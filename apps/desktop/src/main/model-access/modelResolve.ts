import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  MODEL_ACCESS_CHAT_MODES,
  MODEL_ACCESS_RESOLVE_SCHEMA_VERSION,
  parseResolveRequest,
  parseResolveResponse,
  type ModelAgent,
  type ModelChatMode,
  type ProviderReportedModel,
  type ResolveRequest,
  type ResolveRequestEntry,
  type ResolveRequestModel,
  type ResolveResponse,
} from '@cindy/model-access-protocol';

import { app } from 'electron';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { serverApiFetch } from '../serverApiClient.js';

const RESOLVE_PATH = '/api/model-catalog/resolve';
const STORE_VERSION = 2;

export type ModelResolveSourceIdentity =
  | {
      kind: 'provider-runtime';
      upstream: string;
      requestPath?: string;
      modelsUrl: string;
    }
  | {
      kind: 'native';
      id: string;
    };

export interface ModelResolveInput {
  providerId: string;
  agent: ModelAgent;
  wireProtocol?: string;
  /** Local-only cache discriminator. It is hashed and never sent to Model Access Server. */
  sourceIdentity: ModelResolveSourceIdentity;
  models: ResolveRequestModel[];
}

type ModelResolveCandidate = Omit<ResolveRequestModel, 'providerReported'> & {
  providerReported?: Omit<ProviderReportedModel, 'mode'> & { mode?: string };
};

interface CachedModelResolveResult {
  knowledgeRevision: string;
  entry: ResolveResponse['entries'][number];
}

export interface ModelResolveResult extends CachedModelResolveResult {
  /** Local-only request generation used to reject stale asynchronous overlay application. */
  applyToken: string;
}

export interface ModelResolver {
  (input: ModelResolveInput): Promise<ModelResolveResult | null>;
  resolveEntries(inputs: readonly ModelResolveInput[]): Promise<Array<ModelResolveResult | null>>;
}

interface PersistedResolveEntry {
  key: string;
  slot: string;
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

const memoryCache = new Map<string, CachedModelResolveResult>();
const memoryKeyBySlot = new Map<string, string>();
const inFlight = new Map<string, Promise<CachedModelResolveResult | null>>();
const latestApplyTokenBySlot = new Map<string, string>();
const latestCacheKeyBySlot = new Map<string, string>();
let applyTokenSequence = 0;
let storeLoad: Promise<PersistedResolveStore> | null = null;
let storeWrite: Promise<void> = Promise.resolve();

export function isModelCatalogResolveDisabled(): boolean {
  return process.env.XDT_DISABLE_MODEL_CATALOG_RESOLVE === '1';
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) output[key] = canonicalize(item);
  }
  return output;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalRequestUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.hash = '';
    return url.toString();
  } catch {
    return trimmed;
  }
}

function normalizedSourceIdentity(source: ModelResolveSourceIdentity): ModelResolveSourceIdentity {
  if (source.kind === 'native') return source;
  return {
    kind: source.kind,
    upstream: canonicalRequestUrl(source.upstream),
    ...(source.requestPath !== undefined ? { requestPath: source.requestPath } : {}),
    modelsUrl: canonicalRequestUrl(source.modelsUrl),
  };
}

function effectiveWireProtocol(input: ModelResolveInput): string {
  return input.wireProtocol?.trim()
    ?? (input.agent === 'claude-code' ? 'anthropic-messages' : 'openai-responses');
}

function isModelChatMode(value: string): value is ModelChatMode {
  return MODEL_ACCESS_CHAT_MODES.some((mode) => mode === value);
}

/**
 * Projects raw provider discovery records onto the closed v2 resolve wire contract. Explicitly
 * non-chat models stay available to local discovery consumers but do not enter a chat resolve batch.
 */
export function toModelResolveRequestModels(
  models: readonly ModelResolveCandidate[],
): ResolveRequestModel[] {
  return models.flatMap((model) => {
    if (model.providerReported === undefined) {
      return [{ id: model.id, ...(model.name !== undefined ? { name: model.name } : {}) }];
    }
    const { mode, ...providerFacts } = model.providerReported;
    if (mode !== undefined && !isModelChatMode(mode)) return [];
    return [
      {
        id: model.id,
        ...(model.name !== undefined ? { name: model.name } : {}),
        providerReported: {
          ...providerFacts,
          ...(mode !== undefined ? { mode } : {}),
        },
      },
    ];
  });
}

function projectRequestModel(model: ResolveRequestModel): ResolveRequestModel {
  return {
    id: model.id,
    ...(model.name !== undefined ? { name: model.name } : {}),
    ...(model.providerReported !== undefined ? { providerReported: model.providerReported } : {}),
  };
}

function requestEntry(input: ModelResolveInput): ResolveRequestEntry {
  return {
    providerId: input.providerId,
    agent: input.agent,
    wireProtocol: effectiveWireProtocol(input),
    models: input.models.map(projectRequestModel),
  };
}

function modelResolveSlot(input: Pick<ModelResolveInput, 'providerId' | 'agent'>): string {
  return `${input.providerId}\u0000${input.agent}`;
}

function slotFromCacheKey(key: string): string | null {
  const first = key.indexOf('\u0000');
  if (first < 0) return null;
  const second = key.indexOf('\u0000', first + 1);
  return second < 0 ? null : key.slice(0, second);
}

function beginApplyGeneration(slot: string, cacheKey: string): string {
  const currentToken = latestApplyTokenBySlot.get(slot);
  if (latestCacheKeyBySlot.get(slot) === cacheKey && currentToken) return currentToken;
  const token = String(applyTokenSequence += 1);
  latestApplyTokenBySlot.set(slot, token);
  latestCacheKeyBySlot.set(slot, cacheKey);
  return token;
}

function withApplyToken(
  result: CachedModelResolveResult | null,
  applyToken: string,
): ModelResolveResult | null {
  return result ? { ...result, applyToken } : null;
}

export function isLatestModelResolveResult(result: ModelResolveResult): boolean {
  return latestApplyTokenBySlot.get(modelResolveSlot(result.entry)) === result.applyToken;
}

export function modelResolveCacheKey(input: ModelResolveInput): string {
  const entry = requestEntry(input);
  const fingerprint = createHash('sha256')
    .update(canonicalJson({
      fingerprintVersion: 2,
      entry,
      sourceIdentity: normalizedSourceIdentity(input.sourceIdentity),
    }))
    .digest('hex');
  return `${modelResolveSlot(input)}\u0000${fingerprint}`;
}

export function modelResolveRealm(baseUrl: string): string | null {
  try {
    const url = new URL(`${baseUrl}${RESOLVE_PATH}`);
    url.hash = '';
    return `sha256:${createHash('sha256').update(url.toString()).digest('hex')}`;
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
    const entriesBySlot = new Map<string, PersistedResolveEntry>();
    for (const candidate of record.entries) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const entry = candidate as Partial<PersistedResolveEntry>;
      if (
        typeof entry.key !== 'string' ||
        typeof entry.realm !== 'string' ||
        typeof entry.knowledgeRevision !== 'string'
      ) continue;
      const slot = typeof entry.slot === 'string' ? entry.slot : slotFromCacheKey(entry.key);
      if (!slot) continue;
      const parsed = parseResolveResponse(entry.response);
      if (!parsed.ok || parsed.value.knowledgeRevision !== entry.knowledgeRevision) continue;
      entriesBySlot.set(`${entry.realm}\u0000${slot}`, {
        key: entry.key,
        slot,
        realm: entry.realm,
        knowledgeRevision: entry.knowledgeRevision,
        response: parsed.value,
      });
    }
    return { version: STORE_VERSION, entries: [...entriesBySlot.values()] };
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

function selectResult(
  response: ResolveResponse,
  input: ModelResolveInput,
): CachedModelResolveResult | null {
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

function persistedResultFor(
  store: PersistedResolveStore,
  realm: string,
  key: string,
  input: ModelResolveInput,
): CachedModelResolveResult | null {
  const persisted = store.entries.find((entry) => entry.key === key && entry.realm === realm);
  if (!persisted) return null;
  const result = selectResult(persisted.response, input);
  return result?.knowledgeRevision === persisted.knowledgeRevision ? result : null;
}

function compactResponse(result: CachedModelResolveResult): ResolveResponse {
  return {
    schemaVersion: MODEL_ACCESS_RESOLVE_SCHEMA_VERSION,
    knowledgeRevision: result.knowledgeRevision,
    entries: [result.entry],
  };
}

async function persistResults(
  deps: ModelResolveDeps,
  realm: string,
  updates: readonly { key: string; slot: string; result: CachedModelResolveResult }[],
): Promise<void> {
  if (updates.length === 0) return;
  storeWrite = storeWrite.then(async () => {
    const currentUpdates = updates.filter(
      ({ key, slot }) => latestCacheKeyBySlot.get(slot) === `${realm}\u0000${key}`,
    );
    if (currentUpdates.length === 0) return;
    const store = await loadStore(deps);
    const updatedSlots = new Set(currentUpdates.map(({ slot }) => slot));
    const nextStore: PersistedResolveStore = {
      version: STORE_VERSION,
      entries: [
        ...store.entries.filter(
          (entry) => entry.realm !== realm || !updatedSlots.has(entry.slot),
        ),
        ...currentUpdates.map(({ key, slot, result }) => ({
          key,
          slot,
          realm,
          knowledgeRevision: result.knowledgeRevision,
          response: compactResponse(result),
        })),
      ],
    };
    storeLoad = Promise.resolve(nextStore);
    await writeStore(deps, nextStore);
  });
  await storeWrite;
}

function memorySlotKey(realm: string, slot: string): string {
  return `${realm}\u0000${slot}`;
}

function prepareMemorySlot(realm: string, slot: string, cacheKey: string): void {
  const slotKey = memorySlotKey(realm, slot);
  const previous = memoryKeyBySlot.get(slotKey);
  if (previous && previous !== cacheKey) {
    memoryCache.delete(previous);
    memoryKeyBySlot.delete(slotKey);
  }
}

function setMemoryResult(
  realm: string,
  slot: string,
  cacheKey: string,
  result: CachedModelResolveResult,
): void {
  prepareMemorySlot(realm, slot, cacheKey);
  memoryCache.set(cacheKey, result);
  memoryKeyBySlot.set(memorySlotKey(realm, slot), cacheKey);
}

interface PendingResolveEntry {
  input: ModelResolveInput;
  key: string;
  slot: string;
  cacheKey: string;
  applyToken: string;
  indexes: number[];
}

export function createModelResolver(overrides: Partial<ModelResolveDeps> = {}): ModelResolver {
  const deps: ModelResolveDeps = {
    ...defaultDeps(),
    ...overrides,
    disabled: () =>
      isModelCatalogResolveDisabled() || (overrides.disabled?.() ?? false),
  };

  const resolveEntries = async (
    inputs: readonly ModelResolveInput[],
  ): Promise<Array<ModelResolveResult | null>> => {
    // The dynamic flag is checked before key, endpoint, disk, or network access. Disabled means the
    // pre-resolve pipeline is byte-for-byte untouched and has no observable cache side effects.
    const results: Array<ModelResolveResult | null> = inputs.map(() => null);
    if (deps.disabled() || inputs.length === 0) return results;

    const uniqueByPair = new Map<string, PendingResolveEntry>();
    for (const [index, input] of inputs.entries()) {
      const key = modelResolveCacheKey(input);
      const pair = modelResolveSlot(input);
      const existing = uniqueByPair.get(pair);
      if (existing) {
        // The wire protocol forbids duplicate provider/agent entries. Identical fingerprints can be
        // deduplicated locally; conflicting duplicates are ambiguous and fail closed as one batch.
        if (existing.key !== key) return results;
        existing.indexes.push(index);
        continue;
      }
      uniqueByPair.set(pair, {
        input,
        key,
        slot: pair,
        cacheKey: '',
        applyToken: '',
        indexes: [index],
      });
    }
    const request: ResolveRequest = {
      schemaVersion: MODEL_ACCESS_RESOLVE_SCHEMA_VERSION,
      entries: [...uniqueByPair.values()].map(({ input }) => requestEntry(input)),
    };
    if (
      request.entries.some((entry) => !entry.wireProtocol?.trim())
      || !parseResolveRequest(request).ok
    ) return results;

    const realm = modelResolveRealm(deps.getBaseUrl());
    if (!realm) return results;

    for (const entry of uniqueByPair.values()) {
      entry.cacheKey = `${realm}\u0000${entry.key}`;
      entry.applyToken = beginApplyGeneration(entry.slot, entry.cacheKey);
    }

    const pending: Array<{
      entry: PendingResolveEntry;
      promise: Promise<CachedModelResolveResult | null>;
    }> = [];
    const missing: PendingResolveEntry[] = [];
    for (const entry of uniqueByPair.values()) {
      prepareMemorySlot(realm, entry.slot, entry.cacheKey);
      const memory = memoryCache.get(entry.cacheKey);
      if (memory) {
        const applied = withApplyToken(memory, entry.applyToken);
        for (const index of entry.indexes) results[index] = applied;
        continue;
      }
      const existing = inFlight.get(entry.cacheKey);
      if (existing) pending.push({ entry, promise: existing });
      else missing.push(entry);
    }

    if (missing.length > 0) {
      const missingRequest: ResolveRequest = {
        schemaVersion: MODEL_ACCESS_RESOLVE_SCHEMA_VERSION,
        entries: missing.map(({ input }) => requestEntry(input)),
      };
      const batchFlight = (async (): Promise<Map<string, CachedModelResolveResult | null>> => {
        const resolvedByKey = new Map<string, CachedModelResolveResult | null>();
        const store = await loadStore(deps);
        const persistedByKey = new Map(
          missing.map((entry) => [
            entry.key,
            persistedResultFor(store, realm, entry.key, entry.input),
          ]),
        );
        const realmBeforeFetch = modelResolveRealm(deps.getBaseUrl());
        if (!realmBeforeFetch) {
          for (const entry of missing) resolvedByKey.set(entry.key, null);
          return resolvedByKey;
        }

        try {
          const payload = await deps.fetch(missingRequest);
          const realmAfterFetch = modelResolveRealm(deps.getBaseUrl());
          if (realmBeforeFetch !== realm || realmAfterFetch !== realm) {
            for (const entry of missing) resolvedByKey.set(entry.key, null);
            return resolvedByKey;
          }
          const parsed = parseResolveResponse(payload);
          if (!parsed.ok) {
            for (const entry of missing) {
              resolvedByKey.set(entry.key, persistedByKey.get(entry.key) ?? null);
            }
            return resolvedByKey;
          }

          const updates: Array<{
            key: string;
            slot: string;
            result: CachedModelResolveResult;
          }> = [];
          for (const entry of missing) {
            const result = selectResult(parsed.value, entry.input);
            if (result) {
              resolvedByKey.set(entry.key, result);
              if (latestCacheKeyBySlot.get(entry.slot) === entry.cacheKey) {
                setMemoryResult(realm, entry.slot, entry.cacheKey, result);
                updates.push({ key: entry.key, slot: entry.slot, result });
              }
            } else {
              resolvedByKey.set(entry.key, persistedByKey.get(entry.key) ?? null);
            }
          }
          await persistResults(deps, realm, updates);
          return resolvedByKey;
        } catch {
          const realmAfterFetch = modelResolveRealm(deps.getBaseUrl());
          for (const entry of missing) {
            const persisted =
              realmBeforeFetch === realm && realmAfterFetch === realm
                ? (persistedByKey.get(entry.key) ?? null)
                : null;
            if (persisted && latestCacheKeyBySlot.get(entry.slot) === entry.cacheKey) {
              setMemoryResult(realm, entry.slot, entry.cacheKey, persisted);
            }
            resolvedByKey.set(entry.key, persisted);
          }
          return resolvedByKey;
        }
      })();

      for (const entry of missing) {
        let flight!: Promise<CachedModelResolveResult | null>;
        flight = batchFlight
          .then((batch) => batch.get(entry.key) ?? null)
          .finally(() => {
            if (inFlight.get(entry.cacheKey) === flight) inFlight.delete(entry.cacheKey);
          });
        inFlight.set(entry.cacheKey, flight);
        pending.push({ entry, promise: flight });
      }
    }

    const settled = await Promise.all(
      pending.map(async ({ entry, promise }) => ({ entry, result: await promise })),
    );
    for (const { entry, result } of settled) {
      const applied = withApplyToken(result, entry.applyToken);
      for (const index of entry.indexes) results[index] = applied;
    }
    return results;
  };

  const resolveModels = (async (input: ModelResolveInput): Promise<ModelResolveResult | null> =>
    (await resolveEntries([input]))[0] ?? null) as ModelResolver;
  resolveModels.resolveEntries = resolveEntries;
  return resolveModels;
}

export const resolveProviderModels = createModelResolver();
export const resolveProviderModelEntries = resolveProviderModels.resolveEntries;

export function resetModelResolveStateForTests(): void {
  memoryCache.clear();
  memoryKeyBySlot.clear();
  inFlight.clear();
  latestApplyTokenBySlot.clear();
  latestCacheKeyBySlot.clear();
  applyTokenSequence = 0;
  storeLoad = null;
  storeWrite = Promise.resolve();
}
