import { randomBytes, randomUUID, createHash, timingSafeEqual, pbkdf2 as pbkdf2Callback } from 'node:crypto';
import { promisify } from 'node:util';
import { createAthenaProfile, createEmptyProfile } from './profile.js';

const pbkdf2 = promisify(pbkdf2Callback);
const PASSWORD_ITERATIONS = 210000;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function randomToken() {
  return randomBytes(32).toString('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function cleanScope(value) {
  const values = Array.isArray(value) ? value : String(value ?? 'basic_profile').split(/[\s,]+/u);
  return [...new Set(values.map((scope) => String(scope).trim()).filter(Boolean))].slice(0, 20);
}

function validateDisplayName(value) {
  const name = String(value ?? '').trim();
  if (!/^[\p{L}\p{N}_-]{3,16}$/u.test(name)) {
    throw new HttpError(400, 'invalid_display_name', 'Display name must be 3-16 letters, numbers, underscores, or hyphens.');
  }
  return name;
}

function publicAccount(account) {
  return {
    id: account.id,
    accountId: account.id,
    displayName: account.displayName,
    email: account.email,
    failedLoginAttempts: 0,
    lastLogin: account.lastLogin ?? account.createdAt,
    numberOfDisplayNameChanges: 0,
    ageGroup: 'UNKNOWN',
    headless: false,
    country: 'US',
    preferredLanguage: 'en',
    canUpdateDisplayName: false,
    tfaEnabled: false,
    emailVerified: true,
    minorVerified: false,
    cabinedMode: false,
    hasHashedEmail: false
  };
}

export class AuthService {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
    this.failures = new Map();
  }

  async hashPassword(password) {
    const salt = randomBytes(16).toString('hex');
    const derived = await pbkdf2(password, salt, PASSWORD_ITERATIONS, 64, 'sha256');
    return `pbkdf2$sha256$${PASSWORD_ITERATIONS}$${salt}$${derived.toString('hex')}`;
  }

  async verifyPassword(password, stored) {
    const [scheme, digestName, iterationsText, salt, expectedHex] = String(stored).split('$');
    if (scheme !== 'pbkdf2' || digestName !== 'sha256' || !salt || !expectedHex) return false;
    const iterations = Number(iterationsText);
    if (!Number.isSafeInteger(iterations) || iterations < 100000 || iterations > 1000000) return false;
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = await pbkdf2(password, salt, iterations, expected.length, 'sha256');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  async register({ email, username, displayName, password }) {
    const login = String(email ?? username ?? '').trim();
    const normalizedEmail = login.toLowerCase();
    if (!this.config.oauth.allowRegistration) throw new HttpError(403, 'registration_disabled', 'Local account registration is disabled.');
    if (login.length < 3 || login.length > 254 || /\s/u.test(login)) throw new HttpError(400, 'invalid_username', 'Username/email must contain 3-254 non-space characters.');
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw new HttpError(400, 'invalid_password', 'Password must contain 10-128 characters.');
    const name = validateDisplayName(displayName ?? login.split('@')[0]);
    const passwordHash = await this.hashPassword(password);
    const account = {
      id: randomBytes(16).toString('hex'),
      email: normalizedEmail,
      displayName: name,
      passwordHash,
      createdAt: new Date().toISOString(),
      lastLogin: null
    };
    await this.store.update((state) => {
      if (state.accounts.some((item) => item.email.toLowerCase() === normalizedEmail)) {
        throw new HttpError(409, 'account_exists', 'An account with that username/email already exists.');
      }
      if (state.accounts.some((item) => item.displayName.toLowerCase() === name.toLowerCase())) {
        throw new HttpError(409, 'display_name_exists', 'That display name is already taken.');
      }
      state.accounts.push(account);
      state.profiles[account.id] = {
        athena: createAthenaProfile(account.id),
        common_core: createEmptyProfile(account.id, 'common_core', this.config.store.startingVbucks),
        common_public: createEmptyProfile(account.id, 'common_public'),
        profile0: createEmptyProfile(account.id, 'profile0'),
        metadata: createEmptyProfile(account.id, 'metadata')
      };
      return true;
    });
    return publicAccount(account);
  }

  async authenticatePassword(username, password, ip = 'unknown') {
    const key = `${ip}:${String(username ?? '').toLowerCase()}`;
    const current = this.failures.get(key);
    if (current && current.count >= 8 && Date.now() - current.startedAt < 10 * 60 * 1000) {
      throw new HttpError(429, 'too_many_attempts', 'Too many failed logins. Try again in 10 minutes.');
    }
    const account = this.store.findAccountByLogin(username);
    const passwordOK = account ? await this.verifyPassword(String(password ?? ''), account.passwordHash) : false;
    if (!account || !passwordOK) {
      if (!current || Date.now() - current.startedAt >= 10 * 60 * 1000) this.failures.set(key, { count: 1, startedAt: Date.now() });
      else current.count += 1;
      throw new HttpError(400, 'invalid_grant', 'Invalid username or password.');
    }
    this.failures.delete(key);
    await this.store.update((state) => {
      const saved = state.accounts.find((item) => item.id === account.id);
      if (saved) saved.lastLogin = new Date().toISOString();
      return true;
    });
    return this.store.findAccountById(account.id);
  }

  validateClient(input = {}) {
    let clientId = input.client_id ?? input.clientId;
    let clientSecret = input.client_secret ?? input.clientSecret;
    const authorization = input.authorization ?? '';
    if (/^basic\s+/iu.test(authorization)) {
      let decoded;
      try {
        decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      } catch {
        throw new HttpError(401, 'invalid_client', 'Invalid client credentials.');
      }
      const split = decoded.indexOf(':');
      if (split < 0) throw new HttpError(401, 'invalid_client', 'Invalid client credentials.');
      clientId = decoded.slice(0, split);
      clientSecret = decoded.slice(split + 1);
    }
    if (clientId !== this.config.oauth.clientId) throw new HttpError(401, 'invalid_client', 'Unknown client_id.');
    if (clientSecret !== undefined && !safeEqual(clientSecret, this.config.oauth.clientSecret)) {
      throw new HttpError(401, 'invalid_client', 'Invalid client_secret.');
    }
    return { clientId: this.config.oauth.clientId, authenticatedClient: clientSecret !== undefined };
  }

  async issueToken(accountId, { clientId = this.config.oauth.clientId, scope = ['basic_profile'], allowRefresh = true } = {}) {
    const accessToken = randomToken();
    const refreshToken = allowRefresh ? randomToken() : null;
    const deviceId = randomUUID().replaceAll('-', '');
    const now = Date.now();
    const accessLifetime = Number(this.config.oauth.accessTokenSeconds);
    const refreshLifetime = Number(this.config.oauth.refreshTokenSeconds);
    const expiresAt = new Date(now + accessLifetime * 1000).toISOString();
    const refreshExpiresAt = refreshToken ? new Date(now + refreshLifetime * 1000).toISOString() : null;
    await this.store.update((state) => {
      state.auth.accessTokens[digest(accessToken)] = {
        accountId,
        clientId,
        scope: cleanScope(scope),
        createdAt: new Date(now).toISOString(),
        expiresAt
      };
      if (refreshToken) {
        state.auth.refreshTokens[digest(refreshToken)] = {
          accountId,
          clientId,
          scope: cleanScope(scope),
          createdAt: new Date(now).toISOString(),
          expiresAt: refreshExpiresAt
        };
      }
      return true;
    });
    const account = accountId ? this.store.findAccountById(accountId) : null;
    return {
      access_token: accessToken,
      expires_in: accessLifetime,
      expires_at: expiresAt,
      token_type: 'bearer',
      ...(refreshToken ? { refresh_token: refreshToken, refresh_expires: refreshLifetime, refresh_expires_at: refreshExpiresAt } : {}),
      ...(account ? { account_id: account.id, displayName: account.displayName, in_app_id: account.id } : {}),
      client_id: clientId,
      internal_client: this.config.oauth.internalClient,
      client_service: this.config.oauth.clientService,
      scope: cleanScope(scope),
      app: this.config.oauth.productId,
      device_id: deviceId,
      product_id: this.config.oauth.productId,
      application_id: this.config.oauth.applicationId
    };
  }

  async issueAuthorizationCode({ accountId, clientId, redirectUri, scope, codeChallenge, codeChallengeMethod }) {
    const code = randomToken();
    const expiresAt = new Date(Date.now() + Number(this.config.oauth.authorizationCodeSeconds) * 1000).toISOString();
    await this.store.update((state) => {
      state.auth.authorizationCodes[digest(code)] = {
        accountId,
        clientId,
        redirectUri,
        scope: cleanScope(scope),
        codeChallenge: codeChallenge ?? null,
        codeChallengeMethod: codeChallengeMethod ?? 'plain',
        expiresAt
      };
      return true;
    });
    return code;
  }

  async consumeAuthorizationCode(code, { clientId, redirectUri, codeVerifier }) {
    const hash = digest(code);
    let result;
    await this.store.update((state) => {
      const entry = state.auth.authorizationCodes[hash];
      if (!entry || Date.parse(entry.expiresAt) <= Date.now()) throw new HttpError(400, 'invalid_grant', 'Authorization code is invalid or expired.');
      if (entry.clientId !== clientId || entry.redirectUri !== redirectUri) throw new HttpError(400, 'invalid_grant', 'Authorization code client or redirect URI does not match.');
      if (entry.codeChallenge) {
        let verifier = String(codeVerifier ?? '');
        if (entry.codeChallengeMethod === 'S256') verifier = createHash('sha256').update(verifier).digest('base64url');
        if (!safeEqual(verifier, entry.codeChallenge)) throw new HttpError(400, 'invalid_grant', 'PKCE verifier did not match the authorization request.');
      }
      result = { accountId: entry.accountId, scope: entry.scope };
      delete state.auth.authorizationCodes[hash];
      return true;
    });
    return result;
  }

  async issueExchangeCode(accountId) {
    const code = randomToken();
    const expiresAt = new Date(Date.now() + Number(this.config.oauth.exchangeCodeSeconds) * 1000).toISOString();
    await this.store.update((state) => {
      state.auth.exchangeCodes[digest(code)] = { accountId, expiresAt };
      return true;
    });
    return { code, expiresAt };
  }

  async consumeExchangeCode(code) {
    const hash = digest(code);
    let accountId;
    await this.store.update((state) => {
      const entry = state.auth.exchangeCodes[hash];
      if (!entry || Date.parse(entry.expiresAt) <= Date.now()) throw new HttpError(400, 'invalid_grant', 'Exchange code is invalid or expired.');
      accountId = entry.accountId;
      delete state.auth.exchangeCodes[hash];
      return true;
    });
    return accountId;
  }

  async refresh(refreshToken, clientId) {
    const hash = digest(refreshToken);
    let entry;
    await this.store.update((state) => {
      entry = state.auth.refreshTokens[hash];
      if (!entry || Date.parse(entry.expiresAt) <= Date.now() || entry.clientId !== clientId) {
        throw new HttpError(400, 'invalid_grant', 'Refresh token is invalid or expired.');
      }
      delete state.auth.refreshTokens[hash];
      return true;
    });
    return this.issueToken(entry.accountId, { clientId, scope: entry.scope });
  }

  async authenticateHeader(header) {
    const match = /^Bearer\s+(.+)$/iu.exec(String(header ?? ''));
    if (!match) throw new HttpError(401, 'authentication_required', 'A bearer access token is required.');
    const raw = match[1].trim();
    if (!TOKEN_PATTERN.test(raw)) throw new HttpError(401, 'invalid_token', 'Access token is invalid.');
    const entry = this.store.snapshot().auth.accessTokens[digest(raw)];
    if (!entry || Date.parse(entry.expiresAt) <= Date.now()) throw new HttpError(401, 'invalid_token', 'Access token is invalid or expired.');
    const account = entry.accountId ? this.store.findAccountById(entry.accountId) : null;
    if (entry.accountId && !account) throw new HttpError(401, 'invalid_token', 'The token account no longer exists.');
    return { ...entry, account };
  }

  async revokeAccessToken(header) {
    const match = /^Bearer\s+(.+)$/iu.exec(String(header ?? ''));
    if (!match) return false;
    const hash = digest(match[1].trim());
    await this.store.update((state) => {
      delete state.auth.accessTokens[hash];
      return true;
    });
    return true;
  }

  async createDeviceAuth(accountId, userAgent = '') {
    const deviceId = randomUUID().replaceAll('-', '');
    const secret = randomToken();
    const auth = {
      deviceId,
      accountId,
      secretHash: digest(secret),
      createdAt: new Date().toISOString(),
      userAgent: String(userAgent).slice(0, 250)
    };
    await this.store.update((state) => {
      if (!state.accounts.some((account) => account.id === accountId)) throw new HttpError(404, 'account_not_found', 'Account not found.');
      state.auth.deviceAuths[deviceId] = auth;
      return true;
    });
    return { deviceId, accountId, secret, userAgent: auth.userAgent, createdAt: auth.createdAt };
  }

  async authenticateDevice(deviceId, secret) {
    const entry = this.store.snapshot().auth.deviceAuths[String(deviceId ?? '')];
    if (!entry || !safeEqual(entry.secretHash, digest(secret ?? ''))) throw new HttpError(400, 'invalid_grant', 'Device credentials are invalid.');
    const account = this.store.findAccountById(entry.accountId);
    if (!account) throw new HttpError(400, 'invalid_grant', 'Device account no longer exists.');
    return account;
  }

  async deleteDeviceAuth(accountId, deviceId) {
    let removed = false;
    await this.store.update((state) => {
      if (state.auth.deviceAuths[deviceId]?.accountId === accountId) {
        delete state.auth.deviceAuths[deviceId];
        removed = true;
      }
      return true;
    });
    return removed;
  }

  cleanup() {
    const now = Date.now();
    return this.store.update((state) => {
      for (const bucket of ['transactions', 'authorizationCodes', 'accessTokens', 'refreshTokens', 'exchangeCodes']) {
        for (const [key, entry] of Object.entries(state.auth[bucket])) {
          if (Date.parse(entry.expiresAt) <= now) delete state.auth[bucket][key];
        }
      }
      return true;
    });
  }
}

export { publicAccount, cleanScope };
