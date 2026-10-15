import { randomUUID } from 'node:crypto';

const DEFAULT_COSMETICS = [
  ['AthenaPickaxe:DefaultPickaxe', 'AthenaPickaxe'],
  ['AthenaGlider:DefaultGlider', 'AthenaGlider'],
  ['AthenaDance:EID_DanceMoves', 'AthenaDance']
];

function itemEntry(templateId, now) {
  return {
    templateId,
    attributes: {
      max_level_bonus: 0,
      level: 1,
      item_seen: true,
      xp: 0,
      variants: [],
      favorite: false
    },
    quantity: 1
  };
}

function makeLockerSlots() {
  return {
    slots: {
      Character: { items: [''], activeVariants: [{ variants: [] }] },
      Backpack: { items: [''], activeVariants: [{ variants: [] }] },
      Pickaxe: { items: ['AthenaPickaxe:DefaultPickaxe'], activeVariants: [] },
      Glider: { items: ['AthenaGlider:DefaultGlider'], activeVariants: [] },
      Dance: { items: ['AthenaDance:EID_DanceMoves', '', '', '', '', ''] },
      ItemWrap: { items: ['', '', '', '', '', '', '', ''], activeVariants: [null, null, null, null, null, null, null, null] },
      LoadingScreen: { items: [''], activeVariants: [null] },
      MusicPack: { items: [''], activeVariants: [null] },
      SkyDiveContrail: { items: [''], activeVariants: [null] }
    }
  };
}

export function createAthenaProfile(accountId) {
  const now = new Date().toISOString();
  const items = {
    sandbox_loadout: {
      templateId: 'CosmeticLocker:cosmeticlocker_athena',
      attributes: {
        locker_slots_data: makeLockerSlots(),
        use_count: 1,
        banner_icon_template: '',
        locker_name: 'Default Loadout',
        banner_color_template: '',
        item_seen: false,
        favorite: false
      },
      quantity: 1
    }
  };
  for (const [templateId] of DEFAULT_COSMETICS) items[templateId] = itemEntry(templateId, now);
  return {
    _id: randomUUID(),
    created: now,
    updated: now,
    rvn: 1,
    wipeNumber: 1,
    accountId,
    profileId: 'athena',
    version: 'ogfn-local',
    items,
    stats: {
      attributes: {
        accountLevel: 1,
        competitive_identity: {},
        favorite_character: '',
        favorite_backpack: '',
        favorite_dance: ['AthenaDance:EID_DanceMoves', '', '', '', '', ''],
        favorite_pickaxe: 'AthenaPickaxe:DefaultPickaxe',
        favorite_glider: 'AthenaGlider:DefaultGlider',
        favorite_skydivecontrail: '',
        favorite_musicpack: '',
        favorite_loadingscreen: '',
        daily_rewards: {},
        xp: 0,
        season_friend_match_boost: 0,
        banner_icon: '',
        banner_color: '',
        active_loadout_index: 0,
        inventory_limit_bonus: 0
      }
    },
    commandRevision: 0
  };
}

export function createEmptyProfile(accountId, profileId, startingVbucks = 0) {
  const now = new Date().toISOString();
  const items = {};
  if (profileId === 'common_core' && Number.isSafeInteger(startingVbucks) && startingVbucks > 0) {
    items['Currency'] = {
      templateId: 'Currency:MtxPurchased',
      attributes: { platform: 'EpicPC' },
      quantity: startingVbucks
    };
  }
  return {
    _id: randomUUID(),
    created: now,
    updated: now,
    rvn: 1,
    wipeNumber: 1,
    accountId,
    profileId,
    version: 'ogfn-local',
    items,
    stats: { attributes: {} },
    commandRevision: 0
  };
}

export function fullProfileResponse(profile, baseRevision = -1) {
  return {
    profileRevision: profile.rvn,
    profileId: profile.profileId,
    profileChangesBaseRevision: baseRevision,
    profileChanges: [{ changeType: 'fullProfileUpdate', profile: structuredClone(profile) }],
    notifications: [],
    commandRevision: profile.commandRevision,
    serverTime: new Date().toISOString(),
    multiUpdate: [],
    responseVersion: 1
  };
}

export class ProfileService {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
  }

  get(accountId, profileId) {
    const profile = this.store.snapshot().profiles[accountId]?.[profileId];
    return profile ? structuredClone(profile) : null;
  }

  async query(accountId, profileId) {
    const profile = this.get(accountId, profileId);
    if (!profile) return null;
    return fullProfileResponse(profile, -1);
  }

  async command(accountId, profileId, operation, body = {}) {
    if (profileId === 'campaign' || profileId.startsWith('campaign_') || profileId === 'theater') {
      return {
        status: 403,
        body: {
          errorCode: 'fortnite.game.profile.SaveTheWorldAccessRequired',
          errorMessage: 'Save the World must be purchased before this mode can be accessed.',
          numericErrorCode: 403,
          originatingService: 'fortnite',
          intent: 'prod',
          messageVars: ['Save the World'],
          profileId
        }
      };
    }
    if (!['athena', 'common_core', 'common_public', 'profile0', 'metadata'].includes(profileId)) {
      return { status: 404, body: { errorCode: 'fortnite.game.profile.ProfileNotFound', errorMessage: `Profile '${profileId}' is not available.`, numericErrorCode: 404, profileId } };
    }
    let resultProfile;
    let oldRevision;
    let changedItemIds = [];
    await this.store.update((state) => {
      const profile = state.profiles[accountId]?.[profileId];
      if (!profile) throw new Error(`Profile ${profileId} was not initialized for ${accountId}`);
      oldRevision = profile.rvn;
      if (operation.toLowerCase() === 'queryprofile') {
        resultProfile = structuredClone(profile);
        return true;
      }
      if (profileId !== 'athena' && operation.toLowerCase() !== 'setmtxplatform') {
        throw new Error(`Operation ${operation} is not supported for ${profileId}`);
      }
      switch (operation.toLowerCase()) {
        case 'setcosmeticlockerslot': {
          const slotName = String(body.slotName ?? '');
          const index = Number(body.indexWithinSlot ?? 0);
          const itemId = String(body.itemToSlot ?? '');
          const validSlots = new Set(['Character', 'Backpack', 'Pickaxe', 'Glider', 'Dance', 'ItemWrap', 'LoadingScreen', 'MusicPack', 'SkyDiveContrail']);
          if (!validSlots.has(slotName) || !Number.isInteger(index) || index < 0 || index > 7) throw new Error('Invalid cosmetic locker slot.');
          if (itemId && !profile.items[itemId]) throw new Error('Cannot equip an item that is not owned.');
          const slots = profile.items.sandbox_loadout.attributes.locker_slots_data.slots;
          const slot = slots[slotName] ?? { items: [] };
          while (slot.items.length <= index) slot.items.push('');
          slot.items[index] = itemId;
          slots[slotName] = slot;
          if (itemId) profile.items[itemId].attributes.item_seen = true;
          changedItemIds = ['sandbox_loadout', ...(itemId ? [itemId] : [])];
          break;
        }
        case 'markitemseen': {
          const ids = Array.isArray(body.itemIds) ? body.itemIds : [body.itemId].filter(Boolean);
          for (const itemId of ids) {
            if (!profile.items[itemId]) throw new Error(`Item '${itemId}' is not owned.`);
            profile.items[itemId].attributes.item_seen = true;
          }
          changedItemIds = ids;
          break;
        }
        case 'setmtxplatform': {
          if (!profile.stats.attributes) profile.stats.attributes = {};
          profile.stats.attributes.mtx_platform = String(body.platform ?? body.targetPlatform ?? '');
          break;
        }
        case 'setitemfavoritestatus': {
          const itemId = String(body.itemId ?? '');
          if (!profile.items[itemId]) throw new Error(`Item '${itemId}' is not owned.`);
          profile.items[itemId].attributes.favorite = Boolean(body.bFavorite);
          changedItemIds = [itemId];
          break;
        }
        case 'clientquestlogin': {
          resultProfile = structuredClone(profile);
          return true;
        }

        case 'equipbattleroyalecustomization': {
          const slotName = String(body.slotName ?? '');
          const itemId = String(body.itemToSlot ?? '');
          const index = Number(body.indexWithinSlot ?? 0);
          const validSlots = new Set(['Character', 'Backpack', 'Pickaxe', 'Glider', 'Dance', 'ItemWrap', 'LoadingScreen', 'MusicPack', 'SkyDiveContrail']);
          if (!validSlots.has(slotName)) throw new Error(`Invalid slot: ${slotName}`);

          const slots = profile.items.sandbox_loadout.attributes.locker_slots_data.slots;
          const slot = slots[slotName] ?? { items: [], activeVariants: [] };
          while (slot.items.length <= index) slot.items.push('');
          slot.items[index] = itemId;
          slots[slotName] = slot;

          // sincroniza os favorite_* das stats (é daqui que o cliente lê no boot)
          const favoriteField = `favorite_${slotName.toLowerCase()}`;
          if (slotName === 'Dance') {
            profile.stats.attributes.favorite_dance[index] = itemId;
          } else if (favoriteField in profile.stats.attributes) {
            profile.stats.attributes[favoriteField] = itemId;
          }

          changedItemIds = ['sandbox_loadout', ...(itemId ? [itemId] : [])];
          break;
        }

        case 'bulkequipbattleroyalecustomization': {
          const equipItems = Array.isArray(body.equippedItems) ? body.equippedItems : [];
          const validSlots = new Set(['Character', 'Backpack', 'Pickaxe', 'Glider', 'Dance', 'ItemWrap', 'LoadingScreen', 'MusicPack', 'SkyDiveContrail']);
          const slots = profile.items.sandbox_loadout.attributes.locker_slots_data.slots;
          const changed = ['sandbox_loadout'];
          for (const equip of equipItems) {
            const slotName = String(equip?.slotName ?? '');
            const itemId = String(equip?.itemToSlot ?? '');
            const index = Number(equip?.indexWithinSlot ?? 0);
            if (!validSlots.has(slotName)) continue;
            const slot = slots[slotName] ?? { items: [], activeVariants: [] };
            while (slot.items.length <= index) slot.items.push('');
            slot.items[index] = itemId;
            slots[slotName] = slot;
            if (slotName === 'Dance') profile.stats.attributes.favorite_dance[index] = itemId;
            else if (`favorite_${slotName.toLowerCase()}` in profile.stats.attributes) profile.stats.attributes[`favorite_${slotName.toLowerCase()}`] = itemId;
          }
          changedItemIds = changed;
          break;
        }

        default:
          throw new Error(`Unsupported Athena operation: ${operation}`);
      }
      profile.rvn += 1;
      profile.commandRevision += 1;
      profile.updated = new Date().toISOString();
      resultProfile = structuredClone(profile);
      return true;
    });
    if (operation.toLowerCase() === 'queryprofile' || operation.toLowerCase() === 'clientquestlogin') return { status: 200, body: fullProfileResponse(resultProfile, -1) };
    if (operation.toLowerCase() === 'setmtxplatform') return { status: 200, body: fullProfileResponse(resultProfile, oldRevision) };
    return {
      status: 200,
      body: {
        profileRevision: resultProfile.rvn,
        profileId,
        profileChangesBaseRevision: oldRevision,
        profileChanges: [{ changeType: 'fullProfileUpdate', profile: structuredClone(resultProfile) }],
        notifications: [],
        commandRevision: resultProfile.commandRevision,
        serverTime: new Date().toISOString(),
        multiUpdate: [],
        responseVersion: 1
      }
    };
  }

  saveTheWorldAccess(accountId) {
    return { accountId, hasAccess: false, requiredPurchase: true, message: 'Save the World must be purchased before this mode can be accessed.' };
  }
}

export const DEFAULT_COSMETIC_IDS = DEFAULT_COSMETICS.map(([id]) => id);
