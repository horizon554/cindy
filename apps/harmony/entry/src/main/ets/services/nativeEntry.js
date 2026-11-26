import systemShare from '@hms.collaboration.systemShare';
import pushService from '@hms.core.push.pushService';
import notification from '@ohos.notificationManager';
import { taskTarget } from './media';
import { receiveWant } from './sso';
import { cleanStaging, pickFile, uploadFile } from './nativeMedia';
import { dictation } from './dictation';
import { readSession, saveSession, request } from './platform';
import { deviceLinkApiBaseUrl } from './protocol.generated';

let ability, listener, queued, sequence = 0;
function deliver(event) { if (listener) listener(event); else queued = event; }
export function launch(want, owner) {
  ability = owner;
  receiveWant(want.uri || '');
  const generation = ++sequence;
  const target = taskTarget(want.parameters);
  if (target) { deliver({ target }); return; }
  if (want.action !== 'ohos.want.action.sendData' && want.action !== 'ohos.want.action.sendMultipleData') return;
  systemShare.getSharedData(want).then(data => {
    if (generation !== sequence) return;
    const texts = [], uris = [];
    const own = owner.context.abilityInfo.bundleName;
    for (const record of data.getRecords().slice(0,20)) {
      if (typeof record.content === 'string' && record.content) texts.push(record.content.slice(0,32768));
      if (typeof record.uri === 'string') {
        const match = /^file:\/\/([A-Za-z0-9_.-]+)(\/[^?#]*)(?:\?[^#]*)?$/.exec(record.uri);
        if (match && match[1] !== own && (['media','docs'].includes(match[1]) || match[1].includes('.')) &&
          !decodeURIComponent(match[2]).split('/').some(part => part === '..' || part === '.')) uris.push(record.uri);
      }
    }
    if (texts.length || uris.length) deliver({ share: { text: texts.join('\n').slice(0,65536), uris: [...new Set(uris)] } });
    else deliver({ error: '这个分享项目无法读取，请从系统文件选择器添加' });
  }).catch(() => { if (generation === sequence) deliver({ error: '系统分享已失效，请重新分享' }); });
}

const pushUrl = deviceLinkApiBaseUrl + '/api/device-link/push-token';
const setting = id => 'cn.push.' + id;
let lifecycle, onRotation;
export function foreground(active) { lifecycle?.(active); }

export function installInputs(workspace) {
  workspace.native = {
    cleanStaging, pickFile, uploadFile, dictation,
    invalidateExternal() { sequence++; queued = null; },
    listen(fn) { listener = fn; if (queued) { const e = queued; queued = null; fn(e); } },
    async notificationSettings(context) {
      if (typeof notification.openNotificationSettings !== 'function') throw new Error('请从系统设置打开 Cindy 的通知权限');
      await notification.openNotificationSettings(context);
    },
    async restorePush(owner) { return !!await readSession(setting(owner)); },
    async enablePush(ws, owner, prompt, rotatedToken) {
      if (prompt) {
        try { await notification.requestEnableNotification(ws.context); }
        catch (error) { if (await notification.isNotificationEnabled()) throw error; }
      }
      if (!await notification.isNotificationEnabled()) throw new Error('系统通知权限未开启');
      if (ws.session?.id !== owner) return;
      if (!await readSession(setting(owner))) await saveSession({ enabled: true }, setting(owner));
      const pushToken = typeof rotatedToken === 'string' && rotatedToken ? rotatedToken : await pushService.getToken();
      if (!pushToken || ws.session?.id !== owner) throw new Error('无法获取本设备的华为推送凭证');
      const access = await ws.token();
      if (ws.session?.id !== owner) return;
      await saveSession({ enabled: true, token: pushToken }, setting(owner));
      const result = await request(pushUrl, { token: pushToken, platform: 'harmonyos', provider: 'huawei', appVariant: 'cn' }, access, 'PUT');
      if (!result.registered || !result.deliveryConfigured) throw new Error('服务端尚未启用华为通知投递');
    },
    async disablePush(owner, access) {
      const stored = await readSession(setting(owner));
      if (!stored) return;
      // Invalidate this app token on the device even when the account token expired.
      let removed = false;
      if (access && stored.token) {
        try { const receipt = await request(pushUrl, { token: stored.token }, access, 'DELETE'); removed = receipt.deleted === true; } catch {}
      }
      let invalidated = false;
      try { await pushService.deleteToken(); invalidated = true; } catch {}
      if (stored.token && !removed && !invalidated) throw new Error('通知解绑待重试');
      await saveSession(null, setting(owner));
    }
  };
  lifecycle = active => active ? workspace.foreground() : workspace.cancelVoice();
  if (onRotation) { try { pushService.off('tokenUpdate', onRotation); } catch {} }
  onRotation = token => workspace.refreshPush(token);
  try { pushService.on('tokenUpdate', ability, onRotation); } catch {}
}
