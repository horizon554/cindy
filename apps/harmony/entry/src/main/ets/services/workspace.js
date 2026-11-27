import { activityFields, homeTask } from './homeList';
import { messageMedia } from './media';
import { openCache } from './cache';
import { approvalKey, taskPage, mergePage, presentCards, questionAnswer, decisionFor } from './taskModel';
import util from '@ohos.util';
import { buildMobileModelSections, flattenProviderSections, providerPickerListArgs, deviceLinkApiBaseUrl, DeviceLinkClient, parseAttachmentOssRef, isSharedTaskMediaKey, PROTOCOL_VERSION, permissionModeOrAsk, isTurnContinuationBoundaryEvent } from './protocol.generated';
import { accountUrl, directoryUrl, relayUrl, request, deviceIdentity, readSession, saveSession, createSocket } from './platform';

import { authorize, cancelAuthorization, consumeAuthorization, listenForWant, pendingAuthorization } from './sso';

const taskView = { legacyPicker: false, agent: '', model: '', provider: '', permission: '', voicePreview: '', uploadName: '', failedFile: '', task: '', messages: [], live: '', draft: '', cards: [], running: false,
  attachments: [], transfer: '', voice: '', activity: '', hasOlder: false, paused: false, retryable: false, delivery: '' };
const hostView = { ...taskView, device: '', tasks: [], linked: false, moreTasks: false };

// One instance owns one visible account. Only the native page can initiate a send.
function displayName(uri) {
  try { return decodeURIComponent(uri.split(/[?#]/)[0].split('/').pop()).replace(/[\u0000-\u001f]/g, '').slice(0, 80); }
  catch { return ''; }
}

export class Workspace {
  constructor(changed, taskHome = false) {
    this.taskHome = taskHome;
    this.localMedia = new Map();
    this.recentImages = new Map();
    this.thumbnailQueue = Promise.resolve();
    this.changed = changed;
    this.version = 0;
    this.voiceTake = 0;
    this.authEpoch = 0;
    this.sessionWrite = Promise.resolve();
    this.state = { ...hostView, shareLabel: '', shareText: '', shareFiles: [], pushStatus: '', pushEnabled: false, ssoWaiting: false, ssoMethods: [], verification: '', accounts: [], account: '', relay: '', devices: [], error: '' };
  }
  show(patch) {
    if (this.taskHome && patch.devices) {
      const devices = patch.devices, owner = this.session?.id;
      patch.homeIndex = [];
      if (owner && devices.length) {
        Promise.all(devices.map(async host => {
          const rows = await this.cache.read([owner, host.id, '', 'tasks']);
          return (rows || []).map(row => ({ ...row, host: host.id }));
        })).then(pages => {
          if (this.session?.id === owner && this.state.devices === devices) this.show({ homeIndex: pages.flat() });
        }).catch(() => {});
      }
    }
    Object.assign(this.state, patch);
    this.changed({ ...this.state });
  }
  async init(context) {
    this.context = context;
    this.cache = await openCache(context);
    this.id = await deviceIdentity(context);
    const session = await readSession();
    if (session) {
      this.session = session;
      this.start();
    } else {
      this.show({ ssoWaiting: !!await pendingAuthorization(this.id) });
    }
    if (this.native) {
      await this.native.cleanStaging(context);
      this.native.listen(event => this.external(event));
    }
    listenForWant(uri => {
      this.callbackQueue = (this.callbackQueue || Promise.resolve()).then(() => this.finishSSO(uri)).catch(e => this.report(e));
    });
  }
  clearMethods() { this.show({ ssoMethods: [], error: '' }); }
  async discover(org) {
    const reply = await request(accountUrl + '/api/auth/sso/discovery', { org: org.trim() });
    if (reply.region !== 'cn') throw new Error('该组织不属于当前 CN 登录环境');
    const methods = (reply.connections || []).filter(c => typeof c.connectionId === 'string' && c.connectionId);
    if (!methods.length) throw new Error('该组织尚未启用企业 SSO');
    this.show({ ssoMethods: methods.map(c => ({ id: c.connectionId, title: c.connectionName || reply.orgName })), error: '' });
    if (methods.length === 1) await this.startSSO(methods[0].connectionId);
  }
  async startSSO(id) {
    if (!this.state.ssoMethods.some(row => row.id === id)) throw new Error('请选择组织提供的登录方式');
    this.ssoEpoch = (this.ssoEpoch || 0) + 1;
    this.show({ ssoWaiting: true, error: '' });
    try { await authorize(this.context, this.id, id); }
    catch (error) { this.show({ ssoWaiting: false }); throw error; }
  }
  async cancelSSO() {
    this.ssoEpoch = (this.ssoEpoch || 0) + 1;
    await cancelAuthorization();
    this.show({ ssoWaiting: false, ssoMethods: [] });
  }
  async finishSSO(uri) {
    if (this.session || !this.state.ssoWaiting) return;
    const epoch = this.ssoEpoch;
    try {
      const body = await consumeAuthorization(uri, this.id);
      if (!body || epoch !== this.ssoEpoch) return;
      const reply = await request(accountUrl + '/api/auth/token', body);
      if (epoch !== this.ssoEpoch) return;
      await this.completeLogin(reply);
      this.show({ ssoWaiting: false, ssoMethods: [] });
    } catch (error) {
      if (epoch === this.ssoEpoch) this.show({ ssoWaiting: false });
      throw error;
    }
  }
  async verificationCode() {
    await request(accountUrl + '/api/auth/sso/verification/request-code', { verificationTicket: this.verificationTicket, deviceId: this.id });
  }
  async verifyOrganization(code) {
    if (!/^[0-9]{6}$/.test(code)) throw new Error('请输入六位验证码');
    await this.completeLogin(await request(accountUrl + '/api/auth/sso/verification/verify', {
      verificationTicket: this.verificationTicket, code, deviceId: this.id
    }));
  }
  async code(phone) {
    const config = await request(accountUrl + '/api/auth/providers');
    if (config.region !== 'cn' || !config.phone) throw new Error('当前环境未开放手机号登录');
    if (config.captcha?.requiredFor?.includes('phone_request_code')) throw new Error('当前环境要求图形验证，暂未接入');
    const response = await request(accountUrl + '/api/auth/phone/request-code', { phone, locale: 'zh-CN' });
    if (response.status !== 'sent') throw new Error('验证码未发送');
  }
  async login(phone, code) {
    if (!/^[0-9]{6}$/.test(code)) throw new Error('请输入六位验证码');
    const reply = await request(accountUrl + '/api/auth/phone/verify-code', {
      phone, code, deviceId: this.id, clientType: 'mobile', locale: 'zh-CN'
    });
    await this.completeLogin(reply);
  }
  async choose(id) {
    if (!this.ticket || !this.state.accounts.some(row => row.id === id)) throw new Error('请重新验证');
    await this.completeLogin(await request(accountUrl + '/api/auth/select-account', {
      loginTicket: this.ticket, accountId: id, deviceId: this.id
    }));
  }
  async completeLogin(reply) {
    if (reply.status === 'sso_verification_required') {
      this.verificationTicket = reply.verificationTicket;
      this.show({ verification: reply.targetMasked, accounts: [] });
      return;
    }
    this.verificationTicket = undefined;
    this.show({ verification: '' });
    if (reply.status === 'select_account') {
      this.ticket = reply.loginTicket;
      this.show({ accounts: reply.accounts.map(row => ({ id: row.id, title: row.orgName || row.displayName || '个人账号' })) });
      return;
    }
    if (reply.status !== 'ok') throw new Error('此账号还需要完成绑定或组织验证');
    this.ticket = null;
    this.show({ accounts: [] });
    await this.accept(reply);
    this.start();
  }
  async accept(reply) {
    if (!reply.membership?.id || !reply.accessToken || !reply.refreshToken) throw new Error('登录响应不完整');
    const session = { id: reply.membership.id, name: reply.membership.displayName || 'Cindy', refresh: reply.refreshToken };
    const epoch = this.authEpoch;
    await this.storeSession(session);
    if (epoch !== this.authEpoch) throw new Error('账号已退出');
    this.session = session;
    this.access = reply.accessToken;
    const { email, avatarUrl } = reply.membership;
    const accountEmail = typeof email === 'string' ? email.trim() : '';
    const accountAvatar = typeof avatarUrl === 'string' && avatarUrl.startsWith('https://') ? avatarUrl : '';
    if (accountEmail !== this.state.accountEmail || accountAvatar !== this.state.accountAvatar) {
      this.show({ accountEmail, accountAvatar });
    }
    const payload = reply.accessToken.split('.')[1];
    try {
      const bytes = new util.Base64Helper().decodeSync(payload.replace(/-/g, '+').replace(/_/g, '/'));
      this.expires = JSON.parse(util.TextDecoder.create().decodeWithStream(bytes)).exp * 1000;
    } catch { this.expires = 0; }
  }
  storeSession(session) {
    const write = this.sessionWrite.then(() => saveSession(session));
    this.sessionWrite = write.catch(() => {});
    return write;
  }
  async token() {
    if (this.access && Date.now() + 30000 < this.expires) return this.access;
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
  async refresh() {
    const owner = this.session;
    if (!owner) throw new Error('请重新登录');
    let reply;
    try { reply = await request(accountUrl + '/api/auth/refresh', { refreshToken: owner.refresh, deviceId: this.id }); }
    catch (error) {
      if (owner === this.session && [401, 403].includes(error.httpStatus)) await this.clearAccount(false);
      throw error;
    }
    if (owner !== this.session) throw new Error('登录身份已变更');
    if (reply.membership?.id !== owner.id) {
      await this.clearAccount(false);
      throw new Error('登录身份已变更');
    }
    await this.accept(reply);
    return this.access;
  }
  start() {
    this.client?.stop();
    const client = new DeviceLinkClient({
      getWsUrl: () => relayUrl, getToken: () => this.token(), createWebSocket: createSocket,
      getHello: () => ({ deviceName: 'Cindy HarmonyOS', platform: 'harmonyos', app: 'cindy', appVersion: '0.1.0', remoteControlEnabled: false, busy: false }),
      logger: { debug() {}, info() {}, warn() {}, error() {} }
    });
    this.client = client;
    this.show({ account: this.session.name, error: '' });
    const directoryEpoch = this.directoryEpoch || 0;
    this.cache.read(this.key('devices', '', '')).then(rows => {
      if (client !== this.client || directoryEpoch !== (this.directoryEpoch || 0) || !rows) return;
      this.show({ devices: rows });
      if (this.taskHome && this.state.relay !== 'online' && !this.state.device && rows.length) {
        return this.cache.read(this.key('home-device', '', '')).then(id => {
          if (client === this.client && !this.state.device && this.state.relay !== 'online' && directoryEpoch === (this.directoryEpoch || 0)) {
            const host = this.homeHost(rows, id);
            if (host) return this.openDevice(host.id);
          }
        });
      }
    }).catch(e => { if (client === this.client) this.report(e); });
    client.onStatusChange(status => {
      if (this.client !== client) return;
      this.version++;
      this.ready = false;
      this.cancelVoice();
      this.cancelTransfer();
      this.discardFailed();
      this.show({ relay: status, linked: false, cards: [], running: false, activity: '', paused: false });
      if (status === 'online') this.recover().catch(e => { if (this.client === client) this.report(e); });
    });
    client.onFrame(env => {
      if (client !== this.client || !env.src) return;
      if (env.kind === 'link-close') {
        if (['revoked', 'toggle-off'].includes(env.payload?.reason)) {
          this.forgetHost(env.src).catch(e => this.report(e));
        } else if (env.src === this.state.device) {
          this.version++;
          this.ready = false;
          this.cancelVoice(); this.cancelTransfer(); this.discardFailed();
          this.show({ linked: false, cards: [], running: false, paused: false, activity: '', live: '', error: '电脑连接已断开' });
          if (env.payload?.reason === 'transport-timeout' && !this.reopening) {
            this.reopening = this.recover().catch(e => { if (this.client === client) this.report(e); }).finally(() => { this.reopening = null; });
          }
        }
        return;
      }
      if (env.src !== this.state.device || env.kind !== 'push') return;
      const { channel, payload } = env.payload || {};
      if (this.taskHome && channel === 'local-db:sessions:activity' && (this.state.linked || this.homeRead?.version === this.version)) {
        this.applyHomeActivity(payload);
      }
      if (this.state.task && this.state.linked && payload?.sessionId === this.state.task) this.push(channel, payload);
    });
    client.start();
    this.refreshPush();
  }
  report(error) { this.show({ error: error.message || '连接失败，请重试' }); }
  key(name, host = this.state.device, task = this.state.task) {
    return [this.session.id, host, task, name];
  }
  guard(version) {
    if (version !== this.version || !this.session) throw new Error('任务连接已变更');
  }
  async forgetHost(host) {
    if (!this.session) return;
    const owner = this.session.id;
    if (this.state.device === host) {
      this.version++;
      this.cancelDraftTimer();
      this.resetTask();
      this.show({ ...hostView, error: '电脑远程访问权限已关闭' });
    }
    const devices = this.state.devices.filter(d => d.id !== host);
    this.show({ devices });
    await Promise.all([this.cache.forget(owner, host), this.cache.write([owner, '', '', 'devices'], devices)]);
  }
  async devices() {
    const client = this.client;
    let result;
    try {
      const token = await this.token();
      try { result = await request(directoryUrl, null, token); }
      catch (error) {
        if (error.httpStatus !== 401 || client !== this.client) throw error;
        if (this.access === token) this.expires = 0;
        result = await request(directoryUrl, null, await this.token());
      }
    } catch (error) {
      if (client === this.client && this.session && [401,403].includes(error.httpStatus)) {
        const account = this.session.id;
        const host = this.state.device;
        this.directoryEpoch = (this.directoryEpoch || 0) + 1;
        this.version++;
        if (host && this.state.linked) client.closeLink(host, 'user');
        this.cancelDraftTimer();
        this.resetTask();
        this.show({ ...hostView, devices: [], error: '当前账号无法访问设备目录' });
        await this.cache.forget(account);
      }
      throw error;
    }
    if (client !== this.client) return;
    this.directoryEpoch = (this.directoryEpoch || 0) + 1;
    const key = this.key('devices', '', '');
    const known = await this.cache.read(key) || [];
    if (client !== this.client) return;
    const devices = result.devices.filter(d => !d.isSelf && d.remoteControlEnabled && (d.online || known.some(old => old.id === d.deviceId)))
      .map(d => ({ id: d.deviceId, title: d.name, offline: !d.online }));
    for (const d of known) {
      if (!devices.some(row => row.id === d.id)) {
        await this.forgetHost(d.id);
        if (client !== this.client) return;
      }
    }
    this.show({ devices });
    await this.cache.write(key, devices);
  }
  async invoke(channel, args, version) {
    this.guard(version);
    const host = this.state.device;
    try {
      const response = await this.client.invoke(host, { channel, args }, undefined, {
        beforeDispatch: () => this.guard(version)
      });
      this.guard(version);
      if (!response.ok) {
        const error = new Error('电脑请求失败（' + response.error.code + '）');
        const inner = /^\[(NOT_FOUND|PERMISSION_DENIED|ACCESS_REVOKED|FORBIDDEN)\]/.exec(response.error.message || '');
        error.code = response.error.code === 'IPC_ERROR' && inner ? inner[1] : response.error.code;
        throw error;
      }
      return response.result;
    } catch (error) {
      if (version === this.version && ['ACCESS_REVOKED','REMOTE_DISABLED'].includes(error.code)) await this.forgetHost(host);
      throw error;
    }
  }
  async recover() {
    const version = this.version;
    if (this.notification) return this.openNotification();
    await this.devices();
    const { device, task } = this.state;
    if (version !== this.version) return;
    if (this.taskHome && !device) {
      const preferred = await this.cache.read(this.key('home-device', '', ''));
      if (version !== this.version || this.state.device) return;
      const next = this.homeHost(this.state.devices, preferred);
      if (next) await this.openDevice(next.id);
      return;
    }
    if (!device || !this.available(device)) return;
    await this.connectDevice(device, version);
    if (version === this.version && task) await this.attachTask(version);
    else if (version === this.version && this.newDraft && !this.state.agent) await this.configureNew();
  }
  homeHost(devices, preferred) {
    return devices.find(host => host.id === preferred) || (devices.length === 1 ? devices[0] : undefined);
  }
  available(id) {
    return this.state.relay === 'online' && this.state.devices.some(d => d.id === id && !d.offline);
  }
  async connectDevice(id, version) {
    try {
      await this.client.openLink(id, { controllerName: 'Cindy HarmonyOS', protocolVersion: PROTOCOL_VERSION, appVersion: '0.1.0', capabilities: [] });
    } catch (error) {
      if (version === this.version && ['ACCESS_REVOKED','REMOTE_DISABLED'].includes(error.code)) await this.forgetHost(id);
      throw error;
    }
    this.guard(version);
    await this.listTasks(version, this.limit || 40, this.taskHome);
    this.guard(version);
    this.show({ linked: true, error: '' });
  }
  applyHomeActivity(payload) {
    if (!payload?.sessionId || !['running','needs-interaction','completed','error'].includes(payload.phase)) return;
    const signal = { activityPhase: payload.phase, activityAttention: payload.attention === true,
      isTurnRunning: payload.phase === 'running' || payload.phase === 'needs-interaction' };
    if (this.homeRead?.version === this.version) this.homeRead.updates.set(payload.sessionId, signal);
    const previous = this.state.tasks.find(row => row.id === payload.sessionId);
    if (!previous) return;
    const fields = activityFields(signal, previous.interrupted);
    if (previous.rightStatus !== fields.rightStatus || previous.running !== fields.running) {
      this.show({ tasks: this.state.tasks.map(row => row === previous ? { ...row, ...fields } : row) });
    }
  }
  async listTasks(version, limit, subscribe = false) {
    const read = { version, updates: new Map() };
    this.homeRead = read;
    try {
      if (subscribe) {
        try {
          await this.invoke('device-link:subscribe', [{ topics: ['sessions'], controllerName: 'Cindy HarmonyOS', capabilities: [] }], version);
        } catch (error) {
          this.guard(version);
          if (!['CHANNEL_NOT_ALLOWED', 'NOT_FOUND'].includes(error.code)) throw error;
        }
      }
      const args = this.taskHome ? [limit, 'all', { includePinned: true }] : [limit, 'all'];
      const rows = await this.invoke('local-db:sessions:list', args, version);
      let active = [];
      if (this.taskHome) {
        try {
          const snapshot = await this.invoke('maker:list-active', [{ summary: true, snapshotVersion: 2 }], version);
          active = Array.isArray(snapshot) ? snapshot : snapshot?.sessions || [];
        } catch (error) {
          this.guard(version);
          if (!['CHANNEL_NOT_ALLOWED', 'NOT_FOUND'].includes(error.code)) throw error;
        }
      }
      if (this.homeRead !== read) return;
      const signals = new Map(active.filter(row => row?.sessionId).map(row => [row.sessionId, { ...row, isTurnRunning: row.isTurnRunning !== false }]));
      const tasks = rows.filter(row => row?.id && row.status !== 'deleted' && !row.hiddenAt)
        .map(row => homeTask(row, read.updates.get(row.id) || signals.get(row.id)));
      this.limit = limit;
      if (this.taskHome) this.state.homeIndex = [...(this.state.homeIndex || []).filter(r => r.host !== this.state.device),
        ...tasks.map(row => ({ ...row, host: this.state.device }))];
      this.show({ tasks, moreTasks: rows.length >= limit && limit < 1000 });
      await this.cache.write(this.key('tasks', this.state.device, ''), tasks);
    } finally { if (this.homeRead === read) this.homeRead = null; }
  }
  async more() {
    if (this.state.moreTasks && this.state.linked) await this.listTasks(this.version, Math.min(1000, this.limit + 40));
  }
  async openDevice(id) {
    if (!this.state.devices.some(d => d.id === id)) throw new Error('电脑不在当前账号的设备列表');
    const version = ++this.version;
    this.limit = 40;
    this.resetTask();
    this.show({ ...hostView, device: id, error: '' });
    if (this.taskHome) await this.cache.write(this.key('home-device', '', ''), id);
    this.guard(version);
    if (this.available(id)) return this.connectDevice(id, version);
    const tasks = await this.cache.read(this.key('tasks'));
    if (version === this.version) this.show({ tasks: tasks || [] });
  }
  async reconnect() {
    if (this.state.relay === 'online') await this.recover();
    else throw new Error('网络恢复后会自动连接');
  }
  resetTask() {
    this.newDraft = null;
    this.localMedia.clear();
    this.recentImages.clear();
    this.thumbnailQueue = Promise.resolve();
    this.cancelTransfer();
    this.cancelVoice();
    this.recording = null;
    this.failedUpload = null;
    this.uploadTickets = new Map();
    clearTimeout(this.timer);
    this.timer = null;
    this.historyFlight = null;
    this.pending = null;
    this.edits = new Map();
    this.choiceRevision = new Map();
    this.requests = [];
    this.runtimeTick = 0;
    this.cardTick = 0;
    this.preferenceList = null;
    this.ready = false;
    this.hydrated = false;
    this.cachedCount = 0;
  }
  async openTask(id) {
    if (!this.state.tasks.some(r => r.id === id)) throw new Error('请选择当前电脑上的任务');
    const version = ++this.version;
    this.resetTask();
    this.show({ ...taskView, task: id, error: '' });
    const cached = await this.loadLocalTask(version);
    this.guard(version);
    if (this.state.linked) return this.attachTask(version);
    this.show({ messages: cached?.messages || [], hasOlder: !!cached?.hasOlder });
    this.ready = true;
  }
  async loadLocalTask(version) {
    const [draft, pending, cached, attachments] = await Promise.all(['draft','outbox','history','attachments'].map(name => this.cache.read(this.key(name))));
    this.guard(version);
    this.pending = pending;
    this.hydrated = true;
    this.cachedCount = cached?.messages?.length || 0;
    this.show({ attachments: attachments || [], draft: this.dirtyDraft ? this.state.draft : (draft || ''), pendingLabel: pending?.text || pending?.attachments?.[0]?.name || '', delivery: pending ? '正在核对上次发送' : '' });
    return cached;
  }
  async attachTask(version, subscribe = true) {
    const id = this.state.task;
    if (!this.hydrated) await this.loadLocalTask(version);
    try {
      const row = await this.invoke('local-db:sessions:get', [id], version);
      if (!row || row.id !== id || row.status === 'deleted' || row.hiddenAt) throw Object.assign(new Error('任务已不可访问'), { code: 'NOT_FOUND' });
      this.show({ agent: row.agentKind || '', model: row.model || '', provider: row.providerId || '', permission: row.permissionMode || '' });
      if (subscribe) await this.invoke('device-link:subscribe', [{ topics: ['session:' + id], controllerName: 'Cindy HarmonyOS', capabilities: [] }], version);
      const tick = this.runtimeTick;
      await Promise.all([
        this.history(version, false, true), this.refreshCards(version),
        this.invoke('maker:list-active', [{ summary: true, snapshotVersion: 2 }], version).then(active => {
          if (version === this.version && tick === this.runtimeTick) {
            const rows = Array.isArray(active) ? active : active?.sessions || [];
            this.show({ running: rows.some(r => r.sessionId === id && r.isTurnRunning !== false) });
          }
        }),
      ]);
      await this.reconcile(version);
      this.guard(version);
      this.ready = true;
      this.show({ error: '' });
    } catch (error) {
      if (version === this.version && ['NOT_FOUND','FORBIDDEN','PERMISSION_DENIED'].includes(error.code)) {
        const keys = ['draft','outbox','history','attachments'].map(name => this.key(name));
        this.cancelDraftTimer();
        this.version++;
        this.resetTask();
        const tasks = this.state.tasks.filter(r => r.id !== id);
        this.show({ ...taskView, tasks, error: '任务已不可访问' });
        await Promise.all([...keys.map(key => this.cache.write(key, null)), this.cache.write(this.key('tasks'), tasks)]);
      }
      throw error;
    }
  }
  push(channel, payload) {
    const event = payload.event;
    if (channel === 'maker:interaction-request' || channel === 'maker:interaction-dismissed') {
      this.cardTick++;
      const id = payload.request?.requestId || payload.requestId;
      const keep = this.requests.filter(row => row.request.requestId !== id);
      if (channel === 'maker:interaction-request' && id) keep.push({ request: payload.request });
      this.setCards(keep);
      return;
    }
    if (channel === 'maker:input:projection') {
      this.show({ paused: !!payload.queuePaused, error: payload.error || '' });
    }
    if (channel === 'local-db:messages:deleted') {
      const ids = new Set(payload.clientIds || [payload.clientId]);
      this.show({ messages: this.state.messages.filter(m => !ids.has(m.clientId)) });
    }
    if (channel.startsWith('local-db:messages:')) this.scheduleHistory();
    if (channel !== 'maker:event' || !event || event.turnScope === 'background') return;
    const data = event.data || {};
    if (event.type === 'text' && typeof data.text === 'string') {
      this.runtimeTick++;
      this.show({ running: true, live: data.isFullText ? data.text : this.state.live + data.text });
    } else if (event.type === 'tool_use' || event.type === 'tool_result') {
      this.runtimeTick++;
      this.show({ running: true, activity: (event.type === 'tool_use' ? '正在使用 ' : '已完成 ') + (data.toolName || data.name || '工具') });
    } else if (event.type === 'status' && typeof data.isRunning === 'boolean') {
      this.runtimeTick++;
      if (data.isRunning || !isTurnContinuationBoundaryEvent(event)) this.show({ running: data.isRunning, activity: data.isRunning ? this.state.activity : '' });
    } else if (['done','error'].includes(event.type) && !isTurnContinuationBoundaryEvent(event)) {
      this.runtimeTick++;
      this.show({ running: false, activity: '', error: event.type === 'error' ? (data.message || '执行失败') : '' });
      this.scheduleHistory();
    }
  }
  setCards(rows) {
    for (const entry of rows) {
      const request = entry?.request;
      const old = this.requests.find(row => row.request.requestId === request?.requestId)?.request;
      if (old && request.kind === 'ask_user_question' && JSON.stringify(old.questions) !== JSON.stringify(request.questions)) {
        this.edits.delete(request.requestId);
        this.choiceRevision.delete(request.requestId);
      }
    }
    this.requests = rows.filter(row => row?.request?.requestId);
    for (const id of this.edits.keys()) if (!this.requests.some(r => r.request.requestId === id)) {
      this.edits.delete(id);
      this.choiceRevision.delete(id);
    }
    this.show({ cards: presentCards(this.requests, this.edits, this.choiceRevision) });
  }
  async refreshCards(version) {
    const tick = this.cardTick;
    const rows = await this.invoke('maker:get-pending-interactions', [this.state.task], version);
    if (tick === this.cardTick) this.setCards(rows);
  }
  editAnswer(id, key, value, select) {
    const request = this.requests.find(row => row.request.requestId === id)?.request;
    if (!request || !this.state.linked) return;
    if (!this.edits.has(id)) this.edits.set(id, new Map());
    if (select) this.choiceRevision.set(id, (this.choiceRevision.get(id) || 0) + 1);
    questionAnswer(request, this.edits.get(id), key, value, select);
    this.show({ cards: presentCards(this.requests, this.edits, this.choiceRevision) });
  }
  async decide(id, choice, confirmedKey = '') {
    if (!this.ready || !this.state.linked) throw new Error('请先连接任务');
    const version = this.version;
    await this.refreshCards(version);
    const r = this.requests.find(row => row.request.requestId === id)?.request;
    if (!r) throw new Error('请求已结束或已由另一端处理');
    const required = approvalKey(r);
    if (choice === 'allow' && required !== confirmedKey) throw new Error('请重新确认当前高风险操作');
    const decision = decisionFor(r, this.edits.get(id), choice);
    let receipt;
    try { receipt = await this.invoke('maker:resolve-interaction', [id, decision], version); }
    catch (error) {
      await this.refreshCards(version);
      if (this.requests.some(row => row.request.requestId === id)) throw error;
      throw new Error('请求已结束，请查看电脑端结果');
    }
    if (receipt?.accepted !== false) {
      this.cardTick++;
      this.setCards(this.requests.filter(row => row.request.requestId !== id));
    }
    await this.refreshCards(version);
    if (receipt?.accepted === false) throw new Error('请求已过期或已由另一端处理');
  }
  async control(resume) {
    if (!this.state.linked || !this.ready) throw new Error('请先连接任务');
    const version = this.version;
    const task = this.state.task;
    if (resume) await this.invoke('maker:input:resume', [task], version);
    else await this.invoke('maker:input:stop', [task, { keepQueue: true, pauseQueue: true }], version);
    await this.reconcile(version);
    this.scheduleHistory();
  }
  scheduleHistory() {
    const version = this.version;
    if (this.historyFlight?.version === version) {
      this.historyFlight.dirty = true;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (version !== this.version) return;
      const flight = { version, dirty: false };
      this.historyFlight = flight;
      try { await this.history(version); }
      catch (error) { if (version === this.version) this.report(error); }
      finally {
        if (this.historyFlight === flight) this.historyFlight = null;
        if (flight.dirty && version === this.version) this.scheduleHistory();
      }
    }, 200);
  }
  async readPage(version, task, before) {
    let limit = 40;
    for (;;) {
      try {
        const rows = await this.invoke('local-db:messages:list', [task, before ? { limit, before } : { limit }], version);
        return { page: taskPage(rows, task), more: rows.length >= limit };
      } catch (error) {
        if (error.code !== 'PAYLOAD_TOO_LARGE' || limit === 1) throw error;
        limit = Math.max(1, Math.floor(limit / 2));
      }
    }
  }
  async history(version, older = false, reset = false) {
    const task = this.state.task;
    const before = older && this.state.messages[0]?.id;
    if (older && (!before || !this.state.hasOlder)) return;
    const sequence = older ? 0 : (this.readSequence = (this.readSequence || 0) + 1);
    const previous = reset ? [] : this.state.messages;
    const { page, more } = await this.readPage(version, task, before);
    let messages = mergePage(older ? this.state.messages : previous, page, older, more);
    let hasOlder = older ? more && messages.length > previous.length :
      (messages.length > page.length ? this.state.hasOlder : more);
    // A cold/reconnected peer may have cleared or rewound the task offline.
    // Revalidate only the already-loaded window, preserving authoritative order.
    const restoreSize = reset ? Math.min(240, Math.max(this.cachedCount, this.state.messages.length)) : 0;
    while (messages.length < restoreSize && hasOlder && messages.length) {
      if (sequence !== this.readSequence) return;
      const next = await this.readPage(version, task, messages[0].id);
      const combined = mergePage(messages, next.page, true, next.more);
      hasOlder = next.more && combined.length > messages.length;
      messages = combined;
    }
    if (older ? this.state.messages[0]?.id !== before : sequence !== this.readSequence) return;
    this.show({ messages, hasOlder, live: (!this.state.running || messages.some(r => r.title === this.state.live)) ? '' : this.state.live });
    const cached = messages.slice(-240);
    this.cachedCount = cached.length;
    await this.cache.write(this.key('history'), {messages: cached, hasOlder: hasOlder || messages.length > cached.length});
  }
  older() { return this.history(this.version, true); }
  cancelDraftTimer() { clearTimeout(this.draftTimer); this.draftTimer = null; this.dirtyDraft = null; }
  editDraft(text) {
    if (!this.session || (!this.state.task && !this.newDraft)) return;
    this.show({ draft: text });
    if (this.newDraft) return;
    this.dirtyDraft = { key: this.key('draft'), text };
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => this.flushDraft().catch(e => this.report(e)), 150);
  }
  async flushDraft() {
    const draft = this.dirtyDraft;
    this.cancelDraftTimer();
    if (draft) await this.cache.write(draft.key, draft.text || null);
  }
  snapshotNew() {
    if (!this.newDraft) return;
    return { owner: this.session.id, text: this.state.draft, attachments: this.state.attachments.slice(), media: new Map(this.localMedia) };
  }
  beginNew(snapshot) {
    if (this.state.task || !this.session) return;
    this.resetTask();
    this.newDraft = {};
    const restored = snapshot && snapshot.owner === this.session.id ? snapshot : null;
    if (restored) this.localMedia = new Map(restored.media);
    this.show({ ...taskView, draft: restored?.text || '', attachments: restored?.attachments || [] });
  }
  cancelNew() {
    if (!this.newDraft) return;
    this.resetTask();
    this.show({ ...taskView, legacyPicker: false });
  }
  async configureNew(engine = '') {
    const draft = this.newDraft, version = this.version;
    if (!draft || !this.state.linked) return;
    const defaults = await this.invoke('maker:get-new-maker-defaults', [engine || 'codex'], version);
    const agent = engine || defaults.selectedAgentKind || 'codex';
    const selected = !engine && agent !== 'codex'
      ? await this.invoke('maker:get-new-maker-defaults', [agent], version) : defaults;
    if (this.newDraft !== draft) return;
    let directory, legacyPicker = false;
    try {
      directory = await this.invoke('maker:provider:list', providerPickerListArgs({
        agent, providerId: selected.providerId || null, modelId: selected.model
      }), version);
    } catch (error) {
      if (!['CHANNEL_NOT_ALLOWED', 'DEVICE_LINK_CHANNEL_NOT_ALLOWED'].includes(error.code)) throw error;
      legacyPicker = true;
    }
    if (this.newDraft !== draft) return;
    if (!legacyPicker && !Array.isArray(directory?.providers)) throw new Error('模型目录暂不可用，请重试');
    this.newDraft = {};
    this.preferenceList = null;
    this.show({ agent, model: selected.model || '', permission: selected.permissionMode || 'ask',
      provider: selected.providerId || '', legacyPicker });
  }
  async rename(title) {
    const v = this.version, task = this.state.task, value = title.trim();
    if (!this.ready || !this.state.linked || !task || !value) throw new Error('请连接任务并填写标题');
    const updated = await this.invoke('local-db:sessions:patch-meta', [task, { title: value }], v);
    const row = updated?.title ? updated : await this.invoke('local-db:sessions:get', [task], v);
    this.guard(v);
    if (row?.id !== task || !row.title) throw new Error('无法确认任务标题');
    const tasks = this.state.tasks.map(item => item.id === task ? { ...item, title: row.title } : item);
    this.show({ tasks });
    await this.cache.write(this.key('tasks', this.state.device, ''), tasks);
  }
  async engines() {
    const list = await this.invoke('maker:list-available-agents', [], this.version);
    return list.filter(id => ['codex', 'claude-code', 'pi'].includes(id));
  }
  async browse(path) {
    const result = await this.invoke('fs:list-dir', [{ path: path || '~' }], this.version);
    if (!result?.resolvedPath || !Array.isArray(result.entries)) throw new Error('电脑无法读取此目录');
    const dirs = result.entries.filter(e => e.path && ['dir','symlink'].includes(e.kind) && !e.name.startsWith('.'));
    return { path: result.resolvedPath, parent: result.parent || '', rows: [
      ...(result.drives || []).filter(d => !d.current), ...dirs
    ].map(e => ({ id: e.path, title: e.name })) };
  }
  async preferences(kind) {
    const v = this.version, agent = this.state.agent, draft = this.newDraft;
    let options;
    if (kind === 'model') {
      let directory;
      try {
        if (!this.newDraft || !this.state.legacyPicker) directory = await this.invoke('maker:provider:list', providerPickerListArgs({
          agent, providerId: this.state.provider || null, modelId: this.state.model
        }), v);
      } catch (e) {
        const unsupported = ['CHANNEL_NOT_ALLOWED', 'DEVICE_LINK_CHANNEL_NOT_ALLOWED'].includes(e.code);
        if (!unsupported && (this.newDraft || e.code !== 'NOT_FOUND')) throw e;
        directory = null;
      }
      if (directory?.providers?.length || (this.newDraft && Array.isArray(directory?.providers))) {
        const sections = buildMobileModelSections({ providers: directory.providers, agentKind: agent,
          selectedProviderId: this.state.provider, selectedModelId: this.state.model,
          existingSessionRoute: !this.newDraft, visibilityOverrides: directory.modelVisibilityOverrides });
        options = flattenProviderSections(sections.sections).map(({ provider, model }) => ({
          id: JSON.stringify([provider.id, model.id]), title: model.name || model.displayName || model.id,
          summary: provider.name, model: model.id, provider: provider.id
        }));
      }
    }
    if (!options) {
      const caps = await this.invoke('maker:get-capabilities', [agent], v);
      const reported = kind === 'model' ? caps?.availableModels : caps?.permissionModes;
      options = (reported || []).filter(o => o?.id).map(o => ({
        id: o.id, title: o.label || o.id, summary: o.description || '', model: o.id
      }));
    }
    this.guard(v);
    if (draft !== this.newDraft) return [];
    this.preferenceList = { v, kind, options, draft };
    return options;
  }
  async applyPreference(kind, value) {
    const v = this.version, task = this.state.task;
    const choices = this.preferenceList;
    if ((!this.newDraft && (!this.ready || !task)) || !this.state.linked || this.state.running || choices?.v !== v || choices.draft !== this.newDraft ||
        choices.kind !== kind || !choices.options.some(o => o.id === value)) throw new Error('请重新选择当前任务的选项');
    const option = choices.options.find(o => o.id === value);
    if (this.newDraft) {
      if (kind === 'model') {
        Object.assign(this.newDraft, { model: option.model, provider: option.provider });
        this.show({ model: option.model, provider: option.provider || '' });
      } else {
        this.newDraft.permission = value;
        this.show({ permission: value });
      }
      return;
    }
    const args = [task, kind === 'model' ? option.model : value];
    if (kind === 'model' && option.provider) args.push(option.provider);
    const result = await this.invoke(kind === 'model' ? 'maker:set-model' : 'maker:set-permission-mode', args, v);
    if (result?.superseded || result?.deferred) throw new Error('电脑正在处理变更，请稍后查看任务信息');
    const row = await this.invoke('local-db:sessions:get', [task], v);
    if (row?.id === task) this.show({ model: row.model || '', provider: row.providerId || '', permission: row.permissionMode || '' });
  }
  async create(title, project = '', firstText = '', engine = '', draftOnly = false) {
    if (this.creating) return this.creating;
    this.creating = this.createTask(title.trim(), project, firstText, engine, draftOnly).finally(() => { this.creating = null; });
    return this.creating;
  }
  async createTask(title, project, firstText, engine, draftOnly) {
    const version = this.version;
    if (!this.state.linked || this.state.task) throw new Error('请选择执行电脑');
    const key = this.key('creation');
    let intent = await this.cache.read(key);
    this.guard(version);
    const attachments = this.newDraft ? this.state.attachments.slice() : [];
    const options = {};
    if (this.newDraft?.model) Object.assign(options, { model: this.newDraft.model,
      provider: this.newDraft.provider || '', agent: this.state.agent });
    if (this.newDraft?.permission) Object.assign(options, { permission: this.newDraft.permission, agent: this.state.agent });
    if (!intent) {
      intent = { id: util.generateRandomUUID(true), title, project, firstText, engine, attachments, options, draftOnly };
      await this.cache.write(key, intent);
    }
    const sameInput = !!intent.draftOnly === draftOnly && (intent.firstText || '') === firstText && (intent.project || '') === project && (intent.title || '') === title && (intent.engine || '') === engine &&
      JSON.stringify((intent.attachments || []).map(a => a.id)) === JSON.stringify(attachments.map(a => a.id)) &&
      JSON.stringify(intent.options || {}) === JSON.stringify(options);
    const existing = await this.invoke('local-db:sessions:get-many', [[intent.id]], version);
    const row = existing.find(r => r.id === intent.id);
    if (!row) {
      const requested = intent.engine || intent.options?.agent || '';
      if (requested && !(await this.engines()).includes(requested)) throw new Error('所选引擎在当前电脑上不可用');
      let defaults = await this.invoke('maker:get-new-maker-defaults', [requested || 'codex'], version);
      let agentKind = requested || defaults.selectedAgentKind;
      if (!agentKind) {
        const available = await this.invoke('maker:list-available-agents', [], version);
        agentKind = available.find(agent => ['codex','claude-code','pi'].includes(agent));
        if (!agentKind) throw new Error('电脑上没有可用于新任务的引擎');
      }
      if (!requested && agentKind !== 'codex') defaults = await this.invoke('maker:get-new-maker-defaults', [agentKind], version);
      const model = intent.options?.model || defaults.model;
      if (!model) throw new Error('请先在这台电脑上选择新任务的默认模型');
      if (intent.options?.provider) {
        const catalog = await this.invoke('maker:provider:list', providerPickerListArgs({
          agent: agentKind, providerId: intent.options.provider, modelId: model
        }), version);
        const sections = buildMobileModelSections({ providers: catalog?.providers || [], agentKind,
          selectedProviderId: intent.options.provider, selectedModelId: model, visibilityOverrides: catalog?.modelVisibilityOverrides });
        if (!flattenProviderSections(sections.sections).some(r => r.provider.id === intent.options.provider && r.model.id === model)) {
          // No create was dispatched. Release this intent so the user can pick a current route.
          await this.cache.write(key, null);
          throw new Error('所选模型或来源已变更，请重新选择');
        }
      }
      const defaultModel = model === defaults.model && (!intent.options?.model || (intent.options.provider || '') === (defaults.providerId || ''));
      const result = await this.invoke('maker:create-session', [{ id: intent.id, workspaceKind: intent.project ? 'project' : 'dialogue', ...(intent.project ? { workingDir: intent.project } : {}), agentKind,
        model, providerId: (intent.options?.model ? intent.options.provider : defaults.providerId) || undefined, effort: defaultModel ? defaults.effort || '' : '', fastMode: defaultModel ? defaults.fastMode : undefined,
        permissionMode: permissionModeOrAsk(intent.options?.permission || defaults.permissionMode) }], version);
      if (result?.sessionId !== intent.id) throw new Error('电脑返回的任务与创建请求不一致');
    }
    if (intent.title && row?.title !== intent.title) await this.invoke('local-db:sessions:patch-meta', [intent.id, { title: intent.title }], version);
    const tasks = [{ id: intent.id, title: intent.title || row?.title || '新任务', project: intent.project || '' }, ...this.state.tasks.filter(t => t.id !== intent.id)];
    this.show({ tasks });
    await this.cache.write(this.key('tasks'), tasks);
    this.guard(version);
    await this.openTask(intent.id);
    const opened = this.version;
    if (this.state.task !== intent.id || this.session?.id !== key[0] || this.state.device !== key[1]) return;
    if (intent.attachments?.length) {
      await this.setAttachments(intent.attachments);
      this.guard(opened);
    }
    if (intent.firstText) {
      this.editDraft(intent.firstText);
      await this.flushDraft();
      this.guard(opened);
    }
    await this.cache.write(key, null);
    this.guard(opened);
    if (!sameInput) {
      this.show({ error: '已恢复上次创建的任务，请核对草稿和项目后发送' });
      return;
    }
    if (!intent.draftOnly && (intent.firstText || intent.attachments?.length)) await this.send(intent.firstText || '');
    return true;
  }
  async checkDelivery() {
    if (!this.ready || !this.state.linked) throw new Error('请先连接任务');
    await this.reconcile(this.version);
  }
  async reconcile(version) {
    const pending = this.pending;
    const task = this.state.task;
    const ids = pending ? [task, { deliveryClientIds: [pending.id] }] : [task];
    const projection = await this.invoke('maker:input:get-projection', ids, version);
    this.deliverySupported = projection?.inputDeliveryVersion === 1;
    this.show({ paused: !!projection?.queuePaused && !!projection.pendingQueue?.length });
    if (!pending || this.pending !== pending) return;
    const receipt = projection?.deliveryReceipts?.find(r => r.clientId === pending.id);
    const accepted = ['accepted','pending','removed'].includes(receipt?.state) ||
      projection?.pendingQueue?.some(r => r.clientId === pending.id) ||
      this.state.messages.some(r => r.clientId === pending.id || r.id === pending.id);
    if (accepted) return this.acknowledge(pending, version);
    if (!this.deliverySupported) {
      try {
        const around = await this.invoke('local-db:messages:around-client-id', [task, pending.id, { radius: 1 }], version);
        const found = Array.isArray(around) ? around : around?.messages;
        if (found?.some(row => row.sessionId === task && row.clientId === pending.id)) return this.acknowledge(pending, version);
      } catch (error) {
        this.guard(version);
        if (!['NOT_FOUND','CHANNEL_NOT_ALLOWED'].includes(error.code)) throw error;
      }
    }
    const retryable = receipt?.state === 'unknown' && pending.retrySafe === true;
    this.show({ retryable, delivery: retryable ? '电脑尚未收到原消息' : '发送结果待确认' });
    return retryable;
  }
  async acknowledge(pending, version) {
    this.guard(version);
    const key = this.key('outbox');
    const sent = new Set((pending.attachments || []).map(a => a.id));
    const sameDraftFiles = this.state.attachments.length === sent.size && this.state.attachments.every(a => sent.has(a.id));
    for (const file of pending.attachments || []) {
      const uri = this.localMedia.get(file.id);
      if (uri && file.path && file.mimeType?.startsWith('image/')) {
        this.recentImages.set(file.path, { uri, until: Infinity });
        if (this.recentImages.size > 20) this.recentImages.delete(this.recentImages.keys().next().value);
      }
      this.localMedia.delete(file.id);
    }
    if (sent.size) await this.setAttachments(this.state.attachments.filter(a => !sent.has(a.id)));
    this.guard(version);
    if (this.state.draft === pending.text && sameDraftFiles) this.editDraft('');
    this.show({ retryable: false, delivery: '' });
    await this.flushDraft();
    await this.cache.write(key, null);
    if (this.pending === pending) this.pending = null;
  }
  async send(text) {
    if (this.sending) return this.sending;
    this.sending = this.sendOnce(text).finally(() => { this.sending = null; });
    return this.sending;
  }
  async retryOriginal() {
    if (this.sending || !this.pending || !this.state.retryable) return;
    this.sending = this.sendOnce(this.pending.text, true).finally(() => { this.sending = null; });
    return this.sending;
  }
  async sendOnce(text, original = false) {
    if ((!original && !text.trim() && !this.state.attachments.length) || this.transfer || !this.ready || !this.state.task || !this.state.linked) throw new Error('请先连接任务');
    const version = this.version;
    const task = this.state.task;
    if (this.pending) {
      const retry = await this.reconcile(version);
      this.guard(version);
      if (!this.pending) return;
      if (!retry || (!original && (this.pending.text !== text || JSON.stringify((this.pending.attachments || []).map(f => f.id)) !== JSON.stringify(this.state.attachments.map(f => f.id))))) throw new Error('上次发送结果待确认，请先核对原消息');
    }
    const row = await this.invoke('local-db:sessions:get', [task], version);
    if (!row || row.id !== task || !row.workingDir) throw new Error('无法确认任务工作目录');
    if (row.agentDeviceId || row.agentSwitchIntent) throw new Error('此任务涉及远程执行或切换 Agent，暂不支持发送');
    const pending = this.pending || { id: util.generateRandomUUID(true), text, attachments: this.state.attachments.slice(), retrySafe: this.deliverySupported };
    const clientId = pending.id;
    this.pending = pending;
    await this.flushDraft();
    this.guard(version);
    await this.cache.write(this.key('outbox'), pending);
    const createdAt = new Date().toISOString();
    const createOpts = {
      agentKind: row.agentKind || 'claude-code', workingDir: row.workingDir,
      model: row.model, effort: row.effort || '', permissionMode: permissionModeOrAsk(row.permissionMode),
      fastMode: row.fastMode, planMode: row.planMode, projectDir: row.projectDir || undefined,
      providerId: row.providerId || undefined, remoteHostId: row.remoteHostId || undefined,
      resumeSessionId: row.sdkSessionId || undefined, displayReasoning: 'summarized'
    };
    const attachments = pending.attachments || [];
    const { images, files } = messageMedia(attachments);
    const item = {
      ...(attachments.length ? { files: attachments } : {}),
      clientId, text, uiLanguage: 'zh-CN', workingDir: row.workingDir,
      model: row.model, effort: createOpts.effort, permissionMode: createOpts.permissionMode,
      persistedContent: JSON.stringify({ text, images, files }),
      chatMessage: { clientId, role: 'user', content: text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), isStreaming: false, createdAt },
      createOpts
    };
    try {
      await this.invoke('maker:input:enqueue', [task, item, { sendAtMs: Date.now() }], version);
    } catch (error) {
      if (version === this.version) this.show({ retryable: false, delivery: '发送结果待确认', pendingLabel: pending.text || pending.attachments?.[0]?.name || '附件' });
      throw error;
    }
    await this.acknowledge(pending, version);

  }
  external(event) {
    if (event.error) { this.show({ error: event.error }); return; }
    if (event.share) {
      this.share = event.share;
      const files = event.share.uris.map(uri => displayName(uri) || '附件');
      this.show({ shareVersion: (this.state.shareVersion || 0) + 1, shareText: event.share.text || '', shareFiles: files,
        shareLabel: event.share.text.slice(0, 60) || files[0] || '' });
      return;
    }
    if (!event.target) return;
    if (!this.session) { this.notification = event.target; return; }
    if (event.target.owner !== this.session.id) {
      this.show({ error: '通知所属账号与当前登录账号不匹配' }); return;
    }
    this.notification = event.target;
    if (this.state.relay === 'online') this.openNotification().catch(e => this.report(e));
  }
  openNotification() {
    if (!this.routeFlight) {
      this.routeFlight = this.drainNotifications().finally(() => { this.routeFlight = null; });
    }
    return this.routeFlight;
  }
  async drainNotifications() {
    while (this.notification && this.session) {
      const target = this.notification;
      this.notification = null;
      if (target.owner !== this.session.id) {
        this.show({ error: '通知所属账号与当前登录账号不匹配' });
        await this.devices();
      } else {
        await this.routeNotification(target);
      }
    }
  }
  async routeNotification(target) {
    const epoch = this.authEpoch, version = this.version;
    await this.devices();
    if (this.notification || epoch !== this.authEpoch || version !== this.version) return;
    if (!this.available(target.host)) throw new Error('通知对应的电脑离线或已撤权');
    await this.flushDraft();
    this.guard(version);
    if (this.state.device !== target.host || !this.state.linked) {
      if (this.state.device && this.state.device !== target.host && this.state.linked) this.client.closeLink(this.state.device, 'user');
      await this.openDevice(target.host);
    }
    const before = this.version;
    const row = await this.invoke('local-db:sessions:get', [target.task], before);
    if (!row || row.id !== target.task || row.hiddenAt || row.status === 'deleted') throw new Error('通知对应的任务已不可访问');
    if (this.state.task === row.id) { await this.history(before); return; }
    if (this.state.task) await this.back();
    if (!this.state.tasks.some(r => r.id === row.id)) this.show({ tasks: [{ id: row.id, title: row.title || '任务' }, ...this.state.tasks] });
    await this.openTask(row.id);
  }
  foreground() {
    if (!this.session || this.state.relay !== 'online' || !this.state.linked || !this.state.task || !this.ready || this.foregroundRead) return;
    const v = this.version;
    this.foregroundRead = this.attachTask(v, false).catch(e => { if (v === this.version) this.report(e); }).finally(() => { this.foregroundRead = null; });
  }
  async notificationSettings() {
    await this.native.notificationSettings(this.context);
    if (this.state.pushEnabled) await this.refreshPush();
  }
  refreshPush(rotatedToken) {
    if (!this.native || !this.session) return;
    return this.changePush(true, false, rotatedToken).catch(e => this.report(e));
  }
  changePush(enable, prompt = true, rotatedToken) {
    const owner = this.session?.id;
    const run = async () => {
      if (!owner || owner !== this.session?.id) return;
      try {
        if (enable && !prompt && !await this.native.restorePush(owner)) return;
        if (enable) await this.native.enablePush(this, owner, prompt, rotatedToken);
        else await this.native.disablePush(owner, this.access);
        if (owner === this.session?.id) this.show({ pushEnabled: enable, pushStatus: enable ? '任务通知已开启' : '' });
      } catch (e) {
        if (owner !== this.session?.id) return;
        const enabled = await this.native.restorePush(owner);
        const status = e.code === 1000900010 ? '当前应用签名未通过华为推送身份校验' :
          e.httpStatus === 400 || e.httpStatus === 503 ? '当前服务暂未支持华为通知投递' :
          (typeof e.code === 'number' ? '华为通知暂不可用（' + e.code + '）' : e.message);
        this.show({ pushEnabled: enabled, pushStatus: status || '通知暂不可用' });
      }
    };
    return this.pushQueue = (this.pushQueue || Promise.resolve()).then(run, run);
  }
  async setAttachments(attachments) {
    const key = this.key('attachments');
    this.show({ attachments });
    if (!this.newDraft) await this.cache.write(key, attachments.length ? attachments : null);
  }
  localPreview(id) {
    const entry = this.recentImages.get(id);
    return this.localMedia.get(id) || (entry?.until > Date.now() ? entry.uri : '');
  }
  thumbnail(file, visible) {
    const version = this.version;
    const read = async () => {
      if (!visible() || version !== this.version || !this.state.linked) return '';
      const local = this.localPreview(file.path);
      if (local) return local;
      if (!(file.size > 0 && file.size <= 2 * 1024 * 1024) || !file.mimeType?.startsWith('image/')) return '';
      const ref = typeof file.path === 'string' && parseAttachmentOssRef(file.path);
      if (!ref || isSharedTaskMediaKey(ref.ossKey)) return '';
      try {
        return await this.previewUrl(file.path, true);
      } catch { return ''; }
    };
    return this.thumbnailQueue = this.thumbnailQueue.then(read, read);
  }
  async previewUrl(path, thumbnail = false) {
    if (!this.state.task || !this.state.linked) throw new Error('请先连接任务');
    const v = this.version;
    const ref = typeof path === 'string' && parseAttachmentOssRef(path);
    if (!ref || isSharedTaskMediaKey(ref.ossKey)) throw new Error('此附件需在电脑上打开');
    const token = await this.token();
    this.guard(v);
    const result = await request(deviceLinkApiBaseUrl + '/api/device-link/media/presign-get', { key: ref.ossKey }, token);
    this.guard(v);
    if (!/^https:\/\//i.test(result?.getUrl || '')) throw new Error('附件预览不可用');
    if (thumbnail) {
      const expiry = Date.parse(result.expiresAt || '');
      this.recentImages.set(path, { uri: result.getUrl, until: Math.min(Date.now() + 60000, Number.isFinite(expiry) ? expiry : Infinity) });
      if (this.recentImages.size > 20) this.recentImages.delete(this.recentImages.keys().next().value);
    }
    return result.getUrl;
  }
  removeFile(id) {
    this.localMedia.delete(id);
    return this.setAttachments(this.state.attachments.filter(f => f.id !== id));
  }
  cancelTransfer() {
    const t = this.transfer;
    if (t) { t.cancelled = true; t.abort?.(); this.transfer = null; this.show({ transfer: '', uploadName: '' }); }
  }
  discardFailed() { this.failedUpload = null; this.show({ failedFile: '' }); }
  async retryFile() {
    const f = this.failedUpload;
    if (f && f.version === this.version) return this.addFile(f.kind, f.uri);
  }
  async addFile(kind, supplied) {
    if ((!this.newDraft && (!this.ready || !this.state.task)) || !this.state.linked || this.transfer || this.sending) throw new Error('请先打开任务');
    if (this.state.attachments.length >= 20) throw new Error('每条消息最多可添加 20 个附件');
    const v = this.version, t = { cancelled: false, tickets: this.uploadTickets };
    this.transfer = t;
    this.show({ transfer: supplied ? '正在上传' : '正在选择' });
    let uri, name;
    try {
      uri = supplied || await this.native.pickFile(this.context, kind === 'image');
      if (!uri || t.cancelled) return false;
      this.guard(v);
      name = displayName(uri) || (kind === 'image' ? '图片' : '文件');
      this.discardFailed();
      this.show({ transfer: '正在上传', uploadName: name });
      const f = await this.native.uploadFile(this.context, uri, () => this.token(), t, this.state.attachments);
      if (t.cancelled) return false;
      this.guard(v);
      this.localMedia.set(f.id, uri);
      if (!this.state.attachments.some(a => a.id === f.id)) await this.setAttachments([...this.state.attachments, f]);
      return true;
    } catch (e) {
      if (t.cancelled || e.code === 13900042 || v !== this.version) return false;
      if (uri) { this.failedUpload = { kind, uri, version: v }; this.show({ failedFile: name || '附件' }); }
      throw e;
    }
    finally { if (this.transfer === t) { this.transfer = null; this.show({ transfer: '', uploadName: '' }); } }
  }
  shareImage(index) {
    const uri = this.share?.uris[index];
    return uri && /\.(png|jpe?g|webp|gif|heic)$/i.test(displayName(uri)) ? uri : '';
  }
  dismissShare() { if (this.share && this.transfer?.share === this.share) this.cancelTransfer(); this.share = null; this.show({ shareLabel: '', shareText: '', shareFiles: [] }); }
  async acceptShare() {
    const share = this.share;
    if (!share || !this.ready || !this.state.task) throw new Error('请先选择接收分享的任务');
    const v = this.version;
    if (this.transfer) return;
    const files = [...this.state.attachments];
    const transfer = { cancelled: false, tickets: this.uploadTickets, share };
    if (share.uris.length) {
      this.transfer = transfer;
      this.show({ transfer: '正在上传' });
      try {
        share.prepared ||= new Map();
        for (const uri of share.uris) {
          if (this.share !== share || transfer.cancelled) return;
          this.guard(v);
          let file = share.prepared.get(uri);
          if (!file) {
            file = await this.native.uploadFile(this.context, uri, () => this.token(), transfer, files);
            if (this.share !== share || transfer.cancelled) return;
            this.guard(v);
            share.prepared.set(uri, file);
          }
          this.localMedia.set(file.id, uri);
          if (!files.some(f => f.id === file.id)) files.push(file);
        }
        if (files.length > 20) throw new Error('每条消息最多可添加 20 个附件');
        await this.setAttachments(files);
        this.guard(v);
      } finally {
        if (this.transfer === transfer) { this.transfer = null; this.show({ transfer: '', uploadName: '' }); }
      }
    }
    if (this.share !== share) return;
    if (share.text) this.editDraft([this.state.draft,share.text].filter(Boolean).join('\n'));
    this.dismissShare();
    await this.flushDraft();
  }
  startVoice() {
    if ((!this.newDraft && (!this.ready || !this.state.task)) || !this.state.linked || this.recording) return;
    const v = this.version;
    const take = ++this.voiceTake;
    this.show({ voice: '准备录音' });
    this.recording = this.native.dictation(this.context, (voice, preview) => {
      if (v === this.version && take === this.voiceTake) this.show({ voice, ...(preview === undefined ? {} : { voicePreview: preview }) });
    }, (text, error) => {
      if (v !== this.version || take !== this.voiceTake) return;
      this.recording = null;
      this.show({ voice: '', voicePreview: '' });
      if (text) this.editDraft([this.state.draft, text].filter(Boolean).join(' '));
      if (error) this.report(new Error(error));
      this.voiceFinishReply?.(!!text?.trim() && !error);
      this.voiceFinishReply = null;
    });
  }
  finishVoiceForSend() {
    if (!this.recording || this.voiceFinishReply) return Promise.resolve(false);
    return new Promise(resolve => { this.voiceFinishReply = resolve; this.recording.finish(); });
  }
  finishVoice() { this.recording?.finish(); }
  cancelVoice() {
    const recording = this.recording;
    if (!recording) return;
    this.voiceTake++;
    this.voiceFinishReply?.(false);
    this.voiceFinishReply = null;
    this.recording = null;
    recording.cancel();
    this.show({ voice: '', voicePreview: '' });
  }
  async back() {
    await this.flushDraft();
    const { task, device, linked } = this.state;
    const version = ++this.version;
    this.resetTask();
    if (task) {
      this.show({ ...taskView, error: '' });
      if (linked) await this.invoke('device-link:unsubscribe', [{ topics: ['session:' + task] }], version);
    } else if (device) {
      if (linked) this.client.closeLink(device, 'user');
      this.show({ ...hostView, error: '' });
    }
  }
  async clearAccount(waitForPush = true) {
    const owner = this.session?.id;
    const access = this.access;
    this.native?.invalidateExternal?.();
    this.share = null;
    this.notification = null;
    this.authEpoch++;
    this.version++;
    const client = this.client;
    this.client = null;
    this.session = null;
    this.access = null;
    this.cancelDraftTimer();
    this.resetTask();
    client?.stop();
    this.show({ ...hostView, shareLabel: '', shareText: '', shareFiles: [], pushEnabled: false, pushStatus: '', accounts: [], account: '', accountEmail: '', accountAvatar: '', relay: '', devices: [], error: '' });
    await Promise.all([this.storeSession(null), owner && this.cache.forget(owner)]);
    if (owner && this.native) {
      const disable = () => this.native.disablePush(owner, access);
      this.pushQueue = (this.pushQueue || Promise.resolve()).then(disable, disable);
      if (waitForPush) await this.pushQueue;
      else this.pushQueue.catch(e => this.report(e));
    }
  }
  async logout() { await this.clearAccount(); }
}
