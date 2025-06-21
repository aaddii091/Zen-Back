const Ticket = require('../models/ticketModel');
const catchAsync = require('../utils/catchAsync');
const multer = require('multer');
const AppError = require('../utils/appError');

// Configure multer to accept images only and store them in memory
const storage = multer.memoryStorage();
const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new AppError('Only image files are allowed', 400), false);
  }
};

exports.uploadTicketFile = multer({ storage, fileFilter }).single('file');

exports.createTicket = catchAsync(async (req, res, next) => {
  const { title, message, organization } = req.body;

  if (!title || !message) {
    return res.status(400).json({ message: 'Title and message are required' });
  }

  const ticketData = {
    title,
    message,
    organization,
    createdBy: req.user._id,
  };

  if (req.file) {
    ticketData.file = {
      data: req.file.buffer,
      contentType: req.file.mimetype,
    };
  }

  const ticket = await Ticket.create(ticketData);

  res.status(201).json({ status: 'success', data: ticket });
});

exports.getTickets = catchAsync(async (req, res, next) => {
  const filter = {};
  if (req.query.organization) {
    filter.organization = req.query.organization;
  }

  if (req.user.role !== 'admin') {
    filter.createdBy = req.user._id;
  }

  const tickets = await Ticket.find(filter).sort('-createdAt');

  res
    .status(200)
    .json({ status: 'success', results: tickets.length, data: tickets });
});
