'use strict';

const express = require('express');
const { requireAuth, requireSelf } = require('../middleware/auth');

module.exports = function friendRoutes(services) {
  const router = express.Router();
  const own = [requireAuth(services), requireSelf()];
  const friends = services.friends;

  // ----- Old API (roughly Seasons 1-7) -----
  router.get('/friends/api/public/friends/:accountId', ...own, (req, res) => {
    const id = req.account.id;
    res.json([
      ...friends.friends(id).map((f) => ({ accountId: f.accountId, status: 'ACCEPTED', direction: 'OUTBOUND', created: f.created, favorite: false })),
      ...friends.incoming(id).map((f) => ({ accountId: f.accountId, status: 'PENDING', direction: 'INBOUND', created: f.created, favorite: false })),
      ...friends.outgoing(id).map((f) => ({ accountId: f.accountId, status: 'PENDING', direction: 'OUTBOUND', created: f.created, favorite: false })),
    ]);
  });
  router.post('/friends/api/public/friends/:accountId/:friendId', ...own, (req, res) => {
    friends.add(req.account.id, req.params.friendId);
    res.status(204).end();
  });
  router.delete('/friends/api/public/friends/:accountId/:friendId', ...own, (req, res) => {
    friends.remove(req.account.id, req.params.friendId);
    res.status(204).end();
  });
  router.get('/friends/api/public/blocklist/:accountId', ...own, (req, res) =>
    res.json({ blockedUsers: friends.blocked(req.account.id).map((b) => b.accountId) }),
  );
  router.post('/friends/api/public/blocklist/:accountId/:friendId', ...own, (req, res) => {
    friends.block(req.account.id, req.params.friendId);
    res.status(204).end();
  });
  router.delete('/friends/api/public/blocklist/:accountId/:friendId', ...own, (req, res) => {
    friends.unblock(req.account.id, req.params.friendId);
    res.status(204).end();
  });
  router.get('/friends/api/public/list/fortnite/:accountId/recentPlayers', ...own, (req, res) => res.json([]));
  router.get('/friends/api/v1/:accountId/settings', ...own, (req, res) => res.json({ acceptInvites: 'public', mutualPrivacy: 'ALL' }));
  router.put('/friends/api/v1/:accountId/settings', ...own, (req, res) => res.json({ acceptInvites: 'public', mutualPrivacy: 'ALL' }));

  // ----- New API (v1) -----
  const friendV1 = (f) => ({ accountId: f.accountId, groups: [], mutual: 0, alias: '', note: '', favorite: false, created: f.created });
  const requestV1 = (f) => ({ accountId: f.accountId, mutual: 0, favorite: false, created: f.created });

  router.get('/friends/api/v1/:accountId/summary', ...own, (req, res) => {
    const id = req.account.id;
    res.json({
      friends: friends.friends(id).map(friendV1),
      incoming: friends.incoming(id).map(requestV1),
      outgoing: friends.outgoing(id).map(requestV1),
      suggested: [],
      blocklist: friends.blocked(id).map((b) => ({ accountId: b.accountId })),
      settings: { acceptInvites: 'public' },
    });
  });
  router.get('/friends/api/v1/:accountId/friends', ...own, (req, res) => res.json(friends.friends(req.account.id).map(friendV1)));
  router.get('/friends/api/v1/:accountId/incoming', ...own, (req, res) => res.json(friends.incoming(req.account.id).map(requestV1)));
  router.get('/friends/api/v1/:accountId/outgoing', ...own, (req, res) => res.json(friends.outgoing(req.account.id).map(requestV1)));
  router.get('/friends/api/v1/:accountId/suggested', ...own, (req, res) => res.json([]));
  router.get('/friends/api/v1/:accountId/recent/:namespace', ...own, (req, res) => res.json([]));
  router.get('/friends/api/v1/:accountId/blocklist', ...own, (req, res) =>
    res.json(friends.blocked(req.account.id).map((b) => ({ accountId: b.accountId }))),
  );
  router.post(['/friends/api/v1/:accountId/friends/:friendId', '/friends/api/v1/:accountId/incoming/accept/:friendId'], ...own, (req, res) => {
    friends.add(req.account.id, req.params.friendId);
    res.status(204).end();
  });
  router.delete(['/friends/api/v1/:accountId/friends/:friendId', '/friends/api/v1/:accountId/incoming/:friendId', '/friends/api/v1/:accountId/outgoing/:friendId'], ...own, (req, res) => {
    friends.remove(req.account.id, req.params.friendId);
    res.status(204).end();
  });
  router.post('/friends/api/v1/:accountId/blocklist/:friendId', ...own, (req, res) => {
    friends.block(req.account.id, req.params.friendId);
    res.status(204).end();
  });
  router.delete('/friends/api/v1/:accountId/blocklist/:friendId', ...own, (req, res) => {
    friends.unblock(req.account.id, req.params.friendId);
    res.status(204).end();
  });
  router.put('/friends/api/v1/:accountId/friends/:friendId/alias', ...own, (req, res) => res.status(204).end());
  router.delete('/friends/api/v1/:accountId/friends/:friendId/alias', ...own, (req, res) => res.status(204).end());
  router.put('/friends/api/v1/:accountId/friends/:friendId/note', ...own, (req, res) => res.status(204).end());

  return router;
};
