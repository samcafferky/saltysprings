'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Builds the "every cosmetic" list used when game.giveAllCosmetics is on.
// The list is fetched once from a public cosmetics API and cached on disk.
class CosmeticsService {
  constructor(config, logger = console) {
    this.source = config.game.cosmeticsSource;
    this.cacheFile = path.join(config.dataDir, 'cosmetics.json');
    this.logger = logger;
    this.items = [];
  }

  loadCache() {
    try {
      this.items = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      return true;
    } catch {
      return false;
    }
  }

  async refresh() {
    const res = await fetch(this.source);
    if (!res.ok) throw new Error(`cosmetics source returned HTTP ${res.status}`);
    this.items = parseCosmetics(await res.json());
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    fs.writeFileSync(this.cacheFile, JSON.stringify(this.items));
    return this.items.length;
  }

  async init() {
    if (this.loadCache() && this.items.length) {
      this.logger.log(`[cosmetics] loaded ${this.items.length} cosmetics from cache`);
      return;
    }
    try {
      const count = await this.refresh();
      this.logger.log(`[cosmetics] downloaded ${count} cosmetics`);
    } catch (err) {
      this.logger.warn(`[cosmetics] could not download cosmetics list: ${err.message}`);
    }
  }
}

// Accepts the fortnite-api.com format ({ data: [...] } or { data: { br: [...] } })
// or a plain array of template ids like "AthenaCharacter:CID_028_Athena_Commando_F".
function parseCosmetics(json) {
  let list = json && json.data !== undefined ? json.data : json;
  if (list && !Array.isArray(list) && Array.isArray(list.br)) list = list.br;
  if (!Array.isArray(list)) return [];

  const out = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      if (entry.includes(':')) out.push({ templateId: normalizeTemplateId(entry), variants: [] });
      continue;
    }
    const backend = entry && entry.type && entry.type.backendValue;
    if (!backend || !entry.id) continue;
    const variants = (entry.variants || [])
      .filter((v) => v.channel && Array.isArray(v.options) && v.options.length)
      .map((v) => ({
        channel: v.channel,
        active: v.options[0].tag,
        owned: v.options.map((o) => o.tag),
      }));
    out.push({ templateId: normalizeTemplateId(`${backend}:${entry.id}`), variants });
  }
  return out;
}

function normalizeTemplateId(templateId) {
  const [type, id] = String(templateId).split(':');
  return `${type}:${(id || '').toLowerCase()}`;
}

module.exports = { CosmeticsService, parseCosmetics, normalizeTemplateId };
