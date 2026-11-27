// A host-owned blob is readable only through the computer that listed it.
// Cloud identities can instead supply a public photo that survives a host disconnect.
import util from '@ohos.util';
import url from '@ohos.url';
import { BOT_AVATAR_MAX_BYTES, DEVICE_LINK_MEDIA_FETCH_CHANNEL, HomeDeviceSyncLimiter,
  deviceLinkApiBaseUrl, isManagedBotAvatarUrl, isSharedTaskMediaKey, sniffMediaMime } from './protocol.generated';
import { downloadAvatarBytes, request } from './platform';

export function publicAvatar(value, limit = 2048) {
  if (typeof value !== 'string' || value.length > limit || !value.startsWith('https://')) return '';
  try {
    const parsed = new url.URL(value);
    return parsed.hostname && !parsed.username && !parsed.password ? value : '';
  } catch { return ''; }
}

export function portraitFields(name, value) {
  const preset = ['cindy', 'dash', 'lizi'].find(id => value === 'cindy://avatar/preset/' + id);
  const glyph = typeof value === 'string' && value.length <= 16 && !/[A-Za-z0-9/:\s]/.test(value) ? value : '';
  return { avatar: glyph || Array.from(name.trim())[0] || 'C', preset,
    cloudImage: publicAvatar(value) || undefined, avatarImage: isManagedBotAvatarUrl(value) ? value : undefined };
}

function imageData(bytes) {
  if (!bytes?.length || bytes.length > BOT_AVATAR_MAX_BYTES) return '';
  const mime = sniffMediaMime(bytes);
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) return '';
  return 'data:' + mime + ';base64,' + new util.Base64Helper().encodeToStringSync(bytes);
}

export class CompanionAvatars {
  constructor(app) {
    this.app = app;
    this.pool = new HomeDeviceSyncLimiter(2);
    this.flights = new Map();
  }
  async load(row, visible) {
    for (const source of [row.avatarImage, row.cloudImage]) {
      if (!source || !visible()) continue;
      const owner = this.app.session?.id;
      const host = isManagedBotAvatarUrl(source) ? row.host : '';
      const key = [owner, host, source, 'companion-avatar'];
      const sameSource = item => item && (!host || host === item.host) && (source === item.avatarImage || source === item.cloudImage);
      const listed = exact => {
        const matches = candidate => sameSource(candidate) && (!exact || candidate.key === row.key);
        return this.app.state.companions?.some(item => matches(item) || item.faces?.some(matches)) ||
          this.app.state.cloudProfile?.members.some(matches);
      };
      const current = () => owner && this.app.session?.id === owner && this.app.companions?.avatars === this;
      const check = () => {
        if (!current() || !listed(false)) throw new Error('Avatar changed');
      };
      const identity = JSON.stringify(key);
      let flight = this.flights.get(identity);
      if (!flight) {
        const consumers = new Set([visible]);
        const promise = this.pool.run(() => [...consumers].some(onScreen => onScreen()) ? this.read(key, check) : '')
          .catch(() => '').finally(() => this.flights.delete(identity));
        flight = { consumers, promise };
        this.flights.set(identity, flight);
      } else {
        flight.consumers.add(visible);
      }
      const uri = await flight.promise;
      if (!current() || !visible() || !listed(true)) return '';
      if (uri) return uri;
    }
    return '';
  }
  async read(key, check) {
    check();
    const cached = await this.app.cache.read(key).catch(() => '');
    check();
    if (cached) return cached;
    const [, host, source] = key;
    let bytes;
    if (host) {
      const app = this.app, peer = app.home.peers.get(host);
      if (!peer || !app.available(host)) return '';
      const onPeer = () => {
        check();
        if (app.home.peers.get(host) !== peer || peer.client !== app.client || !app.available(host)) throw new Error('Avatar host changed');
      };
      const result = await app.requestHost(peer.client, host, DEVICE_LINK_MEDIA_FETCH_CHANNEL, [{ url: source, thumbnail: true, prepareOnly: false }], onPeer);
      if (!Number.isSafeInteger(result?.size) || result.size < 1 || result.size > BOT_AVATAR_MAX_BYTES || !result.mimeType?.startsWith('image/')) return '';
      if (typeof result.inlineBase64 === 'string') {
        if (result.inlineBase64.length !== 4 * Math.ceil(result.size / 3)) return '';
        bytes = new util.Base64Helper().decodeSync(result.inlineBase64);
        if (bytes.length !== result.size) return '';
      } else if (typeof result.ossKey === 'string' && result.ossKey && !isSharedTaskMediaKey(result.ossKey)) {
        const token = await app.token();
        onPeer();
        const signed = await request(deviceLinkApiBaseUrl + '/api/device-link/media/presign-get', { key: result.ossKey }, token);
        onPeer();
        if (!publicAvatar(signed?.getUrl, 16384)) return '';
        bytes = await downloadAvatarBytes(signed.getUrl);
        onPeer();
      }
    } else if (publicAvatar(source)) {
      bytes = await downloadAvatarBytes(source);
    }
    check();
    const data = imageData(bytes);
    if (data) await this.app.cache.write(key, data).catch(() => {});
    check();
    return data;
  }
}
