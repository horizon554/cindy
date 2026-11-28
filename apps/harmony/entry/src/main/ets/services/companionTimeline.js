import { collectBotMessageTimeGroups, formatBotMessageGroupTime, readBotGroupTaskCard, readBotGroupThreadShareCard, readBotGroupQuoteCard } from './protocol.generated';
import { messageTimestamp } from './taskModel';

function stripPrivateImages(text) {
  return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((part, i) => i % 2 ? part :
    part.replace(/!\[[^\]\n]*\]\((?:cindy-media|xdt-image|xdt-video|file):\/\/[^)\s]*\)/gi, '')).join('').trim();
}

export function serverMessage(message, room, self, names) {
  const blocks = Array.isArray(message.content) ? message.content.filter(Boolean) : [];
  const taskCard = message.author?.kind === 'bot' ? blocks.map(readBotGroupTaskCard).find(Boolean) : null;
  const quote = blocks.map(readBotGroupQuoteCard).find(Boolean);
  const media = blocks.filter(b => b.type === 'media' && b.mediaId).map(b => ({ id: b.mediaId, name: b.caption || '📎' }));
  const role = (room.group ? message.authorId === self : message.authorId !== room.actor) ? 'user' : 'assistant';
  let title = blocks.filter(b => b.type !== 'media' && !readBotGroupQuoteCard(b) && !(taskCard && readBotGroupTaskCard(b)))
    .map(b => b.text || b.fallback || '').filter(Boolean).join('\n');
  if (!room.group && role === 'assistant') title = stripPrivateImages(title);
  if (!title && !media.length && !taskCard && !quote) return null;
  return { id: message.id, seq: message.seq, createdAt: messageTimestamp(message.createdAt), role, title, media, quote, taskCard,
    author: names?.get(message.authorId) || message.author?.name || '', authorId: message.authorId,
    bot: message.author?.kind === 'bot', interactive: message.origin !== 'system' && !readBotGroupThreadShareCard({ ...message, content: blocks }), replyCount: message.replyCount || 0 };
}

export function conversationRows(rows, locale, grouped, direct = false) {
  const eligible = direct ? rows.filter(row => row.role === 'assistant' || row.role === 'user') : rows;
  const stamps = grouped ? collectBotMessageTimeGroups(eligible.map(row => ({ clientId: row.id, createdAt: row.createdAt }))) : new Map();
  let previous;
  return rows.map(row => {
    const stamp = stamps.get(row.id);
    const continued = row.role === 'assistant' && previous?.role === 'assistant' && stamp === undefined &&
      (direct || (row.bot && previous.bot && row.interactive && previous.interactive && row.authorId && row.authorId === previous.authorId));
    previous = row;
    return { ...row, continued: !!continued, stamp: stamp === undefined ? '' : formatBotMessageGroupTime(stamp, locale) };
  });
}

export function compareRoomRows(a, b, byTime) {
  const elapsed = byTime ? Date.parse(a.createdAt) - Date.parse(b.createdAt) : 0;
  if (Number.isFinite(elapsed) && elapsed) return elapsed;
  return BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0;
}
