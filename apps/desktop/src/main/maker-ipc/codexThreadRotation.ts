import type { AgentKind, Maker } from '@cindy/maker-core';

export interface CodexThreadRotationSnapshot {
  sessionId: string;
  sourceSdkSessionId: string;
  sourceModel: string;
  sourceProviderId: string | null;
  workingDir: string;
}

export interface PreparedCodexThreadRotation {
  newSdkSessionId: string;
  rollback: () => Promise<void>;
}

export type PrepareCodexThreadRotation = (
  snapshot: CodexThreadRotationSnapshot,
) => Promise<PreparedCodexThreadRotation>;

export function codexThreadRotationSnapshotFromSession(
  session: {
    id: string;
    agentKind: AgentKind;
    remoteHostId?: string | null;
    sdkSessionId?: string | null;
    model: string;
    workDir?: string | null;
  },
  providerId: string | null,
): CodexThreadRotationSnapshot | null {
  const sdkSessionId = session.sdkSessionId;
  const workingDir = session.workDir;
  if (
    session.agentKind !== 'codex' ||
    session.remoteHostId ||
    !sdkSessionId ||
    sdkSessionId === '<pending>' ||
    !workingDir
  ) {
    return null;
  }
  return {
    sessionId: session.id,
    sourceSdkSessionId: sdkSessionId,
    sourceModel: session.model,
    sourceProviderId: providerId,
    workingDir,
  };
}

export function createCodexThreadRotationPreparer(args: {
  maker: Pick<Maker, 'forkSdkSession'>;
  replaceSdkSessionIdIfCurrent: (
    sessionId: string,
    expectedSdkSessionId: string,
    nextSdkSessionId: string,
  ) => Promise<boolean>;
}): PrepareCodexThreadRotation {
  return async (snapshot) => {
    const fork = await args.maker.forkSdkSession('codex', {
      sourceSdkSessionId: snapshot.sourceSdkSessionId,
      model: snapshot.sourceModel,
      providerId: snapshot.sourceProviderId,
      workingDir: snapshot.workingDir,
      upToMessageId: undefined,
      stripEncryptedReasoning: true,
    });
    const applied = await args.replaceSdkSessionIdIfCurrent(
      snapshot.sessionId,
      snapshot.sourceSdkSessionId,
      fork.newSdkSessionId,
    );
    if (!applied) {
      throw new Error(
        `Codex thread rotation lost its session binding: ${snapshot.sessionId}`,
      );
    }
    let rolledBack = false;
    return {
      newSdkSessionId: fork.newSdkSessionId,
      rollback: async () => {
        if (rolledBack) return;
        rolledBack = true;
        const restored = await args.replaceSdkSessionIdIfCurrent(
          snapshot.sessionId,
          fork.newSdkSessionId,
          snapshot.sourceSdkSessionId,
        );
        if (!restored) {
          throw new Error(
            `Codex thread rotation rollback lost its session binding: ${snapshot.sessionId}`,
          );
        }
      },
    };
  };
}
