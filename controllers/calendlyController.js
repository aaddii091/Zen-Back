const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const TherapistProfile = require('../models/therapistProfileModel');
const Appointment = require('../models/appointmentModel');
const User = require('../models/userModel');

const buildClientRedirectBase = () => {
  const fallback = 'http://localhost:5173/connect-calendly';
  return process.env.CALENDLY_CONNECT_REDIRECT_FRONTEND || fallback;
};

const buildClientRedirectUrl = (status, message) => {
  const base = buildClientRedirectBase();
  const url = new URL(base);
  url.searchParams.set('status', status);
  if (message) {
    url.searchParams.set('message', message);
  }
  return url.toString();
};

const buildAuthUrl = (state) => {
  if (
    !process.env.CALENDLY_CLIENT_ID ||
    !process.env.CALENDLY_REDIRECT_URI
  ) {
    throw new AppError(
      'Calendly OAuth is not configured. Missing client id or redirect uri.',
      500,
    );
  }

  const url = new URL('https://auth.calendly.com/oauth/authorize');
  url.searchParams.set('client_id', process.env.CALENDLY_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', process.env.CALENDLY_REDIRECT_URI);
  url.searchParams.set('state', state);
  return url.toString();
};

const createStateToken = (therapistId) =>
  jwt.sign(
    { therapistId: String(therapistId), type: 'calendly_oauth_state' },
    process.env.JWT_SECRET,
    { expiresIn: '10m' },
  );

const parseStateToken = (state) => {
  try {
    const decoded = jwt.verify(state, process.env.JWT_SECRET);
    if (decoded?.type !== 'calendly_oauth_state' || !decoded?.therapistId) {
      return null;
    }
    return decoded;
  } catch (err) {
    return null;
  }
};

const exchangeCodeForToken = async (code) => {
  const tokenUrl = 'https://auth.calendly.com/oauth/token';
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.CALENDLY_REDIRECT_URI,
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
    throw new AppError(
      data?.error_description || data?.message || 'Failed to exchange Calendly OAuth code.',
      400,
    );
  }

  return data;
};

const refreshAccessToken = async (refreshToken) => {
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
    throw new AppError(
      data?.error_description || data?.message || 'Failed to refresh Calendly access token.',
      400,
    );
  }

  return data;
};

const fetchCalendlyMe = async (accessToken) => {
  const response = await fetch('https://api.calendly.com/users/me', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AppError(
      data?.message || 'Failed to fetch Calendly user information.',
      400,
    );
  }

  return data?.resource || {};
};

const fetchScheduledEvents = async ({
  accessToken,
  calendlyUserUri,
  minStartTime,
  maxStartTime,
}) => {
  const url = new URL('https://api.calendly.com/scheduled_events');
  url.searchParams.set('user', calendlyUserUri);
  url.searchParams.set('min_start_time', minStartTime);
  url.searchParams.set('max_start_time', maxStartTime);
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
  if (!response.ok) {
    throw new AppError(
      data?.message || 'Failed to fetch Calendly scheduled events.',
      400,
    );
  }

  return data?.collection || [];
};

const getFirstInviteeName = async ({ accessToken, eventUri }) => {
  if (!eventUri) return '';

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
  if (!response.ok) return '';

  const invitee = data?.collection?.[0];
  return invitee?.name || invitee?.email || '';
};

const toIsoUtcBoundariesForToday = () => {
  const now = new Date();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(now);
  end.setUTCHours(23, 59, 59, 999);

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
};

const formatTimeLabel = (isoString) => {
  if (!isoString) return 'Time unavailable';
  return new Date(isoString).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
};

const formatTimeRange = (startIso, endIso) => {
  const start = formatTimeLabel(startIso);
  const end = formatTimeLabel(endIso);
  return `${start} - ${end}`;
};

const computeSessionStatus = (startIso, endIso) => {
  const now = new Date();
  const start = new Date(startIso);
  const end = new Date(endIso);

  if (now >= end) {
    return { status: 'completed', statusLabel: 'Completed' };
  }

  if (now >= start && now < end) {
    return { status: 'active', statusLabel: 'In Progress' };
  }

  const minutesUntil = Math.max(0, Math.round((start - now) / (1000 * 60)));
  if (minutesUntil <= 120) {
    return { status: 'upcoming', statusLabel: `${minutesUntil}m until` };
  }

  return { status: 'upcoming', statusLabel: 'Upcoming' };
};

const getSessionChannel = (event) => {
  const location = event?.location || {};
  const locationType = String(location.type || '').toLowerCase();

  if (locationType.includes('zoom') || locationType.includes('google_conference')) {
    return 'Video Call';
  }

  if (locationType.includes('microsoft_teams')) {
    return 'Video Call';
  }

  if (locationType.includes('phone')) {
    return 'Audio Call';
  }

  if (locationType.includes('in_person')) {
    return 'In Person';
  }

  return 'Session';
};

const pickFirstString = (...values) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
};

const asObjectIdOrNull = (value) => {
  if (!value || typeof value !== 'string') return null;
  return mongoose.Types.ObjectId.isValid(value)
    ? new mongoose.Types.ObjectId(value)
    : null;
};

const getWebhookPayload = (reqBody = {}) => reqBody?.payload || {};

const extractTracking = (payload = {}) =>
  payload?.tracking ||
  payload?.invitee?.tracking ||
  payload?.scheduled_event?.tracking ||
  {};

const extractCalendlyUserUriFromPayload = (payload = {}) =>
  pickFirstString(
    payload?.scheduled_event?.event_memberships?.[0]?.user,
    payload?.event_memberships?.[0]?.user,
    payload?.scheduled_event?.created_by,
  );

const ensureValidAccessToken = async (profile) => {
  const hasAccessToken = Boolean(profile?.calendlyAccessToken);
  if (!hasAccessToken) {
    throw new AppError('Calendly access token is missing. Please reconnect Calendly.', 400);
  }

  const tokenExpired =
    profile?.calendlyTokenExpiresAt &&
    new Date(profile.calendlyTokenExpiresAt).getTime() <= Date.now();

  if (!tokenExpired) {
    return profile.calendlyAccessToken;
  }

  if (!profile?.calendlyRefreshToken) {
    throw new AppError('Calendly token expired. Please reconnect Calendly.', 400);
  }

  const tokenData = await refreshAccessToken(profile.calendlyRefreshToken);
  const refreshedToken = tokenData.access_token;
  const refreshedRefreshToken = tokenData.refresh_token || profile.calendlyRefreshToken;
  const expiresInSec = Number(tokenData.expires_in || 3600);
  const expiresAt = new Date(Date.now() + expiresInSec * 1000);

  await TherapistProfile.findOneAndUpdate(
    { user: profile.user },
    {
      $set: {
        calendlyAccessToken: refreshedToken,
        calendlyRefreshToken: refreshedRefreshToken,
        calendlyTokenExpiresAt: expiresAt,
      },
    },
    { runValidators: false },
  );

  return refreshedToken;
};

exports.getConnectUrl = catchAsync(async (req, res) => {
  const state = createStateToken(req.user._id);
  const authUrl = buildAuthUrl(state);

  res.status(200).json({
    status: 'success',
    data: {
      authUrl,
    },
  });
});

exports.callback = catchAsync(async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.redirect(
      buildClientRedirectUrl('error', 'Missing OAuth code or state.'),
    );
  }

  const parsedState = parseStateToken(state);
  if (!parsedState) {
    return res.redirect(buildClientRedirectUrl('error', 'Invalid OAuth state.'));
  }

  try {
    const tokenData = await exchangeCodeForToken(code);
    const calendlyUser = await fetchCalendlyMe(tokenData.access_token);

    const calendlyUserUri = calendlyUser?.uri || '';
    const calendlyOrganizationUri = calendlyUser?.current_organization || '';
    const calendlyUrl = calendlyUser?.scheduling_url || '';
    const calendlyConnected = Boolean(
      calendlyUserUri || calendlyUrl || calendlyOrganizationUri,
    );
    const expiresInSec = Number(tokenData.expires_in || 3600);
    const tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000);

    await TherapistProfile.findOneAndUpdate(
      { user: parsedState.therapistId },
      {
        $set: {
          calendlyConnected,
          calendlyUserUri,
          calendlyOrganizationUri,
          calendlyUrl,
          calendlyConnectedAt: calendlyConnected ? new Date() : null,
          calendlyAccessToken: tokenData.access_token || '',
          calendlyRefreshToken: tokenData.refresh_token || '',
          calendlyTokenExpiresAt: tokenExpiresAt,
        },
        $setOnInsert: {
          user: parsedState.therapistId,
        },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    return res.redirect(buildClientRedirectUrl('success'));
  } catch (error) {
    return res.redirect(
      buildClientRedirectUrl('error', error.message || 'Calendly OAuth failed.'),
    );
  }
});

exports.status = catchAsync(async (req, res) => {
  const profile = await TherapistProfile.findOne({ user: req.user._id });
  const hasOAuthToken = Boolean(profile?.calendlyAccessToken || profile?.calendlyRefreshToken);
  const hasCalendlyIdentity = Boolean(
    profile?.calendlyUserUri || profile?.calendlyOrganizationUri || profile?.calendlyUrl,
  );
  const calendlyConnected = Boolean(
    profile?.calendlyConnected && hasCalendlyIdentity && hasOAuthToken,
  );
  const reconnectRequired = Boolean(profile?.calendlyConnected && hasCalendlyIdentity && !hasOAuthToken);

  res.status(200).json({
    status: 'success',
    data: {
      calendlyConnected,
      reconnectRequired,
      calendlyUserUri: profile?.calendlyUserUri || '',
      calendlyOrganizationUri: profile?.calendlyOrganizationUri || '',
      calendlyUrl: profile?.calendlyUrl || '',
      calendlyConnectedAt: profile?.calendlyConnectedAt || null,
    },
  });
});

exports.todaySessions = catchAsync(async (req, res, next) => {
  const profile = await TherapistProfile.findOne({ user: req.user._id });

  if (!profile || !profile.calendlyConnected || !profile.calendlyUserUri) {
    return next(new AppError('Calendly is not connected for this therapist.', 400));
  }

  const accessToken = await ensureValidAccessToken(profile);
  const { start, end } = toIsoUtcBoundariesForToday();

  const events = await fetchScheduledEvents({
    accessToken,
    calendlyUserUri: profile.calendlyUserUri,
    minStartTime: start,
    maxStartTime: end,
  });

  const eventUris = events
    .map((event) => event?.uri)
    .filter((uri) => typeof uri === 'string' && uri.length > 0);
  const appointments = eventUris.length
    ? await Appointment.find({ calendlyEventUri: { $in: eventUris } })
        .populate('user', 'name email')
        .lean()
    : [];
  const appointmentByEventUri = new Map(
    appointments.map((item) => [item.calendlyEventUri, item]),
  );

  const mappedSessions = [];
  for (const event of events) {
    const appointment = appointmentByEventUri.get(event?.uri);
    const inviteeName = await getFirstInviteeName({
      accessToken,
      eventUri: event?.uri,
    });

    const startTime = event?.start_time;
    const endTime = event?.end_time;
    const statusMeta = computeSessionStatus(startTime, endTime);

    mappedSessions.push({
      id: event?.uri || event?.uuid || `session-${mappedSessions.length + 1}`,
      clientName:
        appointment?.user?.name ||
        appointment?.userName ||
        inviteeName ||
        'Booked Client',
      userId: appointment?.user?._id || appointment?.user || null,
      service: event?.name || 'Therapy Session',
      timeLabel: formatTimeLabel(startTime),
      timeRange: formatTimeRange(startTime, endTime),
      channel: getSessionChannel(event),
      status: statusMeta.status,
      statusLabel: statusMeta.statusLabel,
      statusHint: '',
      startsAt: startTime || null,
      endsAt: endTime || null,
    });
  }

  const sorted = mappedSessions.sort((a, b) => {
    const aTs = a.startsAt ? new Date(a.startsAt).getTime() : 0;
    const bTs = b.startsAt ? new Date(b.startsAt).getTime() : 0;
    return aTs - bTs;
  });

  const highlight = sorted[0] || null;

  res.status(200).json({
    status: 'success',
    data: {
      date: new Date().toISOString(),
      highlight,
      sessions: sorted,
    },
  });
});

exports.webhook = catchAsync(async (req, res) => {
  const eventType = req.body?.event;
  const payload = getWebhookPayload(req.body);
  const tracking = extractTracking(payload);

  const calendlyEventUri = pickFirstString(
    payload?.event,
    payload?.scheduled_event?.uri,
  );
  const calendlyInviteeUri = pickFirstString(
    payload?.uri,
    payload?.invitee?.uri,
  );

  if (!calendlyEventUri) {
    return res.status(200).json({ status: 'ignored', message: 'No calendly event uri.' });
  }

  const userId = asObjectIdOrNull(
    pickFirstString(
      tracking?.utm_content,
      payload?.questions_and_answers?.[0]?.answer,
      payload?.questions_and_answers?.[0]?.value,
    ),
  );

  let therapistId = asObjectIdOrNull(pickFirstString(tracking?.utm_term));
  if (!therapistId) {
    const calendlyUserUri = extractCalendlyUserUriFromPayload(payload);
    if (calendlyUserUri) {
      const therapistProfile = await TherapistProfile.findOne({
        calendlyUserUri,
      }).select('user');
      therapistId = therapistProfile?.user || null;
    }
  }

  const userEmail = pickFirstString(payload?.email, payload?.invitee?.email);
  const userName = pickFirstString(payload?.name, payload?.invitee?.name);
  const timezone = pickFirstString(payload?.timezone, payload?.scheduled_event?.timezone);
  const scheduledAt = payload?.scheduled_event?.start_time || null;
  const endsAt = payload?.scheduled_event?.end_time || null;
  const sessionType = pickFirstString(payload?.scheduled_event?.name, payload?.event_type?.name);

  const isCanceled = eventType === 'invitee.canceled';
  const status = isCanceled ? 'canceled' : 'scheduled';

  let therapistName = '';
  let therapistEmail = '';
  if (therapistId) {
    const therapistUser = await User.findById(therapistId).select('name email');
    therapistName = therapistUser?.name || '';
    therapistEmail = therapistUser?.email || '';
  }

  await Appointment.findOneAndUpdate(
    { calendlyEventUri },
    {
      $set: {
        user: userId,
        therapist: therapistId,
        userName,
        userEmail,
        therapistName,
        therapistEmail,
        scheduledAt,
        endsAt,
        timezone,
        sessionType,
        status,
        calendlyEventUri,
        calendlyInviteeUri,
        tracking,
        rawPayload: req.body,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  res.status(200).json({ status: 'success' });
});

exports.myBookings = catchAsync(async (req, res, next) => {
  const therapistId = req.user?._id;
  if (!therapistId) {
    return next(new AppError('Therapist not found.', 404));
  }

  const bookings = await Appointment.find({ therapist: therapistId })
    .sort({ scheduledAt: 1 })
    .populate('user', 'name email')
    .lean();

  res.status(200).json({
    status: 'success',
    results: bookings.length,
    data: bookings,
  });
});

exports.disconnect = catchAsync(async (req, res) => {
  await TherapistProfile.findOneAndUpdate(
    { user: req.user._id },
    {
      $set: {
        calendlyConnected: false,
        calendlyUserUri: '',
        calendlyOrganizationUri: '',
        calendlyUrl: '',
        calendlyConnectedAt: null,
        calendlyAccessToken: '',
        calendlyRefreshToken: '',
        calendlyTokenExpiresAt: null,
      },
      $setOnInsert: {
        user: req.user._id,
      },
    },
    {
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );

  res.status(200).json({
    status: 'success',
    message: 'Calendly disconnected successfully.',
  });
});
