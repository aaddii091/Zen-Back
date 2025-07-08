const express = require('express');
const userRoutes = require('./routes/userRoutes');
const quizRoutes = require('./routes/quizRoutes');
const ticketRoutes = require('./routes/ticketRoutes');
const organizationRoutes = require('./routes/organizationRoutes');

const AppError = require('./utils/appError');
const globalErrorHandler = require('./controllers/errorController');
const bodyParser = require('body-parser');

const app = express();
const cors = require('cors');

app.use(cors());

// Add basic error handling
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

app.use(express.json());
app.use(express.static(`${__dirname}/public`));

// Add request logging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// Test route
app.get('/', (req, res) => {
  res.status(200).send(`ZenServer is Running ! ${process.env.DATABASE}`);
});

app.use('/api/v1/users', userRoutes);
app.use('/api/v1/users', quizRoutes);
app.use('/api/v1/tickets', ticketRoutes);
app.use('/api/v1/organizations', organizationRoutes);

// 404 handler
app.all('*', (req, res, next) => {
  next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.statusCode || 500).json({
    status: 'error',
    message: err.message || 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err : {},
  });
});

module.exports = app;
