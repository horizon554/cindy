import { afterEach, describe, expect, it, vi } from 'vitest';

import { BUNDLED_CATALOG, buildUserProvider } from '@cindy/model-providers';

import {
  clearResolvedProviderModels,
  commitModelPlaneFromCatalog,
  getActiveCatalog,
  getActiveCatalogRevision,
  setActiveCatalog,
  setActiveCatalogChangedListener,
  setAnthropicDiscoveredModels,
  setCustomProviders,
  setDiscoveredCodexModels,
  setDiscoveredProviderModels,
  setResolvedProviderModels,
} from '../active-catalog.js';

describe('active catalog revision', () => {
  afterEach(() => {
    setActiveCatalogChangedListener(null);
    setActiveCatalog(BUNDLED_CATALOG);
    setAnthropicDiscoveredModels([]);
    setCustomProviders([]);
    setDiscoveredCodexModels([]);
    setDiscoveredProviderModels('xai', 'codex', []);
    clearResolvedProviderModels();
  });

  it('invalidates the merged catalog before notifying one monotonic revision', () => {
    const start = getActiveCatalogRevision();
    const listener = vi.fn((revision: number) => ({
      revision,
      ids: getActiveCatalog()
        .providers.find((provider) => provider.id === 'openai')
        ?.models.codex?.map((model) => model.id),
    }));
    setActiveCatalogChangedListener(listener);

    setDiscoveredCodexModels([
      {
        id: 'gpt-next-live',
        name: 'GPT Next Live',
        contextWindow: 300_000,
        efforts: ['high'],
        defaultEffort: 'high',
      },
    ]);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.results[0]?.value).toMatchObject({ revision: start + 1 });
    expect(listener.mock.results[0]?.value.ids).toContain('gpt-next-live');
  });

  it('routes Anthropic discovery through the same revision listener', () => {
    const start = getActiveCatalogRevision();
    const listener = vi.fn((revision: number) => ({
      revision,
      ids: getActiveCatalog()
        .providers.find((provider) => provider.id === 'anthropic')
        ?.models['claude-code']?.map((model) => model.id),
    }));
    setActiveCatalogChangedListener(listener);

    setAnthropicDiscoveredModels([
      {
        id: 'claude-opus-next',
        name: 'Claude Opus Next',
        contextWindow: 1_000_000,
        efforts: ['high'],
        defaultEffort: 'high',
      },
    ]);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.results[0]?.value).toMatchObject({ revision: start + 1 });
    expect(listener.mock.results[0]?.value.ids).toContain('claude-opus-next');
  });

  it('resolved overlay changes fields without adding, deleting, or reordering discovery membership', () => {
    const discovery = [
      {
        id: 'xai/resolved-a',
        name: 'Fallback A',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
      },
      {
        id: 'xai/plain-b',
        name: 'Plain B',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
      },
    ];
    setDiscoveredProviderModels('xai', 'codex', discovery);
    setResolvedProviderModels(
      'xai',
      'codex',
      ['xai/resolved-a'],
      [
        {
          ...discovery[0],
          name: 'Resolved A',
          contextWindow: 1_000_000,
          efforts: ['high'],
          defaultEffort: 'high',
          group: 'grok',
        },
        {
          id: 'xai/must-not-be-added',
          name: 'Must Not Be Added',
          contextWindow: 1,
          efforts: [],
          defaultEffort: null,
        },
      ],
      'knowledge-r1',
      getActiveCatalog().providers.find((provider) => provider.id === 'xai')!.models.codex!
        .map((model) => model.id),
    );

    const models = getActiveCatalog().providers.find((provider) => provider.id === 'xai')!
      .models.codex!;
    expect(models.filter((model) => discovery.some((item) => item.id === model.id)).map((m) => m.id))
      .toEqual(['xai/resolved-a', 'xai/plain-b']);
    expect(models.some((model) => model.id === 'xai/must-not-be-added')).toBe(false);
    expect(models.find((model) => model.id === 'xai/resolved-a')).toMatchObject({
      name: 'Resolved A',
      contextWindow: 1_000_000,
      source: 'resolved',
      knowledgeRevision: 'knowledge-r1',
    });
    expect(models.find((model) => model.id === 'xai/plain-b')).not.toHaveProperty('source');

    setDiscoveredProviderModels('xai', 'codex', [...discovery, {
      id: 'xai/newer-c',
      name: 'Newer C',
      contextWindow: 200_000,
      efforts: [],
      defaultEffort: null,
    }]);
    const refreshed = getActiveCatalog().providers.find((provider) => provider.id === 'xai')!
      .models.codex!;
    expect(refreshed.find((model) => model.id === 'xai/resolved-a')).not.toHaveProperty('source');
  });

  it('applies resolved metadata when additions-only discovery preserves a different live order', () => {
    const providerId = 'reordered-user';
    const configured = [
      {
        id: 'vendor/pinned-first',
        name: 'Pinned First',
      },
      {
        id: 'vendor/upstream-first',
        name: 'Upstream First',
      },
    ];
    setCustomProviders([buildUserProvider({
      id: providerId,
      name: 'Reordered User Provider',
      runtimes: {
        codex: {
          baseUrl: 'https://models.example/v1',
          models: configured,
        },
      },
    })]);
    const liveModels = getActiveCatalog().providers.find((provider) => provider.id === providerId)!
      .models.codex!;

    setResolvedProviderModels(
      providerId,
      'codex',
      ['vendor/upstream-first', 'vendor/pinned-first'],
      [
        { ...liveModels[1], category: 'gpt' },
        { ...liveModels[0], category: 'anthropic' },
      ],
      'knowledge-reordered',
      ['vendor/upstream-first', 'vendor/pinned-first'],
    );

    const models = getActiveCatalog().providers.find((provider) => provider.id === providerId)!
      .models.codex!;
    expect(models.map((model) => model.id)).toEqual([
      'vendor/pinned-first',
      'vendor/upstream-first',
    ]);
    expect(models.map((model) => model.category)).toEqual(['anthropic', 'gpt']);
    expect(models.every((model) => model.source === 'resolved')).toBe(true);
  });

  it('clears resolved metadata without changing live discovery membership', () => {
    const discovery = [{
      id: 'xai/account-bound',
      name: 'Discovery Name',
      contextWindow: 200_000,
      efforts: [],
      defaultEffort: null,
    }];
    setDiscoveredProviderModels('xai', 'codex', discovery);
    const allIds = getActiveCatalog().providers.find((provider) => provider.id === 'xai')!
      .models.codex!.map((model) => model.id);
    setResolvedProviderModels(
      'xai',
      'codex',
      discovery.map((model) => model.id),
      [{ ...discovery[0], name: 'Resolved Name', category: 'grok' }],
      'account-a-revision',
      allIds,
    );
    expect(
      getActiveCatalog().providers.find((provider) => provider.id === 'xai')!
        .models.codex!.find((model) => model.id === 'xai/account-bound'),
    ).toMatchObject({ name: 'Resolved Name', source: 'resolved' });

    clearResolvedProviderModels();

    const afterClear = getActiveCatalog().providers.find((provider) => provider.id === 'xai')!
      .models.codex!;
    expect(afterClear.map((model) => model.id)).toEqual(allIds);
    expect(afterClear.find((model) => model.id === 'xai/account-bound')).toMatchObject({
      name: 'Discovery Name',
    });
    expect(afterClear.find((model) => model.id === 'xai/account-bound')).not.toHaveProperty('source');
  });

  it('refreshes one provider model snapshot without replacing live routing or other providers', () => {
    // registry-free 克隆:本用例只验「换模型快照不换路由」机制,隔离 registry 实体化层。
    const current = structuredClone(BUNDLED_CATALOG);
    delete (current as { modelRegistry?: unknown }).modelRegistry;
    const incoming = structuredClone(current);
    const currentXai = current.providers.find((provider) => provider.id === 'xai');
    const incomingXai = incoming.providers.find((provider) => provider.id === 'xai');
    const currentOpenAi = current.providers.find((provider) => provider.id === 'openai');
    const incomingOpenAi = incoming.providers.find((provider) => provider.id === 'openai');
    if (!currentXai || !incomingXai || !currentOpenAi || !incomingOpenAi) {
      throw new Error('expected bundled xai/openai providers');
    }
    currentXai.routing.codex = {
      ...currentXai.routing.codex!,
      upstream: 'https://current-routing.example.com/v1',
    };
    incomingXai.routing.codex = {
      ...incomingXai.routing.codex!,
      upstream: 'https://incoming-routing.example.com/v1',
    };
    incomingXai.models.codex = [
      {
        id: 'xai/new-model',
        name: 'New xAI Model',
        contextWindow: 256_000,
        efforts: ['high'],
        defaultEffort: 'high',
      },
    ];
    incomingOpenAi.models.codex = [
      {
        id: 'should-not-replace-openai',
        name: 'Should Not Replace OpenAI',
        contextWindow: 1,
        efforts: [],
        defaultEffort: null,
      },
    ];

    setActiveCatalog(current);
    commitModelPlaneFromCatalog(incoming);

    const active = getActiveCatalog();
    expect(active.providers.find((provider) => provider.id === 'xai')?.models.codex).toEqual(
      incomingXai.models.codex,
    );
    expect(active.providers.find((provider) => provider.id === 'xai')?.routing.codex).toEqual(
      currentXai.routing.codex,
    );
    expect(active.providers.find((provider) => provider.id === 'openai')?.models.codex).toEqual(
      currentOpenAi.models.codex,
    );
  });
});
