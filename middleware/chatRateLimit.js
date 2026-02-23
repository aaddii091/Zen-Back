const AppError = require('../utils/appError');

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 45;
const buckets = new Map();

const sweepExpired = (now) => {
  for (const [key, value] of buckets.entries()) {
    if (value.resetAt <= now) {
      buckets.delete(key);
    }
  }
};

module.exports = (req, res, next) => {
  const now = Date.now();
  if (buckets.size > 5000) {
    sweepExpired(now);
  }

  const identifier =
    String(req.user?._id || '') ||
    String(req.ip || req.headers['x-forwarded-for'] || 'anonymous');

  const existing = buckets.get(identifier);
  if (!existing || existing.resetAt <= now) {
    buckets.set(identifier, {
      count: 1,
      resetAt: now + WINDOW_MS,
    });
    return next();
  }

  if (existing.count >= MAX_REQUESTS_PER_WINDOW) {
    return next(
      new AppError(
        'Too many chat requests. Please wait a minute and try again.',
        429,
      ),
    );
  }

  existing.count += 1;
  buckets.set(identifier, existing);
  return next();
};
