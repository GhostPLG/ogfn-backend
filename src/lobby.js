import { randomUUID } from 'node:crypto';

export class LobbyService {
  constructor({ store }) {
    this.store = store;
    this.parties = new Map();
    this.partyByAccount = new Map();
    this.invitations = new Map();
  }

  getOrCreate(account) {
    const existingId = this.partyByAccount.get(account.id);
    const existing = existingId ? this.parties.get(existingId) : null;
    if (existing) return structuredClone(existing);
    const party = {
      id: randomUUID().replaceAll('-', ''),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revision: 1,
      leader: account.id,
      members: [{ accountId: account.id, displayName: account.displayName, role: 'CAPTAIN', joinedAt: new Date().toISOString(), readiness: 'NOT_READY' }],
      config: {
        joinability: 'INVITE_AND_FORMER',
        privacy: { partyType: 'Public', inviteRestriction: 'AnyMember', onlyLeaderFriendsCanJoin: false, presencePermission: 'Anyone', invitePermission: 'Anyone' },
        maxSize: 16,
        playlist: 'Playlist_DefaultSolo',
        region: 'EU'
      },
      matchmaking: { status: 'idle', sessionId: null, ticketId: null }
    };
    this.parties.set(party.id, party);
    this.partyByAccount.set(account.id, party.id);
    return structuredClone(party);
  }

  getParty(partyId) {
    const party = this.parties.get(partyId);
    return party ? structuredClone(party) : null;
  }

  getForAccount(accountId) {
    const id = this.partyByAccount.get(accountId);
    return id ? this.getParty(id) : null;
  }

  requireMember(partyId, accountId) {
    const party = this.parties.get(partyId);
    if (!party || !party.members.some((member) => member.accountId === accountId)) {
      const error = new Error('Lobby party was not found for this account.');
      error.status = 404;
      error.code = 'party_not_found';
      throw error;
    }
    return party;
  }

  updateConfig(partyId, accountId, changes = {}) {
    const party = this.requireMember(partyId, accountId);
    if (party.leader !== accountId) {
      const error = new Error('Only the lobby leader may change party settings.');
      error.status = 403;
      error.code = 'party_leader_required';
      throw error;
    }
    const maxSize = Number(changes.maxSize ?? party.config.maxSize);
    if (!Number.isInteger(maxSize) || maxSize < party.members.length || maxSize > 16) {
      const error = new Error('Party maxSize must be between current member count and 16.');
      error.status = 400;
      error.code = 'invalid_party_size';
      throw error;
    }
    party.config = {
      ...party.config,
      ...Object.fromEntries(['joinability', 'playlist', 'region'].filter((key) => changes[key] !== undefined).map((key) => [key, String(changes[key])])),
      maxSize
    };
    if (changes.privacy && typeof changes.privacy === 'object') party.config.privacy = { ...party.config.privacy, ...changes.privacy };
    party.revision += 1;
    party.updatedAt = new Date().toISOString();
    return structuredClone(party);
  }

  invite(partyId, fromAccountId, targetAccountId) {
    const party = this.requireMember(partyId, fromAccountId);
    if (!this.store.findAccountById(targetAccountId)) {
      const error = new Error('Target account does not exist.');
      error.status = 404;
      error.code = 'account_not_found';
      throw error;
    }
    if (party.members.length >= party.config.maxSize) {
      const error = new Error('This lobby party is full.');
      error.status = 409;
      error.code = 'party_full';
      throw error;
    }
    const accountPartyId = this.partyByAccount.get(targetAccountId);
    const targetParty = accountPartyId ? this.parties.get(accountPartyId) : null;
    if (targetParty?.id === partyId) {
      const error = new Error('Target account is already a member of this lobby.');
      error.status = 409;
      error.code = 'already_party_member';
      throw error;
    }
    const invitation = { partyId, fromAccountId, targetAccountId, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
    if (!this.invitations.has(targetAccountId)) this.invitations.set(targetAccountId, new Map());
    this.invitations.get(targetAccountId).set(partyId, invitation);
    return structuredClone(invitation);
  }

  join(partyId, account) {
    const party = this.parties.get(partyId);
    if (!party) {
      const error = new Error('Lobby party was not found.');
      error.status = 404;
      error.code = 'party_not_found';
      throw error;
    }
    const invitation = this.invitations.get(account.id)?.get(partyId);
    if (!invitation || Date.parse(invitation.expiresAt) <= Date.now()) {
      const error = new Error('A valid lobby invitation is required.');
      error.status = 403;
      error.code = 'party_invite_required';
      throw error;
    }
    if (party.members.length >= party.config.maxSize) {
      const error = new Error('This lobby party is full.');
      error.status = 409;
      error.code = 'party_full';
      throw error;
    }
    const existingId = this.partyByAccount.get(account.id);
    if (existingId && existingId !== partyId) this.leave(existingId, account.id);
    if (!party.members.some((member) => member.accountId === account.id)) {
      party.members.push({ accountId: account.id, displayName: account.displayName, role: 'MEMBER', joinedAt: new Date().toISOString(), readiness: 'NOT_READY' });
      party.revision += 1;
    }
    this.partyByAccount.set(account.id, partyId);
    this.invitations.get(account.id)?.delete(partyId);
    party.updatedAt = new Date().toISOString();
    return structuredClone(party);
  }

  leave(partyId, accountId) {
    const party = this.parties.get(partyId);
    if (!party || !party.members.some((member) => member.accountId === accountId)) return false;
    party.members = party.members.filter((member) => member.accountId !== accountId);
    this.partyByAccount.delete(accountId);
    party.revision += 1;
    party.updatedAt = new Date().toISOString();
    if (party.members.length === 0) this.parties.delete(partyId);
    else if (party.leader === accountId) {
      party.leader = party.members[0].accountId;
      party.members[0].role = 'CAPTAIN';
    }
    return true;
  }

  setMatchmaking(accountId, ticket) {
    const party = this.getForAccount(accountId);
    if (!party) return null;
    const current = this.parties.get(party.id);
    current.matchmaking = {
      status: ticket?.status ?? 'idle',
      ticketId: ticket?.ticketId ?? null,
      sessionId: ticket?.session?.id ?? null,
      playlist: ticket?.playlist ?? current.config.playlist,
      region: ticket?.region ?? current.config.region
    };
    current.revision += 1;
    current.updatedAt = new Date().toISOString();
    return structuredClone(current);
  }

  getInvitations(accountId) {
    return [...(this.invitations.get(accountId)?.values() ?? [])].filter((item) => Date.parse(item.expiresAt) > Date.now()).map((item) => structuredClone(item));
  }
}
