/**
 * 会话权限档切换 —— composer 与权限卡片共用的唯一写入路径。
 *
 * 原本只长在 ChatInput 里,但 pending 交互期间 ChatInput 整个不挂载
 * (CCAgentSessionView 的互斥渲染),权限卡片自带的档位入口也要走同一套语义,
 * 所以把「确认门 + 远程/本地分支 + runtime-first + 回滚」抽到这里单点持有。
 *
 * 调用方只负责 confirm 弹窗的具体文案与失败 toast —— 本模块不碰 i18n / UI。
 */

import { requiresFullAccessConfirmation } from '@cindy/maker-shared/permission-mode';

import { createLogger } from '@/lib/logger';
import { makerApiForDevice } from '@/lib/makerTransport';
import * as sessionService from '@/lib/sessionService';
import type { PermissionMode } from '@/lib/userPreferences.types';

const log = createLogger('sessionPermissionMode');

/**
 * - `ok`        已生效(runtime + 持久化都成功,或无 sessionId 的纯本地草稿态)
 * - `cancelled` 用户在 Full access 二次确认里点了取消,什么都没改
 * - `failed`    runtime 或持久化失败,已尽力回滚;调用方负责提示
 */
export type PermissionModeChangeOutcome = 'ok' | 'cancelled' | 'failed';

export interface ApplySessionPermissionModeChangeParams {
  /** 无 sessionId = 新建对话草稿,只走 confirm 门,不落 runtime/DB。 */
  sessionId?: string;
  /**
   * device-link 被控端 id;非空 = 远程会话,走隧道。**由调用方显式传入**,本模块不再
   * 自己查 remoteProjectsStore —— relay 瞬时重连时 store 镜像会被 clear(),视图侧
   * 靠 lastRemoteDeviceIdRef 粘滞保留身份继续按远程渲染,若这里重查就会拿到 undefined
   * 而误落本机分支,用远程 sessionId 去调本机 IPC(必失败,还会污染本机会话记录)。
   * 身份来源必须与渲染判定同源。
   */
  deviceId?: string;
  currentMode: PermissionMode;
  nextMode: PermissionMode;
  /** 进入 Full access 时的二次确认;返回 false 即放弃本次切换。 */
  confirmFullAccess: () => Promise<boolean>;
}

export async function applySessionPermissionModeChange({
  sessionId,
  deviceId,
  currentMode,
  nextMode,
  confirmFullAccess,
}: ApplySessionPermissionModeChangeParams): Promise<PermissionModeChangeOutcome> {
  if (requiresFullAccessConfirmation(currentMode, nextMode)) {
    const confirmed = await confirmFullAccess();
    if (!confirmed) return 'cancelled';
  }

  if (!sessionId) return 'ok';

  try {
    if (deviceId) {
      // 控制端纯镜像:运行时隧道 setPermissionMode,被控端持久化后广播回流更新分片。
      // 按 deviceId 直连隧道 —— makerApiFor(sessionId) 同样要回查 store 路由,
      // 重连窗口内会退化成本机 API,与上面 deviceId 注释同一个坑。
      await makerApiForDevice(deviceId).setPermissionMode(sessionId, nextMode);
    } else {
      // runtime-first:运行时成功后才持久化，避免 UI/DB 先显示已切换而实际 agent 仍是旧档。
      await window.electronAPI.maker.setPermissionMode(sessionId, nextMode);
      try {
        await sessionService.update(sessionId, { permissionMode: nextMode });
      } catch (persistError) {
        // DB 写入失败时尽力恢复运行时，保持用户看到的旧设置与实际行为一致。
        try {
          await window.electronAPI.maker.setPermissionMode(sessionId, currentMode);
        } catch (rollbackError) {
          log.warn('permission runtime rollback failed:', rollbackError);
        }
        throw persistError;
      }
    }
    return 'ok';
  } catch (err) {
    log.warn('permission change failed:', err);
    return 'failed';
  }
}
