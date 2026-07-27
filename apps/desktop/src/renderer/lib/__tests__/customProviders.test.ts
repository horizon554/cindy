import { afterEach, describe, expect, it, vi } from 'vitest';

import { customProviderSecretStorageKey } from '@/../shared/providerSecrets';

import {
  appendDiscoveredCustomProviderModels,
  createCustomProvider,
  customProviderModelConfigFromCatalogModel,
  providerViewToCustomProviderConfig,
  replaceCustomProviderModelId,
  updateCustomProvider,
} from '../customProviders';
import type { ProviderView } from '@cindy/model-providers';
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('replaceCustomProviderModelId', () => {
  it('drops hidden metadata when the model id changes', () => {
    expect(replaceCustomProviderModelId({
      id: 'MiniMax-M3',
      name: 'MiniMax M3',
      contextWindow: 1_000_000,
    }, 'another-model')).toEqual({
      id: 'another-model',
      name: 'MiniMax M3',
    });
  });

  it('preserves the original model when the id is unchanged', () => {
    const model = {
      id: 'MiniMax-M3',
      name: 'MiniMax M3',
      contextWindow: 1_000_000,
    };
    expect(replaceCustomProviderModelId(model, model.id)).toBe(model);
  });
});

describe('customProviderModelConfigFromCatalogModel', () => {
  it('does not freeze the materialized custom-provider default into user config', () => {
    expect(customProviderModelConfigFromCatalogModel({
      id: 'default-context',
      name: 'Default Context',
      contextWindow: 200_000,
    })).toEqual({
      id: 'default-context',
      name: 'Default Context',
    });
  });

  it('preserves a provider-specific non-default context window', () => {
    expect(customProviderModelConfigFromCatalogModel({
      id: 'MiniMax-M3',
      name: 'MiniMax M3',
      contextWindow: 1_000_000,
    })).toEqual({
      id: 'MiniMax-M3',
      name: 'MiniMax M3',
      contextWindow: 1_000_000,
    });
  });

  it('preserves hidden defaults while round-tripping catalog models', () => {
    expect(customProviderModelConfigFromCatalogModel({
      id: 'discovered',
      name: 'Discovered',
      contextWindow: 200_000,
      defaultEnabled: false,
    })).toEqual({
      id: 'discovered',
      name: 'Discovered',
      defaultEnabled: false,
    });
  });
});

describe('providerViewToCustomProviderConfig', () => {
  it('preserves no-auth and exact request-path fields through the edit round trip', () => {
    const provider = {
      id: 'local-chat',
      name: 'Local Chat',
      source: 'user',
      agents: ['codex'],
      auth: { method: 'none' },
      access: { kind: 'api' },
      routing: {
        codex: {
          upstream: 'http://127.0.0.1:4000/v1',
          authStrategy: 'none',
          wireProtocol: 'openai-chat',
          requestPath: '/tenant/acme/infer?stream=1',
          modelsUrl: 'http://127.0.0.1:4000/v1/models',
        },
      },
      models: {
        codex: [{
          id: 'local-model',
          name: 'Local Model',
          contextWindow: 200_000,
          efforts: [],
          defaultEffort: null,
        }],
      },
      connected: true,
    } satisfies ProviderView;

    expect(providerViewToCustomProviderConfig(provider)).toEqual({
      id: 'local-chat',
      name: 'Local Chat',
      auth: { method: 'none' },
      runtimes: {
        codex: {
          baseUrl: 'http://127.0.0.1:4000/v1',
          requestPath: '/tenant/acme/infer?stream=1',
          wireProtocol: 'openai-chat',
          modelsUrl: 'http://127.0.0.1:4000/v1/models',
          models: [{ id: 'local-model', name: 'Local Model' }],
        },
      },
    });
  });
});

describe('appendDiscoveredCustomProviderModels', () => {
  it('only appends unknown models and defaults them to hidden', () => {
    const result = appendDiscoveredCustomProviderModels(
      [{ id: 'kept', name: 'Kept' }],
      [
        { id: 'kept', name: 'New name' },
        { id: 'new', name: 'New' },
        { id: 'new', name: 'Duplicate new' },
        { id: '', name: 'Invalid' },
      ],
    );
    expect(result).toEqual({
      models: [
        { id: 'kept', name: 'Kept' },
        { id: 'new', name: 'New', defaultEnabled: false },
      ],
      addedIds: ['new'],
    });
  });
});

describe('custom provider credential lifecycle', () => {
  it('never stores supplied API keys for a no-auth provider', async () => {
    const safeStorageStore = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: {
        maker: { createCustomProvider: vi.fn(async () => ({ ok: true })) },
        safeStorageStore,
      },
    });

    await createCustomProvider({
      id: 'local',
      name: 'Local',
      auth: { method: 'none' },
      runtimes: {
        codex: {
          baseUrl: 'http://127.0.0.1:4000/v1',
          models: [{ id: 'local-model', name: 'Local Model' }],
        },
      },
    }, { codex: 'must-not-be-stored' });

    expect(safeStorageStore).not.toHaveBeenCalled();
  });

  it('rolls back a newly created provider and partial keys when credential storage fails', async () => {
    const create = vi.fn(async () => ({ ok: true }));
    const removeProvider = vi.fn(async () => ({ ok: true }));
    const safeStorageStore = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const safeStorageRemove = vi.fn(async () => true);
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          createCustomProvider: create,
          deleteCustomProvider: removeProvider,
        },
        safeStorageStore,
        safeStorageRemove,
      },
    });
    const config = {
      id: 'partial-create',
      name: 'Partial create',
      auth: { method: 'apiKey' as const },
      runtimes: {
        'claude-code': {
          baseUrl: 'https://api.example/v1',
          models: [{ id: 'claude-model', name: 'Claude model' }],
        },
        codex: {
          baseUrl: 'https://api.example/v1',
          models: [{ id: 'codex-model', name: 'Codex model' }],
        },
      },
    };

    await expect(createCustomProvider(config, {
      'claude-code': 'first-key',
      codex: 'second-key',
    })).rejects.toThrow('Failed to store codex provider credential');

    expect(create).toHaveBeenCalledWith(config);
    expect(removeProvider).toHaveBeenCalledWith(config.id);
    expect(safeStorageRemove).toHaveBeenCalledTimes(2);
    expect(safeStorageRemove).toHaveBeenNthCalledWith(
      1,
      customProviderSecretStorageKey(config.id, 'claude-code'),
    );
    expect(safeStorageRemove).toHaveBeenNthCalledWith(
      2,
      customProviderSecretStorageKey(config.id, 'codex'),
    );
  });

  it('submits replacement keys with the config through one main-process mutation', async () => {
    const update = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('window', {
      electronAPI: {
        maker: { updateCustomProvider: update },
      },
    });

    const config = {
      id: 'switch-to-key',
      name: 'Switch to key',
      auth: { method: 'apiKey' as const },
      runtimes: {
        codex: {
          baseUrl: 'https://api.example/v1',
          models: [{ id: 'm1', name: 'M1' }],
        },
      },
    };
    await updateCustomProvider(
      config,
      { codex: 'replacement-key' },
    );

    expect(update).toHaveBeenCalledWith(config, { codex: 'replacement-key' });
  });

  it('surfaces an atomic main-process update failure', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          updateCustomProvider: vi.fn().mockRejectedValue(new Error('credential rollback failed')),
        },
      },
    });

    await expect(
      updateCustomProvider(
        {
          id: 'switch-to-key',
          name: 'Switch to key',
          auth: { method: 'apiKey' },
          runtimes: {
            codex: {
              baseUrl: 'https://api.example/v1',
              models: [{ id: 'm1', name: 'M1' }],
            },
          },
        },
        { codex: 'replacement-key' },
      ),
    ).rejects.toThrow('credential rollback failed');
  });
});
