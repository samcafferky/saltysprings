'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { EpicError, errors } = require('../utils/errors');
const { getVersionInfo } = require('../utils/version');
const { ProfileEditor, cosmeticItem, LOCKER_SLOTS } = require('../services/profiles');
const { hexId } = require('../utils/ids');

// Pre-Season 12 lockers store equipped items in these athena stats.
const FAVORITE_STATS = {
  Character: 'favorite_character',
  Backpack: 'favorite_backpack',
  Pickaxe: 'favorite_pickaxe',
  Glider: 'favorite_glider',
  SkyDiveContrail: 'favorite_skydivecontrail',
  MusicPack: 'favorite_musicpack',
  LoadingScreen: 'favorite_loadingscreen',
  Dance: 'favorite_dance',
  ItemWrap: 'favorite_itemwraps',
};

const KNOWN_PROFILES = new Set([
  'athena', 'common_core', 'common_public', 'profile0', 'campaign', 'metadata',
  'outpost0', 'collections', 'creative', 'recycle_bin',
]);
const isKnownProfile = (id) => KNOWN_PROFILES.has(id) || /^(theater\d|collection_book_[a-z]+\d)$/.test(id);

const READ_ONLY_OPS = new Set(['QueryProfile', 'QueryPublicProfile']);

// Ops the client calls that need no server-side change. They just return the profile.
const NO_OP = new Set([
  'QueryProfile',
  'QueryPublicProfile',
  'ClientQuestLogin',
  'RefreshExpeditions',
  'SetMtxPlatform',
  'SetHardcoreModifier',
  'IncrementNamedCounterStat',
  'GetMcpTimeForLogin',
  'SetReceiveGiftsEnabled',
  'CheckGiftLimits',
  'ClaimMfaEnabled',
  'SetAffiliateName',
  'VerifyRealMoneyPurchase',
  'MarkNewQuestNotificationSent',
  'SetSeasonPassAutoClaim',
  'PutModularCosmeticLoadout',
  'SetActiveArchetype',
]);

function requireOwned(profile, templateId) {
  if (templateId && !profile.items[templateId]) {
    // Item keys are lowercase in our profiles; the client may send any casing.
    const key = Object.keys(profile.items).find((k) => k.toLowerCase() === templateId.toLowerCase());
    if (!key) throw errors.itemNotFound(templateId);
    return key;
  }
  return templateId || '';
}

// Applies style changes (e.g. a skin's alternate colors) to the owned item.
function applyVariants(editor, itemId, variantUpdates) {
  if (!itemId || !Array.isArray(variantUpdates) || !variantUpdates.length) return [];
  const item = editor.profile.items[itemId];
  const variants = Array.isArray(item.attributes.variants) ? structuredClone(item.attributes.variants) : [];
  for (const update of variantUpdates) {
    if (!update || !update.channel) continue;
    const existing = variants.find((v) => v.channel === update.channel);
    if (existing) {
      if (existing.owned && existing.owned.length && !existing.owned.includes(update.active)) continue;
      existing.active = update.active;
    } else {
      variants.push({ channel: update.channel, active: update.active, owned: update.owned || [] });
    }
  }
  editor.setItemAttribute(itemId, 'variants', variants);
  return variants.map(({ channel, active }) => ({ channel, active }));
}

const operations = {
  // Season 12+ locker.
  SetCosmeticLockerSlot(ctx) {
    const { lockerItem, category, slotIndex = 0, variantUpdates } = ctx.body;
    const editor = ctx.editor('athena');
    const locker = editor.profile.items[lockerItem];
    if (!locker || !LOCKER_SLOTS[category]) throw errors.badRequest('Invalid locker item or category');
    const itemId = requireOwned(editor.profile, ctx.body.itemToSlot);

    const slots = structuredClone(locker.attributes.locker_slots_data.slots);
    const slot = slots[category] || (slots[category] = { items: new Array(LOCKER_SLOTS[category]).fill(''), activeVariants: [] });
    const active = applyVariants(editor, itemId, variantUpdates);

    const indexes = slotIndex === -1 ? slot.items.map((_, i) => i) : [Number(slotIndex)];
    for (const i of indexes) {
      if (i < 0 || i >= LOCKER_SLOTS[category]) throw errors.badRequest('Invalid slot index');
      slot.items[i] = itemId;
      if (!Array.isArray(slot.activeVariants)) slot.activeVariants = [];
      slot.activeVariants[i] = active.length ? { variants: active } : null;
    }
    editor.setItemAttribute(lockerItem, 'locker_slots_data', { slots });
  },

  SetCosmeticLockerBanner(ctx) {
    const { lockerItem, bannerIconTemplateName, bannerColorTemplateName } = ctx.body;
    const editor = ctx.editor('athena');
    if (!editor.profile.items[lockerItem]) throw errors.badRequest('Invalid locker item');
    editor.setItemAttribute(lockerItem, 'banner_icon_template', bannerIconTemplateName || '');
    editor.setItemAttribute(lockerItem, 'banner_color_template', bannerColorTemplateName || '');
  },

  // Pre-Season 12 locker.
  EquipBattleRoyaleCustomization(ctx) {
    const { slotName, indexWithinSlot = 0, variantUpdates } = ctx.body;
    const stat = FAVORITE_STATS[slotName];
    if (!stat) throw errors.badRequest(`Invalid slot ${slotName}`);
    const editor = ctx.editor('athena');
    const itemId = requireOwned(editor.profile, ctx.body.itemToSlot);
    applyVariants(editor, itemId, variantUpdates);

    const current = editor.profile.stats.attributes[stat];
    if (Array.isArray(current)) {
      const next = [...current];
      const index = Number(indexWithinSlot);
      if (index === -1) next.fill(itemId);
      else if (index >= 0 && index < next.length) next[index] = itemId;
      else throw errors.badRequest('Invalid slot index');
      editor.setStat(stat, next);
    } else {
      editor.setStat(stat, itemId);
    }
  },

  SetBattleRoyaleBanner(ctx) {
    const editor = ctx.editor('athena');
    editor.setStat('banner_icon', ctx.body.homebaseBannerIconId || '');
    editor.setStat('banner_color', ctx.body.homebaseBannerColorId || '');
  },

  SetHomebaseBanner(ctx) {
    const editor = ctx.editor('common_public');
    editor.setStat('banner_icon', ctx.body.homebaseBannerIconId || '');
    editor.setStat('banner_color', ctx.body.homebaseBannerColorId || '');
  },

  MarkItemSeen(ctx) {
    const editor = ctx.editor(ctx.profileId);
    for (const id of ctx.body.itemIds || []) {
      if (editor.profile.items[id]) editor.setItemAttribute(id, 'item_seen', true);
    }
  },

  SetItemFavoriteStatus(ctx) {
    const editor = ctx.editor(ctx.profileId);
    const id = ctx.body.targetItemId;
    if (!editor.profile.items[id]) throw errors.itemNotFound(id);
    editor.setItemAttribute(id, 'favorite', Boolean(ctx.body.bFavorite));
  },

  SetItemFavoriteStatusBatch(ctx) {
    const editor = ctx.editor(ctx.profileId);
    const ids = ctx.body.itemIds || [];
    const values = ctx.body.itemFavStatus || [];
    ids.forEach((id, i) => {
      if (editor.profile.items[id]) editor.setItemAttribute(id, 'favorite', Boolean(values[i]));
    });
  },

  PurchaseCatalogEntry(ctx) {
    const { offerId, purchaseQuantity = 1, expectedTotalPrice } = ctx.body;
    const offer = ctx.services.catalog.findOffer(offerId);
    if (!offer) {
      throw new EpicError('errors.com.epicgames.fortnite.id_invalid', `Offer ID (id: '${offerId}') not found`, 16027, 400, [offerId]);
    }
    if (Number(purchaseQuantity) !== 1) throw errors.badRequest('Only one of each item can be bought');
    if (expectedTotalPrice !== undefined && Number(expectedTotalPrice) !== offer.price) {
      throw new EpicError('errors.com.epicgames.modules.catalog.price_mismatch', 'The price of this item changed. Please refresh the shop.', 28000, 400);
    }

    const core = ctx.editor('common_core');
    const athena = ctx.editor('athena');
    if (offer.templateIds.every((id) => athena.profile.items[id])) {
      throw new EpicError('errors.com.epicgames.offer.already_owned', 'You already own this item.', 28004, 400);
    }

    const vbucks = core.profile.items['Currency:MtxPurchased'];
    if (!vbucks || vbucks.quantity < offer.price) {
      throw new EpicError(
        'errors.com.epicgames.currency.mtx.insufficient',
        `You can not afford this item (${offer.price}), you only have ${vbucks ? vbucks.quantity : 0}.`,
        1040,
        400,
        [String(offer.price), String(vbucks ? vbucks.quantity : 0)],
      );
    }
    if (offer.price > 0) core.setItemQuantity('Currency:MtxPurchased', vbucks.quantity - offer.price);

    const lootItems = [];
    for (const templateId of offer.templateIds) {
      if (athena.profile.items[templateId]) continue;
      athena.addItem(templateId, cosmeticItem(templateId));
      lootItems.push({ itemType: templateId, itemGuid: templateId, itemProfile: 'athena', quantity: 1 });
    }

    const history = structuredClone(core.profile.stats.attributes.mtx_purchase_history || { purchases: [] });
    history.purchases = history.purchases || [];
    history.purchases.push({
      purchaseId: hexId(),
      offerId,
      purchaseDate: new Date().toISOString(),
      freeRefundEligible: false,
      fulfillments: [],
      lootResult: lootItems,
      totalMtxPaid: offer.price,
      metadata: {},
      gameContext: '',
    });
    core.setStat('mtx_purchase_history', history);

    ctx.notifications.push({ type: 'CatalogPurchase', primary: true, lootResult: { items: lootItems } });
  },
};

module.exports = function mcpRoutes(services, config) {
  const router = express.Router();

  function run(req, res, next, { readOnly, profileId = String(req.query.profileId || 'athena') }) {
    const { accountId, operation } = req.params;
    if (!isKnownProfile(profileId)) return next(errors.badRequest(`Unknown profile ${profileId}`));
    const handler = operations[operation];

    if (readOnly && !READ_ONLY_OPS.has(operation)) return next(errors.forbidden('This route only allows reading profiles'));
    if (!handler && !NO_OP.has(operation)) {
      services.logger.warn(`[mcp] unknown operation ${operation} (profile ${profileId})`);
    }
    if (!services.accounts.findById(accountId)) return next(errors.notFound());

    const editors = new Map();
    const ctx = {
      services,
      account: req.account,
      body: req.body || {},
      profileId,
      notifications: [],
      editor(id) {
        if (!editors.has(id)) editors.set(id, new ProfileEditor(services.profiles.get(accountId, id)));
        return editors.get(id);
      },
    };

    const main = ctx.editor(profileId);
    if (profileId === 'athena') {
      const season = getVersionInfo(req.headers['user-agent'], config.game.defaultSeason).season;
      if (!readOnly) {
        if (main.profile.stats.attributes.season_num !== season) main.setStat('season_num', season);
        if (config.game.giveAllCosmetics) services.profiles.grantAllCosmetics(main);
      }
    }

    if (handler) handler(ctx);

    // Nothing is written until the whole operation succeeded.
    for (const editor of editors.values()) {
      editor.finish();
      if (editor.changed) services.profiles.save(editor.profile);
    }

    const response = {
      ...main.response(req.query.rvn),
      serverTime: new Date().toISOString(),
      responseVersion: 1,
    };
    const others = [...editors.values()].filter((e) => e !== main && e.changed);
    if (others.length) response.multiUpdate = others.map((e) => e.response(e.baseRevision));
    if (ctx.notifications.length) response.notifications = ctx.notifications;
    res.json(response);
  }

  const ownProfile = [requireAuth(services), (req, res, next) => {
    if (req.account.id !== req.params.accountId) return next(errors.forbidden(`You can't modify account ${req.params.accountId}'s profile`));
    next();
  }];

  router.post('/fortnite/api/game/v2/profile/:accountId/client/:operation', ...ownProfile, (req, res, next) =>
    run(req, res, next, { readOnly: false }),
  );

  // Game servers and other players can read profiles but never change them.
  const readAuth = requireAuth(services, { allowClient: true });
  router.post('/fortnite/api/game/v2/profile/:accountId/dedicated_server/:operation', readAuth, (req, res, next) =>
    run(req, res, next, { readOnly: true }),
  );
  router.post('/fortnite/api/game/v2/profile/:accountId/public/:operation', readAuth, (req, res, next) => {
    const profileId = String(req.query.profileId || 'common_public');
    if (!['common_public', 'campaign'].includes(profileId)) return next(errors.forbidden('That profile is private'));
    run(req, res, next, { readOnly: true, profileId });
  });

  return router;
};

module.exports.operations = operations;
