const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const sendEmail = require('../utils/email');
const User = require('./../models/userModel');
const Quiz = require('./../models/quizModel');
const TherapistProfile = require('./../models/therapistProfileModel');
const Appointment = require('./../models/appointmentModel');
const UserInfo = require('./../models/userInfoModel');
const TherapistQuizAssignment = require('./../models/therapistQuizAssignmentModel');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { promisify } = require('util');
const crypto = require('crypto');

const signToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });
};

const isCalendlyInvalidGrant = (payload = {}) => {
  const errorCode = String(payload?.error || '').toLowerCase();
  const message = String(
    payload?.error_description || payload?.message || '',
  ).toLowerCase();

  return (
    errorCode === 'invalid_grant' ||
    message.includes('authorization grant is invalid') ||
    message.includes('expired') ||
    message.includes('revoked')
  );
};

const clearTherapistCalendlyAuth = async (userId) => {
  if (!userId) return;

  await TherapistProfile.findOneAndUpdate(
    { user: userId },
    {
      $set: {
        calendlyConnected: false,
        calendlyAccessToken: '',
        calendlyRefreshToken: '',
        calendlyTokenExpiresAt: null,
      },
    },
    { runValidators: false },
  );
};

const refreshCalendlyAccessToken = async (refreshToken) => {
  const tokenUrl = 'https://auth.calendly.com/oauth/token';
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: process.env.CALENDLY_CLIENT_ID,
    client_secret: process.env.CALENDLY_CLIENT_SECRET,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.access_token) {
    const appError = new AppError(
      data?.error_description || data?.message || 'Failed to refresh Calendly token.',
      400,
    );
    appError.isCalendlyInvalidGrant = isCalendlyInvalidGrant(data);
    throw appError;
  }

  return data;
};

const ensureTherapistCalendlyToken = async (profile) => {
  if (!profile?.calendlyAccessToken) return '';

  const tokenExpired =
    profile?.calendlyTokenExpiresAt &&
    new Date(profile.calendlyTokenExpiresAt).getTime() <= Date.now();

  if (!tokenExpired) return profile.calendlyAccessToken;

  if (!profile?.calendlyRefreshToken) return '';

  let tokenData;
  try {
    tokenData = await refreshCalendlyAccessToken(profile.calendlyRefreshToken);
  } catch (error) {
    if (error?.isCalendlyInvalidGrant) {
      await clearTherapistCalendlyAuth(profile.user);
      return '';
    }
    throw error;
  }

  const refreshedAccessToken = tokenData.access_token;
  const refreshedRefreshToken = tokenData.refresh_token || profile.calendlyRefreshToken;
  const expiresInSec = Number(tokenData.expires_in || 3600);
  const expiresAt = new Date(Date.now() + expiresInSec * 1000);

  await TherapistProfile.findOneAndUpdate(
    { user: profile.user },
    {
      $set: {
        calendlyAccessToken: refreshedAccessToken,
        calendlyRefreshToken: refreshedRefreshToken,
        calendlyTokenExpiresAt: expiresAt,
      },
    },
    { runValidators: false },
  );

  return refreshedAccessToken;
};

const fetchCalendlyScheduledEvents = async ({
  accessToken,
  calendlyUserUri,
  minStartTime,
}) => {
  const url = new URL('https://api.calendly.com/scheduled_events');
  url.searchParams.set('user', calendlyUserUri);
  url.searchParams.set('min_start_time', minStartTime);
  url.searchParams.set('status', 'active');
  url.searchParams.set('sort', 'start_time:asc');
  url.searchParams.set('count', '50');

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) return [];
  return data?.collection || [];
};

const fetchCalendlyInvitee = async ({ accessToken, eventUri }) => {
  if (!eventUri) return null;

  const url = new URL(`${eventUri}/invitees`);
  url.searchParams.set('count', '1');
  url.searchParams.set('sort', 'created_at:asc');

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) return null;
  return data?.collection?.[0] || null;
};

const mapCalendlyEventToUserSession = ({
  event,
  invitee,
  therapistName = 'Therapist',
}) => ({
  id: event?.uri || event?.uuid || '',
  scheduledAt: event?.start_time || null,
  endsAt: event?.end_time || null,
  timezone: event?.start_time
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : '',
  sessionType: event?.name || 'Therapy Session',
  therapistName,
  stage: 'upcoming',
  joinUrl:
    event?.location?.join_url ||
    event?.location?.location ||
    event?.location?.additional_info ||
    '',
  rescheduleUrl: invitee?.reschedule_url || '',
  cancelUrl: invitee?.cancel_url || '',
});

const ACTIVE_ASSIGNMENT_STATUSES = new Set(['assigned', 'in_progress']);
const CLIENT_SORT_KEYS = new Set([
  'name',
  'nextSessionAt',
  'pendingQuizCount',
  'lastActivityAt',
]);

const asObjectIdOrNull = (value) => {
  const raw = String(value || '').trim();
  if (!raw || !mongoose.Types.ObjectId.isValid(raw)) return null;
  return new mongoose.Types.ObjectId(raw);
};

const parsePositiveInt = (value, fallback, { min = 1, max = 100 } = {}) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
};

const parseDateOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const defaultAssignmentDueDate = () =>
  new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

const isAssignmentOverdue = (assignment, now = new Date()) => {
  if (!assignment?.dueAt) return false;
  if (!ACTIVE_ASSIGNMENT_STATUSES.has(String(assignment?.status || ''))) return false;
  const dueAt = new Date(assignment.dueAt);
  if (Number.isNaN(dueAt.getTime())) return false;
  return dueAt.getTime() < now.getTime();
};

const normalizeSortDirection = (value) =>
  String(value || '').toLowerCase() === 'desc' ? 'desc' : 'asc';

const sanitizeSortKey = (value) => {
  const key = String(value || '').trim();
  return CLIENT_SORT_KEYS.has(key) ? key : 'name';
};

const getComparableDate = (value) => {
  const parsed = parseDateOrNull(value);
  if (!parsed) return 0;
  return parsed.getTime();
};

const mapQuizAssignmentPayload = (assignment, now = new Date()) => {
  const overdue = isAssignmentOverdue(assignment, now);

  return {
    id: assignment?._id,
    userId: assignment?.user?._id || assignment?.user || null,
    therapistId: assignment?.therapist?._id || assignment?.therapist || null,
    quiz: {
      id: assignment?.quiz?._id || assignment?.quiz || null,
      title: assignment?.quiz?.title || 'Untitled Quiz',
      type: assignment?.quiz?.type || '',
      estimatedMinutes: Number.isFinite(Number(assignment?.quiz?.estimatedMinutes))
        ? Number(assignment.quiz.estimatedMinutes)
        : null,
      isActive: assignment?.quiz?.isActive !== false,
    },
    status: assignment?.status || 'assigned',
    effectiveStatus: overdue ? 'overdue' : assignment?.status || 'assigned',
    isOverdue: overdue,
    source: assignment?.source || 'therapist_manual',
    note: assignment?.note || '',
    assignedAt: assignment?.assignedAt || null,
    dueAt: assignment?.dueAt || null,
    startedAt: assignment?.startedAt || null,
    completedAt: assignment?.completedAt || null,
    revokedAt: assignment?.revokedAt || null,
    updatedAt: assignment?.updatedAt || null,
  };
};

const summarizeQuizAssignments = (assignments = [], now = new Date()) => {
  let pending = 0;
  let completed = 0;
  let overdue = 0;
  let revoked = 0;

  assignments.forEach((assignment) => {
    const status = String(assignment?.status || '');
    if (status === 'completed') {
      completed += 1;
      return;
    }
    if (status === 'revoked') {
      revoked += 1;
      return;
    }
    if (isAssignmentOverdue(assignment, now)) {
      overdue += 1;
      return;
    }
    if (ACTIVE_ASSIGNMENT_STATUSES.has(status)) {
      pending += 1;
    }
  });

  return {
    total: assignments.length,
    pending,
    completed,
    overdue,
    revoked,
  };
};

const getClientSessionSummary = (appointments = [], now = new Date()) => {
  let nextSessionAt = null;
  let lastSessionAt = null;

  appointments.forEach((session) => {
    if (String(session?.status || '') === 'canceled') return;

    const startDate = parseDateOrNull(session?.scheduledAt);
    const endDate = parseDateOrNull(session?.endsAt);
    const startTs = startDate ? startDate.getTime() : 0;
    const endTs = endDate ? endDate.getTime() : startTs;

    if (endTs >= now.getTime()) {
      if (!nextSessionAt || startTs < new Date(nextSessionAt).getTime()) {
        nextSessionAt = startDate.toISOString();
      }
      return;
    }

    if (!lastSessionAt || endTs > new Date(lastSessionAt).getTime()) {
      lastSessionAt = (endDate || startDate).toISOString();
    }
  });

  return { nextSessionAt, lastSessionAt };
};

const ensureTherapistClientAccess = async ({ therapistId, clientId }) => {
  const clientObjectId = asObjectIdOrNull(clientId);
  if (!clientObjectId) {
    throw new AppError('Invalid client id.', 400);
  }

  const client = await User.findById(clientObjectId)
    .select('name email role hasOnboarded assignedTherapist attemptedQuizzes accessibleQuizzes')
    .populate('attemptedQuizzes', 'title type')
    .lean();

  if (!client || client.role !== 'user') {
    throw new AppError('Client not found.', 404);
  }

  if (!client.assignedTherapist || String(client.assignedTherapist) !== String(therapistId)) {
    throw new AppError('This client is not assigned to this therapist.', 403);
  }

  return client;
};

exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return next(new AppError('Please provide username and password', 400));
  }
  const user = await User.findOne({ email }).select('+password');
  if (!user || !(await user.correctPassword(password, user.password))) {
    return next(new AppError('User or Password is Wrong ', 401));
  }
  const token = signToken(user._id);
  res.status(200).json({
    status: 'success',
    message: 'Logged In Successfully',
    token: token,
    role: user.role,
    hasOnboarded: user.hasOnboarded,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  });
});
exports.signUp = catchAsync(async (req, res, next) => {
  console.log(req.body);
  const allowedSignupRoles = ['user', 'therapist'];
  const role = allowedSignupRoles.includes(req.body.role)
    ? req.body.role
    : undefined;

  const newUser = await User.create({
    name: req.body.name,
    email: req.body.email,
    password: req.body.password,
    passwordConfirm: req.body.passwordConfirm,
    role,
  });

  const token = signToken(newUser._id);

  // Send a success response
  res.status(200).json({
    status: 'success',
    data: {
      user: newUser, // Include the newly created user in the response
      token: token,
    },
  });
});
exports.protect = catchAsync(async (req, res, next) => {
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401),
    );
  }
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  const freshUser = await User.findById(decoded.id);
  console.log(freshUser);
  if (!freshUser) {
    return next(
      new AppError('The user belonging to this token does no longer exist'),
    );
  }

  req.user = freshUser;
  next();
});
exports.isAdmin = catchAsync(async (req, res, next) => {
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401),
    );
  }
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  const freshUser = await User.findById(decoded.id);
  console.log(freshUser);
  if (freshUser.role !== 'admin') {
    return next(new AppError('The user is not an admin'));
  }

  req.user = freshUser;

  next();
});
exports.isTherapist = catchAsync(async (req, res, next) => {
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401),
    );
  }
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  const freshUser = await User.findById(decoded.id);
  console.log(freshUser);
  if (!freshUser || freshUser.role !== 'therapist') {
    return next(new AppError('The user is not a therapist', 403));
  }

  req.user = freshUser;

  next();
});

exports.assignTherapistToUser = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { therapistUserId } = req.body;

  if (!therapistUserId) {
    return next(new AppError('therapistUserId is required', 400));
  }

  const targetUser = await User.findById(id);
  if (!targetUser) {
    return next(new AppError('User not found', 404));
  }
  if (targetUser.role !== 'user') {
    return next(
      new AppError('Only users with role "user" can be assigned a therapist', 400),
    );
  }

  const therapistUser = await User.findById(therapistUserId);
  if (!therapistUser) {
    return next(new AppError('Therapist user not found', 404));
  }
  if (therapistUser.role !== 'therapist') {
    return next(new AppError('Provided therapistUserId is not a therapist', 400));
  }

  targetUser.assignedTherapist = therapistUser._id;
  await targetUser.save({ validateBeforeSave: false });

  res.status(200).json({
    status: 'success',
    data: {
      userId: targetUser._id,
      assignedTherapist: therapistUser._id,
    },
  });
});

exports.getAssignedTherapist = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.user._id)
    .select('assignedTherapist')
    .populate('assignedTherapist', 'name role');

  if (!user?.assignedTherapist) {
    return res.status(200).json({
      status: 'success',
      data: null,
    });
  }

  const therapistUser = user.assignedTherapist;
  const therapistProfile = await TherapistProfile.findOne({
    user: therapistUser._id,
  });

  res.status(200).json({
    status: 'success',
    data: {
      therapistUserId: therapistUser._id,
      displayName: therapistProfile?.displayName || therapistUser.name,
      title: therapistProfile?.title || 'Therapist',
      bio: therapistProfile?.bio || '',
      specializations: therapistProfile?.specializations || [],
      languages: therapistProfile?.languages || [],
      sessionModes: therapistProfile?.sessionModes || [],
      availabilityStatus: therapistProfile?.availabilityStatus || 'available',
      calendlyUrl: therapistProfile?.calendlyUrl || '',
    },
  });
});

exports.getMe = catchAsync(async (req, res) => {
  res.status(200).json({
    status: 'success',
    data: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      hasOnboarded: req.user.hasOnboarded,
      assignedTherapist: req.user.assignedTherapist || null,
    },
  });
});

exports.getMyAssignedClients = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'therapist') {
    return next(new AppError('Only therapists can access assigned clients.', 403));
  }

  const search = String(req.query?.search || '').trim();
  const onboardingStatus = String(req.query?.onboardingStatus || 'all').toLowerCase();
  const quizStatus = String(req.query?.quizStatus || 'all').toLowerCase();
  const sessionStatus = String(req.query?.sessionStatus || 'all').toLowerCase();
  const sortBy = sanitizeSortKey(req.query?.sortBy);
  const sortDir = normalizeSortDirection(req.query?.sortDir);
  const page = parsePositiveInt(req.query?.page, 1, { min: 1, max: 1000000 });
  const limit = parsePositiveInt(req.query?.limit, 10, { min: 1, max: 100 });

  const baseFilter = {
    role: 'user',
    assignedTherapist: req.user._id,
  };

  if (search) {
    const safeRegex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    baseFilter.$or = [{ name: safeRegex }, { email: safeRegex }];
  }

  if (onboardingStatus === 'completed') {
    baseFilter.hasOnboarded = true;
  } else if (onboardingStatus === 'pending') {
    baseFilter.hasOnboarded = false;
  }

  const clients = await User.find(baseFilter)
    .select('name email hasOnboarded assignedTherapist')
    .lean();

  if (!clients.length) {
    return res.status(200).json({
      status: 'success',
      results: 0,
      total: 0,
      pagination: {
        page,
        limit,
        total: 0,
        totalPages: 0,
      },
      data: [],
    });
  }

  const clientIds = clients.map((client) => client._id);
  const [appointments, assignments] = await Promise.all([
    Appointment.find({
      therapist: req.user._id,
      user: { $in: clientIds },
    })
      .select('user scheduledAt endsAt status')
      .lean(),
    TherapistQuizAssignment.find({
      therapist: req.user._id,
      user: { $in: clientIds },
    })
      .select('user status dueAt assignedAt startedAt completedAt revokedAt updatedAt')
      .lean(),
  ]);

  const now = new Date();
  const appointmentsByClient = new Map();
  appointments.forEach((session) => {
    const key = String(session?.user || '');
    const existing = appointmentsByClient.get(key) || [];
    existing.push(session);
    appointmentsByClient.set(key, existing);
  });

  const assignmentsByClient = new Map();
  assignments.forEach((assignment) => {
    const key = String(assignment?.user || '');
    const existing = assignmentsByClient.get(key) || [];
    existing.push(assignment);
    assignmentsByClient.set(key, existing);
  });

  let rows = clients.map((client) => {
    const id = String(client?._id || '');
    const clientAppointments = appointmentsByClient.get(id) || [];
    const clientAssignments = assignmentsByClient.get(id) || [];
    const sessionSummary = getClientSessionSummary(clientAppointments, now);
    const quizSummary = summarizeQuizAssignments(clientAssignments, now);

    const latestAssignmentAt = clientAssignments
      .map((assignment) =>
        parseDateOrNull(
          assignment?.updatedAt
          || assignment?.completedAt
          || assignment?.revokedAt
          || assignment?.startedAt
          || assignment?.assignedAt,
        ))
      .filter(Boolean)
      .sort((a, b) => b.getTime() - a.getTime())[0] || null;

    const lastActivityCandidates = [
      parseDateOrNull(sessionSummary.lastSessionAt),
      latestAssignmentAt,
    ].filter(Boolean);

    const lastActivityAt = lastActivityCandidates.length
      ? new Date(Math.max(...lastActivityCandidates.map((item) => item.getTime()))).toISOString()
      : null;

    return {
      id: client._id,
      name: client.name || 'Unnamed User',
      email: client.email || '',
      hasOnboarded: Boolean(client.hasOnboarded),
      assignedTherapist: client.assignedTherapist || null,
      nextSessionAt: sessionSummary.nextSessionAt,
      lastSessionAt: sessionSummary.lastSessionAt,
      pendingQuizCount: quizSummary.pending,
      completedQuizCount: quizSummary.completed,
      overdueQuizCount: quizSummary.overdue,
      totalQuizAssignments: quizSummary.total,
      lastActivityAt,
    };
  });

  if (quizStatus === 'has_pending') {
    rows = rows.filter((row) => row.pendingQuizCount > 0);
  } else if (quizStatus === 'overdue') {
    rows = rows.filter((row) => row.overdueQuizCount > 0);
  } else if (quizStatus === 'none_assigned') {
    rows = rows.filter((row) => row.totalQuizAssignments === 0);
  }

  if (sessionStatus === 'upcoming') {
    rows = rows.filter((row) => Boolean(row.nextSessionAt));
  } else if (sessionStatus === 'no_upcoming') {
    rows = rows.filter((row) => !row.nextSessionAt);
  }

  rows.sort((a, b) => {
    let comparison = 0;

    if (sortBy === 'pendingQuizCount') {
      comparison = (a.pendingQuizCount || 0) - (b.pendingQuizCount || 0);
    } else if (sortBy === 'nextSessionAt') {
      comparison = getComparableDate(a.nextSessionAt) - getComparableDate(b.nextSessionAt);
    } else if (sortBy === 'lastActivityAt') {
      comparison = getComparableDate(a.lastActivityAt) - getComparableDate(b.lastActivityAt);
    } else {
      comparison = String(a.name || '').localeCompare(String(b.name || ''), undefined, {
        sensitivity: 'base',
      });
    }

    return sortDir === 'desc' ? -comparison : comparison;
  });

  const total = rows.length;
  const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
  const offset = (page - 1) * limit;
  const pagedRows = rows.slice(offset, offset + limit);

  res.status(200).json({
    status: 'success',
    results: pagedRows.length,
    total,
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
    data: pagedRows,
  });
});

exports.getTherapistClientOverview = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'therapist') {
    return next(new AppError('Only therapists can access client overview.', 403));
  }

  const { id: clientId } = req.params;
  const client = await ensureTherapistClientAccess({
    therapistId: req.user._id,
    clientId,
  });

  const [allAppointments, userInfo, allAssignments] = await Promise.all([
    Appointment.find({
      therapist: req.user._id,
      user: clientId,
    })
      .sort({ scheduledAt: 1 })
      .lean(),
    UserInfo.findOne({ user: clientId }).lean(),
    TherapistQuizAssignment.find({
      therapist: req.user._id,
      user: clientId,
    })
      .populate('quiz', 'title type estimatedMinutes isActive')
      .sort({ assignedAt: -1 })
      .lean(),
  ]);

  const now = new Date();
  const sessionView = allAppointments.map((session) => {
    const scheduledAt = session?.scheduledAt ? new Date(session.scheduledAt) : null;
    const endsAt = session?.endsAt ? new Date(session.endsAt) : null;

    let stage = 'upcoming';
    if (scheduledAt && endsAt && now >= scheduledAt && now <= endsAt) {
      stage = 'current';
    } else if (endsAt && now > endsAt) {
      stage = 'previous';
    }

    return {
      id: session?._id,
      scheduledAt: session?.scheduledAt || null,
      endsAt: session?.endsAt || null,
      timezone: session?.timezone || '',
      sessionType: session?.sessionType || 'Session',
      status: session?.status || 'scheduled',
      stage,
      joinUrl:
        session?.rawPayload?.payload?.scheduled_event?.location?.join_url ||
        session?.rawPayload?.payload?.scheduled_event?.location?.location ||
        '',
      rescheduleUrl:
        session?.rawPayload?.payload?.reschedule_url ||
        session?.rawPayload?.payload?.invitee?.reschedule_url ||
        '',
      cancelUrl:
        session?.rawPayload?.payload?.cancel_url ||
        session?.rawPayload?.payload?.invitee?.cancel_url ||
        '',
    };
  });

  const currentSession =
    sessionView.find((session) => session.stage === 'current' && session.status !== 'canceled') ||
    null;
  const nextSession =
    sessionView.find((session) => session.stage === 'upcoming' && session.status !== 'canceled') ||
    null;

  const previousSessions = sessionView
    .filter((session) => session.stage === 'previous')
    .sort((a, b) => new Date(b.scheduledAt || 0).getTime() - new Date(a.scheduledAt || 0).getTime());

  const attemptedTests = Array.isArray(client.attemptedQuizzes)
    ? client.attemptedQuizzes.map((quiz) => ({
        id: quiz?._id,
        title: quiz?.title || 'Untitled Test',
        type: quiz?.type || '',
      }))
    : [];

  const mappedAssignments = allAssignments.map((assignment) =>
    mapQuizAssignmentPayload(assignment, now));
  const quizAssignmentsSummary = summarizeQuizAssignments(allAssignments, now);
  const activeAssignments = mappedAssignments.filter((assignment) =>
    ACTIVE_ASSIGNMENT_STATUSES.has(String(assignment?.status || '')));
  const completedAssignments = mappedAssignments.filter(
    (assignment) => assignment.status === 'completed');

  res.status(200).json({
    status: 'success',
    data: {
      client: {
        id: client._id,
        name: client.name,
        email: client.email,
        hasOnboarded: client.hasOnboarded,
      },
      preferences: {
        primaryConcern: userInfo?.primaryConcern || '',
        languagePref: userInfo?.languagePref || '',
        sessionMode: userInfo?.sessionMode || '',
        availabilityPrefs: Array.isArray(userInfo?.availabilityPrefs)
          ? userInfo.availabilityPrefs
          : [],
        reminderChannel: userInfo?.reminderChannel || '',
      },
      sessions: {
        current: currentSession,
        next: nextSession,
        previous: previousSessions,
        all: sessionView,
      },
      quizzes: {
        summary: quizAssignmentsSummary,
        activeAssignments,
        completedAssignments,
        allAssignments: mappedAssignments,
      },
      tests: {
        attempted: attemptedTests,
      },
    },
  });
});

exports.getTherapistQuizLibrary = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'therapist') {
    return next(new AppError('Only therapists can access quiz library.', 403));
  }

  const quizzes = await Quiz.find({ isActive: { $ne: false } })
    .select('title type estimatedMinutes isActive questions')
    .sort({ title: 1 })
    .lean();

  const data = quizzes.map((quiz) => ({
    id: quiz?._id,
    title: quiz?.title || 'Untitled Quiz',
    type: quiz?.type || '',
    estimatedMinutes: Number.isFinite(Number(quiz?.estimatedMinutes))
      ? Number(quiz.estimatedMinutes)
      : Math.max(5, Math.ceil((Array.isArray(quiz?.questions) ? quiz.questions.length : 0) * 1.5)),
    isActive: quiz?.isActive !== false,
  }));

  res.status(200).json({
    status: 'success',
    results: data.length,
    data,
  });
});

exports.getTherapistClientQuizAssignments = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'therapist') {
    return next(new AppError('Only therapists can access client quiz assignments.', 403));
  }

  const { id: clientId } = req.params;
  const statusFilter = String(req.query?.status || 'all').toLowerCase();

  const client = await ensureTherapistClientAccess({
    therapistId: req.user._id,
    clientId,
  });

  const assignments = await TherapistQuizAssignment.find({
    therapist: req.user._id,
    user: client._id,
  })
    .populate('quiz', 'title type estimatedMinutes isActive')
    .sort({ assignedAt: -1 })
    .lean();

  const now = new Date();
  let mappedAssignments = assignments.map((assignment) =>
    mapQuizAssignmentPayload(assignment, now));

  const allowedStatusFilters = new Set([
    'all',
    'assigned',
    'in_progress',
    'completed',
    'revoked',
    'overdue',
  ]);

  if (!allowedStatusFilters.has(statusFilter)) {
    return next(new AppError('Invalid status filter.', 400));
  }

  if (statusFilter !== 'all') {
    mappedAssignments = mappedAssignments.filter(
      (assignment) => assignment.effectiveStatus === statusFilter,
    );
  }

  res.status(200).json({
    status: 'success',
    data: {
      client: {
        id: client._id,
        name: client.name,
        email: client.email,
      },
      summary: summarizeQuizAssignments(assignments, now),
      assignments: mappedAssignments,
    },
  });
});

exports.assignQuizToTherapistClient = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'therapist') {
    return next(new AppError('Only therapists can assign quizzes.', 403));
  }

  const { id: clientId } = req.params;
  const { quizId, dueAt, note } = req.body || {};

  if (!quizId) {
    return next(new AppError('quizId is required.', 400));
  }

  const quizObjectId = asObjectIdOrNull(quizId);
  if (!quizObjectId) {
    return next(new AppError('Invalid quizId.', 400));
  }

  const dueAtProvided = dueAt !== undefined && dueAt !== null && dueAt !== '';
  const parsedDueAt = dueAtProvided ? parseDateOrNull(dueAt) : defaultAssignmentDueDate();
  if (dueAtProvided && !parsedDueAt) {
    return next(new AppError('Invalid dueAt date.', 400));
  }

  const normalizedNote = String(note || '').trim();
  if (normalizedNote.length > 1200) {
    return next(new AppError('Assignment note must be at most 1200 characters.', 400));
  }

  const [client, quiz] = await Promise.all([
    ensureTherapistClientAccess({
      therapistId: req.user._id,
      clientId,
    }),
    Quiz.findById(quizObjectId).select('title type estimatedMinutes isActive').lean(),
  ]);

  if (!quiz) {
    return next(new AppError('Quiz not found.', 404));
  }
  if (quiz.isActive === false) {
    return next(new AppError('Quiz is not active and cannot be assigned.', 400));
  }

  const assignment = await TherapistQuizAssignment.create({
    user: client._id,
    therapist: req.user._id,
    quiz: quiz._id,
    status: 'assigned',
    assignedAt: new Date(),
    dueAt: parsedDueAt,
    note: normalizedNote,
    source: 'therapist_manual',
  });

  await User.findByIdAndUpdate(
    client._id,
    { $addToSet: { accessibleQuizzes: quiz._id } },
    { new: false, runValidators: false },
  );

  const hydrated = await TherapistQuizAssignment.findById(assignment._id)
    .populate('quiz', 'title type estimatedMinutes isActive')
    .lean();

  const allAssignments = await TherapistQuizAssignment.find({
    therapist: req.user._id,
    user: client._id,
  }).lean();

  const now = new Date();
  res.status(201).json({
    status: 'success',
    data: {
      assignment: mapQuizAssignmentPayload(hydrated, now),
      summary: summarizeQuizAssignments(allAssignments, now),
    },
  });
});

exports.updateTherapistClientQuizAssignment = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'therapist') {
    return next(new AppError('Only therapists can update quiz assignments.', 403));
  }

  const { id: clientId, assignmentId } = req.params;
  const { dueAt, status } = req.body || {};

  const client = await ensureTherapistClientAccess({
    therapistId: req.user._id,
    clientId,
  });

  const assignmentObjectId = asObjectIdOrNull(assignmentId);
  if (!assignmentObjectId) {
    return next(new AppError('Invalid assignment id.', 400));
  }

  const assignment = await TherapistQuizAssignment.findOne({
    _id: assignmentObjectId,
    therapist: req.user._id,
    user: client._id,
  });

  if (!assignment) {
    return next(new AppError('Quiz assignment not found.', 404));
  }

  if (status !== undefined) {
    if (status !== 'revoked') {
      return next(new AppError('Only status "revoked" can be set manually.', 400));
    }
    if (assignment.status === 'completed') {
      return next(new AppError('Completed assignments cannot be revoked.', 400));
    }
    assignment.status = 'revoked';
    assignment.revokedAt = new Date();
  }

  if (dueAt !== undefined) {
    if (dueAt === null || dueAt === '') {
      assignment.dueAt = null;
    } else {
      const parsedDueAt = parseDateOrNull(dueAt);
      if (!parsedDueAt) {
        return next(new AppError('Invalid dueAt date.', 400));
      }
      assignment.dueAt = parsedDueAt;
    }
  }

  await assignment.save({ validateBeforeSave: true });

  const hydrated = await TherapistQuizAssignment.findById(assignment._id)
    .populate('quiz', 'title type estimatedMinutes isActive')
    .lean();

  const allAssignments = await TherapistQuizAssignment.find({
    therapist: req.user._id,
    user: client._id,
  }).lean();

  const now = new Date();
  res.status(200).json({
    status: 'success',
    data: {
      assignment: mapQuizAssignmentPayload(hydrated, now),
      summary: summarizeQuizAssignments(allAssignments, now),
    },
  });
});

exports.getMySessionOverview = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'user') {
    return next(new AppError('Only users can access session overview.', 403));
  }

  const sessions = await Appointment.find({
    status: { $ne: 'canceled' },
    $or: [
      { user: req.user._id },
      { userEmail: String(req.user.email || '').toLowerCase().trim() },
    ],
  })
    .populate('therapist', 'name email')
    .sort({ scheduledAt: 1 })
    .lean();

  const now = new Date();

  const mapped = sessions.map((session) => {
    const scheduledAt = session?.scheduledAt ? new Date(session.scheduledAt) : null;
    const endsAt = session?.endsAt ? new Date(session.endsAt) : null;

    let stage = 'upcoming';
    if (scheduledAt && endsAt && now >= scheduledAt && now <= endsAt) {
      stage = 'current';
    } else if (endsAt && now > endsAt) {
      stage = 'previous';
    } else if (scheduledAt && now > scheduledAt) {
      stage = 'previous';
    }

    return {
      id: session?._id,
      scheduledAt: session?.scheduledAt || null,
      endsAt: session?.endsAt || null,
      timezone: session?.timezone || '',
      sessionType: session?.sessionType || 'Therapy Session',
      therapistName: session?.therapist?.name || session?.therapistName || 'Therapist',
      stage,
      joinUrl:
        session?.rawPayload?.payload?.scheduled_event?.location?.join_url ||
        session?.rawPayload?.payload?.scheduled_event?.location?.location ||
        '',
      rescheduleUrl:
        session?.rawPayload?.payload?.reschedule_url ||
        session?.rawPayload?.payload?.invitee?.reschedule_url ||
        '',
      cancelUrl:
        session?.rawPayload?.payload?.cancel_url ||
        session?.rawPayload?.payload?.invitee?.cancel_url ||
        '',
    };
  });

  const currentSession =
    mapped.find((session) => session.stage === 'current') || null;
  const nextSession =
    mapped.find((session) => session.stage === 'upcoming') || null;
  let upcoming = mapped.filter((session) => session.stage === 'upcoming');

  if (!currentSession && !nextSession && upcoming.length === 0) {
    const assignedTherapistId = req.user?.assignedTherapist;
    if (assignedTherapistId) {
      const therapistProfile = await TherapistProfile.findOne({
        user: assignedTherapistId,
      }).lean();

      if (therapistProfile?.calendlyConnected && therapistProfile?.calendlyUserUri) {
        const accessToken = await ensureTherapistCalendlyToken(therapistProfile);
        if (accessToken) {
          const minStartTime = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
          const events = await fetchCalendlyScheduledEvents({
            accessToken,
            calendlyUserUri: therapistProfile.calendlyUserUri,
            minStartTime,
          });

          const email = String(req.user.email || '').toLowerCase().trim();
          const therapistName =
            (await User.findById(assignedTherapistId).select('name').lean())?.name || 'Therapist';

          const fallbackSessions = [];
          for (const event of events) {
            const invitee = await fetchCalendlyInvitee({
              accessToken,
              eventUri: event?.uri,
            });

            const inviteeEmail = String(invitee?.email || '').toLowerCase().trim();
            if (!inviteeEmail || inviteeEmail !== email) continue;

            const mappedSession = mapCalendlyEventToUserSession({
              event,
              invitee,
              therapistName,
            });

            const scheduledAt = mappedSession?.scheduledAt ? new Date(mappedSession.scheduledAt) : null;
            const endsAt = mappedSession?.endsAt ? new Date(mappedSession.endsAt) : null;
            if (scheduledAt && endsAt && now >= scheduledAt && now <= endsAt) {
              mappedSession.stage = 'current';
            } else if ((endsAt && now > endsAt) || (scheduledAt && now > scheduledAt && !endsAt)) {
              mappedSession.stage = 'previous';
            }

            fallbackSessions.push(mappedSession);
          }

          const sortedFallback = fallbackSessions.sort(
            (a, b) => new Date(a.scheduledAt || 0).getTime() - new Date(b.scheduledAt || 0).getTime(),
          );
          const fallbackCurrent = sortedFallback.find((session) => session.stage === 'current') || null;
          const fallbackNext = sortedFallback.find((session) => session.stage === 'upcoming') || null;
          const fallbackUpcoming = sortedFallback.filter((session) => session.stage === 'upcoming');

          return res.status(200).json({
            status: 'success',
            data: {
              current: fallbackCurrent,
              next: fallbackNext,
              upcoming: fallbackUpcoming,
            },
          });
        }
      }
    }
  }

  res.status(200).json({
    status: 'success',
    data: {
      current: currentSession,
      next: nextSession,
      upcoming,
    },
  });
});

exports.forgotPassword = catchAsync(async (req, res, next) => {
  const user = await User.findOne({ email: req.body.email });
  if (!user) {
    return next(new AppError('There is no user with email address', 401));
  }
  const resetToken = await user.createPasswordResetToken();
  console.log(resetToken);
  await user.save({ validateBeforeSave: false });

  const resetURL = `${req.protocol}://${req.get(
    'host',
  )}/api/v1/users/resetPassword/${resetToken}`;

  const message = `Forgot your password ? Submit a PATCH request with your new password & passwordConfirm to: ${resetURL}`;
  try {
    await sendEmail({
      email: user.email,
      subject: 'Your Password Reset',
      message,
    });
    res.status(200).json({
      status: 'success',
      message: 'Token sent to mail',
    });
  } catch (err) {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({
      validateBeforeSave: false,
    });
  }
});

exports.resetPassword = catchAsync(async (req, res, next) => {
  const hashedToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });

  if (!user) {
    return next(new AppError('Token is expired or invalid', 400));
  }
  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  const token = signToken(user._id);
  res.status(200).json({
    status: 'success',
    token,
  });
});

exports.updatePassword = catchAsync(async (req, res, next) => {
  //geting user from collection
  const user = await User.findById(req.user._id.toString()).select('+password');
  //checking if the current password is correct
  if (user.correctPassword(user.password, req.body.password)) {
    console.log('correct password');
    user.password = req.body.newPassword;
    user.passwordConfirm = req.body.newPasswordConfirm;
    await user.save();
  }
  const token = signToken(user._id);
  res.status(200).json({
    status: 'success',
    message: 'Logged In Successfully',
    token: token,
  });
});
exports.getUserQuizzes = catchAsync(async (req, res, next) => {
  let token;

  // Extract token from Authorization header
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401),
    );
  }

  // Verify and decode the token
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  // Fetch user details using decoded ID
  const user = await User.findById(decoded.id);

  if (!user) {
    return next(
      new AppError(
        'The user belonging to this token does no longer exist.',
        404,
      ),
    );
  }

  // Fetch quizzes using the IDs in the user's accessibleQuizzes array
  const quizzes = await Quiz.find({
    _id: { $in: user.accessibleQuizzes },
  });

  // If no quizzes are found
  if (!quizzes || quizzes.length === 0) {
    return next(new AppError('No quizzes found for this user.', 404));
  }

  // Respond with the quizzes
  res.status(200).json({
    message: 'User quizzes retrieved successfully',
    quizzes,
  });
});
exports.getQuizByID = catchAsync(async (req, res, next) => {
  let token;

  const { id } = req.body;
  console.log(req.body);

  // Extract token from Authorization header
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401),
    );
  }

  // Verify and decode the token
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  // Fetch user details using decoded ID
  const user = await User.findById(decoded.id);

  if (!user) {
    return next(
      new AppError(
        'The user belonging to this token does no longer exist.',
        404,
      ),
    );
  }

  // Fetch quizzes using the `$in` operator
  const quiz = await Quiz.find({
    _id: { $in: id },
  });

  // If no quiz are found
  if (!quiz || quiz.length === 0) {
    return next(new AppError(`No quiz found for the provided ID ${id}.`, 404));
  }

  const requestedQuizIds = (Array.isArray(id) ? id : [id])
    .map((item) => asObjectIdOrNull(item))
    .filter(Boolean);

  if (requestedQuizIds.length) {
    await TherapistQuizAssignment.updateMany(
      {
        user: decoded.id,
        quiz: { $in: requestedQuizIds },
        status: 'assigned',
      },
      {
        $set: {
          status: 'in_progress',
        },
        $currentDate: {
          startedAt: true,
        },
      },
    );
  }

  // Respond with the quiz
  res.status(200).json({
    message: 'User quiz retrieved successfully',
    quiz,
  });
});
