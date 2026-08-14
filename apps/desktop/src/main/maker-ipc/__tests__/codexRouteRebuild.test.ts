import { describe, expect, it, vi } from 'vitest';

import {
  CodexRouteRebuildService,
  type CodexRouteRebuildSession,
} from '../codexRouteRebuild.js';

function createHarness(initialSessions: CodexRouteRebuildSession[]) {
  const sessions = [...initialSessions];
  let currentRequiresCodeModeOnly = false;
  let reconciliationBlocked = false;
  const closeSession = vi.fn(async (sessionId: string) => {
    const index = sessions.findIndex((session) => session.id === sessionId);
    if (index >= 0) sessions.splice(index, 1);
  });
  const onApplied = vi.fn();
  const service = new CodexRouteRebuildService({
    maker: {
      listActiveSessions: () => sessions,
      closeSession,
    },
    isReconciliationBlocked: () => reconciliationBlocked,
    resolveRequiresCodeModeOnly: async () => currentRequiresCodeModeOnly,
    onApplied,
    retryDelayMs: 60_000,
  });
  return {
    service,
    sessions,
    closeSession,
    onApplied,
    setCurrentRequiresCodeModeOnly(value: boolean) {
      currentRequiresCodeModeOnly = value;
    },
    setReconciliationBlocked(value: boolean) {
      reconciliationBlocked = value;
    },
  };
}

function localCodex(
  id: string,
  frozen: boolean,
  isTurnRunning: () => boolean = () => false,
): CodexRouteRebuildSession {
  return {
    id,
    instanceId: `${id}-instance`,
    agentKind: 'codex',
    remoteHostId: null,
    model: 'codex/gpt-5.5',
    codexRouteRequiresCodeModeOnly: frozen,
    isTurnRunning,
  };
}

describe('CodexRouteRebuildService', () => {
  it('keeps an idle session when the live catalog capability is unchanged', async () => {
    const h = createHarness([localCodex('same', false)]);

    await h.service.reconcile(1);

    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.service.has('same')).toBe(false);
  });

  it.each([
    { frozen: false, current: true },
    { frozen: true, current: false },
  ])('closes an idle local Codex session across $frozen -> $current', async ({ frozen, current }) => {
    const h = createHarness([localCodex('idle', frozen)]);
    h.setCurrentRequiresCodeModeOnly(current);

    await h.service.reconcile(2);

    expect(h.closeSession).toHaveBeenCalledWith('idle');
    expect(h.service.has('idle')).toBe(false);
    expect(h.onApplied).toHaveBeenCalledWith('idle');
  });

  it('gates a busy session and closes it after the turn settles', async () => {
    let running = true;
    const h = createHarness([localCodex('busy', false, () => running)]);
    h.setCurrentRequiresCodeModeOnly(true);

    await h.service.reconcile(3);
    expect(h.service.has('busy')).toBe(true);
    expect(h.closeSession).not.toHaveBeenCalled();

    running = false;
    await h.service.onTurnSettled('busy');

    expect(h.closeSession).toHaveBeenCalledWith('busy');
    expect(h.service.has('busy')).toBe(false);
    expect(h.onApplied).toHaveBeenCalledWith('busy');
  });

  it('keeps a pending rebuild queue-gated while a Provider route mutation is active', async () => {
    let running = true;
    const h = createHarness([localCodex('mutation-pending', false, () => running)]);
    h.setCurrentRequiresCodeModeOnly(true);
    await h.service.reconcile(4);
    expect(h.service.has('mutation-pending')).toBe(true);

    running = false;
    h.setReconciliationBlocked(true);
    await h.service.onTurnSettled('mutation-pending');
    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.service.has('mutation-pending')).toBe(true);

    h.setReconciliationBlocked(false);
    await h.service.onTurnSettled('mutation-pending');
    expect(h.closeSession).toHaveBeenCalledWith('mutation-pending');
    expect(h.service.has('mutation-pending')).toBe(false);
  });

  it('discards an async capability snapshot if a Provider mutation starts while resolving', async () => {
    const sessions = [localCodex('mutation-race', false)];
    let blocked = false;
    let finishResolve!: (value: boolean) => void;
    const closeSession = vi.fn(async () => {});
    const service = new CodexRouteRebuildService({
      maker: {
        listActiveSessions: () => sessions,
        closeSession,
      },
      isReconciliationBlocked: () => blocked,
      resolveRequiresCodeModeOnly: () =>
        new Promise<boolean>((resolve) => {
          finishResolve = resolve;
        }),
      retryDelayMs: 60_000,
    });

    const reconcile = service.reconcile(5);
    await vi.waitFor(() => expect(finishResolve).toBeTypeOf('function'));
    blocked = true;
    finishResolve(true);
    await reconcile;

    expect(closeSession).not.toHaveBeenCalled();
    expect(service.has('mutation-race')).toBe(false);
  });

  it('keeps pending when a Provider mutation starts and finishes during revalidation', async () => {
    let running = true;
    let generation = 0;
    let resolveCount = 0;
    let finishRevalidation!: (value: boolean) => void;
    const sessions = [localCodex('transient-mutation', false, () => running)];
    const closeSession = vi.fn(async () => {});
    const service = new CodexRouteRebuildService({
      maker: {
        listActiveSessions: () => sessions,
        closeSession,
      },
      getReconciliationGeneration: () => generation,
      resolveRequiresCodeModeOnly: () => {
        resolveCount += 1;
        if (resolveCount <= 2 || resolveCount > 3) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          finishRevalidation = resolve;
        });
      },
      retryDelayMs: 60_000,
    });

    await service.reconcile(6);
    expect(service.has('transient-mutation')).toBe(true);
    running = false;

    const settle = service.onTurnSettled('transient-mutation');
    await vi.waitFor(() => expect(finishRevalidation).toBeTypeOf('function'));
    generation += 1;
    finishRevalidation(true);
    await settle;

    expect(closeSession).not.toHaveBeenCalled();
    expect(service.has('transient-mutation')).toBe(true);

    await service.onTurnSettled('transient-mutation');
    expect(closeSession).toHaveBeenCalledWith('transient-mutation');
    expect(service.has('transient-mutation')).toBe(false);
  });

  it('claims one close when duplicate settle signals finish revalidation together', async () => {
    let running = true;
    const h = createHarness([localCodex('duplicate-settle', false, () => running)]);
    h.setCurrentRequiresCodeModeOnly(true);
    await h.service.reconcile(7);
    running = false;

    await Promise.all([
      h.service.onTurnSettled('duplicate-settle'),
      h.service.onTurnSettled('duplicate-settle'),
    ]);

    expect(h.closeSession).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending rebuild when a later catalog revision restores the frozen value', async () => {
    let running = true;
    const h = createHarness([localCodex('reverted', false, () => running)]);
    h.setCurrentRequiresCodeModeOnly(true);
    await h.service.reconcile(8);
    expect(h.service.has('reverted')).toBe(true);

    h.setCurrentRequiresCodeModeOnly(false);
    await h.service.reconcile(9);
    running = false;

    expect(h.service.has('reverted')).toBe(false);
    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.onApplied).toHaveBeenCalledWith('reverted');
  });

  it('ignores remote Codex sessions', async () => {
    const remote = {
      ...localCodex('remote', false),
      remoteHostId: 'ssh-host',
    };
    const h = createHarness([remote]);
    h.setCurrentRequiresCodeModeOnly(true);

    await h.service.reconcile(10);

    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.service.has('remote')).toBe(false);
  });
});
