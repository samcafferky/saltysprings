'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('../utils/ids');
const { normalizeTemplateId } = require('./cosmetics');

function nextUtcMidnight() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

// Turns shop.json into the storefront format the client expects.
class CatalogService {
  constructor(config) {
    this.file = path.join(config.root, 'shop.json');
    this.offers = new Map();
    this.reload();
  }

  reload() {
    const shop = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { featured: [], daily: [] };
    this.offers.clear();
    this.storefronts = [
      this.buildStorefront('BRWeeklyStorefront', 'Featured', shop.featured || []),
      this.buildStorefront('BRDailyStorefront', 'Daily', shop.daily || []),
    ];
  }

  buildStorefront(name, section, entries) {
    const catalogEntries = entries.map((entry, index) => {
      const templateIds = entry.items.map(normalizeTemplateId);
      const offerId = `v2:/${sha256(`${name}:${templateIds.join(',')}`)}`;
      const price = Math.max(0, Math.floor(entry.price || 0));
      const offer = {
        devName: `[VIRTUAL]1 x ${templateIds.join(', ')} for ${price} MtxCurrency`,
        offerId,
        fulfillmentIds: [],
        dailyLimit: -1,
        weeklyLimit: -1,
        monthlyLimit: -1,
        categories: [],
        prices: [
          {
            currencyType: 'MtxCurrency',
            currencySubType: '',
            regularPrice: price,
            dynamicRegularPrice: -1,
            finalPrice: price,
            saleExpiration: '9999-12-31T23:59:59.999Z',
            basePrice: price,
          },
        ],
        meta: { SectionId: section, TileSize: section === 'Featured' ? 'Normal' : 'Small' },
        matchFilter: '',
        filterWeight: 0,
        appStoreId: [],
        requirements: templateIds.map((id) => ({ requirementType: 'DenyOnItemOwnership', requiredId: id, minQuantity: 1 })),
        offerType: 'StaticPrice',
        giftInfo: { bIsEnabled: false, forcedGiftBoxTemplateId: '', purchaseRequirements: [], giftRecordIds: [] },
        refundable: false,
        metaInfo: [
          { key: 'SectionId', value: section },
          { key: 'TileSize', value: section === 'Featured' ? 'Normal' : 'Small' },
        ],
        displayAssetPath: '',
        itemGrants: templateIds.map((templateId) => ({ templateId, quantity: 1 })),
        sortPriority: entries.length - index,
        catalogGroupPriority: 0,
      };
      this.offers.set(offerId, { price, templateIds });
      return offer;
    });
    return { name, catalogEntries };
  }

  catalog() {
    return {
      refreshIntervalHrs: 24,
      dailyPurchaseHrs: 24,
      expiration: nextUtcMidnight(),
      storefronts: this.storefronts,
    };
  }

  findOffer(offerId) {
    return this.offers.get(offerId) || null;
  }
}

module.exports = { CatalogService, nextUtcMidnight };
