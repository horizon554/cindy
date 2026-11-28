import { pasteboard } from '@kit.BasicServicesKit';

@Component
export struct MessageActionGlyph {
  @Prop icon: Resource;
  @Prop subdued: boolean = false;

  build() {
    Stack() {
      Image(this.icon).width('100%').height('100%')
      Rect().width('100%').height('100%').fill(this.subdued ? $r('app.color.faint') : $r('app.color.muted')).blendMode(BlendMode.SRC_IN)
    }.width(14).height(14).blendMode(BlendMode.SRC_OVER, BlendApplyType.OFFSCREEN).accessibilityLevel('no')
  }
}

// A disabled native Button dims its entire subtree. Draw the tertiary glyph beside it
// so group actions keep the same contrast while accessibility still exposes a disabled button.
@Component
struct DisabledGroupMessageAction {
  @Prop icon: Resource;
  @Prop label: Resource;
  @Prop own: boolean = false;
  @Prop controlId: string = '';

  build() {
    Stack({ alignContent: this.own ? Alignment.TopEnd : Alignment.TopStart }) {
      Button({ type: ButtonType.Normal }) {}
        .width(44).height(44).padding(0).backgroundColor(Color.Transparent)
        .enabled(false).id(this.controlId).accessibilityText(this.label)
      MessageActionGlyph({ icon: this.icon, subdued: true })
        .margin({ top: 8 }).hitTestBehavior(HitTestMode.None).accessibilityLevel('no-hide-descendants')
    }.width(44).height(44)
  }
}

@Component
export struct MessageCopyButton {
  @Prop text: string = '';
  @Prop group: boolean = false;
  @Prop own: boolean = false;
  @Prop controlId: string = 'message-copy';
  @State private copied: boolean = false;
  private copying: boolean = false;
  private resetTimer: number = -1;
  private active: boolean = true;

  aboutToDisappear(): void { this.active = false; clearTimeout(this.resetTimer); }
  aboutToAppear(): void { this.active = true; }

  private async copy(): Promise<void> {
    if (this.copying || !this.text) return;
    this.copying = true;
    try {
      await pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, this.text));
      if (this.active) {
        this.copied = true;
        clearTimeout(this.resetTimer);
        this.resetTimer = setTimeout(() => { this.copied = false; }, 1500);
      }
    } catch {
      if (this.active) this.getUIContext().getPromptAction().showToast({ message: $r('app.string.copy_failed') });
    } finally { this.copying = false; }
  }

  build() {
    Button({ type: ButtonType.Normal }) {
      if (this.copied) { MessageActionGlyph({ icon: $r('app.media.message_copied') }) }
      else { MessageActionGlyph({ icon: $r('app.media.message_copy') }) }
    }.width(44).height(44).padding({ top: this.group ? 8 : 0 }).borderRadius(22)
      .align(this.group ? (this.own ? Alignment.TopEnd : Alignment.TopStart) : Alignment.Center).backgroundColor(Color.Transparent)
      .enabled(!!this.text).id(this.controlId)
      .accessibilityText(this.copied ? $r('app.string.copied') : $r('app.string.message_copy')).onClick(() => this.copy())
  }
}

@Component
export struct CompanionMessageActions {
  @Prop group: boolean = false;
  @Prop own: boolean = false;
  @Prop text: string = '';
  @Prop showReply: boolean = false;
  @Prop replyEnabled: boolean = true;
  @Prop showMore: boolean = true;
  @Prop messageId: string = '';
  reply: () => void = () => {};
  @BuilderParam menu: () => void;

  @Styles
  hitTarget() {
    .width(44).height(44).padding({ top: this.group ? 8 : 0 })
    .align(this.group ? (this.own ? Alignment.TopEnd : Alignment.TopStart) : Alignment.Center)
    .backgroundColor(Color.Transparent)
  }

  build() {
    Row() {
      if (this.group && !this.text) {
        DisabledGroupMessageAction({ icon: $r('app.media.message_copy'), label: $r('app.string.message_copy'),
          own: this.own, controlId: 'room-copy-' + this.messageId })
      } else if (this.text) {
        MessageCopyButton({ group: this.group, own: this.own, text: this.text,
          controlId: this.group ? 'room-copy-' + this.messageId : 'message-copy' })
      }
      if (this.showReply && this.group && !this.replyEnabled) {
        DisabledGroupMessageAction({ icon: $r('app.media.message_reply'), label: $r('app.string.room_reply'),
          own: this.own, controlId: 'room-quote-' + this.messageId })
      } else if (this.showReply) {
        Button({ type: ButtonType.Normal }) { MessageActionGlyph({ icon: $r('app.media.message_reply') }) }
          .hitTarget().id(this.group ? 'room-quote-' + this.messageId : 'companion-message-reply')
          .accessibilityText($r('app.string.room_reply')).onClick(this.reply)
      }
      if (this.showMore) {
        Button({ type: ButtonType.Normal }) { MessageActionGlyph({ icon: $r('app.media.message_more') }) }
          .hitTarget().id(this.group ? 'room-more-' + this.messageId : 'message-more')
          .accessibilityText($r('app.string.more_actions')).bindMenu(this.menu)
      }
    }.offset({ x: this.group ? 0 : (this.own ? 2 : -15) })
  }
}
