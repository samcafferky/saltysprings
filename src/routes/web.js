'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { rateLimit } = require('../middleware/rateLimit');
const { EpicError, errors } = require('../utils/errors');

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Endpoints for the sign-up page and for launchers.
module.exports = function webRoutes(services, config) {
  const router = express.Router();
  const limit = rateLimit({ windowMs: 60_000, max: config.server.rateLimits.registerPerMinute });

  router.get('/api/info', (req, res) =>
    res.json({
      name: 'OGFN Server Emulator',
      registration: config.registration.enabled,
      inviteRequired: Boolean(config.registration.inviteCode),
    }),
  );

  router.post('/api/register', limit, (req, res, next) => {
    const { email, displayName, password, inviteCode } = req.body || {};
    if (!config.registration.enabled) {
      return next(new EpicError('errors.com.epicgames.account.registration_disabled', 'Registration is closed on this server.', 18010, 403));
    }
    if (config.registration.inviteCode && !sameSecret(inviteCode || '', config.registration.inviteCode)) {
      return next(new EpicError('errors.com.epicgames.account.invalid_invite', 'That invite code is not valid.', 18011, 403));
    }
    const account = services.accounts.create({ email, displayName, password });
    services.profiles.createDefaults(account.id);
    services.logger.log(`[account] registered ${account.displayName} (${account.id})`);
    res.status(201).json({ accountId: account.id, displayName: account.displayName });
  });

  // Launchers log in here, then start the game with
  // -AUTH_TYPE=exchangecode -AUTH_PASSWORD=<code>.
  router.post('/api/launcher/exchange', limit, (req, res, next) => {
    const { login, password } = req.body || {};
    const account = services.accounts.checkCredentials(login, password);
    if (!account) return next(errors.invalidCredentials());
    if (account.banned) return next(errors.banned());
    const code = services.tokens.issueExchangeCode(account.id, 'ogfn-launcher');
    res.json({ code: code.token, expiresInSeconds: Math.round((code.expiresAt - Date.now()) / 1000), accountId: account.id, displayName: account.displayName });
  });

  return router;
};
