import { common } from '@kit.AbilityKit';
import { UIContext } from '@kit.ArkUI';
import { image } from '@kit.ImageKit';
import fs from '@ohos.file.fs';
import fileUri from '@ohos.file.fileuri';
import util from '@ohos.util';
import systemShare from '@hms.collaboration.systemShare';

// Only the message body is captured. Share targets receive a temporary system file grant.
export async function shareMessageImage(ui: UIContext, control: string): Promise<void> {
  const context = ui.getHostContext() as common.UIAbilityContext;
  const pixels = await ui.getComponentSnapshot().get(control);
  const packer = image.createImagePacker();
  const path = context.cacheDir + '/attachment-staging/' + util.generateRandomUUID(true);
  try {
    const file = await fs.open(path, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY);
    try { await packer.packToFile(pixels, file.fd, { format: 'image/png', quality: 100 }); }
    finally { await fs.close(file); }
  } finally { await packer.release(); await pixels.release(); }
  const data = new systemShare.SharedData({ utd: 'general.png', uri: fileUri.getUriFromPath(path), title: 'Cindy' });
  await new systemShare.ShareController(data).show(context, {});
}
