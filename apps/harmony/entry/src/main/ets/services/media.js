import { buildLegacyAttachmentOssRef } from './protocol.generated';

export function uploadedFile(meta, key) {
  const { name, size, sha256, mimeType, ext } = meta;
  const path = buildLegacyAttachmentOssRef({ ossKey: key, mimeType, originalName: name, size, sha256 });
  const category = mimeType.startsWith('image/') ? 'image' : ext === '.pdf' ? 'pdf' :
    mimeType.startsWith('text/') ? 'text' : 'file';
  return { id: 'mobile-upload:' + key, name, size, sha256, mimeType, ext, path, category,
    originalName: name, ...(category === 'image' ? { url: path } : {}) };
}

export function messageMedia(attachments) {
  const images = [], files = [];
  for (const { name, path, size, sha256, mimeType, category, base64 } of attachments) {
    if (category === 'image') images.push({ originalName: name, ...(base64 ? { base64 } : { url: path }), mimeType, size, sha256 });
    else files.push({ name, path, size, sha256 });
  }
  return { images, files };
}

export function taskTarget(parameters) {
  const match = /^\/sessions\/([\w-]{1,128})\?deviceId=([\w-]{1,128})$/.exec(parameters?.deepLink);
  const owner = parameters?.accountId;
  return match && typeof owner === 'string' && /^[\w-]{1,128}$/.test(owner) ?
    { owner, task: match[1], host: match[2] } : null;
}
