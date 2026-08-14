import type { AgentCredentialMode, AgentKind } from '@cindy/maker-core';

import {
  isCredentialModeSwitchBusyError,
  isLocalSessionBusy,
  prepareLocalSessionCredentialModeSwitch,
} from '../maker-host/codex-credential-switch.js';

const DEFAULT_RETRY_DELAY_MS = 10_000;

export interface CodexRouteRebuildSession {
  id: string;
  instanceId: string;
  agentKind: AgentKind;
  remoteHostId?: string | null;
  model: string;
  codexRouteRequiresCodeModeOnly?: boolean;
  codexRouteCredentialMode?: AgentCredentialMode;
  isTurnRunning?: () => boolean;
}

export interface CodexRouteRebuildDeps {
  maker: {
    listActiveSessions: () => CodexRouteRebuildSession[];
    closeSession: (sessionId: string) => Promise<void>;
  };
  isSessionInTurn?: (sessionId: string) => boolean;
  /** True while Provider routing is intentionally between committed snapshots. */
  isReconciliationBlocked?: () => boolean;
  /** Changes whenever a Provider route mutation starts, including transient ones. */
  getReconciliationGeneration?: () => number;
  resolveRequiresCodeModeOnly: (session: CodexRouteRebuildSession) => Promise<boolean>;
  onApplied?: (sessionId: string) => void;
  retryDelayMs?: number;
  logger?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
}

interface PendingRouteRebuild {
  instanceId: string;
  revision: number;
}

/**
 * Rebuilds only local Codex sessions whose thread-frozen CodeModeOnly value no
 * longer matches the live catalog route. Busy sessions remain queue-gated
 * until their terminal boundary; provider/model persistence is untouched.
 */
export class CodexRouteRebuildService {
  private readonly pending = new Map<string, PendingRouteRebuild>();
  private readonly applying = new Set<string>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconcileGeneration = 0;
  private lifecycleGeneration = 0;
  private lifecycleAbortController = new AbortController();

  constructor(private readonly deps: CodexRouteRebuildDeps) {}

  has(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  async reconcile(revision: number): Promise<void> {
    if (this.deps.isReconciliationBlocked?.() === true) return;
    const routeGeneration = this.deps.getReconciliationGeneration?.();
    const generation = ++this.reconcileGeneration;
    let sessions: CodexRouteRebuildSession[];
    try {
      sessions = this.deps.maker
        .listActiveSessions()
        .filter(
          (session) =>
            session.agentKind === 'codex' &&
            !session.remoteHostId &&
            typeof session.codexRouteRequiresCodeModeOnly === 'boolean',
        );
    } catch (error) {
      this.deps.logger?.warn('catalog route rebuild scan failed', {
        revision,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const comparisons = await Promise.all(
      sessions.map(async (session) => {
        try {
          const current = await this.deps.resolveRequiresCodeModeOnly(session);
          return { session, current } as const;
        } catch (error) {
          this.deps.logger?.warn('catalog route capability resolve failed', {
            revision,
            sessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      }),
    );
    if (generation !== this.reconcileGeneration) return;
    if (this.deps.isReconciliationBlocked?.() === true) return;
    if (this.deps.getReconciliationGeneration?.() !== routeGeneration) return;

    const scannedIds = new Set(sessions.map((session) => session.id));
    const toApply: string[] = [];
    for (const comparison of comparisons) {
      if (!comparison) continue;
      const { session, current } = comparison;
      if (current === session.codexRouteRequiresCodeModeOnly) {
        this.finish(session.id, session.instanceId, 'catalog capability converged');
        continue;
      }
      this.pending.set(session.id, { instanceId: session.instanceId, revision });
      this.scheduleRetry(session.id);
      toApply.push(session.id);
    }

    for (const [sessionId, pending] of [...this.pending]) {
      if (!scannedIds.has(sessionId) && !this.applying.has(sessionId)) {
        this.finish(sessionId, pending.instanceId, 'session no longer eligible');
      }
    }
    await Promise.all(toApply.map((sessionId) => this.tryApply(sessionId)));
  }

  onTurnSettled(sessionId: string): Promise<void> {
    return this.tryApply(sessionId);
  }

  onSessionClosed(sessionId: string): void {
    if (this.applying.has(sessionId)) return;
    const pending = this.pending.get(sessionId);
    if (!pending) return;
    this.finish(sessionId, pending.instanceId, 'session closed');
  }

  clear(): void {
    this.reconcileGeneration += 1;
    this.lifecycleGeneration += 1;
    this.lifecycleAbortController.abort();
    this.lifecycleAbortController = new AbortController();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.pending.clear();
  }

  private async tryApply(sessionId: string): Promise<void> {
    const pending = this.pending.get(sessionId);
    if (!pending || this.applying.has(sessionId)) return;
    if (this.deps.isReconciliationBlocked?.() === true) {
      this.scheduleRetry(sessionId);
      return;
    }
    const routeGeneration = this.deps.getReconciliationGeneration?.();
    const lifecycleGeneration = this.lifecycleGeneration;
    const signal = this.lifecycleAbortController.signal;

    let session: CodexRouteRebuildSession | undefined;
    try {
      session = this.deps.maker
        .listActiveSessions()
        .find((candidate) => candidate.id === sessionId);
    } catch (error) {
      this.deps.logger?.warn('catalog route rebuild live-session read failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleRetry(sessionId);
      return;
    }
    if (
      !session ||
      session.instanceId !== pending.instanceId ||
      session.agentKind !== 'codex' ||
      session.remoteHostId ||
      typeof session.codexRouteRequiresCodeModeOnly !== 'boolean'
    ) {
      this.finish(sessionId, pending.instanceId, 'session incarnation changed');
      return;
    }

    let current: boolean;
    try {
      current = await this.deps.resolveRequiresCodeModeOnly(session);
    } catch (error) {
      this.deps.logger?.warn('catalog route rebuild revalidation failed', {
        sessionId,
        revision: pending.revision,
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleRetry(sessionId);
      return;
    }
    if (
      lifecycleGeneration !== this.lifecycleGeneration ||
      signal.aborted ||
      this.pending.get(sessionId) !== pending
    ) return;
    if (this.deps.isReconciliationBlocked?.() === true) {
      this.scheduleRetry(sessionId);
      return;
    }
    if (this.deps.getReconciliationGeneration?.() !== routeGeneration) {
      this.scheduleRetry(sessionId);
      return;
    }
    if (current === session.codexRouteRequiresCodeModeOnly) {
      this.finish(sessionId, pending.instanceId, 'catalog capability reverted');
      return;
    }
    if (isLocalSessionBusy(session, this.deps.isSessionInTurn)) {
      this.scheduleRetry(sessionId);
      return;
    }
    if (this.deps.isReconciliationBlocked?.() === true) {
      this.scheduleRetry(sessionId);
      return;
    }
    // Multiple terminal/status/retry signals can finish the same async
    // revalidation together. Claim the close only after the await boundary.
    if (this.applying.has(sessionId)) return;

    this.applying.add(sessionId);
    try {
      await prepareLocalSessionCredentialModeSwitch({
        maker: this.deps.maker,
        sessionId,
        isSessionInTurn: this.deps.isSessionInTurn,
        signal,
      });
      if (this.pending.get(sessionId) !== pending) return;
      // Provider mutation can start while closeSession is awaiting teardown.
      // The old thread is already gone, but waking the queue before the new
      // route snapshot commits could recreate it against an intermediate route.
      if (
        this.deps.isReconciliationBlocked?.() === true ||
        this.deps.getReconciliationGeneration?.() !== routeGeneration
      ) {
        this.scheduleRetry(sessionId);
        return;
      }
      this.finish(sessionId, pending.instanceId, 'catalog capability changed');
    } catch (error) {
      if (!isCredentialModeSwitchBusyError(error)) {
        this.deps.logger?.warn('catalog route rebuild close failed; will retry', {
          sessionId,
          revision: pending.revision,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (this.pending.get(sessionId) === pending) this.scheduleRetry(sessionId);
    } finally {
      this.applying.delete(sessionId);
    }
  }

  private finish(sessionId: string, instanceId: string, reason: string): void {
    const pending = this.pending.get(sessionId);
    if (!pending || pending.instanceId !== instanceId) return;
    this.pending.delete(sessionId);
    const timer = this.retryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(sessionId);
    this.deps.logger?.info('catalog route rebuild settled', { sessionId, reason });
    try {
      this.deps.onApplied?.(sessionId);
    } catch (error) {
      this.deps.logger?.warn('catalog route rebuild wake failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scheduleRetry(sessionId: string): void {
    if (!this.pending.has(sessionId) || this.retryTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(sessionId);
      void this.tryApply(sessionId);
    }, this.deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.retryTimers.set(sessionId, timer);
  }
}
