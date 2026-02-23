const express = require('express');
const userRoutes = require('./routes/userRoutes');
const quizRoutes = require('./routes/quizRoutes');
const ticketRoutes = require('./routes/ticketRoutes');
const organizationRoutes = require('./routes/organizationRoutes');
const voiceRoutes = require('./routes/voiceRoutes');
const userInfoRoutes = require('./routes/userInfoRoutes');
const therapistProfileRoutes = require('./routes/therapistProfileRoutes');
const calendlyRoutes = require('./routes/calendlyRoutes');
const aiAssistantRoutes = require('./routes/aiAssistantRoutes');
const therapyChatRoutes = require('./routes/therapyChatRoutes');

const AppError = require('./utils/appError');
const globalErrorHandler = require('./controllers/errorController');
const bodyParser = require('body-parser');

const app = express();
const cors = require('cors');

app.use(cors());
app.options('*', cors());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

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
app.use('/api/v1/voice', voiceRoutes);
app.use('/api/v1/user-info', userInfoRoutes);
app.use('/api/v1/therapist-profile', therapistProfileRoutes);
app.use('/api/v1/calendly', calendlyRoutes);
app.use('/api/v1/ai-assistant', aiAssistantRoutes);
app.use('/api/v1/therapy-chat', therapyChatRoutes);

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
