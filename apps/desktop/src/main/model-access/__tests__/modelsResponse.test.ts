import { describe, expect, it } from 'vitest';

import { normalizeGatewayModelsPayload } from '../modelsResponse.js';

const MODEL = {
  id: 'gpt-5.5',
  currency: 'USD',
  agents: ['codex'],
  name: 'GPT-5.5',
  contextWindow: 272_000,
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'high',
};

function v2(models: unknown[]) {
  return { schemaVersion: 2, models };
}

describe('normalizeGatewayModelsPayload', () => {
  it('strictly parses a v2 response and preserves additive fields', () => {
    expect(normalizeGatewayModelsPayload(v2([MODEL]), 'CNY')).toEqual([MODEL]);
  });

  it('returns null for structurally invalid v2 responses so callers keep the snapshot', () => {
    expect(normalizeGatewayModelsPayload(v2([{ ...MODEL, agents: [] }]), 'CNY')).toBeNull();
    expect(normalizeGatewayModelsPayload(v2([{ ...MODEL, currency: 'EUR' }]), 'CNY')).toBeNull();
  });

  it('uses the tolerant unversioned envelope during the transition', () => {
    expect(normalizeGatewayModelsPayload({ models: [MODEL, { bad: true }] }, 'CNY')).toEqual([
      { ...MODEL, currency: 'USD' },
    ]);
  });

  it('keeps successful empty arrays distinct from parse failures', () => {
    expect(normalizeGatewayModelsPayload(v2([]), 'CNY')).toEqual([]);
    expect(normalizeGatewayModelsPayload({ models: [] }, 'CNY')).toEqual([]);
  });

  it('trusts model currency and falls back only when it is absent', () => {
    expect(normalizeGatewayModelsPayload({ models: [{ ...MODEL, currency: 'CNY' }] }, 'USD')).toMatchObject([
      { currency: 'CNY' },
    ]);
    const { currency: _currency, ...withoutCurrency } = MODEL;
    expect(normalizeGatewayModelsPayload({ models: [withoutCurrency] }, 'CNY')).toMatchObject([
      { currency: 'CNY' },
    ]);
  });
});
