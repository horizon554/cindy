import { describe, expect, it } from 'vitest';

import type { CreateScheduleInput, Schedule } from '@cindy/maker-scheduler';
import type { Catalog } from '@cindy/model-providers';

import {
  defaultModelFor,
  materializeScheduleDefaultForCreate,
  materializeScheduleDefaultForUpdate,
} from '../model-defaults.js';

const catalog: Catalog = {
  version: '3',
  providers: [],
  defaults: {
    'claude-code': { sessionModel: 'catalog-schedule-claude' },
    codex: { sessionModel: 'catalog-schedule-codex' },
  },
};

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    agentKind: 'claude-code',
    executionMode: 'agent',
    model: undefined,
    targetSessionId: undefined,
    ...overrides,
  } as Schedule;
}

function createInput(
  overrides: Partial<CreateScheduleInput> = {},
): CreateScheduleInput {
  return {
    name: 'schedule',
    prompt: 'do work',
    kind: 'cron',
    cronExpr: '0 9 * * *',
    timezone: 'UTC',
    recurring: true,
    agentKind: 'claude-code',
    useWorktree: false,
    notify: { desktop: true, feishu: false },
    ...overrides,
  };
}

describe('scheduler defaultModelFor', () => {
  it('reads catalog session defaults', () => {
    expect(defaultModelFor('claude-code', catalog)).toBe('catalog-schedule-claude');
    expect(defaultModelFor('codex', catalog)).toBe('catalog-schedule-codex');
  });

  it('retains historical scheduler fallbacks when metadata is missing', () => {
    const empty: Catalog = { version: '3', providers: [] };
    expect(defaultModelFor('claude-code', empty)).toBe('claude-sonnet-4-6');
    expect(defaultModelFor('codex', empty)).toBe('gpt-5.5');
  });

  it('materializes fresh create inputs from the active catalog default', () => {
    expect(
      materializeScheduleDefaultForCreate(
        createInput({ agentKind: 'claude-code', executionMode: 'agent' }),
        catalog,
      ),
    ).toMatchObject({ model: 'catalog-schedule-claude' });
    expect(
      materializeScheduleDefaultForCreate(
        createInput({ agentKind: 'codex', executionMode: 'agent' }),
        catalog,
      ),
    ).toMatchObject({ model: 'catalog-schedule-codex' });
  });

  it('preserves explicit, heartbeat, script, and Pi create semantics', () => {
    const explicit = createInput({
      model: 'chosen-model',
    });
    expect(materializeScheduleDefaultForCreate(explicit, catalog)).toBe(explicit);

    const heartbeat = createInput({
      targetSessionId: 'session-1',
    });
    expect(materializeScheduleDefaultForCreate(heartbeat, catalog)).toBe(heartbeat);

    const script = createInput({ executionMode: 'script' });
    expect(materializeScheduleDefaultForCreate(script, catalog)).toBe(script);

    const pi = createInput({ agentKind: 'pi' });
    expect(materializeScheduleDefaultForCreate(pi, catalog)).toBe(pi);
  });

  it('materializes empty historical updates under the task lock and follows agent transitions', () => {
    expect(
      materializeScheduleDefaultForUpdate(schedule(), { name: 'renamed' }, catalog),
    ).toEqual({ name: 'renamed', model: 'catalog-schedule-claude' });
    expect(
      materializeScheduleDefaultForUpdate(schedule(), { agentKind: 'codex' }, catalog),
    ).toEqual({ agentKind: 'codex', model: 'catalog-schedule-codex' });
    expect(
      materializeScheduleDefaultForUpdate(
        schedule({ targetSessionId: 'session-1' }),
        { targetSessionId: undefined },
        catalog,
      ),
    ).toEqual({ targetSessionId: undefined, model: 'catalog-schedule-claude' });
  });

  it('replaces an old explicit model when the schedule switches agent without a model patch', () => {
    expect(
      materializeScheduleDefaultForUpdate(
        schedule({ agentKind: 'claude-code', model: 'claude-explicit-model' }),
        { agentKind: 'codex' },
        catalog,
      ),
    ).toEqual({ agentKind: 'codex', model: 'catalog-schedule-codex' });
  });

  it('clears an old explicit model when the schedule switches to Pi', () => {
    expect(
      materializeScheduleDefaultForUpdate(
        schedule({ agentKind: 'claude-code', model: 'claude-explicit-model' }),
        { agentKind: 'pi' },
        catalog,
      ),
    ).toEqual({ agentKind: 'pi', model: undefined });
  });

  it('clears an old explicit override when a heartbeat schedule switches agent', () => {
    expect(
      materializeScheduleDefaultForUpdate(
        schedule({
          agentKind: 'claude-code',
          model: 'claude-explicit-model',
          targetSessionId: 'session-1',
        }),
        { agentKind: 'codex' },
        catalog,
      ),
    ).toEqual({ agentKind: 'codex', model: undefined });
  });

  it('does not materialize updates that remain heartbeat, explicit, script, or Pi', () => {
    const heartbeatPatch = { name: 'renamed' };
    expect(
      materializeScheduleDefaultForUpdate(
        schedule({ targetSessionId: 'session-1' }),
        heartbeatPatch,
        catalog,
      ),
    ).toBe(heartbeatPatch);

    const explicitPatch = { model: 'chosen-model' };
    expect(materializeScheduleDefaultForUpdate(schedule(), explicitPatch, catalog)).toBe(
      explicitPatch,
    );

    const scriptPatch = { executionMode: 'script' as const };
    expect(materializeScheduleDefaultForUpdate(schedule(), scriptPatch, catalog)).toBe(
      scriptPatch,
    );

    const piPatch = { name: 'renamed' };
    expect(
      materializeScheduleDefaultForUpdate(schedule({ agentKind: 'pi' }), piPatch, catalog),
    ).toBe(piPatch);
  });
});
