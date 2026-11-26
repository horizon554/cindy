// Tier 1. Exercise EntryAbility's production adapter with a native API substitute.
// The simulator rejects this bundle's Push Kit identity, so it cannot exercise
// the token rotation and authenticated unregister paths itself.
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test('register, rotate and unbind one device and import only granted share URIs', async () => {
  const modules = {
    '@hms.core.push.pushService': 'export default globalThis.nativeInputTest.push;',
    '@ohos.notificationManager': 'export default globalThis.nativeInputTest.notification;',
    '@hms.collaboration.systemShare': 'export default {getSharedData:async want=>({getRecords:()=>want.records})};',
    './platform': 'export const { request, readSession, saveSession }=globalThis.nativeInputTest;',
    './nativeMedia': 'export let cleanStaging,pickFile,uploadFile;',
    './dictation': 'export let dictation;',
    './sso': 'export function receiveWant(){}',
    './protocol.generated': "export const deviceLinkApiBaseUrl='https://test.invalid';export let buildLegacyAttachmentOssRef;"
  };
  const files = await build({entryPoints:[fileURLToPath(new URL('../entry/src/main/ets/services/nativeEntry.js',import.meta.url))],
    bundle:true, write:false, format:'esm', plugins:[{name:'native-input-test',setup(b) {
      b.onResolve({filter:/.*/},a=>a.path in modules?{namespace:'port',path:a.path}:null);
      b.onLoad({filter:/.*/,namespace:'port'},a=>({contents:modules[a.path]}));
    }}]});
  const store=new Map(), calls=[], rotations=[], events=[];
  let rotate, permission=false, deleted=0;
  globalThis.nativeInputTest={
    notification:{isNotificationEnabled:async()=>permission,requestEnableNotification:async()=>{}},
    push:{getToken:async()=>'one',deleteToken:async()=>{deleted++;},on:(event,obj,cb)=>{rotate=cb;}},
    readSession:async key=>store.get(key),saveSession:async(value,key)=>store.set(key,value),
    request:async(url,body,token,method)=>{
      assert.ok(url.endsWith('/push-token'));assert.equal(token,'access');
      calls.push({body,method});return method==='PUT'?{registered:true,deliveryConfigured:true}:{deleted:true};
    }
  };
  try {
    const {installInputs,launch}=await import('data:text/javascript;base64,'+Buffer.from(files.outputFiles[0].text).toString('base64'));
    const ws={session:{id:'owner'},token:async()=>'access',refreshPush:t=>rotations.push(t)};
    const ability={context:{abilityInfo:{bundleName:'org.test.cindy'}}};
    launch({},ability);installInputs(ws);ws.native.listen(e=>events.push(e));
    await assert.rejects(ws.native.enablePush(ws,'owner',true),/未开启/);assert.deepEqual(calls,[]);
    permission=true;await ws.native.enablePush(ws,'owner',true);
    rotate('two');assert.deepEqual(rotations,['two']);await ws.native.enablePush(ws,'owner',false,rotations[0]);
    assert.deepEqual(calls.map(c=>[c.method,c.body.platform,c.body.provider,c.body.token]),
      [['PUT','harmonyos','huawei','one'],['PUT','harmonyos','huawei','two']]);
    await ws.native.disablePush('owner','access');
    assert.deepEqual(calls[2],{method:'DELETE',body:{token:'two'}});assert.equal(deleted,1);
    assert.equal(await ws.native.restorePush('owner'),false);
    launch({action:'ohos.want.action.sendData',records:[
      {uri:'file://org.test.cindy/data/storage/el2/base/files/private'},
      {uri:'file://docs/Download/%2E%2E/private'},{uri:'file:///data/private'},
      {utd:'general.plain-text',content:'shared text'}, {uri:'file://org.test.sender/data/storage/el2/base/files/sample.png'}
    ]},ability);
    await Promise.resolve();await Promise.resolve();
    assert.deepEqual(events[0].share,{text:'shared text',uris:['file://org.test.sender/data/storage/el2/base/files/sample.png']});
    launch({parameters:{accountId:'owner',deepLink:'/sessions/task?deviceId=mac'}},ability);
    assert.deepEqual(events[1].target,{owner:'owner',task:'task',host:'mac'});
  } finally {delete globalThis.nativeInputTest;}
});

// Tier 1. A lost response to a completed raw PUT must reuse the same signed
// object on manual retry. The private endpoint must never receive a bearer token.
test('retry an ambiguous PUT against one private object and release staging files', async () => {
  const routes = {
    '@ohos.file.fs': 'export default globalThis.mediaTest.fs;',
    '@ohos.file.fileuri': "export default {FileUri:class {name='retry.txt'}};",
    '@ohos.file.hash': "export default {hash:async()=>'a'.repeat(64)};",
    '@ohos.util': "export default {generateRandomUUID:()=>crypto.randomUUID()};",
    '@ohos.file.picker':'export default {};','@ohos.file.photoAccessHelper':'export default {};',
    '@ohos.data.uniformTypeDescriptor':"export default {getUniformDataTypeByFilenameExtension:()=>1,getTypeDescriptor:()=>({mimeTypes:['text/plain']})};",
    '@hms.collaboration.rcp':'export default globalThis.mediaTest.rcp;',
    './protocol.generated':"export const deviceLinkApiBaseUrl='https://test.invalid';",
    './media':'export const uploadedFile=(meta,key)=>({...meta,id:key});',
    './platform':'export const request=globalThis.mediaTest.presign;'
  };
  const bundle = await build({entryPoints:[fileURLToPath(new URL('../entry/src/main/ets/services/nativeMedia.js',import.meta.url))],
    format:'esm',bundle:true,write:false,plugins:[{name:'staged-upload',setup(b) {
      b.onResolve({filter:/.*/},a=>a.path in routes?{namespace:'test',path:a.path}:null);
      b.onLoad({filter:/.*/,namespace:'test'},a=>({contents:routes[a.path]}));
    }}]});
  let presigns=0, closed=0, attempts=0;
  const copies=new Set();
  const fs={open:async()=>({fd:1}),OpenMode:{READ_ONLY:0},stat:async()=>({size:4,isFile:()=>true}),
    copyFile:async(fd,path)=>copies.add(path),close:async()=>{closed++;},accessSync:p=>copies.has(p),unlink:async p=>copies.delete(p)};
  globalThis.mediaTest={fs,presign:async(url,body,bearer)=>{
    presigns++;assert.equal(bearer,'secret');assert.equal(body.size,4);
    return {key:'object',putUrl:'https://oss.invalid/signed',expiresAt:new Date(Date.now()+60000).toISOString()};
  },rcp:{Request:class { constructor(url,method,headers,body){Object.assign(this,{url,method,headers,body});} },
    UploadFromFile:class {},createSession:()=>({close(){},async fetch(req){
      assert.equal(req.method,'PUT');assert.equal(req.url,'https://oss.invalid/signed');
      assert.deepEqual(req.headers,{'Content-Type':'text/plain','x-oss-object-acl':'private'});
      if (++attempts===1) throw new Error('lost reply');return {statusCode:200};
    }})}};
  try {
    const {uploadFile}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
    const ctx={cacheDir:'/cache'},tickets=new Map();
    const pick = files=>uploadFile(ctx,'file://docs/retry.txt',async()=>'secret',{tickets},files);
    await assert.rejects(pick([]),/lost reply/);
    const file=await pick([]);await pick([file]);
    assert.equal(presigns,1);assert.equal(attempts,2);assert.equal(closed,3);assert.equal(copies.size,0);
  } finally {delete globalThis.mediaTest;}
});
