/**
 * sessionPermissionMode.test.ts
 * ---------------------------------------------------------------------------
 * 会话权限档切换的唯一写入路径。原本内联在 ChatInput 里,权限卡片要用同一套语义
 * 才抽出来,所以这里锁死四件事:Full access 二次确认门、远程/本地分支互斥、
 * runtime-first 顺序、持久化失败后的 runtime 回滚。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const makerApiForDevice = vi.fn<(deviceId: string) => unknown>();
const remoteSetPermissionMode = vi.fn<(sessionId: string, mode: string) => Promise<void>>();
const localSetPermissionMode = vi.fn<(sessionId: string, mode: string) => Promise<void>>();
const sessionUpdate = vi.fn<(sessionId: string, patch: unknown) => Promise<void>>();

vi.mock('@/lib/makerTransport', () => ({
  makerApiForDevice: (deviceId: string) => {
    makerApiForDevice(deviceId);
    return { setPermissionMode: remoteSetPermissionMode };
  },
}));

vi.mock('@/lib/sessionService', () => ({
  update: (sessionId: string, patch: unknown) => sessionUpdate(sessionId, patch),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  }),
}));

import { applySessionPermissionModeChange } from '@/lib/sessionPermissionMode';

const SESSION_ID = 'perm-mode-session';

/** 默认不该被调用 —— 只有目标档是 bypassPermissions 时才过确认门。 */
const confirmNever = vi.fn(async () => {
  throw new Error('confirmFullAccess should not be called');
});

beforeEach(() => {
  vi.clearAllMocks();
  remoteSetPermissionMode.mockResolvedValue(undefined);
  localSetPermissionMode.mockResolvedValue(undefined);
  sessionUpdate.mockResolvedValue(undefined);
  (globalThis as unknown as { window: unknown }).window = {
    electronAPI: { maker: { setPermissionMode: localSetPermissionMode } },
  };
});

describe('applySessionPermissionModeChange', () => {
  it('本地会话 runtime-first:运行时成功后才落库', async () => {
    const outcome = await applySessionPermissionModeChange({
      sessionId: SESSION_ID,
      currentMode: 'ask',
      nextMode: 'acceptEdits',
      confirmFullAccess: confirmNever,
    });

    expect(outcome).toBe('ok');
    expect(localSetPermissionMode).toHaveBeenCalledWith(SESSION_ID, 'acceptEdits');
    expect(sessionUpdate).toHaveBeenCalledWith(SESSION_ID, { permissionMode: 'acceptEdits' });
    expect(localSetPermissionMode.mock.invocationCallOrder[0]!).toBeLessThan(
      sessionUpdate.mock.invocationCallOrder[0]!,
    );
    expect(remoteSetPermissionMode).not.toHaveBeenCalled();
  });

  it('device-link 远程会话纯镜像:按调用方给的 deviceId 直连隧道,不写本机库', async () => {
    const outcome = await applySessionPermissionModeChange({
      sessionId: SESSION_ID,
      deviceId: 'device-1',
      currentMode: 'ask',
      nextMode: 'acceptEdits',
      confirmFullAccess: confirmNever,
    });

    expect(outcome).toBe('ok');
    expect(makerApiForDevice).toHaveBeenCalledWith('device-1');
    expect(remoteSetPermissionMode).toHaveBeenCalledWith(SESSION_ID, 'acceptEdits');
    expect(localSetPermissionMode).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  // relay 瞬时重连会 clear() 掉 store 里的 session→device 映射,而视图仍按远程渲染
  // (lastRemoteDeviceIdRef 粘滞)。身份必须由调用方给死:本模块若自己回查 store,
  // 这一刻就会拿到空值、把远程 sessionId 灌进本机 IPC(必失败 + 污染本机记录)。
  it('身份只认入参:重连期间 store 索引为空也不退回本机分支', async () => {
    const outcome = await applySessionPermissionModeChange({
      sessionId: SESSION_ID,
      deviceId: 'sticky-device',
      currentMode: 'ask',
      nextMode: 'bypassPermissions',
      confirmFullAccess: vi.fn(async () => true),
    });

    expect(outcome).toBe('ok');
    expect(makerApiForDevice).toHaveBeenCalledWith('sticky-device');
    expect(localSetPermissionMode).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it('进 Full access 必过确认门;取消则一处不改', async () => {
    const confirmFullAccess = vi.fn(async () => false);

    const outcome = await applySessionPermissionModeChange({
      sessionId: SESSION_ID,
      currentMode: 'ask',
      nextMode: 'bypassPermissions',
      confirmFullAccess,
    });

    expect(outcome).toBe('cancelled');
    expect(confirmFullAccess).toHaveBeenCalledOnce();
    expect(localSetPermissionMode).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it('确认后才切进 Full access', async () => {
    const outcome = await applySessionPermissionModeChange({
      sessionId: SESSION_ID,
      currentMode: 'ask',
      nextMode: 'bypassPermissions',
      confirmFullAccess: vi.fn(async () => true),
    });

    expect(outcome).toBe('ok');
    expect(localSetPermissionMode).toHaveBeenCalledWith(SESSION_ID, 'bypassPermissions');
  });

  it('落库失败时把运行时回滚到原档', async () => {
    sessionUpdate.mockRejectedValueOnce(new Error('db down'));

    const outcome = await applySessionPermissionModeChange({
      sessionId: SESSION_ID,
      currentMode: 'ask',
      nextMode: 'acceptEdits',
      confirmFullAccess: confirmNever,
    });

    expect(outcome).toBe('failed');
    expect(localSetPermissionMode).toHaveBeenNthCalledWith(1, SESSION_ID, 'acceptEdits');
    expect(localSetPermissionMode).toHaveBeenNthCalledWith(2, SESSION_ID, 'ask');
  });

  it('运行时失败直接告败,不落库', async () => {
    localSetPermissionMode.mockRejectedValueOnce(new Error('runtime down'));

    const outcome = await applySessionPermissionModeChange({
      sessionId: SESSION_ID,
      currentMode: 'ask',
      nextMode: 'acceptEdits',
      confirmFullAccess: confirmNever,
    });

    expect(outcome).toBe('failed');
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it('无 sessionId(新建草稿)只过确认门,不碰 runtime/DB', async () => {
    const outcome = await applySessionPermissionModeChange({
      currentMode: 'ask',
      nextMode: 'acceptEdits',
      confirmFullAccess: confirmNever,
    });

    expect(outcome).toBe('ok');
    expect(localSetPermissionMode).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });
});
