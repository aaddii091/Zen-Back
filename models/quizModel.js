const mongoose = require('mongoose');

// Define a schema for questions (MCQ, Written, Personality Traits)
const QuestionSchema = new mongoose.Schema({
  text: { type: String, required: true }, // The question text
  trait: { type: String }, // For personality tests, e.g., 'E', 'A', 'C', 'N', 'O'
  positive: { type: Boolean }, // Indicates if the question positively impacts the trait
});

// Define the schema for a quiz
const QuizSchema = new mongoose.Schema({
  title: { type: String, required: true }, // Title of the quiz
  type: {
    type: String,
    enum: ['mcq', 'written', 'mixed', 'poll', 'personality_test'], // Supports various quiz types
    required: true,
  }, // Type of quiz
  questions: [QuestionSchema], // Array of questions
  defaultOptions: [{ type: String }], // Default options (used for polls or personality tests)
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Admin who created the quiz
});

module.exports = mongoose.model('Quiz', QuizSchema);
