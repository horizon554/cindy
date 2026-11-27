import { getSessionListCollapseView, hasPendingSessionInterruption, resolveMobileSessionRightStatus,
  sessionTaskProjectIconDirectory } from './protocol.generated';

export function activityFields(signal, interrupted) {
  const running = signal?.isTurnRunning === true || signal?.activityPhase === 'running';
  const phase = signal?.activityPhase;
  const attention = signal?.activityAttention === true;
  const cleared = !attention && (phase === 'completed' || phase === 'error');
  const rightStatus = interrupted ? 'error' : resolveMobileSessionRightStatus({
    livePhase: cleared ? undefined : phase, liveAttention: attention,
    running, pendingInteractionCount: 0, scheduleUnreadCount: 0,
  });
  return { running, rightStatus };
}

export function homeTask(row, signal) {
  const interrupted = hasPendingSessionInterruption(row);
  return {
    id: row.id, title: row.title || '未命名任务', pinnedAt: row.pinnedAt || '',
    project: sessionTaskProjectIconDirectory(row) || '', summary: row.preview || row.summary || '',
    created: row.createdAt || '', updated: row.lastActivityAt || row.userSendAt || row.updatedAt || row.createdAt || '',
    status: row.status || '', interrupted, ...activityFields(signal || row, interrupted),
  };
}

// Keep standalone tasks interleaved with projects in the user's chosen sort order.
export function groupHomeRows(rows, groupProjects, flat, searching, deviceOrder = [], collapsed = []) {
  const groups = [], projects = new Map();
  const pinned = [];
  for (const row of rows) {
    if (!flat && row.pinnedAt) { pinned.push(row); continue; }
    if (flat || !groupProjects || !row.project) {
      groups.push({ key: JSON.stringify(['task', row.host, row.id]), kind: 'task', head: row, rows: [row], total: 1 });
      continue;
    }
    const key = JSON.stringify(['project', row.host, row.project]);
    let group = projects.get(key);
    if (!group) {
      group = { key, kind: 'project', head: row, rows: [], total: 0 };
      projects.set(key, group);
      groups.push(group);
    }
    group.rows.push(row);
  }
  const nowMs = Date.now();
  for (const group of projects.values()) {
    const preview = getSessionListCollapseView({
      entries: group.rows, showAll: false, isFiltering: searching,
      disableCollapse: false, isActiveEntry: () => false, nowMs, getActivityMs: row => Date.parse(row.updated),
      hasAttentionEntry: row => row.running || (row.rightStatus && row.rightStatus !== 'time'),
    });
    group.total = preview.totalCount;
    group.rows = preview.visibleEntries;
  }
  if (!flat && deviceOrder.length > 1) {
    const byHost = new Map();
    for (const group of groups) {
      const host = group.head.host;
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push(group);
    }
    if (byHost.size > 1) {
      groups.length = 0;
      for (const host of deviceOrder) {
        const children = byHost.get(host);
        if (!children) continue;
        const key = JSON.stringify(['device', host]);
        groups.push({ key, kind: 'device', head: children[0].head, rows: [], total: 0 });
        if (!collapsed.includes(key)) groups.push(...children);
      }
    }
  }
  if (pinned.length) {
    pinned.sort((a, b) => Date.parse(b.pinnedAt) - Date.parse(a.pinnedAt));
    groups.unshift({ key: 'pinned', kind: 'pinned', head: pinned[0], rows: pinned, total: pinned.length });
  }
  return groups;
}
