const express = require('express');
const authController = require('../controllers/authController');
const ticketController = require('../controllers/ticketController');

const router = express.Router();

router.post(
  '/',
  authController.protect,
  ticketController.uploadTicketFile,
  ticketController.createTicket
);
router.get('/queue', authController.protect, ticketController.listSafeguardingQueue);
router.patch('/:id/status', authController.protect, ticketController.updateTicketStatus);
router.get('/', authController.protect, ticketController.getTickets);

module.exports = router;
