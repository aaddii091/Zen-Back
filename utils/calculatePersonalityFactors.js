// utils/pfScoringService.js
const catchAsync = require('../utils/catchAsync');
const stenChart = require('../charts/StenChart');

const buildTraitScores = (answers) => {
  const traitScores = {};
  const source = answers instanceof Map ? Object.fromEntries(answers.entries()) : answers || {};

  for (const questionId in source) {
    const entry = source[questionId] || {};
    const trait = String(entry?.trait || '').trim();
    const point = Number.parseInt(entry?.point, 10);
    if (!trait) continue;
    traitScores[trait] = (traitScores[trait] || 0) + (Number.isFinite(point) ? point : 0);
  }

  return traitScores;
};

const getStenScores = (rawScores) => {
  const stenScores = {};

  for (const [trait, value] of Object.entries(rawScores || {})) {
    const ranges = stenChart[trait];
    if (!ranges) continue;

    for (let i = 0; i < ranges.length; i += 1) {
      const [min, max] = ranges[i];
      if (value >= min && value <= max) {
        stenScores[trait] = i + 1;
        break;
      }
    }
  }

  return stenScores;
};

const computePersonalityFactorsFromPayload = (payload = {}) => {
  if (String(payload?.quizType || '') !== 'poll PF') {
    throw new Error('Invalid quiz type for PF scoring.');
  }

  const rawScore = buildTraitScores(payload?.answers);
  const stenScore = getStenScores(rawScore);

  return {
    RawScore: rawScore,
    StenScore: stenScore,
  };
};

exports.computePersonalityFactorsFromPayload = computePersonalityFactorsFromPayload;

exports.calculatePersonalityFactors = catchAsync(async (req, res) => {
  try {
    const result = computePersonalityFactorsFromPayload(req.body || {});
    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({
      message: error?.message || 'Unable to calculate personality factors.',
    });
  }
});
