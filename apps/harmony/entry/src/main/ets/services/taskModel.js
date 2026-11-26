import { normalizeAskQuestions, answerKey, askQuestionOptions, askAnswerError, encodeMultiSelectAnswer,
  selectionFromAnswer, buildPermissionReviewPresentation } from './protocol.generated';

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

export function taskPage(rows, task) {
  const page = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row?.id || row.sessionId !== task || seen.has(row.id)) continue;
    seen.add(row.id);
    let title;
    if (row.role === 'ask_user' || row.role === 'permission' || row.role === 'tool_use' || row.role === 'tool_result') {
      let data = row.content;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* Plain tool output. */ } }
      if (row.role === 'ask_user') title = normalizeAskQuestions(data?.questions).map(q => q.question).join('\n');
      if (row.role === 'permission') title = data?.title || data?.toolName || '操作审批';
      if (row.role === 'tool_use') title = '工具 · ' + (data?.toolName || data?.name || row.toolName || '调用');
      if (row.role === 'tool_result') title = body(data) || data?.output || '工具已返回';
    }
    page.push({ id: row.id, clientId: row.clientId || '', role: row.role || '',
      title: (typeof title === 'string' && title) || body(row.content) || row.toolName || '暂不支持显示此消息' });
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
      result.detail = [p.sourceDescription, p.description, p.riskSummary, p.code].filter(Boolean).join('\n');
    } else if (r.kind === 'plan_review') {
      result.title = '审核计划';
      result.detail = r.plan || '';
    } else if (r.kind === 'ask_user_question') {
      result.title = '待回答';
      result.questions = normalizeAskQuestions(r.questions).map(q => {
        const key = answerKey(q);
        const answer = edits.get(r.requestId)?.get(key) || '';
        const { selectedLabels, customInput } = selectionFromAnswer(q, answer);
        const choices = askQuestionOptions(q);
        return { key, label: q.question, multi: !!q.multiSelect, free: !q.answerConstraints?.choices,
          value: q.multiSelect ? customInput : answer,
          options: choices.map(opt => ({ label: opt.label, detail: opt.description || '', selected: selectedLabels.has(opt.label) })) };
      });
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
