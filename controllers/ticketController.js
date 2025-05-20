const Ticket = require('../models/ticketModel');
const catchAsync = require('../utils/catchAsync');

exports.createTicket = catchAsync(async (req, res, next) => {
  const { title, message, file, organization } = req.body;

  if (!title || !message) {
    return res.status(400).json({ message: 'Title and message are required' });
  }

  const ticket = await Ticket.create({
    title,
    message,
    file,
    organization,
    createdBy: req.user._id,
  });

  res.status(201).json({ status: 'success', data: ticket });
});

exports.getTickets = catchAsync(async (req, res, next) => {
  const filter = {};

  // allow filtering by organization
  if (req.query.organization) {
    filter.organization = req.query.organization;
  }

  // regular users may only access their own tickets
  if (req.user.role !== 'admin') {
    filter.createdBy = req.user._id;
  } else if (req.query.user) {
    // admins can optionally filter by user id
    filter.createdBy = req.query.user;
  }

  const tickets = await Ticket.find(filter).sort('-createdAt');

  res.status(200).json({
    status: 'success',
    results: tickets.length,
    data: tickets,
  });
});
