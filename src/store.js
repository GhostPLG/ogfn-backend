import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function emptyState() {
  return {
    schemaVersion: 1,
    accounts: [],
    profiles: {},
    auth: {
      transactions: {},
      authorizationCodes: {},
      accessTokens: {},
      refreshTokens: {},
      exchangeCodes: {},
      deviceAuths: {}
    },
    matches: {}
  };
}

export class JsonStore {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'state.json');
    this.state = emptyState();
    this.pending = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.state = { ...emptyState(), ...parsed };
      this.state.auth = { ...emptyState().auth, ...(parsed.auth ?? {}) };
      this.state.profiles ??= {};
      this.state.matches ??= {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot read ${this.file}: ${error.message}`);
      await this.write(this.state);
    }
    return this;
  }

  snapshot() {
    return structuredClone(this.state);
  }

  async update(mutator) {
    const operation = this.pending.then(async () => {
      const draft = structuredClone(this.state);
      const result = await mutator(draft);
      await this.write(draft);
      this.state = draft;
      return structuredClone(result);
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  async write(state) {
    await fs.mkdir(this.directory, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.file);
  }

  findAccountById(accountId) {
    return this.state.accounts.find((account) => account.id === accountId) ?? null;
  }

  findAccountByLogin(login) {
    const normalized = String(login ?? '').trim().toLowerCase();
    return this.state.accounts.find((account) => account.email.toLowerCase() === normalized || account.displayName.toLowerCase() === normalized) ?? null;
  }
}
