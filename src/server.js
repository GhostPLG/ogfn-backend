import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createHandler } from 'graphql-http/lib/use/express';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { JsonStore } from './store.js';
import { AuthService, HttpError, publicAccount } from './auth.js';
import { ProfileService, fullProfileResponse } from './profile.js';
import { NewsService } from './news.js';
import { ShopService } from './shop.js';
import { Matchmaker } from './matchmaker.js';
import { LobbyService } from './lobby.js';
import { createGameServerApp } from './gameserver.js';
import { makeSchema } from './graphql.js';

function jsonError(response, status, code, message, extra = {}) {
  return response.status(status).json({
    errorCode: `ogfn.${code}`,
    errorMessage: message,
    numericErrorCode: status,
    originatingService: 'ogfn-local',
    intent: 'prod',
    ...extra
  });
}

function toStatus(error) {
  return Number.isInteger(error.status) ? error.status : 400;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function redirectAllowlist(config, uri) {
  if (!uri || !config.oauth.redirectUris.includes(uri)) throw new HttpError(400, 'invalid_redirect_uri', 'redirect_uri is not on the local allowlist.');
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new HttpError(400, 'invalid_redirect_uri', 'redirect_uri must be a valid absolute URI.');
  }
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new HttpError(400, 'invalid_redirect_uri', 'HTTP redirect URIs are limited to localhost.');
  }
  return parsed.toString().replace(/\/$/u, uri.endsWith('/') ? '/' : '');
}

function withQuery(uri, values) {
  const target = new URL(uri);
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== '') target.searchParams.set(key, String(value));
  return target.toString();
}

function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/iu.exec(request.get('authorization') ?? '');
  return match?.[1]?.trim() ?? null;
}

function displayNameForAccount(accountId, store) {
  return store.findAccountById(accountId)?.displayName ?? accountId;
}

function makePartyResponse(party, lobby, viewerAccountId = party.leader) {
  const invitations = lobby.getInvitations(viewerAccountId);
  return {
    id: party.id,
    created_at: party.createdAt,
    updated_at: party.updatedAt,
    revision: party.revision,
    config: {
      joinability: party.config.joinability,
      max_size: party.config.maxSize,
      sub_type: 'default',
      invite_ttl: 600,
      join_confirmation: false,
      open_invites: false,
      privacy: {
        partyType: party.config.privacy.partyType,
        inviteRestriction: party.config.privacy.inviteRestriction,
        onlyLeaderFriendsCanJoin: party.config.privacy.onlyLeaderFriendsCanJoin,
        presencePermission: party.config.privacy.presencePermission,
        invitePermission: party.config.privacy.invitePermission
      }
    },
    meta: {
      'Default:PlaylistData_j': JSON.stringify({ playlistName: party.config.playlist, tournamentId: '', eventWindowId: '', linkCode: '' }),
      'Default:Region_s': party.config.region,
      'Default:Joinability': party.config.joinability,
      'Default:PartyTypeId': 'default',
      'Default:GameSessionId_s': party.matchmaking.sessionId ?? '',
      'Default:MatchmakingState_s': party.matchmaking.status
    },
    members: party.members.map((member) => ({
      account_id: member.accountId,
      accountId: member.accountId,
      displayName: member.displayName,
      role: member.role,
      joined_at: member.joinedAt,
      meta: { 'Default:PlatformData_j': '{}', 'Default:ReadyState_s': member.readiness, 'Default:Location_s': 'PreLobby' },
      connections: []
    })),
    invites: invitations,
    matchmaking: structuredClone(party.matchmaking)
  };
}

export async function createBackend(config) {
  const store = await new JsonStore(config.dataDir).init();
  const auth = new AuthService({ store, config });
  const profile = new ProfileService({ store, config });
  const news = await new NewsService(config.newsFile).init();
  const shop = await new ShopService({ file: config.shopFile, store }).init();
  const lobby = new LobbyService({ store });
  const services = { store, auth, profile, news, shop, lobby, matchmaker: null };
  const authCleanupTimer = setInterval(() => {
    void auth.cleanup().catch((error) => console.error('[auth] cleanup failed:', error.message));
  }, 60_000);
  authCleanupTimer.unref?.();
  const matchmaker = new Matchmaker({ store, config, gameServer: config.gameServer });
  services.matchmaker = matchmaker;
  services.enqueueMatchmaking = async (account, requested = {}) => {
    const party = lobby.getForAccount(account.id);
    let members = [account];
    const options = { ...requested };
    if (party) {
      options.playlist ??= party.config.playlist;
      options.region ??= party.config.region;
      if (party.members.length > 1) {
        if (party.leader !== account.id) throw new HttpError(403, 'party_leader_required', 'Only the lobby leader may start matchmaking for this party.');
        members = party.members.map((member) => store.findAccountById(member.accountId)).filter(Boolean);
      }
    }
    const ticket = await matchmaker.enqueueGroup(members, options);
    for (const member of members) lobby.setMatchmaking(member.id, ticket);
    return ticket;
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors({ origin: config.server.allowedOrigins.includes('*') ? true : config.server.allowedOrigins, credentials: false, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type', 'X-EpicGames-Language', 'X-EpicGames-ProfileRevisions', 'X-Ogfn-Join-Ticket'] }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  const authenticate = async (request, response, next) => {
    try {
      request.auth = await auth.authenticateHeader(request.get('authorization'));
      next();
    } catch (error) {
      jsonError(response, toStatus(error), error.code ?? 'authentication_required', error.message);
    }
  };
  const requireAccount = (request, response) => {
    if (!request.auth?.account) {
      jsonError(response, 401, 'player_token_required', 'A player access token is required for this operation.');
      return null;
    }
    return request.auth.account;
  };
  const accountOwnsPath = (request, response, accountId) => {
    const account = requireAccount(request, response);
    if (!account) return false;
    if (account.id !== accountId) {
      jsonError(response, 403, 'account_mismatch', 'The authenticated account does not match the requested account.');
      return false;
    }
    return true;
  };

  app.get('/', (_request, response) => response.json({ name: 'OGFN local backend', version: '1.0.0', status: 'ok', api: '/graphql', health: '/health' }));
  app.get('/health', (_request, response) => response.json({ status: 'ok', service: 'ogfn-backend', port: config.server.port, gameserverAdapter: config.gameServer.adapterEnabled, storage: 'json' }));

  app.post('/api/accounts', async (request, response) => {
    try {
      const account = await auth.register(request.body ?? {});
      response.status(201).json(account);
    } catch (error) {
      jsonError(response, toStatus(error), error.code ?? 'account_creation_failed', error.message);
    }
  });

  app.get('/account/api/oauth/authorize', async (request, response) => {
    try {
      const client = auth.validateClient({ client_id: request.query.client_id });
      if (request.query.response_type !== 'code') throw new HttpError(400, 'unsupported_response_type', 'Only response_type=code is supported.');
      const redirectUri = redirectAllowlist(config, String(request.query.redirect_uri ?? ''));
      const scope = String(request.query.scope ?? 'basic_profile').split(/[\s,]+/u).filter(Boolean);
      const codeChallenge = request.query.code_challenge ? String(request.query.code_challenge) : null;
      const method = String(request.query.code_challenge_method ?? (codeChallenge ? 'plain' : 'plain'));
      if (codeChallenge && !['plain', 'S256'].includes(method)) throw new HttpError(400, 'invalid_request', 'PKCE method must be plain or S256.');
      if (method === 'S256' && (!codeChallenge || !/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge))) throw new HttpError(400, 'invalid_request', 'S256 code_challenge must be a 43-character base64url digest.');
      const transactionId = randomUUID();
      const expiresAt = new Date(Date.now() + Number(config.oauth.authorizationCodeSeconds) * 1000).toISOString();
      await store.update((state) => {
        state.auth.transactions[transactionId] = {
          clientId: client.clientId,
          redirectUri,
          scope,
          state: String(request.query.state ?? ''),
          codeChallenge,
          codeChallengeMethod: method,
          expiresAt
        };
        return true;
      });
      response.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OGFN local sign-in</title><body><main><h1>Sign in to the local OGFN server</h1><p>Use the account created on this backend. Credentials are sent only to this local server.</p><form method="post" action="/account/api/oauth/authorize"><input type="hidden" name="transaction_id" value="${escapeHtml(transactionId)}"><label>Username/email <input name="username" autocomplete="username" required></label><br><label>Password <input type="password" name="password" autocomplete="current-password" required></label><br><button type="submit">Sign in</button></form></main></body></html>`);
    } catch (error) {
      jsonError(response, toStatus(error), error.code ?? 'invalid_authorize_request', error.message);
    }
  });

  app.post('/account/api/oauth/authorize', async (request, response) => {
    const { transaction_id: transactionId, username, password } = request.body ?? {};
    try {
      let transaction = store.snapshot().auth.transactions[String(transactionId ?? '')];
      if (!transaction || Date.parse(transaction.expiresAt) <= Date.now()) throw new HttpError(400, 'invalid_transaction', 'Authorization transaction is invalid or expired.');
      const account = await auth.authenticatePassword(username, password, request.ip ?? 'local');
      await store.update((state) => {
        transaction = state.auth.transactions[String(transactionId)];
        if (!transaction || Date.parse(transaction.expiresAt) <= Date.now()) throw new HttpError(400, 'invalid_transaction', 'Authorization transaction is invalid or expired.');
        delete state.auth.transactions[String(transactionId)];
        return true;
      });
      const code = await auth.issueAuthorizationCode({
        accountId: account.id,
        clientId: transaction.clientId,
        redirectUri: transaction.redirectUri,
        scope: transaction.scope,
        codeChallenge: transaction.codeChallenge,
        codeChallengeMethod: transaction.codeChallengeMethod
      });
      const target = withQuery(transaction.redirectUri, { code, state: transaction.state });
      if (request.accepts('html')) return response.redirect(302, target);
      return response.json({ code, state: transaction.state, redirect_uri: target });
    } catch (error) {
      const status = toStatus(error);
      if (request.accepts('html')) return response.status(status).type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign-in failed</title><body><main><h1>Sign-in failed</h1><p>${escapeHtml(error.message)}</p><a href="javascript:history.back()">Go back</a></main></body></html>`);
      return jsonError(response, status, error.code ?? 'authorization_failed', error.message);
    }
  });

  app.post('/account/api/oauth/token', async (request, response) => {
    const body = request.body ?? {};
    try {
      const { clientId, authenticatedClient } = auth.validateClient({ client_id: body.client_id, client_secret: body.client_secret, authorization: request.get('authorization') });
      const grantType = String(body.grant_type ?? '');
      if (grantType === 'client_credentials' && !authenticatedClient) throw new HttpError(401, 'invalid_client', 'client_credentials requires the configured client secret.');
      let token;
      if (grantType === 'client_credentials') {
        token = await auth.issueToken(null, { clientId, scope: body.scope ?? ['basic_profile'], allowRefresh: false });
      } else if (grantType === 'password') {
        if (!config.oauth.allowPasswordGrant) throw new HttpError(400, 'unsupported_grant_type', 'Password grant is disabled. Use authorization_code with PKCE.');
        const username = body.username ?? body.email ?? body.account_id;
        const account = await auth.authenticatePassword(username, body.password, request.ip ?? 'local');
        token = await auth.issueToken(account.id, { clientId, scope: body.scope ?? ['basic_profile'] });
      } else if (grantType === 'authorization_code') {
        const redeemed = await auth.consumeAuthorizationCode(body.code, { clientId, redirectUri: redirectAllowlist(config, body.redirect_uri), codeVerifier: body.code_verifier });
        token = await auth.issueToken(redeemed.accountId, { clientId, scope: redeemed.scope });
      } else if (grantType === 'exchange_code') {
        const accountId = await auth.consumeExchangeCode(body.exchange_code ?? body.code);
        token = await auth.issueToken(accountId, { clientId, scope: body.scope ?? ['basic_profile'] });
      } else if (grantType === 'refresh_token') {
        token = await auth.refresh(body.refresh_token, clientId);
      } else if (grantType === 'device_auth') {
        const account = await auth.authenticateDevice(body.device_id ?? body.deviceId, body.secret ?? body.device_secret);
        token = await auth.issueToken(account.id, { clientId, scope: body.scope ?? ['basic_profile'] });
      } else {
        throw new HttpError(400, 'unsupported_grant_type', 'Supported grant_type values: authorization_code, password, client_credentials, exchange_code, refresh_token, device_auth.');
      }
      response.set('Cache-Control', 'no-store');
      response.set('Pragma', 'no-cache');
      return response.json(token);
    } catch (error) {
      return jsonError(response, toStatus(error), error.code ?? 'invalid_grant', error.message);
    }
  });

  app.get('/account/api/oauth/verify', authenticate, (request, response) => {
    const entry = request.auth;
    response.set('Cache-Control', 'no-store').json({
      token: bearerToken(request),
      session_id: randomUUID().replaceAll('-', ''),
      token_type: 'bearer',
      client_id: entry.clientId,
      internal_client: config.oauth.internalClient,
      client_service: config.oauth.clientService,
      scope: entry.scope,
      account_id: entry.accountId ?? undefined,
      displayName: entry.account?.displayName,
      app: config.oauth.productId,
      in_app_id: entry.accountId ?? undefined,
      expires_at: entry.expiresAt,
      expires_in: Math.max(0, Math.floor((Date.parse(entry.expiresAt) - Date.now()) / 1000))
    });
  });

  app.get('/account/api/oauth/exchange', authenticate, async (request, response) => {
    try {
      if (!request.auth.account) throw new HttpError(400, 'player_token_required', 'Exchange codes require a player token.');
      const result = await auth.issueExchangeCode(request.auth.account.id);
      response.set('Cache-Control', 'no-store').json({ code: result.code, expiresInSeconds: config.oauth.exchangeCodeSeconds, expires_at: result.expiresAt });
    } catch (error) {
      jsonError(response, toStatus(error), error.code ?? 'exchange_failed', error.message);
    }
  });

  app.post('/account/api/oauth/revoke', async (request, response) => {
    await auth.revokeAccessToken(request.get('authorization'));
    response.status(204).end();
  });

  app.post('/account/api/oauth/deviceAuth', authenticate, async (request, response) => {
    try {
      const account = requireAccount(request, response);
      if (!account) return;
      const device = await auth.createDeviceAuth(account.id, request.get('user-agent'));
      response.status(201).json(device);
    } catch (error) {
      jsonError(response, toStatus(error), error.code ?? 'device_auth_failed', error.message);
    }
  });

  app.delete('/account/api/oauth/deviceAuth/:accountId/:deviceId', authenticate, async (request, response) => {
    if (!accountOwnsPath(request, response, request.params.accountId)) return;
    const removed = await auth.deleteDeviceAuth(request.auth.account.id, request.params.deviceId);
    if (!removed) return jsonError(response, 404, 'device_auth_not_found', 'Device auth was not found.');
    return response.status(204).end();
  });

  app.get('/account/api/public/account/:accountId', authenticate, (request, response) => {
    const account = store.findAccountById(request.params.accountId);
    if (!account) return jsonError(response, 404, 'account_not_found', 'Account was not found.');
    const summary = publicAccount(account);
    delete summary.email;
    return response.json(summary);
  });

  app.get('/account/api/public/account', authenticate, (request, response) => {
    const ids = String(request.query.accountId ?? '').split(',').filter(Boolean).slice(0, 100);
    return response.json(ids.map((id) => store.findAccountById(id)).filter(Boolean).map((account) => {
      const summary = publicAccount(account);
      delete summary.email;
      return summary;
    }));
  });

  app.get('/fortnite/api/v2/fortnite/br-news', (_request, response) => response.json(news.getNews('br')));
  app.get('/fortnite/api/v2/fortnite/stw-news', (_request, response) => response.json(news.getNews('stw')));
  app.get('/fortnite/api/BRDynamicNews', (_request, response) => response.json(news.getNews('br')));
  app.get('/fortnite/api/fortnite-br/surfaces/:surface/target', (request, response) => response.json(news.getNews(request.params.surface.includes('stw') ? 'stw' : 'br')));
  app.get('/fortnite/api/fortnite-br/surfaces/:surface/target/:locale', (request, response) => response.json(news.getNews(request.params.surface.includes('stw') ? 'stw' : 'br')));
  app.get('/fortnite/api/game/v2/world/info', (_request, response) => response.json({ worldInfo: { worldId: 'Fortnite', season: 1, seasonNumber: 1, seasonTemplateId: 'AthenaSeason:season1', matchEndRewards: [], eventFlags: [] } }));
  app.get('/api/news', (_request, response) => response.json(news.getAll()));

  app.get('/fortnite/api/storefront/v2/catalog', (_request, response) => response.json(shop.storefrontResponse()));
  app.get('/fortnite/api/storefront/v2/keychain', (_request, response) => response.json([]));
  app.get('/api/shop', (_request, response) => response.json({ storefront: shop.storefrontResponse(), offers: shop.getOffers() }));
  app.get('/api/shop/balance', authenticate, (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    response.json({ accountId: account.id, balance: shop.getBalance(account.id) });
  });
  app.post('/api/shop/purchase', authenticate, async (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    try {
      return response.json(await shop.buy(account.id, String(request.body?.offerId ?? '')));
    } catch (error) {
      return jsonError(response, toStatus(error), error.code ?? 'purchase_failed', error.message, { balance: error.balance, price: error.price });
    }
  });

  const profileHandler = async (request, response) => {
    const accountId = request.params.accountId;
    if (!accountOwnsPath(request, response, accountId)) return;
    const operation = String(request.params.operation ?? 'QueryProfile');
    const profileId = String(request.query.profileId ?? 'athena');
    if (operation.toLowerCase() === 'purchasecatalogentry') {
      try {
        const purchase = await shop.buy(accountId, String(request.body?.offerId ?? ''));
        const athena = profile.get(accountId, 'athena');
        const core = profile.get(accountId, 'common_core');
        return response.json({
          profileRevision: athena.rvn,
          profileId: 'athena',
          profileChangesBaseRevision: athena.rvn - 1,
          profileChanges: [{ changeType: 'fullProfileUpdate', profile: athena }],
          notifications: [{ type: 'CatalogPurchase', primary: true, purchaseId: purchase.purchaseId, offerId: purchase.offerId, totalMtxPaid: purchase.price, items: purchase.itemGrants }],
          common_core: fullProfileResponse(core),
          commandRevision: athena.commandRevision,
          serverTime: new Date().toISOString(),
          multiUpdate: [],
          responseVersion: 1
        });
      } catch (error) {
        return jsonError(response, toStatus(error), error.code ?? 'purchase_failed', error.message, { balance: error.balance, price: error.price });
      }
    }
    try {
      const result = await profile.command(accountId, profileId, operation, request.body ?? {});
      return response.status(result.status).json(result.body);
    } catch (error) {
      return jsonError(response, toStatus(error), error.code ?? 'profile_operation_failed', error.message, { profileId, operation });
    }
  };
  app.post('/fortnite/api/game/v2/profile/:accountId/client/:operation', authenticate, profileHandler);
  app.post('/fortnite/api/game/v2/profile/:accountId/public/:operation', authenticate, profileHandler);
  app.get('/api/profile/:profileId', authenticate, (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    const result = profile.get(account.id, request.params.profileId);
    if (!result) return jsonError(response, 404, 'profile_not_found', 'Profile was not found.');
    return response.json(result);
  });

  app.get('/api/lobby', authenticate, (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    const party = lobby.getOrCreate(account);
    return response.json(makePartyResponse(party, lobby));
  });
  app.post('/party/api/v1/Fortnite/parties', authenticate, (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    return response.status(201).json(makePartyResponse(lobby.getOrCreate(account), lobby));
  });
  app.get('/party/api/v1/Fortnite/user/:accountId', authenticate, (request, response) => {
    if (!accountOwnsPath(request, response, request.params.accountId)) return;
    const party = lobby.getOrCreate(request.auth.account);
    return response.json({ current: [makePartyResponse(party, lobby, request.auth.account.id)], invites: lobby.getInvitations(request.auth.account.id) });
  });
  app.get('/party/api/v1/Fortnite/parties/:partyId', authenticate, (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    try {
      const party = lobby.requireMember(request.params.partyId, account.id);
      return response.json(makePartyResponse(party, lobby));
    } catch (error) {
      return jsonError(response, toStatus(error), error.code ?? 'party_not_found', error.message);
    }
  });
  app.get('/party/api/v1/Fortnite/parties/:partyId/members', authenticate, (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    try {
      return response.json(makePartyResponse(lobby.requireMember(request.params.partyId, account.id), lobby).members);
    } catch (error) {
      return jsonError(response, toStatus(error), error.code ?? 'party_not_found', error.message);
    }
  });
  app.patch('/party/api/v1/Fortnite/parties/:partyId', authenticate, (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    try {
      const body = request.body ?? {};
      const configInput = body.config ?? body;
      const meta = body.meta ?? {};
      const parsedPlaylist = typeof meta['Default:PlaylistData_j'] === 'string' ? JSON.parse(meta['Default:PlaylistData_j']) : {};
      const party = lobby.updateConfig(request.params.partyId, account.id, {
        ...configInput,
        playlist: configInput.playlist ?? parsedPlaylist.playlistName,
        region: configInput.region ?? meta['Default:Region_s']
      });
      return response.json(makePartyResponse(party, lobby));
    } catch (error) {
      return jsonError(response, toStatus(error), error.code ?? 'party_update_failed', error.message);
    }
  });
  app.post('/party/api/v1/Fortnite/parties/:partyId/invites/:accountId', authenticate, (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    try {
      return response.status(201).json(lobby.invite(request.params.partyId, account.id, request.params.accountId));
    } catch (error) {
      return jsonError(response, toStatus(error), error.code ?? 'party_invite_failed', error.message);
    }
  });
  app.post('/party/api/v1/Fortnite/parties/:partyId/members/:accountId', authenticate, (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    if (request.params.accountId !== account.id) return jsonError(response, 403, 'account_mismatch', 'You may only join the lobby as the authenticated account.');
    try {
      return response.json(makePartyResponse(lobby.join(request.params.partyId, account), lobby));
    } catch (error) {
      return jsonError(response, toStatus(error), error.code ?? 'party_join_failed', error.message);
    }
  });
  app.delete('/party/api/v1/Fortnite/parties/:partyId/members/:accountId', authenticate, (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    if (request.params.accountId !== account.id) return jsonError(response, 403, 'account_mismatch', 'You may only leave the lobby as the authenticated account.');
    const left = lobby.leave(request.params.partyId, account.id);
    return left ? response.status(204).end() : jsonError(response, 404, 'party_not_found', 'Lobby party was not found.');
  });
  app.post('/api/lobby/:partyId/invite/:accountId', authenticate, (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    try {
      return response.status(201).json(lobby.invite(request.params.partyId, account.id, request.params.accountId));
    } catch (error) {
      return jsonError(response, toStatus(error), error.code ?? 'party_invite_failed', error.message);
    }
  });

  app.post('/api/matchmaking/queue', authenticate, async (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    try {
      const ticket = await services.enqueueMatchmaking(account, { playlist: request.body?.playlist, region: request.body?.region });
      return response.status(ticket.status === 'matched' ? 201 : 202).json(matchmaker.getTicketById(ticket.ticketId, account.id));
    } catch (error) {
      return jsonError(response, toStatus(error), error.code ?? 'matchmaking_failed', error.message);
    }
  });
  app.get('/api/matchmaking/queue', authenticate, (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    const ticket = matchmaker.getTicketByAccount(account.id);
    if (!ticket) return response.status(204).end();
    return response.json(ticket);
  });
  app.delete('/api/matchmaking/queue', authenticate, async (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    const cancelled = await matchmaker.leave(account.id);
    if (cancelled) {
      const party = lobby.getForAccount(account.id);
      for (const member of party?.members ?? []) lobby.setMatchmaking(member.accountId, null);
      if (!party) lobby.setMatchmaking(account.id, null);
    }
    return response.json({ cancelled });
  });
  app.post('/fortnite/api/matchmaking/session/matchMakingRequest', authenticate, async (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    try {
      const payload = Array.isArray(request.body) ? request.body[0] ?? {} : request.body ?? {};
      const playlist = request.query.playlist ?? payload.playlist ?? payload.playlistName;
      const region = request.query.region ?? payload.region;
      const ticket = await services.enqueueMatchmaking(account, { playlist, region });
      return response.json(matchmaker.getTicketById(ticket.ticketId, account.id));
    } catch (error) {
      return jsonError(response, toStatus(error), error.code ?? 'matchmaking_failed', error.message);
    }
  });
  app.get('/fortnite/api/matchmaking/session/:sessionId', authenticate, (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    const session = matchmaker.sessionForAccount(account.id, request.params.sessionId);
    if (!session) return jsonError(response, 404, 'session_not_found', 'Match session not found for this account.');
    return response.json({
      id: session.id,
      ownerId: session.ownerId,
      ownerName: session.ownerName,
      serverName: `OGFN ${session.playlist}`,
      serverAddress: session.serverAddress,
      serverPort: session.serverPort,
      maxPublicPlayers: session.maxPublicPlayers,
      openPublicPlayers: session.openPublicPlayers,
      maxPrivatePlayers: 0,
      openPrivatePlayers: 0,
      attributes: { REGION_s: session.region, GAMEMODE_s: 'FORTATHENA', PLAYLISTNAME_s: session.playlist, MATCHMAKINGPOOL_s: 'Any', ...session.attributes },
      publicPlayers: session.players.map((player) => ({ playerId: player.accountId, displayName: displayNameForAccount(player.accountId, store), teamId: 1, squadId: 1, isReady: true })),
      privatePlayers: [],
      totalPlayers: session.players.length,
      allowJoinInProgress: true,
      shouldAdvertise: true,
      started: session.started,
      lastUpdated: new Date().toISOString()
    });
  });
  app.post('/fortnite/api/matchmaking/session/:sessionId/join', authenticate, async (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    const session = matchmaker.sessionForAccount(account.id, request.params.sessionId);
    if (!session) return jsonError(response, 404, 'session_not_found', 'Match session not found for this account.');
    const currentTicket = matchmaker.getTicketByAccount(account.id);
    const joinTicket = request.body?.joinTicket ?? request.get('x-ogfn-join-ticket') ?? currentTicket?.joinTicket;
    try {
      const gsResponse = await fetch(`${config.gameServer.controlUrl.replace(/\/$/u, '')}/sessions/${encodeURIComponent(session.id)}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ joinTicket }),
        signal: AbortSignal.timeout(5000)
      });
      const result = await gsResponse.json().catch(() => null);
      if (!gsResponse.ok) return jsonError(response, gsResponse.status, result?.errorCode ?? 'gameserver_join_failed', result?.errorMessage ?? 'GameServer rejected the join request.');
      return response.status(204).end();
    } catch (error) {
      return jsonError(response, 503, 'gameserver_unavailable', `Cannot reach the local GameServer adapter: ${error.message}`);
    }
  });
  app.delete('/fortnite/api/matchmaking/session/:sessionId', authenticate, async (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    const session = matchmaker.sessionForAccount(account.id, request.params.sessionId);
    if (!session) return jsonError(response, 404, 'session_not_found', 'Match session not found for this account.');
    const memberTickets = [...new Set(session.players.map((player) => matchmaker.getTicketByAccount(player.accountId)?.ticketId).filter(Boolean))];
    for (const ticketId of memberTickets) {
      const ticket = matchmaker.ticketsById.get(ticketId);
      for (const member of ticket?.members ?? []) {
        matchmaker.activeByAccount.delete(member.accountId);
        lobby.setMatchmaking(member.accountId, null);
      }
    }
    return response.status(204).end();
  });
  app.get('/fortnite/api/game/v2/matchmaking/account/:accountId/session/:sessionId', authenticate, (request, response) => {
    if (!accountOwnsPath(request, response, request.params.accountId)) return;
    const session = matchmaker.sessionForAccount(request.params.accountId, request.params.sessionId);
    const ticket = matchmaker.getTicketByAccount(request.params.accountId);
    if (!session || !ticket?.joinTicket) return jsonError(response, 404, 'session_not_found', 'Match session assignment not found.');
    return response.json({ accountId: request.params.accountId, sessionId: request.params.sessionId, key: ticket.joinTicket, region: session.region, playlist: session.playlist, serverAddress: session.serverAddress, serverPort: session.serverPort });
  });
  app.get('/api/matchmaking/session/:sessionId', authenticate, (request, response) => {
    const account = requireAccount(request, response);
    if (!account) return;
    const session = matchmaker.sessionForAccount(account.id, request.params.sessionId);
    if (!session) return jsonError(response, 404, 'session_not_found', 'Match session not found for this account.');
    return response.json(matchmaker.publicSession(session));
  });

  const schema = makeSchema(services);
  app.all('/graphql', createHandler({
    schema,
    context: async (request) => {
      try {
        const authorization = request.raw.headers.authorization;
        return { auth: authorization ? await auth.authenticateHeader(authorization) : null, services };
      } catch {
        return { auth: null, services };
      }
    }
  }));

  app.use((request, response) => jsonError(response, 404, 'not_found', `No route for ${request.method} ${request.path}.`));
  app.use((error, _request, response, _next) => {
    console.error('[backend] request error:', error.message);
    return jsonError(response, 500, 'internal_error', 'The backend encountered an internal error.');
  });

  const gameServer = config.gameServer.adapterEnabled ? createGameServerApp(config) : null;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  async function handleUpgrade(request, socket, head) {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/matchmaker/ws') {
      socket.destroy();
      return;
    }
    try {
      const token = /^Bearer\s+(.+)$/iu.exec(request.headers.authorization ?? '')?.[1] ?? url.searchParams.get('access_token');
      const playerAuth = await auth.authenticateHeader(token ? `Bearer ${token}` : '');
      if (!playerAuth.account) throw new Error('A player token is required.');
      wss.handleUpgrade(request, socket, head, (websocket) => matchmaker.subscribe(playerAuth.account.id, websocket));
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  }

  return { app, services, gameServer, wss, authCleanupTimer, handleUpgrade };
}
