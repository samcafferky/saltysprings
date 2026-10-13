'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { start, xmppLogin: login } = require('./helpers');

const xmppLogin = (u) => login(t, u);

let t;
before(async () => (t = await start()));
after(() => t.close());

test('friend request, accept, summary and remove', async () => {
  const a = await t.user('SocA');
  const b = await t.user('SocB');
  const add = await t.request('POST', `/friends/api/v1/${a.accountId}/friends/${b.accountId}`, { token: a.token });
  assert.equal(add.status, 204);

  let summary = await t.request('GET', `/friends/api/v1/${b.accountId}/summary`, { token: b.token });
  assert.equal(summary.body.incoming[0].accountId, a.accountId);

  // B accepting is just B adding A back.
  await t.request('POST', `/friends/api/v1/${b.accountId}/friends/${a.accountId}`, { token: b.token });
  summary = await t.request('GET', `/friends/api/v1/${a.accountId}/summary`, { token: a.token });
  assert.equal(summary.body.friends[0].accountId, b.accountId);
  assert.equal(summary.body.outgoing.length, 0);

  const old = await t.request('GET', `/friends/api/public/friends/${b.accountId}`, { token: b.token });
  assert.equal(old.body[0].status, 'ACCEPTED');

  await t.request('DELETE', `/friends/api/v1/${a.accountId}/friends/${b.accountId}`, { token: a.token });
  summary = await t.request('GET', `/friends/api/v1/${b.accountId}/summary`, { token: b.token });
  assert.equal(summary.body.friends.length, 0);
});

test('blocking stops friend requests', async () => {
  const a = await t.user('SocC');
  const b = await t.user('SocD');
  await t.request('POST', `/friends/api/v1/${a.accountId}/blocklist/${b.accountId}`, { token: a.token });
  const res = await t.request('POST', `/friends/api/v1/${b.accountId}/friends/${a.accountId}`, { token: b.token });
  assert.equal(res.status, 403);
  const list = await t.request('GET', `/friends/api/public/blocklist/${a.accountId}`, { token: a.token });
  assert.deepEqual(list.body.blockedUsers, [b.accountId]);
});

test('cannot read someone else\'s friends list', async () => {
  const a = await t.user('SocE');
  const b = await t.user('SocF');
  assert.equal((await t.request('GET', `/friends/api/v1/${b.accountId}/summary`, { token: a.token })).status, 403);
});

test('xmpp: bad token is refused', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${t.server.xmppPort}`, 'xmpp');
  await new Promise((r) => ws.once('open', r));
  const got = new Promise((r) => ws.on('message', (d) => /failure/.test(d.toString()) && r(true)));
  ws.send('<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="prod.ol.epicgames.com" version="1.0"/>');
  ws.send(`<auth mechanism="PLAIN" xmlns="urn:ietf:params:xml:ns:xmpp-sasl">${Buffer.from('\0x\0nope').toString('base64')}</auth>`);
  assert.equal(await got, true);
  ws.close();
});

test('xmpp: friend notifications, presence and chat', async () => {
  const a = await t.user('XmA');
  const b = await t.user('XmB');
  const xa = await xmppLogin(a);
  const xb = await xmppLogin(b);

  await t.request('POST', `/friends/api/v1/${a.accountId}/friends/${b.accountId}`, { token: a.token });
  await xb.waitFor(/INBOUND/);
  await t.request('POST', `/friends/api/v1/${b.accountId}/friends/${a.accountId}`, { token: b.token });
  await xa.waitFor(/ACCEPTED/);

  xa.ws.send('<presence><status>{"Status":"Battle Royale Lobby"}</status><show>away</show></presence>');
  const presence = await xb.waitFor(/<presence[^>]*from="[^"]*XmA|Battle Royale Lobby/);
  assert.match(presence, /Battle Royale Lobby/);

  xb.ws.send(`<message to="${a.accountId}@prod.ol.epicgames.com" type="chat" id="m1"><body>hi &amp; hello</body></message>`);
  const msg = await xa.waitFor(/<message[^>]*type="chat"/);
  assert.match(msg, /hi &amp; hello/);

  // Party chat room.
  xa.ws.send('<presence to="Party-1@muc.prod.ol.epicgames.com/XmA:a:x"><x xmlns="http://jabber.org/protocol/muc"/></presence>');
  await xa.waitFor(/status code="110"/);
  xb.ws.send('<presence to="Party-1@muc.prod.ol.epicgames.com/XmB:b:x"><x xmlns="http://jabber.org/protocol/muc"/></presence>');
  await xa.waitFor(/Party-1@muc\.prod\.ol\.epicgames\.com\/XmB/);
  xb.ws.send('<message to="Party-1@muc.prod.ol.epicgames.com" type="groupchat"><body>gg</body></message>');
  assert.match(await xa.waitFor(/type="groupchat"/), /<body>gg<\/body>/);

  // Going offline is visible to friends.
  xb.ws.close();
  await xa.waitFor(/type="unavailable"[^>]*>|from="[^"]*" type="unavailable"/);
  xa.ws.close();
});

test('matchmaking: no server keeps the player queued, a server sends them to the match', async () => {
  const u = await t.user('MmA');
  const q = new URLSearchParams({ bucketId: '5046157:0:NAE:playlist_defaultsolo' });
  const ticket = await t.request('GET', `/fortnite/api/game/v2/matchmakingservice/ticket/player/${u.accountId}?${q}`, { token: u.token });
  assert.equal(ticket.status, 200);

  const connect = (signature = ticket.body.signature) =>
    new WebSocket(ticket.body.serviceUrl, { headers: { authorization: `Epic-Signed mms-player ${ticket.body.payload} ${signature}` } });

  // Tampered tickets are refused.
  const bad = connect('forged');
  await new Promise((r) => bad.on('close', r).on('error', r));

  t.config.matchmaking.gameServers.push({ ip: '10.0.0.5', port: 7777, regions: ['NAE'], playlists: ['playlist_defaultsolo'] });
  const ws = connect();
  const play = await new Promise((resolve, reject) => {
    const states = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      states.push(m.payload.state || m.name);
      if (m.name === 'Play') resolve({ states, sessionId: m.payload.sessionId });
    });
    setTimeout(() => reject(new Error('no Play message')), 4000);
  });
  ws.close();
  assert.deepEqual(play.states, ['Connecting', 'Waiting', 'Queued', 'SessionAssignment', 'Play']);

  const session = await t.request('GET', `/fortnite/api/matchmaking/session/${play.sessionId}`, { token: u.token });
  assert.equal(session.body.serverAddress, '10.0.0.5');
  assert.equal(session.body.serverPort, 7777);
  t.config.matchmaking.gameServers.length = 0;
});
