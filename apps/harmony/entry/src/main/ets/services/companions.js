// Host rows open the canonical bot session. Cloud-only rows expose the account's
// read-only direct room, even when its home computer has never connected here.
import cryptoFramework from '@ohos.security.cryptoFramework';
import util from '@ohos.util';
import { CompanionAvatars, portraitFields, publicAvatar } from './companionAvatar';
import { isManagedBotAvatarUrl, chatApiBaseUrl, REMOTE_RESOURCE_PROTOCOL_VERSION, resolveRemoteText } from './protocol.generated';
import { request } from './platform';

import { ServerGroups, chatId, chatCursor, cloudMessageBody, singleLinePreview, lostRoom } from './groupChats';
const rowKey = (host, bot) => JSON.stringify([host, bot]);
const collection = 'teammates';
const descriptor = locale => ({ protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: ['session-link', 'status'], locale });
// Chat Server's companion-direct namespace is stable across devices. A derived ID is
// only a join key for rooms actually returned by the account's authorized directory.
function directRoomKey(self, actor) {
  const hash = cryptoFramework.createMd('SHA256');
  hash.updateSync({ data: new util.TextEncoder().encodeInto('companion-direct:' + self + ':' + actor) });
  const hex = Array.from(hash.digestSync().data, b => b.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), '4' + hex.slice(13, 16), 'a' + hex.slice(17, 20), hex.slice(20, 32)].join('-');
}
const text = (value, locale) => typeof value === 'string' || typeof value?.fallback === 'string' ? resolveRemoteText(value, locale) : '';

export async function hostCompanions(call, host, locale) {
  const result = await call('maker:remote-resources:list', [{ collectionId: collection, limit: 200, client: descriptor(locale) }]);
  if (!Array.isArray(result?.items)) throw new Error('伙伴名单暂不可用');
  return result.items.flatMap(({ ref, display, links, revision }) => {
    if (ref?.collectionId !== collection || ref.kind !== 'bot' || !ref.id || !display) return [];
    const title = text(display.title, locale);
    const avatar = display.avatar;
    const target = links?.find(link => link.rel === 'conversation')?.target;
    return [{ key: rowKey(host, ref.id), host, id: ref.id, title, revision, sessionId: target?.kind === 'session' ? target.sessionId : undefined,
      avatar: avatar?.kind === 'emoji' ? avatar.value : avatar?.fallbackText || Array.from(title)[0] || 'C',
      usesGlyph: avatar?.kind === 'emoji', avatarImage: avatar?.kind === 'media' && isManagedBotAvatarUrl(avatar.value) ? avatar.value : undefined,
      preset: portraitFields(title, avatar?.value).preset, preview: singleLinePreview(text(display.preview, locale)), subtitle: singleLinePreview(text(display.subtitle, locale)), updated: Number(display.timestamp) || 0 }];
  });
}

export async function resolveCompanion(call, id, locale) {
  const ref = { collectionId: collection, kind: 'bot', id };
  const resource = await call('maker:remote-resources:get', [{ ref, client: descriptor(locale) }]);
  if (resource?.ref?.id !== id || resource.ref.kind !== 'bot' || resource.ref.collectionId !== collection) throw Object.assign(new Error('伙伴已不可访问'), { code: 'COMPANION_CHANGED' });
  const stage = resource.blocks?.find(block => block.id === 'invitation' && block.primitive === 'status')?.data?.stage;
  if (stage && stage !== 'ready') throw Object.assign(new Error('伙伴尚未就绪'), { code: 'COMPANION_CHANGED' });
  const target = resource.links?.find(link => link.rel === 'conversation')?.target;
  if (target?.kind !== 'session' || !target.sessionId) throw Object.assign(new Error('伙伴会话暂不可用'), { code: 'COMPANION_CHANGED' });
  return target.sessionId;
}

export class Companions {
  constructor(app) { this.app = app; this.actors = []; this.visibleBuddies = new Set(); this.direct = new Map(); this.openedDirectRooms = new Map(); this.groups = new ServerGroups(); this.avatars = new CompanionAvatars(app); }
  rows() {
    const homes = new Map(this.actors.map(a => [a.externalId, a]));
    const rows = new Map();
    for (const { profile, memberNames, ...row } of this.groups.rows.values()) {
      if (!this.groups.personal.hidden(row.id)) rows.set(row.key, row);
    }
    const listedGroups = new Set(this.groups.known);
    for (const peer of this.app.home.peers.values()) {
      const botsById = new Map((peer.bots?.rows || []).map(bot => [bot.id, bot]));
      for (const row of peer.groups?.rows || []) {
        if ((!this.groups.ready && !row.localGroup) || this.groups.personal.hidden(row.id) || listedGroups.has(row.id)) continue;
        listedGroups.add(row.id);
        const faces = row.memberLinks.map(member => {
          const buddy = botsById.get(member.botId);
          const title = member.label || buddy?.title || '';
          return { ...portraitFields(title), ...buddy, id: member.botId, key: JSON.stringify([row.key, member.botId]), host: peer.id, title };
        });
        rows.set(row.key, { ...row, faces });
      }
      for (const row of peer.bots?.rows || []) {
        const actor = homes.get(row.id);
        if (actor && actor.homeDeviceId !== row.host) continue;
        const cloudImage = publicAvatar(actor?.avatar);
        rows.set(row.key, { ...row, recentCall: peer.callReads?.get(row.key)?.revision === row.revision && peer.callReads?.get(row.key)?.result === true,
          ...(cloudImage && !row.preset && !row.usesGlyph ? { cloudImage } : {}) });
      }
    }
    for (const actor of homes.values()) {
      const host = actor.homeDeviceId, id = actor.externalId, key = rowKey(host, id);
      const hosted = rows.get(key);
      const cached = this.direct.get(actor.id);
      const direct = cached && !this.groups.personal.hidden(cached.roomId) ? cached : undefined;
      if (!hosted) rows.set(key, { key, host, id, title: actor.name, actor: actor.id,
        updated: direct?.updated || 0, preview: direct?.preview || '', ...portraitFields(actor.name, actor.avatar) });
    }
    return [...rows.values()].sort((a, b) => b.updated - a.updated || a.key.localeCompare(b.key));
  }
  loadCall(key, visible = true) {
    if (!visible) { this.visibleBuddies.delete(key); return; }
    this.visibleBuddies.add(key);
    for (const peer of this.app.home.peers.values()) {
      const row = peer.bots?.rows.find(item => item.key === key);
      if (row?.sessionId) return this.readCall(peer, row);
    }
  }
  refreshVisibleCalls(peer) {
    const keys = new Set(peer.bots?.rows.map(row => row.key));
    for (const key of peer.callReads?.keys() || []) if (!keys.has(key)) peer.callReads.delete(key);
    for (const row of peer.bots?.rows || []) {
      if (row.sessionId && this.visibleBuddies.has(row.key)) this.readCall(peer, row);
    }
  }
  readCall(peer, row) {
    const cache = peer.callReads ??= new Map();
    const existing = cache.get(row.key);
    if (existing && existing.revision === row.revision && existing.sessionId === row.sessionId) return existing.flight;
    const entry = { revision: row.revision, sessionId: row.sessionId };
    cache.set(row.key, entry);
    const current = () => this.app.companions === this && this.app.home.peers.get(peer.id) === peer &&
      this.visibleBuddies.has(row.key) && cache.get(row.key) === entry &&
      peer.bots?.rows.some(item => item.key === row.key && item.sessionId === row.sessionId && item.revision === row.revision);
    entry.flight = this.app.home.pool.run(async () => {
      if (!current()) return;
      const result = await peer.recentCall(row.sessionId);
      if (current()) {
        entry.result = result;
        if (result) this.publish();
      }
    }).catch(() => {}).finally(() => {
      if (entry.result === undefined && cache.get(row.key) === entry) cache.delete(row.key);
    });
    return entry.flight;
  }
  async api(path, body) {
    const app = this.app;
    const current = () => { if (app.companions !== this || !app.session) throw new Error('登录身份已变更'); };
    current();
    const url = chatApiBaseUrl + '/v1' + path;
    const token = await app.token();
    current();
    try {
      const result = await request(url, body, token);
      current();
      return result;
    } catch (error) {
      current();
      if (error.httpStatus !== 401) throw error;
      if (app.access === token) app.expires = 0;
      const fresh = await app.token();
      current();
      const result = await request(url, body, fresh);
      current();
      return result;
    }
  }
  refresh() {
    if (this.flight) return this.flight;
    this.flight = this.readRoster().finally(() => { this.flight = null; });
    return this.flight;
  }
  async readRoster() {
    const app = this.app;
    try {
      const me = await this.api('/me');
      const [actors, groups] = await Promise.allSettled([
        me?.actor?.kind === 'human' && me.capabilities?.companionHome === true ? this.api('/actors') : [],
        this.groups.read(path => this.api(path), me),
      ]);
      if (app.companions !== this) return;
      if (actors.status === 'fulfilled' && Array.isArray(actors.value)) {
        this.actors = actors.value.filter(a => a?.kind === 'bot' && !a.disabled && chatId(a.id) && typeof a.externalId === 'string' && a.externalId && typeof a.homeDeviceId === 'string' && a.homeDeviceId && typeof a.name === 'string');
      } else if (lostRoom(actors.reason || {})) this.actors = [];
      this.error = actors.status !== 'fulfilled';
      if (groups.status === 'rejected') this.groupFailure(groups.reason);
      else {
        for (const [id, cached] of this.direct) {
          if (!this.groups.directRooms.has(cached.roomId) || this.groups.personal.hidden(cached.roomId)) this.direct.delete(id);
        }
        this.publish();
        if (actors.status === 'fulfilled') await this.readDirectPreviews();
      }
    } catch (error) {
      if (app.companions !== this) return;
      this.groupFailure(error);
      if (lostRoom(error)) this.actors = [];
      this.error = error.httpStatus !== 404;
    }
    if (app.companions === this) this.publish();
  }
  async readDirectPreviews() {
    const next = new Map();
    const pending = this.actors.values();
    const hosted = new Set([...this.app.home.peers.values()].flatMap(peer => (peer.bots?.rows || []).map(row => row.key)));
    const worker = async () => {
      for (const actor of pending) {
        const id = this.openedDirectRooms.get(actor.id) || directRoomKey(this.groups.self, actor.id);
        if (!this.groups.directRooms.has(id) || this.groups.personal.hidden(id) || hosted.has(rowKey(actor.homeDeviceId, actor.externalId))) continue;
        const head = this.groups.directRooms.get(id), previous = this.direct.get(actor.id);
        if (head !== undefined && previous?.roomId === id && previous.head === head) { next.set(actor.id, previous); continue; }
        try {
          let before = '', preview = '', updated = 0;
          do {
            const limit = before ? 50 : 1;
            const page = await this.api('/conversations/' + id + '/messages?limit=' + limit + (before ? '&before=' + before : ''));
            if (!Array.isArray(page)) throw new Error('无效的会话摘要');
            const message = page.find(m => m && !m.deleted && !m.threadRootId && m.origin !== 'system' && cloudMessageBody(m));
            if (message) { preview = singleLinePreview(cloudMessageBody(message)); updated = Date.parse(message.createdAt) || 0; break; }
            const last = page.length === limit ? page[limit - 1]?.seq : '';
            if (!chatCursor(last) || (before && BigInt(last) >= BigInt(before))) break;
            before = last;
          } while (before);
          next.set(actor.id, { roomId: id, head, preview, updated });
        } catch (error) {
          if (previous && !lostRoom(error)) next.set(actor.id, previous);
        }
      }
    };
    await Promise.all([worker(), worker()]);
    this.direct = next;
  }
  groupFailure(error) {
    if (lostRoom(error)) { this.groups.rows.clear(); this.direct.clear(); }
    // Older deployments may have no Chat service. Online computer collections
    // still authorize their own rows independently.
    this.groups.ready = error.httpStatus === 404 || (!lostRoom(error) && this.groups.ready);
    this.groups.error = error.httpStatus !== 404;
  }
  groupProfile(room) {
    if (!room?.group) return undefined;
    if (!room.host) return this.groups.rows.get(room.id)?.profile;
    const detail = room.hostProfile;
    if (!detail) return undefined;
    const bots = new Map((this.app.home.peers.get(room.host)?.bots?.rows || []).map(bot => [bot.id, bot]));
    const members = detail.members.map(member => {
      const buddy = bots.get(member.botId);
      const title = member.name;
      const portrait = member.avatarUrl || member.avatar;
      return { ...portraitFields(title), ...(buddy || {}), ...(portrait ? portraitFields(title, portrait) : {}),
        id: member.botId, key: JSON.stringify([room.key, member.botId]), host: room.host, title, role: member.role };
    });
    return { ...detail, members };
  }
  publish() {
    const rows = this.rows();
    if (this.open && !rows.some(row => row.key === this.open.key)) this.close();
    this.app.show({ companions: rows, cloudProfile: this.groupProfile(this.open), companionError: !!(this.error || this.groups.error) ||
      [...this.app.home.peers.values()].some(peer => peer.bots?.error || peer.groups?.error) });
  }
  close() {
    this.open = null;
    this.app.show({ cloudCompanion: undefined, cloudProfile: undefined, cloudMessages: [], cloudOlder: false, cloudLoading: false, cloudError: false });
  }
  async openRoom(row) {
    const room = { key: row.key, group: !!row.group, host: row.host, id: row.group ? row.id : '', actor: row.actor, messages: new Map() };
    this.open = room;
    this.app.show({ cloudCompanion: row, cloudProfile: this.groupProfile(room), cloudMessages: [], cloudOlder: false, cloudLoading: true, cloudError: false });
    await this.readRoom();
  }
  async readRoom(older = false) {
    const room = this.open;
    if (!room || room.loading || (older && !room.before)) return;
    const current = () => this.app.companions === this && this.open === room;
    room.loading = true;
    this.app.show({ cloudLoading: true, cloudError: false });
    try {
      if (room.group && room.host) {
        const peer = this.app.home.peers.get(room.host);
        if (!peer?.groupHistory) throw Object.assign(new Error('群聊已不可访问'), { code: 'NOT_FOUND' });
        const { messages, profile } = await peer.groupHistory(room.id);
        if (current()) {
          room.hostProfile = profile;
          this.app.show({ cloudMessages: messages, cloudProfile: this.groupProfile(room), cloudOlder: false });
        }
        return;
      }
      if (!room.id) {
        const operationId = 'companion-room:' + room.actor;
        const name = this.app.state.cloudCompanion.title.trim().slice(0, 160) || '伙伴';
        const body = { kind: 'direct', name, participants: [room.actor], sourceId: room.actor };
        let result;
        try { result = await this.api('/conversations', { ...body, operationId }); }
        catch (error) {
          if (!current() || error.httpStatus !== 409 || error.code !== 'OPERATION_CONFLICT') throw error;
          const hash = cryptoFramework.createMd('SHA256');
          hash.updateSync({ data: new util.TextEncoder().encodeInto(name) });
          const suffix = Array.from(hash.digestSync().data).slice(0, 6).map(n => n.toString(16).padStart(2, '0')).join('');
          result = await this.api('/conversations', { ...body, operationId: operationId + ':' + suffix });
        }
        if (!current()) return;
        if (!chatId(result?.id)) throw new Error('伙伴会话无效');
        room.id = result.id;
        this.openedDirectRooms.set(room.actor, result.id);
      }
      const page = await this.api('/conversations/' + room.id + '/messages?limit=100' + (older ? '&before=' + room.before : ''));
      if (!current()) return;
      if (!Array.isArray(page)) throw new Error('伙伴记录暂不可用');
      const before = page.length === 100 ? page[99]?.seq : null;
      if (before !== null && (!chatCursor(before) || (older && BigInt(before) >= BigInt(room.before)))) throw new Error('无效的历史页');
      if (!older) room.messages.clear();
      for (const message of page) {
        if (!message?.id || !chatCursor(message.seq) || message.deleted || message.threadRootId || (!room.group && message.origin === 'system')) continue;
        const title = cloudMessageBody(message);
        const mine = room.group ? message.authorId === this.groups.self : message.authorId !== room.actor;
        const author = room.group ? this.groups.rows.get(room.id)?.memberNames?.get(message.authorId) || message.author?.name || '' : '';
        if (title) room.messages.set(message.id, { id: message.id, title, author, role: mine ? 'user' : 'assistant', seq: message.seq });
      }
      room.before = before;
      const messages = [...room.messages.values()].sort((a, b) => BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0);
      this.app.show({ cloudMessages: messages, cloudOlder: !!before });
    } catch (error) {
      if (current()) {
        if (room.group && lostRoom(error)) {
          if (room.host) {
            if (error.code === 'SERVER_OWNED_GROUP') this.groups.known.add(room.id);
            const list = this.app.home.peers.get(room.host)?.groups;
            if (list) list.rows = list.rows.filter(row => row.id !== room.id);
          } else this.groups.rows.delete(room.id);
          this.publish();
          return;
        }
        if (lostRoom(error)) {
          if (room.actor) { this.direct.delete(room.actor); this.publish(); }
          room.messages.clear(); room.before = null; this.app.show({ cloudMessages: [], cloudOlder: false }); }
        this.app.show({ cloudError: true });
      }
    } finally {
      room.loading = false;
      if (current()) this.app.show({ cloudLoading: false });
    }
  }
}
