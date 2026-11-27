import { window, LengthMetrics, KeyboardAvoidMode as WindowKeyboardAvoidMode } from '@kit.ArkUI';
import { filePreview } from '@kit.PreviewKit';
import { common } from '@kit.AbilityKit';
import { installInputs } from '../services/nativeEntry';
import { LoginBrand } from './LoginBrand';
import { HistorySource } from './HistorySource';
import { HistoryMessage, InteractionPanel, MessageBody } from './TaskContent';
import { DirectoryRow, IconAction, PillAction } from './Controls';
import { Row as Item, Workspace, ViewState, Attachment, MediaInfo, Card, FolderList, Question, Choice } from '../services/workspace';

interface HomeGroup { key: string; head: Item; rows: Item[] }

@Entry
@Component
struct Index {
  @State view: ViewState = { retryable: false, attachments: [], voice: '', transfer: '', pushStatus: '', pushEnabled: false,
    shareLabel: '', cards: [], activity: '', delivery: '', draft: '', linked: false, paused: false, moreTasks: false,
    hasOlder: false, running: false, ssoWaiting: false, ssoMethods: [], verification: '', accounts: [], account: '',
    relay: '', devices: [], tasks: [], messages: [], live: '', device: '', task: '', error: '' };
  @State loginWidth: number = 375;
  @State loginHeight: number = 740;
  @State phone: string = '';
  @State enterprise: boolean = false;
  @State org: string = '';
  @State otp: string = '';
  @State creating: boolean = false;
  @State title: string = '';
  @State composing: boolean = false;
  @State initializing: boolean = true;
  @State busy: boolean = false;
  @State notice: string = '';
  @State codeSent: boolean = false;
  @State consent: boolean = false;
  @State toggleGeneration: number = 0;
  @State panel: string = '';
  @State drawerOpen: boolean = false;
  @State query: string = '';
  @State statusFilter: string = 'active';
  @State scope: string = '';
  @State collapsed: string[] = [];
  @State engine: string = '';
  @State engineOptions: string[] = [];
  @State choices: Item[] = [];
  @State folders: FolderList = { path: '', parent: '', rows: [] };
  @State inputHeight: number = 48;
  @State availableHeight: number = 640;
  @State topInset: number = 0;
  @State bottomInset: number = 0;
  @State keyboardShown: boolean = false;
  private appWindow?: window.Window;
  private areaChanged = (event: window.AvoidAreaOptions): void => {
    if (event.type === window.AvoidAreaType.TYPE_SYSTEM) this.topInset = this.getUIContext().px2vp(event.area.topRect.height);
    if (event.type === window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR) this.bottomInset = this.getUIContext().px2vp(event.area.bottomRect.height);
    if (event.type === window.AvoidAreaType.TYPE_KEYBOARD) this.keyboardShown = event.area.bottomRect.height > 0;
  };
  @State unread: boolean = false;
  private dragStart: number = 48;
  @State pathInput: string = '';
  @State project: string = '';
  @State zoom: number = 1;
  @State panX: number = 0;
  @State panY: number = 0;
  private initialZoom: number = 1;
  private initialX: number = 0;
  private initialY: number = 0;
  @State inputOpen: boolean = false;
  @State selectedFile: MediaInfo | undefined = undefined;
  @State previewSource: string = '';
  @State voiceElapsed: number = 0;
  private voiceTimer: number = -1;
  @State resend: number = 0;
  @State cardIndex: number = 0;
  private resendTimer: number = -1;
  private historySource: HistorySource = new HistorySource();
  private scroll: Scroller = new Scroller();
  private pulledHistory: boolean = false;
  private followEnd: boolean = true;
  private scrollTimer: number = -1;
  private workspace: Workspace = new Workspace((state: ViewState) => {
    const switched = state.task !== this.view.task;
    const changed = state.messages.length !== this.view.messages.length || state.live !== this.view.live;
    if (state.account !== this.view.account) { this.scope = ''; this.query = ''; this.collapsed = []; this.statusFilter = 'active'; }
    if (this.scope && !state.devices.some((d: Item) => d.id === this.scope)) this.scope = '';
    if (!switched && state.task && !this.followEnd && changed) {
      const last = this.view.messages[this.view.messages.length - 1]?.id;
      const index = last ? state.messages.findIndex((r: Item) => r.id === last) : -1;
      if ((index >= 0 && index < state.messages.length - 1) || (!!state.live && state.live !== this.view.live)) this.unread = true;
    }
    this.historySource.replace(state.messages);
    if (state.device !== this.view.device || switched) this.creating = false;
    if (switched || state.device !== this.view.device || state.account !== this.view.account) {
      this.drawerOpen = false; this.panel = ''; this.selectedFile = undefined; this.previewSource = ''; this.inputOpen = false; this.inputHeight = 48; this.cardIndex = 0; this.unread = false; this.engine = ''; this.engineOptions = []; this.choices = [];
      this.folders = { path: '', parent: '', rows: [] }; this.project = ''; this.title = '';
    }
    if (!state.linked) { this.selectedFile = undefined; this.previewSource = ''; }
    if (this.cardIndex >= state.cards.length) this.cardIndex = 0;
    if (state.voice !== this.view.voice) {
      clearInterval(this.voiceTimer);
      this.voiceElapsed = 0;
      if (state.voice === '录音中') {
        const started = Date.now();
        this.voiceTimer = setInterval(() => { this.voiceElapsed = Math.floor((Date.now() - started) / 1000); }, 1000);
      }
    }
    const appearanceChanged = !!state.account !== !!this.view.account;
    this.view = state;
    if (appearanceChanged) this.updateBars();
    if (switched) { this.pulledHistory = false; this.followEnd = true; this.composing = false; }
    if (state.task && this.followEnd && (changed || switched)) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = setTimeout(() => {
        if (this.view.task === state.task && this.followEnd) this.scroll.scrollEdge(Edge.Bottom);
      }, 35);
    }
  }, true);

  aboutToAppear(): void {
    this.updateBars();
    installInputs(this.workspace);
    this.getUIContext().setKeyboardAvoidMode(WindowKeyboardAvoidMode.RESIZE);
    this.run(async () => {
      try { await this.workspace.init(this.getUIContext().getHostContext() as common.UIAbilityContext); }
      finally { this.initializing = false; }
    });
  }

  onWillApplyTheme(): void { this.updateBars(); }

  private async updateBars(): Promise<void> {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    if (!ctx) return;
    try {
      const win = await window.getLastWindow(ctx);
      if (this.appWindow !== win) {
        this.appWindow?.off('avoidAreaChange', this.areaChanged);
        this.appWindow = win;
        win.on('avoidAreaChange', this.areaChanged);
      }
      this.topInset = this.getUIContext().px2vp(win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM).topRect.height);
      this.bottomInset = this.getUIContext().px2vp(win.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR).bottomRect.height);
      const colors = ctx.resourceManager;
      const bg = colors.getColorSync((this.view.account ? $r('app.color.canvas') : $r('app.color.login_bg')).id);
      const fg = colors.getColorSync($r('app.color.ink').id);
      const background = '#' + (bg >>> 0).toString(16).padStart(8, '0').slice(-6);
      const foreground = '#' + (fg >>> 0).toString(16).padStart(8, '0').slice(-6);
      win.setWindowBackgroundColor(background);
      await win.setWindowSystemBarProperties({ statusBarColor: background, navigationBarColor: background,
        statusBarContentColor: foreground, navigationBarContentColor: foreground });
    } catch { /* A window can disappear during a theme or account transition. */ }
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.notice = '';
    try { await action(); }
    catch (error) { this.notice = (error as Error).message || this.getUIContext().getHostContext()!.resourceManager.getStringSync($r('app.string.operation_failed').id); }
    finally { this.busy = false; }
  }

  onBackPress(): boolean {
    if (this.drawerOpen) { this.drawerOpen = false; return true; }
    if (this.selectedFile) { this.selectedFile = undefined; this.previewSource = ''; return true; }
    if (this.panel === 'new-host' && !this.view.device) { this.panel = ''; this.creating = false; return true; }
    if (this.panel) { this.panel = ['path', 'browse'].includes(this.panel) ? 'projects' : ''; return true; }
    if (!this.view.account && (this.codeSent || this.enterprise) && !this.view.ssoWaiting) {
      this.codeSent = false; this.enterprise = false; this.otp = ''; this.notice = ''; this.workspace.clearMethods(); return true;
    }
    if (this.creating) { this.creating = false; this.title = ''; this.foldComposer(); return true; }
    if (this.view.shareLabel && !this.view.task) { this.workspace.dismissShare(); return true; }
    if (!this.view.task) return false;
    this.run(() => this.workspace.back());
    return true;
  }

  onPageHide(): void {
    this.workspace.cancelVoice();
    this.workspace.flushDraft().catch((e: Error) => { this.notice = e.message; });
  }

  private async openPolicy(url: string): Promise<void> {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    await context.startAbility({ action: 'ohos.want.action.viewData', entities: ['entity.system.browsable'], uri: url });
  }

  private deviceLabel(item: Item): string {
    return this.view.devices.filter((d: Item) => d.title === item.title).length > 1 ? item.title + ' · ' + item.id.slice(-6) : item.title;
  }

  private headerTitle(): ResourceStr {
    if (this.view.task) return this.view.tasks.find((r: Item) => r.id === this.view.task)?.title || $r('app.string.task');
    return this.view.device ? $r('app.string.tasks') : $r('app.string.hosts');
  }

  private canSend(): boolean {
    return !this.composing && !this.busy && this.view.linked && !this.view.voice && !this.view.transfer &&
      !this.view.delivery && (!!this.view.draft.trim() || this.view.attachments.length > 0);
  }

  private async showPreview(file: MediaInfo, local: string = ''): Promise<void> {
    this.selectedFile = file; this.previewSource = ''; this.zoom = 1; this.panX = 0; this.panY = 0;
    if (local) { this.previewSource = local; return; }
    if (!file.path) return;
    const url = await this.workspace.previewUrl(file.path);
    if (this.selectedFile?.path === file.path) this.previewSource = url;
  }

  private async openSelectedFile(): Promise<void> {
    const source = this.previewSource;
    const file = this.selectedFile;
    if (!file || !source) return;
    if (source.startsWith('https://')) return this.openPolicy(source);
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    if (await filePreview.canPreview(context, source)) {
      await filePreview.openPreview(context, { uri: source, title: file.name, mimeType: file.mimeType || '' });
    } else if (file.path) {
      const url = await this.workspace.previewUrl(file.path);
      if (this.selectedFile?.path === file.path) await this.openPolicy(url);
    }
  }

  private gallery(): MediaInfo[] {
    if (this.view.attachments.some((a: Attachment) => a === this.selectedFile || (!!a.path && a.path === this.selectedFile?.path))) {
      return this.view.attachments.filter((a: Attachment) => !!a.mimeType?.startsWith('image/'));
    }
    const result: MediaInfo[] = [];
    this.view.messages.forEach((row: Item) => (row.media || []).forEach((a: MediaInfo) => {
      if (a.path && a.mimeType?.startsWith('image/') && !result.some((f: MediaInfo) => f.path === a.path)) result.push(a);
    }));
    return result;
  }

  private imageIndex(): number { return this.gallery().findIndex((f: MediaInfo) => f.path === this.selectedFile?.path); }
  private async moveImage(offset: number): Promise<void> {
    const next = this.gallery()[this.imageIndex() + offset];
    if (next) {
      const draft = this.view.attachments.find((a: Attachment) => a.path === next.path);
      await this.showPreview(next, this.workspace.localPreview(draft?.id || next.path || ''));
    }
  }

  @Builder
  filePreview() {
    Column({ space: 12 }) {
      Text(this.selectedFile?.name || '').fontSize(18).fontWeight(FontWeight.Medium)
      if (this.previewSource && this.selectedFile?.mimeType?.startsWith('image/')) {
        Stack() {
          Image(this.previewSource).width('100%').height('100%').objectFit(ImageFit.Contain)
            .scale({ x: this.zoom, y: this.zoom }).translate({ x: this.panX, y: this.panY })
        }.width('100%').layoutWeight(1).clip(true).gesture(GestureGroup(GestureMode.Parallel,
          PinchGesture().onActionStart(() => { this.initialZoom = this.zoom; }).onActionUpdate((e: GestureEvent) => {
            this.zoom = Math.min(4, Math.max(1, this.initialZoom * e.scale));
            if (this.zoom === 1) { this.panX = 0; this.panY = 0; }
          }),
          PanGesture().onActionStart(() => { this.initialX = this.panX; this.initialY = this.panY; })
            .onActionUpdate((e: GestureEvent) => {
              if (this.zoom > 1) { this.panX = Math.min(180 * this.zoom, Math.max(-180 * this.zoom, this.initialX + e.offsetX));
                this.panY = Math.min(220 * this.zoom, Math.max(-220 * this.zoom, this.initialY + e.offsetY)); }
            }).onActionEnd((e: GestureEvent) => {
              if (this.zoom === 1 && Math.abs(e.offsetX) > 60) this.run(() => this.moveImage(e.offsetX < 0 ? 1 : -1));
            })))
        if (this.gallery().length > 1) {
          Row({ space: 12 }) {
            IconAction({ icon: $r('sys.symbol.chevron_left'), label: $r('app.string.previous'), available: this.imageIndex() > 0, onTap: () => this.run(() => this.moveImage(-1)) })
            Text((this.imageIndex() + 1).toString() + ' / ' + this.gallery().length.toString()).fontColor($r('app.color.ink'))
            IconAction({ icon: $r('sys.symbol.chevron_right'), label: $r('app.string.next_step'), available: this.imageIndex() + 1 < this.gallery().length, onTap: () => this.run(() => this.moveImage(1)) })
          }
        }
      } else {
        Text([this.selectedFile?.mimeType, this.selectedFile?.size ? this.selectedFile.size.toString() + ' B' : ''].filter((s: string | undefined) => !!s).join(' · '))
          .fontSize(14).fontColor($r('app.color.muted'))
        if (this.previewSource) {
          PillAction({ label: $r('app.string.open_file'), onTap: () => this.run(() => this.openSelectedFile()) })
        } else if (!this.busy) { Text($r('app.string.unavailable_preview')).fontSize(14) }
      }
      PillAction({ label: $r('app.string.close'), onTap: () => { this.selectedFile = undefined; this.previewSource = ''; } })
    }.padding(16).width('100%').layoutWeight(1)
  }

  private expanded(): boolean {
    return this.inputOpen || !!this.view.transfer || !!this.view.voice || !!this.view.failedFile;
  }

  private foldComposer(): void {
    this.inputOpen = false; this.inputHeight = 48;
    this.getUIContext().getFocusController().clearFocus();
  }

  @Builder
  composer() {
    Column({ space: 3 }) {
      if (this.expanded()) {
        Button({ type: ButtonType.Normal }) {
          Divider().width(32).strokeWidth(3).color($r('app.color.line'))
        }.id('resize-composer').height(20).width(68).backgroundColor(Color.Transparent).accessibilityText($r('app.string.collapse_input'))
          .onClick(() => this.foldComposer())
          .gesture(PanGesture({ direction: PanDirection.Vertical })
            .onActionStart(() => { this.dragStart = this.inputHeight; })
            .onActionUpdate((e: GestureEvent) => {
              this.inputHeight = Math.max(44, Math.min(this.availableHeight * 0.42, this.dragStart - e.offsetY));
            }).onActionEnd((e: GestureEvent) => { if (this.dragStart <= 48 && e.offsetY > 32) this.foldComposer(); }))
      }
      if (this.view.attachments.length && this.expanded()) {
        Scroll() {
          Row({ space: 6 }) {
            ForEach(this.view.attachments, (f: Attachment) => {
              if (f.mimeType?.startsWith('image/')) {
                Stack({ alignContent: Alignment.BottomStart }) {
                  Button({ type: ButtonType.Normal }) {
                    if (this.workspace.localPreview(f.id)) { Image(this.workspace.localPreview(f.id)).width(72).height(72).objectFit(ImageFit.Cover) }
                    else { SymbolGlyph($r('sys.symbol.picture')).fontSize(26) }
                  }.id('preview-' + f.id).width(72).height(72).borderRadius(12).backgroundColor($r('app.color.chip')).accessibilityText(f.name)
                    .onClick(() => this.run(() => this.showPreview(f, this.workspace.localPreview(f.id))))
                  Button({ type: ButtonType.Normal }) {
                    SymbolGlyph($r('sys.symbol.xmark')).fontSize(12).fontColor([$r('app.color.on_action')]).padding(4)
                      .backgroundColor($r('app.color.action')).borderRadius(12)
                  }.width(44).height(44).position({ x: 40, y: 0 }).align(Alignment.TopEnd).padding(2).backgroundColor(Color.Transparent)
                    .id('remove-' + f.id).accessibilityText($r('app.string.remove_file', f.name)).enabled(!this.busy)
                    .onClick(() => this.run(() => this.workspace.removeFile(f.id)))
                }.width(84).height(84)
              } else {
                Row() {
                  Button({ type: ButtonType.Normal }) {
                    Row({ space: 6 }) {
                      SymbolGlyph($r('sys.symbol.doc')).fontSize(21)
                      Text(f.name).maxLines(2).fontSize(14).fontColor($r('app.color.ink')).constraintSize({ maxWidth: 120 })
                    }
                  }.id('preview-' + f.id).height(44).backgroundColor(Color.Transparent)
                    .onClick(() => this.run(() => this.showPreview(f, this.workspace.localPreview(f.id))))
                  IconAction({ icon: $r('sys.symbol.xmark'), label: $r('app.string.remove_file', f.name), controlId: 'remove-' + f.id,
                    available: !this.busy, onTap: () => this.run(() => this.workspace.removeFile(f.id)) })
                }.backgroundColor($r('app.color.chip')).borderRadius(10)
              }
            }, (f: Attachment) => f.id)
          }
        }.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).align(Alignment.Start).width('100%').height(86)
      }
      if (this.view.voicePreview) { Text(this.view.voicePreview).fontSize(15).fontColor($r('app.color.ink')).width('100%').maxLines(3) }
      Row({ space: 4 }) {
      if (!this.expanded() && !this.creating) {
        if (this.view.attachments.length) {
          Button(this.view.attachments.length.toString()).height(40).onClick(() => { this.inputOpen = true; })
        }
        IconAction({ icon: $r('sys.symbol.plus'), label: $r('app.string.add_file'), controlId: 'compact-add',
          available: this.view.linked, menuItems: this.attachmentMenu() })
      }
      TextArea({ placeholder: this.creating ? $r('app.string.first_input') : $r('app.string.message'),
        text: this.creating ? this.title : this.view.draft }).id(this.creating ? 'first-message' : 'composer').layoutWeight(1)
        .height(this.expanded() ? Math.min(this.inputHeight, Math.max(44, this.availableHeight * 0.42)) : 44)
        .onFocus(() => { this.inputOpen = true; })
        .fontSize(16).fontColor($r('app.color.ink')).backgroundColor(Color.Transparent)
        .padding({ left: 10, right: 10, top: 7, bottom: 3 })
        .onChange((value: string, preview?: PreviewText) => {
          this.composing = !!preview?.value;
          if (!this.composing) { if (this.creating) this.title = value; else this.workspace.editDraft(value); }
        })
        if (this.creating) {
          IconAction({ icon: $r('sys.symbol.arrow_up'), label: this.view.shareLabel ? $r('app.string.share_new') : $r('app.string.send'),
            controlId: 'create-send', prominent: true, available: !this.busy && !this.composing && this.view.linked && (!!this.title.trim() || !!this.view.shareLabel),
            onTap: () => this.run(() => this.newTask()) })
        } else if (!this.expanded()) {
          if (this.view.running) {
            IconAction({ icon: $r('sys.symbol.square_fill'), label: $r('app.string.stop'), controlId: 'stop', prominent: true,
              available: this.view.linked, onTap: () => this.run(() => this.workspace.control(false)) })
          } else if (this.view.draft.trim() || this.view.attachments.length) {
            IconAction({ icon: $r('sys.symbol.arrow_up'), label: $r('app.string.send'), controlId: 'send',
              prominent: true, available: this.canSend(), onTap: () => this.run(() => this.workspace.send(this.view.draft)) })
          } else {
            IconAction({ icon: $r('sys.symbol.mic'), label: $r('app.string.voice'), controlId: 'voice', available: !this.busy && this.view.linked,
              onTap: () => this.workspace.startVoice() })
          }
        }
      }.width('100%')
      if (!this.creating && (this.expanded() || this.view.paused)) {
      Row({ space: 2 }) {
        if (this.view.transfer) {
          Text([this.view.uploadName, this.view.transfer].filter((s: string | undefined) => !!s).join(' · ')).fontSize(14).fontColor($r('app.color.muted')).layoutWeight(1)
          PillAction({ label: $r('app.string.cancel_file'), onTap: () => this.workspace.cancelTransfer() })
        } else if (this.view.failedFile) {
          Text(this.view.failedFile).layoutWeight(1).fontSize(14).fontColor($r('app.color.warning')).maxLines(1)
          PillAction({ label: $r('app.string.retry_upload'), onTap: () => this.run(async () => { await this.workspace.retryFile(); }) })
          IconAction({ icon: $r('sys.symbol.xmark'), label: $r('app.string.cancel_file'), onTap: () => { this.notice = ''; this.workspace.discardFailed(); } })
        } else if (this.view.voice) {
          Text(this.view.voice === '录音中' ? this.view.voice + ' 0:' + this.voiceElapsed.toString().padStart(2, '0') : this.view.voice).fontSize(14).fontColor($r('app.color.recording')).layoutWeight(1)
          IconAction({ icon: $r('sys.symbol.xmark'), label: $r('app.string.voice_cancel'), controlId: 'cancel-voice',
            onTap: () => this.workspace.cancelVoice() })
          IconAction({ icon: $r('sys.symbol.checkmark'), label: $r('app.string.voice_finish'), controlId: 'finish-voice',
            prominent: true, onTap: () => this.workspace.finishVoice() })
        } else {
          IconAction({ icon: $r('sys.symbol.plus'), label: $r('app.string.add_file'), controlId: 'add-attachment',
            available: !this.busy && this.view.linked,
            menuItems: this.attachmentMenu() })
          IconAction({ icon: $r('sys.symbol.mic'), label: $r('app.string.voice'), controlId: 'voice', available: !this.busy && this.view.linked,
            onTap: () => { this.notice = ''; this.workspace.startVoice(); } })
          Scroll() {
            Row({ space: 4 }) {
              if (this.view.model) { this.preferenceChip(this.view.model, 'model') }
              if (this.view.permission) { this.preferenceChip(this.view.permission, 'permission') }
            }
          }.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).layoutWeight(1)
          if (this.view.paused) {
            PillAction({ label: $r('app.string.resume'), available: !this.busy && this.view.linked,
              onTap: () => this.run(() => this.workspace.control(true)) })
          }
          if (this.view.running) {
            IconAction({ icon: $r('sys.symbol.square_fill'), label: $r('app.string.stop'), controlId: 'stop',
              prominent: true, available: !this.busy && this.view.linked, onTap: () => this.run(() => this.workspace.control(false)) })
          }
          if (!this.view.running || this.view.draft.trim() || this.view.attachments.length) {
            IconAction({ icon: $r('sys.symbol.arrow_up'), label: $r('app.string.send'), controlId: 'send',
              prominent: true, available: this.canSend(), onTap: () => this.run(() => this.workspace.send(this.view.draft)) })
          }
        }
      }.width('100%')
      }
    }.width('100%').alignItems(HorizontalAlign.Center).padding(this.expanded() ? 8 : 4).constraintSize({ minHeight: 55 }).borderWidth(1)
      .borderColor($r('app.color.line')).borderRadius(this.expanded() ? 18 : 30).backgroundColor($r('app.color.panel'))
  }

  @Builder
  preferenceChip(value: string, kind: string) {
    Button(value).id('choose-' + kind).height(44).padding({ left: 7, right: 7 }).fontSize(13)
      .fontColor($r('app.color.ink')).backgroundColor($r('app.color.chip')).borderRadius(12)
      .enabled(!this.busy && this.view.linked && !this.view.running).onClick(() => this.run(() => this.showChoices(kind)))
  }

  private attachmentMenu(): MenuElement[] {
    return [{ value: $r('app.string.image'), action: () => this.run(async () => { if (await this.workspace.addFile('image')) this.inputOpen = true; }) },
      { value: $r('app.string.file'), action: () => this.run(async () => { if (await this.workspace.addFile('file')) this.inputOpen = true; }) }];
  }

  @Builder
  taskContent() {
    List({ space: 14, scroller: this.scroll }) {
      LazyForEach(this.historySource, (item: Item) => {
        ListItem() { HistoryMessage({ item: item, openLink: (url: string) => this.run(() => this.openPolicy(url)),
          loadImage: (file: MediaInfo, visible: () => boolean) => this.workspace.thumbnail(file, visible),
          preview: (file: MediaInfo) => this.run(() => this.showPreview(file, this.workspace.localPreview(file.path || ''))) }) }
      }, (item: Item) => item.id + item.title + (item.detail || '') + JSON.stringify(item.media || []))
      if (this.view.live) {
        ListItem() { MessageBody({ value: this.view.live, openLink: (url: string) => this.run(() => this.openPolicy(url)) }) }
      }
    }.id('history').layoutWeight(1).width('100%').maintainVisibleContentPosition(true)
      .onScrollFrameBegin((offset: number, state: ScrollState) => {
        if (state === ScrollState.Scroll && offset < 0) {
          this.followEnd = false;
          if (!this.pulledHistory && this.view.hasOlder && this.view.linked && !this.busy && this.scroll.currentOffset().yOffset <= 1) {
            this.pulledHistory = true;
            this.run(() => this.workspace.older());
          }
        }
        return { offsetRemain: offset };
      }).onScrollStop(() => { this.pulledHistory = false; }).onReachEnd(() => { this.followEnd = true; this.unread = false; })
    if (this.unread) {
      PillAction({ label: $r('app.string.new_messages'), onTap: () => { this.followEnd = true; this.unread = false; this.scroll.scrollEdge(Edge.Bottom); } })
    }
    if (this.view.delivery) {
      Column({ space: 4 }) {
        if (this.view.pendingLabel) { Text(this.view.pendingLabel).maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis }) }
        Text(this.view.delivery).fontSize(13).fontColor($r('app.color.warning'))
        PillAction({ label: this.view.retryable ? $r('app.string.retry_last') : $r('app.string.verify_delivery'),
          available: !this.busy && this.view.linked, onTap: () => this.run(() => this.view.retryable ? this.workspace.retryOriginal() : this.workspace.checkDelivery()) })
      }.alignSelf(ItemAlign.End).padding(8).backgroundColor($r('app.color.chip')).borderRadius(12)
    }
    if (this.view.cards.length) {
      if (this.view.cards.length > 1) {
        Button((this.cardIndex + 1).toString() + ' / ' + this.view.cards.length.toString()).accessibilityText($r('app.string.other_requests'))
          .onClick(() => { this.cardIndex = (this.cardIndex + 1) % this.view.cards.length; })
      }
      ForEach(this.view.cards.slice(this.cardIndex, this.cardIndex + 1), (card: Card) => {
        InteractionPanel({ card: this.view.cards[this.cardIndex], available: !this.busy && this.view.linked,
          openLink: (url: string) => this.run(() => this.openPolicy(url)),
          edit: (key: string, value: string, selected: boolean) => this.workspace.editAnswer(card.id, key, value, selected),
          decide: (choice: string, key?: string) => this.run(() => this.workspace.decide(card.id, choice, key)) })
      }, (card: Card) => card.id + JSON.stringify(card.questions.map((q: Question) => [q.key, q.label, q.options.map((o: Choice) => o.label)])))
    } else {
      if (this.view.running) {
        Row({ space: 8 }) {
          LoadingProgress().width(14).height(14).color($r('app.color.running'))
          Text(this.view.activity || $r('app.string.working')).fontSize(13).lineHeight(18).fontColor($r('app.color.muted')).maxLines(1)
        }.alignSelf(ItemAlign.Start)
      }
      this.composer()
    }
  }

  @Builder
  consentRow() {
    Row({ space: 2 }) {
      Checkbox().select(this.consent).accessibilityText($r('app.string.consent'))
        .selectedColor($r('app.color.action')).onChange((value: boolean) => { this.consent = value; })
      Text($r('app.string.agree')).fontSize(13).fontColor($r('app.color.muted'))
      Text($r('app.string.terms')).fontSize(13).fontColor($r('app.color.ink')).height(44)
        .decoration({ type: TextDecorationType.Underline }).onClick(() => this.run(() => this.openPolicy('https://cindy.cn/terms')))
      Text($r('app.string.and')).fontSize(13).fontColor($r('app.color.muted'))
      Text($r('app.string.privacy')).fontSize(13).fontColor($r('app.color.ink')).height(44)
        .decoration({ type: TextDecorationType.Underline }).onClick(() => this.run(() => this.openPolicy('https://cindy.cn/privacy')))
    }.width('100%').justifyContent(FlexAlign.Center)
  }

  private async requestCode(): Promise<void> {
    await this.workspace.code('+86' + this.phone);
    this.codeSent = true; this.resend = 60;
    clearInterval(this.resendTimer);
    const until = Date.now() + 60000;
    this.resendTimer = setInterval(() => {
      this.resend = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      if (!this.resend) clearInterval(this.resendTimer);
    }, 500);
  }

  private submitPhone(): void {
    if (this.codeSent) {
      this.run(async () => { await this.workspace.login('+86' + this.phone, this.otp); this.otp = ''; this.phone = ''; this.codeSent = false; });
    } else if (this.consent) { this.run(() => this.requestCode()); }
    else {
      this.getUIContext().showAlertDialog({ message: $r('app.string.agreement_title'),
        primaryButton: { value: $r('app.string.cancel'), action: () => {} },
        secondaryButton: { value: $r('app.string.agree_continue'), action: () => {
          this.consent = true; this.run(() => this.requestCode());
        } } })
    }
  }

  aboutToDisappear(): void { this.appWindow?.off('avoidAreaChange', this.areaChanged); this.appWindow = undefined; clearInterval(this.resendTimer); clearInterval(this.voiceTimer); clearTimeout(this.scrollTimer); }

  private u(px: number): number { return px * this.loginWidth / 750; }

  @Builder
  otpInput() {
    TextInput({ placeholder: $r('app.string.sms'), text: this.otp }).id('otp').type(InputType.Number)
      .maxLength(6).inputFilter('[0-9]').textAlign(TextAlign.Center).height(this.u(80))
      .onChange((value: string) => { this.otp = value; })
  }

  @Builder
  loginForm() {
    Stack({ alignContent: Alignment.TopStart }) {
      Column() {
        Text(this.enterprise ? $r('app.string.sso_org') : this.codeSent ? $r('app.string.phone_code_title') : $r('app.string.app_login'))
          .fontSize(this.u(32)).fontWeight(FontWeight.Bold).fontColor($r('app.color.ink')).margin({ top: this.u(31) })
        if (this.enterprise || this.codeSent) {
          Text(this.enterprise ? $r('app.string.org_hint') : '+86 ' + this.phone).fontSize(this.u(20)).lineHeight(this.u(25))
            .fontColor($r('app.color.muted')).maxLines(2).textAlign(TextAlign.Center).width('79.41%')
        }
      }.width('100%')
      if (this.enterprise || this.codeSent) {
        IconAction({ icon: $r('sys.symbol.chevron_left'), label: $r('app.string.back'), controlId: 'login-back', onTap: () => { this.onBackPress(); } })
      }
      Column() {
        if (this.enterprise) {
          TextInput({ placeholder: $r('app.string.org_id'), text: this.org }).id('org').height(this.u(80)).enabled(!this.busy)
            .onChange((value: string) => { this.org = value; this.workspace.clearMethods(); })
        } else if (this.codeSent) { this.otpInput() }
        else {
          Row({ space: 5 }) {
            Text('+86').fontSize(this.u(28)).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink'))
            TextInput({ placeholder: $r('app.string.phone'), text: this.phone }).id('phone').type(InputType.PhoneNumber)
              .layoutWeight(1).backgroundColor(Color.Transparent).maxLength(11).height(this.u(80))
              .onChange((value: string) => { this.phone = value; this.otp = ''; })
          }.width('100%').height(this.u(80)).padding({ left: this.u(31), right: 8 }).borderRadius(32).backgroundColor($r('app.color.chip'))
        }
      }.width('79.41%').position({ x: '10.295%', y: this.u(158) })
      Button(this.codeSent ? $r('app.string.sign_in') : $r('app.string.next_step')).primaryLogin()
        .width('79.41%').height(this.u(80)).position({ x: '10.295%', y: this.u(300) })
        .enabled(!this.busy && (this.enterprise ? !!this.org.trim() : /^1[3-9][0-9]{9}$/.test(this.phone) && (!this.codeSent || /^\d{6}$/.test(this.otp))))
        .onClick(() => { if (this.enterprise) this.run(() => this.workspace.discover(this.org)); else this.submitPhone(); })
      if (this.codeSent) {
        Button(this.resend ? $r('app.string.again_in', this.resend) : $r('app.string.new_code')).height(this.u(60))
          .position({ x: '10.295%', y: this.u(238) }).backgroundColor(Color.Transparent).fontColor($r('app.color.muted')).fontSize(13)
          .enabled(!this.busy && !this.resend).onClick(() => this.run(() => this.requestCode()))
      }
    }.width('100%').height(this.u(440))
    ForEach(this.view.ssoMethods, (item: Item) => {
      PillAction({ label: item.title, available: !this.busy, onTap: () => this.run(() => this.workspace.startSSO(item.id)) })
    }, (item: Item) => item.id)
  }

  @Builder
  login() {
    Scroll() {
      Column({ space: 0 }) {
        LoginBrand({ stageWidth: this.loginWidth, stageHeight: this.loginHeight })
        Column({ space: 16 }) {
          if (this.view.ssoWaiting) {
            LoadingProgress().width(28).height(28)
            Text($r('app.string.sso_wait')).sectionTitle()
            PillAction({ label: $r('app.string.sso_cancel'), onTap: () => this.run(() => this.workspace.cancelSSO()) })
          } else if (this.view.verification) {
            Text($r('app.string.verify_for', this.view.verification)).sectionTitle()
            PillAction({ label: $r('app.string.get_code'), onTap: () => this.run(() => this.workspace.verificationCode()) })
            this.otpInput()
            Button($r('app.string.verify')).primaryLogin().enabled(!this.busy && /^\d{6}$/.test(this.otp))
              .onClick(() => this.run(async () => { await this.workspace.verifyOrganization(this.otp); this.otp = ''; }))
          } else if (this.view.accounts.length) {
            Text($r('app.string.choose_account')).sectionTitle()
            ForEach(this.view.accounts, (item: Item) => {
              DirectoryRow({ title: item.title, targetId: item.id, available: !this.busy, open: () => this.run(() => this.workspace.choose(item.id)) })
            }, (item: Item) => item.id)
          } else { this.loginForm() }
          this.errorNotice()
        }.padding(this.view.ssoWaiting || this.view.verification || this.view.accounts.length ? 20 : 0).width('90.67%').borderRadius(16).backgroundColor($r('app.color.login_card'))
        if (!this.enterprise && !this.codeSent && !this.view.verification && !this.view.accounts.length && !this.view.ssoWaiting) {
          Button('SSO', { type: ButtonType.Circle }).width(44).height(44).fontSize(13).margin({ top: this.u(40) })
            .backgroundColor($r('app.color.action')).fontColor($r('app.color.on_action')).accessibilityText($r('app.string.use_sso'))
            .onClick(() => { this.enterprise = true; this.notice = ''; })
          this.consentRow()
        }
      }.width('100%').constraintSize({ maxWidth: 440 }).padding({ bottom: 16 })
    }.width('100%').height('100%').align(Alignment.Top).scrollBar(BarState.Off)
      .onAreaChange((_: Area, next: Area) => {
        this.loginWidth = Math.min(440, Number(next.width));
        this.loginHeight = Number(next.height);
      })
  }

  private async selectHost(id: string): Promise<void> {
    if (this.view.device !== id) {
      if (this.view.task) await this.workspace.back();
      if (this.view.device) await this.workspace.back();
      await this.workspace.openDevice(id);
    }
    this.panel = '';
  }

  private async chooseHost(id: string): Promise<void> {
    const restoring = this.panel === 'new-host';
    const note = this.title;
    const project = this.view.device === id ? this.project : '';
    const owner = this.view.account;
    const selectingScope = this.panel === 'hosts';
    await this.selectHost(id);
    if (selectingScope && this.view.account === owner) this.scope = id;
    if (restoring && this.view.account === owner && this.view.device === id) {
      this.creating = true;
      this.title = note;
      this.project = project;
    }
  }

  private hostOffline(id: string): boolean {
    return this.view.relay !== 'online' || !!this.view.devices.find((r: Item) => r.id === id)?.offline;
  }

  private homeRows(): Item[] {
    const allowed = this.view.devices.map((r: Item) => r.id);
    const current: Item[] = this.view.tasks.map((r: Item) => {
      const item: Item = { id: r.id, title: r.title, project: r.project, summary: r.summary,
        updated: r.updated, running: r.running, status: r.status, host: this.view.device };
      return item;
    });
    const rows = current.concat((this.view.homeIndex || []).filter((r: Item) => r.host !== this.view.device && allowed.includes(r.host || '')));
    return rows.filter((r: Item) => (!this.view.shareLabel || !this.hostOffline(r.host || '')) && (!this.scope || this.scope === r.host) && (this.statusFilter === 'all' || (r.status === 'archived') === (this.statusFilter === 'archived')) &&
      (r.title + ' ' + (r.project || '') + ' ' + (r.summary || '')).toLowerCase().includes(this.query.trim().toLowerCase()));
  }

  private rowTime(item: Item): string {
    const date = new Date(item.updated || '');
    if (!Number.isFinite(date.getTime())) return '';
    return date.toDateString() === new Date().toDateString() ?
      date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0') :
      (date.getMonth() + 1).toString() + '/' + date.getDate().toString();
  }

  private groupKey(item: Item): string { return JSON.stringify([item.host || '', item.project || '']); }

  private groups(): HomeGroup[] {
    const groups = new Map<string, HomeGroup>();
    this.homeRows().forEach((row: Item) => {
      const key = this.groupKey(row);
      const existing = groups.get(key);
      if (existing) existing.rows.push(row);
      else groups.set(key, { key: key, head: row, rows: [row] });
    });
    return Array.from(groups.values());
  }

  private async browse(path: string): Promise<void> {
    const origin = this.panel;
    const folders = await this.workspace.browse(path);
    if (this.creating && this.panel === origin) { this.folders = folders; this.panel = 'browse'; }
  }

  private rowAvailable(item: Item): boolean {
    return !this.busy && (!this.view.shareLabel || !this.hostOffline(item.host || ''));
  }

  private basename(path: string): string { return path.split(/[\\/]/).filter((s: string) => !!s).pop() || path; }

  private startNew(): void {
    this.title = ''; this.project = ''; this.engine = ''; this.inputOpen = false; this.inputHeight = 48;
    this.creating = true; this.panel = this.view.device ? '' : 'new-host';
  }

  private async showChoices(kind: string): Promise<void> {
    this.choices = [];
    if (kind === 'engines') this.engineOptions = await this.workspace.engines();
    else this.choices = await this.workspace.preferences(kind);
    if (kind === 'engines' ? this.creating && !this.panel : !!this.view.task && this.inputOpen && !this.panel) this.panel = kind;
  }

  private hostName(id: string): string {
    const host = this.view.devices.find((r: Item) => r.id === id);
    return host ? this.deviceLabel(host) : '';
  }

  private async newTask(): Promise<void> {
    const text = this.title.trim();
    if (!this.view.shareLabel && !text) return;
    const sharing = !!this.view.shareLabel;
    const version = this.view.shareVersion;
    const created = await this.workspace.create('', this.project.trim(), sharing ? '' : text, this.engine);
    if (created && sharing && this.view.shareVersion === version && this.view.shareLabel && this.view.task) {
      if (text) this.workspace.editDraft(text);
      await this.workspace.acceptShare();
    }
  }

  @Builder
  headerMenu() {
    Menu() {
      if (this.view.task) {
        MenuItem({ content: $r('app.string.task_info') }).onClick(() => { this.panel = 'detail'; })
        if (this.view.hasOlder && this.view.linked) {
          MenuItem({ content: $r('app.string.older') }).onClick(() => this.run(async () => {
            this.followEnd = false; this.scroll.scrollEdge(Edge.Top); await this.workspace.older();
          }))
        }
      } else {
        ForEach(['active', 'archived', 'all'], (filter: string) => {
          MenuItem({ content: this.filterLabel(filter), labelInfo: this.statusFilter === filter ? '✓' : '' })
            .onClick(() => { this.statusFilter = filter; })
        })
        MenuItem({ content: $r('app.string.refresh') }).onClick(() => this.run(() => this.workspace.reconnect()))
      }
    }
  }

  private filterLabel(value: string): ResourceStr {
    return value === 'active' ? $r('app.string.ready_tasks') : value === 'archived' ? $r('app.string.archived') : $r('app.string.all_tasks');
  }

  private panelTitle(): ResourceStr {
    switch (this.panel) {
      case 'hosts': case 'new-host': return $r('app.string.select_host');
      case 'settings': return $r('app.string.settings');
      case 'detail': return $r('app.string.task_info');
      case 'engines': return $r('app.string.engine');
      case 'projects': case 'path': case 'browse': return $r('app.string.workspace_label');
      case 'model': return $r('app.string.model');
      case 'permission': return $r('app.string.permission_mode');
      default: return this.creating ? $r('app.string.create_new') : this.view.shareLabel ? $r('app.string.choose_target') : this.headerTitle();
    }
  }

  private headerHint(): string {
    const resource = this.atHome() ? $r('app.string.select_host') : this.view.task && !this.panel ? $r('app.string.task_info') : undefined;
    return resource ? this.getUIContext().getHostContext()!.resourceManager.getStringSync(resource.id) : '';
  }

  private atHome(): boolean { return !this.panel && !this.selectedFile && !this.view.task && !this.creating; }

  @Builder
  header() {
    Row({ space: 4 }) {
      if (this.atHome()) {
        IconAction({ icon: $r('sys.symbol.line_3_horizontal'), controlId: 'navigation', label: $r('app.string.navigation'),
          onTap: () => { this.drawerOpen = true; } })
      } else {
        IconAction({ icon: $r('sys.symbol.chevron_left'), controlId: 'back', label: $r('app.string.back'),
          available: !this.busy, onTap: () => { this.onBackPress(); } })
      }
      Row({ space: 4 }) {
        Text(this.selectedFile ? $r('app.string.preview') : this.atHome() && !this.view.shareLabel ?
          (this.scope ? this.hostName(this.scope) : $r('app.string.all_hosts')) : this.panelTitle())
          .fontSize(18).lineHeight(24).fontWeight(FontWeight.Medium).maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis }).fontColor($r('app.color.ink')).constraintSize({ maxWidth: '88%' })
        if (this.atHome() && !this.view.shareLabel) { SymbolGlyph($r('sys.symbol.chevron_down')).fontSize(13) }
      }.id('header-title').accessibilityGroup(true)
        .accessibilityDescription(this.headerHint())
        .justifyContent(FlexAlign.Center).height(44).layoutWeight(1)
        .onClick(() => {
          if (this.atHome() && !this.view.shareLabel) this.panel = 'hosts';
          else if (this.view.task && !this.panel && !this.selectedFile) this.panel = 'detail';
        })
      if (!this.panel && !this.selectedFile && !this.creating) {
        Button({ type: ButtonType.Circle }) {
          if (this.view.task) {
            Row({ space: 3 }) {
              Circle().width(3).height(3).fill($r('app.color.ink'))
              Circle().width(3).height(3).fill($r('app.color.ink'))
              Circle().width(3).height(3).fill($r('app.color.ink'))
            }.accessibilityLevel('no')
          }
          else { SymbolGlyph($r('sys.symbol.slider_horizontal_2')).fontSize(21).fontColor([$r('app.color.ink')]) }
        }.id('account-menu').width(44).height(44).backgroundColor(Color.Transparent).enabled(!this.busy)
          .accessibilityText(this.view.task ? $r('app.string.task_info') : $r('app.string.display_options')).bindMenu(this.headerMenu)
      } else { Blank().width(44) }
    }.width('100%').height(48)
  }

  @Builder
  option(label: ResourceStr, value: ResourceStr, action: () => void, control: string) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 12 }) {
        Text(label).fontSize(15).fontColor($r('app.color.ink'))
        Blank()
        Text(value).fontSize(14).fontColor($r('app.color.muted')).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).constraintSize({ maxWidth: '60%' })
        SymbolGlyph($r('sys.symbol.chevron_right')).fontSize(12).fontColor([$r('app.color.faint')])
      }.width('100%').padding({ left: 12, right: 12 })
    }.id(control).height(48).width('100%').borderRadius(8).backgroundColor($r('app.color.panel')).onClick(action)
  }

  @Builder
  infoRow(label: Resource, value: ResourceStr) {
    Row({ space: 12 }) {
      Text(label).fontSize(14).fontColor($r('app.color.muted')).width(84)
      Text(value).layoutWeight(1).fontSize(15).fontColor($r('app.color.ink')).copyOption(CopyOptions.InApp)
    }.width('100%').constraintSize({ minHeight: 44 }).padding({ left: 12, right: 12 })
  }

  @Builder
  drawer() {
    Stack({ alignContent: Alignment.Start }) {
      Button({ type: ButtonType.Normal }) {}
        .width('100%').height('100%').backgroundColor($r('app.color.scrim')).accessibilityText($r('app.string.close'))
        .onClick(() => { this.drawerOpen = false; })
      Column({ space: 8 }) {
        Row({ space: 8 }) {
          Text(this.view.account).layoutWeight(1).fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink')).maxLines(1)
          IconAction({ icon: $r('sys.symbol.xmark'), label: $r('app.string.close'), onTap: () => { this.drawerOpen = false; } })
        }.width('100%').padding({ left: 12 })
        this.option($r('app.string.tasks'), '', () => { this.drawerOpen = false; }, 'drawer-home')
        this.option($r('app.string.select_host'), this.scope ? this.hostName(this.scope) : $r('app.string.all_hosts'), () => {
          this.drawerOpen = false; this.panel = 'hosts';
        }, 'scope')
        Blank().layoutWeight(1)
        this.option($r('app.string.settings'), '', () => { this.drawerOpen = false; this.panel = 'settings'; }, 'settings')
      }.width('82%').constraintSize({ maxWidth: 340 }).height('100%').backgroundColor($r('app.color.panel'))
        .padding({ top: this.topInset + 8, left: 12, right: 12, bottom: this.bottomInset + 8 })
    }.width('100%').height('100%')
  }

  @Builder
  settings() {
    Column({ space: 12 }) {
      this.infoRow($r('app.string.account_label'), this.view.account)
      Column({ space: 4 }) {
        Row({ space: 8 }) {
          Text($r('app.string.notification_settings')).layoutWeight(1).fontSize(16).fontColor($r('app.color.ink'))
          ForEach([this.toggleGeneration], (generation: number) => {
            Toggle({ type: ToggleType.Switch, isOn: this.view.pushEnabled }).id('push-switch').enabled(!this.busy)
            .selectedColor($r('app.color.action')).accessibilityText($r('app.string.notification_settings'))
            .onChange((enable: boolean) => {
              if (enable !== this.view.pushEnabled) this.run(async () => {
                await this.workspace.changePush(enable); this.toggleGeneration++;
              });
            })
          }, (generation: number) => generation.toString())
        }.width('100%').height(48).padding({ left: 12, right: 12 })
        if (this.view.pushStatus) { Text(this.view.pushStatus).fontSize(14).fontColor($r('app.color.muted')).padding(6) }
        this.option($r('app.string.settings_notifications'), '', () => this.run(() => this.workspace.notificationSettings()), 'system-notifications')
      }.width('100%').backgroundColor($r('app.color.panel')).borderRadius(12)
      Blank().layoutWeight(1)
      PillAction({ label: $r('app.string.sign_out'), onTap: () => this.run(async () => {
        await this.workspace.logout(); this.phone = ''; this.org = ''; this.otp = ''; this.consent = false; this.codeSent = false; this.enterprise = false;
      }) })
    }.width('100%').layoutWeight(1).padding(8)
  }

  @Builder
  directory() {
    if (this.panel === 'settings') { this.settings() }
    else if (this.panel === 'hosts' || this.panel === 'new-host') {
      List() {
        if (this.panel === 'hosts') {
          ListItem() { this.option($r('app.string.all_hosts'), this.scope ? '' : '✓', () => { this.scope = ''; this.panel = ''; }, 'all-hosts') }
        }
        ForEach(this.view.devices, (item: Item) => {
          ListItem() { DirectoryRow({ title: this.deviceLabel(item), targetId: item.id, computer: true, offline: !!item.offline,
            open: () => this.run(() => this.chooseHost(item.id)) }) }
        }, (item: Item) => item.id)
      }.layoutWeight(1).width('100%')
    } else if (this.panel === 'engines') {
      this.option($r('app.string.host_default'), this.engine ? '' : '✓', () => { this.engine = ''; this.panel = ''; }, 'engine-default')
      ForEach(this.engineOptions, (id: string) => {
        this.option(id, id === this.engine ? '✓' : '', () => { this.engine = id; this.panel = ''; }, 'engine-' + id)
      })
    } else if (this.panel === 'projects') {
      this.option($r('app.string.dialogue'), this.project ? '' : '✓', () => { this.project = ''; this.panel = ''; }, 'dialogue')
      this.option($r('app.string.browse_computer'), '', () => this.run(() => this.browse(this.project || '~')), 'browse-computer')
      this.option($r('app.string.other_path'), '', () => { this.pathInput = this.project; this.panel = 'path'; }, 'choose-path')
      List() {
        ForEach(Array.from(new Set(this.view.tasks.map((t: Item) => t.project || '').filter((p: string) => !!p))), (path: string) => {
          ListItem() { DirectoryRow({ title: this.basename(path), subtitle: path, open: () => { this.project = path; this.panel = ''; } }) }
        })
      }.layoutWeight(1).width('100%')
    } else if (this.panel === 'browse') {
      this.infoRow($r('app.string.workspace_label'), this.folders.path)
      if (this.folders.parent) { this.option($r('app.string.parent_folder'), '', () => this.run(() => this.browse(this.folders.parent)), 'parent-folder') }
      List() {
        ForEach(this.folders.rows, (dir: Item) => {
          ListItem() { DirectoryRow({ title: dir.title, targetId: dir.id, open: () => this.run(() => this.browse(dir.id)) }) }
        }, (dir: Item) => dir.id)
      }.layoutWeight(1).width('100%')
      PillAction({ label: $r('app.string.use_path'), prominent: true, onTap: () => { this.project = this.folders.path; this.panel = ''; } })
    } else if (this.panel === 'path') {
      TextInput({ placeholder: $r('app.string.workspace_path'), text: this.pathInput }).id('project-dir').onChange((v: string) => { this.pathInput = v; })
      PillAction({ label: $r('app.string.use_path'), available: !!this.pathInput.trim(), onTap: () => { this.project = this.pathInput.trim(); this.panel = ''; } })
    } else if (this.creating) {
      this.option($r('app.string.computer'), this.hostName(this.view.device) || $r('app.string.select_host'), () => { this.panel = 'new-host'; }, 'new-task-host')
      this.option($r('app.string.engine'), this.engine || $r('app.string.host_default'), () => this.run(() => this.showChoices('engines')), 'new-task-engine')
      this.option($r('app.string.workspace_label'), this.project ? this.basename(this.project) : $r('app.string.dialogue'), () => { this.panel = 'projects'; }, 'new-task-project')
      Blank().layoutWeight(1)
      this.composer()
    } else {
      Search({ placeholder: $r('app.string.search_task'), value: this.query }).id('search-tasks').height(40)
        .cancelButton({ style: CancelButtonStyle.INPUT }).onChange((v: string) => { this.query = v; })
      Stack({ alignContent: Alignment.BottomEnd }) {
        List({ space: 0 }) {
          ForEach(this.groups(), (group: HomeGroup) => {
            ListItem() { this.projectHeading(group.head) }
            if (!this.collapsed.includes(group.key) || !!this.query.trim()) {
              ForEach(group.rows, (item: Item) => {
                ListItem() {
                  Button({ type: ButtonType.Normal }) {
                    Row({ space: 9 }) {
                      Circle().width(6).height(6).fill(item.running && !this.hostOffline(item.host || '') ? $r('app.color.running') : $r('app.color.line'))
                      Text(item.title).layoutWeight(1).fontSize(15).lineHeight(22).maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis }).fontColor($r('app.color.ink'))
                      Text(this.hostOffline(item.host || '') ? $r('app.string.offline') : this.rowTime(item)).fontSize(12).fontColor($r('app.color.muted'))
                    }.padding({ left: 24, right: 6 }).width('100%')
                  }.id(item.id).constraintSize({ minHeight: 44 }).width('100%').backgroundColor(Color.Transparent).enabled(this.rowAvailable(item))
                    .onClick(() => this.run(async () => { await this.selectHost(item.host || ''); await this.workspace.openTask(item.id); }))
                }
              }, (item: Item) => (item.host || '') + '/' + item.id)
            }
          }, (g: HomeGroup) => g.key + JSON.stringify(g.rows))
          if (!this.homeRows().length) {
            ListItem() {
              Column({ space: 12 }) {
                Text(this.query.trim() ? $r('app.string.no_matches') : !this.view.devices.length ? $r('app.string.no_hosts') :
                  this.view.device && this.hostOffline(this.view.device) ? $r('app.string.offline_empty') : $r('app.string.no_tasks')).fontSize(15).fontColor($r('app.color.muted'))
                if (this.query.trim()) {
                  PillAction({ label: $r('app.string.clear_search'), onTap: () => { this.query = ''; } })
                } else if (!this.view.devices.length) {
                  PillAction({ label: $r('app.string.refresh'), onTap: () => this.run(() => this.workspace.devices()) })
                } else if (this.statusFilter !== 'active') {
                  PillAction({ label: $r('app.string.ready_tasks'), onTap: () => { this.statusFilter = 'active'; } })
                }
              }.width('100%').padding(24)
            }
          }
          if (this.view.moreTasks && this.view.linked && (!this.scope || this.scope === this.view.device)) {
            ListItem() { PillAction({ label: $r('app.string.more_tasks'), available: !this.busy, onTap: () => this.run(() => this.workspace.more()) }) }
          }
        }.width('100%').height('100%').contentEndOffset(76)
        if (this.view.devices.length) {
          Button({ type: ButtonType.Circle }) { SymbolGlyph($r('sys.symbol.square_and_pencil')).fontSize(23).fontColor([$r('app.color.on_action')]) }
            .id('new-task').width(56).height(56).margin({ right: 4, bottom: 12 }).backgroundColor($r('app.color.action'))
            .accessibilityText($r('app.string.create_new')).onClick(() => this.startNew())
        }
      }.layoutWeight(1).width('100%')
    }
  }

  @Builder
  projectHeading(group: Item) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 8 }) {
        SymbolGlyph($r('sys.symbol.folder')).fontSize(17).fontColor([$r('app.color.muted')])
        Text(group.project ? this.basename(group.project) : $r('app.string.dialogue')).fontSize(15).fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.ink')).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        if (!this.scope && this.view.devices.length > 1) { Text(this.hostName(group.host || '')).fontSize(12).fontColor($r('app.color.muted')).maxLines(1) }
        Blank()
        SymbolGlyph(this.collapsed.includes(this.groupKey(group)) ? $r('sys.symbol.chevron_right') : $r('sys.symbol.chevron_down')).fontSize(12)
      }.width('100%').padding({ left: 6, right: 6 })
    }.width('100%').height(44).backgroundColor(Color.Transparent).onClick(() => {
      const key = this.groupKey(group);
      this.collapsed = this.collapsed.includes(key) ? this.collapsed.filter((g: string) => g !== key) : this.collapsed.concat(key);
    })
  }

  @Builder
  errorNotice() {
    if (this.notice || this.view.error) {
      Text(this.notice || this.view.error).fontSize(14).lineHeight(20).fontColor($r('app.color.danger')).width('100%')
        .padding(8).backgroundColor($r('app.color.chip')).borderRadius(8).copyOption(CopyOptions.InApp)
    }
  }

  build() {
    Stack() {
      Column().width('100%').height('100%').backgroundColor(this.view.account ? $r('app.color.canvas') : $r('app.color.login_bg'))
        .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
      Column({ space: 6 }) {
      if (this.initializing) {
        Blank()
        LoginBrand({ stageWidth: this.loginWidth, stageHeight: this.availableHeight })
        LoadingProgress().width(22).height(22).color($r('app.color.muted')).accessibilityText($r('app.string.connecting'))
        Blank()
      } else if (!this.view.account) {
        this.login()
      } else {
        this.header()
        if (this.view.shareLabel && !this.panel) {
          Column({ space: 4 }) {
            if (this.view.shareText) { Text(this.view.shareText).maxLines(3).textOverflow({ overflow: TextOverflow.Ellipsis }).fontSize(15).fontColor($r('app.color.ink')) }
            if (this.view.shareFiles?.length) {
              Text($r('app.string.file_count', this.view.shareFiles.length)).fontSize(13).fontColor($r('app.color.muted'))
              Scroll() {
                Row({ space: 8 }) {
                  ForEach(this.view.shareFiles, (name: string, i: number) => {
                    Row({ space: 4 }) {
                      if (this.workspace.shareImage(i)) {
                        Image(this.workspace.shareImage(i)).width(42).height(42).borderRadius(6).objectFit(ImageFit.Cover)
                      } else { SymbolGlyph($r('sys.symbol.doc')).fontSize(20) }
                      Text(name).fontSize(13).maxLines(1).constraintSize({ maxWidth: 130 }).textOverflow({ overflow: TextOverflow.Ellipsis })
                    }.padding(6).backgroundColor($r('app.color.chip')).borderRadius(8)
                  }, (name: string, i: number) => i.toString() + name)
                }
              }.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).width('100%')
            }
            Flex({ wrap: FlexWrap.Wrap, alignItems: ItemAlign.Center, space: { main: LengthMetrics.vp(6) } }) {
              if (this.view.task) {
                PillAction({ label: $r('app.string.choose_target'), onTap: () => this.run(() => this.workspace.back()) })
                PillAction({ label: $r('app.string.share_draft'), available: !this.busy && this.view.linked, onTap: () => this.run(() => this.workspace.acceptShare()) })
              } else { Text($r('app.string.share_pick')).fontSize(14).fontColor($r('app.color.muted')).layoutWeight(1) }
              PillAction({ label: $r('app.string.share_drop'), onTap: () => this.workspace.dismissShare() })
            }
          }.width('100%').alignItems(HorizontalAlign.Start).padding(8).backgroundColor($r('app.color.panel')).borderRadius(12)
        }
        if (this.view.device && !this.view.linked) {
          PillAction({ label: $r('app.string.reconnect'), available: !this.busy && this.view.relay === 'online',
            onTap: () => this.run(() => this.workspace.reconnect()) })
        } else if (this.view.relay !== 'online') {
          Text($r('app.string.connecting')).fontSize(13).fontColor($r('app.color.muted'))
        }
        this.errorNotice()
        if (this.view.shareLabel && this.view.task && !this.panel) {
          this.infoRow($r('app.string.choose_target'), this.headerTitle())
        } else if (this.selectedFile) { this.filePreview() }
        else if (this.panel === 'detail') {
          this.infoRow($r('app.string.task'), this.headerTitle())
          this.infoRow($r('app.string.computer'), this.hostName(this.view.device))
          this.infoRow($r('app.string.workspace_label'), this.view.tasks.find((r: Item) => r.id === this.view.task)?.project || $r('app.string.dialogue'))
          if (this.view.agent) { this.infoRow($r('app.string.engine'), this.view.agent) }
          if (this.view.model) { this.infoRow($r('app.string.model'), this.view.model) }
          if (this.view.permission) { this.infoRow($r('app.string.permission_mode'), this.view.permission) }
        } else if (this.panel === 'model' || this.panel === 'permission') {
          List() {
            ForEach(this.choices, (opt: Item) => {
              ListItem() { DirectoryRow({ title: opt.title, subtitle: opt.summary || '', targetId: 'pref-' + opt.id,
                available: !this.busy && this.view.linked && !this.view.running, open: () => this.run(async () => {
                  await this.workspace.applyPreference(this.panel, opt.id); this.panel = '';
                }) }) }
            })
            if (!this.choices.length) { ListItem() { Text($r('app.string.no_choices')).fontColor($r('app.color.muted')).padding(16) } }
          }.layoutWeight(1).width('100%')
        } else if (this.view.task) { this.taskContent() } else { this.directory() }
      }
    }.padding({ left: this.view.account ? 16 : 0, right: this.view.account ? 16 : 0,
      top: this.topInset + (this.view.account ? 4 : 0), bottom: (this.keyboardShown ? 0 : this.bottomInset) + (this.view.account ? 8 : 0) }).width('100%').height('100%').onAreaChange((_: Area, area: Area) => { this.availableHeight = Number(area.height); if (this.initializing) this.loginWidth = Math.min(440, Number(area.width)); })
      if (this.drawerOpen && this.view.account) { this.drawer() }
    }.width('100%').height('100%').backgroundColor(this.view.account ? $r('app.color.canvas') : $r('app.color.login_bg'))
  }
}

@Extend(Button) function primaryLogin() {
  .width('100%').fontSize(16).fontWeight(FontWeight.Medium)
    .fontColor($r('app.color.on_action')).backgroundColor($r('app.color.action'))
}

@Extend(Text) function sectionTitle() {
  .fontSize(20).lineHeight(28).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink'))
}
