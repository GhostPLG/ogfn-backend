import fsSync from 'fs';
import { randomUUID } from 'node:crypto';

// IDs que o cliente 4.5 envia ao comprar passe/tiers (Season 4)
export const BATTLE_PASS_OFFERS = {
  '76EA7FE9787744B09B79FF3FC5E39D0C': { key: 'battlePass', defaultPrice: 950,  tiers: 0,  devName: 'Season 4 Battle Pass' },
  '884CE68998C44AC58D85C5A9883DE1A6': { key: 'bundle25',   defaultPrice: 2800, tiers: 25, devName: 'Season 4 Bundle +25 Tiers' },
  'E9527AF46F4B4A9CAE98D91F2AA53CB6': { key: 'singleTier', defaultPrice: 150,  tiers: 1,  devName: 'Single Tier' }
};

const TOKEN = 'AthenaSeason:athenaseason4';

export class BattlePassService {
  constructor() {
    this.season4 = { paidRewards: [], freeRewards: [] };
  }

  init() {
    try {
      this.season4 = JSON.parse(fsSync.readFileSync(new URL('./battlepass-season4.json', import.meta.url), 'utf8'));
      console.log('[battlepass] Season4 carregado | tiers pagos:', this.season4.paidRewards?.length ?? 0);
    } catch (err) {
      console.error('[battlepass] falha ao carregar JSON:', err.message);
    }
  }

  isBattlePassOffer(offerId) {
    return Boolean(BATTLE_PASS_OFFERS[offerId]);
  }

  // Concede recompensas pagas até o tier indicado, sem duplicar
  grantUpTo(athena, upToTier, granted = []) {
    athena.items ??= {};
    const list = this.season4.paidRewards ?? [];
    for (let i = 0; i < Math.min(upToTier, list.length); i++) {
      for (const [templateId, quantity] of Object.entries(list[i] ?? {})) {
        if (templateId.startsWith('Token:athenaseason')) continue;
        if (athena.items[templateId]) continue;
        athena.items[templateId] = {
          templateId,
          attributes: { max_level_bonus: 0, level: 1, item_seen: false, xp: 0, favorite: false },
          quantity
        };
        granted.push({ templateId, quantity });
      }
    }
    return granted;
  }

    async purchase(accountId, offerId, store, config) {
    if (!BATTLE_PASS_OFFERS[offerId]) return null;
    let result;
    await store.update((state) => {
      result = this.handlePurchase(state, accountId, offerId, config);
    });
    return result;
  }

  // Chamado pelo shop.buy dentro do store.update. Retorna a compra ou null
  handlePurchase(state, accountId, offerId, config) {
    const offer = BATTLE_PASS_OFFERS[offerId];
    if (!offer) return null;

    const profiles = state.profiles ??= {};
    const prof = profiles[accountId];
    if (!prof) {
      const error = new Error('Account not found.');
      error.status = 404;
      error.code = 'account_not_found';
      throw error;
    }

    const price = Number(config?.battlepass?.[offer.key] ?? offer.defaultPrice);
    const currency = prof.common_core?.items?.['Currency:MtxPurchased'];
    const balance = currency?.quantity ?? 0;
    if (balance < price) {
      const error = new Error('Not enough V-Bucks for this offer.');
      error.status = 402;
      error.code = 'insufficient_funds';
      error.balance = balance;
      error.price = price;
      throw error;
    }
    if (currency) currency.quantity -= price;

    const athena = prof.athena;
    athena.items ??= {};
    athena.stats ??= {};
    athena.stats.attributes ??= {};

    const granted = [];
    if (offer.key !== 'singleTier') {
      // token = passe ativo
      athena.items[TOKEN] = {
        templateId: TOKEN,
        attributes: { max_level_bonus: 0, level: 1, item_seen: false, xp: 0, variants: [], favorite: false },
        quantity: 1
      };
      athena.stats.attributes.book_purchased = true;
      athena.stats.attributes.book_purchased_book_xp_offset = 0;
      athena.stats.attributes.season_num = 4;
      // passe começa no tier 1 (mantém se já tiver mais)
      athena.stats.attributes.book_level = Math.max(athena.stats.attributes.book_level ?? 0, 1);
      this.grantUpTo(athena, athena.stats.attributes.book_level, granted);
    }

    if (offer.tiers > 0) {
      athena.stats.attributes.book_level = (athena.stats.attributes.book_level ?? 0) + offer.tiers;
      this.grantUpTo(athena, athena.stats.attributes.book_level, granted);
    }

    const now = new Date().toISOString();
    athena.rvn = (athena.rvn ?? 0) + 1;
    athena.commandRevision = (athena.commandRevision ?? 0) + 1;
    athena.updated = now;

    const core = prof.common_core;
    if (core) {
      core.rvn = (core.rvn ?? 0) + 1;
      core.commandRevision = (core.commandRevision ?? 0) + 1;
      core.updated = now;
    }

    const purchase = {
      purchaseId: randomUUID(),
      accountId,
      offerId,
      devName: offer.devName,
      price,
      itemGrants: granted,
      createdAt: new Date().toISOString(),
      balance: currency?.quantity ?? 0
    };
    state.purchases ??= [];
    state.purchases.push(purchase);

    console.log('[battlepass] compra ok:', offer.key, '| book_level:', athena.stats.attributes.book_level, '| itens concedidos:', granted.length);
    return purchase;
  }

  // Gancho de login: entrega pendências de tiers já alcançados
  grantPendingOnLogin(state, accountId) {
    const athena = state.profiles?.[accountId]?.athena;
    if (!athena?.stats?.attributes?.book_purchased) return 0;
    const level = athena.stats.attributes.book_level ?? 0;
    if (level <= 0) return 0;
    const granted = this.grantUpTo(athena, level);
    if (granted.length) {
      const now = new Date().toISOString();
      athena.rvn = (athena.rvn ?? 0) + 1;
      athena.commandRevision = (athena.commandRevision ?? 0) + 1;
      console.log('[battlepass] pendências entregues no login:', granted.length);
    }
    return granted.length;
  }

  seasonStorefront() {
    const expiration = '9999-12-31T23:59:59.999Z';

    const entry = (offerId, offer) => ({
      offerId,
      devName: offer.devName,
      offerType: 'StaticPrice',
      fulfillmentIds: [],
      dailyLimit: -1,
      weeklyLimit: -1,
      monthlyLimit: -1,
      categories: [],
      prices: [{
        currencyType: 'MtxCurrency',
        currencySubType: '',
        regularPrice: offer.regularPrice,
        finalPrice: offer.finalPrice,
        ...(offer.saleType ? { saleType: offer.saleType } : {}),
        saleExpiration: expiration,
        basePrice: offer.finalPrice
      }],
      requirements: [],
      meta: {
        SectionId: 'BRSeason4',
        TileSize: 'Normal',
        inDate: '2018-04-30T00:00:00.000Z',
        outDate: '9999-12-31T23:59:59.999Z'
      },
      matchFilter: '',
      filterWeight: 0,
      appStoreId: [],
      metaInfo: [
        { key: 'SectionId', value: 'BRSeason4' },
        { key: 'TileSize', value: 'Normal' }
      ],
      catalogGroup: '',
      displayAssetPath: offer.displayAssetPath,
      itemGrants: [],
      sortPriority: offer.sortPriority ?? 0,
      catalogGroupPriority: 0,
      title: {
        en: offer.titleEn,
        'pt-br': offer.titlePt,
        es: offer.titlePt,
        fr: offer.titleEn,
        de: offer.titleEn
      },
      shortDescription: {
        en: offer.shortEn,
        'pt-br': offer.shortPt
      },
      description: {
        en: offer.descEn,
        'pt-br': offer.descPt
      }
    });

    const seasonOffers = {
      '76EA7FE9787744B09B79FF3FC5E39D0C': {
        devName: 'BR.Season4.BattlePass.01',
        titleEn: 'Battle Pass', titlePt: 'Passe de Batalha',
        shortEn: 'Chapter 1 - Season 4', shortPt: 'Capítulo 1 - Temporada 4',
        descEn: 'Chapter 1 - Season 4 Battle Pass. Play to level up and unlock over 100 rewards!',
        descPt: 'Passe de Batalha da Temporada 4. Jogue para subir de nível e desbloqueie mais de 100 recompensas!',
        displayAssetPath: '/Game/Catalog/DisplayAssets/DA_BR_Season4_BattlePass.DA_BR_Season4_BattlePass',
        regularPrice: 950, finalPrice: 950, saleType: '',
        sortPriority: 1
      },
      '884CE68998C44AC58D85C5A9883DE1A6': {
        devName: 'BR.Season4.BattleBundle.01',
        titleEn: 'Battle Bundle', titlePt: 'Pacotão de Batalha',
        shortEn: 'Battle Pass + 25 tiers!', shortPt: 'Passe de Batalha + 25 níveis!',
        descEn: 'Chapter 1 - Season 4 Battle Pass with 25 tiers unlocked instantly!',
        descPt: 'Passe de Batalha da Temporada 4 com 25 níveis desbloqueados na hora!',
        displayAssetPath: '/Game/Catalog/DisplayAssets/DA_BR_Season4_BattlePassWithLevels.DA_BR_Season4_BattlePassWithLevels',
        regularPrice: 4700, finalPrice: 2800, saleType: 'PercentOff',
        sortPriority: 0
      },
      'E9527AF46F4B4A9CAE98D91F2AA53CB6': {
        devName: 'BR.Season4.SingleTier.01',
        titleEn: 'Battle Pass Tier', titlePt: 'Nível do Passe de Batalha',
        shortEn: '', shortPt: '',
        descEn: 'Get great rewards now!',
        descPt: 'Conquiste grandes recompensas agora!',
        displayAssetPath: '',
        regularPrice: 150, finalPrice: 150, saleType: ''
      }
    };

    return {
      name: 'BRSeason4',
      catalogEntries: Object.entries(seasonOffers).map(([offerId, offer]) => entry(offerId, offer))
    };
  }
}