import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadDotEnv(file) {
  let content;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function envBool(value, fallback) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function envNumber(value, fallback, name) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return number;
}

export async function loadConfig() {
  await loadDotEnv(path.join(ROOT, '.env'));
  const parsed = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'config.json'), 'utf8'));
  const config = {
    ...parsed,
    server: {
      ...parsed.server,
      host: process.env.SERVER_HOST ?? parsed.server.host,
      port: envNumber(process.env.SERVER_PORT, parsed.server.port, 'SERVER_PORT')
    },
    oauth: {
      ...parsed.oauth,
      clientId: process.env.OAUTH_CLIENT_ID ?? parsed.oauth.clientId,
      clientSecret: process.env.OAUTH_CLIENT_SECRET ?? parsed.oauth.clientSecret
    },
    gameServer: {
      ...parsed.gameServer,
      adapterEnabled: envBool(process.env.GS_ADAPTER_ENABLED, parsed.gameServer.adapterEnabled),
      bindHost: process.env.GS_BIND_HOST ?? parsed.gameServer.bindHost,
      publicHost: process.env.GS_PUBLIC_HOST ?? parsed.gameServer.publicHost,
      port: envNumber(process.env.GS_PORT, parsed.gameServer.port, 'GS_PORT'),
      controlUrl: process.env.GS_CONTROL_URL ?? parsed.gameServer.controlUrl,
      internalSecret: process.env.GS_INTERNAL_SECRET ?? parsed.gameServer.internalSecret
    },
    matchmaking: {
      ...parsed.matchmaking,
      sessionKey: process.env.SESSION_KEY ?? parsed.matchmaking.sessionKey
    },
    dataDir: process.env.DATA_DIR ?? parsed.dataDir
  };
  if (typeof config.oauth.clientSecret !== 'string' || config.oauth.clientSecret.length < 16) {
    throw new Error('oauth.clientSecret must contain at least 16 characters');
  }
  if (typeof config.gameServer.internalSecret !== 'string' || config.gameServer.internalSecret.length < 16) {
    throw new Error('gameServer.internalSecret must contain at least 16 characters');
  }
  if (typeof config.matchmaking.sessionKey !== 'string' || config.matchmaking.sessionKey.length < 16) {
    throw new Error('matchmaking.sessionKey must contain at least 16 characters');
  }
  config.rootDir = ROOT;
  config.dataDir = path.resolve(ROOT, config.dataDir);
  config.newsFile = path.join(ROOT, 'config', 'news.json');
  config.shopFile = path.join(ROOT, 'config', 'shop.json');
  return config;
}

export async function readJsonFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
