import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildUserProvider, type Catalog } from '@cindy/model-providers';
import { afterEach, describe, expect, it } from 'vitest';

import {
  codexModelCatalogStatePath,
  readNativeCodexModelsFromCache,
  writeCodexModelCatalogCache,
} from '../codex-model-catalog-cache.js';
import { CodexModelCatalogNeedsNativeModelsError } from '../codex-model-catalog-sync.js';

const roots: string[] = [];

function catalogWithModel(): Catalog {
  return {
    version: 'test',
    providers: [buildUserProvider({
      id: 'deepseek',
      name: 'DeepSeek',
      auth: { method: 'apiKey' },
      runtimes: {
        codex: {
          baseUrl: 'https://api.deepseek.invalid/v1',
          models: [{
            id: 'deepseek-v4-pro',
            name: 'DeepSeek V4 Pro',
            contextWindow: 256_000,
          }],
        },
      },
    })],
  } as Catalog;
}

function nativeModel() {
  return {
    slug: 'gpt-template',
    display_name: 'GPT Template',
    base_instructions: 'native prompt',
    supported_in_api: true,
  };
}

async function createHome(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-codex-catalog-'));
  roots.push(root);
  return root;
}

async function writeVendorCache(codexHome: string, models: unknown[]): Promise<void> {
  await fsp.writeFile(path.join(codexHome, 'models_cache.json'), JSON.stringify({
    fetched_at: '2026-08-04T00:00:00.000Z',
    etag: 'native',
    client_version: '0.145.0',
    models,
  }));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe('Codex model catalog cache', () => {
  it('keeps Cindy provenance in a sidecar while leaving the vendor cache schema clean', async () => {
    const codexHome = await createHome();
    await writeVendorCache(codexHome, [nativeModel()]);

    await writeCodexModelCatalogCache({
      codexHome,
      catalog: catalogWithModel(),
      revision: 7,
      now: new Date('2026-08-04T01:00:00.000Z'),
    });

    const vendor = JSON.parse(await fsp.readFile(path.join(codexHome, 'models_cache.json'), 'utf8'));
    const state = JSON.parse(await fsp.readFile(codexModelCatalogStatePath(codexHome), 'utf8'));
    expect(vendor).not.toHaveProperty('cindy_injected_slugs');
    expect(vendor.models.map((model: { slug: string }) => model.slug)).toContain('deepseek-v4-pro');
    expect(state).toEqual({ revision: 7, injectedSlugs: ['deepseek-v4-pro'] });
    expect(readNativeCodexModelsFromCache(codexHome)?.map((model) => model.slug))
      .toEqual(['gpt-template']);
  });

  it('removes stale injected models after Codex rewrites the vendor cache and drops unknown fields', async () => {
    const codexHome = await createHome();
    await writeVendorCache(codexHome, [nativeModel()]);
    await writeCodexModelCatalogCache({
      codexHome,
      catalog: catalogWithModel(),
      revision: 1,
    });

    // Simulate Codex 0.145 persist_cache: only vendor fields survive, while the
    // Cindy sidecar remains beside the rewritten file.
    const rewritten = JSON.parse(await fsp.readFile(path.join(codexHome, 'models_cache.json'), 'utf8'));
    await writeVendorCache(codexHome, rewritten.models);
    await writeCodexModelCatalogCache({
      codexHome,
      catalog: { version: 'test', providers: [] } as Catalog,
      revision: 2,
    });

    const next = JSON.parse(await fsp.readFile(path.join(codexHome, 'models_cache.json'), 'utf8'));
    const state = JSON.parse(await fsp.readFile(codexModelCatalogStatePath(codexHome), 'utf8'));
    expect(next.models.map((model: { slug: string }) => model.slug)).toEqual(['gpt-template']);
    expect(state).toEqual({ revision: 2, injectedSlugs: [] });
  });

  it('uses an observed native snapshot to recover provenance after first-run warm-up', async () => {
    const codexHome = await createHome();
    const synthetic = {
      ...nativeModel(),
      slug: 'deepseek-v4-pro',
      display_name: 'DeepSeek V4 Pro',
    };
    // The first model/list response has already been persisted by Codex, so the
    // vendor file contains native + synthetic entries but no Cindy sidecar yet.
    await writeVendorCache(codexHome, [nativeModel(), synthetic]);

    await writeCodexModelCatalogCache({
      codexHome,
      catalog: catalogWithModel(),
      revision: 3,
      nativeModels: [nativeModel()],
    });

    const state = JSON.parse(await fsp.readFile(codexModelCatalogStatePath(codexHome), 'utf8'));
    expect(state.injectedSlugs).toEqual(['deepseek-v4-pro']);
    expect(readNativeCodexModelsFromCache(codexHome)?.map((model) => model.slug))
      .toEqual(['gpt-template']);
  });

  it('requires Codex model/list warm-up for a missing or malformed vendor cache', async () => {
    const codexHome = await createHome();
    await expect(writeCodexModelCatalogCache({
      codexHome,
      catalog: catalogWithModel(),
      revision: 1,
    })).rejects.toBeInstanceOf(CodexModelCatalogNeedsNativeModelsError);

    await fsp.writeFile(path.join(codexHome, 'models_cache.json'), '{broken');
    await expect(writeCodexModelCatalogCache({
      codexHome,
      catalog: catalogWithModel(),
      revision: 1,
    })).rejects.toBeInstanceOf(CodexModelCatalogNeedsNativeModelsError);
  });
});
