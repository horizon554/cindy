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
  stdin: { contents: "export { Workspace } from './workspace'; export { receiveWant } from './sso';",
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
  const login = { status: 'ok', accessToken: jwt, refreshToken: 'fixture', membership: { id: 'account', displayName: 'Fixture' } };
  const host = { id: 'task', workingDir: '/fixture', title: 'Fixture task', agentKind: 'codex', model: 'fixture' };
  const rows = [{ id: 'first', sessionId: 'task', content: {text: 'existing'} }];
  const secrets = new Map();
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
              case 'maker:list-active': result = {sessions:[]}; break;
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
  await app.login('fixture','test');
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
  app = new Workspace(s => { state = s; });
  await app.init({});
  await until(() => state?.relay === 'online' && state?.devices.length);
  await app.openDevice('host');
  await app.openTask('task');
  assert.equal(refreshes,1);
  assert.equal(state.messages.at(-1).title,'finished while offline');
  assert.equal(count,1);
  await app.logout();
  assert.equal(secrets.get('session'),null);

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

// M2 regression through the page controller, replacing only native storage and
// the peer transport. A lost create reply, same-timestamp history and a racing
// dismissal previously had no Harmony coverage.
test('recover creation, reconcile pages and decisions, isolate offline drafts and revoke access', async () => {
  globalThis.harmonyPorts = { deviceIdentity: async () => 'phone', readSession: async () => null, saveSession: async () => {},
    request: async () => { throw Object.assign(new Error('directory denied'), {httpStatus:403}); } };
  const { Workspace } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64') + '#m2');
  const app = new Workspace(() => {});
  await app.init({});
  app.session = { id: 'account-one', name: '测试' };
  app.show({ account: '测试', relay: 'online', devices: [{ id: 'pc', title: '电脑' }] });
  const sessions = new Map();
  let history = [], cards = [], created = 0, enqueue = 0, stopped = 0, resumed = 0, resolved = 0;
  let loseCreation = true, loseSend = false, refuse = false, lostDecision = false;
  let holdHistory, releaseHistory;
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
        case 'maker:create-session':
          created++;
          assert.equal(id.agentKind,'pi'); assert.equal(id.model,'host-model');
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
  await assert.rejects(app.create('同一任务'), /reply lost/);
  await Promise.all([app.create('同一任务'),app.create('同一任务')]);
  const task = app.state.task;
  assert.ok(task); assert.equal(created,1); assert.equal(sessions.get(task).title,'同一任务');
  assert.equal(app.state.running,true);
  await app.control(false); await app.control(true); assert.equal(stopped,1); assert.equal(resumed,1);
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
  assert.equal(app.state.draft,'继续写的新草稿'); assert.equal(enqueue,1);

  cards = [ask]; await app.refreshCards(app.version);
  app.editAnswer('q','q1','乙',true); app.editAnswer('q','q1','甲',true);
  await assert.rejects(app.decide('q','answer'),/检查回答/);
  app.editAnswer('q','q2','中文',false);
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
  globalThis.harmonyPorts = {};
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
  app.native = {
    uploadFile: async (_,uri,token,transfer) => {
      if (delayed) { delayed(); await new Promise(r=>{release=r;}); }
      return {id:uri,name:'sample.png',path:'ref',size:12,sha256:'a'.repeat(64),mimeType:'image/png',category:'image'};
    },
    pickFile: async ()=>'image',
    dictation(ctx, update, cb) { complete=cb; update('录音中');return {cancel:()=>cb('',''),finish:()=>cb('验收','')}; }
  };
  app.show({relay:'online'}); await app.devices(); await app.openDevice('mac'); await app.openTask('a');
  app.external({target:{owner:'other',host:'mac',task:'b'}});
  assert.equal(app.state.task,'a');
  app.notification={owner:'owner',host:'mac',task:'hidden'};
  await assert.rejects(app.openNotification(),/不可访问/); assert.equal(app.state.task,'a');
  const entered = new Promise(r=>{delayed=r;});
  const late = app.addFile('image'); await entered;
  app.notification={owner:'owner',host:'mac',task:'outside-first-page'};
  await app.openNotification(); release(); await late; delayed=null;
  assert.equal(app.state.task,'outside-first-page'); assert.deepEqual(app.state.attachments,[]);
  app.external({share:{text:'放弃的分享',uris:[]}});app.dismissShare();
  assert.equal(app.state.draft,'');
  app.external({share:{text:'',uris:['image']}}); await app.acceptShare();
  await app.addFile('image'); assert.equal(app.state.attachments.length,1); assert.equal(sent.length,0);
  app.startVoice();app.cancelVoice();assert.equal(app.state.draft,'');
  app.startVoice();app.finishVoice();assert.equal(app.state.draft,'验收');app.editDraft('');
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
  app.startVoice();await app.back();complete('迟到的语音','');assert.equal(app.state.draft,'');
});
