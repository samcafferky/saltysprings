'use strict';

const { errors } = require('../utils/errors');

// Small fixed-window limiter, keyed by IP. Good enough for login/register.
function rateLimit({ windowMs = 60_000, max = 20 } = {}) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, windowMs);
  timer.unref();

  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.reset - now) / 1000));
      return next(errors.tooManyRequests());
    }
    next();
  };
}

module.exports = { rateLimit };
