'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { EpicError, errors } = require('../utils/errors');

// Admin API. Turned off unless admin.apiKey (or ADMIN_KEY) is set.
// Send the key as "Authorization: Bearer <key>".
module.exports = function adminRoutes(services, config) {
  const router = express.Router();

  router.use('/admin/api', (req, res, next) => {
    const key = config.admin.apiKey;
    if (!key) return next(errors.notFound());
    const given = Buffer.from(String(req.headers.authorization || '').replace(/^bearer\s+/i, ''));
    const expected = Buffer.from(key);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return next(errors.forbidden('Invalid admin key'));
    next();
  });

  const findAccount = (req) => {
    const id = req.params.account;
    const account = services.accounts.findById(id) || services.accounts.findByDisplayName(id);
    if (!account) throw new EpicError('errors.com.epicgames.account.account_not_found', `Account ${id} not found`, 18007, 404);
    return account;
  };
  const summary = (a) => ({ id: a.id, displayName: a.displayName, email: a.email, createdAt: a.createdAt, lastLogin: a.lastLogin, banned: a.banned, isAdmin: a.isAdmin });

  router.get('/admin/api/accounts', (req, res) => res.json(services.accounts.list().map(summary)));
  router.get('/admin/api/accounts/:account', (req, res) => {
    const account = findAccount(req);
    const vbucks = services.profiles.get(account.id, 'common_core').items['Currency:MtxPurchased'];
    res.json({ ...summary(account), vbucks: vbucks ? vbucks.quantity : 0 });
  });
  router.post('/admin/api/accounts/:account/ban', (req, res) => {
    const account = findAccount(req);
    services.accounts.setBanned(account.id, true);
    services.tokens.revokeAllForAccount(account.id);
    services.events.emit('account:banned', { accountId: account.id });
    res.status(204).end();
  });
  router.post('/admin/api/accounts/:account/unban', (req, res) => {
    services.accounts.setBanned(findAccount(req).id, false);
    res.status(204).end();
  });
  router.post('/admin/api/accounts/:account/vbucks', (req, res, next) => {
    const amount = Number((req.body || {}).amount);
    if (!Number.isFinite(amount)) return next(errors.badRequest('amount must be a number'));
    services.profiles.setVbucks(findAccount(req).id, amount);
    res.status(204).end();
  });
  router.post('/admin/api/accounts/:account/items', (req, res, next) => {
    const items = (req.body || {}).items;
    if (!Array.isArray(items) || !items.every((i) => typeof i === 'string' && i.includes(':'))) {
      return next(errors.badRequest('items must be a list like ["AthenaCharacter:CID_028_Athena_Commando_F"]'));
    }
    res.json({ added: services.profiles.grantItems(findAccount(req).id, items) });
  });
  router.delete('/admin/api/accounts/:account', (req, res) => {
    const account = findAccount(req);
    services.events.emit('account:banned', { accountId: account.id });
    services.accounts.delete(account.id);
    res.status(204).end();
  });

  router.post('/admin/api/shop/reload', (req, res) => {
    services.catalog.reload();
    res.status(204).end();
  });

  // Game servers can be added/removed while running (not saved to config.json).
  router.get('/admin/api/gameservers', (req, res) => res.json(config.matchmaking.gameServers));
  router.post('/admin/api/gameservers', (req, res, next) => {
    const { ip, port, regions = [], playlists = [], customKey = null, maxPlayers } = req.body || {};
    if (!ip || !Number.isInteger(Number(port))) return next(errors.badRequest('ip and port are required'));
    const server = { ip: String(ip), port: Number(port), regions, playlists, customKey, maxPlayers };
    config.matchmaking.gameServers.push(server);
    res.status(201).json(server);
  });
  router.delete('/admin/api/gameservers/:index', (req, res, next) => {
    const index = Number(req.params.index);
    if (!config.matchmaking.gameServers[index]) return next(errors.notFound());
    config.matchmaking.gameServers.splice(index, 1);
    res.status(204).end();
  });

  return router;
};
