'use strict';

const { hexId } = require('../utils/ids');
const { normalizeTemplateId } = require('./cosmetics');

const DEFAULT_ITEMS = ['AthenaPickaxe:defaultpickaxe', 'AthenaGlider:defaultglider', 'AthenaDance:eid_dancemoves'];

const LOCKER_SLOTS = {
  Character: 1,
  Backpack: 1,
  Pickaxe: 1,
  Glider: 1,
  SkyDiveContrail: 1,
  MusicPack: 1,
  LoadingScreen: 1,
  Dance: 6,
  ItemWrap: 7,
};

function cosmeticItem(templateId, variants = []) {
  return {
    templateId,
    attributes: { max_level_bonus: 0, level: 1, item_seen: true, xp: 0, variants, favorite: false },
    quantity: 1,
  };
}

function emptyLocker() {
  const slots = {};
  for (const [slot, size] of Object.entries(LOCKER_SLOTS)) {
    slots[slot] = { items: new Array(size).fill(''), activeVariants: [] };
  }
  slots.Pickaxe.items[0] = 'AthenaPickaxe:defaultpickaxe';
  slots.Glider.items[0] = 'AthenaGlider:defaultglider';
  slots.Dance.items[0] = 'AthenaDance:eid_dancemoves';
  return {
    templateId: 'CosmeticLocker:cosmeticlocker_athena',
    attributes: {
      locker_slots_data: { slots },
      use_count: 0,
      banner_icon_template: 'StandardBanner1',
      banner_color_template: 'DefaultColor1',
      locker_name: '',
      item_seen: false,
      favorite: false,
    },
    quantity: 1,
  };
}

function baseProfile(accountId, profileId) {
  const now = new Date().toISOString();
  return {
    _id: hexId(),
    created: now,
    updated: now,
    rvn: 1,
    wipeNumber: 1,
    accountId,
    profileId,
    version: 'ogfn_1',
    items: {},
    stats: { attributes: {} },
    commandRevision: 0,
  };
}

const templates = {
  athena(accountId, { season }) {
    const profile = baseProfile(accountId, 'athena');
    profile.items.sandbox_loadout = emptyLocker();
    for (const id of DEFAULT_ITEMS) profile.items[id] = cosmeticItem(id);
    profile.stats.attributes = {
      season_match_boost: 0,
      loadouts: ['sandbox_loadout'],
      mfa_reward_claimed: true,
      rested_xp_overflow: 0,
      quest_manager: { dailyLoginInterval: '0001-01-01T00:00:00.000Z', dailyQuestRerolls: 1 },
      book_level: 1,
      season_num: season,
      book_xp: 0,
      permissions: [],
      season: { numWins: 0, numHighBracket: 0, numLowBracket: 0 },
      battlestars: 0,
      vote_data: {},
      book_purchased: false,
      lifetime_wins: 0,
      party_assist_quest: '',
      purchased_battle_pass_tier_offers: [],
      rested_xp_exchange: 0.333,
      level: 1,
      xp_overflow: 0,
      rested_xp: 0,
      rested_xp_mult: 0,
      accountLevel: 1,
      competitive_identity: {},
      inventory_limit_bonus: 0,
      last_applied_loadout: 'sandbox_loadout',
      daily_rewards: {},
      xp: 0,
      season_friend_match_boost: 0,
      active_loadout_index: 0,
      // Pre-Season 12 clients equip through these "favorite_" stats instead of the locker item.
      favorite_character: '',
      favorite_backpack: '',
      favorite_pickaxe: 'AthenaPickaxe:defaultpickaxe',
      favorite_glider: 'AthenaGlider:defaultglider',
      favorite_skydivecontrail: '',
      favorite_musicpack: '',
      favorite_loadingscreen: '',
      favorite_dance: ['AthenaDance:eid_dancemoves', '', '', '', '', ''],
      favorite_itemwraps: ['', '', '', '', '', '', ''],
      banner_icon: 'StandardBanner1',
      banner_color: 'DefaultColor1',
      past_seasons: [],
    };
    return profile;
  },

  common_core(accountId, { startingVbucks }) {
    const profile = baseProfile(accountId, 'common_core');
    profile.items['Currency:MtxPurchased'] = {
      templateId: 'Currency:MtxPurchased',
      attributes: { platform: 'EpicPC' },
      quantity: startingVbucks,
    };
    for (let i = 1; i <= 31; i++) {
      profile.items[`HomebaseBannerIcon:standardbanner${i}`] = {
        templateId: `HomebaseBannerIcon:StandardBanner${i}`,
        attributes: { item_seen: true },
        quantity: 1,
      };
    }
    for (let i = 1; i <= 21; i++) {
      profile.items[`HomebaseBannerColor:defaultcolor${i}`] = {
        templateId: `HomebaseBannerColor:DefaultColor${i}`,
        attributes: { item_seen: true },
        quantity: 1,
      };
    }
    profile.stats.attributes = {
      survey_data: {},
      personal_offers: {},
      intro_game_played: true,
      import_friends_claimed: {},
      mtx_purchase_history: { refundsUsed: 0, refundCredits: 3, purchases: [] },
      undo_cooldowns: [],
      mtx_affiliate_set_time: '',
      inventory_limit_bonus: 0,
      current_mtx_platform: 'EpicPC',
      mtx_affiliate: '',
      forced_intro_played: 'Coconut',
      weekly_purchases: {},
      daily_purchases: {},
      ban_history: {},
      in_app_purchases: {},
      permissions: [],
      undo_timeout: 'min',
      monthly_purchases: {},
      allowed_to_send_gifts: false,
      mfa_enabled: true,
      allowed_to_receive_gifts: false,
      gift_history: {},
    };
    return profile;
  },

  common_public(accountId) {
    const profile = baseProfile(accountId, 'common_public');
    profile.stats.attributes = { banner_color: 'DefaultColor1', homebase_name: '', banner_icon: 'StandardBanner1' };
    return profile;
  },
};

// Records every change made to a profile so the response can send only the
// differences (the way real MCP does) instead of the whole profile each time.
class ProfileEditor {
  constructor(profile) {
    this.profile = profile;
    this.baseRevision = profile.rvn;
    this.changes = [];
  }

  setStat(name, value) {
    this.profile.stats.attributes[name] = value;
    this.changes.push({ changeType: 'statModified', name, value });
  }

  addItem(itemId, item) {
    this.profile.items[itemId] = item;
    this.changes.push({ changeType: 'itemAdded', itemId, item });
  }

  removeItem(itemId) {
    delete this.profile.items[itemId];
    this.changes.push({ changeType: 'itemRemoved', itemId });
  }

  setItemAttribute(itemId, attributeName, attributeValue) {
    this.profile.items[itemId].attributes[attributeName] = attributeValue;
    this.changes.push({ changeType: 'itemAttrChanged', itemId, attributeName, attributeValue });
  }

  setItemQuantity(itemId, quantity) {
    this.profile.items[itemId].quantity = quantity;
    this.changes.push({ changeType: 'itemQuantityChanged', itemId, quantity });
  }

  get changed() {
    return this.changes.length > 0;
  }

  // Bumps revisions. Call once at the end of an operation.
  finish() {
    if (this.changed) {
      this.profile.rvn += 1;
      this.profile.commandRevision += 1;
      this.profile.updated = new Date().toISOString();
    }
  }

  // The block that goes into an MCP response for this profile.
  response(clientRevision) {
    const sendFull = clientRevision === undefined || Number(clientRevision) !== this.baseRevision;
    return {
      profileRevision: this.profile.rvn,
      profileId: this.profile.profileId,
      profileChangesBaseRevision: this.baseRevision,
      profileChanges: sendFull ? [{ changeType: 'fullProfileUpdate', profile: this.profile }] : this.changes,
      profileCommandRevision: this.profile.commandRevision,
    };
  }
}

class ProfileService {
  constructor(db, config, cosmetics) {
    this.db = db;
    this.config = config;
    this.cosmetics = cosmetics;
  }

  load(accountId, profileId) {
    const row = this.db.prepare('SELECT data FROM profiles WHERE account_id = ? AND profile_id = ?').get(accountId, profileId);
    return row ? JSON.parse(row.data) : null;
  }

  // Loads a profile, creating it on first use. Unknown profile ids (campaign,
  // collections, creative, ...) get an empty profile so the client is happy.
  get(accountId, profileId) {
    let profile = this.load(accountId, profileId);
    if (!profile) {
      const make = templates[profileId];
      profile = make
        ? make(accountId, { season: this.config.game.defaultSeason, startingVbucks: this.config.game.startingVbucks })
        : baseProfile(accountId, profileId);
      this.save(profile);
    }
    return profile;
  }

  save(profile) {
    this.db
      .prepare(
        `INSERT INTO profiles (account_id, profile_id, data) VALUES (?, ?, ?)
         ON CONFLICT(account_id, profile_id) DO UPDATE SET data = excluded.data`,
      )
      .run(profile.accountId, profile.profileId, JSON.stringify(profile));
  }

  createDefaults(accountId) {
    for (const id of Object.keys(templates)) this.get(accountId, id);
  }

  // Adds any cosmetics from the full list that the player doesn't own yet.
  grantAllCosmetics(editor) {
    for (const { templateId, variants } of this.cosmetics.items) {
      if (!editor.profile.items[templateId]) editor.addItem(templateId, cosmeticItem(templateId, variants));
    }
  }

  // Used by the admin tools. Returns the ids that were newly added.
  grantItems(accountId, templateIds) {
    const editor = new ProfileEditor(this.get(accountId, 'athena'));
    const added = [];
    for (const raw of templateIds) {
      const templateId = normalizeTemplateId(raw);
      if (editor.profile.items[templateId]) continue;
      editor.addItem(templateId, cosmeticItem(templateId));
      added.push(templateId);
    }
    editor.finish();
    this.save(editor.profile);
    return added;
  }

  setVbucks(accountId, amount) {
    const editor = new ProfileEditor(this.get(accountId, 'common_core'));
    editor.setItemQuantity('Currency:MtxPurchased', Math.max(0, Math.floor(amount)));
    editor.finish();
    this.save(editor.profile);
  }
}

module.exports = { ProfileService, ProfileEditor, cosmeticItem, LOCKER_SLOTS, templates };
