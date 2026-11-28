import { readAgentInputReferences, readChatReplyQuote, readSentPastedTextRanges, readSentSlashCommandRanges } from './protocol.generated';

// Draft sources keep the original wire text. A history display label is never input to a rewind.
export function editSource(content, media) {
  if (typeof content === 'string') return { text: content };
  if (Array.isArray(content)) {
    if (content.every(part => part?.type === 'text' && typeof part.text === 'string')) {
      return { text: content.map(part => part.text).join('\n') };
    }
    return;
  }
  if (!content || (typeof content.text !== 'string' && !media.length)) return;
  // The plain Harmony composer cannot recreate the trusted context for these rich references.
  if (content.sessionReferences?.length) return;
  const images = content.images ?? [], files = content.files ?? [];
  if (!Array.isArray(images) || !Array.isArray(files) || images.length + files.length !== media.length || media.some(file => !file.path)) return;
  const metadata = {};
  if (content.agentReferences?.length) {
    const references = readAgentInputReferences(content.agentReferences, content.text || '');
    if (references.length !== content.agentReferences.length) return;
    metadata.agentReferences = references;
  }
  if (content.replyQuote) {
    const quote = readChatReplyQuote(content.replyQuote);
    if (!quote) return;
    metadata.replyQuote = quote;
  }
  if (content.quotesEncoded) metadata.quotesEncoded = true;
  const pasted = readSentPastedTextRanges(content.pastedTextRanges, content.text || '');
  const slash = readSentSlashCommandRanges(content.slashCommandRanges, content.text || '');
  if (pasted) metadata.pastedTextRanges = pasted;
  if (slash) metadata.slashCommandRanges = slash;
  return { text: content.text || '', metadata };
}

// TextArea reports the full new string. Move ranges outside the edit and drop a range only if touched.
export function updateEditRanges(metadata, before, after) {
  if (before === after || (!metadata?.pastedTextRanges?.length && !metadata?.slashCommandRanges?.length && !metadata?.agentReferences?.length)) return metadata;
  let start = 0, end = before.length, nextEnd = after.length;
  while (start < end && start < nextEnd && before[start] === after[start]) start++;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  const result = { ...metadata };
  for (const name of ['pastedTextRanges', 'slashCommandRanges', 'agentReferences']) {
    if (metadata[name]) result[name] = metadata[name].flatMap(range => range.end <= start ? [range] :
      range.start >= end ? [{ ...range, start: range.start + nextEnd - end, end: range.end + nextEnd - end }] : []);
  }
  return result;
}

export function editAttachments(row) {
  return (row.media || []).map((file, index) => {
    const id = 'message-edit:' + row.clientId + ':' + index;
    const ext = file.name.match(/\.[a-z\d]+$/i)?.[0]?.toLowerCase() || '';
    const category = file.image ? 'image' : ext === '.pdf' ? 'pdf' : file.mimeType?.startsWith('text/') ? 'text' : 'file';
    const inline = file.image && /^data:([^;,]+);base64,(.+)$/s.exec(file.path);
    return { ...file, id, ext, category, originalName: file.name,
      ...(inline ? { path: 'clipboard://' + id, base64: inline[2], mimeType: inline[1] } : file.image ? { url: file.path } : {}) };
  });
}
