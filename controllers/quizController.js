const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const User = require('./../models/userModel');
const Quiz = require('../models/quizModel');
const AnswerSheet = require('../models/16PFAnswerModel');
const jwt = require('jsonwebtoken');
const { promisify } = require('util');
const calculatePersonalityFactors = require('../utils/calculatePersonalityFactors');

exports.createQuiz = catchAsync(async (req, res, next) => {
  const { type } = req.body;
  if (type === 'mcq') {
    try {
      const { title, type, questions } = req.body;

      // Validate input
      if (
        !title ||
        !type ||
        !Array.isArray(questions) ||
        questions.length === 0
      ) {
        return res.status(400).json({
          message:
            'Invalid input data: Title, type, and questions are required.',
        });
      }

      // Validate quiz type
      if (!['mcq', 'written', 'mixed'].includes(type)) {
        return res.status(400).json({
          message: 'Invalid quiz type. Valid types are mcq, written, or mixed.',
        });
      }

      // Validate each question based on type
      for (const question of questions) {
        if (!question.text || !question.type) {
          return res
            .status(400)
            .json({ message: 'Each question must have text and type.' });
        }
        if (!['mcq', 'written'].includes(question.type)) {
          return res.status(400).json({
            message: 'Invalid question type. Valid types are mcq or written.',
          });
        }
        if (question.type === 'mcq') {
          if (
            !Array.isArray(question.options) ||
            question.options.length < 2 ||
            !question.correctAnswer
          ) {
            return res.status(400).json({
              message:
                'MCQ questions must have at least two options and a correct answer.',
            });
          }
        }
        if (question.type === 'written') {
          if (question.options && question.options.length > 0) {
            return res
              .status(400)
              .json({ message: 'Written questions cannot have options.' });
          }
        }
      }

      // Create a new quiz document
      const newQuiz = new Quiz({
        title,
        type,
        questions,
        createdBy: req.user._id, // Assuming `req.user` contains the authenticated user's details
      });

      // Save the quiz to the database
      const savedQuiz = await newQuiz.save();

      res
        .status(201)
        .json({ message: 'Quiz created successfully!', quiz: savedQuiz });
    } catch (error) {
      console.error('Error creating quiz:', error);
      res.status(500).json({ message: 'Error creating quiz', error });
    }
  } else if (type === 'poll') {
    try {
      const { title, questions } = req.body;

      // Validate input
      if (!title || !Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({
          message: 'Invalid input data: Title and questions are required.',
        });
      }

      // Validate each question
      for (const question of questions) {
        if (!question.text) {
          return res.status(400).json({
            message: 'Each question must have text.',
          });
        }
      }

      // Predefined options for all poll questions (saved at the quiz level)
      const predefinedOptions = [
        'Highly Agree',
        'Agree',
        'Neutral',
        'Disagree',
        'Highly Disagree',
      ];

      // Prepare questions without options
      console.log(questions);

      const pollQuestions = questions.map((question) => ({
        text: question.text,
        trait: question.trait,
        positive: question.positive,
      }));

      // Create a new poll quiz document
      const newQuiz = new Quiz({
        title,
        type: 'poll', // Define a specific type for poll quizzes
        questions: pollQuestions,
        defaultOptions: predefinedOptions, // Save predefined options at the quiz level
        createdBy: req.user._id, // Assuming `req.user` contains the authenticated user's details
      });

      // Save the poll quiz to the database
      const savedQuiz = await newQuiz.save();

      res
        .status(201)
        .json({ message: 'Poll quiz created successfully!', quiz: savedQuiz });
    } catch (error) {
      console.error('Error creating poll quiz:', error);
      res.status(500).json({ message: 'Error creating poll quiz', error });
    }
  } else if (type === 'poll PF') {
    try {
      const { title, questions } = req.body;

      // Validate input
      if (!title || !Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({
          message: 'Invalid input data: Title and questions are required.',
        });
      }

      // Validate each question
      for (const question of questions) {
        if (!question.text) {
          return res.status(400).json({
            message: 'Each question must have text.',
          });
        }
      }

      const pollQuestions = questions.map((question) => ({
        text: question.text,
        trait: question.trait,
        options: question.options,
      }));

      // Create a new poll quiz document
      const newQuiz = new Quiz({
        title,
        type: 'poll PF', // Define a specific type for poll quizzes
        questions: pollQuestions,
        createdBy: req.user._id, // Assuming `req.user` contains the authenticated user's details
      });

      // Save the poll quiz to the database
      const savedQuiz = await newQuiz.save();

      res
        .status(201)
        .json({ message: 'Poll quiz created successfully!', quiz: savedQuiz });
    } catch (error) {
      console.error('Error creating poll quiz:', error);
      res.status(500).json({ message: 'Error creating poll quiz', error });
    }
  } else {
    console.error('Error creating poll quiz:');
    res.status(500).json({ message: 'Error creating poll quiz' });
  }
});

exports.submitQuiz = catchAsync(async (req, res, next) => {
  try {
    const { quizId, quizName, quizType, answers } = req.body;

    if (!quizId || !quizName || !quizType || !answers) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    let token;
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith('Bearer')
    ) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return next(
        new AppError('You are not logged in! Please log in to get access.', 401)
      );
    }

    const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

    const freshUser = await User.findById(decoded.id);

    let userId;

    if (freshUser) {
      userId = decoded.id;
    }
    console.log(freshUser);

    freshUser.attemptedQuizzes.forEach((i) => {
      if (i.toString() === quizId) {
        return next(new AppError('User has already given the test', 403));
      }
    });

    const newAnswerSheet = new AnswerSheet({
      quizId,
      quizName,
      quizType,
      userId,
      answers,
    });

    const savedAnswerSheet = await newAnswerSheet.save();
    await User.findByIdAndUpdate(
      decoded.id,
      { $addToSet: { attemptedQuizzes: quizId } }, // prevents duplicates
      { new: true, runValidators: false } // skip validation
    );
    if (savedAnswerSheet && quizType === 'poll PF') {
      (async () => {
        try {
          await calculatePersonalityFactors(savedAnswerSheet);
        } catch (err) {
          console.error('PF calc error:', err.message);
        }
      })();
    }
    res.status(201).json({
      message: 'Answers submitted successfully',
      data: savedAnswerSheet,
    });
  } catch (error) {
    console.error('Error saving answer sheet:', error);
    res.status(500).json({ message: 'Error saving answer sheet', error });
  }
});
