import { pasteboard } from '@kit.BasicServicesKit';
import { common } from '@kit.AbilityKit';
import systemShare from '@hms.collaboration.systemShare';
import { Row as Message, UsagePart } from '../services/workspace';

@Component
export struct MessageFooter {
  @Prop row: Message = { id: '', title: '' };
  @Prop task: string = '';
  @Prop companion: boolean = false;
  @Prop editing: boolean = false;
  link: (task: string, id: string) => string = () => '';
  addLink: (value: string) => void = () => {};
  edit: (task: string, id: string) => void = () => {};
  fork: (task: string, id: string) => void = () => {};
  @State private now: number = Date.now();
  private timer: number = -1;

  private updateClock(visible: boolean): void {
    clearInterval(this.timer);
    if (!visible) return;
    this.now = Date.now();
    if (this.now - Date.parse(this.row.createdAt || '') < 86400000) {
      this.timer = setInterval(() => { this.now = Date.now(); }, 60000);
    }
  }

  aboutToDisappear(): void { clearInterval(this.timer); }

  private timeLabel(): ResourceStr {
    const date = new Date(this.row.createdAt || '');
    const time = date.getTime();
    if (!Number.isFinite(time)) return '';
    const minutes = Math.max(0, Math.floor((this.now - time) / 60000));
    if (minutes === 0) return $r('app.string.message_now');
    if (minutes < 60) return $r('app.string.message_minutes', minutes);
    if (minutes < 1440) return $r('app.string.message_hours', Math.floor(minutes / 60));
    const day = [date.getMonth() + 1, date.getDate()].map((n: number) => String(n).padStart(2, '0')).join('-');
    const clock = [date.getHours(), date.getMinutes()].map((n: number) => String(n).padStart(2, '0')).join(':');
    return (date.getFullYear() === new Date(this.now).getFullYear() ? '' : date.getFullYear() + '-') + day + ' ' + clock;
  }

  private text(): string {
    const body = this.row.messageText ?? this.row.title;
    const files = this.row.media?.map(file => file.name).filter((name: string) => !!name) || [];
    return [body, ...files].filter((part: string) => !!part).join('\n');
  }

  private usageLabel(): string {
    const resources = this.getUIContext().getHostContext()?.resourceManager;
    return (this.row.usage || []).map((part: UsagePart) => part.estimated && resources ?
      resources.getStringSync($r('app.string.message_value').id, part.value) : part.value).join(' + ');
  }

  private async copy(value: string): Promise<void> {
    if (!value) return;
    try {
      await pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, value));
      this.getUIContext().getPromptAction().showToast({ message: $r('app.string.copied') });
    } catch { this.getUIContext().getPromptAction().showToast({ message: $r('app.string.copy_failed') }); }
  }

  private async share(): Promise<void> {
    try {
      const data = new systemShare.SharedData({ utd: 'general.plain-text', content: this.text() });
      await new systemShare.ShareController(data).show(this.getUIContext().getHostContext() as common.UIAbilityContext, {});
    } catch { this.getUIContext().getPromptAction().showToast({ message: $r('app.string.message_share_error') }); }
  }

  private confirmFork(): void {
    const task = this.task;
    const id = this.row.id;
    this.getUIContext().showAlertDialog({ message: $r('app.string.message_fork_prompt'),
      primaryButton: { value: $r('app.string.cancel'), action: () => {} },
      secondaryButton: { value: $r('app.string.message_fork'), action: () => this.fork(task, id) } });
  }

  @Builder
  time() {
    if (this.row.createdAt && Number.isFinite(Date.parse(this.row.createdAt))) {
      Text(this.timeLabel()).id('message-time').fontSize(12).maxLines(1).fontColor($r('app.color.muted'))
        .accessibilityDescription(new Date(this.row.createdAt).toLocaleString())
    }
  }

  @Builder
  icon(image: Resource, label: Resource, id: string, click: () => void) {
    Button({ type: ButtonType.Circle }) {
      Image(image).width(17).height(17).fillColor($r('app.color.muted')).accessibilityLevel('no')
    }.id(id).width(44).height(44).padding(0).backgroundColor(Color.Transparent).accessibilityText(label).onClick(click)
  }

  @Builder
  menu() {
    Menu() {
      if (this.row.editPlacement === 'menu' && !this.editing) {
        MenuItem({ content: $r('app.string.message_edit') }).id('message-edit-menu')
          .onClick(() => this.edit(this.task, this.row.id))
      }
      if (this.row.clientId && this.task) {
        MenuItem({ content: $r('app.string.message_link') }).onClick(() => this.copy(this.link(this.task, this.row.id)))
        MenuItem({ content: $r('app.string.message_add_link') }).onClick(() => {
          const href = this.link(this.task, this.row.id);
          if (href) this.addLink(href);
        })
      }
      if (this.row.createdAt && Number.isFinite(Date.parse(this.row.createdAt))) {
        MenuItem({ content: new Date(this.row.createdAt).toLocaleString() }).enabled(false)
      }
    }
  }

  build() {
    Flex({ direction: FlexDirection.Row, wrap: FlexWrap.Wrap,
      justifyContent: this.row.role === 'user' ? FlexAlign.End : FlexAlign.Start, alignItems: ItemAlign.Center }) {
      if (this.row.role === 'user') { this.time() }
      this.icon($r('app.media.message_copy'), $r('app.string.message_copy'), 'message-copy', () => this.copy(this.text()))
      this.icon($r('app.media.message_share'), $r('app.string.message_share'), 'message-share', () => this.share())
      if (this.row.forkable && !this.companion) {
        this.icon($r('app.media.message_fork'), $r('app.string.message_fork'), 'message-fork', () => this.confirmFork())
      }
      if (this.row.editPlacement === 'inline') {
        this.icon($r('app.media.message_edit'), $r('app.string.message_edit'), 'message-edit', () => this.edit(this.task, this.row.id))
      }
      if ((this.row.clientId && this.task) || this.row.createdAt) {
        Button({ type: ButtonType.Circle }) {
          Image($r('app.media.message_more')).width(17).height(17).fillColor($r('app.color.muted')).accessibilityLevel('no')
        }.id('message-more').width(44).height(44).padding(0).backgroundColor(Color.Transparent)
          .accessibilityText($r('app.string.more_actions')).bindMenu(this.menu)
      }
      if (this.row.role !== 'user') { this.time() }
      if (!this.companion && this.row.usage) {
        Text(this.usageLabel()).id('message-usage')
          .fontSize(12).fontColor($r('app.color.muted')).margin({ left: 4 })
      }
    }.id('message-actions-' + this.row.id).width('100%')
      .onVisibleAreaChange([0], (visible: boolean, ratio: number) => this.updateClock(visible && ratio > 0))
  }
}
