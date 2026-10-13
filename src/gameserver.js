import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

function matchesSecret(received, expected) {
  const left = Buffer.from(String(received ?? ''));
  const right = Buffer.from(String(expected ?? ''));
  return left.length === right.length && timingSafeEqual(left, right);
}

function verifyJoinTicket(token, sessionKey, sessionId) {
  if (typeof token !== 'string') return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  const expected = createHmac('sha256', sessionKey).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (decoded.sid !== sessionId || decoded.exp <= Date.now()) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function createGameServerApp(config) {
  const app = express();
  const sessions = new Map();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.get('/health', (_request, response) => response.json({ status: 'ok', service: 'ogfn-gameserver-development-adapter', port: config.gameServer.port, activeSessions: sessions.size, protocol: 'http-json-control-and-websocket-simulation' }));
  app.post('/internal/sessions', (request, response) => {
    const supplied = /^Bearer\s+(.+)$/iu.exec(request.get('authorization') ?? '')?.[1];
    if (!matchesSecret(supplied, config.gameServer.internalSecret)) return response.status(401).json({ errorCode: 'gameserver.invalid_internal_token', errorMessage: 'Internal GameServer credential was rejected.' });
    const { sessionId, playlist, region, players, maxPublicPlayers, expiresAt } = request.body ?? {};
    if (typeof sessionId !== 'string' || !/^[A-F0-9]{16,64}$/u.test(sessionId)) return response.status(400).json({ errorCode: 'gameserver.invalid_session_id', errorMessage: 'sessionId must be an uppercase hexadecimal identifier.' });
    if (typeof playlist !== 'string' || !/^[a-z0-9_-]{2,64}$/iu.test(playlist)) return response.status(400).json({ errorCode: 'gameserver.invalid_playlist', errorMessage: 'playlist is invalid.' });
    if (typeof region !== 'string' || !/^[A-Z0-9_-]{2,12}$/u.test(region)) return response.status(400).json({ errorCode: 'gameserver.invalid_region', errorMessage: 'region is invalid.' });
    if (!Array.isArray(players) || players.length < 1 || players.length > Number(maxPublicPlayers)) return response.status(400).json({ errorCode: 'gameserver.invalid_players', errorMessage: 'players must contain at least one and at most maxPublicPlayers entries.' });
    const uniqueAccounts = new Set(players.map((player) => player?.accountId));
    if (uniqueAccounts.size !== players.length || players.some((player) => typeof player?.accountId !== 'string' || typeof player?.joinTicket !== 'string')) return response.status(400).json({ errorCode: 'gameserver.invalid_players', errorMessage: 'Every player must have a unique accountId and a joinTicket.' });
    const max = Number(maxPublicPlayers);
    if (!Number.isInteger(max) || max < players.length || max > Number(config.gameServer.maxPlayers)) return response.status(400).json({ errorCode: 'gameserver.invalid_capacity', errorMessage: 'maxPublicPlayers is outside the configured capacity.' });
    const existing = sessions.get(sessionId);
    if (existing) return response.status(200).json({ session: existing });
    const session = {
      id: sessionId,
      ownerId: players[0].accountId,
      ownerName: String(players[0].displayName ?? 'Player').slice(0, 32),
      serverName: `OGFN ${playlist}`,
      serverAddress: config.gameServer.publicHost,
      serverPort: Number(config.gameServer.port),
      playlist,
      region,
      maxPublicPlayers: max,
      openPublicPlayers: max - players.length,
      maxPrivatePlayers: 0,
      openPrivatePlayers: 0,
      started: false,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      attributes: { GAMEMODE_s: 'FORTATHENA', PLAYLISTNAME_s: playlist, REGION_s: region, MATCHMAKINGPOOL_s: 'Any' },
      players: players.map((player) => ({ accountId: player.accountId, displayName: String(player.displayName ?? 'Player').slice(0, 32), ticketId: player.ticketId, joinTicket: player.joinTicket, joinedAt: null, lastSeenAt: null }))
    };
    sessions.set(sessionId, session);
    return response.status(201).json({ session });
  });
  app.get('/sessions/:sessionId', (request, response) => {
    const session = sessions.get(request.params.sessionId);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) return response.status(404).json({ errorCode: 'gameserver.session_not_found', errorMessage: 'Session not found or expired.' });
    const { players, ...summary } = session;
    return response.json({ session: summary, players: players.map(({ joinTicket: _ticket, ...player }) => player) });
  });
  app.post('/sessions/:sessionId/join', (request, response) => {
    const session = sessions.get(request.params.sessionId);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) return response.status(404).json({ errorCode: 'gameserver.session_not_found', errorMessage: 'Session not found or expired.' });
    const token = request.body?.joinTicket ?? request.get('x-ogfn-join-ticket');
    const decoded = verifyJoinTicket(token, config.matchmaking.sessionKey, session.id);
    if (!decoded) return response.status(401).json({ errorCode: 'gameserver.invalid_join_ticket', errorMessage: 'Join ticket is invalid or expired.' });
    const player = session.players.find((entry) => entry.accountId === decoded.sub);
    if (!player) return response.status(403).json({ errorCode: 'gameserver.player_not_assigned', errorMessage: 'This account is not assigned to this session.' });
    player.joinedAt ??= new Date().toISOString();
    player.lastSeenAt = new Date().toISOString();
    return response.json({ accepted: true, sessionId: session.id, accountId: player.accountId, serverAddress: session.serverAddress, serverPort: session.serverPort, playlist: session.playlist, message: 'Accepted by the local GameServer adapter. This endpoint is not a Fortnite Unreal gameplay protocol.' });
  });
  app.use((error, _request, response, _next) => {
    console.error('[gameserver] request error:', error.message);
    response.status(500).json({ errorCode: 'gameserver.internal_error', errorMessage: 'GameServer adapter encountered an internal error.' });
  });
  return { app, sessions };
}
