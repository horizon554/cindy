import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { brandImage, PickerBrand } from '../services/modelBrand';

@Component
export struct ModelBrandIcon {
  @Prop @Watch('resetSource') brand: PickerBrand;
  control: string = '';
  @State private source: string = '';

  private resetSource(): void { this.refresh(); }
  aboutToAppear(): void { this.refresh(); }
  onWillApplyTheme(): void { this.refresh(); }

  private refresh(useCustom: boolean = true): void {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    if (!ctx) return;
    const color = ctx.resourceManager.getColorSync($r('app.color.muted').id);
    const ink = '#' + (color >>> 0).toString(16).padStart(8, '0').slice(-6);
    const dark = ctx.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    this.source = brandImage(this.brand, ink, dark, useCustom);
  }

  build() {
    Stack() {
      if (this.source) {
        ForEach([this.source], (uri: string) => {
          Image(uri).width(18).height(18).objectFit(ImageFit.Contain).id('brand-art-' + this.control)
            .onError(() => {
              if (this.source !== uri) return;
              this.refresh(false);
              if (this.source === uri) this.source = '';
            })
        }, (uri: string) => uri)
      } else {
        Text(this.brand.monogram).fontSize(11).fontWeight(FontWeight.Medium).fontColor($r('app.color.muted'))
          .textAlign(TextAlign.Center).width(18).height(18).borderWidth(1).borderColor($r('app.color.line')).borderRadius(4)
          .id('brand-initial-' + this.control)
      }
    }.width(20).height(20).accessibilityLevel('no-hide-descendants')
  }
}
