import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { JsonStore } from '../src/store.js';
import { AuthService } from '../src/auth.js';
import { ProfileService, DEFAULT_COSMETIC_IDS } from '../src/profile.js';
import { ShopService } from '../src/shop.js';
import { createBackend } from '../src/server.js';

let temporaryDirectory;
let config;
let store;
let auth;
let profile;
let shop;
let backend;
let server;
let baseUrl;

async function createAccount(name, email = `${name.toLowerCase()}@test.local`) {
  const account = await auth.register({ email, displayName: name, password: 'valid-local-password-001' });
  return account;
}

async function getToken(email = 'alpha@test.local') {
  const params = new URLSearchParams({ grant_type: 'password', username: email, password: 'valid-local-password-001' });
  const response = await fetch(`${baseUrl}/account/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${config.oauth.clientId}:${config.oauth.clientSecret}`).toString('base64')}` },
    body: params
  });
  assert.equal(response.status, 200);
  return (await response.json()).access_token;
}

test.before(async () => {
  config = await loadConfig();
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ogfn-test-'));
  config.dataDir = temporaryDirectory;
  config.server.port = 0;
  config.server.host = '127.0.0.1';
  config.gameServer.adapterEnabled = true;
  config.gameServer.bindHost = '127.0.0.1';
  config.gameServer.publicHost = '127.0.0.1';
  config.gameServer.port = 0;
  config.gameServer.controlUrl = 'http://127.0.0.1:0';
  config.matchmaking.minPlayers = 1;
  config.store.startingVbucks = 1000;
  config.oauth.clientSecret = 'test-client-secret-which-is-long-enough';
  config.gameServer.internalSecret = 'test-gameserver-secret-which-is-long-enough';
  config.matchmaking.sessionKey = 'test-session-key-which-is-long-enough';
  store = await new JsonStore(temporaryDirectory).init();
  auth = new AuthService({ store, config });
  profile = new ProfileService({ store, config });
  shop = await new ShopService({ file: config.shopFile, store }).init();
  const alpha = await createAccount('Alpha', 'alpha@test.local');
  assert.ok(alpha.id);
  backend = await createBackend(config);
  store = backend.services.store;
  auth = backend.services.auth;
  profile = backend.services.profile;
  shop = backend.services.shop;
  server = backend.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const gsServer = backend.gameServer.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => gsServer.once('listening', resolve));
  backend.gameServer.httpServer = gsServer;
  config.gameServer.port = gsServer.address().port;
  config.gameServer.controlUrl = `http://127.0.0.1:${gsServer.address().port}`;
});

test.after(async () => {
  backend?.services.matchmaker.stop();
  if (backend?.authCleanupTimer) clearInterval(backend.authCleanupTimer);
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (backend?.gameServer?.httpServer?.listening) await new Promise((resolve) => backend.gameServer.httpServer.close(resolve));
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

test('new account starts with only the standard pickaxe, glider, and dance in Athena', async () => {
  const result = profile.get(store.state.accounts[0].id, 'athena');
  const cosmeticKeys = Object.keys(result.items).filter((key) => key !== 'sandbox_loadout');
  assert.deepEqual(cosmeticKeys.sort(), [...DEFAULT_COSMETIC_IDS].sort());
  assert.deepEqual(result.items.sandbox_loadout.attributes.locker_slots_data.slots.Pickaxe.items, ['AthenaPickaxe:DefaultPickaxe']);
  assert.deepEqual(result.items.sandbox_loadout.attributes.locker_slots_data.slots.Glider.items, ['AthenaGlider:DefaultGlider']);
  assert.equal(result.items.sandbox_loadout.attributes.locker_slots_data.slots.Dance.items[0], 'AthenaDance:EID_DanceMoves');
});

test('password token grant and verify return local account', async () => {
  const token = await getToken();
  const response = await fetch(`${baseUrl}/account/api/oauth/verify`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).account_id, store.state.accounts[0].id);
});

test('authorization-code OAuth enforces PKCE and redeems the code once', async () => {
  const verifier = 'v'.repeat(43);
  const challenge = (await import('node:crypto')).createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = 'http://localhost:8080/callback';
  const authorizeUrl = new URL(`${baseUrl}/account/api/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', config.oauth.clientId);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', 'basic_profile');
  authorizeUrl.searchParams.set('state', 'test-state');
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  const authorize = await fetch(authorizeUrl, { headers: { accept: 'text/html' } });
  assert.equal(authorize.status, 200);
  const html = await authorize.text();
  const transactionId = /name="transaction_id" value="([^"]+)"/u.exec(html)?.[1];
  assert.ok(transactionId);
  const login = await fetch(`${baseUrl}/account/api/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ transaction_id: transactionId, username: 'alpha@test.local', password: 'valid-local-password-001' })
  });
  assert.equal(login.status, 200);
  const { code, state } = await login.json();
  assert.equal(state, 'test-state');
  const redeem = await fetch(`${baseUrl}/account/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.oauth.clientId, code, redirect_uri: redirectUri, code_verifier: verifier })
  });
  assert.equal(redeem.status, 200);
  const token = await redeem.json();
  assert.ok(token.access_token);
  const secondRedeem = await fetch(`${baseUrl}/account/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.oauth.clientId, code, redirect_uri: redirectUri, code_verifier: verifier })
  });
  assert.equal(secondRedeem.status, 400);
});

test('OAuth rotates refresh tokens and supports exchange-code and device auth', async () => {
  const initial = await fetch(`${baseUrl}/account/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${config.oauth.clientId}:${config.oauth.clientSecret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'password', username: 'alpha@test.local', password: 'valid-local-password-001' })
  });
  assert.equal(initial.status, 200);
  const initialTokens = await initial.json();
  const refreshResponse = await fetch(`${baseUrl}/account/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: config.oauth.clientId, refresh_token: initialTokens.refresh_token })
  });
  assert.equal(refreshResponse.status, 200);
  const refreshed = await refreshResponse.json();
  assert.notEqual(refreshed.refresh_token, initialTokens.refresh_token);
  const reusedRefresh = await fetch(`${baseUrl}/account/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: config.oauth.clientId, refresh_token: initialTokens.refresh_token })
  });
  assert.equal(reusedRefresh.status, 400);

  const exchangeSource = await fetch(`${baseUrl}/account/api/oauth/exchange`, { headers: { authorization: `Bearer ${refreshed.access_token}` } });
  assert.equal(exchangeSource.status, 200);
  const exchange = await exchangeSource.json();
  const exchangedResponse = await fetch(`${baseUrl}/account/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'exchange_code', client_id: config.oauth.clientId, exchange_code: exchange.code })
  });
  assert.equal(exchangedResponse.status, 200);
  const exchanged = await exchangedResponse.json();

  const deviceResponse = await fetch(`${baseUrl}/account/api/oauth/deviceAuth`, { method: 'POST', headers: { authorization: `Bearer ${exchanged.access_token}` } });
  assert.equal(deviceResponse.status, 201);
  const device = await deviceResponse.json();
  const deviceTokenResponse = await fetch(`${baseUrl}/account/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'device_auth', client_id: config.oauth.clientId, device_id: device.deviceId, secret: device.secret })
  });
  assert.equal(deviceTokenResponse.status, 200);
  assert.equal((await deviceTokenResponse.json()).account_id, initialTokens.account_id);
});

test('profile endpoint returns full Athena profile and blocks Save the World safely', async () => {
  const token = await getToken();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const accountId = store.state.accounts[0].id;
  const query = await fetch(`${baseUrl}/fortnite/api/game/v2/profile/${accountId}/client/QueryProfile?profileId=athena`, { method: 'POST', headers, body: '{}' });
  assert.equal(query.status, 200);
  const result = await query.json();
  assert.equal(result.profileChanges[0].profile.profileId, 'athena');
  const stw = await fetch(`${baseUrl}/fortnite/api/game/v2/profile/${accountId}/client/QueryProfile?profileId=campaign`, { method: 'POST', headers, body: '{}' });
  assert.equal(stw.status, 403);
  assert.equal((await stw.json()).errorCode, 'fortnite.game.profile.SaveTheWorldAccessRequired');
  const queue = await fetch(`${baseUrl}/api/matchmaking/queue`, { method: 'POST', headers, body: JSON.stringify({ playlist: 'Playlist_STW' }) });
  assert.equal(queue.status, 403);
});

test('news route returns configured motd and visible banner', async () => {
  const response = await fetch(`${baseUrl}/fortnite/api/v2/fortnite/br-news`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.news.motds.some((motd) => motd.id === 'ogfn-welcome'));
  assert.ok(body.battleroyalenews.motds.some((motd) => motd.id === 'ogfn-welcome'));
  assert.ok(body.banners.some((banner) => banner.id === 'ogfn-local-banner'));
});

test('purchase offer is charged atomically and grants item', async () => {
  const accountId = store.state.accounts[0].id;
  const purchase = await shop.buy(accountId, 'ogfn-outfit-001');
  assert.equal(purchase.price, 800);
  assert.equal(shop.getBalance(accountId), 200);
  assert.ok(profile.get(accountId, 'athena').items['AthenaCharacter:CID_001_Athena_Commando_F_Default']);
});

test('party requires invitation and accepts the invite', async () => {
  const alpha = await backend.services.auth.register({ email: 'party-leader@test.local', displayName: 'PartyLead', password: 'valid-local-password-001' });
  const beta = await backend.services.auth.register({ email: 'party-member@test.local', displayName: 'PartyMate', password: 'valid-local-password-001' });
  const party = backend.services.lobby.getOrCreate(alpha);
  backend.services.lobby.invite(party.id, alpha.id, beta.id);
  const joined = backend.services.lobby.join(party.id, beta);
  assert.equal(joined.members.length, 2);
  assert.equal(joined.leader, alpha.id);
});

test('matchmaking creates a signed session on the GameServer adapter', async () => {
  const account = await backend.services.auth.register({ email: 'solo-match@test.local', displayName: 'SoloMatch', password: 'valid-local-password-001' });
  const ticket = await backend.services.matchmaker.enqueue(account, { playlist: 'Playlist_TestSolo', region: 'EU' });
  assert.equal(ticket.status, 'matched');
  assert.equal(ticket.session.serverPort, config.gameServer.port);
  assert.ok(backend.services.matchmaker.verifyTicket(ticket.joinTicket));
  const join = await fetch(`${config.gameServer.controlUrl}/sessions/${ticket.session.id}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ joinTicket: ticket.joinTicket })
  });
  assert.equal(join.status, 200);
  assert.equal((await join.json()).accepted, true);
});

test('matchmaking fill window groups separate queue arrivals into one session', async () => {
  const first = await backend.services.auth.register({ email: 'fill-one@test.local', displayName: 'FillOne', password: 'valid-local-password-001' });
  const second = await backend.services.auth.register({ email: 'fill-two@test.local', displayName: 'FillTwo', password: 'valid-local-password-001' });
  config.matchmaking.minPlayers = 2;
  try {
    const [firstTicket, secondTicket] = await Promise.all([
      backend.services.matchmaker.enqueue(first, { playlist: 'Playlist_FillTest', region: 'EU' }),
      backend.services.matchmaker.enqueue(second, { playlist: 'Playlist_FillTest', region: 'EU' })
    ]);
    assert.equal(firstTicket.status, 'matched');
    assert.equal(secondTicket.status, 'matched');
    assert.equal(firstTicket.session.id, secondTicket.session.id);
    assert.equal(firstTicket.session.openPublicPlayers, config.gameServer.maxPlayers - 2);
  } finally {
    config.matchmaking.minPlayers = 1;
  }
});

test('lobby party matchmaking creates one shared session with per-player join tickets', async () => {
  const alpha = await backend.services.auth.register({ email: 'match-leader@test.local', displayName: 'MatchLead', password: 'valid-local-password-001' });
  const beta = await backend.services.auth.register({ email: 'match-member@test.local', displayName: 'MatchMate', password: 'valid-local-password-001' });
  const party = backend.services.lobby.getOrCreate(alpha);
  backend.services.lobby.invite(party.id, alpha.id, beta.id);
  backend.services.lobby.join(party.id, beta);
  const ticket = await backend.services.enqueueMatchmaking(alpha, { playlist: 'Playlist_PartyTest', region: 'EU' });
  assert.equal(ticket.status, 'matched');
  assert.equal(ticket.members.length, 2);
  const alphaTicket = backend.services.matchmaker.getTicketByAccount(alpha.id);
  const betaTicket = backend.services.matchmaker.getTicketByAccount(beta.id);
  assert.equal(alphaTicket.session.id, betaTicket.session.id);
  assert.notEqual(alphaTicket.joinTicket, betaTicket.joinTicket);
  const alphaJoin = await fetch(`${config.gameServer.controlUrl}/sessions/${alphaTicket.session.id}/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ joinTicket: alphaTicket.joinTicket })
  });
  const betaJoin = await fetch(`${config.gameServer.controlUrl}/sessions/${betaTicket.session.id}/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ joinTicket: betaTicket.joinTicket })
  });
  assert.equal(alphaJoin.status, 200);
  assert.equal(betaJoin.status, 200);
});

test('GraphQL supports health query', async () => {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await getToken()}` },
    body: JSON.stringify({ query: '{ health me { displayName email } shopOffers { offerId } }' })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.data.health, 'ok');
  assert.equal(result.data.me.displayName, 'Alpha');
  assert.equal('email' in result.data.me, true);
  assert.ok(result.data.shopOffers.length > 0);
});
