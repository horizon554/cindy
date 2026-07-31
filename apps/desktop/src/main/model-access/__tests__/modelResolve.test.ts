import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/unused' },
}));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: () => 'https://models.example.test',
}));
vi.mock('../../serverApiClient.js', () => ({
  serverApiFetch: vi.fn(),
}));

import {
  createModelResolver,
  modelResolveCacheKey,
  modelResolveRealm,
  resetModelResolveStateForTests,
  type ModelResolveInput,
} from '../modelResolve.js';

const INPUT: ModelResolveInput = {
  providerId: 'acme',
  agent: 'codex',
  wireProtocol: 'openai-responses',
  models: [{ id: 'model-a', name: 'Model A' }],
};

function response(revision = 'r1') {
  return {
    schemaVersion: 2,
    knowledgeRevision: revision,
    entries: [{
      providerId: 'acme',
      agent: 'codex',
      models: [{
        id: 'model-a',
        name: 'Model A',
        contextWindow: 128_000,
        efforts: ['high'],
        defaultEffort: 'high',
      }],
    }],
  };
}

function harness(options: {
  baseUrl?: string;
  disk?: string | null;
  fetch?: () => Promise<unknown>;
  disabled?: boolean;
} = {}) {
  let disk = options.disk ?? null;
  const calls = {
    fetch: vi.fn(options.fetch ?? (async () => response())),
    readFile: vi.fn(async () => {
      if (disk === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return disk;
    }),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (_path: string, text: string) => { disk = text; }),
    rename: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    getBaseUrl: vi.fn(() => options.baseUrl ?? 'https://models.example.test/api'),
    getUserDataDir: vi.fn(() => '/tmp/model-resolve-test'),
    disabled: vi.fn(() => options.disabled === true),
  };
  return { resolve: createModelResolver(calls), calls, disk: () => disk };
}

afterEach(() => {
  resetModelResolveStateForTests();
});

describe('model resolve client', () => {
  it('keys the cache by provider, agent, and ordered model-id hash', () => {
    expect(modelResolveCacheKey(INPUT)).toBe(modelResolveCacheKey({ ...INPUT }));
    expect(modelResolveCacheKey(INPUT)).not.toBe(
      modelResolveCacheKey({ ...INPUT, agent: 'claude-code' }),
    );
    expect(modelResolveCacheKey(INPUT)).not.toBe(
      modelResolveCacheKey({ ...INPUT, models: [{ id: 'model-b' }] }),
    );
  });

  it('normalizes the endpoint realm to the base host', () => {
    expect(modelResolveRealm('https://Models.Example.test:8443/path')).toBe(
      'models.example.test:8443',
    );
    expect(modelResolveRealm('not a URL')).toBeNull();
  });

  it('strictly validates the response and degrades to null', async () => {
    const h = harness({ fetch: async () => ({ ...response(), schemaVersion: 1 }) });
    await expect(h.resolve(INPUT)).resolves.toBeNull();
    expect(h.calls.writeFile).not.toHaveBeenCalled();
  });

  it('uses matching last-known-good when a refresh response is structurally invalid', async () => {
    const key = modelResolveCacheKey(INPUT);
    const disk = JSON.stringify({
      version: 1,
      entries: [{
        key,
        realm: 'models.example.test',
        knowledgeRevision: 'r1',
        response: response(),
      }],
    });
    const h = harness({ disk, fetch: async () => ({ ...response('broken'), schemaVersion: 1 }) });
    await expect(h.resolve(INPUT)).resolves.toMatchObject({ knowledgeRevision: 'r1' });
    expect(h.calls.writeFile).not.toHaveBeenCalled();
  });

  it('single-flights identical requests and persists last-known-good atomically', async () => {
    let release!: (value: unknown) => void;
    const h = harness({ fetch: () => new Promise((resolve) => { release = resolve; }) });
    const first = h.resolve(INPUT);
    const second = h.resolve(INPUT);
    await vi.waitFor(() => expect(h.calls.fetch).toHaveBeenCalledOnce());
    release(response());
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ knowledgeRevision: 'r1' }),
      expect.objectContaining({ knowledgeRevision: 'r1' }),
    ]);
    expect(h.calls.writeFile).toHaveBeenCalledOnce();
    expect(h.calls.rename).toHaveBeenCalledOnce();
    expect(h.disk()).toContain('"knowledgeRevision":"r1"');
  });

  it('uses matching-realm last-known-good only when refresh fails', async () => {
    const key = modelResolveCacheKey(INPUT);
    const disk = JSON.stringify({
      version: 1,
      entries: [{
        key,
        realm: 'models.example.test',
        knowledgeRevision: 'r1',
        response: response(),
      }],
    });
    const matching = harness({ disk, fetch: async () => { throw new Error('offline'); } });
    await expect(matching.resolve(INPUT)).resolves.toMatchObject({ knowledgeRevision: 'r1' });

    resetModelResolveStateForTests();
    const mismatched = harness({
      disk,
      baseUrl: 'https://other.example.test',
      fetch: async () => { throw new Error('offline'); },
    });
    await expect(mismatched.resolve(INPUT)).resolves.toBeNull();
  });

  it('disabled flag performs no endpoint, disk, network, or write side effects', async () => {
    const h = harness({ disabled: true });
    await expect(h.resolve(INPUT)).resolves.toBeNull();
    expect(h.calls.getBaseUrl).not.toHaveBeenCalled();
    expect(h.calls.getUserDataDir).not.toHaveBeenCalled();
    expect(h.calls.readFile).not.toHaveBeenCalled();
    expect(h.calls.fetch).not.toHaveBeenCalled();
    expect(h.calls.writeFile).not.toHaveBeenCalled();
  });
});
