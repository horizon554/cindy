import http from '@ohos.net.http';
import webSocket from '@ohos.net.webSocket';
import asset from '@ohos.security.asset';
import util from '@ohos.util';
import preferences from '@ohos.data.preferences';
import { authApiBaseUrl, deviceLinkApiBaseUrl } from './protocol.generated';

export const relayUrl = deviceLinkApiBaseUrl.replace(/^https:/, 'wss:') + '/api/device-link/ws';
export const accountUrl = authApiBaseUrl;
export const directoryUrl = deviceLinkApiBaseUrl + '/api/device-link/devices';

export async function request(url, body, token, method) {
  const client = http.createHttp();
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await client.request(url, {
      method: method || (body ? http.RequestMethod.POST : http.RequestMethod.GET),
      header: headers,
      extraData: body ? JSON.stringify(body) : undefined,
      connectTimeout: 12000, readTimeout: 15000,
      maxRedirects: 0, usingCache: false, maxLimit: 2 * 1024 * 1024
    });
    if (response.responseCode < 200 || response.responseCode >= 300) {
      const error = new Error('服务请求失败（HTTP ' + response.responseCode + '）');
      error.httpStatus = response.responseCode;
      throw error;
    }
    return response.result ? JSON.parse(response.result) : {};
  } finally {
    client.destroy();
  }
}

export async function readSession(key = 'cn.session') {
  const alias = new util.TextEncoder().encodeInto(key);
  try {
    const rows = await asset.query(new Map([[asset.Tag.ALIAS, alias], [asset.Tag.RETURN_TYPE, asset.ReturnType.ALL]]));
    return JSON.parse(util.TextDecoder.create('utf-8').decodeWithStream(rows[0].get(asset.Tag.SECRET)));
  } catch (error) {
    if (error.code === asset.ErrorCode.NOT_FOUND) return null;
    throw new Error('无法读取安全存储');
  }
}

export async function saveSession(value, key = 'cn.session') {
  const alias = new util.TextEncoder().encodeInto(key);
  const query = new Map([[asset.Tag.ALIAS, alias]]);
  if (!value) {
    try { await asset.remove(query); }
    catch (error) { if (error.code !== asset.ErrorCode.NOT_FOUND) throw error; }
    return;
  }
  query.set(asset.Tag.SECRET, new util.TextEncoder().encodeInto(JSON.stringify(value)));
  query.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_UNLOCKED);
  query.set(asset.Tag.CONFLICT_RESOLUTION, asset.ConflictResolution.OVERWRITE);
  await asset.add(query);
}

export async function deviceIdentity(context) {
  const prefs = await preferences.getPreferences(context, 'device');
  let id = await prefs.get('id', '');
  if (!id) {
    id = util.generateRandomUUID(true);
    await prefs.put('id', id);
    await prefs.flush();
  }
  return id;
}

export function createSocket(url, headers) {
  const socket = webSocket.createWebSocket();
  const handlers = new Map();
  const emit = (name, ...args) => (handlers.get(name) || []).forEach(fn => fn(...args));
  let closed = false;
  const finish = (code, reason) => {
    if (closed) return;
    closed = true;
    emit('close', code, reason);
  };
  socket.on('open', () => emit('open'));
  socket.on('message', (_, data) => { if (typeof data === 'string') emit('message', data); });
  socket.on('close', (_, result) => finish(result?.code, result?.reason));
  socket.on('error', () => emit('error', new Error('Relay 连接异常')));
  socket.connect(url, { header: headers }).catch(() => {
    emit('error', new Error('Relay 连接失败'));
    finish(1006, 'connection failed');
  });
  return {
    on(name, fn) { handlers.set(name, [...(handlers.get(name) || []), fn]); },
    send(data) { socket.send(data).catch(() => socket.close().catch(() => {})); },
    close() { socket.close().catch(() => {}); },
    terminate() { socket.close().catch(() => {}); }
  };
}
