import { describe, expect, it } from 'vitest';

import type { Catalog } from '@cindy/model-providers';

import { defaultModelFor } from '../model-defaults.js';

describe('scheduler defaultModelFor', () => {
  it('reads catalog session defaults', () => {
    const catalog: Catalog = {
      version: '3',
      providers: [],
      defaults: {
        'claude-code': { sessionModel: 'catalog-schedule-claude' },
        codex: { sessionModel: 'catalog-schedule-codex' },
      },
    };
    expect(defaultModelFor('claude-code', catalog)).toBe('catalog-schedule-claude');
    expect(defaultModelFor('codex', catalog)).toBe('catalog-schedule-codex');
  });

  it('retains historical scheduler fallbacks when metadata is missing', () => {
    const empty: Catalog = { version: '3', providers: [] };
    expect(defaultModelFor('claude-code', empty)).toBe('claude-sonnet-4-6');
    expect(defaultModelFor('codex', empty)).toBe('gpt-5.5');
  });
});
