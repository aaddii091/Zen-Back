// IMPORTS

const app = require('./index');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

//config for .env

dotenv.config({ path: './config.env' });

// Cache the database connection
let isConnected = false;

// Improved database connection with timeout handling
const connectDB = async () => {
  if (isConnected) return;

  if (!process.env.DATABASE) {
    console.error('DATABASE environment variable is not defined');
    throw new Error('Missing DATABASE connection string');
  }

  try {
    await mongoose.connect(process.env.DATABASE, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      bufferCommands: false,
      serverSelectionTimeoutMS: 5000, // 5 seconds
      socketTimeoutMS: 10000, // 10 seconds
    });

    isConnected = true;
    console.log('DB connection successful!');
  } catch (error) {
    isConnected = false;
    console.error('MongoDB connection error:', error);
    throw error;
  }
};

// Initiate database connection once per cold start
const connectPromise = connectDB();

// Add request timeout middleware
app.use((req, res, next) => {
  req.setTimeout(10000); // 10 second timeout for requests
  next();
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.statusCode || 500).json({
    status: 'error',
    message: err.message || 'Something went wrong!',
  });
});

// Only start server in development
if (process.env.NODE_ENV !== 'production') {
  const port = process.env.PORT || 3000;
  connectPromise
    .then(() => {
      app.listen(port, () => {
        console.log(`Development server running on port ${port}`);
      });
    })
    .catch((err) => {
      console.error('Failed to connect to database:', err);
    });
}

module.exports = async (req, res) => {
  try {
    await connectPromise;
    return app(req, res);
  } catch (err) {
    console.error('Database connection failed:', err);
    res
      .status(500)
      .json({ status: 'error', message: 'Database connection failed' });
  }
};
