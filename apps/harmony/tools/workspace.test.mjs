// M1a integration regression. Mobile's transport tests do not exercise the Harmony
// page controller. A missing enqueue reply followed by reconnect must yield one
// durable input, and a fresh app instance must re-read that same Host history.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { build } from 'esbuild';
import './build-protocol.mjs';

const bundled = await build({
  stdin: { contents: "export { Workspace } from './workspace'; export { receiveWant } from './sso'; export { groupHomeRows } from './homeList';",
    resolveDir: fileURLToPath(new URL('../entry/src/main/ets/services', import.meta.url)) },
  platform: 'node', format: 'esm', bundle: true, write: false,
  plugins: [{
    name: 'native-test-ports',
    setup(b) {
      b.onResolve({ filter: /^(@ohos.security.cryptoFramework|@ohos.url|@ohos.systemDateTime|@ohos.util|\.\/cache|\.\/platform)$/ }, args => ({ path: args.path, namespace: 'port' }));
      b.onLoad({ filter: /.*/, namespace: 'port' }, args => ({
        contents: args.path === './cache' ? `const entries=new Map(); export async function openCache() { return {
          read:async k=>entries.get(JSON.stringify(k)), write:async(k,v)=>entries.set(JSON.stringify(k),v),
          forget:async(a,h)=>{for(const k of entries.keys()){const [owner,host]=JSON.parse(k);if(a===owner&&(!h||h===host)) entries.delete(k)}}}; }` :
          args.path === '@ohos.url' ? 'export default {URL, URLParams:URLSearchParams}' :
          args.path === '@ohos.security.cryptoFramework' ? `import {randomBytes, createHash} from 'node:crypto'; export default {createRandom:()=>({generateRandomSync:n=>({data:randomBytes(n)})}),createMd:()=>{const md=createHash('sha256');return {updateSync:b=>md.update(b.data),digestSync:()=>({data:md.digest()})}}}` :
          args.path === '@ohos.systemDateTime'
          ? 'export default { getUptime:()=>performance.now(), TimeType:{ACTIVE:1} }'
          : args.path === '@ohos.util'
          ? 'export default {generateRandomUUID:()=>crypto.randomUUID(),TextEncoder:class { encodeInto(s){return Buffer.from(s)} },Base64Helper:class {encodeToStringSync(b){return b.toString("base64")} decodeSync(s){return Buffer.from(s,"base64url")}}, TextDecoder:{create:()=>({decodeWithStream:b=>b.toString()})}}'
          : 'export const {accountUrl,directoryUrl,relayUrl,request,deviceIdentity,readSession,saveSession,createSocket}=globalThis.harmonyPorts'
      }));
    }
  }]
});
async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await pause(25);
  }
  assert.fail('Expected application state was not reached');
}

test('stream, reconnect after accepted input, and restore login on relaunch', async t => {
  const jwt = 'test.' + Buffer.from(JSON.stringify({exp: Date.now()/1000 + 3600})).toString('base64url') + '.test';
  const login = { status: 'ok', accessToken: jwt, refreshToken: 'fixture', membership: { id: 'account', displayName: 'Fixture', email: 'fixture@example.invalid', avatarUrl: 'https://fixture.invalid/avatar' } };
  const host = { id: 'task', workingDir: '/fixture', title: 'Fixture task', agentKind: 'codex', model: 'fixture' };
  const rows = [{ id: 'first', sessionId: 'task', content: {text: 'existing'} }];
  const secrets = new Map();
  let homeSnapshotRace = false;
  let socket, authorizeUrl, exchanges = 0, count = 0, subscriptions = 0, refreshes = 0;
  globalThis.harmonyPorts = {
    accountUrl: 'https://fixture.invalid', directoryUrl: '/devices', relayUrl: 'wss://fixture.invalid',
    deviceIdentity: async () => 'phone', saveSession: async (s,k='session') => { secrets.set(k,s); }, readSession: async (k='session') => secrets.get(k),
    async request(url, body, token) {
      if (url.endsWith('/sso/discovery')) return { region:'cn', orgName:'Fixture',
        connections:[{connectionId:'fixture',connectionName:'Test SAML'}] };
      if (url.endsWith('/token')) {
        exchanges++;
        assert.equal(body.code, 'one-use');
        assert.equal(createHash('sha256').update(body.codeVerifier).digest('base64url'), authorizeUrl.searchParams.get('code_challenge'));
        return login;
      }
      if (url.endsWith('/providers')) return { region: 'cn', phone: true };
      if (url.endsWith('/request-code')) return { status: 'sent' };
      if (url.endsWith('/verify-code')) return login;
      if (url.endsWith('/refresh')) { assert.equal(body.refreshToken, 'fixture'); refreshes++; return login; }
      assert.equal(url, '/devices'); assert.equal(token, jwt);
      return { devices: [{deviceId:'host',name:'Desktop',online:true,remoteControlEnabled:true}] };
    },
    createSocket(url, headers) {
      assert.equal(headers.authorization, 'Bearer ' + jwt);
      const events = new Map();
      function emit(kind, ...args) { for (const cb of events.get(kind) || []) cb(...args); }
      function received(frame) { emit('message', JSON.stringify({v:1, ...frame})); }
      socket = {
        on(kind, fn) { events.set(kind, [...events.get(kind) || [],fn]); },
        close() { emit('close', 1006); },
        push(channel,payload) { received({kind:'push',src:'host',payload:{channel,payload}}); },
        send(raw) {
          const frame = JSON.parse(raw);
          queueMicrotask(() => {
            const reply = (kind,payload) => received({kind,id:frame.id,src:'host',dst:'phone',payload});
            if (frame.kind === 'hello') return reply('hello-ack',{serverProtocolVersion:1,deviceId:'phone',userId:'account'});
            if (frame.kind === 'link-open') return reply('link-accept',{appVersion:'fixture',allowlistHash:'fixture'});
            if (frame.kind !== 'invoke') return;
            const {channel,args} = frame.payload;
            let result;
            switch (channel) {
              case 'maker:schedule:list': result = []; break;
              case 'maker:schedule:list-sidebar-index-runs': result = {runs:[]}; break;
              case 'maker:list-active':
                result = {format:'active-sessions-v2',sessions:[]};
                if (homeSnapshotRace) {
                  homeSnapshotRace = false;
                  socket.push('local-db:sessions:activity', {sessionId:'task',phase:'needs-interaction',attention:true});
                }
                break;
              case 'maker:get-pending-interactions': result = []; break;
              case 'maker:input:get-projection': result = {inputDeliveryVersion:1, deliveryReceipts:(args[1]?.deliveryClientIds || []).map(id => ({
                clientId: id, state: rows.some(r => r.id === id) ? 'accepted' : 'unknown'
              }))}; break;
              case 'local-db:sessions:list': result = [host]; break;
              case 'local-db:sessions:get': result = host; break;
              case 'local-db:messages:list': result = rows.slice().reverse(); break;
              case 'device-link:subscribe': subscriptions++; break;
              case 'maker:input:enqueue':
                count++;
                assert.equal(args[0],host.id);
                rows.push({id:args[1].clientId,sessionId:'task',content:args[1].persistedContent});
                socket.close(); // accepted by host, response lost
                return;
              default: assert.fail('Unexpected invoke ' + channel);
            }
            reply('invoke-result',{ok:true,result:result ?? null});
          });
        }
      };
      setTimeout(() => emit('open'),0);
      return socket;
    }
  };
  const { Workspace, receiveWant } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  let state;
  let app = new Workspace(s => { state = s; });
  t.after(() => { app.client?.stop(); delete globalThis.harmonyPorts; });
  await app.init({});
  await app.code('fixture');
  await assert.rejects(app.login('fixture', '12345'), /六位/);
  await app.login('fixture','123456');
  await until(() => state?.relay === 'online' && state?.devices.length);
  await app.openDevice('host');
  await app.openTask('task');
  assert.equal(state.messages[0].title,'existing');
  socket.push('maker:event',{sessionId:'task',event:{type:'text',data:{text:'partial'}}});
  assert.equal(state.live,'partial');
  await assert.rejects(app.send('one input'));
  rows.push({id:'reply',sessionId:'task',content:{text:'finished while offline'}});
  await until(() => state.messages.length === 3);
  assert.deepEqual(state.messages.map(m => m.title),['existing','one input','finished while offline']);
  assert.equal(subscriptions,2);
  assert.equal(count,1);
  app.client.stop();
  // A newer activity push must survive a delayed list snapshot, and a later read
  // acknowledgement must clear the terminal dot without another list request.
  host.pinnedAt = '2026-01-02T00:00:00Z';
  homeSnapshotRace = true;
  app = new Workspace(s => { state = s; }, true);
  await app.init({});
  await until(() => state?.linked && state.tasks.length);
  assert.equal(state.tasks[0].pinnedAt, host.pinnedAt);
  assert.equal(state.tasks[0].project, '/fixture');
  assert.equal(state.tasks[0].rightStatus, 'awaiting');
  for (const [phase, attention, expected] of [
    ['running',false,'running'], ['error',true,'error'], ['completed',true,'done'], ['completed',false,'time'],
  ]) {
    socket.push('local-db:sessions:activity', {sessionId:'task',phase,attention});
    assert.equal(state.tasks[0].rightStatus, expected);
  }
  await app.openTask('task');
  assert.equal(refreshes,1);
  assert.equal(state.accountEmail, login.membership.email);
  assert.equal(state.accountAvatar, login.membership.avatarUrl);
  assert.equal(secrets.get('session').email, undefined);
  assert.equal(state.messages.at(-1).title,'finished while offline');
  assert.equal(count,1);
  await app.logout();
  assert.equal(secrets.get('session'),null);
  assert.equal(state.accountEmail, '');
  assert.equal(state.accountAvatar, '');

  // Cold-start callback: same native launch event and a newly created page owner.
  app = new Workspace(s => { state = s; });
  await app.init({ startAbility: async want => { authorizeUrl = new URL(want.uri); } });
  await app.discover('fixture');
  const stateKey = authorizeUrl.searchParams.get('client_state');
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), 'cindycn://auth');
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
  app = new Workspace(s => { state = s; });
  await app.init({});
  assert.equal(state.ssoWaiting, true);
  receiveWant('cindycn://auth?code=one-use&state=old');
  await app.callbackQueue;
  assert.equal(exchanges, 0);
  const callback = 'cindycn://auth?code=one-use&state=' + stateKey;
  receiveWant(callback);
  receiveWant(callback);
  await app.callbackQueue;
  assert.equal(state.account, 'Fixture');
  assert.equal(exchanges, 1);
  await app.logout();
});

// Tier 1: two computers can contain identical task IDs and project paths. Run the
// home controller against distinct peers, including a cancelled archive preflight.
test('group home tasks by computer and apply row actions only to their owning peer', async () => {
  const directory = ['a', 'b'].map(deviceId => ({ deviceId, name: deviceId, remoteControlEnabled: true, online: true }));
  directory.push({ deviceId: 'disabled', name: '', remoteControlEnabled: false, online: true });
  globalThis.harmonyPorts = { request: async () => ({ devices: directory }) };
  const { Workspace, groupHomeRows } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64') + '#home-groups');
  const app = new Workspace(() => {}, true);
  const peers = new Map(['a', 'b'].map(host => [host, [
    { id: 'same', title: host, workingDir: '/work', status: 'active' },
    { id: 'solo', title: 'Shared chat', workspaceKind: 'dialogue', status: 'active' },
  ]]));
  const saved = new Map();
  const writes = [];
  app.session = { id: 'owner' };
  app.token = async () => 'fixture';
  let releaseCache, blockList;
  const staleCache = new Promise(resolve => { releaseCache = resolve; });
  const lists = [];
  app.cache = { read: async key => key[1] === 'b' && key[3] === 'tasks' ? staleCache : saved.get(JSON.stringify(key)),
    forget: async (owner, host) => saved.delete(JSON.stringify([owner,host,'','tasks'])), write: async (key, value) => saved.set(JSON.stringify(key), value) };
  app.client = { openLink: async () => {}, closeLink() {}, async invoke(host, { channel, args }, _, options) {
    options.beforeDispatch();
    const rows = peers.get(host);
    let result;
    if (channel === 'local-db:sessions:list') {
      lists.push(host);
      if (host === 'b' && blockList) await blockList;
      result = rows.slice(0, args[0]);
    }
    if (channel === 'maker:list-active' && host === 'b') result = [{sessionId:'same',isTurnRunning:true}];
    if (channel === 'local-db:sessions:get') result = rows.find(row => row.id === args[0]);
    if (channel === 'maker:schedule:list-sidebar-index-runs') result = {runs:[{
      scheduleId:'paused', scheduleName:'Paused', scheduleStatus:'paused', runId:'r', sessionId:'solo', status:'completed', firedAt:10,
    }]};
    if (channel === 'maker:schedule:list') result = [{ id: 'schedule', name: 'Daily', status: 'active', targetSessionId: 'same' }];
    if (channel === 'local-db:sessions:patch-meta') {
      writes.push(host);
      result = Object.assign(rows.find(row => row.id === args[0]), args[1]);
    }
    return { ok: true, result };
  } };
  app.show({ relay: 'online' });
  await app.reconnect();
  assert.equal(app.state.device, '');
  assert.deepEqual(lists.sort(), ['a','b']);
  assert.equal(app.state.homeIndex.filter(row => row.id === 'same').length, 2);
  assert.deepEqual(app.state.homeIndex.filter(row => row.id === 'solo' && row.title === 'Shared chat').map(row => row.host).sort(), ['a','b']);
  const rowB = () => app.state.homeIndex.find(row => row.host === 'b' && row.id === 'same');
  assert.equal(rowB().rightStatus, 'running');
  await until(() => rowB()?.scheduled);
  assert.equal(rowB().scheduled, true);
  assert.equal(app.state.homeIndex.find(row => row.host === 'b' && row.id === 'solo').scheduleStopped, true);
  releaseCache([{ id: 'stale', title: 'old cache' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rowB().title, 'b');
  await app.openDevice('b');
  assert.equal(lists.length, 2);
  const sections = (collapsed = []) => groupHomeRows(app.state.homeIndex, true, false, false, ['a', 'b'], collapsed);
  assert.deepEqual(sections().filter(group => group.kind === 'device').map(group => group.head.host), ['a', 'b']);
  assert.deepEqual(sections([sections()[0].key]).filter(group => group.kind === 'project').map(group => group.head.host), ['b']);
  assert.ok(groupHomeRows(app.state.homeIndex.filter(row => row.host === 'b'), true, false, false, ['a','b']).every(group => group.kind !== 'device'));
  assert.ok(groupHomeRows(app.state.homeIndex, true, true, false, ['a','b']).every(group => group.kind === 'task'));
  await app.changeHomeTask('a', 'same', 'pin');
  assert.equal(sections()[0].kind, 'pinned');
  assert.equal(sections()[0].head.host, 'a');
  const archive = confirm => app.changeHomeTask('a', 'same', 'archive', '', async names => {
    assert.deepEqual(names, ['Daily']); return confirm;
  });
  await archive(false);
  assert.deepEqual(writes, ['a']);
  await archive(true);
  await app.changeHomeTask('a', 'same', 'restore');
  await app.changeHomeTask('a', 'same', 'rename', 'Changed');
  const result = saved.get(JSON.stringify(['owner', 'a', '', 'tasks'])).find(row => row.id === 'same');
  assert.deepEqual([result.title, result.status, result.pinnedAt], ['Changed', 'active', '']);
  assert.deepEqual(peers.get('b')[0], { id: 'same', title: 'b', workingDir: '/work', status: 'active' });
  assert.deepEqual(writes, ['a', 'a', 'a', 'a']);
  for (let i = 0; i < 40; i++) peers.get('b').push({id: 'page-' + i, title: 'Page ' + i});
  await app.reconnect();
  assert.equal(app.state.moreTasks, true);
  await app.more();
  assert.ok(app.state.homeIndex.some(row => row.id === 'page-39' && row.host === 'b'));
  assert.equal(app.state.moreTasks, false);
  app.setHomeScope('a');
  assert.deepEqual(app.state.liveHosts, ['a']);
  let releaseList;
  blockList = new Promise(resolve => { releaseList = resolve; });
  const reads = lists.length;
  app.setHomeScope('');
  await until(() => lists.length > reads);
  await app.forgetHost('b');
  releaseList();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(app.state.homeIndex.every(row => row.host !== 'b'));
  assert.ok(!saved.has(JSON.stringify(['owner','b','','tasks'])));
  delete globalThis.harmonyPorts;
});

// M2 regression through the page controller, replacing only native storage and
// the peer transport. A lost create reply, same-timestamp history and a racing
// dismissal previously had no Harmony coverage.
test('recover creation, reconcile pages and decisions, isolate offline drafts and revoke access', async () => {
  globalThis.harmonyPorts = { deviceIdentity: async () => 'phone', readSession: async () => null, saveSession: async () => {},
    request: async () => { throw Object.assign(new Error('directory denied'), {httpStatus:403}); } };
  const { Workspace } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64') + '#m2');
  const app = new Workspace(() => {}, true);
  await app.init({});
  app.session = { id: 'account-one', name: '测试' };
  app.show({ account: '测试', relay: 'online', devices: [{ id: 'pc', title: '电脑' }] });
  const sessions = new Map();
  let history = [], cards = [], created = 0, enqueue = 0, stopped = 0, resumed = 0, resolved = 0;
  let loseCreation = true, loseSend = false, refuse = false, lostDecision = false;
  let holdHistory, releaseHistory, legacyHost = false;
  const requests = [];
  const receipt = new Map();
  const ask = {request: {kind:'ask_user_question',requestId:'q',questions:[
    {id:'q1',question:'选哪些？',multiSelect:true,options:[{label:'甲'},{label:'乙'}]},
    {id:'q2',question:'说明',answerConstraints:{required:true,minLength:2}}
  ]}};
  const permission = {request:{kind:'permission',requestId:'p',toolName:'Read',input:{file_path:'fixture.txt'}}};
  app.client = { openLink: async () => {}, closeLink() {}, stop() {},
    async invoke(host, {channel,args}, _, options) {
      options.beforeDispatch();
      requests.push({channel,args,host});
      const id = args[0];
      let result;
      switch (channel) {
        case 'local-db:sessions:list': result = [...sessions.values()].slice(0,id); break;
        case 'local-db:sessions:get-many': result = id.map(k => sessions.get(k)).filter(Boolean); break;
        case 'maker:get-new-maker-defaults': result = {selectedAgentKind:'pi',model:id === 'pi' ? 'host-model':'other', permissionMode:'ask'}; break;
        case 'maker:list-available-agents': result = ['pi','codex']; break;
        case 'maker:provider:list':
          if (legacyHost) return {ok:false,error:{code:'CHANNEL_NOT_ALLOWED'}};
          result = {providers:[]}; break;
        case 'maker:get-capabilities': result = {availableModels:[{id:'other', label:'Other'}],permissionModes:[{id:'ask',label:'Ask'},{id:'plan',label:'Plan'}]}; break;
        case 'maker:set-model': sessions.get(id).model = args[1]; break;
        case 'maker:create-session':
          created++;
          if (created === 1) { assert.equal(id.agentKind,'pi'); assert.equal(id.model,'host-model'); }
          sessions.set(id.id, {...id,workingDir:'/fixture'});
          if (loseCreation) { loseCreation = false; throw new Error('reply lost'); }
          result = {sessionId:id.id}; break;
        case 'local-db:sessions:patch-meta': Object.assign(sessions.get(id),args[1]); break;
        case 'local-db:sessions:get': result = sessions.get(id); break;
        case 'device-link:subscribe': case 'device-link:unsubscribe': break;
        case 'local-db:messages:list': {
          const before = args[1]?.before;
          const index = before ? history.findIndex(row => row.id === before) : history.length;
          result = history.slice(Math.max(0,index-40),index).reverse().map(row=>({...row}));
          if (holdHistory) { holdHistory(); holdHistory = null; await new Promise(ok => {releaseHistory = ok;}); }
          break;
        }
        case 'maker:get-pending-interactions': result = cards; break;
        case 'maker:list-active': result = {sessions:[{sessionId:[...sessions.keys()][0],isTurnRunning:true}]}; break;
        case 'maker:input:get-projection': result = {inputDeliveryVersion:1,pendingQueue:[],
          deliveryReceipts:(args[1]?.deliveryClientIds || []).map(clientId => ({clientId,state:receipt.get(clientId) || 'unknown'}))}; break;
        case 'maker:input:enqueue':
          enqueue++; receipt.set(args[1].clientId,'accepted');
          if (loseSend) { loseSend=false; throw new Error('reply lost'); } break;
        case 'maker:input:stop': stopped++; assert.deepEqual(args[1],{keepQueue:true,pauseQueue:true}); break;
        case 'maker:input:resume': resumed++; break;
        case 'maker:resolve-interaction':
          resolved++; cards = cards.filter(entry => entry.request.requestId !== id);
          if (lostDecision) { lostDecision = false; throw new Error('reply lost'); }
          result = {accepted: !refuse}; break;
        default: assert.fail('Unexpected channel ' + channel);
      }
      return { ok: true, result };
    } };
  await app.openDevice('pc');
  await assert.rejects(app.create('同一任务', '/fixture', '第一条消息'), /reply lost/);
  await Promise.all([app.create('同一任务', '/fixture', '第一条消息'),app.create('同一任务', '/fixture', '第一条消息')]);
  const task = app.state.task;
  assert.ok(task); assert.equal(created,1); assert.equal(sessions.get(task).title,'同一任务');
  assert.equal(enqueue,1);
  assert.equal(sessions.get(task).workspaceKind,'project');
  assert.equal(requests.filter(r => r.channel === 'maker:input:enqueue')[0].args[1].text,'第一条消息');
  assert.equal(app.state.running,true);
  await app.control(false); await app.control(true); assert.equal(stopped,1); assert.equal(resumed,1);
  app.show({running:false});
  assert.deepEqual((await app.preferences('model')).map(row => row.id), ['other']);
  await assert.rejects(app.applyPreference('model','unlisted'), /重新选择/);
  await app.applyPreference('model','other');
  assert.equal(app.state.model,'other');
  history = Array.from({length:85},(_,i)=>({id:'m'+i,sessionId:task,createdAt:20,role:'user',content:'行 '+i}));
  history[80] = {...history[80],role:'future',content:{}};
  await app.history(app.version);
  assert.equal(app.state.messages[0].id,'m45');
  await app.older(); await app.older();
  assert.equal(app.state.hasOlder,false);
  assert.deepEqual(app.state.messages.map(m=>m.id),history.map(m=>m.id));
  assert.equal(app.state.messages[80].title,'暂不支持显示此消息');
  await app.history(app.version);
  assert.equal(new Set(app.state.messages.map(m=>m.id)).size,85);
  const oldReadEntered = new Promise(ok => { holdHistory = ok; });
  const oldRead = app.history(app.version);
  await oldReadEntered;
  history.at(-1).content = '新的权威结果';
  await app.history(app.version);
  releaseHistory(); await oldRead;
  assert.equal(app.state.messages.at(-1).title,'新的权威结果');
  history = history.filter(row=>row.id!=='m18');
  history.push({id:'later',sessionId:task,role:'assistant',content:'恢复后到达'});
  await app.history(app.version,false,true);
  assert.deepEqual(app.state.messages.map(m=>m.id),history.map(m=>m.id));
  app.editDraft('上次发送');
  loseSend = true;
  await assert.rejects(app.send('上次发送'),/reply lost/);
  app.editDraft('继续写的新草稿');
  await app.reconcile(app.version);
  assert.equal(app.state.draft,'继续写的新草稿'); assert.equal(enqueue,2);

  cards = [ask]; await app.refreshCards(app.version);
  app.editAnswer('q','q1','乙',true); app.editAnswer('q','q1','甲',true);
  await assert.rejects(app.decide('q','answer'),/检查回答/);
  assert.equal(app.state.cards[0].complete,false);
  app.editAnswer('q','q2','中文',false);
  assert.equal(app.state.cards[0].complete,true);
  await app.decide('q','answer');
  assert.deepEqual({...requests.filter(r=>r.channel==='maker:resolve-interaction').at(-1).args[1].answers}, {q1:'["甲","乙"]',q2:'中文'});
  for (const choice of ['allow','deny']) {
    cards = [permission]; await app.refreshCards(app.version); await app.decide('p',choice);
    assert.equal(requests.filter(r=>r.channel==='maker:resolve-interaction').at(-1).args[1].behavior,choice);
  }
  cards = [permission]; await app.refreshCards(app.version); cards = [];
  await assert.rejects(app.decide('p','allow'),/已结束/); assert.equal(resolved,3);
  refuse = true; cards = [permission]; await app.refreshCards(app.version);
  await assert.rejects(app.decide('p','allow'),/已过期/); assert.deepEqual(app.state.cards,[]);
  lostDecision = true; cards = [permission]; await app.refreshCards(app.version);
  await assert.rejects(app.decide('p','allow'),/已结束/); assert.deepEqual(app.state.cards,[]);

  // A second tap must still refer to the command currently authorized by the Host.
  refuse = false; lostDecision = false;
  const risk = {request:{requestId:'risk',kind:'permission',toolName:'Bash',input:{command:'git push --dry-run'}}};
  cards = [risk]; await app.refreshCards(app.version);
  const original = app.state.cards[0].approvalKey;
  assert.ok(original);
  const beforeConfirm = resolved;
  await assert.rejects(app.decide('risk','allow'), /重新确认/);
  risk.request.input.command = 'git push --dry-run origin';
  await assert.rejects(app.decide('risk','allow',original), /重新确认/);
  assert.equal(resolved,beforeConfirm);
  await app.decide('risk','allow',app.state.cards[0].approvalKey);
  assert.equal(resolved,beforeConfirm + 1);

  await app.back();
  loseCreation = true;
  await assert.rejects(app.create('使用所选引擎', '', '', 'codex'), /reply lost/);
  await app.create('使用所选引擎', '', '', 'codex');
  assert.equal(created, 2);
  assert.equal(sessions.get(app.state.task).agentKind, 'codex');
  assert.equal(sessions.get(app.state.task).model, 'other');
  // The first-message toolbar runs before a task exists. A lost create reply must
  // preserve its file and selections, and using the share target must never enqueue.
  await app.back();
  app.beginNew();
  await app.configureNew();
  assert.equal(app.state.legacyPicker, false);
  assert.deepEqual(await app.preferences('model'), []);
  legacyHost = true;
  await app.configureNew();
  assert.equal(app.state.legacyPicker, true);
  await app.preferences('model'); await app.applyPreference('model','other');
  await app.preferences('permission'); await app.applyPreference('permission','plan');
  const firstFile = {id:'first-file',name:'notes.txt',path:'test-key',category:'text',mimeType:'text/plain'};
  app.native = {pickFile:async () => 'file://docs/notes.txt',uploadFile:async () => firstFile};
  let finishFirst;
  app.native.uploadFile = () => new Promise(resolve => { finishFirst = resolve; });
  app.editDraft('新任务草稿');
  const cancelledFirst = app.addFile('file');
  await until(() => app.state.uploadPending);
  const beforeCancel = created;
  const cancelledCreate = app.create('', '/fixture', app.state.draft);
  app.cancelTransfer();
  await cancelledCreate;
  finishFirst(firstFile);
  assert.equal(await cancelledFirst, false);
  assert.equal(created, beforeCancel);
  assert.equal(app.state.draft, '新任务草稿');
  app.editDraft('');
  const pickingFirst = app.addFile('file');
  await until(() => app.state.uploadPending);
  const enqueuesBefore = enqueue;
  const createdBefore = created;
  loseCreation = true;
  const firstTaps = [app.create('', '/fixture'), app.create('', '/fixture')].map(promise => assert.rejects(promise, /reply lost/));
  assert.equal(created, createdBefore);
  finishFirst(firstFile);
  await Promise.all([pickingFirst, ...firstTaps]);
  assert.equal(created, createdBefore + 1);
  app.native.uploadFile = async () => firstFile;
  await app.create('', '/fixture');
  assert.equal(enqueue, enqueuesBefore + 1);
  assert.deepEqual(requests.filter(r => r.channel === 'maker:input:enqueue').at(-1).args[1].files, [firstFile]);
  assert.equal(sessions.get(app.state.task).permissionMode, 'plan');
  assert.equal(sessions.get(app.state.task).model, 'other');
  await app.rename('验收新标题');
  assert.equal(app.state.tasks.find(row => row.id === app.state.task).title, '验收新标题');
  await app.back();
  app.beginNew();
  await app.addFile('file');
  app.editDraft('保留草稿');
  const snapshot = app.snapshotNew();
  app.cancelNew();
  assert.deepEqual(app.state.attachments, []);
  app.beginNew(snapshot);
  assert.equal(app.state.draft, '保留草稿');
  await app.create('', '', app.state.draft, '', true);
  assert.deepEqual(app.state.attachments, [firstFile]);
  assert.equal(app.state.draft, '保留草稿');
  assert.equal(enqueue, enqueuesBefore + 1);
  app.native = undefined;
  legacyHost = false;
  await app.back(); await app.back(); app.show({relay:'offline'});
  await app.openDevice('pc'); await app.openTask(task);
  assert.equal(app.state.messages.length,85); assert.equal(app.state.draft,'继续写的新草稿');
  await assert.rejects(app.send(app.state.draft), /请先连接/);
  const oldKey = app.key('draft');
  await app.back(); await app.back();
  app.session = {id:'another-account'}; await app.openDevice('pc');
  assert.deepEqual(app.state.tasks,[]);
  await app.back(); app.session = {id:'account-one'};
  await app.openDevice('pc'); await app.openTask(task);
  app.show({linked:true,relay:'online'});
  const entered = new Promise(ok=>{holdHistory=ok;});
  const late = app.history(app.version);
  await entered;
  await app.forgetHost('pc'); releaseHistory();
  await assert.rejects(late,/变更|切换/); assert.deepEqual(app.state.messages,[]);
  assert.equal(await app.cache.read(oldKey), undefined);
  assert.deepEqual(app.state.devices,[]);
  await app.cache.write(oldKey,'失权前的草稿');
  app.access='fixture'; app.expires=Date.now()+60000;
  await assert.rejects(app.devices(),/directory denied/);
  assert.equal(await app.cache.read(oldKey),undefined);
  await app.cache.write(oldKey,'退出前的草稿');
  await app.logout();
  assert.equal(await app.cache.read(oldKey),undefined);
  delete globalThis.harmonyPorts;
});

// Tier 1. Harmony page entry points. A picked file may finish after navigation,
// and an accepted attachment-only enqueue may lose its reply. Assert what the
// next task and the Host actually receive, including a cold task restore.
test('route a notification, accept a share and recover one attachment-only message', async () => {
  const previews = [];
  globalThis.harmonyPorts = { request: async (url, body, token) => {
    assert.ok(url.endsWith('/api/device-link/media/presign-get'));
    assert.equal(token, 'preview-access');
    previews.push(body.key);
    return { getUrl: 'https://fixture.invalid/picture', expiresAt: new Date(Date.now()+60000).toISOString() };
  } };
  const module = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64') + '#media');
  const { Workspace } = module;
  const app = new Workspace(() => {});
  const entries = new Map();
  app.cache = { read: async k => entries.get(JSON.stringify(k)),
    write: async (k,v) => { entries.set(JSON.stringify(k),v); } };
  app.session = {id:'owner'}; app.context = {};
  app.devices = async () => { app.show({devices:[{id:'mac',title:'Mac'}]}); };
  const sent = [];
  let accepted, fail = true, drop = false, complete, delayed, release;
  app.client = { openLink: async () => {}, closeLink() {},
    async invoke(host, {channel, args}, _, opts) {
      opts.beforeDispatch(); assert.equal(host, 'mac');
      let result;
      switch (channel) {
        case 'local-db:sessions:list': result = [{id:'a',title:'A'}]; break;
        case 'local-db:sessions:get': result = {id:args[0], workingDir:'/test', title:args[0], hiddenAt:args[0]==='hidden'?1:null}; break;
        case 'maker:input:enqueue':
          sent.push(args[1]);
          if (drop) { drop = false; accepted = null; throw new Error('lost before receipt'); }
          accepted=args[1].clientId;
          if (fail) { fail = false; throw new Error('lost ACK'); } break;
        case 'maker:input:get-projection':
          result={inputDeliveryVersion:1,deliveryReceipts:accepted?[{clientId:accepted,state:'accepted'}]:(args[1]?.deliveryClientIds || []).map(clientId=>({clientId,state:'unknown'}))};break;
        default: result=[]; break;
      }
      return {ok:true,result};
    } };
  let failFile = false;
  app.native = {
    uploadFile: async (_,uri,token,transfer) => {
      if (failFile) { failFile = false; throw new Error('upload interrupted'); }
      if (delayed) { delayed(); await new Promise(r=>{release=r;}); }
      return {id:uri,name:'sample.png',path:'ref',size:12,sha256:'a'.repeat(64),mimeType:'image/png',category:'image'};
    },
    pickFile: async ()=>'image',
    dictation(ctx, update, cb) { complete=cb; update('录音中');return {cancel:()=>cb('',''),finish:()=>cb('验收','')}; }
  };
  app.show({relay:'online'}); await app.devices(); await app.openDevice('mac'); await app.openTask('a');
  app.token = async () => 'preview-access';
  const ref = 'cindy-oss-attach://m/' + Buffer.from(JSON.stringify({ossKey:'fixture-key'})).toString('base64url');
  const photo = {path:ref,mimeType:'image/png',size:200};
  assert.equal(await app.thumbnail(photo, () => false), '');
  assert.equal(await app.thumbnail({...photo,size:4*1024*1024}, () => true), '');
  await assert.rejects(app.previewUrl('/not-a-media-ref'), /电脑上打开/);
  assert.equal(previews.length, 0);
  const [first, second] = await Promise.all([app.thumbnail(photo, () => true), app.thumbnail(photo, () => true)]);
  assert.equal(first, 'https://fixture.invalid/picture'); assert.equal(second, first);
  assert.deepEqual(previews, ['fixture-key']);
  app.external({target:{owner:'other',host:'mac',task:'b'}});
  assert.equal(app.state.task,'a');
  app.notification={owner:'owner',host:'mac',task:'hidden'};
  await assert.rejects(app.openNotification(),/不可访问/); assert.equal(app.state.task,'a');
  failFile = true;
  await assert.rejects(app.addFile('image'), /interrupted/);
  assert.equal(app.state.failedFile, 'image');
  assert.equal(await app.retryFile(), true);
  assert.equal(app.state.failedFile, '');
  await app.removeFile('image');
  const entered = new Promise(r=>{delayed=r;});
  const late = app.addFile('image'); await entered;
  app.notification={owner:'owner',host:'mac',task:'outside-first-page'};
  await app.openNotification(); release(); await late; delayed=null;
  assert.equal(app.state.task,'outside-first-page'); assert.deepEqual(app.state.attachments,[]);
  assert.equal(app.localPreview(ref), '');
  app.external({share:{text:'放弃的分享',uris:[]}});app.dismissShare();
  assert.equal(app.state.draft,'');
  app.external({share:{text:'',uris:['image']}}); await app.acceptShare();
  await app.addFile('image'); assert.equal(app.state.attachments.length,1); assert.equal(sent.length,0);
  app.startVoice();app.cancelVoice();assert.equal(app.state.draft,'');
  app.startVoice();app.finishVoice();assert.equal(app.state.draft,'验收');app.editDraft('');
  // The composer previews successive partials at the original selection. Only
  // the accepted final result is added to the draft, before the file picker opens.
  let partial;
  app.native.dictation = (_, update, cb) => {
    partial = text => update('录音中', text);
    complete = cb;
    update('录音中');
    return {finish(){}, cancel(){}};
  };
  app.editDraft('左旧右');
  app.startVoice(1, 2);
  partial('第一'); partial('第二');
  assert.equal(app.state.voicePreview, '左第二右');
  assert.equal(app.state.draft, '左旧右');
  app.cancelVoice(); complete('迟到','');
  assert.equal(app.state.draft, '左旧右');
  app.startVoice(1, 2);
  const previousPicker = app.native.pickFile;
  const draftsAtPick = [];
  app.native.pickFile = async () => { draftsAtPick.push(app.state.draft); };
  const choosing = app.addFile('file');
  assert.deepEqual(draftsAtPick, []);
  complete('新','');
  assert.equal(await choosing, false);
  assert.deepEqual(draftsAtPick, ['左新右']);
  assert.equal(app.state.voiceCaret, 2);
  app.native.pickFile = previousPicker;
  app.editDraft('');
  // A late recognition after cancelling the send gesture cannot send or replace the draft.
  app.native.dictation = (_, update, cb) => {
    complete = cb;
    update('录音中');
    return {finish(){}, cancel(){}};
  };
  app.startVoice();
  const cancelled = app.finishVoiceForSend();
  app.cancelVoice(); complete('迟到的结果','');
  assert.equal(await cancelled,false); assert.equal(app.state.draft,'');
  app.startVoice();
  const finish = app.finishVoiceForSend();
  assert.equal(await app.finishVoiceForSend(),false);
  complete('确认发送','');
  assert.equal(await finish,true); assert.equal(app.state.draft,'确认发送');
  app.editDraft('');
  await assert.rejects(app.send(''),/lost ACK/);
  assert.equal(sent.length,1); assert.equal(sent[0].files.length,1); assert.equal(sent[0].chatMessage.images[0].originalName,'sample.png');
  await app.back(); await app.openTask('outside-first-page');
  assert.equal(sent.length,1); assert.deepEqual(app.state.attachments,[]);
  await app.addFile('image'); drop=true;
  await assert.rejects(app.send(''),/lost before receipt/);
  await app.removeFile('image'); app.editDraft('下一条草稿');
  await app.checkDelivery(); assert.equal(app.state.retryable,true);
  await app.retryOriginal();
  assert.equal(sent.length,3);
  assert.equal(sent[2].clientId,sent[1].clientId);
  assert.deepEqual(sent[2].files,sent[1].files);
  assert.equal(app.state.draft,'下一条草稿');
  app.editDraft('');
  let uploaded, rejected;
  app.native.uploadFile = () => new Promise((resolve, reject) => { uploaded = resolve; rejected = reject; });
  const file = {id:'wait', name:'wait.txt', path:'wait', mimeType:'text/plain'};
  async function startUpload() {
    const promise = app.addFile('file', 'file://fixture/wait.txt');
    await until(() => app.state.uploadPending);
    return { promise };
  }
  const beforeUpload = sent.length;
  const attachmentOnly = await startUpload();
  const taps = [app.send(''), app.send('')];
  app.editDraft('下一条输入');
  assert.equal(sent.length, beforeUpload);
  uploaded(file);
  await Promise.all([attachmentOnly.promise, ...taps]);
  assert.equal(sent.length, beforeUpload + 1);
  assert.deepEqual(sent.at(-1).files, [file]);
  assert.equal(app.state.draft, '下一条输入');
  app.editDraft('保留文字');
  const failed = await startUpload();
  const queued = app.send(app.state.draft);
  rejected(new Error('fixture upload failed'));
  await assert.rejects(failed.promise, /fixture upload failed/);
  await queued;
  assert.equal(app.state.failedFile, 'wait.txt');
  assert.equal(app.state.draft, '保留文字');
  const cancelledUpload = await startUpload();
  const pendingSend = app.send(app.state.draft);
  app.cancelTransfer();
  await pendingSend;
  uploaded(file);
  assert.equal(await cancelledUpload.promise, false);
  const switched = await startUpload();
  const oldSend = app.send(app.state.draft);
  await app.back();
  await app.openTask('a');
  uploaded(file);
  await Promise.all([oldSend, switched.promise]);
  assert.equal(sent.length, beforeUpload + 1);
  assert.deepEqual(app.state.attachments, []);
  app.startVoice();await app.back();complete('迟到的语音','');assert.equal(app.state.draft,'');
});
