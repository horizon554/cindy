import { CompanionMessageActions } from './CompanionMessageActions';
import { CompanionAvatar, companionPortraitKey } from './CompanionAvatar';
import { IconAction, PillAction } from './Controls';
import { HistorySource } from './HistorySource';
import { MessageBody } from './TaskContent';
import { shareMessageImage } from './ShareMessage';
import { Workspace, Companion, Row as Item, GroupProfile, GroupMember, Attachment, MediaInfo, RoomPending, TrackedMention } from '../services/workspace';

@Component
struct RoomAttachment {
  file: MediaInfo = { name: '' };
  load: (visible: () => boolean) => Promise<string> = async () => '';
  open: () => void = () => {};
  @State private source: string = '';
  private revision: number = 0;
  private setOnScreen(visible: boolean): void {
    const revision = ++this.revision;
    if (!visible || this.source || !(this.file.mimeType?.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|heic|avif)$/i.test(this.file.name))) return;
    const current = (): boolean => revision === this.revision;
    this.load(current).then((uri: string) => { if (current()) this.source = uri; });
  }
  aboutToDisappear(): void { this.revision++; }
  build() {
    Button() {
      if (this.source) {
        Image(this.source).width(168).height(128).objectFit(ImageFit.Contain).onError(() => { this.source = ''; })
      } else {
        Text('📎 ' + this.file.name).maxLines(2).fontSize(14).fontColor($r('app.color.ink'))
      }
    }.type(ButtonType.Normal).padding(8).borderRadius(10).backgroundColor($r('app.color.chip'))
      .accessibilityText(this.file.name).onClick(this.open)
      .onVisibleAreaChange([0], (visible: boolean, ratio: number) => this.setOnScreen(visible && ratio > 0))
  }
}

@Component
export struct RoomConversation {
  workspace?: Workspace;
  @Prop buddy: Companion;
  @Prop @Watch('rowsChanged') rows: Item[] = [];
  @Prop profile: GroupProfile | undefined = undefined;
  @Prop root: Item | undefined = undefined;
  @Prop @Watch('restorePending') pending: RoomPending | undefined = undefined;
  @Prop more: boolean = false;
  @Prop loading: boolean = false;
  @Prop failed: boolean = false;
  @Prop move: string = '';
  @Prop target: string = '';
  @Prop homeName: string = '';
  @Prop connected: boolean = true;
  preview: (file: MediaInfo) => void = () => {};
  openLink: (url: string) => void = () => {};
  @State private text: string = '';
  @State private tracked: TrackedMention[] = [];
  @State private files: Attachment[] = [];
  @State private quote: string = '';
  @State private choosing: boolean = false;
  @State private targets: Item[] = [];
  @State private pickingHost: boolean = false;
  @State private busy: boolean = false;
  @State private error: string = '';
  private active: boolean = true;
  private scroll: Scroller = new Scroller();
  private history: HistorySource = new HistorySource();
  private restoringSend: boolean = false;
  private lastId: string = '';
  private following: boolean = true;
  private rowsChanged(): void {
    this.history.replace(this.rows);
    const firstLoad = !this.lastId;
    const last = this.rows[this.rows.length - 1]?.id || '';
    if (last && last !== this.lastId && (!this.lastId || this.following)) {
      setTimeout(() => { if (this.active && (firstLoad || this.following)) this.scroll.scrollEdge(Edge.Bottom); }, 16);
    }
    this.lastId = last;
  }
  private remember(): void {
    this.workspace?.saveRoomDraft(this.buddy.key, this.root?.id || '', { text: this.text, tracked: this.tracked, mentionIds: [], files: this.files, quoteId: this.quote });
  }
  private focusInput(): void { this.getUIContext().getFocusController().requestFocus('room-input'); }
  private restorePending(): void {
    if (!this.pending && this.restoringSend) { this.text = ''; this.tracked = []; this.files = []; this.quote = ''; }
    this.restoringSend = !!this.pending?.signature;
    if (this.pending) {
      this.text = this.pending.text; this.tracked = this.pending.tracked || []; this.files = this.pending.files; this.quote = this.pending.quoteId;
    }
  }
  aboutToAppear(): void { this.active = true; this.restorePending(); this.rowsChanged(); }
  aboutToDisappear(): void { this.active = false; }
  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.error = '';
    try { await action(); } catch (e) { if (this.active) this.error = (e as Error).message; }
    finally { if (this.active) this.busy = false; }
  }
  private taskState(state: string): ResourceStr {
    switch (state) {
      case 'started': return $r('app.string.room_task_started');
      case 'waiting': return $r('app.string.room_task_waiting');
      case 'completed': return $r('app.string.room_task_completed');
      case 'failed': return $r('app.string.room_task_failed');
      case 'cancelled': return $r('app.string.room_task_cancelled');
      case 'timed-out': return $r('app.string.room_task_timeout');
      default: return state;
    }
  }
  private member(row: Item): Companion {
    return this.buddy.group ? this.profile?.members.find((m: GroupMember) => m.id === row.authorId) ||
      { key: row.authorId || row.id, id: row.authorId || '', host: this.buddy.host, title: row.author || '', avatar: row.author?.slice(0, 1) || '·' } : this.buddy;
  }
  private locate(id: string): void {
    const index = this.rows.findIndex((r: Item) => r.id === id);
    if (index >= 0) this.scroll.scrollToIndex(index + 1, true, ScrollAlign.CENTER);
    else this.getUIContext().getPromptAction().showToast({ message: $r('app.string.room_quote_outside') });
  }
  private async pick(images: boolean): Promise<void> {
    const file = await this.workspace!.pickRoomFile(images);
    if (this.active && file && !this.files.some((f: Attachment) => f.id === file.id)) { this.files = [...this.files, file]; this.remember(); }
  }
  private async send(): Promise<void> {
    const mentions = this.pending?.signature ? this.pending.mentionIds : this.workspace!.roomMentionIds(this.text, this.tracked);
    await this.workspace!.sendRoom(this.text, mentions, this.files, this.quote);
    if (this.active) { this.text = ''; this.tracked = []; this.files = []; this.quote = ''; this.choosing = false; this.remember(); this.following = true; this.scroll.scrollEdge(Edge.Bottom); }
  }
  private async chooseTarget(): Promise<void> {
    const devices = await this.workspace!.roomTargets();
    if (this.active) { this.targets = devices; this.pickingHost = true; }
  }
  private confirmMove(host: Item): void {
    this.pickingHost = false;
    this.getUIContext().showAlertDialog({ message: $r('app.string.room_move_confirm', host.title),
      primaryButton: { value: $r('app.string.cancel'), action: () => {} },
      secondaryButton: { value: $r('app.string.room_move'), action: () => this.run(() => this.workspace!.moveRoom(host.id, false)) } });
  }
  @Builder
  hostSheet() {
    Column() {
      Text($r('app.string.room_move')).fontSize(18).fontColor($r('app.color.ink')).padding(12)
      if (!this.targets.length) { Text($r('app.string.room_no_hosts')).fontColor($r('app.color.muted')).padding(12) }
      List() {
        ForEach(this.targets, (host: Item) => {
          ListItem() { Button(host.title).width('100%').fontColor($r('app.color.ink')).backgroundColor(Color.Transparent).onClick(() => this.confirmMove(host)) }
        }, (host: Item) => host.id)
      }.layoutWeight(1)
    }.width('100%').height('100%').padding(16)
  }
  @Builder
  rowMenu(row: Item) {
    Menu() {
      if (row.createdAt && Number.isFinite(Date.parse(row.createdAt))) {
        MenuItem({ content: new Date(row.createdAt).toLocaleString() }).id('room-message-time').enabled(false)
      }
      if (!this.root && !this.buddy.host) {
        MenuItem({ content: row.replyCount ? $r('app.string.room_topic_open') : $r('app.string.room_topic_create') }).id('room-topic').onClick(() => this.run(() => this.workspace!.openRoomThread(row.id)))
      }
      if (!this.buddy.host) {
        MenuItem({ content: $r('app.string.room_share_image') }).id('room-share-image').onClick(() => this.run(() => shareMessageImage(this.getUIContext(), 'room-body-' + row.id)))
      }
    }
  }
  @Builder
  body(row: Item) {
    Column({ space: 5 }) {
      if (this.buddy.group && row.author && row.role !== 'user' && !row.continued) {
        Text(row.author).fontSize(14).fontColor($r('app.color.muted'))
      }
      if (row.quote) {
        Text([row.quote.authorName, row.quote.excerpt].filter((s: string) => !!s).join(' · ')).maxLines(2)
          .fontSize(14).padding({ left: 8 }).borderWidth({ left: 2 }).borderColor($r('app.color.line')).fontColor($r('app.color.muted'))
          .onClick(() => this.locate(row.quote?.messageId || ''))
      }
      if (row.title) { MessageBody({ value: row.title, fitContent: row.role === 'user', openLink: this.openLink }) }
      if (row.taskCard) {
        Column({ space: 4 }) {
          Text(row.taskCard.title).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink'))
          Text(this.taskState(row.taskCard.state)).fontSize(13).fontColor($r('app.color.muted'))
          if (row.taskCard.summary) { Text(row.taskCard.summary).fontSize(14).fontColor($r('app.color.ink')) }
        }.alignItems(HorizontalAlign.Start).padding(12).backgroundColor($r('app.color.chip')).borderRadius(12)
      }
      ForEach(row.media || [], (f: MediaInfo) => {
        RoomAttachment({ file: f,
          load: (visible: () => boolean) => this.workspace!.roomThumbnail(row.id, f.id || f.path || '', visible),
          open: () => this.run(async () => {
            const file = await this.workspace!.roomFile(row.id, f.id || f.path || '');
            if (this.active) this.preview(file);
          }) })
      }, (f: MediaInfo) => f.id || f.path || f.name)
    }.margin({ bottom: this.buddy.group && row.interactive ? 4 : 0 })
      .id('room-body-' + row.id).width(row.role === 'user' ? undefined : '100%').alignItems(HorizontalAlign.Start)
      .padding(row.role === 'user' ? 10 : 0).backgroundColor(row.role === 'user' ? $r('app.color.panel') : $r('app.color.canvas')).borderRadius(12)
  }
  @Builder
  message(row: Item) {
    Column() {
      if (row.stamp) { Text(row.stamp).id('room-time-group').fontSize(12).fontColor($r('app.color.muted')).padding(8) }
      Row({ space: 10 }) {
        if (row.role !== 'user') {
          if (row.continued) { Blank().width(28) }
          else {
            ForEach([this.member(row)], (m: Companion) => {
              CompanionAvatar({ row: m, portraitSize: 28, load: (c: Companion, v: () => boolean) => this.workspace!.companionAvatar(c, v) })
            }, (m: Companion) => companionPortraitKey(m))
          }
        }
        Column() {
          this.body(row)
          if (this.buddy.group && row.interactive) {
            if (row.replyCount && !this.root && !this.buddy.host) {
              Button($r('app.string.room_replies', row.replyCount)).height(44).fontColor($r('app.color.muted')).backgroundColor(Color.Transparent)
                .onClick(() => this.run(() => this.workspace!.openRoomThread(row.id)))
            }
            CompanionMessageActions({ group: true, own: row.role === 'user', text: row.title, messageId: row.id,
              showReply: !this.buddy.host && !this.root, replyEnabled: !!this.profile?.writable && !this.pending?.signature,
              showMore: !this.buddy.host || !!row.createdAt, reply: () => { this.quote = row.id; this.remember(); this.focusInput(); } }) {
              this.rowMenu(row)
            }
          }
        }.layoutWeight(row.role === 'user' ? 0 : 1).width(row.role === 'user' ? '86%' : undefined).alignItems(row.role === 'user' ? HorizontalAlign.End : HorizontalAlign.Start)
      }.width('100%').justifyContent(row.role === 'user' ? FlexAlign.End : FlexAlign.Start).alignItems(VerticalAlign.Top)
    }.width('100%').padding({ left: 16, right: 16 })
  }
  @Builder
  attachments() {
    Menu() {
      MenuItem({ content: $r('app.string.album') }).onClick(() => this.run(() => this.pick(true)))
      MenuItem({ content: $r('app.string.file') }).onClick(() => this.run(() => this.pick(false)))
    }
  }
  @Builder
  composer() {
    Column({ space: 4 }) {
      if (this.pending?.signature) { Text($r('app.string.room_send_uncertain')).fontSize(14).fontColor($r('app.color.muted')) }
      if (this.choosing) {
        List() {
          ForEach(this.profile?.members || [], (m: GroupMember) => {
            ListItem() { Button(m.title).width('100%').height(44).backgroundColor(Color.Transparent).fontColor($r('app.color.ink'))
              .onClick(() => { const prefix = this.text.endsWith('@') ? this.text.slice(0, -1) :
                  this.text && !/\s$/.test(this.text) ? this.text + ' ' : this.text;
                this.tracked = [...this.tracked, { start: prefix.length, botId: m.id, label: m.title }];
                this.text = prefix + '@' + m.title + ' '; this.remember(); this.choosing = false; this.focusInput(); }) }
          }, (m: GroupMember) => m.id)
        }.height(130)
      }
      if (this.quote) {
        Button('↩  ' + (this.rows.find((r: Item) => r.id === this.quote)?.title || '') + '  ×').enabled(!this.pending?.signature).width('100%').height(40)
          .fontColor($r('app.color.ink')).backgroundColor($r('app.color.chip')).onClick(() => { this.quote = ''; this.remember(); })
      }
      ForEach(this.files, (f: Attachment) => {
        Button(f.name + '  ×').enabled(!this.pending?.signature).height(36).onClick(() => { this.files = this.files.filter((v: Attachment) => v.id !== f.id); this.remember(); })
      }, (f: Attachment) => f.id)
      Row({ space: 3 }) {
        if (this.profile?.attachments) {
          Button('+').enabled(!this.pending?.signature).id('room-picker').width(44).height(44).fontColor($r('app.color.ink')).backgroundColor(Color.Transparent)
            .accessibilityText($r('app.string.add_file')).bindMenu(this.attachments)
        }
        Button('@').enabled(!this.pending?.signature).id('room-mention').width(44).height(44).fontColor($r('app.color.ink')).backgroundColor(Color.Transparent)
          .accessibilityText($r('app.string.room_mention')).onClick(() => { this.choosing = !this.choosing; })
        TextArea({ text: this.text, placeholder: $r('app.string.message') }).enabled(!this.pending?.signature).id('room-input').layoutWeight(1).maxLines(5)
          .fontColor($r('app.color.ink')).backgroundColor(Color.Transparent).onChange((value: string) => {
            if (this.text === value) return;
            this.tracked = this.workspace!.roomEditedMentions(this.text, value, this.tracked);
            this.text = value;
            if (/(^|\s)@$/.test(value)) this.choosing = true;
            this.remember();
          })
        IconAction({ icon: $r('sys.symbol.arrow_up'), label: $r('app.string.send'), controlId: 'room-send',
          available: this.connected && (!!this.text.trim() || this.files.length > 0), onTap: () => this.run(() => this.send()) })
      }.width('100%').backgroundColor($r('app.color.panel')).borderRadius(22)
    }.enabled(!this.busy).padding({ left: 12, right: 12, bottom: 8 }).width('100%')
  }
  build() {
    Column({ space: 4 }) {
      if (!this.buddy.group) {
        Row({ space: 6 }) {
          Text(this.move === 'waiting' ? $r('app.string.room_wait') : this.move === 'timeout' ? $r('app.string.room_timeout') : this.homeName ? $r('app.string.room_offline', this.homeName) : $r('app.string.room_home_offline'))
            .fontColor($r('app.color.muted')).fontSize(14).layoutWeight(1)
          if (this.move !== 'waiting') {
            PillAction({ label: this.move === 'timeout' ? $r('app.string.room_retry') : $r('app.string.room_move'), available: !this.busy,
              onTap: () => this.run(() => this.move === 'timeout' ? this.workspace!.moveRoom(this.target, true) : this.chooseTarget()) })
          }
        }.padding({ left: 16, right: 12 }).width('100%')
      }
      List({ space: 10, scroller: this.scroll, initialIndex: this.rows.length }) {
        ListItem() {
          Column() {
            if (this.root) { this.body(this.root) }
            if (this.more) { PillAction({ label: $r('app.string.older'), available: !this.loading, onTap: () => this.run(() => this.workspace!.cloudHistory(true)) }) }
          }
        }
        LazyForEach(this.history, (r: Item) => { ListItem() { this.message(r) } }, (r: Item) => this.history.key(r))
      }.id('companion-history').width('100%').layoutWeight(1).maintainVisibleContentPosition(true)
        .onScrollIndex((_first: number, last: number) => { if (this.rows.length) this.following = last >= this.rows.length; })
      if (this.loading) { LoadingProgress().width(24).height(24) }
      else if (!this.failed && !this.rows.length) { Text($r('app.string.companion_empty')).fontColor($r('app.color.muted')) }
      if (this.failed) { PillAction({ label: $r('app.string.companion_history_retry'), onTap: () => this.run(() => this.workspace!.cloudHistory(false)) }) }
      if (this.error) { Text(this.error).fontSize(14).fontColor($r('app.color.muted')).padding(8) }
      if (this.buddy.group && this.profile?.writable) { this.composer() }
      else { Text(this.buddy.group ? $r('app.string.group_readonly') : $r('app.string.companion_readonly')).id('companion-readonly').fontSize(13).fontColor($r('app.color.muted')).padding(12) }
    }.width('100%').height('100%').backgroundColor($r('app.color.canvas'))
      .bindSheet(this.pickingHost, this.hostSheet(), { height: SheetSize.MEDIUM, showClose: true, onDisappear: () => { this.pickingHost = false; } })
  }
}
