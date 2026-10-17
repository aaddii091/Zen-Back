const mongoose = require('mongoose');
const multer = require('multer');

const Ticket = require('../models/ticketModel');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const storage = multer.memoryStorage();
const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new AppError('Only image files are allowed', 400), false);
  }
};

const MANAGEABLE_ROLES = new Set(['admin', 'therapist']);
const SAFEGUARDING_KINDS = new Set(['incident', 'complaint']);
const STATUS_VALUES = new Set(['queued', 'in_progress', 'addressed']);

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const parseStringList = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }

  if (typeof value !== 'string') return [];
  const raw = value.trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => String(item || '').trim())
        .filter(Boolean);
    }
  } catch {
    // Ignore JSON parse failure and fall back to comma-separated input.
  }

  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const asObjectIdOrNull = (value) => {
  const raw = String(value || '').trim();
  return mongoose.Types.ObjectId.isValid(raw)
    ? new mongoose.Types.ObjectId(raw)
    : null;
};

const ensureQueueManager = (req, next) => {
  if (!MANAGEABLE_ROLES.has(String(req.user?.role || ''))) {
    next(new AppError('Only therapists or admins can manage the safeguarding queue.', 403));
    return true;
  }
  return false;
};

const formatReporter = (ticket) => {
  if (ticket?.anonymous) {
    return {
      label: 'Anonymous report',
      name: '',
      email: '',
      role: '',
      isAnonymous: true,
    };
  }

  const createdBy = ticket?.createdBy || {};
  const snapshot = ticket?.reporterSnapshot || {};
  const name = createdBy?.name || snapshot?.name || '';
  const email = createdBy?.email || snapshot?.email || '';
  const role = createdBy?.role || snapshot?.role || '';

  return {
    label: name || email || 'Student reporter',
    name,
    email,
    role,
    isAnonymous: false,
  };
};

const mapTicketPayload = (ticket, options = {}) => {
  const includeInternal = Boolean(options.includeInternal);
  const reporter = formatReporter(ticket);

  return {
    id: ticket?._id,
    title: ticket?.title || '',
    message: ticket?.message || '',
    kind: ticket?.kind || 'support',
    issueTypes: Array.isArray(ticket?.issueTypes) ? ticket.issueTypes : [],
    anonymous: Boolean(ticket?.anonymous),
    reporter,
    requestImmediateSupport: Boolean(ticket?.requestImmediateSupport),
    retaliationRisk: Boolean(ticket?.retaliationRisk),
    location: ticket?.location || '',
    occurredAt: ticket?.occurredAt || null,
    status: ticket?.status || 'queued',
    organization: ticket?.organization || '',
    createdAt: ticket?.createdAt || null,
    addressedAt: ticket?.addressedAt || null,
    hasAttachment: Boolean(ticket?.file?.data && ticket?.file?.contentType),
    addressedBy: ticket?.addressedBy
      ? {
          id: ticket.addressedBy?._id || ticket.addressedBy,
          name: ticket.addressedBy?.name || '',
          email: ticket.addressedBy?.email || '',
        }
      : null,
    internalNotes: includeInternal ? ticket?.internalNotes || '' : '',
  };
};

const buildSafeguardingAnalytics = async () => {
  const [
    complaintsAddressed,
    incidentsAddressed,
    complaintsOpen,
    incidentsOpen,
  ] = await Promise.all([
    Ticket.countDocuments({ kind: 'complaint', status: 'addressed' }),
    Ticket.countDocuments({ kind: 'incident', status: 'addressed' }),
    Ticket.countDocuments({ kind: 'complaint', status: { $ne: 'addressed' } }),
    Ticket.countDocuments({ kind: 'incident', status: { $ne: 'addressed' } }),
  ]);

  return {
    complaintsAddressed,
    incidentsAddressed,
    complaintsOpen,
    incidentsOpen,
  };
};

exports.uploadTicketFile = multer({ storage, fileFilter }).single('file');

exports.createTicket = catchAsync(async (req, res) => {
  const title = String(req.body?.title || req.body?.subject || '').trim();
  const message = String(req.body?.message || req.body?.description || '').trim();

  if (!title || !message) {
    return res.status(400).json({ message: 'Title and message are required' });
  }

  const rawKind = String(req.body?.kind || req.body?.submissionType || 'support').trim().toLowerCase();
  const kind = SAFEGUARDING_KINDS.has(rawKind) ? rawKind : 'support';

  const ticketData = {
    title,
    message,
    kind,
    issueTypes: parseStringList(req.body?.issueTypes),
    anonymous: parseBoolean(req.body?.anonymous, false),
    requestImmediateSupport: parseBoolean(req.body?.requestImmediateSupport, false),
    retaliationRisk: parseBoolean(req.body?.retaliationRisk, false),
    location: String(req.body?.location || '').trim(),
    organization: String(req.user?.organization || req.body?.organization || '').trim(),
    createdBy: req.user._id,
    reporterSnapshot: {
      name: String(req.user?.name || '').trim(),
      email: String(req.user?.email || '').trim(),
      role: String(req.user?.role || '').trim(),
    },
  };

  const occurredAt = req.body?.occurredAt ? new Date(req.body.occurredAt) : null;
  if (occurredAt && !Number.isNaN(occurredAt.getTime())) {
    ticketData.occurredAt = occurredAt;
  }

  if (req.file) {
    ticketData.file = {
      data: req.file.buffer,
      contentType: req.file.mimetype,
    };
  }

  const ticket = await Ticket.create(ticketData);

  res.status(201).json({
    status: 'success',
    data: mapTicketPayload(ticket),
  });
});

exports.getTickets = catchAsync(async (req, res) => {
  const filter = {};

  if (req.query.organization) {
    filter.organization = String(req.query.organization);
  }

  if (req.query.kind) {
    filter.kind = String(req.query.kind);
  }

  if (req.user.role === 'user') {
    filter.createdBy = req.user._id;
  }

  const tickets = await Ticket.find(filter)
    .populate('createdBy', 'name email role')
    .populate('addressedBy', 'name email')
    .sort({ createdAt: -1 });

  res.status(200).json({
    status: 'success',
    results: tickets.length,
    data: tickets.map((ticket) =>
      mapTicketPayload(ticket, { includeInternal: MANAGEABLE_ROLES.has(String(req.user?.role || '')) }),
    ),
  });
});

exports.listSafeguardingQueue = catchAsync(async (req, res, next) => {
  if (ensureQueueManager(req, next)) return;

  const filter = {
    kind: { $in: ['incident', 'complaint'] },
  };

  if (req.query.status) {
    const status = String(req.query.status).trim().toLowerCase();
    if (STATUS_VALUES.has(status)) {
      filter.status = status;
    }
  } else {
    filter.status = { $ne: 'addressed' };
  }

  const items = await Ticket.find(filter)
    .populate('createdBy', 'name email role')
    .populate('addressedBy', 'name email')
    .sort({ createdAt: 1 });

  const analytics = await buildSafeguardingAnalytics();

  res.status(200).json({
    status: 'success',
    data: {
      queue: items.map((ticket, index) => ({
        ...mapTicketPayload(ticket, { includeInternal: true }),
        queuePosition: index + 1,
      })),
      analytics,
    },
  });
});

exports.updateTicketStatus = catchAsync(async (req, res, next) => {
  if (ensureQueueManager(req, next)) return;

  const ticketId = asObjectIdOrNull(req.params?.id);
  if (!ticketId) {
    return next(new AppError('Invalid ticket id.', 400));
  }

  const ticket = await Ticket.findById(ticketId);
  if (!ticket) {
    return next(new AppError('Safeguarding case not found.', 404));
  }

  if (!SAFEGUARDING_KINDS.has(String(ticket.kind || ''))) {
    return next(new AppError('Only incident and complaint reports can be updated from the safeguarding queue.', 400));
  }

  const nextStatus = String(req.body?.status || '').trim().toLowerCase();
  if (!STATUS_VALUES.has(nextStatus)) {
    return next(new AppError('Valid status is required.', 400));
  }

  ticket.status = nextStatus;
  ticket.internalNotes = String(req.body?.internalNotes || ticket.internalNotes || '').trim();

  if (nextStatus === 'addressed') {
    ticket.addressedAt = new Date();
    ticket.addressedBy = req.user._id;
  } else {
    ticket.addressedAt = null;
    ticket.addressedBy = null;
  }

  await ticket.save({ validateBeforeSave: false });

  const hydrated = await Ticket.findById(ticket._id)
    .populate('createdBy', 'name email role')
    .populate('addressedBy', 'name email');

  res.status(200).json({
    status: 'success',
    data: mapTicketPayload(hydrated, { includeInternal: true }),
  });
});
