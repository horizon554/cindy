import util from '@ohos.util';
import { botGroupQuoteFromMessage, buildBotGroupQuoteCard, chatGroupMemberName, isMobilePlatform } from './protocol.generated';
import { chatId } from './groupChats';
import { serverMessage } from './companionTimeline';

export class RoomActions {
  constructor(roster) { this.roster = roster; this.app = roster.app; this.sends = new Map(); this.images = Promise.resolve(); }
  current(room) {
    if (!room || this.app.companions !== this.roster || this.roster.open !== room) throw new Error('会话已切换');
  }
  writable(room) {
    this.current(room);
    const profile = this.roster.groupProfile(room);
    if (!room.group || !profile?.writable || (room.host && !this.app.available(room.host))) throw new Error('群聊当前不可发送消息');
    return profile;
  }
  async pick(room, images) {
    const profile = this.writable(room);
    if (!profile.attachments) throw new Error('当前群聊不支持附件');
    const uris = await this.app.native.pickFile(this.app.context, images, 1);
    this.current(room);
    if (!uris?.length) return;
    const transfer = { tickets: new Map(), cancelled: false };
    room.transfer = transfer;
    try {
      if (room.host) return await this.app.native.uploadFile(this.app.context, uris[0], () => this.app.token(), transfer, []);
      const api = (path, body) => { this.writable(room); return this.roster.api('/conversations/' + room.id + path, body); };
      return await this.app.native.uploadFile(this.app.context, uris[0], null, transfer, [], api);
    } finally { room.transfer = null; }
  }
  async media(room, messageId, fileId) {
    this.current(room);
    const message = room.thread === messageId ? room.parent?.messages.get(messageId) : room.messages.get(messageId);
    const file = message?.media?.find(f => (f.id || f.path) === fileId);
    if (!file) throw new Error('附件不可用');
    if (room.group && room.host) {
      const path = file.path;
      if (!path) throw new Error('附件仅在所属电脑上可用');
      const url = await this.app.attachmentUrl(path, () => this.current(room));
      this.current(room); return { ...file, url };
    }
    if (!chatId(file.id)) throw new Error('附件不可用');
    const media = await this.roster.api('/conversations/' + room.id + '/media/' + file.id);
    this.current(room);
    if (typeof media.url !== 'string' || !/^https:\/\/[^\s@/]+\//i.test(media.url)) throw new Error('附件地址无效');
    if (!Number.isSafeInteger(Number(media.size)) || Number(media.size) < 0 || typeof media.type !== 'string') throw new Error('附件信息无效');
    return { ...file, name: media.name || file.name, mimeType: media.type, url: media.url, size: Number(media.size) };
  }
  thumbnail(room, message, id, visible) {
    const read = async () => {
      if (!visible() || this.roster.open !== room) return '';
      const file = await this.media(room, message, id);
      return visible() && file.mimeType?.startsWith('image/') ? file.url : '';
    };
    const result = this.images.then(read).catch(() => '');
    this.images = result;
    return result;
  }
  async send(room, text, mentionIds, files, quoteId) {
    this.writable(room);
    if (!text.trim() && !files.length) return;
    const signature = JSON.stringify([text, [...new Set(mentionIds)], files.map(f => f.id), quoteId]);
    const key = [this.app.session.id, room.host, room.id, 'group-send:' + (room.thread || '')];
    const scope = JSON.stringify(key);
    const flight = this.sends.get(scope);
    if (flight) {
      if (flight.signature !== signature) throw new Error('上一条消息仍在发送');
      return flight.promise;
    }
    const promise = this.sendOnce(room, key, signature, text, mentionIds, files, quoteId);
    this.sends.set(scope, { signature, promise });
    try { await promise; } finally { this.sends.delete(scope); }
  }
  async sendOnce(room, key, signature, text, mentionIds, files, quoteId) {
    let pending = await this.app.cache.read(key);
    const profile = this.writable(room);
    if (pending && pending.signature !== signature) throw new Error('请先重试上一条发送结果未确认的消息');
    if (!pending) {
      const operationId = util.generateRandomUUID(true);
      const content = text ? [{ type: 'text', text }] : [];
      const mentions = [...new Set(mentionIds)].filter(id => profile.members.some(m => m.id === id));
      if (files.length && (!profile.attachments || (!room.host && files.some(f => !chatId(f.id))))) throw new Error('当前群聊不支持此附件');
      if (quoteId) {
        if (!room.messages.get(quoteId)?.interactive || room.host || room.thread || !chatId(quoteId)) throw new Error('原消息不可引用');
        const path = '/conversations/' + room.id;
        const [original, members] = await Promise.all([this.roster.api(path + '/messages/' + quoteId), this.roster.api(path + '/members')]);
        this.writable(room);
        if (original?.id !== quoteId || original.deleted || original.threadRootId || !Array.isArray(members)) throw new Error('原消息不可引用');
        const quote = serverMessage(original, room, this.roster.groups.self);
        if (!quote?.interactive) throw new Error('原消息不可引用');
        const member = members.find(m => m.id === quote.authorId);
        const view = botGroupQuoteFromMessage({ id: quote.id, sequence: Number(quote.seq), authorKind: quote.bot ? 'bot' : 'user',
          authorName: member ? chatGroupMemberName(member, members) : quote.author, content: quote.title, task: quote.taskCard, attachments: quote.media });
        content.unshift(buildBotGroupQuoteCard(view));
        if (member?.kind === 'bot' && member.state === 'joined' && !mentions.includes(member.id)) mentions.push(member.id);
      }
      content.push(...files.map(file => ({ type: 'media', mediaId: file.id, caption: file.name })));
      const body = room.host ? { text, clientId: operationId, mentions: { all: false, botIds: mentions }, attachments: files } :
        { operationId, content, mentions, ...(room.thread ? { threadRootId: room.thread } : {}),
          ...(this.roster.independentReplies ? { independentReplies: true } : {}) };
      pending = { signature, body, text, mentionIds, files, quoteId };
      await this.app.cache.write(key, pending);
    }
    this.writable(room);
    try {
      if (room.host) await this.app.home.peers.get(room.host).groupSend(room.id, pending.body);
      else await this.roster.api('/conversations/' + room.id + '/messages', pending.body);
    } catch (error) {
      if (this.app.companions !== this.roster) throw error;
      const definitive = [400, 403, 404, 409, 413, 422].includes(error.httpStatus);
      if (definitive) await this.app.cache.write(key, null);
      if (this.sameScope(room)) this.app.show({ cloudPending: definitive ? undefined : pending });
      throw error;
    }
    if (this.app.companions !== this.roster) return;
    await this.app.cache.write(key, null);
    if (this.sameScope(room)) {
      this.roster.open.draft = undefined;
      this.app.show({ cloudPending: undefined });
      await this.roster.readRoom();
    }
  }
  sameScope(room) {
    const open = this.roster.open;
    return this.app.companions === this.roster && open?.key === room.key && open.thread === room.thread;
  }
  async targets(room) {
    this.current(room);
    const fresh = await this.app.devices(false);
    if (fresh === false) throw new Error('设备列表已更新，请重试');
    this.current(room);
    return this.app.state.devices.filter(d => !d.offline && !isMobilePlatform(d.platform) && d.platform !== 'harmonyos' && d.id !== room.host && d.id !== this.app.id);
  }
  async takeOver(room, target, waitOnly = false) {
    this.current(room);
    if (room.group || !chatId(room.actor)) throw new Error('伙伴不可切换电脑');
    const devices = await this.targets(room);
    if (!devices.some(d => d.id === target)) throw new Error('目标电脑已不可用');
    if (waitOnly && room.moving !== target) throw new Error('请重新选择电脑');
    room.moving = target;
    if (!waitOnly) {
      try {
        const updated = await this.roster.api('/actors/' + room.actor, { homeDeviceId: target, expectedHomeDeviceId: room.host }, 'PATCH');
        if (updated?.homeDeviceId && updated.homeDeviceId !== target) throw Object.assign(new Error('主力电脑已更改'), { code: 'HOME_DEVICE_CONFLICT' });
      } catch (error) {
        if (error.code !== 'HOME_DEVICE_CONFLICT' || error.homeDeviceId !== target) {
          room.moving = undefined;
          if (error.code === 'HOME_DEVICE_CONFLICT') {
            await this.roster.refresh();
            const conflict = new Error('主力电脑已更改，请重新查看伙伴');
            if (!this.roster.open && this.app.companions === this.roster) this.app.report(conflict);
            throw conflict;
          }
          throw error;
        }
      }
    }
    this.current(room);
    clearTimeout(room.timer);
    const deadline = Date.now() + 90000;
    const current = () => this.roster.open === room && this.app.companions === this.roster && room.moving === target;
    const tick = async () => {
      if (!current()) return;
      try {
        if (!this.app.home.peers.get(target)?.bots) await this.app.home.load(target);
        const list = this.app.home.peers.get(target)?.bots;
        if (list?.flight) await list.flight;
        if (!current()) return;
        await list?.refresh();
        if (!current()) return;
        if (!list?.error && list?.rows.some(r => r.id === room.botId)) {
          await this.roster.refresh();
          if (!current()) return;
          const row = this.roster.rows().find(r => r.host === target && r.id === room.botId && !r.actor && !r.group);
          if (row) { await this.app.openCompanion(row.key); if (current()) this.roster.close(); return; }
        }
      } catch (e) { if (!current()) return; }
      if (!current()) return;
      if (Date.now() >= deadline) { this.app.show({ homeMove: 'timeout' }); return; }
      room.timer = setTimeout(tick, 5000);
    };
    this.app.show({ homeMove: 'waiting', homeTarget: target }); void tick();
  }
}
