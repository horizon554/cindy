import { editSource } from './messageEdit';
import { readChatReplyQuote, normalizeAskQuestions, answerKey, askQuestionOptions, askAnswerError, encodeMultiSelectAnswer,
  selectionFromAnswer, buildPermissionReviewPresentation, readVoiceCallRecord, formatCompactTokens, resolveSessionTotalMoney, messageCostParts, isSyntheticTriggerText, isAnsweredAsyncQuestionClientId } from './protocol.generated';

function decode(content) {
  if (typeof content !== 'string') return content;
  try { return JSON.parse(content); } catch { return content; }
}

export function approvalKey(request) {
  if (request.kind !== 'permission') return '';
  const p = buildPermissionReviewPresentation(request);
  return p.riskSummary ? JSON.stringify([request.requestId, request.toolName, request.input, p.title, p.description, p.sourceDescription, p.riskSummary, p.code]) : '';
}

function body(content) {
  if (typeof content === 'string') {
    if (/^\s*[[{]/.test(content)) {
      try { return body(JSON.parse(content)) || content; } catch { /* A literal user message. */ }
    }
    return content;
  }
  if (typeof content?.text === 'string') {
    const names = [...(Array.isArray(content.images) ? content.images.map(a => a?.originalName || '图片') : []),
      ...(Array.isArray(content.files) ? content.files.map(a => a?.name || '文件') : [])];
    return [content.text, ...names].filter(Boolean).join('\n');
  }
  if (Array.isArray(content)) return content.filter(i => i?.type === 'text').map(i => i.text).join('\n');
  return '';
}

function callTranscript(record) {
  const handoffs = new Map(record.handoffs.map(task => [task.inputId, task]));
  const lines = [];
  for (const turn of record.turns) {
    const handoff = handoffs.get(turn.id);
    const status = handoff?.state || (turn.role === 'user' && turn.failed ? 'send-failed' : undefined);
    if (turn.text.trim() || handoff) lines.push({ role: turn.role, text: turn.text, status });
    handoffs.delete(turn.id);
  }
  for (const task of handoffs.values()) lines.push({ role: 'user', text: task.text, status: task.state });
  if (!lines.length) return undefined;
  return { startedAt: record.startedAt, endedAt: record.endedAt, lines };
}

export function messageTimestamp(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function messageMetadata(row, content, text, hasMedia) {
  if (row.role !== 'user' && row.role !== 'assistant') return {};
  const meta = row.agentMeta || {};
  const assistant = row.role === 'assistant';
  const boundary = !assistant && !meta.parentUuid;
  const eligible = !row.systemCardType && !meta.parentUuid && !meta.autoResume && !meta.failedSamplingAttempt && !isAnsweredAsyncQuestionClientId(row.clientId) &&
    !meta.isStreaming && !meta.streaming && !content?.isStreaming && !content?.streaming &&
    (assistant ? !!text.trim() : (!!text.trim() || hasMedia) && !isSyntheticTriggerText(text));
  const fields = { quote: readChatReplyQuote(content?.replyQuote) || undefined, createdAt: messageTimestamp(row.createdAt), boundary, eligible };
  if (!assistant || !eligible) return fields;
  const total = resolveSessionTotalMoney({ totalMoney: meta.userTurnCost, totalCostUsd: meta.userTurnCostUsd });
  const money = total || resolveSessionTotalMoney({ totalMoney: meta.turnCost, totalCostUsd: meta.turnCostUsd });
  let parts;
  if (money) {
    const estimate = total ? meta.userTurnCostIsEstimate : meta.turnCostIsEstimate;
    const projected = estimate ? { ...money, approximate: true, kind: 'value-estimate' } : money;
    const { conversation, additional } = messageCostParts(projected, meta.turnUsageDetails);
    parts = [...conversation, ...additional].map(({ amount, currency, kind }) => {
      const symbol = currency === 'USD' ? '$' : '¥';
      const value = amount >= 1000 ? (amount / 1000).toFixed(1) + 'k' : amount >= 10 ? String(Math.round(amount)) :
        amount >= 0.01 ? amount.toFixed(2) : amount >= 0.001 ? amount.toFixed(3) : '0.001';
      return { value: (amount < 0.001 ? '<' : '') + symbol + value, estimated: kind === 'value-estimate' };
    });
  }
  const tokens = meta.turnUsageDetails?.totalTokens;
  const hasTokens = Number.isFinite(tokens) && tokens > 0;
  return { ...fields, sealed: meta.turnCompleted === true || !!money || hasTokens,
    usage: parts?.length ? parts : hasTokens ? [{ value: formatCompactTokens(tokens) + ' tokens', estimated: false }] : undefined };
}

// Resolve turn boundaries after merging pages so loading older history cannot manufacture a footer.
export function messageActionRows(history, running, forkAllowed, editAllowed = false) {
  const rows = history.filter(row => !row.emptyVoiceCall);
  const finals = new Set();
  let last, latestUser, sealed = false;
  for (const row of rows) {
    if (row.boundary ?? row.role === 'user') {
      if (last && !sealed) finals.add(last);
      last = undefined;
      sealed = false;
    }
    if (row.role === 'user' && row.boundary !== false && row.realUser !== false) latestUser = row;
    if (row.role === 'assistant' && !row.voiceCall && (row.eligible ?? !!row.title)) {
      last = row;
      if (row.sealed) { finals.add(row); sealed = true; }
    }
  }
  if (!running && last && !sealed) finals.add(last);
  let priorUser = false;
  return rows.map(row => {
    const user = row.role === 'user' && row.eligible !== false;
    const actions = user || finals.has(row);
    const forkable = actions && !!row.clientId && forkAllowed && (!user || priorUser);
    if (row.boundary ?? user) priorUser = true;
    const editPlacement = user && row === latestUser && row.clientId && editAllowed && row.editSource ?
      (running ? 'menu' : 'inline') : undefined;
    return actions ? { ...row, actions: true, forkable, editPlacement } : row;
  });
}

export function taskPage(rows, task) {
  const page = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row?.id || row.sessionId !== task || seen.has(row.id)) continue;
    seen.add(row.id);
    const call = row.role === 'assistant' && readVoiceCallRecord(row.agentMeta?.voiceCall);
    if (call) {
      const voiceCall = callTranscript(call);
      // Empty calls still anchor Host pagination and history reconciliation.
      page.push({ id: row.id, clientId: row.clientId || '', role: row.role, title: '', createdAt: messageTimestamp(row.createdAt ?? call.startedAt),
        ...(voiceCall ? { voiceCall } : { emptyVoiceCall: true }) });
      continue;
    }
    let title, detail;
    if (row.role === 'ask_user' || row.role === 'permission' || row.role === 'tool_use' || row.role === 'tool_result') {
      let data = row.content;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* Plain tool output. */ } }
      if (row.role === 'ask_user') title = normalizeAskQuestions(data?.questions).map(q => q.question).join('\n');
      if (row.role === 'permission') title = data?.title || data?.toolName || '操作审批';
      if (row.role === 'tool_use') {
        title = data?.toolName || data?.name || row.toolName || '调用';
        detail = [data?.input?.description, data?.input?.command, data?.input?.file_path, data?.input?.path]
          .filter(v => typeof v === 'string' && v).join('\n').slice(0, 8192);
      }
      if (row.role === 'tool_result') title = body(data) || data?.output || '工具已返回';
    }
    const content = decode(row.content);
    const media = [];
    for (const kind of ['images', 'files']) {
      for (const file of Array.isArray(content?.[kind]) ? content[kind] : []) {
        if (!file || typeof file !== 'object') continue;
        const image = kind === 'images';
        const path = file.url || file.path || (image && file.base64 ? 'data:' + (file.mimeType || 'image/png') + ';base64,' + file.base64 : '');
        media.push({ image, ...(file.sha256 ? { sha256: file.sha256 } : {}), path: typeof path === 'string' ? path : '', name: file.originalName || file.name || (kind === 'images' ? '图片' : '文件'),
          size: Number(file.size) || 0, mimeType: file.mimeType || (kind === 'images' ? 'image/*' : '') });
      }
    }
    const messageText = body(row.content);
    const editContent = typeof row.content === 'string' && (content === null || typeof content !== 'object') ? row.content : content;
    const realUser = row.role === 'user' && !row.agentMeta?.autoResume && !row.systemCardType &&
      !row.agentMeta?.parentUuid && !isAnsweredAsyncQuestionClientId(row.clientId) && !isSyntheticTriggerText(messageText);
    const source = realUser ? editSource(editContent, media) : undefined;
    if (source && source.text === (media.length ? content?.text || '' : messageText)) delete source.text;
    page.push({ ...(row.role === 'user' ? { realUser, editSource: source } : {}), ...messageMetadata(row, content, messageText, media.length > 0), ...(detail ? { detail } : {}), ...(media.length ? { media, messageText: content.text || '' } : {}), id: row.id, clientId: row.clientId || '', role: row.role || '',
      title: (typeof title === 'string' && title) || messageText || row.toolName || '暂不支持显示此消息' });
  }
  return page.reverse();
}

// Host pages are ordered by (createdAt, rowid). Keep that order even when
// timestamps tie. A missing overlap means the next older page must be read anew.
export function mergePage(current, page, older, full) {
  if (older) {
    const ids = new Set(current.map(r => r.id));
    return [...page.filter(r => !ids.has(r.id)), ...current];
  }
  const index = full && page.length ? current.findIndex(r => r.id === page[0].id) : -1;
  return index > 0 ? [...current.slice(0, index), ...page] : page;
}

export function presentCards(entries, edits, revisions) {
  return entries.flatMap(({ request: r }) => {
    if (!r?.requestId) return [];
    const result = { id: r.requestId, revision: revisions.get(r.requestId) || 0, kind: r.kind, title: '', detail: '', questions: [] };
    if (r.kind === 'permission') {
      const p = buildPermissionReviewPresentation(r);
      result.title = p.title || r.toolName || '操作审批';
      result.approvalKey = approvalKey(r);
      result.risk = p.riskSummary || '';
      result.code = p.code || '';
      result.detail = [p.sourceDescription, p.description].filter(Boolean).join('\n');
    } else if (r.kind === 'plan_review') {
      result.title = '审核计划';
      result.detail = r.plan || '';
    } else if (r.kind === 'ask_user_question') {
      result.title = '待回答';
      let complete = true;
      result.questions = normalizeAskQuestions(r.questions).map(q => {
        const key = answerKey(q);
        const answer = edits.get(r.requestId)?.get(key) || '';
        const valid = !askAnswerError(q, answer) && (!!q.answerConstraints || (!!answer.trim() && answer !== '[]'));
        if (!valid) complete = false;
        const { selectedLabels, customInput } = selectionFromAnswer(q, answer);
        const choices = askQuestionOptions(q);
        return { key, valid, label: q.question, multi: !!q.multiSelect, free: !q.answerConstraints?.choices,
          value: q.multiSelect ? customInput : answer,
          options: choices.map(opt => ({ label: opt.label, detail: opt.description || '', selected: selectedLabels.has(opt.label) })) };
      });
      result.complete = complete && result.questions.length > 0;
    } else { result.title = '请在电脑上处理此请求'; }
    return [result];
  });
}

export function questionAnswer(request, edits, key, value, select) {
  const q = normalizeAskQuestions(request.questions).find(q => answerKey(q) === key);
  if (!q) return;
  if (q.multiSelect) {
    const { selectedLabels, customInput } = selectionFromAnswer(q, edits.get(key));
    if (select) {
      if (selectedLabels.has(value)) selectedLabels.delete(value); else selectedLabels.add(value);
    }
    value = encodeMultiSelectAnswer(askQuestionOptions(q), selectedLabels, select ? customInput : value);
  }
  edits.set(key, value);
}

export function decisionFor(request, edits, choice) {
  if (request.kind === 'ask_user_question' && choice === 'answer') {
    const answers = Object.create(null);
    const questions = normalizeAskQuestions(request.questions);
    if (!questions.length) throw new Error('请在电脑上查看问题');
    for (const q of questions) {
      const key = answerKey(q);
      const value = edits?.get(key) || '';
      if (askAnswerError(q, value) || (!q.answerConstraints && (!value.trim() || (q.multiSelect && value === '[]')))) {
        throw new Error('请检查回答：' + q.question);
      }
      answers[key] = value;
    }
    return { kind: request.kind, answers };
  }
  if (['permission', 'plan_review'].includes(request.kind) && ['allow', 'deny'].includes(choice)) {
    return { kind: request.kind, behavior: choice };
  }
  throw new Error('请在电脑上处理此请求');
}

// Preserve fenced text verbatim and keep links inert until explicitly opened.
export function messageBlocks(text) {
  const blocks = [];
  let fence = null, lines = [];
  function flush(kind) {
    if (lines.length) blocks.push({ kind, text: lines.join('\n') });
    lines = [];
  }
  const source = text.split('\n');
  const cells = line => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(s => s.trim().replace(/\\\|/g, '|'));
  for (let i = 0; i < source.length; i++) {
    const line = source[i];
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker && (!fence || (marker[1][0] === fence[0] && marker[1].length >= fence.length))) {
      flush(fence ? 'code' : 'text'); fence = fence ? null : marker[1]; continue;
    }
    if (fence) { lines.push(line); continue; }
    if (line.includes('|') && source[i + 1]?.includes('|') && cells(source[i + 1]).every(s => /^:?-{3,}:?$/.test(s))) {
      flush('text');
      const rows = [cells(line)]; i++;
      while (i + 1 < source.length && source[i + 1].includes('|') && source[i + 1].trim()) rows.push(cells(source[++i]));
      blocks.push({ kind: 'table', rows, text: rows.map(row => row.join('\t')).join('\n') }); continue;
    }
    if (/^\s*>/.test(line)) {
      flush('text');
      const quote = [line.replace(/^\s*>\s?/, '')];
      while (i + 1 < source.length && /^\s*>/.test(source[i + 1])) quote.push(source[++i].replace(/^\s*>\s?/, ''));
      blocks.push({ kind: 'quote', text: quote.join('\n') }); continue;
    }
    const heading = /^(#{1,6})\s+(.+)/.exec(line);
    if (heading) { flush('text'); blocks.push({ kind: 'heading', text: heading[2] }); }
    else if (!line.trim()) flush('text');
    else lines.push(line.replace(/^\s*[-*+]\s+/, '• '));
  }
  flush(fence ? 'code' : 'text');
  return blocks;
}
export function messageSpans(text) {
  const spans = [];
  const tokens = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+)|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
  let end = 0;
  for (const m of text.matchAll(tokens)) {
    if (m.index > end) spans.push({ text: text.slice(end, m.index) });
    spans.push({ text: m[1] || m[3] || m[4] || m[5], url: m[2] || m[3], bold: !!m[4], code: !!m[5] });
    end = m.index + m[0].length;
  }
  if (end < text.length) spans.push({ text: text.slice(end) });
  return spans;
}
