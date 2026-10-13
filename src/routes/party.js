'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { errors } = require('../utils/errors');

const BASE = '/party/api/v1/Fortnite';

module.exports = function partyRoutes(services) {
  const router = express.Router();
  const auth = requireAuth(services);
  const parties = services.parties;

  // Only lets a player act as themselves (the :accountId in the path).
  const self = (param) => (req, res, next) =>
    req.account.id === req.params[param] ? next() : next(errors.forbidden(`You can't act as ${req.params[param]}`));

  // Invites, pings and join requests only go between friends.
  const friendOf = (param) => (req, res, next) =>
    services.friends.areFriends(req.account.id, req.params[param]) ? next() : next(errors.forbidden('You can only do that with friends'));

  // Party contents are only visible to members, or to someone invited or pinged.
  const canSee = (party, accountId) =>
    party.members.some((m) => m.account_id === accountId) ||
    party.invites.some((i) => i.sent_to === accountId) ||
    party.members.some((m) => parties.pings.has(`${accountId}:${m.account_id}`)) ||
    party.config.joinability === 'OPEN';

  router.get(`${BASE}/user/:accountId`, auth, self('accountId'), (req, res) => res.json(parties.userSummary(req.account.id)));
  router.get(`${BASE}/user/:accountId/notifications/undelivered/count`, auth, self('accountId'), (req, res) => {
    const summary = parties.userSummary(req.account.id);
    res.json({ pings: summary.pings.length, invites: summary.invites.length });
  });

  router.post(`${BASE}/parties`, auth, (req, res) => res.json(parties.create(req.account.id, req.body || {})));

  router.get(`${BASE}/parties/:partyId`, auth, (req, res, next) => {
    const party = parties.get(req.params.partyId);
    if (!canSee(party, req.account.id)) return next(errors.forbidden('You are not in this party'));
    res.json(party);
  });

  router.patch(`${BASE}/parties/:partyId`, auth, (req, res) => {
    parties.update(req.params.partyId, req.account.id, req.body || {});
    res.status(204).end();
  });

  router.patch(`${BASE}/parties/:partyId/members/:accountId/meta`, auth, self('accountId'), (req, res) => {
    parties.updateMember(req.params.partyId, req.account.id, req.body || {});
    res.status(204).end();
  });

  router.post(`${BASE}/parties/:partyId/members/:accountId/join`, auth, self('accountId'), (req, res) => {
    const party = parties.join(req.params.partyId, req.account.id, req.body || {});
    res.json({ status: 'JOINED', party_id: party.id });
  });

  // Leaving yourself, or the leader kicking someone.
  router.delete(`${BASE}/parties/:partyId/members/:accountId`, auth, (req, res, next) => {
    const party = parties.get(req.params.partyId);
    const me = party.members.find((m) => m.account_id === req.account.id);
    if (req.params.accountId !== req.account.id && (!me || me.role !== 'CAPTAIN')) {
      return next(errors.forbidden('Only the party leader can kick players'));
    }
    parties.leave(party.id, req.params.accountId);
    res.status(204).end();
  });

  router.post(`${BASE}/parties/:partyId/members/:accountId/promote`, auth, (req, res) => {
    parties.promote(req.params.partyId, req.account.id, req.params.accountId);
    res.status(204).end();
  });

  router.post(`${BASE}/parties/:partyId/invites/:accountId`, auth, friendOf('accountId'), (req, res) => {
    parties.invite(req.params.partyId, req.account.id, req.params.accountId, req.body || {});
    res.status(204).end();
  });

  router.post(`${BASE}/parties/:partyId/invites/:accountId/decline`, auth, self('accountId'), (req, res) => {
    parties.declineInvite(req.params.partyId, req.account.id);
    res.status(204).end();
  });

  router.post(`${BASE}/user/:accountId/pings/:pingerId`, auth, self('pingerId'), friendOf('accountId'), (req, res) =>
    res.json(parties.ping(req.account.id, req.params.accountId, (req.body || {}).meta || {})),
  );
  router.get(`${BASE}/user/:accountId/pings/:pingerId/parties`, auth, self('accountId'), (req, res) =>
    res.json(parties.pingerParties(req.account.id, req.params.pingerId)),
  );
  router.delete(`${BASE}/user/:accountId/pings/:pingerId`, auth, self('accountId'), (req, res) => {
    parties.deletePing(req.account.id, req.params.pingerId);
    res.status(204).end();
  });

  // "Request to join": forwarded to the other player as a ping.
  router.post(`${BASE}/members/:accountId/intentions/:senderId`, auth, self('senderId'), friendOf('accountId'), (req, res) => {
    const ping = parties.ping(req.account.id, req.params.accountId, (req.body || {}).meta || {});
    res.json({ requester_id: req.account.id, requester_dn: req.account.displayName, requester_pl: 'win', requester_pl_dn: req.account.displayName, requestee_id: req.params.accountId, meta: ping.meta, expires_at: ping.expires_at, sent_at: ping.sent_at });
  });

  return router;
};
