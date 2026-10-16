import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export { BATTLE_PASS_OFFERS } from './battlepass.js';

function prettyName(templateId) {
  const raw = String(templateId).split(':').pop() ?? '';
  return raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function categoryOf(templateId) {
  const id = String(templateId);
  if (id.includes('AthenaCharacter')) return 'Outfit';
  if (id.includes('AthenaPickaxe')) return 'Pickaxe';
  if (id.includes('AthenaGlider')) return 'Glider';
  if (id.includes('AthenaDance')) return 'Emote';
  if (id.includes('Backpack')) return 'Backpack';
  if (id.includes('Wrap')) return 'ItemWrap';
  return 'Cosmetic';
}

// Aceita o formato simples { daily1: {...}, featured1: {...} } e converte pro formato interno
function normalizeShop(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw.storefronts)) return raw;
  const daily = [];
  const featured = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    const grantsRaw = Array.isArray(value.itemGrants) ? value.itemGrants : [value.itemGrants].filter(Boolean);
    const itemGrants = grantsRaw
      .map((g) => (typeof g === 'string' ? { templateId: g, quantity: 1 } : { templateId: String(g.templateId ?? ''), quantity: Number(g.quantity ?? 1) }))
      .filter((g) => g.templateId);
    if (itemGrants.length === 0) continue;
    const isDaily = key.toLowerCase().startsWith('daily');
    const first = itemGrants[0].templateId;
    const offer = {
      offerId: key,
      title: value.title ?? '',
      price: Number.isSafeInteger(value.price) ? value.price : 0,
      sectionId: isDaily ? 'Daily' : 'Featured',
      tileSize: value.tileSize ?? (isDaily ? 'Small' : 'Normal'),
      category: value.category ?? categoryOf(first),
      itemGrants
    };
    (isDaily ? daily : featured).push(offer);
  }
  return {
    title: 'OGFN Item Shop',
    refreshIntervalHrs: 24,
    dailyPurchaseHrs: 24,
    expiration: '2099-01-01T00:00:00.000Z',
    storefronts: [
      { name: 'BRWeeklyStorefront', catalogEntries: featured },
      { name: 'BRDailyStorefront', catalogEntries: daily }
    ]
  };
}

function validateShop(config) {
  if (!config || !Array.isArray(config.storefronts)) throw new Error('Shop config must contain a storefronts array.');
  const ids = new Set();
  for (const storefront of config.storefronts) {
    if (!Array.isArray(storefront.catalogEntries)) throw new Error(`Shop storefront '${storefront.name}' must contain catalogEntries.`);
    for (const offer of storefront.catalogEntries) {
      if (!offer.offerId || !Number.isSafeInteger(offer.price) || offer.price < 0 || !Array.isArray(offer.itemGrants)) {
        throw new Error(`Invalid shop offer in storefront '${storefront.name}'.`);
      }
      if (ids.has(offer.offerId)) throw new Error(`Duplicate shop offer id '${offer.offerId}'.`);
      ids.add(offer.offerId);
      for (const grant of offer.itemGrants) {
        if (typeof grant.templateId !== 'string' || !grant.templateId.includes(':') || !Number.isSafeInteger(grant.quantity) || grant.quantity < 1) {
          throw new Error(`Invalid item grant in offer '${offer.offerId}'.`);
        }
      }
    }
  }
  return config;
}

function fortniteOffer(offer, expiration) {
  const templateId = offer.itemGrants[0]?.templateId ?? '';
  const meta = {
    SectionId: offer.sectionId ?? 'Featured',
    LayoutId: 'GhostBackend.99',
    TileSize: offer.tileSize ?? 'Normal',
    templateId,
    inDate: '2018-04-30T00:00:00.000Z',
    outDate: '9999-12-31T23:59:59.999Z'
  };
  return {
    offerId: offer.offerId,
    devName: offer.title,
    fulfillmentIds: [],
    dailyLimit: -1,
    weeklyLimit: -1,
    monthlyLimit: -1,
    categories: [],
    prices: [{ currencyType: 'MtxCurrency', currencySubType: '', regularPrice: offer.price, finalPrice: offer.price, saleExpiration: expiration, basePrice: offer.price }],
    meta,
    matchFilter: '',
    filterWeight: 0,
    appStoreId: [],
    requirements: offer.itemGrants.map((grant) => ({ requirementType: 'DenyOnItemOwnership', requiredId: grant.templateId, minQuantity: 1 })),
    offerType: 'StaticPrice',
    giftInfo: { bIsEnabled: true, forcedGiftBoxTemplateId: '', purchaseRequirements: [], giftRecordIds: [] },
    refundable: true,
    metaInfo: Object.entries(meta).map(([key, value]) => ({ key, value: String(value) })),
    displayAssetPath: '',
    itemGrants: offer.itemGrants.map((grant) => ({ templateId: grant.templateId, quantity: grant.quantity })),
    sortPriority: 0,
    catalogGroupPriority: 0,
    title: offer.title ?? '',
    shortDescription: offer.description ?? '',
    description: offer.description ?? ''
  };
}

export class ShopService {
  constructor({ file, store }) {
    this.file = file;
    this.store = store;
    this.config = null;
  }

  async init() {
    this.config = validateShop(normalizeShop(JSON.parse(await fs.readFile(this.file, 'utf8'))));
    return this;
  }

  async reload() {
    this.config = validateShop(normalizeShop(JSON.parse(await fs.readFile(this.file, 'utf8'))));
    return this.config;
  }

  getOffers() {
    return this.config.storefronts.flatMap((storefront) => storefront.catalogEntries.map((offer) => ({ ...structuredClone(offer), storefront: storefront.name })));
  }

  getOffer(offerId) {
    return this.getOffers().find((offer) => offer.offerId === offerId) ?? null;
  }

  getBalance(accountId) {
    return this.store.snapshot().profiles[accountId]?.common_core?.items?.['Currency:MtxPurchased']?.quantity ?? 0;
  }

  storefrontResponse() {
    const expiration = this.config.expiration ?? new Date(Date.now() + 86400000).toISOString();
    return {
      refreshIntervalHrs: this.config.refreshIntervalHrs ?? 24,
      dailyPurchaseHrs: this.config.dailyPurchaseHrs ?? 24,
      expiration,
      storefronts: this.config.storefronts.map((storefront) => ({
        name: storefront.name,
        catalogEntries: storefront.catalogEntries.map((offer) => fortniteOffer(offer, expiration))
      })),
      storefront: [],
      rmtPromotionConfig: [],
      giftInfo: { bIsEnabled: true, forcedGiftBoxTemplateId: '', purchaseRequirements: [], giftRecordIds: [] }
    };
  }

  async buy(accountId, offerId) {
    let result;
    await this.store.update((state) => {
      const offer = this.config.storefronts.flatMap((storefront) => storefront.catalogEntries).find((entry) => entry.offerId === offerId);
      if (!offer) {
        const error = new Error(`Offer '${offerId}' does not exist.`);
        error.status = 404;
        error.code = 'offer_not_found';
        throw error;
      }
      const profiles = state.profiles[accountId];
      if (!profiles?.athena || !profiles?.common_core) {
        const error = new Error('Player profile not found.');
        error.status = 404;
        error.code = 'profile_not_found';
        throw error;
      }
      const existingGrant = offer.itemGrants.find((grant) => profiles.athena.items[grant.templateId]);
      if (existingGrant) {
        const error = new Error(`Item '${existingGrant.templateId}' is already owned.`);
        error.status = 409;
        error.code = 'item_already_owned';
        throw error;
      }
      const currency = profiles.common_core.items['Currency:MtxPurchased'];
      const balance = currency?.quantity ?? 0;
      if (balance < offer.price) {
        const error = new Error('Not enough V-Bucks for this offer.');
        error.status = 402;
        error.code = 'insufficient_funds';
        error.balance = balance;
        error.price = offer.price;
        throw error;
      }
      if (currency) currency.quantity -= offer.price;
      else if (offer.price > 0) {
        const error = new Error('The account has no V-Bucks balance.');
        error.status = 402;
        error.code = 'insufficient_funds';
        throw error;
      }
      const now = new Date().toISOString();
      for (const grant of offer.itemGrants) {
        profiles.athena.items[grant.templateId] = {
          templateId: grant.templateId,
          attributes: { max_level_bonus: 0, level: 1, item_seen: false, xp: 0, variants: [], favorite: false },
          quantity: grant.quantity
        };
      }
      profiles.athena.rvn += 1;
      profiles.athena.commandRevision += 1;
      profiles.athena.updated = now;
      profiles.common_core.rvn += 1;
      profiles.common_core.commandRevision += 1;
      profiles.common_core.updated = now;
      const account = state.accounts.find((entry) => entry.id === accountId);
      if (!account) {
        const error = new Error('Account not found.');
        error.status = 404;
        error.code = 'account_not_found';
        throw error;
      }
      const purchase = {
        purchaseId: randomUUID(),
        accountId,
        offerId,
        price: offer.price,
        itemGrants: structuredClone(offer.itemGrants),
        createdAt: now,
        balance: currency?.quantity ?? 0
      };
      state.purchases ??= [];
      state.purchases.push(purchase);
      result = purchase;
      return true;
    });
    return result;
  }
}
