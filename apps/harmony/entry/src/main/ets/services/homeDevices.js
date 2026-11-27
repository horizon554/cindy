// The homepage can read several peers. Navigation and every mutation still use
// Workspace's selected peer and version. Each subscription owns its own rows.
import { HomeDeviceSyncLimiter, buildSessionScheduleIndex, normalizeScheduleList, normalizeScheduleRuns, PROTOCOL_VERSION } from './protocol.generated';
import { homeTask } from './homeList';

// A task can be the schedule's explicit target or the session of a particular run.
// The shared index resolves the latest binding and multiple active/paused schedules.
function scheduleIndex(bindings, snapshot) {
  const schedules = new Map(normalizeScheduleList(bindings).map(row => [row.id, row]));
  const runs = new Map();
  const inflight = new Map((snapshot?.inflightPolicies || []).map(row => [row.runId, row.sessionId]));
  for (const row of snapshot?.runs || []) {
    if (!row?.scheduleId || !row.runId) continue;
    if (!schedules.has(row.scheduleId)) schedules.set(row.scheduleId, { id: row.scheduleId, name: row.scheduleName, status: row.scheduleStatus });
    const sessionId = row.sessionId || (row.status === 'running' ? inflight.get(row.runId) : undefined);
    const [run] = normalizeScheduleRuns([{ ...row, id: row.runId, sessionId }]);
    if (!run) continue;
    if (!runs.has(row.scheduleId)) runs.set(row.scheduleId, []);
    runs.get(row.scheduleId).push(run);
  }
  const index = buildSessionScheduleIndex([...schedules.values()], runs);
  return new Map([...index].map(([id, info]) => [id, info.allSchedulesStopped === true]));
}

export class HomeDevices {
  constructor(workspace) {
    this.app = workspace;
    this.peers = new Map();
    this.pool = new HomeDeviceSyncLimiter();
    this.scope = '';
  }
  drop(id, close = false) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    clearTimeout(peer.timer);
    clearTimeout(peer.scheduleTimer);
    if (close && peer.opened) peer.client.closeLink(id, 'user');
  }
  clear(close) {
    for (const id of this.peers.keys()) this.drop(id, close);
  }
  sync(refresh = false) {
    const app = this.app;
    const ids = app.state.devices.filter(d => app.available(d.id) &&
      (!this.scope || d.id === this.scope || d.id === app.state.device)).map(d => d.id);
    const removed = [...this.peers.keys()].filter(id => !ids.includes(id));
    for (const id of removed) this.drop(id, true);
    if (removed.length) app.show({});
    return Promise.allSettled(ids.map(id => this.load(id, undefined, refresh))).then(results => {
      const failure = results.find((result, i) => result.status === 'rejected' && this.peers.has(ids[i]));
      if (failure) app.report(failure.reason);
    });
  }
  load(id, limit, refresh = false) {
    const app = this.app;
    let peer = this.peers.get(id);
    if (!peer) {
      peer = { id, owner: app.session.id, client: app.client, limit: 40, rows: new Map(), signals: new Map(), schedules: new Map() };
      this.peers.set(id, peer);
    }
    if (peer.flight) return peer.flight;
    if (peer.loaded && !limit && !refresh) return Promise.resolve();
    const guard = () => {
      if (this.peers.get(id) !== peer || app.client !== peer.client || app.session?.id !== peer.owner || !app.available(id)) {
        throw new Error('电脑连接已变更');
      }
    };
    const call = (channel, args) => app.requestHost(peer.client, id, channel, args, guard);
    const optional = async (channel, args) => {
      try { return await call(channel, args); }
      catch (error) {
        guard();
        if (!['CHANNEL_NOT_ALLOWED','NOT_FOUND'].includes(error.code)) throw error;
      }
    };
    peer.flight = this.pool.run(async () => {
      guard();
      peer.deltas = new Map();
      peer.activity = new Map();
      if (!peer.opened) {
        await peer.client.openLink(id, { controllerName: 'Cindy HarmonyOS', protocolVersion: PROTOCOL_VERSION, appVersion: '0.1.0', capabilities: [] });
        // A scope change can overtake the handshake. A replacement reader owns
        // its link, otherwise release the late handshake immediately.
        if (this.peers.get(id) !== peer && !this.peers.has(id)) peer.client.closeLink(id, 'user');
        guard();
        peer.opened = true;
      }
      if (!peer.subscribed) {
        await optional('device-link:subscribe', [{ topics: ['sessions'], controllerName: 'Cindy HarmonyOS', capabilities: [] }]);
        peer.subscribed = true;
      }
      const count = limit || peer.limit;
      const rows = await call('local-db:sessions:list', [count, 'all', { includePinned: true }]);
      const active = await optional('maker:list-active', [{ summary: true, snapshotVersion: 2 }]);
      const refreshSchedules = !peer.loaded || refresh;
      const drafts = await app.cache.draftTasks?.(peer.owner, id);
      guard();
      peer.rows = new Map(rows.filter(row => row?.id).map(row => [row.id, row]));
      for (const [key, patch] of peer.deltas) this.patchRow(peer, key, patch);
      const signals = Array.isArray(active) ? active : active?.sessions || [];
      peer.signals = new Map(signals.map(s => [s.sessionId, { ...s, isTurnRunning: s.isTurnRunning !== false }]));
      for (const [key, signal] of peer.activity) peer.signals.set(key, signal);
      peer.deltas = peer.activity = null;
      peer.drafts = drafts || new Set();
      peer.limit = count;
      peer.more = rows.length >= count && count < 1000;
      peer.loaded = true;
      await this.publish(peer);
      guard();
      if (refreshSchedules) this.readSchedules(peer, optional, guard);
    }, id === app.state.device ? 'foreground' : 'background').catch(async error => {
      if (this.peers.get(id) === peer && ['ACCESS_REVOKED','REMOTE_DISABLED'].includes(error.code)) await app.forgetHost(id);
      throw error;
    }).finally(() => { peer.flight = null; });
    return peer.flight;
  }
  readSchedules(peer, optional, guard) {
    // Never make opening a task wait for optional schedule channels. Use the same
    // device work pool and coalesce changes received while a snapshot is in flight.
    peer.refreshSchedules = () => this.readSchedules(peer, optional, guard);
    if (peer.scheduleFlight) { peer.scheduleDirty = true; return; }
    peer.scheduleFlight = this.pool.run(async () => {
      guard();
      const bindings = await optional('maker:schedule:list', [null, { sessionBindings: true }]);
      const snapshot = await optional('maker:schedule:list-sidebar-index-runs', []);
      guard();
      if (!bindings && !snapshot) return;
      const next = scheduleIndex(bindings, snapshot);
      if (next.size === peer.schedules.size && [...next].every(([id, stopped]) => peer.schedules.get(id) === stopped)) return;
      peer.schedules = next;
      await this.publish(peer);
    }).catch(async error => {
      if (this.peers.get(peer.id) === peer && ['ACCESS_REVOKED','REMOTE_DISABLED'].includes(error.code)) await this.app.forgetHost(peer.id);
    }).finally(() => {
      peer.scheduleFlight = null;
      if (peer.scheduleDirty && this.peers.get(peer.id) === peer) {
        peer.scheduleDirty = false;
        peer.refreshSchedules();
      }
    });
  }
  patchRow(peer, id, patch) {
    const row = peer.rows.get(id);
    if (row || patch.id === id) peer.rows.set(id, { ...row, ...patch });
  }
  refreshSoon(peer) {
    if (peer.timer) return;
    peer.timer = setTimeout(async () => {
      try {
        await peer.flight?.catch(() => {});
        peer.timer = null;
        if (this.peers.get(peer.id) === peer) await this.load(peer.id, peer.limit);
      } catch (error) { if (this.peers.get(peer.id) === peer) this.app.report(error); }

    }, 200);
  }
  push(host, channel, payload) {
    const peer = this.peers.get(host);
    if (!peer) return;
    const id = payload?.sessionId;
    if (channel === 'local-db:sessions:activity' && id && ['running','needs-interaction','completed','error'].includes(payload.phase)) {
      const signal = { activityPhase: payload.phase, activityAttention: payload.attention === true,
        isTurnRunning: ['running', 'needs-interaction'].includes(payload.phase) };
      peer.signals.set(id, signal);
      peer.activity?.set(id, signal);
      if (peer.loaded && peer.rows.has(id)) this.publishRow(peer, id);
    } else if (channel === 'local-db:sessions:patched' && id && payload.patch) {
      this.metadata(host, id, payload.patch);
    } else if (channel === 'maker:schedule:event' && ['changed', 'session-bound', 'resync'].includes(payload?.type) && !payload.skippedRunId) {
      if (!peer.scheduleTimer) peer.scheduleTimer = setTimeout(() => {
        peer.scheduleTimer = null;
        if (this.peers.get(host) === peer) peer.refreshSchedules?.();
      }, 200);
    } else if (channel === 'local-db:sessions:created') {
      this.refreshSoon(peer);
    }
  }
  metadata(host, id, patch) {
    const peer = this.peers.get(host);
    if (!peer) return;
    peer.deltas?.set(id, { ...peer.deltas.get(id), ...patch });
    this.patchRow(peer, id, patch);
    if (peer.loaded && peer.rows.has(id)) this.publishRow(peer, id);
  }
  item(peer, row) {
    const item = homeTask(row, peer.signals.get(row.id));
    item.localDraft = peer.drafts?.has(row.id) || false;
    item.scheduled = item.scheduled || peer.schedules.has(row.id);
    item.scheduleStopped = peer.schedules.get(row.id) === true;
    return item;
  }
  publishRow(peer, id) {
    const raw = peer.rows.get(id);
    const previous = (this.app.state.homeIndex || []).filter(row => row.host === peer.id);
    const index = previous.findIndex(row => row.id === id);
    if (raw.status === 'deleted' || raw.hiddenAt) {
      if (index >= 0) previous.splice(index, 1);
    } else if (index >= 0) previous[index] = this.item(peer, raw);
    else previous.push(this.item(peer, raw));
    this.app.putHomeRows(peer.id, previous);
  }
  publish(peer) {
    const tasks = [...peer.rows.values()].filter(row => row.status !== 'deleted' && !row.hiddenAt).map(row => this.item(peer, row));
    this.app.putHomeRows(peer.id, tasks);
    return this.app.cache.write([peer.owner, peer.id, '', 'tasks'], tasks);
  }
  more() {
    return Promise.all([...this.peers.values()].filter(peer => peer.more && (!this.scope || this.scope === peer.id))
      .map(peer => this.load(peer.id, Math.min(1000, peer.limit + 40))));
  }
}
