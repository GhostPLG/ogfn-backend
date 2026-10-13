import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

function asJson(response) {
  return response.json().catch(() => null);
}

function matchmakingError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export class Matchmaker {
  constructor({ store, config, gameServer }) {
    this.store = store;
    this.config = config;
    this.gameServer = gameServer;
    this.queues = new Map();
    this.ticketsById = new Map();
    this.activeByAccount = new Map();
    this.subscribers = new Map();
    this.processing = new Map();
    this.timeout = setInterval(() => this.expireQueues(), 5000);
    this.timeout.unref?.();
  }

  signTicket(sessionId, accountId, expiresAt) {
    const payload = Buffer.from(JSON.stringify({ sid: sessionId, sub: accountId, exp: expiresAt })).toString('base64url');
    const signature = createHmac('sha256', this.config.matchmaking.sessionKey).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  verifyTicket(token) {
    if (typeof token !== 'string') return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    const expected = createHmac('sha256', this.config.matchmaking.sessionKey).update(payload).digest();
    let actual;
    try {
      actual = Buffer.from(signature, 'base64url');
    } catch {
      return null;
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!value.sid || !value.sub || !Number.isFinite(value.exp) || value.exp <= Date.now()) return null;
      return value;
    } catch {
      return null;
    }
  }

  playlistIsStw(playlist) {
    return /stw|campaign|save.?the.?world/iu.test(playlist);
  }

  validateQueueOptions({ playlist, region } = {}) {
    const selectedPlaylist = String(playlist ?? this.config.matchmaking.defaultPlaylist).trim();
    const selectedRegion = String(region ?? this.config.matchmaking.defaultRegion).toUpperCase();
    if (!/^[a-z0-9_-]{2,64}$/iu.test(selectedPlaylist)) throw matchmakingError(400, 'invalid_playlist', 'Playlist name is invalid.');
    if (!/^[A-Z0-9_-]{2,12}$/u.test(selectedRegion)) throw matchmakingError(400, 'invalid_region', 'Region is invalid.');
    if (this.playlistIsStw(selectedPlaylist)) throw matchmakingError(403, 'save_the_world_purchase_required', 'Save the World is unavailable: this account must purchase access to the mode.');
    return { playlist: selectedPlaylist, region: selectedRegion };
  }

  normalizePlayers(accounts) {
    if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > 16) throw matchmakingError(400, 'invalid_party_size', 'A matchmaking party must contain 1-16 players.');
    const unique = new Map();
    for (const account of accounts) {
      if (!account?.id || !account?.displayName || !this.store.findAccountById(account.id)) throw matchmakingError(400, 'invalid_party_member', 'Every matchmaking party member must be a registered account.');
      unique.set(account.id, { accountId: account.id, displayName: account.displayName });
    }
    return [...unique.values()];
  }

  async enqueue(account, options = {}) {
    return this.enqueueGroup([account], options);
  }

  async enqueueGroup(accounts, options = {}) {
    const members = this.normalizePlayers(accounts);
    const { playlist, region } = this.validateQueueOptions(options);
    const maxPlayers = Math.min(Number(this.config.matchmaking.maxPlayers) || 100, Number(this.config.gameServer.maxPlayers) || 100);
    if (members.length > maxPlayers) throw matchmakingError(400, 'party_exceeds_session_capacity', 'The party has more players than this GameServer session can accept.');

    const activeTickets = new Set(members.map((member) => this.activeByAccount.get(member.accountId)).filter(Boolean));
    if (activeTickets.size === 1) {
      const existing = this.ticketsById.get([...activeTickets][0]);
      const existingMembers = new Set((existing?.members ?? []).map((member) => member.accountId));
      const sameMembers = existingMembers.size === members.length && members.every((member) => existingMembers.has(member.accountId));
      const sameQueue = existing?.playlist === playlist && existing?.region === region;
      if (existing && sameMembers && sameQueue && ['queued', 'matching'].includes(existing.status)) return structuredClone(existing);
      if (existing && sameMembers && sameQueue && existing.status === 'matched' && existing.session && Date.parse(existing.session.expiresAt) > Date.now()) return structuredClone(existing);
      throw matchmakingError(409, 'player_already_matchmaking', 'One or more party members already have an active or completed matchmaking assignment.');
    }
    if (activeTickets.size > 0) throw matchmakingError(409, 'party_members_in_different_queues', 'Party members must leave their existing matchmaking queue before forming a joint match.');

    const poolKey = `${region}:${playlist}`;
    const now = new Date().toISOString();
    const ticket = {
      ticketId: randomUUID(),
      accountId: members[0].accountId,
      displayName: members[0].displayName,
      members,
      playlist,
      region,
      status: 'queued',
      createdAt: now,
      expiresAt: new Date(Date.now() + Number(this.config.matchmaking.queueTimeoutSeconds) * 1000).toISOString(),
      session: null,
      joinTickets: {},
      error: null
    };
    if (this.ticketsById.size > 5000) this.pruneTickets();
    this.ticketsById.set(ticket.ticketId, ticket);
    for (const member of members) this.activeByAccount.set(member.accountId, ticket.ticketId);
    if (!this.queues.has(poolKey)) this.queues.set(poolKey, []);
    this.queues.get(poolKey).push(ticket.ticketId);
    for (const member of members) this.publish(member.accountId, { type: 'status', ticket: this.publicTicket(ticket, member.accountId) });
    await this.processPool(poolKey);
    return structuredClone(ticket);
  }

  async processPool(poolKey) {
    if (this.processing.get(poolKey)) return this.processing.get(poolKey);
    const task = (async () => {
      const initialQueue = this.queues.get(poolKey) ?? [];
      const minPlayers = Math.max(1, Number(this.config.matchmaking.minPlayers) || 1);
      const fillWindow = Math.max(0, Math.min(10000, Number(this.config.matchmaking.matchFillWindowMilliseconds) || 0));
      const maxPlayers = Math.min(Number(this.config.matchmaking.maxPlayers) || 100, Number(this.config.gameServer.maxPlayers) || 100);
      if (fillWindow > 0 && initialQueue.some((id) => this.ticketsById.get(id)?.status === 'queued')) await delay(fillWindow);
      while (true) {
        const queue = this.queues.get(poolKey) ?? [];
        const waiting = queue.map((id) => this.ticketsById.get(id)).filter((ticket) => ticket?.status === 'queued');
        const totalWaitingPlayers = waiting.reduce((count, ticket) => count + ticket.members.length, 0);
        if (totalWaitingPlayers < minPlayers) break;
        const batch = [];
        let playerCount = 0;
        for (const ticket of waiting) {
          if (playerCount + ticket.members.length > maxPlayers) continue;
          batch.push(ticket);
          playerCount += ticket.members.length;
          if (playerCount >= maxPlayers) break;
        }
        if (playerCount < minPlayers) break;
        await this.createMatch(poolKey, batch);
      }
    })().finally(() => this.processing.delete(poolKey));
    this.processing.set(poolKey, task);
    return task;
  }

  async createMatch(poolKey, tickets) {
    const queue = this.queues.get(poolKey) ?? [];
    const sessionPlayers = tickets.flatMap((ticket) => ticket.members.map((member) => ({ ...member, ticketId: ticket.ticketId })));
    if (!sessionPlayers.length) return;
    for (const ticket of tickets) {
      ticket.status = 'matching';
      for (const member of ticket.members) this.publish(member.accountId, { type: 'status', ticket: this.publicTicket(ticket, member.accountId) });
    }
    const [region, ...playlistParts] = poolKey.split(':');
    const playlist = playlistParts.join(':');
    const sessionId = randomUUID().replaceAll('-', '').toUpperCase();
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).getTime();
    const playerData = sessionPlayers.map((member) => ({
      accountId: member.accountId,
      displayName: member.displayName,
      ticketId: member.ticketId,
      joinTicket: this.signTicket(sessionId, member.accountId, expiresAt)
    }));
    try {
      const endpoint = `${this.config.gameServer.controlUrl.replace(/\/$/u, '')}/internal/sessions`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.gameServer.internalSecret}`
        },
        body: JSON.stringify({
          sessionId,
          playlist,
          region,
          players: playerData,
          maxPublicPlayers: Math.min(this.config.gameServer.maxPlayers, this.config.matchmaking.maxPlayers),
          expiresAt: new Date(expiresAt).toISOString()
        }),
        signal: AbortSignal.timeout(5000)
      });
      const body = await asJson(response);
      if (!response.ok) throw new Error(body?.errorMessage ?? `GameServer returned HTTP ${response.status}.`);
      const session = body.session ?? body;
      const savedSession = {
        id: sessionId,
        ownerId: playerData[0].accountId,
        ownerName: playerData[0].displayName,
        playlist,
        region,
        serverAddress: session.serverAddress ?? this.config.gameServer.publicHost,
        serverPort: session.serverPort ?? this.config.gameServer.port,
        maxPublicPlayers: session.maxPublicPlayers ?? this.config.gameServer.maxPlayers,
        openPublicPlayers: session.openPublicPlayers ?? Math.max(0, (session.maxPublicPlayers ?? this.config.gameServer.maxPlayers) - playerData.length),
        started: Boolean(session.started),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        players: playerData.map((player) => ({ accountId: player.accountId, displayName: player.displayName, ticketId: player.ticketId, joinTicket: player.joinTicket }))
      };
      await this.store.update((state) => {
        state.matches[sessionId] = structuredClone(savedSession);
        return true;
      });
      for (const ticket of tickets) {
        ticket.status = 'matched';
        ticket.session = structuredClone(savedSession);
        ticket.expiresAt = savedSession.expiresAt;
        ticket.joinTickets = Object.fromEntries(ticket.members.map((member) => {
          const assignment = playerData.find((player) => player.accountId === member.accountId);
          return [member.accountId, assignment.joinTicket];
        }));
        ticket.joinTicket = ticket.joinTickets[ticket.accountId];
        ticket.matchedAt = new Date().toISOString();
        for (const member of ticket.members) this.publish(member.accountId, { type: 'matched', ticket: this.publicTicket(ticket, member.accountId) });
      }
    } catch (error) {
      for (const ticket of tickets) {
        ticket.status = 'failed';
        ticket.error = { code: 'gameserver_unavailable', message: error.message };
        for (const member of ticket.members) {
          this.activeByAccount.delete(member.accountId);
          this.publish(member.accountId, { type: 'error', ticket: this.publicTicket(ticket, member.accountId) });
        }
      }
    } finally {
      const finished = new Set(tickets.map((ticket) => ticket.ticketId));
      this.queues.set(poolKey, queue.filter((id) => !finished.has(id)));
    }
  }

  publicTicket(ticket, requestedAccountId = ticket?.accountId) {
    if (!ticket) return null;
    return {
      ticketId: ticket.ticketId,
      accountId: requestedAccountId,
      playlist: ticket.playlist,
      region: ticket.region,
      status: ticket.status,
      createdAt: ticket.createdAt,
      expiresAt: ticket.expiresAt,
      matchedAt: ticket.matchedAt ?? null,
      members: ticket.members.map(({ accountId, displayName }) => ({ accountId, displayName })),
      session: ticket.session ? this.publicSession(ticket.session) : null,
      joinTicket: ticket.joinTickets?.[requestedAccountId] ?? (requestedAccountId === ticket.accountId ? ticket.joinTicket ?? null : null),
      error: ticket.error
    };
  }

  publicSession(session) {
    return {
      id: session.id,
      ownerId: session.ownerId,
      ownerName: session.ownerName,
      serverAddress: session.serverAddress,
      serverPort: session.serverPort,
      playlist: session.playlist,
      region: session.region,
      maxPublicPlayers: session.maxPublicPlayers,
      openPublicPlayers: session.openPublicPlayers,
      started: session.started,
      expiresAt: session.expiresAt
    };
  }

  getTicketById(ticketId, accountId) {
    const ticket = this.ticketsById.get(ticketId);
    if (!ticket || (accountId && !ticket.members.some((member) => member.accountId === accountId))) return null;
    return this.publicTicket(ticket, accountId ?? ticket.accountId);
  }

  getTicketByAccount(accountId) {
    const ticketId = this.activeByAccount.get(accountId);
    const ticket = ticketId ? this.ticketsById.get(ticketId) : null;
    if (ticket && Date.parse(ticket.expiresAt) > Date.now()) return this.publicTicket(ticket, accountId);
    return null;
  }

  getSession(sessionId) {
    const session = this.store.snapshot().matches[sessionId];
    if (!session || Date.parse(session.expiresAt) <= Date.now()) return null;
    return session;
  }

  sessionForAccount(accountId, sessionId) {
    const session = this.getSession(sessionId);
    if (!session || !session.players.some((player) => player.accountId === accountId)) return null;
    return session;
  }

  async leave(accountId) {
    const ticketId = this.activeByAccount.get(accountId);
    const ticket = ticketId ? this.ticketsById.get(ticketId) : null;
    if (!ticket || !['queued', 'matching'].includes(ticket.status)) return false;
    ticket.status = 'cancelled';
    for (const member of ticket.members) {
      this.activeByAccount.delete(member.accountId);
      this.publish(member.accountId, { type: 'cancelled', ticket: this.publicTicket(ticket, member.accountId) });
    }
    const poolKey = `${ticket.region}:${ticket.playlist}`;
    this.queues.set(poolKey, (this.queues.get(poolKey) ?? []).filter((id) => id !== ticketId));
    return true;
  }

  expireQueues() {
    const now = Date.now();
    for (const [ticketId, ticket] of this.ticketsById.entries()) {
      if (Date.parse(ticket.expiresAt) > now) continue;
      if (ticket.status === 'queued') {
        ticket.status = 'expired';
        for (const member of ticket.members) {
          this.activeByAccount.delete(member.accountId);
          this.publish(member.accountId, { type: 'expired', ticket: this.publicTicket(ticket, member.accountId) });
        }
      } else if (ticket.status === 'matched' || ticket.status === 'failed' || ticket.status === 'cancelled') {
        for (const member of ticket.members) this.activeByAccount.delete(member.accountId);
      }
      if (ticket.status === 'expired') this.ticketsById.delete(ticketId);
    }
    for (const [poolKey, queue] of this.queues.entries()) {
      this.queues.set(poolKey, queue.filter((id) => this.ticketsById.get(id)?.status === 'queued'));
    }
  }

  pruneTickets() {
    const threshold = Date.now() - 60 * 60 * 1000;
    for (const [id, ticket] of this.ticketsById.entries()) {
      if (Date.parse(ticket.createdAt) < threshold && !['queued', 'matching'].includes(ticket.status)) {
        this.ticketsById.delete(id);
        for (const member of ticket.members) this.activeByAccount.delete(member.accountId);
      }
    }
  }

  publish(accountId, value) {
    for (const socket of this.subscribers.get(accountId) ?? []) {
      if (socket.readyState === 1) socket.send(JSON.stringify(value));
    }
  }

  subscribe(accountId, socket) {
    if (!this.subscribers.has(accountId)) this.subscribers.set(accountId, new Set());
    this.subscribers.get(accountId).add(socket);
    const ticket = this.getTicketByAccount(accountId);
    socket.send(JSON.stringify(ticket ? { type: ticket.status, ticket } : { type: 'idle' }));
    socket.on('close', () => {
      const sockets = this.subscribers.get(accountId);
      sockets?.delete(socket);
      if (sockets?.size === 0) this.subscribers.delete(accountId);
    });
  }

  async waitForMatch(accountId, timeoutMs = 1000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const ticket = this.getTicketByAccount(accountId);
      if (!ticket || !['queued', 'matching'].includes(ticket.status)) return ticket;
      await delay(100);
    }
    return this.getTicketByAccount(accountId);
  }

  stop() {
    clearInterval(this.timeout);
    for (const sockets of this.subscribers.values()) for (const socket of sockets) socket.close();
    this.subscribers.clear();
  }
}
