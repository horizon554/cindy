import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  MODEL_ACCESS_RESOLVE_SCHEMA_VERSION,
  parseResolveRequest,
  parseResolveResponse,
  type ModelAgent,
  type ResolveRequestModel,
  type ResolveResponse,
} from '@cindy/model-access-protocol';

import { app } from 'electron';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { serverApiFetch } from '../serverApiClient.js';

const RESOLVE_PATH = '/api/model-catalog/resolve';
const STORE_VERSION = 1;

export interface ModelResolveInput {
  providerId: string;
  agent: ModelAgent;
  wireProtocol?: string;
  models: ResolveRequestModel[];
}

export interface ModelResolveResult {
  knowledgeRevision: string;
  entry: ResolveResponse['entries'][number];
}

interface PersistedResolveEntry {
  key: string;
  realm: string;
  knowledgeRevision: string;
  response: ResolveResponse;
}

interface PersistedResolveStore {
  version: typeof STORE_VERSION;
  entries: PersistedResolveEntry[];
}

export interface ModelResolveDeps {
  fetch(request: unknown): Promise<unknown>;
  getBaseUrl(): string;
  getUserDataDir(): string;
  readFile(filePath: string): Promise<string>;
  mkdir(dirPath: string): Promise<void>;
  writeFile(filePath: string, contents: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(filePath: string): Promise<void>;
  disabled(): boolean;
}

const memoryCache = new Map<string, ModelResolveResult>();
const inFlight = new Map<string, Promise<ModelResolveResult | null>>();
let storeLoad: Promise<PersistedResolveStore> | null = null;
let storeWrite: Promise<void> = Promise.resolve();

export function isModelCatalogResolveDisabled(): boolean {
  return process.env.XDT_DISABLE_MODEL_CATALOG_RESOLVE === '1';
}

export function modelResolveCacheKey(input: ModelResolveInput): string {
  const modelIdsHash = createHash('sha256')
    .update(input.models.map((model) => model.id).join('\u0000'))
    .digest('hex');
  return `${input.providerId}\u0000${input.agent}\u0000${modelIdsHash}`;
}

export function modelResolveRealm(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return null;
  }
}

function resolveFile(userDataDir: string): string {
  return path.join(userDataDir, 'model-access', 'model-resolve.json');
}

function emptyStore(): PersistedResolveStore {
  return { version: STORE_VERSION, entries: [] };
}

function parsePersistedStore(raw: string): PersistedResolveStore {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyStore();
    const record = value as { version?: unknown; entries?: unknown };
    if (record.version !== STORE_VERSION || !Array.isArray(record.entries)) return emptyStore();
    const entries: PersistedResolveEntry[] = [];
    for (const candidate of record.entries) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const entry = candidate as Partial<PersistedResolveEntry>;
      if (
        typeof entry.key !== 'string' ||
        typeof entry.realm !== 'string' ||
        typeof entry.knowledgeRevision !== 'string'
      ) continue;
      const parsed = parseResolveResponse(entry.response);
      if (!parsed.ok || parsed.value.knowledgeRevision !== entry.knowledgeRevision) continue;
      entries.push({ ...entry, response: parsed.value } as PersistedResolveEntry);
    }
    return { version: STORE_VERSION, entries };
  } catch {
    return emptyStore();
  }
}

function defaultDeps(): ModelResolveDeps {
  return {
    fetch: (request) => serverApiFetch<unknown>(RESOLVE_PATH, {
      method: 'POST',
      body: request,
      baseUrl: () => getClientEndpoint('modelAccessApiBaseUrl'),
      timeoutMs: 10_000,
      redactErrorDetails: true,
    }),
    getBaseUrl: () => getClientEndpoint('modelAccessApiBaseUrl'),
    getUserDataDir: () => app.getPath('userData'),
    readFile: (filePath) => fs.readFile(filePath, 'utf8'),
    mkdir: async (dirPath) => {
      await fs.mkdir(dirPath, { recursive: true });
    },
    writeFile: (filePath, contents) =>
      fs.writeFile(filePath, contents, { encoding: 'utf8', mode: 0o600 }),
    rename: (from, to) => fs.rename(from, to),
    remove: async (filePath) => {
      await fs.rm(filePath, { force: true });
    },
    disabled: isModelCatalogResolveDisabled,
  };
}

async function loadStore(deps: ModelResolveDeps): Promise<PersistedResolveStore> {
  if (!storeLoad) {
    storeLoad = deps.readFile(resolveFile(deps.getUserDataDir()))
      .then(parsePersistedStore)
      .catch(() => emptyStore());
  }
  return storeLoad;
}

async function writeStore(deps: ModelResolveDeps, store: PersistedResolveStore): Promise<void> {
  const filePath = resolveFile(deps.getUserDataDir());
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await deps.mkdir(path.dirname(filePath));
    await deps.writeFile(tempPath, `${JSON.stringify(store)}\n`);
    await deps.rename(tempPath, filePath);
  } catch {
    await deps.remove(tempPath).catch(() => undefined);
  }
}

function selectResult(response: ResolveResponse, input: ModelResolveInput): ModelResolveResult | null {
  const entry = response.entries.find(
    (candidate) => candidate.providerId === input.providerId && candidate.agent === input.agent,
  );
  if (!entry) return null;
  const expectedIds = input.models.map((model) => model.id);
  if (
    entry.models.length !== expectedIds.length ||
    entry.models.some((model, index) => model.id !== expectedIds[index])
  ) return null;
  return { knowledgeRevision: response.knowledgeRevision, entry };
}

export function createModelResolver(overrides: Partial<ModelResolveDeps> = {}) {
  const deps: ModelResolveDeps = {
    ...defaultDeps(),
    ...overrides,
    disabled: () =>
      isModelCatalogResolveDisabled() || (overrides.disabled?.() ?? false),
  };

  return async function resolveModels(input: ModelResolveInput): Promise<ModelResolveResult | null> {
    // The dynamic flag is checked before key, endpoint, disk, or network access. Disabled means the
    // pre-resolve pipeline is byte-for-byte untouched and has no observable cache side effects.
    if (deps.disabled()) return null;
    const request = {
      schemaVersion: MODEL_ACCESS_RESOLVE_SCHEMA_VERSION,
      entries: [{
        providerId: input.providerId,
        agent: input.agent,
        ...(input.wireProtocol ? { wireProtocol: input.wireProtocol } : {}),
        models: input.models,
      }],
    };
    if (!parseResolveRequest(request).ok) return null;

    const realm = modelResolveRealm(deps.getBaseUrl());
    if (!realm) return null;
    const key = modelResolveCacheKey(input);
    const memory = memoryCache.get(`${realm}\u0000${key}`);
    if (memory) return memory;
    const existing = inFlight.get(`${realm}\u0000${key}`);
    if (existing) return existing;

    const flight = (async (): Promise<ModelResolveResult | null> => {
      const store = await loadStore(deps);
      let persistedResult: ModelResolveResult | null = null;
      const persisted = store.entries.find((entry) => entry.key === key && entry.realm === realm);
      if (persisted) {
        const result = selectResult(persisted.response, input);
        if (result && result.knowledgeRevision === persisted.knowledgeRevision) {
          persistedResult = result;
        }
      }

      try {
        const payload = await deps.fetch(request);
        const parsed = parseResolveResponse(payload);
        if (!parsed.ok) return persistedResult;
        const result = selectResult(parsed.value, input);
        if (!result) return persistedResult;
        memoryCache.set(`${realm}\u0000${key}`, result);
        const nextStore: PersistedResolveStore = {
          version: STORE_VERSION,
          entries: [
            ...store.entries.filter((entry) => !(entry.key === key && entry.realm === realm)),
            {
              key,
              realm,
              knowledgeRevision: result.knowledgeRevision,
              response: parsed.value,
            },
          ],
        };
        storeLoad = Promise.resolve(nextStore);
        storeWrite = storeWrite.then(() => writeStore(deps, nextStore));
        await storeWrite;
        return result;
      } catch {
        if (persistedResult) memoryCache.set(`${realm}\u0000${key}`, persistedResult);
        return persistedResult;
      }
    })().finally(() => {
      inFlight.delete(`${realm}\u0000${key}`);
    });
    inFlight.set(`${realm}\u0000${key}`, flight);
    return flight;
  };
}

export const resolveProviderModels = createModelResolver();

export function resetModelResolveStateForTests(): void {
  memoryCache.clear();
  inFlight.clear();
  storeLoad = null;
  storeWrite = Promise.resolve();
}
