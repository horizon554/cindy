// Read-only group directory and history. Server rooms belong to the signed-in
// account. A compatibility row belongs to the authenticated computer that listed it.
import { REMOTE_RESOURCE_PROTOCOL_VERSION, BOT_GROUP_CLIENT_PRIMITIVES, botGroupResourceRef, resolveRemoteText,
  hasBotGroupCollection, botGroupMemberLinks, botGroupChatDataFromResource, botGroupMessageSummaryText, readBotGroupTaskCard,
  createConversationListState, latestBotGroupMessage, botGroupActivityAt, chatGroupMemberName } from './protocol.generated';

import { portraitFields } from './companionAvatar';

export const singleLinePreview = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, 160) : '';
export const chatId = value => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
export const chatCursor = value => typeof value === 'string' && /^\d{1,30}$/.test(value);
export const lostRoom = error => [401, 403, 404, 410].includes(error.httpStatus) ||
  ['NOT_FOUND', 'PERMISSION_DENIED', 'FORBIDDEN', 'ACCESS_REVOKED', 'REMOTE_DISABLED', 'SERVER_OWNED_GROUP'].includes(error.code);
const client = locale => ({ protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: BOT_GROUP_CLIENT_PRIMITIVES, locale });
const groupKey = (host, id) => JSON.stringify(['group', host, id]);

export async function hostGroups(call, peer, locale) {
  if (peer.hasGroups === undefined) {
    const manifest = await call('maker:remote-resources:manifest', [{ client: client(locale) }]);
    peer.hasGroups = hasBotGroupCollection(manifest);
  }
  if (!peer.hasGroups) return [];
  const result = await call('maker:remote-resources:list', [{ collectionId: 'bot-groups', limit: 200, client: client(locale) }]);
  if ((result?.collectionId && result.collectionId !== 'bot-groups') || !Array.isArray(result?.items)) throw new Error('群聊名单无效');
  return result.items.flatMap(({ ref, display, links }) => {
    if (!ref?.id || ref.collectionId !== 'bot-groups' || ref.kind !== 'bot-group' || !display?.title) return [];
    return [{ key: groupKey(peer.id, ref.id), host: peer.id, id: ref.id, group: true, avatar: '',
      title: resolveRemoteText(display.title, locale), searchText: display.subtitle ? resolveRemoteText(display.subtitle, locale) : '',
      preview: display.preview ? singleLinePreview(resolveRemoteText(display.preview, locale)) : '',
      memberLinks: botGroupMemberLinks({ links: links || [] }, locale).slice(0, 5),
      localGroup: Number.isFinite(display.lastReadAt), updated: Number(display.timestamp) || 0 }];
  });
}

export async function hostGroupHistory(call, id, locale) {
  const ref = botGroupResourceRef(id);
  const resource = await call('maker:remote-resources:get', [{ ref, client: client(locale) }]);
  const group = resource?.ref?.collectionId === ref.collectionId && resource.ref.kind === ref.kind &&
    resource.ref.id === id && botGroupChatDataFromResource(resource);
  if (group?.serverBacked) throw Object.assign(new Error('群聊由 Chat 服务管理'), { code: 'SERVER_OWNED_GROUP' });
  if (!group || group.id !== id || group.archived) throw Object.assign(new Error('群聊已不可访问'), { code: 'NOT_FOUND' });
  return group.messages.flatMap(message => {
    if (message.deleted || message.threadRootId) return [];
    const files = message.attachments?.length ? message.attachments.map(file => file.name) : message.files || [];
    const title = [botGroupMessageSummaryText(message), ...files].filter(Boolean).join('\n');
    const mine = message.isSelf ?? (message.authorKind === 'user' && !group.serverBacked);
    return title ? [{ id: message.id, title, author: message.authorName, role: mine ? 'user' : 'assistant' }] : [];
  });
}

export function cloudMessageBody(message) {
  return (Array.isArray(message.content) ? message.content : []).flatMap(block => {
    if (!block) return [];
    const value = block.type === 'media' ? block.caption || '📎' : block.text || block.fallback ||
      (message.author?.kind === 'bot' && readBotGroupTaskCard(block)?.title);
    return typeof value === 'string' && value.trim() ? [value] : [];
  }).join('\n').trim();
}

export class ServerGroups {
  constructor() {
    this.rows = new Map();
    this.known = new Set();
    this.directRooms = new Map();
    this.personal = createConversationListState();
    this.ready = false;
  }
  // Keep IDs after leaving or hiding a group. A connected computer can still
  // be advertising an old copy. No transcripts are retained by the directory.
  async read(api, me) {
    if (!chatId(me?.actor?.id) || me.actor.kind !== 'human') throw new Error('群聊身份不可用');
    this.self = me.actor.id;
    if (me.capabilities?.conversationListStateVersion === 1) await this.personal.sync(path => api(path));
    for (const id of this.personal.ids()) this.known.add(id);
    const rooms = new Map(), directRooms = new Map(), cursors = new Set();
    let after = '';
    do {
      const page = await api('/conversations?limit=100' + (after ? '&after=' + after : ''));
      if (!Array.isArray(page)) throw new Error('群聊名单无效');
      for (const room of page) {
        if (!chatId(room?.id)) continue;
        if (room.kind === 'direct' && room.state === 'joined' && !room.archived && !this.personal.hidden(room.id)) directRooms.set(room.id, room.head);
        if (room.kind !== 'group') continue;
        this.known.add(room.id);
        if (room.state === 'joined' && !room.archived && !this.personal.hidden(room.id) && typeof room.name === 'string') rooms.set(room.id, room);
      }
      after = page.length === 100 ? page[99]?.id : '';
      if (page.length === 100 && (!chatId(after) || cursors.has(after))) throw new Error('群聊名单分页无效');
      cursors.add(after);
    } while (after);
    this.directRooms = directRooms;
    const next = new Map(), pending = rooms.values();
    let partial = false;
    const worker = async () => {
      for (const room of pending) {
        const previous = this.rows.get(room.id);
        const row = { key: groupKey('', room.id), host: '', id: room.id, group: true, avatar: '',
          updated: botGroupActivityAt({ createdAt: Date.parse(room.created_at) }), ...previous, title: room.name };
        if (room.head === undefined || room.head !== previous?.head || room.revision !== previous?.revision) {
          try {
            const snapshot = await api('/conversations/' + room.id + '/snapshot');
            if (snapshot?.room?.id !== room.id || snapshot.room.kind !== 'group' || !Array.isArray(snapshot.members) ||
              !Array.isArray(snapshot.messages)) throw new Error('群聊摘要无效');
            if (snapshot.room.archived || (snapshot.room.state && snapshot.room.state !== 'joined')) continue;
            const members = snapshot.members.filter(m => m?.state === 'joined' && typeof m.name === 'string');
            const last = latestBotGroupMessage(snapshot.messages.filter(m => chatCursor(m?.seq)));
            row.memberNames = new Map(members.filter(m => chatId(m.id)).map(m => [m.id, chatGroupMemberName(m, members)]));
            row.searchText = [...row.memberNames.values()].join('\n');
            row.faces = members.filter(m => chatId(m.id)).slice(0, 5).map(m => ({
              key: JSON.stringify([row.key, m.id]), id: m.id, host: '', title: m.name,
              ...portraitFields(m.name, m.groupAvatar ?? m.avatar ?? m.defaultAvatarUrl),
            }));
            row.preview = last ? singleLinePreview(cloudMessageBody(last)) : '';
            row.updated = botGroupActivityAt({ createdAt: Date.parse(room.created_at), lastMessage: last ? { createdAt: Date.parse(last.createdAt) } : null });
            row.head = room.head;
            row.revision = room.revision;
          } catch (error) {
            if (lostRoom(error)) continue;
            partial = true;
          }
        }
        next.set(room.id, row);
      }
    };
    await Promise.all([worker(), worker()]);
    this.rows = next;
    this.ready = true;
    this.error = partial;
  }
}
