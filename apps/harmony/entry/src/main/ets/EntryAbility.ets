import { UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';

import { launch, foreground } from './services/nativeEntry';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want): void { launch(want, this); }
  onNewWant(want: Want): void { launch(want, this); }

  onForeground(): void { foreground(true); }
  onBackground(): void { foreground(false); }

  onWindowStageCreate(stage: window.WindowStage): void {
    this.loadWindow(stage);
  }

  private async loadWindow(stage: window.WindowStage): Promise<void> {
    try { await stage.getMainWindowSync().setWindowLayoutFullScreen(true); }
    catch { /* Safe-area layout also works in a non-fullscreen window. */ }
    await stage.loadContent('pages/Index');
  }
}
