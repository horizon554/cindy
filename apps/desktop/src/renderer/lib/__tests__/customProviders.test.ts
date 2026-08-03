import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendDiscoveredCustomProviderModels,
  createCustomProvider,
  customProviderModelConfigFromCatalogModel,
  providerViewToCustomProviderConfig,
  replaceCustomProviderModelId,
  setCustomProviderModelReasoning,
  setCustomProviderModelReasoningEffort,
  setCustomProviderModelSupportsImageInput,
  updateCustomProvider,
} from '../customProviders';
import type {
  CatalogModel,
  ProviderRuntimeModelConfig,
  ProviderView,
} from '@cindy/model-providers';
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('replaceCustomProviderModelId', () => {
  it('drops hidden metadata when the model id changes', () => {
    expect(replaceCustomProviderModelId({
      id: 'MiniMax-M3',
      name: 'MiniMax M3',
      contextWindow: 1_000_000,
      supportsImageInput: true,
      reasoning: true,
      reasoningEfforts: ['low', 'high'],
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

describe('setCustomProviderModelSupportsImageInput', () => {
  it('updates only the selected model row', () => {
    const models = [
      { id: 'text', name: 'Text' },
      { id: 'vision', name: 'Vision' },
    ];
    expect(setCustomProviderModelSupportsImageInput(models, 1, true)).toEqual([
      models[0],
      { id: 'vision', name: 'Vision', supportsImageInput: true },
    ]);
  });
});

describe('Pi custom-provider reasoning controls', () => {
  it('enables conservative default levels and removes the capability when disabled', () => {
    const models = [{ id: 'reasoner', name: 'Reasoner' }];
    const enabled = setCustomProviderModelReasoning(models, 0, true);
    expect(enabled).toEqual([
      {
        id: 'reasoner',
        name: 'Reasoner',
        reasoning: true,
        reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
      },
    ]);
    expect(setCustomProviderModelReasoning(enabled, 0, false)).toEqual(models);
  });

  it('keeps canonical order and refuses to remove the final supported effort', () => {
    const models: ProviderRuntimeModelConfig[] = [
      {
        id: 'reasoner',
        name: 'Reasoner',
        reasoning: true,
        reasoningEfforts: ['high'],
      },
    ];
    const withXhigh = setCustomProviderModelReasoningEffort(models, 0, 'xhigh', true);
    expect(withXhigh[0]?.reasoningEfforts).toEqual(['high', 'xhigh']);
    const highOnly = setCustomProviderModelReasoningEffort(withXhigh, 0, 'xhigh', false);
    expect(setCustomProviderModelReasoningEffort(highOnly, 0, 'high', false)).toEqual(highOnly);
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

  it('preserves an explicit override equal to the current default (explicit flag wins)', () => {
    // 用户显式填了 200000:值恰好等于当前默认,但显式覆盖必须在未来默认升级后
    // 原样保留——不能靠等值推断丢掉字段(PR review P1)。
    expect(customProviderModelConfigFromCatalogModel({
      id: 'pinned-default',
      name: 'Pinned',
      contextWindow: 200_000,
      contextWindowExplicit: true,
    })).toEqual({
      id: 'pinned-default',
      name: 'Pinned',
      contextWindow: 200_000,
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

  it('preserves an explicit Pi image-input capability through the edit round trip', () => {
    expect(customProviderModelConfigFromCatalogModel({
      id: 'vision-model',
      name: 'Vision Model',
      contextWindow: 200_000,
      supportsImageInput: true,
    })).toEqual({
      id: 'vision-model',
      name: 'Vision Model',
      supportsImageInput: true,
    });
  });

  it('reconstructs explicit Pi reasoning capability from catalog efforts only for Pi', () => {
    const catalogModel = {
      id: 'reasoner',
      name: 'Reasoner',
      contextWindow: 200_000,
      efforts: ['low', 'high', 'xhigh'] as CatalogModel['efforts'],
    };
    expect(customProviderModelConfigFromCatalogModel(catalogModel, 'pi')).toEqual({
      id: 'reasoner',
      name: 'Reasoner',
      reasoning: true,
      reasoningEfforts: ['low', 'high', 'xhigh'],
    });
    expect(customProviderModelConfigFromCatalogModel(catalogModel, 'codex')).toEqual({
      id: 'reasoner',
      name: 'Reasoner',
    });
  });

  it('preserves provider modalities/capabilities through the edit round trip', () => {
    expect(customProviderModelConfigFromCatalogModel({
      id: 'vlm',
      name: 'VLM',
      contextWindow: 1_048_576,
      modalities: { input: ['text', 'image'], output: ['text'] },
      capabilities: { reasoning: true, toolCall: true },
    })).toEqual({
      id: 'vlm',
      name: 'VLM',
      contextWindow: 1_048_576,
      modalities: { input: ['text', 'image'], output: ['text'] },
      capabilities: { reasoning: true, toolCall: true },
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

  it('round-trips Pi reasoning efforts from a provider view', () => {
    const provider = {
      id: 'local-reasoning',
      name: 'Local Reasoning',
      source: 'user',
      agents: ['pi'],
      auth: { method: 'none' },
      access: { kind: 'api' },
      routing: {
        pi: {
          upstream: 'http://127.0.0.1:4000/v1',
          authStrategy: 'none',
          wireProtocol: 'openai-responses',
        },
      },
      models: {
        pi: [
          {
            id: 'reasoner',
            name: 'Reasoner',
            contextWindow: 200_000,
            efforts: ['low', 'high', 'xhigh'],
            defaultEffort: 'high',
          },
        ],
      },
      connected: true,
    } satisfies ProviderView;

    expect(providerViewToCustomProviderConfig(provider).runtimes.pi?.models).toEqual([
      {
        id: 'reasoner',
        name: 'Reasoner',
        reasoning: true,
        reasoningEfforts: ['low', 'high', 'xhigh'],
      },
    ]);
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
      changed: true,
    });
  });

  // #386「端点声明的 contextWindow 随发现落盘」的入参形状已改为 providerReported,
  // 同语义由下面 'persists provider-reported contextWindow into the config' 覆盖
  // (含非正数忽略),不再保留旧形状的重复用例。

  it('backfills provider-reported contextWindow onto existing models that lack one', () => {
    const result = appendDiscoveredCustomProviderModels(
      [
        { id: 'has', name: 'Has', contextWindow: 128_000 }, // 已有值 → 不覆盖
        { id: 'gap', name: 'Gap' }, // 缺失 + 厂商上报 → 回填
        { id: 'nogap', name: 'NoGap' }, // 缺失但厂商未上报 → 不动
      ],
      [
        { id: 'has', name: 'Has', providerReported: { contextWindow: 999_999 } },
        { id: 'gap', name: 'Gap', providerReported: { contextWindow: 1_000_000 } },
        { id: 'nogap', name: 'NoGap' },
      ],
    );
    expect(result).toEqual({
      models: [
        { id: 'has', name: 'Has', contextWindow: 128_000 },
        { id: 'gap', name: 'Gap', contextWindow: 1_000_000 },
        { id: 'nogap', name: 'NoGap' },
      ],
      addedIds: [],
      changed: true,
    });
  });

  it('reports changed=false when there is nothing to add or backfill', () => {
    const result = appendDiscoveredCustomProviderModels(
      [{ id: 'a', name: 'A', contextWindow: 128_000 }],
      [{ id: 'a', name: 'A', providerReported: { contextWindow: 999_999 } }],
    );
    expect(result).toEqual({
      models: [{ id: 'a', name: 'A', contextWindow: 128_000 }],
      addedIds: [],
      changed: false,
    });
  });

  it('persists provider-reported contextWindow into the config (survives restart / feeds save-resolve)', () => {
    const result = appendDiscoveredCustomProviderModels(
      [],
      [
        { id: 'a', name: 'A', providerReported: { contextWindow: 1_000_000 } },
        { id: 'b', name: 'B' }, // 无上报 → 不写假窗口
        { id: 'c', name: 'C', providerReported: { contextWindow: 0 } }, // 非正数忽略
      ],
    );
    expect(result.models).toEqual([
      { id: 'a', name: 'A', defaultEnabled: false, contextWindow: 1_000_000 },
      { id: 'b', name: 'B', defaultEnabled: false },
      { id: 'c', name: 'C', defaultEnabled: false },
    ]);
  });

  it('persists provider-reported modalities/capabilities on new models, narrowing unknown capability keys', () => {
    const result = appendDiscoveredCustomProviderModels(
      [],
      [
        {
          id: 'vlm',
          name: 'VLM',
          providerReported: {
            contextWindow: 1_048_576,
            modalities: { input: ['text', 'image'], output: ['text'] },
            // 宽松上报:只保留已知 boolean 键,丢弃未知键与非 boolean。
            capabilities: { reasoning: true, toolCall: false, bogus: 'x', temperature: 1 },
          },
        },
      ],
    );
    expect(result.models).toEqual([
      {
        id: 'vlm',
        name: 'VLM',
        defaultEnabled: false,
        contextWindow: 1_048_576,
        modalities: { input: ['text', 'image'], output: ['text'] },
        capabilities: { reasoning: true, toolCall: false },
      },
    ]);
    expect(result.changed).toBe(true);
  });

  it('backfills modalities/capabilities onto existing models that lack them, per field', () => {
    const result = appendDiscoveredCustomProviderModels(
      [
        // 已有 modalities → 不覆盖;缺 capabilities → 回填。
        { id: 'has-mod', name: 'HasMod', modalities: { input: ['text'], output: ['text'] } },
        // 三者皆缺 → 全部回填。
        { id: 'bare', name: 'Bare' },
      ],
      [
        {
          id: 'has-mod',
          name: 'HasMod',
          providerReported: {
            modalities: { input: ['text', 'image'], output: ['text'] }, // 应被忽略(已有)
            capabilities: { toolCall: true },
          },
        },
        {
          id: 'bare',
          name: 'Bare',
          providerReported: {
            contextWindow: 262_144,
            modalities: { input: ['text'], output: ['text'] },
            capabilities: { reasoning: true },
          },
        },
      ],
    );
    expect(result.models).toEqual([
      {
        id: 'has-mod',
        name: 'HasMod',
        modalities: { input: ['text'], output: ['text'] },
        capabilities: { toolCall: true },
      },
      {
        id: 'bare',
        name: 'Bare',
        contextWindow: 262_144,
        modalities: { input: ['text'], output: ['text'] },
        capabilities: { reasoning: true },
      },
    ]);
    expect(result.addedIds).toEqual([]);
    expect(result.changed).toBe(true);
  });
});

describe('custom provider credential lifecycle', () => {
  it('submits create config and keys through one main-process mutation', async () => {
    const create = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('window', {
      electronAPI: {
        maker: { createCustomProvider: create },
      },
    });

    const config = {
      id: 'new-provider',
      name: 'New provider',
      auth: { method: 'apiKey' as const },
      runtimes: {
        codex: {
          baseUrl: 'https://api.example/v1',
          models: [{ id: 'model', name: 'Model' }],
        },
      },
    };
    const keys = { codex: 'new-key' };
    await createCustomProvider(config, keys);

    expect(create).toHaveBeenCalledWith(config, keys);
  });

  it('surfaces an atomic main-process create failure', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          createCustomProvider: vi.fn().mockRejectedValue(
            new Error('credential staging failed'),
          ),
        },
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
    })).rejects.toThrow('credential staging failed');
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
