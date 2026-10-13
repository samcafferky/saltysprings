'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, CLIENT } = require('./helpers');

let t;
before(async () => (t = await start()));
after(() => t.close());

const mcp = (u, op, profileId, body = {}, rvn = -1) =>
  t.request('POST', `/fortnite/api/game/v2/profile/${u.accountId}/client/${op}?profileId=${profileId}&rvn=${rvn}`, { token: u.token, body });

test('QueryProfile returns full athena profile with defaults and season from user agent', async () => {
  const u = await t.user('Prof1');
  const res = await mcp(u, 'QueryProfile', 'athena');
  assert.equal(res.status, 200);
  const change = res.body.profileChanges[0];
  assert.equal(change.changeType, 'fullProfileUpdate');
  assert.ok(change.profile.items['AthenaPickaxe:defaultpickaxe']);
  assert.equal(change.profile.stats.attributes.season_num, 7);
});

test('unknown profiles are created empty, bogus ids rejected', async () => {
  const u = await t.user('Prof2');
  const res = await mcp(u, 'QueryProfile', 'campaign');
  assert.equal(res.status, 200);
  assert.equal(res.body.profileId, 'campaign');
  assert.equal((await mcp(u, 'QueryProfile', 'definitely_not_real')).status, 400);
});

test('locker equip (season 12+ style) and incremental updates', async () => {
  const u = await t.user('Prof3');
  const first = await mcp(u, 'QueryProfile', 'athena');
  const rvn = first.body.profileRevision;

  const res = await mcp(u, 'SetCosmeticLockerSlot', 'athena', {
    lockerItem: 'sandbox_loadout',
    category: 'Dance',
    itemToSlot: 'AthenaDance:EID_DanceMoves',
    slotIndex: 3,
  }, rvn);
  assert.equal(res.status, 200);
  assert.equal(res.body.profileRevision, rvn + 1);
  // Client was up to date, so it only gets the change.
  assert.equal(res.body.profileChanges[0].changeType, 'itemAttrChanged');
  assert.equal(res.body.profileChanges[0].attributeValue.slots.Dance.items[3], 'AthenaDance:eid_dancemoves');

  const notOwned = await mcp(u, 'SetCosmeticLockerSlot', 'athena', {
    lockerItem: 'sandbox_loadout',
    category: 'Character',
    itemToSlot: 'AthenaCharacter:CID_028_Athena_Commando_F',
    slotIndex: 0,
  });
  assert.equal(notOwned.status, 404);
  assert.equal(notOwned.body.errorCode, 'errors.com.epicgames.fortnite.item_not_found');
});

test('old-style EquipBattleRoyaleCustomization updates favorite stats', async () => {
  const u = await t.user('Prof4');
  const res = await mcp(u, 'EquipBattleRoyaleCustomization', 'athena', { slotName: 'Dance', itemToSlot: 'AthenaDance:eid_dancemoves', indexWithinSlot: -1 });
  assert.equal(res.status, 200);
  const profile = res.body.profileChanges[0].profile;
  assert.deepEqual(profile.stats.attributes.favorite_dance, new Array(6).fill('AthenaDance:eid_dancemoves'));
});

test('buying from the shop takes V-Bucks and gives the item', async () => {
  const u = await t.user('Prof5');
  const catalog = await t.request('GET', '/fortnite/api/storefront/v2/catalog', { token: u.token });
  const offer = catalog.body.storefronts.flatMap((s) => s.catalogEntries).find((e) => e.prices[0].finalPrice === 500);
  assert.ok(offer, 'expected a 500 V-Buck offer in shop.json');

  const buy = await mcp(u, 'PurchaseCatalogEntry', 'common_core', { offerId: offer.offerId, purchaseQuantity: 1, currency: 'MtxCurrency', expectedTotalPrice: 500 });
  assert.equal(buy.status, 200);
  const core = buy.body.profileChanges[0].profile;
  assert.equal(core.items['Currency:MtxPurchased'].quantity, 500);
  assert.equal(buy.body.multiUpdate[0].profileId, 'athena');
  assert.equal(buy.body.notifications[0].lootResult.items[0].itemType, offer.itemGrants[0].templateId);

  const again = await mcp(u, 'PurchaseCatalogEntry', 'common_core', { offerId: offer.offerId, purchaseQuantity: 1, expectedTotalPrice: 500 });
  assert.equal(again.body.errorCode, 'errors.com.epicgames.offer.already_owned');

  const pricey = catalog.body.storefronts.flatMap((s) => s.catalogEntries).find((e) => e.prices[0].finalPrice > 500);
  const broke = await mcp(u, 'PurchaseCatalogEntry', 'common_core', { offerId: pricey.offerId, purchaseQuantity: 1 });
  assert.equal(broke.body.errorCode, 'errors.com.epicgames.currency.mtx.insufficient');

  // Failed purchase must not have changed anything.
  const check = await mcp(u, 'QueryProfile', 'common_core');
  assert.equal(check.body.profileChanges[0].profile.items['Currency:MtxPurchased'].quantity, 500);
});

test('players cannot touch each other\'s profiles', async () => {
  const a = await t.user('Prof6');
  const b = await t.user('Prof7');
  const res = await t.request('POST', `/fortnite/api/game/v2/profile/${b.accountId}/client/QueryProfile?profileId=athena&rvn=-1`, { token: a.token, body: {} });
  assert.equal(res.status, 403);
});

test('game servers can read profiles with client credentials but not write', async () => {
  const u = await t.user('Prof8');
  const cc = await t.request('POST', '/account/api/oauth/token', { headers: { authorization: CLIENT }, form: { grant_type: 'client_credentials' } });
  const token = cc.body.access_token.replace('eg1~', '');
  const read = await t.request('POST', `/fortnite/api/game/v2/profile/${u.accountId}/dedicated_server/QueryProfile?profileId=athena&rvn=-1`, { token, body: {} });
  assert.equal(read.status, 200);
  const write = await t.request('POST', `/fortnite/api/game/v2/profile/${u.accountId}/dedicated_server/SetBattleRoyaleBanner?profileId=athena&rvn=-1`, { token, body: {} });
  assert.equal(write.status, 403);
});

test('admin can grant items and set V-Bucks', async () => {
  const u = await t.user('Prof9');
  const admin = { authorization: 'Bearer test-admin-key' };
  const grant = await t.request('POST', '/admin/api/accounts/Prof9/items', { headers: admin, body: { items: ['AthenaCharacter:CID_028_Athena_Commando_F'] } });
  assert.deepEqual(grant.body.added, ['AthenaCharacter:cid_028_athena_commando_f']);
  await t.request('POST', '/admin/api/accounts/Prof9/vbucks', { headers: admin, body: { amount: 13500 } });

  const equip = await mcp(u, 'SetCosmeticLockerSlot', 'athena', {
    lockerItem: 'sandbox_loadout',
    category: 'Character',
    itemToSlot: 'AthenaCharacter:CID_028_Athena_Commando_F',
    slotIndex: 0,
    variantUpdates: [],
  });
  assert.equal(equip.status, 200);
  const core = await mcp(u, 'QueryProfile', 'common_core');
  assert.equal(core.body.profileChanges[0].profile.items['Currency:MtxPurchased'].quantity, 13500);
});
