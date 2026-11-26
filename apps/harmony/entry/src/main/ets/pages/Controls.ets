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
  icon: Resource = $r('sys.symbol.plus');
  @Prop label: Resource = $r('app.string.add_file');
  controlId: string = '';
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
        Text(this.title).fontSize(16).fontColor($r('app.color.ink')).layoutWeight(1).maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (this.offline) { Text($r('app.string.offline')).fontSize(13).fontColor($r('app.color.muted')) }
        SymbolGlyph($r('sys.symbol.chevron_right')).fontSize(14).fontColor([$r('app.color.faint')]).accessibilityLevel('no')
      }.width('100%').padding({ left: 14, right: 12, top: 12, bottom: 12 })
    }.id(this.targetId).width('100%').constraintSize({ minHeight: 52 }).borderRadius(12)
      .backgroundColor($r('app.color.panel')).enabled(this.available).onClick(this.open)
  }
}
