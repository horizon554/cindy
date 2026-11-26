import { UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';

import { launch, foreground } from './services/nativeEntry';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want): void { launch(want, this); }
  onNewWant(want: Want): void { launch(want, this); }

  onForeground(): void { foreground(true); }
  onBackground(): void { foreground(false); }

  onWindowStageCreate(stage: window.WindowStage): void {
    stage.loadContent('pages/Index');
  }
}
