const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const User = require('../models/userModel');
const TherapistQuizAssignment = require('../models/therapistQuizAssignmentModel');
const AnswerSheet = require('../models/16PFAnswerModel');
const TherapyConversation = require('../models/therapyConversationModel');
const {
  computePersonalityFactorsFromPayload,
} = require('../utils/calculatePersonalityFactors');
const { encryptChatText, isChatEncryptionReady } = require('../utils/chatCrypto');

const asObjectIdOrNull = (value) => {
  if (!value) return null;
  const raw = String(value).trim();
  return mongoose.Types.ObjectId.isValid(raw) ? new mongoose.Types.ObjectId(raw) : null;
};

// A counsellor may only reach the results of a student assigned to them. Same
// rule as every other client-scoped endpoint, restated here rather than
// imported because authController does not export it.
const ensureAssignedStudent = async ({ therapistId, studentId }) => {
  const studentObjectId = asObjectIdOrNull(studentId);
  if (!studentObjectId) throw new AppError('Invalid student id.', 400);

  const student = await User.findById(studentObjectId)
    .select('name email role assignedTherapist')
    .lean();

  if (!student || student.role !== 'user') {
    throw new AppError('Student not found.', 404);
  }
  if (
    !student.assignedTherapist
    || String(student.assignedTherapist) !== String(therapistId)
  ) {
    throw new AppError('This student is not assigned to you.', 403);
  }

  return student;
};

// The submission for an assignment. Falls back to the newest sheet for the same
// quiz because sheets submitted before assignmentId was added to the schema
// carry no assignment reference, and those results should still be readable.
const findAnswerSheet = async ({ assignment, studentId }) => (
  await AnswerSheet.findOne({ assignmentId: assignment._id, userId: studentId })
    .sort({ createdAt: -1 })
    .lean()
) || (
  await AnswerSheet.findOne({
    userId: studentId,
    quizId: assignment.quiz?._id || assignment.quiz,
  })
    .sort({ createdAt: -1 })
    .lean()
);

const scoreSheet = (answerSheet) => {
  if (String(answerSheet?.quizType || '') !== 'poll PF') return null;
  try {
    return computePersonalityFactorsFromPayload(answerSheet);
  } catch {
    // An unscoreable sheet still has a submission date and a quiz name worth
    // showing, so this returns null rather than failing the whole request.
    return null;
  }
};

const mapCounsellorNote = (assignment) => {
  const note = assignment?.counsellorNote;
  if (!note?.body || !note.sentAt) return null;
  return {
    body: note.body,
    sentAt: note.sentAt,
    updatedAt: note.updatedAt || null,
  };
};

// GET /api/v1/quiz-results/student/:studentId
//
// Every completed assignment for one student, so the counsellor can see what
// was taken and when before opening any single result.
exports.listStudentQuizResults = catchAsync(async (req, res) => {
  const student = await ensureAssignedStudent({
    therapistId: req.user._id,
    studentId: req.params.studentId,
  });

  const assignments = await TherapistQuizAssignment.find({
    user: student._id,
    status: 'completed',
  })
    .populate('quiz', 'title type')
    .sort({ completedAt: -1 })
    .lean();

  res.status(200).json({
    status: 'success',
    results: assignments.length,
    data: assignments.map((assignment) => ({
      id: assignment._id,
      quiz: {
        id: assignment.quiz?._id || assignment.quiz,
        title: assignment.quiz?.title || 'Untitled quiz',
        type: assignment.quiz?.type || '',
      },
      completedAt: assignment.completedAt,
      hasNote: Boolean(assignment.counsellorNote?.sentAt),
    })),
  });
});

// GET /api/v1/quiz-results/:assignmentId
//
// The same scored payload the student sees on their own result page, so the
// counsellor and the student are looking at one thing rather than two
// different renderings of it.
exports.getStudentQuizResult = catchAsync(async (req, res, next) => {
  const assignmentId = asObjectIdOrNull(req.params.assignmentId);
  if (!assignmentId) return next(new AppError('Invalid assignment id.', 400));

  const assignment = await TherapistQuizAssignment.findById(assignmentId)
    .populate('quiz', 'title type')
    .populate('user', 'name email')
    .lean();

  if (!assignment) return next(new AppError('Quiz assignment not found.', 404));

  // Access is checked against the student on the assignment, not against an id
  // in the URL, so a counsellor cannot read another counsellor's assignment by
  // guessing its id.
  const student = await ensureAssignedStudent({
    therapistId: req.user._id,
    studentId: assignment.user?._id || assignment.user,
  });

  const answerSheet = await findAnswerSheet({ assignment, studentId: student._id });
  if (!answerSheet) {
    return next(new AppError('This student has not submitted this quiz yet.', 404));
  }

  res.status(200).json({
    status: 'success',
    data: {
      assignment: {
        id: assignment._id,
        status: assignment.status,
        assignedAt: assignment.assignedAt,
        completedAt: assignment.completedAt,
        quiz: {
          id: assignment.quiz?._id || assignment.quiz,
          title: assignment.quiz?.title || 'Untitled quiz',
          type: assignment.quiz?.type || '',
        },
      },
      student: {
        id: student._id,
        name: student.name,
      },
      result: scoreSheet(answerSheet),
      submittedAt: answerSheet?.createdAt || null,
      quizType: answerSheet?.quizType || assignment.quiz?.type || '',
      counsellorNote: mapCounsellorNote(assignment),
    },
  });
});

// PATCH /api/v1/quiz-results/:assignmentId/note
//
// Writes the counsellor's note and tells the student it is there. The note
// lives on the result; the chat message is only a pointer to it, because a
// result read in isolation months later should still carry the counsellor's
// reading of it.
exports.setQuizResultNote = catchAsync(async (req, res, next) => {
  const assignmentId = asObjectIdOrNull(req.params.assignmentId);
  if (!assignmentId) return next(new AppError('Invalid assignment id.', 400));

  const body = String(req.body?.body || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim();

  if (!body) return next(new AppError('A note is required.', 400));
  if (body.length > 4000) {
    return next(new AppError('A note must be at most 4000 characters.', 400));
  }

  const assignment = await TherapistQuizAssignment.findById(assignmentId)
    .populate('quiz', 'title');
  if (!assignment) return next(new AppError('Quiz assignment not found.', 404));

  const student = await ensureAssignedStudent({
    therapistId: req.user._id,
    studentId: assignment.user,
  });

  if (assignment.status !== 'completed') {
    return next(
      new AppError('A note can only be added once the student has submitted.', 400),
    );
  }

  const isFirstSend = !assignment.counsellorNote?.sentAt;

  assignment.counsellorNote = {
    body,
    sentAt: assignment.counsellorNote?.sentAt || new Date(),
    sentBy: req.user._id,
    updatedAt: isFirstSend ? null : new Date(),
  };
  await assignment.save();

  // Best effort: the note is saved and visible to the student either way, so a
  // chat failure must not fail the request or lose the note.
  let notified = false;
  if (isChatEncryptionReady()) {
    try {
      const conversation = await TherapyConversation.findOneAndUpdate(
        { user: student._id, therapist: req.user._id },
        { $setOnInsert: { user: student._id, therapist: req.user._id } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );

      const quizTitle = assignment.quiz?.title || 'your assessment';
      conversation.messages.push({
        sender: req.user._id,
        senderType: 'therapist',
        ...encryptChatText(
          `I have added a note on your ${quizTitle} result. You can read it on your result page.`,
        ),
        sentAt: new Date(),
      });
      if (conversation.messages.length > 500) {
        conversation.messages = conversation.messages.slice(-500);
      }
      await conversation.save();
      notified = true;
    } catch {
      notified = false;
    }
  }

  res.status(200).json({
    status: 'success',
    data: {
      counsellorNote: mapCounsellorNote(assignment.toObject()),
      notified,
    },
  });
});
