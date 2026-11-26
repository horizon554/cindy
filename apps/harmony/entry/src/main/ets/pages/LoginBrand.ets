import { resolveLoginStage } from '../services/protocol.generated';

interface StageBox { x: number; y: number; w: number; h: number }
interface Stage { cindy: StageBox; word: StageBox; slogan: StageBox; scale: number; loginY: number }

@Component
export struct LoginBrand {
  @Prop stageWidth: number = 375;
  @Prop stageHeight: number = 740;

  private stage(): Stage { return resolveLoginStage(this.stageWidth, this.stageHeight); }

  @Builder
  asset(source: Resource, box: StageBox, scale: number) {
    Image(source).objectFit(ImageFit.Contain).width(box.w * scale).height(box.h * scale)
      .position({ x: box.x * scale, y: box.y * scale }).accessibilityLevel('no')
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      this.asset($r('app.media.login_hero'), this.stage().cindy, this.stage().scale)
      this.asset($r('app.media.login_wordmark'), this.stage().word, this.stage().scale)
      this.asset($r('app.media.login_slogan'), this.stage().slogan, this.stage().scale)
    }.width(this.stageWidth).height(this.stage().loginY * this.stage().scale).clip(true)
      .accessibilityGroup(true).accessibilityText('Cindy')
  }
}
