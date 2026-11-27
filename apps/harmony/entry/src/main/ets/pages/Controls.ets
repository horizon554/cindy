import { ModelBrandIcon } from './ModelBrandIcon';
import { PickerBrand } from '../services/modelBrand';

@Component
struct FilterReminderDot {
  build() {
    Circle().width(6).height(6).fill($r('app.color.running')).accessibilityLevel('no')
  }
}

@Component
export struct PillAction {
  @Prop label: ResourceStr = '';
  @Prop prominent: boolean = false;
  @Prop available: boolean = true;
  onTap: () => void = () => {};

  build() {
    Button(this.label, { type: ButtonType.Capsule }).fontSize(15).fontWeight(FontWeight.Medium)
      .fontColor(this.prominent ? $r('app.color.on_action') : $r('app.color.ink'))
      .backgroundColor(this.prominent ? $r('app.color.action') : $r('app.color.chip'))
      .constraintSize({ minHeight: 44 }).enabled(this.available).onClick(this.onTap)
  }
}

@Component
export struct IconAction {
  @Prop icon: Resource = $r('sys.symbol.plus');
  @Prop label: Resource = $r('app.string.add_file');
  @Prop controlId: string = '';
  @Prop reminder: string = '';
  @Prop prominent: boolean = false;
  @Prop available: boolean = true;
  menuItems: MenuElement[] = [];
  onTap: () => void = () => {};

  @Builder
  glyph() {
    Stack({ alignContent: Alignment.Center }) {
      SymbolGlyph(this.icon).fontSize(20).fontColor([this.prominent ? $r('app.color.on_action') : $r('app.color.ink')])
      if (this.reminder) {
        FilterReminderDot().position({ x: 19, y: 0 })
      }
    }.width(24).height(24).accessibilityLevel('no-hide-descendants')
  }

  build() {
    if (this.menuItems.length) {
      Button({ type: ButtonType.Circle }) { this.glyph() }
        .width(44).height(44).backgroundColor(Color.Transparent).id(this.controlId)
        .accessibilityText(this.label).enabled(this.available).bindMenu(this.menuItems)
    } else {
      Button({ type: ButtonType.Circle }) { this.glyph() }
        .width(44).height(44).backgroundColor(this.prominent ? $r('app.color.action') : Color.Transparent)
        .id(this.controlId).accessibilityText(this.label).accessibilityDescription(this.reminder).enabled(this.available).onClick(this.onTap)
    }
  }
}

@Component
export struct DirectoryRow {
  @Prop title: string = '';
  @Prop subtitle: string = '';
  @Prop running: boolean = false;
  @Prop offline: boolean = false;
  @Prop computer: boolean = false;
  @Prop available: boolean = true;
  targetId: string = '';
  open: () => void = () => {};

  build() {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 12 }) {
        if (this.computer) {
          SymbolGlyph($r('sys.symbol.desktop')).fontSize(21).fontColor([$r('app.color.muted')]).accessibilityLevel('no')
        }
        Column({ space: 2 }) {
          Text(this.title).fontSize(16).lineHeight(22).fontColor($r('app.color.ink')).maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
          if (this.subtitle) { Text(this.subtitle).fontSize(13).lineHeight(18).fontColor($r('app.color.muted')).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }) }
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        if (this.running) { LoadingProgress().width(14).height(14).color($r('app.color.running')).accessibilityText($r('app.string.working')) }
        if (this.offline) { Text($r('app.string.offline')).fontSize(13).fontColor($r('app.color.muted')) }
        SymbolGlyph($r('sys.symbol.chevron_right')).fontSize(14).fontColor([$r('app.color.faint')]).accessibilityLevel('no')
      }.width('100%').padding({ left: 14, right: 12, top: 12, bottom: 12 })
    }.id(this.targetId).width('100%').constraintSize({ minHeight: 52 }).borderRadius(12)
      .backgroundColor($r('app.color.panel')).enabled(this.available).onClick(this.open)
  }
}

@Component
export struct OptionRow {
  @Prop label: ResourceStr = '';
  @Prop value: ResourceStr = '';
  @Prop showReminder: boolean = false;
  control: string = '';
  action: () => void = () => {};

  build() {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 12 }) {
        Text(this.label).fontSize(15).fontColor($r('app.color.ink'))
        Blank()
        Text(this.value).fontSize(14).fontColor($r('app.color.muted')).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).constraintSize({ maxWidth: '60%' })
        if (this.showReminder) { FilterReminderDot() }
        SymbolGlyph($r('sys.symbol.chevron_right')).fontSize(12).fontColor([$r('app.color.faint')])
      }.width('100%').padding({ left: 12, right: 12 })
    }.id(this.control).height(48).width('100%').borderRadius(8).backgroundColor($r('app.color.panel')).onClick(this.action)
  }
}

@Component
export struct ChoiceRow {
  @Prop label: ResourceStr = '';
  @Prop detail: string = '';
  @Prop showReminder: boolean = false;
  @Prop brand?: PickerBrand = undefined;
  @Prop description: string = '';
  @Prop group: string = '';
  @Prop control: string = '';
  @Prop selected: boolean = false;
  @Prop multi: boolean = false;
  @Prop available: boolean = true;
  action: () => void = () => {};

  private accessibleLabel(): string {
    return typeof this.label === 'string' ? this.label :
      this.getUIContext().getHostContext()?.resourceManager.getStringSync(this.label.id) || '';
  }

  build() {
    Row() {
      Row({ space: 8 }) {
        if (this.brand) { ModelBrandIcon({ brand: this.brand, control: this.control }) }
        Column({ space: 2 }) {
          Text(this.label).fontSize(15).fontColor($r('app.color.ink'))
          if (this.detail) { Text(this.detail).fontSize(13).fontColor($r('app.color.muted')) }
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        if (this.showReminder) { FilterReminderDot() }
      }.layoutWeight(1).constraintSize({ minHeight: 48 }).padding({ left: 12, top: 6, bottom: 6 })
        .accessibilityLevel('no-hide-descendants').onClick(this.action)
      if (this.multi) {
        Checkbox({ name: this.accessibleLabel() }).select(this.selected).id(this.control)
          .width(20).height(20).margin({ left: 12, right: 12 }).responseRegion({ x: -12, y: -14, width: 44, height: 48 })
          .selectedColor($r('app.color.action')).accessibilityText(this.accessibleLabel()).accessibilityDescription(this.description || this.detail)
          .onClick(this.action)
      } else {
        Radio({ value: this.control, group: this.group }).checked(this.selected).id(this.control)
          .width(20).height(20).margin({ left: 12, right: 12 }).responseRegion({ x: -12, y: -14, width: 44, height: 48 })
          .accessibilityText(this.accessibleLabel()).accessibilityDescription(this.description || this.detail).onClick(this.action)
      }
    }.width('100%').borderRadius(8).backgroundColor($r('app.color.panel')).enabled(this.available)
  }
}

@Component
export struct PreferenceChip {
  @Prop value: string = '';
  @Prop available: boolean = true;
  control: string = '';
  open: () => void = () => {};

  build() {
    Button({ type: ButtonType.Normal }) {
      Text(this.value).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).fontSize(13).fontColor($r('app.color.ink'))
    }.id(this.control).height(44).constraintSize({ maxWidth: 140 }).padding({ left: 7, right: 7 }).borderRadius(12)
      .backgroundColor($r('app.color.chip')).enabled(this.available).accessibilityText(this.value).onClick(this.open)
  }
}
