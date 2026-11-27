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
  stdin: { contents: "export { Workspace } from './workspace'; export { receiveWant } from './sso'; export { groupHomeRows, matchingCompanions } from './homeList';",
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
          : 'export const {accountUrl,directoryUrl,relayUrl,request,downloadAvatarBytes,deviceIdentity,readSession,saveSession,createSocket}=globalThis.harmonyPorts'
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

test('restore login and delivery on relaunch, then open the bound host or cloud companion conversation', async t => {
  const jwt = 'test.' + Buffer.from(JSON.stringify({exp: Date.now()/1000 + 3600})).toString('base64url') + '.test';
  const login = { status: 'ok', accessToken: jwt, refreshToken: 'fixture', membership: { id: 'account', displayName: 'Fixture', email: 'fixture@example.invalid', avatarUrl: 'https://fixture.invalid/avatar' } };
  const host = { id: 'task', workingDir: '/fixture', title: 'Fixture task', agentKind: 'codex', model: 'fixture' };
  const rows = [{ id: 'first', sessionId: 'task', content: {text: 'existing'} }];
  const secrets = new Map();
  let homeSnapshotRace = false;
  const actor = '10000000-0000-4000-8000-000000000001', room = '08fd0aa5-94d7-4d86-ae90-7d77291d786c';
  const groupId = '30000000-0000-4000-8000-000000000003';
  const hiddenId = '40000000-0000-4000-8000-000000000004';
  const self = '50000000-0000-4000-8000-000000000005';
  const groupRoom = { id: groupId, name: 'Writer', kind: 'group', state: 'joined', created_at: '2026-01-01T00:00:00Z', head: '52' };
  let joined = true, snapshotUnavailable = false;
  const unrelatedRooms = Array.from({length: 100}, (_, i) => ({ id: '60000000-0000-4000-8000-' + String(i).padStart(12, '0'), kind: 'direct', state: 'joined' }));
  const ref = { collectionId: 'teammates', kind: 'bot', id: 'writer' };
  let canonical = 'buddy-session', cloudReads = 0, delayedCloud;
  const blobAvatar = 'cindy-media://blobs/' + 'b'.repeat(64) + '.png';
  const publicPhoto = 'https://fixture.invalid/avatar.png';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64');
  let avatarFetches = 0, publicFetches = 0, publicPhotoReady = false;
  const buddyResource = () => ({ ref, display: { title: 'Writer', preview: 'Hosted recent message', timestamp: Date.parse('2026-01-20T00:00:00Z'), avatar: { kind: 'media', value: blobAvatar, fallbackText: 'W' } }, links: [{ rel: 'conversation',
    target: { kind: 'session', sessionId: canonical } }] });
  let socket, authorizeUrl, exchanges = 0, count = 0, subscriptions = 0, refreshes = 0;
  globalThis.harmonyPorts = {
    downloadAvatarBytes: async address => {
      if ([publicPhoto + '?group', publicPhoto + '?sixth'].includes(address)) return png;
      assert.equal(address, publicPhoto); publicFetches++;
      return publicPhotoReady ? png : Buffer.from('<html>not an image</html>');
    },
    accountUrl: 'https://fixture.invalid', directoryUrl: '/devices', relayUrl: 'wss://fixture.invalid',
    deviceIdentity: async () => 'phone', saveSession: async (s,k='session') => { secrets.set(k,s); }, readSession: async (k='session') => secrets.get(k),
    async request(url, body, token) {
      if (url.endsWith('/v1/me')) return { actor: { id: self, kind: 'human' }, capabilities: { companionHome: true, conversationListStateVersion: 1 } };
      if (url.endsWith('/v1/conversation-list-state?limit=100')) return [{ conversationId: hiddenId, hidden: true, revision: 1 }];
      if (url.endsWith('/v1/conversations?limit=100')) return unrelatedRooms;
      if (url.endsWith('/v1/conversations?limit=100&after=' + unrelatedRooms.at(-1).id)) return [
        ...(joined ? [groupRoom] : []), { ...groupRoom, id: hiddenId }, { id: room, kind: 'direct', state: 'joined', head: '1' }];
      if (url.endsWith('/' + groupId + '/snapshot') && snapshotUnavailable) throw Object.assign(new Error('Offline'), { httpStatus: 503 });
      if (url.endsWith('/' + groupId + '/snapshot')) return { room: { ...groupRoom, topic: 'Topic', description: 'About the group' }, members: [
        { id: actor, kind: 'bot', name: 'Mimi', state: 'joined', groupAvatar: publicPhoto + '?group', avatar: '🐱' },
        { id: self, kind: 'human', name: 'Me', state: 'joined', role: 'owner', avatar: '🌱' },
        ...unrelatedRooms.slice(0, 4).map(({ id }, i) => ({ id, kind: 'human', name: 'Reader', state: 'joined', avatar: i === 3 ? publicPhoto + '?sixth' : null })),
        { id: hiddenId, kind: 'human', name: 'Former member', state: 'left' }], messages: [{ seq: '52', deleted: true }, { seq: '51', content: [{type:'text',text:'Latest group post'}], createdAt: '2026-02-01T00:00:00Z' }] };
      if (url.includes('/' + groupId + '/messages?')) {
        assert.equal(body, undefined);
        if (url.endsWith('&before=2')) return [{ id: 'm1', seq: '1', authorId: actor, author: { name: 'Mimi' }, content: [{ type: 'text', text: 'first' }] }];
        return Array.from({length: 100}, (_, i) => ({ id: 'm' + (101-i), seq: String(101-i), authorId: i === 0 ? self : actor,
          author: { name: i === 0 ? 'Me' : 'Global bot name' }, content: [{ type: 'text', text: 'turn ' + i }] }));
      }
      if (url.endsWith('/' + room + '/messages?limit=1')) return [{ seq:'1', content:[{type:'text', text:'Cloud transcript'}] }];
      if (url.endsWith('/v1/actors')) return [
        { id: actor, externalId: 'cloud', kind: 'bot', homeDeviceId: 'offline', name: 'Writer', avatar: publicPhoto },
        { id: room, externalId: 'writer', kind: 'bot', homeDeviceId: 'host', name: 'Writer' },
        { id: room, externalId: 'deleted', kind: 'bot', disabled: true, homeDeviceId: 'offline', name: 'Gone' },
      ];
      if (url.endsWith('/v1/conversations')) {
        assert.deepEqual(body.participants, [actor]);
        assert.equal(body.operationId, 'companion-room:' + actor);
        return { id: room };
      }
      if (url.endsWith('/v1/conversations/' + room + '/messages?limit=100')) {
        cloudReads++;
        if (delayedCloud) await delayedCloud;
        return [{ id: 'first-cloud', authorId: actor, seq: '1', content: [{ type: 'text', text: 'Cloud transcript' }] }];
      }
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
              case 'device-link:media:fetch':
                avatarFetches++;
                assert.deepEqual(args, [{ url: blobAvatar, thumbnail: true, prepareOnly: false }]);
                result = { size: png.length, mimeType: 'image/png', inlineBase64: png.toString('base64') }; break;
              case 'maker:remote-resources:manifest':
                result = {collections: [{ id: 'bot-groups', resourceKind: 'bot-group' }]}; break;
              case 'maker:remote-resources:list':
                if (args[0].collectionId === 'bot-groups') {
                  result = { items: [groupId, hiddenId, 'legacy'].map(id => ({ ref: { collectionId: 'bot-groups', kind: 'bot-group', id },
                    display: { title: 'Writer', subtitle: 'Local member', preview: 'Local recent message', timestamp: 4 }, links: [{ rel: 'member', target: {kind:'resource', ref}, label:'Writer' }] })) }; break;
                }
                assert.equal(args[0].collectionId, 'teammates');
                result = { items: [buddyResource()] }; break;
              case 'maker:remote-resources:get':
                if (args[0].ref.kind === 'bot-group') {
                  assert.equal(args[0].ref.id, 'legacy');
                  result = { ref: args[0].ref, blocks: [{ primitive: 'bot-group-chat', data: { id: 'legacy', name: 'Writer',
                    topic: 'Local topic', members: [{ botId: 'writer', name: 'Writer' }, { botId: 'other', name: 'Other', avatar: '🌿' }], messages: [{ id: 'local', sequence: 1, kind: 'message', authorKind: 'bot', authorName: 'Bot',
                      content: 'local history', createdAt: 23 }] } }] }; break;
                }
                assert.deepEqual(args[0].ref, ref);
                result = buddyResource(); break;
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
              case 'local-db:sessions:get': result = args[0] === 'task' ? host : { ...host, id: args[0], source: 'bot', status: 'active' }; break;
              case 'local-db:messages:list': result = rows.slice().reverse(); break;
              case 'device-link:unsubscribe': break;
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
  const { Workspace, receiveWant, matchingCompanions } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
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

  // Tier 1: a bot's canonical session can be outside the bounded task list.
  // Same-name hosted/cloud rows must open their own history; a rebind fences sends.
  await app.back();
  // Production companion entry, integration tier: duplicate names/host copies, hidden membership, page older and late responses.
  // The old roster only returned bots; two extra mixed rows must be independently readable.
  await app.refreshCompanions();
  assert.equal(state.companions.length, 4);
  const group = state.companions[0];
  assert.deepEqual(state.companions.map(row => row.id), [groupId, 'writer', 'legacy', 'cloud']);
  assert.deepEqual(matchingCompanions(state.companions, 'Local member', 'host').map(row => row.id), ['legacy']);
  assert.deepEqual(matchingCompanions(state.companions, 'ｍＩＭＩ', 'host').map(row => row.id), [groupId]);
  assert.equal(matchingCompanions(state.companions, 'writer', '').length, 4);
  assert.equal(state.companions.filter(row => row.id === groupId).length, 1);
  assert.ok(!state.companions.some(row => row.id === hiddenId));
  const localGroup = state.companions.find(row => row.id === 'legacy');
  // Integration: the home row used to discard both the portrait members and the last message.
  assert.equal(group.preview, 'Latest group post');
  assert.deepEqual(group.faces.slice(0, 2).map(face => face.cloudImage || face.avatar), [publicPhoto + '?group', '🌱']);
  assert.equal(await app.companionAvatar(group.faces[0], () => true), 'data:image/png;base64,' + png.toString('base64'));
  assert.equal(localGroup.faces[0].avatarImage, blobAvatar);
  assert.equal(localGroup.preview, 'Local recent message');
  assert.equal(state.companions.find(row => row.actor === actor).preview, 'Cloud transcript');
  assert.equal(state.companions.find(row => row.id === 'writer').preview, 'Hosted recent message');
  await app.openCompanion(localGroup.key);
  assert.equal(state.cloudMessages[0].title, 'local history');
  assert.equal(state.cloudProfile.topic, 'Local topic');
  assert.deepEqual(state.cloudProfile.members.map(member => member.title), ['Writer', 'Other']);
  assert.equal(state.cloudProfile.members[0].avatarImage, blobAvatar);
  assert.equal(state.cloudProfile.members[1].avatar, '🌿');
  app.closeCloudCompanion();
  await app.openCompanion(group.key);
  // The composite portrait shows five people. The profile must include every joined identity,
  // even when display names repeat, and allow its visible sixth member's photo.
  assert.equal(group.faces.length, 5);
  assert.equal(state.cloudProfile.topic, 'Topic');
  assert.equal(state.cloudProfile.description, 'About the group');
  assert.deepEqual(state.cloudProfile.members.map(m => m.title), ['Mimi', 'Me', 'Reader', 'Reader', 'Reader', 'Reader']);
  assert.equal(new Set(state.cloudProfile.members.map(m => m.key)).size, 6);
  assert.equal(state.cloudProfile.members[1].role, 'owner');
  const sixth = state.cloudProfile.members[5];
  assert.equal(await app.companionAvatar(sixth, () => true), 'data:image/png;base64,' + png.toString('base64'));
  assert.equal(state.cloudMessages.length, 100);
  assert.equal(state.cloudMessages.at(-1).role, 'user');
  assert.equal(state.cloudMessages[0].author, 'Mimi');
  await app.cloudHistory(true);
  assert.equal(state.cloudMessages[0].title, 'first');
  assert.equal(state.cloudOlder, false);
  groupRoom.revision = 2;
  snapshotUnavailable = true;
  await app.refreshCompanions();
  assert.equal(state.cloudCompanion.key, group.key);
  assert.equal(state.cloudProfile, undefined);
  assert.equal(await app.companionAvatar(sixth, () => true), '');
  snapshotUnavailable = false;
  await app.retryGroupProfile();
  assert.equal(state.cloudProfile.members.length, 6);
  joined = false;
  await app.refreshCompanions();
  assert.equal(state.cloudCompanion, undefined);
  assert.deepEqual(state.cloudMessages, []);
  assert.ok(!state.companions.some(row => row.id === groupId));
  assert.equal(state.cloudProfile, undefined);
  assert.equal(await app.companionAvatar(sixth, () => true), '');
  assert.equal(await app.companionAvatar(group.faces[0], () => true), '');
  const hosted = state.companions.find(row => row.host === 'host' && !row.group);
  const cloud = state.companions.find(row => row.actor === actor);
  assert.equal(hosted.title, cloud.title);
  // A hosted custom portrait and an offline buddy's public photo must both
  // reach the native image view. A bad CDN response must not pollute its cache.
  const visible = () => true, image = 'data:image/png;base64,' + png.toString('base64');
  assert.equal(await app.companionAvatar(hosted, () => false), '');
  assert.deepEqual(await Promise.all([app.companionAvatar(hosted, visible), app.companionAvatar(hosted, visible)]), [image, image]);
  assert.equal(await app.companionAvatar(hosted, visible), image);
  assert.equal(avatarFetches, 1);
  assert.equal(await app.companionAvatar(cloud, visible), '');
  publicPhotoReady = true;
  assert.equal(await app.companionAvatar(cloud, visible), image);
  assert.equal(await app.companionAvatar(cloud, visible), image);
  assert.equal(publicFetches, 2);
  assert.ok(!state.tasks.some(row => row.id === canonical));
  // The host stores call transcripts in metadata with an empty assistant body.
  // Exercise the actual companion entry (integration), including an empty call.
  const call = { version: 1, callId: 'call', startedAt: 1000, endedAt: 62000, turns: [], handoffs: [] };
  const callRow = { id: 'empty-call', sessionId: canonical, role: 'assistant', content: '', agentMeta: { voiceCall: call } };
  rows.push(callRow, { ...callRow, id: 'spoken-call', agentMeta: { voiceCall: { ...call,
    turns: [{ id: 'u', role: 'user', text: 'fixture question', complete: true, createdAt: 1001 },
      { id: 'a', role: 'assistant', text: 'fixture reply', complete: true, createdAt: 1002 }],
    handoffs: [{ id: 'task', inputId: 'u', state: 'accepted', text: 'fixture question' }] } } });
  // A newer voice card has an empty stored body, even when the host still lists an older text preview.
  await app.loadCompanionCall(hosted.key);
  assert.equal(state.companions.find(row => row.key === hosted.key).recentCall, true);
  await app.openCompanion(hosted.key);
  assert.deepEqual(state.messages.map(row => row.id), ['spoken-call']);
  assert.deepEqual(state.messages[0].voiceCall.lines.map(line => [line.role, line.text, line.status]), [
    ['user', 'fixture question', 'accepted'], ['assistant', 'fixture reply', undefined],
  ]);
  assert.equal(state.task, canonical);
  assert.deepEqual(state.taskCompanion, { ...hosted, recentCall: true });
  canonical = 'moved';
  await assert.rejects(app.send('should not dispatch'), /伙伴会话已变更/);
  assert.equal(count, 1);
  await app.back();
  await app.openCompanion(cloud.key);
  assert.equal(state.taskCompanion, undefined);
  assert.deepEqual(state.cloudCompanion, cloud);
  assert.equal(state.cloudMessages[0].title, 'Cloud transcript');
  assert.equal(state.task, '');
  let resumeCloud;
  delayedCloud = new Promise(resolve => { resumeCloud = resolve; });
  const refreshCloud = app.cloudHistory(false);
  await until(() => cloudReads === 2);
  app.closeCloudCompanion();
  resumeCloud();
  await refreshCloud;
  assert.deepEqual(state.cloudMessages, []);
  assert.equal(state.cloudCompanion, undefined);
  await app.logout();
  assert.deepEqual(state.companions, []);
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
  let view;
  const app = new Workspace(state => { view = state; }, true);
  await app.init({});
  app.session = { id: 'account-one', name: '测试' };
  app.show({ account: '测试', relay: 'online', devices: [{ id: 'pc', title: '电脑' }] });
  const sessions = new Map();
  let history = [], cards = [], created = 0, enqueue = 0, stopped = 0, resumed = 0, resolved = 0;
  let loseCreation = true, loseSend = false, refuse = false, lostDecision = false;
  let holdHistory, releaseHistory, legacyHost = false;
  let catalog = [];
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
          result = {providers:catalog}; break;
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
  // A whole page of empty calls still leads to the older visible conversation.
  const emptyRecord = { version: 1, callId: 'empty', startedAt: 1000, turns: [], handoffs: [] };
  history = [{ id: 'older-text', sessionId: task, role: 'user', content: 'before calls' },
    ...Array.from({ length: 40 }, (_, i) => ({ id: 'call-' + i, sessionId: task, role: 'assistant',
      content: '', agentMeta: { voiceCall: { ...emptyRecord, callId: 'call-' + i } } }))];
  await app.history(app.version);
  assert.deepEqual(view.messages, []);
  assert.equal(view.hasOlder, true);
  await app.older();
  assert.deepEqual(view.messages.map(row => row.title), ['before calls']);
  history.at(-1).agentMeta.voiceCall.turns = [{ id: 'u', role: 'user', text: 'late transcript', complete: true, createdAt: 1001 }];
  await app.history(app.version);
  assert.deepEqual(view.messages.map(row => row.id), ['older-text', 'call-39']);
  assert.equal(view.messages[1].voiceCall.lines[0].text, 'late transcript');
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

  // Two sources can offer the same model ID. Artwork follows catalog metadata
  // while selection still addresses the chosen provider/model pair.
  const provider = (id, name, models) => ({
    id, name, agents:['pi'], connected:true, routing:{pi:{}}, models:{pi:models}
  });
  catalog = [
    { ...provider('team', 'Team', [{id:'shared',name:'Example',icon:'openai'}, {id:'plain',name:'Plain'}]), logoKind:'xd' },
    provider('custom', '自建', [{id:'shared',name:'Example',icon:'future-brand'}])
  ];
  const branded = await app.preferences('model');
  const teamModel = branded.find(row => row.provider === 'team' && row.model === 'shared');
  assert.equal(teamModel.brand.kind, 'openai');
  const team = branded.filter(row => row.provider === 'team');
  assert.deepEqual(team.filter(row => row.sectionBrand).map(row => row.sectionBrand.kind), ['xd']);
  assert.equal(team.find(row => row.model === 'plain').brand.kind, 'xd');
  const custom = branded.find(row => row.provider === 'custom');
  assert.equal(custom.brand.monogram, '自');
  assert.equal(custom.brand.kind, '');
  await app.applyPreference('model', custom.id);
  assert.equal(app.state.provider, 'custom');
  assert.equal(app.state.model, 'shared');
  catalog = [];
  legacyHost = true;
  await app.configureNew();
  assert.equal(app.state.legacyPicker, true);
  await app.preferences('model'); await app.applyPreference('model','other');
  await app.preferences('permission'); await app.applyPreference('permission','plan');
  const firstFile = {id:'first-file',name:'notes.txt',path:'test-key',category:'text',mimeType:'text/plain'};
  app.native = {pickFile:async () => ['file://docs/notes.txt'],uploadFile:async () => firstFile};
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
  // Waiting to create freezes removal even if an accessibility action reaches the controller.
  app.removeUpload(app.state.pendingUploads[0].id);
  assert.equal(app.state.pendingUploads.length, 1);
  // Back opens once; upload completion while the dialog is up cannot dispatch create.
  let answer;
  const leave = app.leaveNew(() => new Promise(resolve => { answer = resolve; }));
  assert.equal(await app.leaveNew(() => assert.fail('second dialog')), false);
  finishFirst(firstFile);
  await pickingFirst;
  assert.equal(created, createdBefore);
  assert.equal(app.state.waitingToCreate, true);
  answer(false);
  assert.equal(await leave, false);
  await Promise.all(firstTaps);
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
  const originalUpload = app.native.uploadFile;
  for (const finishedBeforeDiscard of [false, true]) {
    let finish, discard;
    const prior = created;
    app.native.uploadFile = () => new Promise(resolve => { finish = resolve; });
    const picking = app.addFile('image');
    await until(() => !!finish);
    const sending = app.create('', '', '取消');
    const leaving = app.leaveNew(() => new Promise(resolve => { discard = resolve; }));
    if (finishedBeforeDiscard) { finish(firstFile); await picking; }
    discard(true);
    assert.equal(await leaving, true);
    await sending;
    if (!finishedBeforeDiscard) { finish(firstFile); await picking; }
    assert.deepEqual(app.state.attachments, []);
    assert.equal(created, prior);
    assert.equal(app.state.waitingToCreate, false);
    app.beginNew();
  }
  app.native.uploadFile = originalUpload;
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
    pickFile: async ()=>['image'],
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
  app.native.pickFile = async () => ['file://fixture/wait.txt'];
  async function startUpload() {
    const promise = app.state.failedFile ? app.retryFile() : app.addFile('file');
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
  // Tier 1: a second gallery selection while the first is in flight sees reserved slots.
  // A middle upload failure cannot send a partial message or change selection order on retry.
  const selected = [['a.png','b.png'], ['c.png','overflow.png']];
  const limits = [], calls = [];
  const existing = Array.from({length:17}, (_, i) => ({id:'existing'+i,name:'existing'+i,path:'existing'+i}));
  await app.setAttachments(existing);
  app.native.pickFile = async (_, image, slots) => { assert.ok(image); limits.push(slots); return selected.shift(); };
  // Hold actual adapter completions separately; the order of network replies is user-independent.
  const flights = new Map();
  app.native.uploadFile = (_, uri, token, active) => new Promise((resolve, reject) => {
    calls.push(uri);
    assert.ok(!flights.has(uri) && flights.size < 2);
    flights.set(uri, {
      finish() { flights.delete(uri); resolve({id:uri,name:uri,path:uri,mimeType:'image/png'}); },
      fail() { flights.delete(uri); reject(new Error('middle upload failed')); }
    });
    active.abort = () => { flights.delete(uri); reject(new Error('cancelled')); };
  });
  const firstGallery = app.addFile('image');
  await until(() => flights.size === 2);
  const nextGallery = app.addFile('image');
  await until(() => app.state.pendingUploads.length === 3);
  assert.deepEqual(limits, [3,1]);
  assert.deepEqual(calls, ['a.png','b.png']);
  assert.deepEqual(app.state.pendingUploads.map(p => [p.previewUri, p.uploading]),
    [['a.png',true], ['b.png',true], ['c.png',false]]);
  const beforeBatch = sent.length;
  const sendGallery = app.send('');
  flights.get('b.png').fail();
  await sendGallery;
  await until(() => flights.has('c.png'));
  assert.equal(app.state.failedFile, 'b.png');
  await app.send('');
  assert.equal(sent.length, beforeBatch);
  const retry = app.retryFile(app.state.pendingUploads.find(p => p.title === 'b.png').id);
  assert.equal(flights.size, 2);
  flights.get('c.png').finish();
  await until(() => calls.length === 4);
  assert.deepEqual(calls, ['a.png','b.png','c.png','b.png']);
  flights.get('b.png').finish();
  await until(() => app.state.attachments.length === 19);
  assert.deepEqual(app.state.attachments.slice(-2).map(f => f.id), ['b.png','c.png']);
  flights.get('a.png').finish();
  await Promise.all([firstGallery,nextGallery,retry]);
  assert.equal(sent.length, beforeBatch);
  assert.deepEqual(app.state.attachments.slice(-3).map(f => f.id), ['a.png','b.png','c.png']);
  await assert.rejects(app.addFile('image'), /20/);
  await app.send('');
  assert.equal(sent.length, beforeBatch + 1);
  assert.deepEqual(sent.at(-1).files.map(f => f.id), [...existing.map(f=>f.id),'a.png','b.png','c.png']);
  // Removing one in-flight item after Send cancels only its transfer and cannot dispatch a subset.
  app.native.pickFile = async () => ['a.png','removed.mp4'];
  const cancellation = app.addFile('image');
  await until(() => flights.size === 2);
  const partialSend = app.send('');
  assert.equal(app.state.pendingUploads[1].previewUri, '');
  app.removeUpload(app.state.pendingUploads[1].id);
  assert.deepEqual([...flights.keys()], ['a.png']);
  flights.get('a.png').finish();
  await Promise.all([partialSend,cancellation]);
  assert.equal(sent.length, beforeBatch + 1);
  assert.deepEqual(app.state.attachments.map(f=>f.id), ['a.png']);
  app.startVoice();await app.back();complete('迟到的语音','');assert.equal(app.state.draft,'');
});
