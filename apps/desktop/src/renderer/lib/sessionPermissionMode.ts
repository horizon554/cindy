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

import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import { createLogger } from '@/lib/logger';
import { makerApiFor } from '@/lib/makerTransport';
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
  currentMode: PermissionMode;
  nextMode: PermissionMode;
  /** 进入 Full access 时的二次确认;返回 false 即放弃本次切换。 */
  confirmFullAccess: () => Promise<boolean>;
}

export async function applySessionPermissionModeChange({
  sessionId,
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
    if (getSessionDeviceId(sessionId)) {
      // 控制端纯镜像:运行时隧道 setPermissionMode,被控端持久化后广播回流更新分片。
      await makerApiFor(sessionId).setPermissionMode(sessionId, nextMode);
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
