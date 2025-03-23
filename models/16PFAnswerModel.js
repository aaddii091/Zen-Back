const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema(
  {
    answer: {
      type: String,
      required: true,
    },
    point: {
      type: String, // or Number if you control the data type and it's always numeric
      required: true,
    },
    trait: {
      type: String,
      required: true,
    },
  },
  { _id: false }
);

const answerSheetSchema = new mongoose.Schema(
  {
    quizId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Quiz',
      required: true,
    },
    quizName: {
      type: String,
      required: true,
    },
    quizType: {
      type: String,
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false, // make it required: true if you always track user
    },
    answers: {
      type: Map,
      of: answerSchema,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('AnswerSheet', answerSheetSchema);
