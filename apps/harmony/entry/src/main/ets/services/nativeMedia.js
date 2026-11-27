import fs from '@ohos.file.fs';
import fileUri from '@ohos.file.fileuri';
import hash from '@ohos.file.hash';
import picker from '@ohos.file.picker';
import photo from '@ohos.file.photoAccessHelper';
import util from '@ohos.util';
import rcp from '@hms.collaboration.rcp';
import utd from '@ohos.data.uniformTypeDescriptor';
import { deviceLinkApiBaseUrl } from './protocol.generated';
import { request } from './platform';
import { uploadedFile } from './media';

const directory = ctx => ctx.cacheDir + '/attachment-staging';
export async function cleanStaging(ctx) {
  const dir = directory(ctx);
  if (!fs.accessSync(dir)) fs.mkdirSync(dir);
  for (const name of await fs.listFile(dir)) if (/^[a-f0-9-]{36}$/.test(name)) await fs.unlink(dir + '/' + name);
}

export async function pickFile(ctx, image, remaining) {
  if (image) {
    const result = await new photo.PhotoViewPicker().select({ MIMEType: photo.PhotoViewMIMETypes.IMAGE_VIDEO_TYPE, maxSelectNumber: remaining });
    return result.photoUris;
  }
  const result = await new picker.DocumentViewPicker(ctx).select({ maxSelectNumber: 1 });
  return result;
}

export async function uploadFile(ctx, uri, token, transfer, existing) {
  const path = directory(ctx) + '/' + util.generateRandomUUID(true);
  let input, session;
  const check = () => { if (transfer.cancelled) throw new Error('附件已取消'); };
  try {
    check();
    input = await fs.open(uri, fs.OpenMode.READ_ONLY);
    const stat = await fs.stat(input.fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 2147483648) throw new Error('请选择 1 字节到 2 GiB 的文件');
    await fs.copyFile(input.fd, path);
    check();
    const size = (await fs.stat(path)).size;
    if (size !== stat.size) throw new Error('文件已变更，请重新选择');
    const name = new fileUri.FileUri(uri).name.replace(/[\u0000-\u001f]/g, '').slice(0,255) || '附件';
    const ext = (/\.[a-z0-9]{1,12}$/i.exec(name)?.[0] || '').toLowerCase();
    let mimeType = 'application/octet-stream';
    if (ext) {
      try {
        const type = utd.getUniformDataTypeByFilenameExtension(ext);
        mimeType = utd.getTypeDescriptor(type)?.mimeTypes?.find(m => m.includes('/') && !m.includes('*')) || mimeType;
      } catch { /* The file picker also supports files with unregistered extensions. */ }
    }
    const sha256 = (await hash.hash(path, 'sha256')).toLowerCase();
    check();
    const cached = existing.find(f => f.name === name && f.sha256 === sha256);
    if (cached) return cached;
    const fingerprint = sha256 + '/' + name;
    let target = transfer.tickets.get(fingerprint);
    if (!target || Date.parse(target.expiresAt) <= Date.now() + 15000) {
      const access = await token(); check();
      target = await request(deviceLinkApiBaseUrl + '/api/device-link/media/presign-put',
        { size, ext: ext.slice(1) || 'bin', contentType: mimeType }, access);
      check();
      if (typeof target.key !== 'string' || !target.key || !/^https:\/\//i.test(target.putUrl) ||
          !Number.isFinite(Date.parse(target.expiresAt))) throw new Error('附件服务返回了无效地址');
      // Repeating a PUT after an ambiguous response replaces the same private object.
      if (transfer.tickets.size >= 20) transfer.tickets.delete(transfer.tickets.keys().next().value);
      transfer.tickets.set(fingerprint, target);
    }
    session = rcp.createSession();
    transfer.abort = () => session.cancel();
    const req = new rcp.Request(target.putUrl, 'PUT', { 'Content-Type': mimeType, 'x-oss-object-acl': 'private' },
      new rcp.UploadFromFile(path));
    req.configuration = { transfer: { autoRedirect: false, timeout: { connectMs: 15000, transferMs: 300000 } } };
    const reply = await session.fetch(req);
    if (reply.statusCode < 200 || reply.statusCode >= 300) {
      if (reply.statusCode === 403) transfer.tickets.delete(fingerprint);
      throw new Error('上传失败，请重新选择该文件（HTTP ' + reply.statusCode + '）');
    }
    check();
    return uploadedFile({ name, ext, size, sha256, mimeType }, target.key);
  } finally {
    transfer.abort = null;
    if (session) session.close();
    if (input) await fs.close(input);
    if (fs.accessSync(path)) await fs.unlink(path);
  }
}
