import cryptoFramework from '@ohos.security.cryptoFramework';
import util from '@ohos.util';
import url from '@ohos.url';
import { accountUrl, readSession, saveSession } from './platform';

const redirect = 'cindycn://auth';
const pendingKey = 'cn.sso.pending';
const lifetime = 10 * 60 * 1000;
let listener;
let launchCallback;

function base64url(bytes) {
  return new util.Base64Helper().encodeToStringSync(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function receiveWant(uri) {
  if (!uri || uri.length > 8192 || !/^cindycn:\/\/auth\/?\?/.test(uri)) return;
  if (listener) listener(uri);
  else launchCallback = uri;
}

export function listenForWant(fn) {
  listener = fn;
  if (launchCallback) {
    const uri = launchCallback;
    launchCallback = undefined;
    fn(uri);
  }
}

export async function pendingAuthorization(deviceId) {
  const flow = await readSession(pendingKey);
  if (!flow) return null;
  if (flow.deviceId === deviceId && flow.createdAt <= Date.now() && Date.now() - flow.createdAt <= lifetime) return flow;
  await cancelAuthorization();
  return null;
}

export function cancelAuthorization() {
  return saveSession(null, pendingKey);
}

export async function authorize(context, deviceId, connectionId) {
  const random = cryptoFramework.createRandom();
  const verifier = base64url(random.generateRandomSync(32).data);
  const state = base64url(random.generateRandomSync(32).data);
  const md = cryptoFramework.createMd('SHA256');
  md.updateSync({data: new util.TextEncoder().encodeInto(verifier)});
  const challenge = base64url(md.digestSync().data);
  const params = new url.URLParams();
  for (const [key, value] of Object.entries({
    client_type: 'mobile', device_id: deviceId, redirect_uri: redirect,
    code_challenge: challenge, code_challenge_method: 'S256', client_state: state, ui_locale: 'zh-CN'
  })) params.set(key, value);
  await saveSession({ state, verifier, deviceId, createdAt: Date.now() }, pendingKey);
  try {
    await context.startAbility({
      action: 'ohos.want.action.viewData', entities: ['entity.system.browsable'],
      uri: accountUrl + '/api/auth/sso/' + encodeURIComponent(connectionId) + '/authorize?' + params.toString()
    });
  } catch {
    await cancelAuthorization();
    throw new Error('无法打开系统浏览器');
  }
}

export async function consumeAuthorization(uri, deviceId) {
  const value = new url.URL(uri);
  if (value.protocol !== 'cindycn:' || value.host !== 'auth' || value.username || value.password ||
      value.hash || (value.pathname && value.pathname !== '/')) return null;
  const flow = await pendingAuthorization(deviceId);
  const query = value.searchParams;
  if (!flow || query.getAll('state').length !== 1 || query.get('state') !== flow.state) return null;
  await cancelAuthorization();
  if (query.has('error')) throw new Error('企业授权已取消或被拒绝');
  if (query.getAll('code').length !== 1 || !query.get('code')) throw new Error('授权回调缺少授权码');
  return { grantType: 'authorization_code', code: query.get('code'), codeVerifier: flow.verifier, deviceId };
}
