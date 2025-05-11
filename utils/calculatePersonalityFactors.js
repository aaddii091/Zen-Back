// utils/pfScoringService.js
const catchAsync = require('../utils/catchAsync');
const stenChart = require('../charts/StenChart');

exports.calculatePersonalityFactors = catchAsync(async (req, res, next) => {
  console.log(req.body);

  if (req.body.quizType === 'poll PF') {
    // For now, just log. You’ll write the actual scoring logic later
    console.log('Processing PF scoring for:', req.body._id);

    const traitScores = {};

    for (const questionId in req.body.answers) {
      const { trait, point } = req.body.answers[questionId];
      if (trait) {
        traitScores[trait] = (traitScores[trait] || 0) + parseInt(point);
      }
    }

    console.log('Trait scores:', traitScores);

    function getStenScores(rawScores) {
      const stenScores = {};

      for (const [trait, value] of Object.entries(rawScores)) {
        const ranges = stenChart[trait];
        if (!ranges) continue;

        for (let i = 0; i < ranges.length; i++) {
          const [min, max] = ranges[i];
          if (value >= min && value <= max) {
            stenScores[trait] = i + 1;
            break;
          }
        }
      }
      console.log(stenScores);

      return stenScores;
    }
    // now calculating Sten Score
    if (req.body.gender === 'Male') {
      const StenScore = getStenScores(traitScores);
      return res.status(200).json({
        RawScore: traitScores,
        StenScore: StenScore,
      });
    }
  } else {
    return res.status(400).json({
      message: 'Invalid quiz type. Valid types are mcq, written, or mixed.',
    });
  }
});
