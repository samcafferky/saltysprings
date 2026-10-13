'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, xmppLogin } = require('./helpers');

let t;
before(async () => (t = await start()));
after(() => t.close());

const P = '/party/api/v1/Fortnite';
const joinInfo = (u) => ({ connection: { id: `${u.accountId}@prod.ol.epicgames.com/V2:Fortnite:WIN::x`, meta: {} }, meta: {} });

test('create, update and read a party', async () => {
  const a = await t.user('PartyA');
  const created = await t.request('POST', `${P}/parties`, { token: a.token, body: { config: { max_size: 4 }, join_info: joinInfo(a), meta: { 'Default:PartyState_s': 'BattleRoyaleView' } } });
  assert.equal(created.status, 200);
  const party = created.body;
  assert.equal(party.members[0].role, 'CAPTAIN');
  assert.equal(party.members[0].meta['urn:epic:member:dn_s'], 'PartyA');
  assert.equal(party.config.max_size, 4);

  const summary = await t.request('GET', `${P}/user/${a.accountId}`, { token: a.token });
  assert.equal(summary.body.current[0].id, party.id);

  await t.request('PATCH', `${P}/parties/${party.id}`, { token: a.token, body: { meta: { update: { 'Default:PlaylistData_j': '{}' }, delete: ['Default:PartyState_s'] }, revision: 0 } });
  await t.request('PATCH', `${P}/parties/${party.id}/members/${a.accountId}/meta`, { token: a.token, body: { update: { 'Default:Ready_s': 'Ready' }, delete: [] } });
  const read = await t.request('GET', `${P}/parties/${party.id}`, { token: a.token });
  assert.equal(read.body.revision, 1);
  assert.equal(read.body.meta['Default:PlaylistData_j'], '{}');
  assert.ok(!('Default:PartyState_s' in read.body.meta));
  assert.equal(read.body.members[0].meta['Default:Ready_s'], 'Ready');
});

test('invite, join with notifications, leader leaves and the next player leads', async () => {
  const a = await t.user('PartyB');
  const b = await t.user('PartyC');
  const xa = await xmppLogin(t, a);
  const xb = await xmppLogin(t, b);

  const party = (await t.request('POST', `${P}/parties`, { token: a.token, body: { config: { joinability: 'INVITE_AND_FORMER' }, join_info: joinInfo(a) } })).body;

  // Can't join a closed party without an invite.
  const blocked = await t.request('POST', `${P}/parties/${party.id}/members/${b.accountId}/join`, { token: b.token, body: joinInfo(b) });
  assert.equal(blocked.status, 403);

  // Invites only go to friends.
  assert.equal((await t.request('POST', `${P}/parties/${party.id}/invites/${b.accountId}`, { token: a.token, body: {} })).status, 403);
  await t.request('POST', `/friends/api/v1/${a.accountId}/friends/${b.accountId}`, { token: a.token });
  await t.request('POST', `/friends/api/v1/${b.accountId}/friends/${a.accountId}`, { token: b.token });
  assert.equal((await t.request('POST', `${P}/parties/${party.id}/invites/${b.accountId}`, { token: a.token, body: {} })).status, 204);
  await xb.waitFor(/INITIAL_INVITE/);
  const pings = await t.request('GET', `${P}/user/${b.accountId}`, { token: b.token });
  assert.equal(pings.body.pings[0].sent_by, a.accountId);

  const joined = await t.request('POST', `${P}/parties/${party.id}/members/${b.accountId}/join`, { token: b.token, body: joinInfo(b) });
  assert.equal(joined.body.status, 'JOINED');
  await xa.waitFor(/MEMBER_JOINED/);

  // B can't kick A, but A leaving makes B the leader.
  assert.equal((await t.request('DELETE', `${P}/parties/${party.id}/members/${a.accountId}`, { token: b.token })).status, 403);
  assert.equal((await t.request('DELETE', `${P}/parties/${party.id}/members/${a.accountId}`, { token: a.token })).status, 204);
  await xb.waitFor(/MEMBER_NEW_CAPTAIN/);
  const after = await t.request('GET', `${P}/parties/${party.id}`, { token: b.token });
  assert.deepEqual(after.body.members.map((m) => [m.account_id, m.role]), [[b.accountId, 'CAPTAIN']]);

  // Last player going offline removes the party.
  xb.ws.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await t.request('GET', `${P}/parties/${party.id}`, { token: b.token })).status, 404);
  xa.ws.close();
});

test('only the leader can change party settings, and players act only as themselves', async () => {
  const a = await t.user('PartyD');
  const b = await t.user('PartyE');
  const party = (await t.request('POST', `${P}/parties`, { token: a.token, body: { join_info: joinInfo(a) } })).body;
  await t.request('POST', `${P}/parties/${party.id}/members/${b.accountId}/join`, { token: b.token, body: joinInfo(b) });
  assert.equal((await t.request('PATCH', `${P}/parties/${party.id}`, { token: b.token, body: { meta: { update: { x: '1' } } } })).status, 403);
  assert.equal((await t.request('PATCH', `${P}/parties/${party.id}/members/${a.accountId}/meta`, { token: b.token, body: { update: {} } })).status, 403);
  assert.equal((await t.request('GET', `${P}/user/${a.accountId}`, { token: b.token })).status, 403);

  // Joining another party moves you out of the old one.
  const solo = (await t.request('POST', `${P}/parties`, { token: b.token, body: { join_info: joinInfo(b) } })).body;
  const old = await t.request('GET', `${P}/parties/${party.id}`, { token: a.token });
  assert.deepEqual(old.body.members.map((m) => m.account_id), [a.accountId]);
  assert.equal(solo.members[0].account_id, b.accountId);
});

test('season 11+ lobby endpoints answer', async () => {
  const u = await t.user('PartyF');
  assert.equal((await t.request('GET', '/fortnite/api/discovery/accessToken/++Fortnite+Release-14.60', { token: u.token })).status, 200);
  assert.ok((await t.request('POST', '/api/v1/discovery/surface/CreativeDiscoverySurface_Frontend', { body: {} })).body.Panels);
});
