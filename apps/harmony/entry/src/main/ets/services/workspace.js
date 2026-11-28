import { editAttachments, updateEditRanges } from './messageEdit';
import { Companions, resolveCompanion } from './companions';
import { HomeDevices } from './homeDevices';
import { homeTask } from './homeList';
import { modelBrand, providerBrand } from './modelBrand';
import { messageMedia } from './media';
import { openCache } from './cache';
import { approvalKey, taskPage, messageActionRows, mergePage, presentCards, questionAnswer, decisionFor } from './taskModel';
import util from '@ohos.util';
import { resolveRemoteInvokeTimeoutMs, buildTaskDeepLink, isSharedTaskPeer, mobileSessionBulkPatch, normalizeScheduleList, buildMobileModelSections, flattenProviderSections, providerPickerListArgs, deviceLinkApiBaseUrl, DeviceLinkClient, parseAttachmentOssRef, isSharedTaskMediaKey, PROTOCOL_VERSION, permissionModeOrAsk, isTurnContinuationBoundaryEvent } from './protocol.generated';
import { accountUrl, directoryUrl, relayUrl, request, deviceIdentity, readSession, saveSession, createSocket } from './platform';

import { authorize, cancelAuthorization, consumeAuthorization, listenForWant, pendingAuthorization } from './sso';

const taskView = { canEditHistory: false, editingMessage: '', editFileCount: 0, editRecoverable: false, editSubmitting: false, queuedInputs: 0, taskCompanion: undefined, legacyPicker: false, agent: '', model: '', provider: '', permission: '', voicePreview: '', voiceCaret: undefined, pendingUploads: [], pickingFiles: false, waitingToCreate: false, failedFile: '', task: '', messages: [], live: '', draft: '', cards: [], running: false,
  attachments: [], transfer: '', uploadPending: false, voice: '', activity: '', hasOlder: false, paused: false, retryable: false, delivery: '' };
const hostView = { ...taskView, device: '', tasks: [], linked: false, moreTasks: false };

// One instance owns one visible account. Only the native page can initiate a send.
function displayName(uri, limit = 80) {
  try { return decodeURIComponent(uri.split(/[?#]/)[0].split('/').pop()).replace(/[\u0000-\u001f]/g, '').slice(0, limit); }
  catch { return ''; }
}

export class Workspace {
  constructor(changed, taskHome = false) {
    this.taskHome = taskHome;
    this.home = taskHome ? new HomeDevices(this) : null;
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
      const allowed = new Set(devices.map(d => d.id));
      for (const id of this.home.peers.keys()) {
        if (!allowed.has(id) || devices.find(d => d.id === id)?.offline) this.home.drop(id, true);
      }
      if (!allowed.has(this.home.scope)) this.home.scope = '';
      patch.homeIndex = (this.state.homeIndex || []).filter(row => allowed.has(row.host));
      for (const host of devices) {
        if (!owner || this.home.peers.get(host.id)?.loaded) continue;
        Promise.all([this.cache.read([owner, host.id, '', 'tasks']), this.cache.draftTasks?.(owner, host.id)])
          .then(([rows, drafts]) => {
            if (!rows || this.session?.id !== owner || this.state.devices !== devices || this.home.peers.get(host.id)?.loaded) return;
            this.putHomeRows(host.id, rows.map(row => ({ ...row, localDraft: drafts ? drafts.has(row.id) : row.localDraft })));
          }).catch(() => {});
      }
    }
    if (this.home && patch.tasks && !patch.homeIndex && patch.device === undefined && this.state.device) {
      const host = this.state.device;
      patch.homeIndex = [...(this.state.homeIndex || []).filter(row => row.host !== host), ...patch.tasks.map(row => ({ ...row, host }))];
    }
    if (patch.linked === false) patch.editSubmitting = false;
    const wasRunning = !!(this.state.running || this.state.live);
    Object.assign(this.state, patch);
    if (this.home) {
      const live = [...this.home.peers.values()].filter(peer => peer.loaded);
      this.state.liveHosts = live.map(peer => peer.id);
      this.state.moreTasks = live.some(peer => peer.more && (!this.home.scope || this.home.scope === peer.id));
    }
    const running = !!(this.state.running || this.state.live);
    const refreshActions = patch.messages || wasRunning !== running || 'linked' in patch || 'taskCompanion' in patch ||
      patch.cards || 'canEditHistory' in patch;
    if (refreshActions) {
      const writable = this.state.linked && !isSharedTaskPeer(this.state.device);
      this.visibleMessages = messageActionRows(this.state.messages, running, writable && !this.companion && !this.botSession,
        writable && this.state.canEditHistory && !this.state.cards.length);
    }
    if (this.editing && !this.state.editSubmitting && (this.state.queuedInputs ||
        ((refreshActions || 'editSubmitting' in patch) && !this.currentEditRow(this.editing.id)))) {
      this.cancelMessageEdit();
      return;
    }
    if (this.editing && !this.state.editSubmitting && wasRunning !== running) {
      this.editing.previewSequence++;
      this.state.editFileCount = 0;
      if (!running) this.previewMessageEdit(this.editing);
    }
    this.changed({ ...this.state, messages: this.visibleMessages || this.state.messages });
  }
  putHomeRows(host, tasks) {
    const homeIndex = [...(this.state.homeIndex || []).filter(row => row.host !== host), ...tasks.map(row => ({ ...row, host }))];
    this.show(host === this.state.device ? { tasks, homeIndex } : { homeIndex });
  }
  setHomeScope(id) {
    if (!this.home || this.home.scope === id) return;
    this.home.scope = id;
    this.show({});
    if (this.directoryReady) this.home.sync();
  }
  async init(context) {
    this.context = context;
    this.locale = context.config?.language || 'zh-CN';
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
      this.directoryReady = false;
      this.home?.clear(false);
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
        this.home?.drop(env.src);
        if (this.home) this.show({});
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
      if (env.kind !== 'push') return;
      const { channel, payload } = env.payload || {};
      this.home?.push(env.src, channel, payload);
      if (env.src !== this.state.device) return;
      if (this.state.task && this.state.linked && payload?.sessionId === this.state.task) this.push(channel, payload);
    });
    if (this.home) {
      this.companions = new Companions(this);
      this.companions.refresh();
    }
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
  async forgetHost(host, directoryUpdate = false) {
    if (!this.session) return;
    const owner = this.session.id;
    const lostScope = this.home?.scope === host;
    this.directoryRead?.add(host);
    this.home?.drop(host, true);
    if (this.state.device === host) {
      this.version++;
      this.cancelDraftTimer();
      this.resetTask();
      this.show({ ...hostView, error: '电脑远程访问权限已关闭' });
    }
    const devices = this.state.devices.filter(d => d.id !== host);
    this.show({ devices });
    await Promise.all([this.cache.forget(owner, host), this.cache.write([owner, '', '', 'devices'], devices)]);
    if (lostScope && !directoryUpdate && this.session?.id === owner && this.directoryReady) await this.home.sync();
  }
  async devices(syncHome = true) {
    const client = this.client;
    const revoked = new Set();
    this.directoryRead = revoked;
    const current = () => client === this.client && this.directoryRead === revoked;
    let result;
    try {
      const token = await this.token();
      try { result = await request(directoryUrl, null, token); }
      catch (error) {
        if (error.httpStatus !== 401 || !current()) throw error;
        if (this.access === token) this.expires = 0;
        result = await request(directoryUrl, null, await this.token());
      }
    } catch (error) {
      if (!current()) return false;
      if (this.session && [401,403].includes(error.httpStatus)) {
        const account = this.session.id;
        const host = this.state.device;
        this.directoryEpoch = (this.directoryEpoch || 0) + 1;
        this.version++;
        this.directoryReady = false;
        if (host && !this.home && this.state.linked) client.closeLink(host, 'user');
        this.cancelDraftTimer();
        this.resetTask();
        this.show({ ...hostView, devices: [], error: '当前账号无法访问设备目录' });
        await this.cache.forget(account);
      }
      throw error;
    }
    if (!current()) return false;
    this.directoryEpoch = (this.directoryEpoch || 0) + 1;
    const key = this.key('devices', '', '');
    const known = await this.cache.read(key) || [];
    if (!current()) return false;
    const listed = result.devices.filter(d => !d.isSelf && d.remoteControlEnabled && (d.online || known.some(old => old.id === d.deviceId)))
      .map(d => ({ id: d.deviceId, title: d.name, offline: !d.online }));
    for (const d of known) {
      if (!listed.some(row => row.id === d.id)) {
        await this.forgetHost(d.id, true);
        if (!current()) return false;
      }
    }
    const devices = listed.filter(d => !revoked.has(d.id));
    this.directoryReady = true;
    this.show({ devices });
    await this.cache.write(key, devices);
    if (current() && syncHome) await this.home?.sync(true);
  }
  async invoke(channel, args, version) {
    this.guard(version);
    const host = this.state.device;
    try {
      return await this.requestHost(this.client, host, channel, args, () => this.guard(version));
    } catch (error) {
      if (version === this.version && ['ACCESS_REVOKED','REMOTE_DISABLED'].includes(error.code)) await this.forgetHost(host);
      throw error;
    }
  }
  async requestHost(client, host, channel, args, guard) {
    guard();
    const timeout = (channel === 'maker:fork' || channel.startsWith('maker:rewind:')) ? resolveRemoteInvokeTimeoutMs(channel, args, 'mobile') : undefined;
    const response = await client.invoke(host, { channel, args }, timeout, { beforeDispatch: guard });
    guard();
    if (!response.ok) {
      const inner = /^\[(NOT_FOUND|PERMISSION_DENIED|ACCESS_REVOKED|FORBIDDEN|SESSION_RUNNING|REWIND_TARGET_NOT_LATEST|EDIT_NOT_LAST_MESSAGE|NO_PRIOR_ASSISTANT)\]/.exec(response.error.message || '');
      const code = response.error.code === 'IPC_ERROR' && inner ? inner[1] : response.error.code;
      const error = new Error('电脑请求失败（' + code + '）');
      error.code = code;
      throw error;
    }
    return response.result;
  }
  async recover() {
    const version = this.version;
    if (this.notification) return this.openNotification();
    if (await this.devices(false) === false) return;
    const { device, task } = this.state;
    const syncing = this.home?.sync(true);
    if (version !== this.version) return syncing;
    if (this.taskHome && !device) {
      const preferred = await this.cache.read(this.key('home-device', '', ''));
      if (version !== this.version || this.state.device) return;
      const next = this.homeHost(this.state.devices, preferred);
      if (next) await this.openDevice(next.id);
      await syncing;
      return;
    }
    if (!device || !this.available(device)) return syncing;
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
    if (this.home) {
      await this.home.load(id);
      this.guard(version);
      const tasks = (this.state.homeIndex || []).filter(row => row.host === id);
      this.show({ tasks, linked: true, error: '' });
      return;
    }
    try {
      await this.client.openLink(id, { controllerName: 'Cindy HarmonyOS', protocolVersion: PROTOCOL_VERSION, appVersion: '0.1.0', capabilities: [] });
    } catch (error) {
      if (version === this.version && ['ACCESS_REVOKED','REMOTE_DISABLED'].includes(error.code)) await this.forgetHost(id);
      throw error;
    }
    this.guard(version);
    await this.listTasks(version, this.limit || 40);
    this.guard(version);
    this.show({ linked: true, error: '' });
  }
  async listTasks(version, limit) {
    const rows = await this.invoke('local-db:sessions:list', [limit, 'all'], version);
    const tasks = rows.filter(row => row?.id && row.status !== 'deleted' && !row.hiddenAt).map(row => homeTask(row));
    this.limit = limit;
    this.show({ tasks, moreTasks: rows.length >= limit && limit < 1000 });
    await this.cache.write(this.key('tasks', this.state.device, ''), tasks);
  }
  async more() {
    if (this.home) { await this.home.more(); return; }
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
    if (this.home && this.directoryReady) this.home.sync();
    if (this.available(id)) return this.connectDevice(id, version);
    const [tasks, drafts] = await Promise.all([this.cache.read(this.key('tasks')), this.home && this.cache.draftTasks?.(this.session.id, id)]);
    if (version === this.version) this.show({ tasks: (tasks || []).map(row => drafts ? { ...row, localDraft: drafts.has(row.id) } : row) });
  }
  async reconnect() {
    if (this.state.relay === 'online') await this.recover();
    else throw new Error('网络恢复后会自动连接');
  }
  resetTask() {
    this.editing = null;
    this.companion = null;
    this.botSession = false;
    this.newDraft = null;
    this.localMedia.clear();
    this.recentImages.clear();
    this.thumbnailQueue = Promise.resolve();
    this.cancelTransfer();
    this.cancelVoice();
    this.recording = null;
    this.uploadBatch = null;
    this.createWait?.resolve?.(false);
    this.createWait = null;
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
    await this.enterTask(id);
  }
  async refreshCompanions() {
    const reads = [...this.home.peers.values()].flatMap(peer => [peer.bots?.refresh(), peer.groups?.refresh()]);
    await Promise.all([this.companions?.refresh(), ...reads]);
  }
  loadCompanionCall(key, visible = true) { return this.companions?.loadCall(key, visible); }
  async companionAvatar(row, visible) { return await this.companions?.avatars.load(row, visible) || ''; }
  async openCompanion(key) {
    const roster = this.companions;
    const lookup = () => roster.rows().find(row => row.key === key);
    const row = lookup();
    if (!row) throw new Error('伙伴已不可访问');
    if (row.group || row.actor) return roster.openRoom(row);
    if (!this.available(row.host)) throw new Error('请等待伙伴的电脑上线');
    if (this.state.device !== row.host || !this.state.linked) await this.openDevice(row.host);
    const v = this.version;
    if (this.companions !== roster || this.state.device !== row.host || !lookup()) throw new Error('伙伴名单已变更');
    const id = await resolveCompanion((ch, args) => this.invoke(ch, args, v), row.id, this.locale);
    this.guard(v);
    await this.enterTask(id, row);
  }
  async retryGroupProfile() {
    const roster = this.companions;
    if (!roster?.open?.group) return;
    if (roster.open.host) await roster.readRoom();
    else await roster.refresh();
  }
  messageLink(task, id) {
    const row = this.visibleMessages?.find(m => m.id === id && m.actions);
    if (this.state.task !== task || !row?.clientId) return '';
    const link = buildTaskDeepLink(task, this.state.device);
    return link + (link.includes('?') ? '&' : '?') + 'message=' + encodeURIComponent(row.clientId);
  }
  currentEditRow(id) {
    return this.visibleMessages?.find(row => row.id === id && row.editPlacement);
  }
  async beginMessageEdit(task, id) {
    const row = this.currentEditRow(id);
    if (!this.ready || this.state.task !== task || !row) throw new Error('只能编辑当前任务最后一条可编辑的用户消息');
    if (this.editing?.id === id) return;
    if (this.sending || this.pending || this.state.queuedInputs) throw new Error('请先处理排队或待确认的消息');
    if (this.recording || this.transfer || this.state.pickingFiles || this.state.failedFile) throw new Error('请先完成录音或处理附件传输');
    const editing = { id, clientId: row.clientId, draft: this.state.draft, attachments: this.state.attachments,
      metadata: row.editSource.metadata, version: this.version, previewSequence: 0 };
    this.editing = editing;
    this.show({ editingMessage: id, editFileCount: 0, draft: row.editSource.text ?? row.messageText ?? row.title, attachments: editAttachments(row), error: '' });
    if (!this.state.running && !this.state.live) this.previewMessageEdit(editing);
  }
  previewMessageEdit(editing) {
    const sequence = ++editing.previewSequence;
    this.invoke('maker:rewind:preview', [this.state.task, editing.clientId], editing.version).then(preview => {
      if (this.editing === editing && editing.previewSequence === sequence && !this.state.editSubmitting &&
          preview?.canRewind && !preview.conversationOnly) {
        this.show({ editFileCount: preview.filesChanged?.length || 0 });
      }
    }).catch(() => {});
  }
  restoreEditStash() {
    const editing = this.editing;
    if (!editing) return;
    this.editing = null;
    this.cancelVoice();
    this.cancelTransfer();
    if (this.uploadBatch) this.discardFailed();
    this.show({ editingMessage: '', editFileCount: 0, draft: editing.draft, attachments: editing.attachments });
  }
  cancelMessageEdit() {
    if (!this.state.editSubmitting) this.restoreEditStash();
  }
  async submitMessageEdit(editing, text) {
    const { task } = this.state, version = editing.version;
    const guard = () => {
      this.guard(version);
      if (this.editing !== editing || !this.currentEditRow(editing.id) || !this.state.linked || this.state.queuedInputs) {
        throw new Error('消息或队列已变更，请检查任务后重试');
      }
    };
    guard();
    if (this.pending || this.state.editSubmitting || (!text.trim() && !this.state.attachments.length)) return;
    const outboxKey = this.key('outbox');
    const candidate = { id: util.generateRandomUUID(true), editTarget: editing.clientId, text, metadata: editing.metadata,
      attachments: this.state.attachments.slice(), retrySafe: this.deliverySupported, awaitingRewind: true };
    const opts = { requireLatestUser: true, ...(this.state.editFileCount > 0 ? {} : { allowFileRestore: false }) };
    let commitAttempted = false;
    this.show({ editSubmitting: true });
    try {
      await this.flushDraft();
      await this.sendSession(task, version);
      await this.reconcile(version);
      guard();
      // Journal the replacement before the Host can remove the old turn. This phase can never enqueue.
      this.pending = candidate;
      await this.cache.write(outboxKey, candidate);
      guard();
      let updated;
      for (let attempt = 0; ; attempt++) {
        guard();
        try {
          commitAttempted = true;
          updated = await this.invoke('maker:rewind:commit', [task, editing.clientId, opts], version);
          break;
        } catch (error) {
          if (error.code !== 'SESSION_RUNNING' || attempt >= 20) throw error;
          guard();
          if (attempt === 0) await this.invoke('maker:input:stop', [task, { keepQueue: true, pauseQueue: true }], version);
          await new Promise(resolve => setTimeout(resolve, 750));
        }
      }
      this.guard(version);
      if (updated?.id !== task) throw new Error('无法确认电脑的回退结果');
      const replacement = { ...candidate, awaitingRewind: false };
      await this.cache.write(outboxKey, replacement);
      this.guard(version);
      this.pending = replacement;
      this.restoreEditStash();
      this.show({ delivery: '正在发送编辑后的消息', pendingLabel: text });
      this.validateSendSession(task, updated);
      await this.enqueuePending(task, version, updated, replacement);
    } catch (error) {
      if (version === this.version && this.pending === candidate) {
        if (!commitAttempted || ['SESSION_RUNNING', 'EDIT_NOT_LAST_MESSAGE', 'REWIND_TARGET_NOT_LATEST', 'NO_PRIOR_ASSISTANT',
          'CHANNEL_NOT_ALLOWED', 'PERMISSION_DENIED', 'FORBIDDEN'].includes(error.code)) {
          await this.cache.write(outboxKey, null);
          this.guard(version);
          this.pending = null;
        } else {
          this.restoreEditStash();
          this.show({ editRecoverable: true, delivery: '上次编辑尚未确认，可取回内容', pendingLabel: text });
        }
      }
      throw error;
    } finally {
      if (version === this.version) {
        if (this.pending?.editTarget && !this.pending.awaitingRewind && this.state.delivery) {
          this.reconcile(version).catch(() => {});
        }
        this.show({ editSubmitting: false });
        this.scheduleHistory();
      }
    }
  }
  async recoverMessageEdit() {
    const pending = this.pending, version = this.version;
    if (!pending?.awaitingRewind || this.state.editSubmitting) return;
    // No enqueue was ever issued in this phase. Bring the text back for explicit user review.
    await this.history(version, false, true);
    this.guard(version);
    const row = this.visibleMessages?.find(item => item.clientId === pending.editTarget && item.editPlacement);
    if (row && !this.state.queuedInputs) {
      this.pending = null;
      try { await this.beginMessageEdit(this.state.task, row.id); }
      catch (err) { this.pending = pending; throw err; }
      this.guard(version);
      if (this.editing?.id !== row.id) {
        this.pending = pending;
        throw new Error('消息或队列已变更，请重新取回内容');
      }
      this.editing.metadata = pending.metadata;
      this.show({ draft: pending.text, attachments: pending.attachments });
    } else {
      // Preserve the normal draft, including identical attachment IDs, across recovery.
      const draft = this.state.draft;
      const text = pending.text;
      if (text && draft !== text && !draft.startsWith(text + '\n\n')) this.editDraft([text, draft].filter(Boolean).join('\n\n'));
      const ids = new Set(this.state.attachments.map(file => file.id));
      await this.setAttachments([...this.state.attachments, ...pending.attachments.filter(file => !ids.has(file.id))]);
      await this.flushDraft();
    }
    this.guard(version);
    await this.cache.write(this.key('outbox'), null);
    this.guard(version);
    this.pending = null;
    this.show({ editRecoverable: false, delivery: '', pendingLabel: '', retryable: false });
  }
  async forkMessage(task, id) {
    const pending = this.forkRequest;
    if (pending?.version === this.version) {
      if (pending.task === task && pending.id === id) return pending.promise;
      throw new Error('正在创建分叉任务');
    }
    const request = { version: this.version, task, id, promise: this.openFork(task, id) };
    this.forkRequest = request;
    try { await request.promise; }
    finally { if (this.forkRequest === request) this.forkRequest = null; }
  }
  async openFork(task, id) {
    const row = this.visibleMessages?.find(m => m.id === id && m.forkable);
    if (task !== this.state.task || !row || !this.state.linked || this.companion) throw new Error('消息当前无法分叉');
    if (this.recording || this.transfer) throw new Error('请先完成录音或附件传输');
    const version = this.version, device = this.state.device;
    await this.flushDraft();
    this.guard(version);
    const fork = await this.invoke('maker:fork', [task, row.clientId], version);
    this.guard(version);
    if (!fork?.id || fork.id === task || (fork.parentSessionId && fork.parentSessionId !== task) ||
      (fork.forkedAtMessageId && fork.forkedAtMessageId !== row.clientId)) throw new Error('电脑返回的分叉任务不匹配');
    this.home?.metadata(device, fork.id, fork);
    this.show({ tasks: [homeTask(fork), ...this.state.tasks.filter(t => t.id !== fork.id)] });
    await this.flushDraft();
    this.guard(version);
    await this.invoke('device-link:unsubscribe', [{ topics: ['session:' + task] }], version);
    this.guard(version);
    const openedVersion = this.version + 1;
    await this.enterTask(fork.id);
    if (this.version === openedVersion && this.state.task === fork.id && this.state.device === device && row.role === 'user' && !this.state.draft) {
      this.editDraft(row.messageText ?? row.title);
      await this.flushDraft();
    }
  }
  closeCloudCompanion() { this.companions?.close(); }
  cloudHistory(older) { return this.companions?.readRoom(older); }
  async enterTask(id, companion) {
    if (this.companions?.open) this.companions.close();
    const version = ++this.version;
    this.resetTask();
    this.companion = companion;
    this.show({ ...taskView, task: id, taskCompanion: companion, error: '' });
    const cached = await this.loadLocalTask(version);
    this.guard(version);
    if (this.state.linked) return this.attachTask(version, true, !!companion);
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
  async validateCompanion(version) {
    const buddy = this.companion;
    if (!buddy) return;
    const id = await resolveCompanion((ch, args) => this.invoke(ch, args, version), buddy.id, this.locale);
    if (this.state.device !== buddy.host || id !== this.state.task) throw Object.assign(new Error('伙伴会话已变更，请从首页重新打开'), { code: 'COMPANION_CHANGED' });
  }
  async attachTask(version, subscribe = true, bindingVerified = false) {
    const id = this.state.task;
    if (!this.hydrated) await this.loadLocalTask(version);
    try {
      if (!bindingVerified) await this.validateCompanion(version);
      const row = await this.invoke('local-db:sessions:get', [id], version);
      if (this.companion && (row?.source !== 'bot' || row.status !== 'active')) throw Object.assign(new Error('伙伴会话已不可用'), { code: 'COMPANION_CHANGED' });
      if (!row || row.id !== id || row.status === 'deleted' || row.hiddenAt) throw Object.assign(new Error('任务已不可访问'), { code: 'NOT_FOUND' });
      this.botSession = row.source === 'bot';
      this.show({ canEditHistory: !!row.workingDir && !row.agentDeviceId && !row.agentSwitchIntent, agent: row.agentKind || '', model: row.model || '', provider: row.providerId || '', permission: row.permissionMode || '' });
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
      if (version === this.version && this.companion && ['COMPANION_CHANGED','NOT_FOUND','FORBIDDEN','PERMISSION_DENIED'].includes(error.code)) {
        await this.back();
        throw error;
      }
      if (version === this.version && ['NOT_FOUND','FORBIDDEN','PERMISSION_DENIED'].includes(error.code)) {
        const keys = ['draft','outbox','history','attachments'].map(name => this.key(name));
        this.cancelDraftTimer();
        this.version++;
        this.resetTask();
        this.home?.metadata(this.state.device, id, { status: 'deleted' });
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
      this.show({ queuedInputs: payload.pendingQueue?.length ?? this.state.queuedInputs, paused: !!payload.queuePaused, error: payload.error || '' });
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
    if (this.state.editSubmitting || text === this.state.draft) return;
    if (this.editing) this.editing.metadata = updateEditRanges(this.editing.metadata, this.state.draft, text);
    this.show({ draft: text });
    if (this.newDraft || this.editing) return;
    this.dirtyDraft = { key: this.key('draft'), text };
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => this.flushDraft().catch(e => this.report(e)), 150);
  }
  async flushDraft() {
    const draft = this.dirtyDraft;
    this.cancelDraftTimer();
    if (draft) {
      await this.cache.write(draft.key, draft.text || null);
      this.markComposerDraft(draft.key);
    }
  }
  markComposerDraft([owner, host, id]) {
    if (!this.home || this.session?.id !== owner || this.state.device !== host || this.state.task !== id) return;
    const peer = this.home.peers.get(host);
    const marked = !!(this.state.draft.trim() || this.state.attachments.length);
    if (peer?.drafts) {
      if (marked) peer.drafts.add(id);
      else peer.drafts.delete(id);
    }
    if (this.state.tasks.some(row => row.id === id && !!row.localDraft !== marked)) {
      this.putHomeRows(host, this.state.tasks.map(row => row.id === id ? { ...row, localDraft: marked } : row));
    }
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
  async leaveNew(confirmDiscard) {
    const wait = this.createWait;
    if (!wait) {
      if (this.creating) return false;
      this.cancelNew();
      return true;
    }
    if (wait.decision) return false;
    wait.decision = new Promise(resolve => { wait.resolve = resolve; });
    try {
      if (!await confirmDiscard() || this.createWait !== wait) return false;
      this.cancelNew();
      return true;
    } catch {
      return false;
    } finally {
      wait.resolve();
      wait.decision = null;
    }
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
    this.home?.metadata(this.state.device, task, { title: row.title });
    const tasks = this.state.tasks.map(item => item.id === task ? { ...item, title: row.title } : item);
    this.show({ tasks });
    await this.cache.write(this.key('tasks', this.state.device, ''), tasks);
  }
  async changeHomeTask(host, id, action, title, confirmArchive) {
    if (!this.session || this.state.task || !this.available(host)) throw new Error('请连接任务所在的电脑');
    if (!['pin', 'unpin', 'archive', 'restore', 'rename'].includes(action)) throw new Error('不支持的任务操作');
    if (!this.home && this.state.device && this.state.device !== host && this.state.linked) this.client.closeLink(this.state.device, 'user');
    const connecting = this.state.device !== host ? this.openDevice(host) : undefined;
    const v = this.version;
    if (connecting) await connecting;
    this.guard(v);
    if (host !== this.state.device || !this.state.linked) throw new Error('请连接任务所在的电脑');
    // A cached row from another computer may have changed since it was displayed.
    const current = await this.invoke('local-db:sessions:get', [id], v);
    this.guard(v);
    if (current?.id !== id || current.status === 'deleted' || current.hiddenAt) throw new Error('任务已不可用');
    if ((action === 'pin' && (current.status === 'archived' || current.pinnedAt)) ||
        (action === 'unpin' && !current.pinnedAt) ||
        (action === 'archive' && current.status === 'archived') ||
        (action === 'restore' && current.status !== 'archived')) {
      await this.applyHomeMetadata(host, current);
      return;
    }
    if (action === 'rename' && !title?.trim()) throw new Error('请填写标题');
    if (action === 'archive') {
      let timeout;
      try {
        const schedules = await Promise.race([
          this.invoke('maker:schedule:list', [null, { sessionBindings: true }], v).catch(() => []),
          new Promise(resolve => { timeout = setTimeout(() => resolve([]), 1500); }),
        ]);
        this.guard(v);
        const names = normalizeScheduleList(schedules).filter(s => s.status === 'active' && s.targetSessionId === id).map(s => s.name);
        if (names.length && !await confirmArchive(names)) return;
      } finally { clearTimeout(timeout); }
    }
    const patch = action === 'rename' ? { title: title.trim() } : mobileSessionBulkPatch(action);
    const updated = await this.invoke('local-db:sessions:patch-meta', [id, patch], v);
    const matches = row => row?.id === id && Object.entries(patch).every(([key, value]) => (row[key] ?? null) === value);
    const confirmed = matches(updated) ? updated : await this.invoke('local-db:sessions:get', [id], v);
    this.guard(v);
    if (!matches(confirmed)) throw new Error('无法确认任务操作');
    await this.applyHomeMetadata(host, { ...current, ...confirmed });
  }
  async applyHomeMetadata(host, row) {
    const metadata = { title: row.title, status: row.status || '', pinnedAt: row.pinnedAt || '' };
    this.home?.metadata(host, row.id, row);
    const tasks = this.state.tasks.map(item => item.id === row.id ? { ...item, ...metadata } : item);
    if (!tasks.some(item => item.id === row.id)) tasks.push(homeTask(row));
    this.show({ tasks, homeIndex: [...(this.state.homeIndex || []).filter(item => item.host !== host),
      ...tasks.map(item => ({ ...item, host }))] });
    await this.cache.write(this.key('tasks', host, ''), tasks);
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
        options = sections.sections.flatMap(({ provider, models }) => {
          const source = providerBrand(provider);
          return models.map((model, index) => ({
            id: JSON.stringify([provider.id, model.id]), title: model.name || model.displayName || model.id,
            summary: provider.name || provider.id, model: model.id, provider: provider.id,
            brand: modelBrand(model.icon, source), sectionBrand: index === 0 ? source : undefined,
            activeSource: provider.id === sections.activeSourceId
          }));
        });
      }
    }
    if (!options) {
      const caps = await this.invoke('maker:get-capabilities', [agent], v);
      const reported = kind === 'model' ? caps?.availableModels : caps?.permissionModes;
      options = (reported || []).filter(o => o?.id).map(o => ({
        id: o.id, title: o.label || o.id, summary: o.description || '', model: o.id,
        brand: kind === 'model' ? modelBrand(o.icon) : undefined
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
    this.creating = this.afterUpload(() => this.createTask(title.trim(), project, firstText, engine, draftOnly), true).finally(() => { this.creating = null; });
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
    const createdRow = { ...row, id: intent.id, title: intent.title || row?.title || '新任务', projectDir: intent.project || row?.projectDir,
      workspaceKind: intent.project ? 'project' : 'dialogue', agentKind: row?.agentKind || intent.engine || this.state.agent };
    this.home?.metadata(this.state.device, intent.id, createdRow);
    const tasks = [homeTask(createdRow), ...this.state.tasks.filter(t => t.id !== intent.id)];
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
    if (pending?.awaitingRewind) {
      if (!this.state.editSubmitting) this.show({ delivery: '上次编辑尚未确认，可取回内容', pendingLabel: pending.text,
        editRecoverable: true, retryable: false });
      return false;
    }
    const ids = pending ? [task, { deliveryClientIds: [pending.id] }] : [task];
    const projection = await this.invoke('maker:input:get-projection', ids, version);
    this.deliverySupported = projection?.inputDeliveryVersion === 1;
    this.show({ queuedInputs: projection?.pendingQueue?.length || 0, paused: !!projection?.queuePaused && !!projection.pendingQueue?.length });
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
    if (pending.editTarget) {
      // Editing stashed the ordinary composer. Even equal text or attachment IDs belong to that draft.
      await this.cache.write(key, null);
      if (this.pending === pending) {
        this.pending = null;
        this.show({ retryable: false, editRecoverable: false, delivery: '', pendingLabel: '' });
      }
      return;
    }
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
    const editing = this.editing;
    this.sending = this.afterUpload(() => editing ? this.submitMessageEdit(editing, this.state.draft) : this.sendOnce(text)).finally(() => { this.sending = null; });
    return this.sending;
  }
  async afterUpload(action, creating = false) {
    const transfer = this.transfer;
    if (!transfer) return this.state.failedFile ? false : action();
    if (!this.state.uploadPending || this.state.failedFile) return false;
    const version = this.version, target = this.newDraft, draft = this.state.draft, revision = transfer.revision;
    const wait = creating && target ? {} : null;
    if (wait) { this.createWait = wait; this.show({ waitingToCreate: true }); }
    try {
      const interrupted = new Promise(resolve => { transfer.interruptWait = resolve; });
      const uploaded = await Promise.race([transfer.finished, interrupted]);
      if (wait?.decision) await wait.decision;
      if (!uploaded || transfer.revision !== revision || version !== this.version || target !== this.newDraft ||
          (target && this.state.draft !== draft) || !this.state.linked || this.transfer || this.state.failedFile) return false;
    } finally {
      transfer.interruptWait = null;
      if (wait && this.createWait === wait) { this.createWait = null; this.show({ waitingToCreate: false }); }
    }
    return action();
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
    const row = await this.sendSession(task, version);
    this.guard(version);
    const pending = this.pending || { id: util.generateRandomUUID(true), text, attachments: this.state.attachments.slice(), retrySafe: this.deliverySupported };
    this.pending = pending;
    await this.flushDraft();
    this.guard(version);
    await this.cache.write(this.key('outbox'), pending);
    return this.enqueuePending(task, version, row, pending);
  }
  async sendSession(task, version) {
    await this.validateCompanion(version);
    const row = await this.invoke('local-db:sessions:get', [task], version);
    this.validateSendSession(task, row);
    return row;
  }
  validateSendSession(task, row) {
    if (this.companion && (row?.source !== 'bot' || row.status !== 'active')) throw Object.assign(new Error('伙伴会话已不可用'), { code: 'COMPANION_CHANGED' });
    if (!row || row.id !== task || !row.workingDir) throw new Error('无法确认任务工作目录');
    if (row.agentDeviceId || row.agentSwitchIntent) throw new Error('此任务涉及远程执行或切换 Agent，暂不支持发送');
  }
  async enqueuePending(task, version, row, pending) {
    const { id: clientId, text, metadata } = pending;
    const { agentReferences, replyQuote, ...textMetadata } = metadata || {};
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
      ...(agentReferences?.length ? { agentReferences } : {}),
      clientId, text, uiLanguage: 'zh-CN', workingDir: row.workingDir,
      model: row.model, effort: createOpts.effort, permissionMode: createOpts.permissionMode,
      persistedContent: JSON.stringify({ text, images, files, ...metadata }),
      chatMessage: { clientId, role: 'user', content: text, ...textMetadata, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), isStreaming: false, createdAt },
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
    await this.devices(false);
    if (this.notification || epoch !== this.authEpoch || version !== this.version) return;
    if (!this.available(target.host)) throw new Error('通知对应的电脑离线或已撤权');
    await this.flushDraft();
    this.guard(version);
    if (this.state.device !== target.host || !this.state.linked) {
      if (!this.home && this.state.device && this.state.device !== target.host && this.state.linked) this.client.closeLink(this.state.device, 'user');
      await this.openDevice(target.host);
    }
    const before = this.version;
    const row = await this.invoke('local-db:sessions:get', [target.task], before);
    if (!row || row.id !== target.task || row.hiddenAt || row.status === 'deleted') throw new Error('通知对应的任务已不可访问');
    if (this.state.task === row.id) { await this.history(before); return; }
    if (this.state.task) await this.back();
    this.home?.metadata(target.host, row.id, row);
    if (!this.state.tasks.some(r => r.id === row.id)) this.show({ tasks: [homeTask(row), ...this.state.tasks] });
    await this.openTask(row.id);
  }
  foreground() {
    if (this.companions && !this.state.task) {
      if (this.companions.open) this.companions.readRoom();
      else this.refreshCompanions().catch(() => {});
    }
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
  async setAttachments(attachments, patch = {}) {
    const key = this.key('attachments');
    this.show({ ...patch, attachments });
    if (!this.newDraft && !this.editing) {
      await this.cache.write(key, attachments.length ? attachments : null);
      this.markComposerDraft(key);
    }
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
  async removeFile(id) {
    if (this.creating && this.newDraft) return;
    this.localMedia.delete(id);
    return this.setAttachments(this.state.attachments.filter(f => f.id !== id));
  }
  cancelTransfer() {
    const transfer = this.transfer;
    if (!transfer) return;
    transfer.cancelled = true;
    this.transfer = null;
    for (const item of transfer.items || []) {
      if (item.active) { item.active.cancelled = true; item.active.abort?.(); }
    }
    transfer.abort?.();
    if (transfer.share) { this.show({ transfer: '' }); return; }
    transfer.settle(false);
    this.uploadBatch = null;
    this.show({ transfer: '', pendingUploads: [], uploadPending: false, pickingFiles: false, failedFile: '' });
  }
  discardFailed() { this.uploadBatch = null; this.show({ pendingUploads: [], failedFile: '' }); }
  uploadStatus(batch) {
    const pendingUploads = batch.items.filter(item => !item.fileId && !item.removed)
      .map(item => ({ id: item.id, title: item.name, previewUri: item.previewUri, failed: !!item.error, uploading: !!item.active }));
    const uploadPending = pendingUploads.some(item => !item.failed) || batch.items.some(item => item.active && !item.removed && !item.error);
    return { pendingUploads, pickingFiles: batch.picking, uploadPending,
      transfer: uploadPending ? '正在上传' : batch.picking ? '正在选择' : '',
      failedFile: pendingUploads.find(item => item.failed)?.title || '' };
  }
  beginUploads(batch) {
    if (this.transfer !== batch) {
      batch.finished = new Promise(resolve => { batch.settle = resolve; });
      this.transfer = batch;
    }
    return batch.finished;
  }
  drainUploads(batch) {
    if (this.uploadBatch !== batch) return;
    const active = batch.items.filter(item => item.active);
    for (const item of batch.items) {
      if (active.length >= 2) break;
      if (item.fileId || item.error || item.removed || item.active) continue;
      // Identically named selections must see their predecessor's hash/receipt before presigning.
      if (active.some(other => other.name === item.name)) continue;
      item.active = { tickets: this.uploadTickets, cancelled: false };
      active.push(item);
      this.uploadItem(batch, item);
    }
    if (!active.length && !batch.picking) {
      this.transfer = null;
      const failed = batch.items.some(item => !item.removed && item.error);
      if (!failed) this.uploadBatch = null;
      batch.settle(!failed && !batch.cancelled);
    }
    this.show(this.uploadStatus(batch));
  }
  async uploadItem(batch, item) {
    try {
      const file = await this.native.uploadFile(this.context, item.uri, () => this.token(), item.active, this.state.attachments);
      // Serialize draft writes, so a failed cache transaction rolls back before the next snapshot.
      const publish = async () => {
        if (this.uploadBatch !== batch || item.removed) return;
        item.fileId = file.id;
        this.localMedia.set(file.id, item.uri);
        if (this.state.attachments.some(f => f.id === file.id)) return;
        const later = new Set(batch.items.slice(batch.items.indexOf(item) + 1).filter(other => other.inserted).map(other => other.fileId));
        const files = this.state.attachments.slice();
        const next = files.findIndex(f => later.has(f.id));
        files.splice(next < 0 ? files.length : next, 0, file);
        try {
          await this.setAttachments(files, this.uploadStatus(batch));
          item.inserted = true;
        } catch (error) {
          if (this.uploadBatch === batch) {
            this.localMedia.delete(file.id);
            item.fileId = null;
            this.show({ ...this.uploadStatus(batch), attachments: this.state.attachments.filter(f => f.id !== file.id) });
          }
          throw error;
        }
      };
      batch.publish = batch.publish.then(publish, publish);
      await batch.publish;
    } catch (error) {
      if (this.uploadBatch === batch && !item.removed) {
        item.error = error;
        batch.revision++;
        batch.interruptWait?.(false);
      }
    } finally {
      item.active = null;
      this.drainUploads(batch);
    }
  }
  removeUpload(id) {
    const batch = this.uploadBatch;
    const item = batch?.items.find(entry => entry.id === id);
    if (!item || item.removed || item.fileId || (this.newDraft && this.creating)) return;
    item.removed = true;
    batch.revision++;
    batch.interruptWait?.(false);
    if (this.transfer !== batch) {
      const failed = batch.items.find(entry => !entry.removed && entry.error);
      if (!failed) this.discardFailed();
      else this.show({ pendingUploads: this.uploadStatus(batch).pendingUploads, failedFile: failed.name });
      return;
    }
    if (!batch.picking && batch.items.every(entry => entry.removed)) {
      this.cancelTransfer();
      return;
    }
    if (item.active) { item.active.cancelled = true; item.active.abort?.(); }
    this.drainUploads(batch);
  }
  async retryFile(id) {
    const batch = this.uploadBatch;
    const item = batch?.items.find(entry => !entry.removed && entry.error && (!id || entry.id === id));
    if (!item || item.active || (this.transfer && this.transfer !== batch) || this.sending || this.creating || !this.state.linked) return false;
    item.error = null;
    const finished = this.beginUploads(batch);
    this.drainUploads(batch);
    await finished;
    if (item.error) throw item.error;
    return !!item.fileId && !batch.cancelled;
  }
  remainingAttachmentSlots(files = this.state.attachments) {
    const reserved = this.uploadBatch?.items.filter(item => !item.fileId && !item.removed).length || 0;
    return 20 - files.length - reserved;
  }
  async addFile(kind) {
    if ((!this.newDraft && (!this.ready || !this.state.task)) || !this.state.linked || this.transfer?.share ||
        this.uploadBatch?.picking || this.sending || this.creating) throw new Error('请先打开任务');
    const batch = this.uploadBatch || { items: [], revision: 0, cancelled: false, publish: Promise.resolve() };
    const remaining = this.remainingAttachmentSlots();
    if (remaining <= 0) throw new Error('每条消息最多可添加 20 个附件');
    this.uploadBatch = batch;
    const finished = this.beginUploads(batch);
    batch.picking = true;
    this.show(this.uploadStatus(batch));
    let added = [];
    try {
      if (this.recording && await this.finishVoice() === undefined) return false;
      if (this.uploadBatch !== batch) return false;
      const selection = await this.native.pickFile(this.context, kind === 'image', remaining);
      if (this.uploadBatch !== batch) return false;
      added = (selection || []).filter(Boolean).slice(0, Math.max(0, Math.min(remaining, this.remainingAttachmentSlots()))).map(uri => {
        const name = displayName(uri, 255) || (kind === 'image' ? '图片' : '文件');
        const previewUri = /\.(png|jpe?g|webp|gif|heic|heif|bmp|avif)$/i.test(name) ? uri : '';
        return { id: util.generateRandomUUID(true), uri, name, previewUri };
      });
      batch.items.push(...added);
    } catch (error) {
      if (this.uploadBatch !== batch || error?.code === 13900042) return false;
      throw error;
    } finally {
      batch.picking = false;
      if (this.uploadBatch === batch) this.drainUploads(batch);
    }
    if (!added.length) return false;
    await finished;
    const failed = added.find(item => item.error && !item.removed);
    if (failed) throw failed.error;
    return !batch.cancelled && added.every(item => !!item.fileId && !item.removed);
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
        if (this.remainingAttachmentSlots(files) < 0) throw new Error('每条消息最多可添加 20 个附件');
        await this.setAttachments(files);
        this.guard(v);
      } finally {
        if (this.transfer === transfer) { this.transfer = null; this.show({ transfer: '' }); }
      }
    }
    if (this.share !== share) return;
    if (share.text) this.editDraft([this.state.draft,share.text].filter(Boolean).join('\n'));
    this.dismissShare();
    await this.flushDraft();
  }
  startVoice(start = this.state.draft.length, end = start) {
    if ((!this.newDraft && (!this.ready || !this.state.task)) || !this.state.linked || this.recording) return;
    const v = this.version, take = ++this.voiceTake;
    const original = this.state.draft;
    const from = Math.max(0, Math.min(start, end, original.length));
    const to = Math.max(from, Math.min(Math.max(start, end), original.length));
    let partial = '';
    // Offsets belong to this draft. Preserve an intervening edit if the host
    // reconciles an older send while the recognizer is still delivering text.
    const insert = text => {
      const current = this.state.draft;
      if (!text) return { voicePreview: current, voiceCaret: current === original ? to : current.length };
      const at = current === original ? from : current.length;
      const after = current === original ? to : current.length;
      return { voicePreview: current.slice(0, at) + text + current.slice(after), voiceCaret: at + text.length };
    };
    this.show({ voice: '准备录音', ...insert('') });
    this.recording = this.native.dictation(this.context, (voice, preview) => {
      if (v !== this.version || take !== this.voiceTake) return;
      if (preview !== undefined) partial = preview.trim();
      this.show({ voice, ...insert(partial) });
    }, (text, error) => {
      if (v !== this.version || take !== this.voiceTake) return;
      this.recording = null;
      const final = text?.trim() || (error ? partial : '');
      const result = insert(final);
      if (final) this.editDraft(result.voicePreview);
      this.show({ voice: '', voicePreview: '', voiceCaret: result.voiceCaret });
      if (error) this.report(new Error(error));
      this.settleVoice(!!final && !error);
    });
  }
  finishVoice() {
    if (!this.recording) return Promise.resolve(false);
    if (this.voiceFinished) return this.voiceFinished;
    const finished = new Promise(resolve => { this.voiceFinishReply = resolve; });
    this.voiceFinished = finished;
    this.recording.finish();
    return finished;
  }
  async finishVoiceForSend() {
    return !this.voiceFinished && (await this.finishVoice()) === true;
  }
  settleVoice(result) {
    this.voiceFinished = null;
    this.voiceFinishReply?.(result);
    this.voiceFinishReply = null;
  }
  cancelVoice() {
    const recording = this.recording;
    if (!recording) return;
    this.voiceTake++;
    this.recording = null;
    this.settleVoice(undefined);
    recording.cancel();
    this.show({ voice: '', voicePreview: '', voiceCaret: undefined });
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
      if (!this.home && linked) this.client.closeLink(device, 'user');
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
    this.companions = null;
    this.version++;
    const client = this.client;
    this.home?.clear(false);
    this.directoryReady = false;
    this.client = null;
    this.session = null;
    this.access = null;
    this.cancelDraftTimer();
    this.resetTask();
    client?.stop();
    this.show({ ...hostView, companions: [], companionError: false, cloudCompanion: undefined, cloudProfile: undefined, cloudMessages: [], cloudOlder: false, cloudLoading: false, cloudError: false, shareLabel: '', shareText: '', shareFiles: [], pushEnabled: false, pushStatus: '', accounts: [], account: '', accountEmail: '', accountAvatar: '', relay: '', devices: [], error: '' });
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
