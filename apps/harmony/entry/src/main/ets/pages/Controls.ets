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
  @Prop prominent: boolean = false;
  @Prop available: boolean = true;
  menuItems: MenuElement[] = [];
  onTap: () => void = () => {};

  @Builder
  glyph() {
    SymbolGlyph(this.icon).fontSize(20).fontColor([this.prominent ? $r('app.color.on_action') : $r('app.color.ink')])
      .accessibilityLevel('no')
  }

  build() {
    if (this.menuItems.length) {
      Button({ type: ButtonType.Circle }) { this.glyph() }
        .width(44).height(44).backgroundColor(Color.Transparent).id(this.controlId)
        .accessibilityText(this.label).enabled(this.available).bindMenu(this.menuItems)
    } else {
      Button({ type: ButtonType.Circle }) { this.glyph() }
        .width(44).height(44).backgroundColor(this.prominent ? $r('app.color.action') : Color.Transparent)
        .id(this.controlId).accessibilityText(this.label).enabled(this.available).onClick(this.onTap)
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
  control: string = '';
  action: () => void = () => {};

  build() {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 12 }) {
        Text(this.label).fontSize(15).fontColor($r('app.color.ink'))
        Blank()
        Text(this.value).fontSize(14).fontColor($r('app.color.muted')).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).constraintSize({ maxWidth: '60%' })
        SymbolGlyph($r('sys.symbol.chevron_right')).fontSize(12).fontColor([$r('app.color.faint')])
      }.width('100%').padding({ left: 12, right: 12 })
    }.id(this.control).height(48).width('100%').borderRadius(8).backgroundColor($r('app.color.panel')).onClick(this.action)
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
