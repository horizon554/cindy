import { LengthMetrics, KeyboardAvoidMode as WindowKeyboardAvoidMode } from '@kit.ArkUI';
import { filePreview } from '@kit.PreviewKit';
import { common } from '@kit.AbilityKit';
import { installInputs } from '../services/nativeEntry';
import { LoginBrand } from './LoginBrand';
import { HistorySource } from './HistorySource';
import { HistoryMessage, InteractionPanel, MessageBody } from './TaskContent';
import { DirectoryRow, IconAction, PillAction } from './Controls';
import { Row as Item, Workspace, ViewState, Attachment, MediaInfo, Card } from '../services/workspace';

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
  @State panel: string = '';
  @State query: string = '';
  @State statusFilter: string = 'all';
  @State project: string = '';
  @State tallInput: boolean = false;
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
    this.historySource.replace(state.messages);
    if (state.device !== this.view.device || switched) this.creating = false;
    if (switched || state.device !== this.view.device || state.account !== this.view.account) {
      this.panel = ''; this.selectedFile = undefined; this.previewSource = ''; this.inputOpen = false; this.tallInput = false; this.cardIndex = 0;
      this.query = ''; this.project = ''; this.title = '';
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
    this.view = state;
    if (switched) { this.pulledHistory = false; this.followEnd = true; this.composing = false; }
    if (state.task && this.followEnd && (changed || switched)) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = setTimeout(() => {
        if (this.view.task === state.task && this.followEnd) this.scroll.scrollEdge(Edge.Bottom);
      }, 35);
    }
  }, true);

  aboutToAppear(): void {
    installInputs(this.workspace);
    this.getUIContext().setKeyboardAvoidMode(WindowKeyboardAvoidMode.RESIZE);
    this.run(async () => {
      try { await this.workspace.init(this.getUIContext().getHostContext() as common.UIAbilityContext); }
      finally { this.initializing = false; }
    });
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
    if (this.selectedFile) { this.selectedFile = undefined; this.previewSource = ''; return true; }
    if (this.panel) { this.panel = ''; return true; }
    if (!this.view.account && (this.codeSent || this.enterprise) && !this.view.ssoWaiting) {
      this.codeSent = false; this.enterprise = false; this.otp = ''; this.notice = ''; this.workspace.clearMethods(); return true;
    }
    if (this.creating) { this.creating = false; this.title = ''; return true; }
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
    this.selectedFile = file; this.previewSource = '';
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

  @Builder
  filePreview() {
    Column({ space: 12 }) {
      Text(this.selectedFile?.name || '').fontSize(18).fontWeight(FontWeight.Medium)
      if (this.previewSource && this.selectedFile?.mimeType?.startsWith('image/')) {
        Image(this.previewSource).width('100%').layoutWeight(1).objectFit(ImageFit.Contain)
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
    return this.inputOpen || !!this.view.transfer || !!this.view.voice;
  }

  private foldComposer(): void {
    this.inputOpen = false; this.tallInput = false;
    this.getUIContext().getFocusController().clearFocus();
  }

  @Builder
  composer() {
    Column({ space: 3 }) {
      if (this.expanded()) {
        Button({ type: ButtonType.Normal }) {
          Divider().width(32).strokeWidth(3).color($r('app.color.line'))
        }.height(20).width(68).backgroundColor(Color.Transparent).accessibilityText($r('app.string.collapse_input'))
          .onClick(() => this.foldComposer())
          .gesture(PanGesture({ direction: PanDirection.Vertical }).onActionEnd((e: GestureEvent) => {
            if (e.offsetY < -12) this.tallInput = true;
            else if (e.offsetY > 12) { if (this.tallInput) this.tallInput = false; else this.foldComposer(); }
          }))
      }
      if (this.view.attachments.length && this.expanded()) {
        Scroll() {
          Row({ space: 6 }) {
            ForEach(this.view.attachments, (f: Attachment) => {
              Row({ space: 2 }) {
                Button({ type: ButtonType.Normal }) {
                  Row({ space: 6 }) {
                    if (f.mimeType?.startsWith('image/') && this.workspace.localPreview(f.id)) {
                      Image(this.workspace.localPreview(f.id)).width(34).height(34).borderRadius(4)
                    } else { SymbolGlyph($r('sys.symbol.doc')).fontSize(18) }
                    Text(f.name).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).constraintSize({ maxWidth: 146 })
                      .fontSize(14).fontColor($r('app.color.ink'))
                  }
                }.id('preview-' + f.id).backgroundColor(Color.Transparent).height(44).onClick(() => this.run(() => this.showPreview(f, this.workspace.localPreview(f.id))))
                IconAction({ icon: $r('sys.symbol.xmark'), label: $r('app.string.remove_file', f.name), controlId: 'remove-' + f.id,
                  available: !this.busy, onTap: () => this.run(() => this.workspace.removeFile(f.id)) })
              }.padding({ left: 8 }).backgroundColor($r('app.color.chip')).borderRadius(8)
            }, (f: Attachment) => f.id)
          }
        }.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).align(Alignment.Start).width('100%').height(46)
      }
      Row({ space: 4 }) {
      if (!this.expanded()) {
        if (this.view.attachments.length) {
          Button(this.view.attachments.length.toString()).height(40).onClick(() => { this.inputOpen = true; })
        }
        IconAction({ icon: $r('sys.symbol.plus'), label: $r('app.string.add_file'), controlId: 'compact-add',
          available: this.view.linked, menuItems: this.attachmentMenu() })
      }
      TextArea({ placeholder: $r('app.string.message'), text: this.view.draft }).id('composer').layoutWeight(1).maxLines(this.expanded() ? (this.tallInput ? 12 : 6) : 1)
        .onFocus(() => { this.inputOpen = true; })
        .fontSize(16).fontColor($r('app.color.ink')).backgroundColor(Color.Transparent)
        .padding({ left: 10, right: 10, top: 7, bottom: 3 }).constraintSize({ minHeight: this.tallInput ? 120 : 36, maxHeight: this.expanded() ? (this.tallInput ? 240 : 144) : 44 })
        .onChange((value: string, preview?: PreviewText) => {
          this.composing = !!preview?.value;
          if (!this.composing) this.workspace.editDraft(value);
        })
        if (!this.expanded()) {
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
      if (this.expanded() || this.view.paused) {
      Row({ space: 2 }) {
        if (this.view.transfer) {
          Text(this.view.transfer).fontSize(14).fontColor($r('app.color.muted')).layoutWeight(1)
          PillAction({ label: $r('app.string.cancel_file'), onTap: () => this.workspace.cancelTransfer() })
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
          if (this.view.taskContext) {
            Text(this.view.taskContext).layoutWeight(1).fontSize(13).lineHeight(18).fontColor($r('app.color.muted'))
              .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).onClick(() => { this.panel = 'detail'; })
          } else { Blank() }
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
    }.width('100%').alignItems(HorizontalAlign.Center).padding(this.expanded() ? 8 : 3).borderWidth(1)
      .borderColor($r('app.color.line')).borderRadius(this.expanded() ? 18 : 30).backgroundColor($r('app.color.panel'))
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
      }).onScrollStop(() => { this.pulledHistory = false; }).onReachEnd(() => { this.followEnd = true; })
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
      }, (card: Card) => card.id)
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

  aboutToDisappear(): void { clearInterval(this.resendTimer); clearInterval(this.voiceTimer); clearTimeout(this.scrollTimer); }

  @Builder
  loginForm() {
    if (this.enterprise) {
      Text($r('app.string.sso_org')).sectionTitle()
      Text($r('app.string.org_hint')).fontSize(14).lineHeight(20).fontColor($r('app.color.muted'))
      TextInput({ placeholder: $r('app.string.org_id'), text: this.org }).id('org').enabled(!this.busy)
        .onChange((value: string) => { this.org = value; this.workspace.clearMethods(); })
      Button($r('app.string.next_step')).primaryLogin().enabled(!this.busy && !!this.org.trim())
        .onClick(() => this.run(() => this.workspace.discover(this.org)))
      ForEach(this.view.ssoMethods, (item: Item) => {
        PillAction({ label: item.title, available: !this.busy, onTap: () => this.run(() => this.workspace.startSSO(item.id)) })
      }, (item: Item) => item.id)
    } else {
      Text(this.codeSent ? $r('app.string.phone_code_title') : $r('app.string.app_login')).sectionTitle()
      if (this.codeSent) {
        Text('+86 ' + this.phone).fontSize(14).fontColor($r('app.color.muted'))
        TextInput({ placeholder: $r('app.string.sms'), text: this.otp }).id('otp').type(InputType.Number)
          .maxLength(8).onChange((v: string) => { this.otp = v; })
      } else {
        Row({ space: 4 }) {
          Text('+86').fontSize(16).fontWeight(FontWeight.Medium)
          TextInput({ placeholder: $r('app.string.phone'), text: this.phone }).id('phone').type(InputType.PhoneNumber)
            .layoutWeight(1).backgroundColor(Color.Transparent).maxLength(11)
            .onChange((value: string) => { this.phone = value; this.otp = ''; })
        }.height(46).padding({ left: 16, right: 8 }).borderRadius(24).backgroundColor($r('app.color.chip'))
      }
      Button(this.codeSent ? $r('app.string.sign_in') : $r('app.string.next_step')).primaryLogin()
        .enabled(!this.busy && /^1[3-9][0-9]{9}$/.test(this.phone) && (!this.codeSent || !!this.otp.trim()))
        .onClick(() => this.submitPhone())
      if (this.codeSent) {
        PillAction({ label: this.resend ? $r('app.string.again_in', this.resend) : $r('app.string.new_code'),
          available: !this.busy && !this.resend, onTap: () => this.run(() => this.requestCode()) })
      }
    }
  }

  @Builder
  login() {
    Scroll() {
      Column({ space: 0 }) {
        LoginBrand({ stageWidth: this.loginWidth, stageHeight: this.loginHeight })
        Column({ space: 16 }) {
          if ((this.enterprise || this.codeSent) && !this.view.ssoWaiting && !this.view.accounts.length && !this.view.verification) {
            IconAction({ icon: $r('sys.symbol.chevron_left'), label: $r('app.string.back'), onTap: () => { this.onBackPress(); } })
              .alignSelf(ItemAlign.Start)
          }
          if (this.view.ssoWaiting) {
            LoadingProgress().width(28).height(28)
            Text($r('app.string.sso_wait')).sectionTitle()
            PillAction({ label: $r('app.string.sso_cancel'), onTap: () => this.run(() => this.workspace.cancelSSO()) })
          } else if (this.view.verification) {
            Text($r('app.string.verify_for', this.view.verification)).sectionTitle()
            PillAction({ label: $r('app.string.get_code'), onTap: () => this.run(() => this.workspace.verificationCode()) })
            TextInput({ placeholder: $r('app.string.code'), text: this.otp }).onChange((v: string) => { this.otp = v; })
            Button($r('app.string.verify')).primaryLogin().enabled(!this.busy && !!this.otp)
              .onClick(() => this.run(async () => { await this.workspace.verifyOrganization(this.otp); this.otp = ''; }))
          } else if (this.view.accounts.length) {
            Text($r('app.string.choose_account')).sectionTitle()
            ForEach(this.view.accounts, (item: Item) => {
              DirectoryRow({ title: item.title, targetId: item.id, available: !this.busy, open: () => this.run(() => this.workspace.choose(item.id)) })
            }, (item: Item) => item.id)
          } else { this.loginForm() }
          this.errorNotice()
        }.padding(24).width('90.7%').borderRadius(16).backgroundColor($r('app.color.login_card'))
        if (!this.enterprise && !this.codeSent && !this.view.verification && !this.view.accounts.length && !this.view.ssoWaiting) {
          Button('SSO', { type: ButtonType.Circle }).width(44).height(44).fontSize(13).margin({ top: 8 })
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
    await this.selectHost(id);
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
    return rows.filter((r: Item) => (this.statusFilter === 'all' || (r.status === 'archived') === (this.statusFilter === 'archived')) &&
      (r.title + ' ' + (r.project || '') + ' ' + (r.summary || '')).toLowerCase().includes(this.query.trim().toLowerCase()));
  }

  private rowSubtitle(item: Item): string {
    const parts: string[] = [];
    if (this.view.devices.length > 1) parts.push(this.hostName(item.host || ''));
    if (item.updated) {
      const date = new Date(item.updated);
      if (Number.isFinite(date.getTime())) {
        parts.push(date.toDateString() === new Date().toDateString() ?
          date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0') :
          (date.getMonth() + 1).toString() + '/' + date.getDate().toString());
      }
    }
    if (item.summary) parts.push(item.summary);
    return parts.filter((part: string) => !!part).join(' · ');
  }

  private groups(): string[] {
    return Array.from(new Set(this.homeRows().map((r: Item) => r.project || '')));
  }

  private hostName(id: string): string {
    const host = this.view.devices.find((r: Item) => r.id === id);
    return host ? this.deviceLabel(host) : '';
  }

  private async newTask(): Promise<void> {
    const text = this.title.trim();
    if (!this.view.shareLabel && !text) return;
    const sharing = !!this.view.shareLabel;
    const created = await this.workspace.create('', this.project.trim(), sharing ? '' : text);
    if (created && sharing && this.view.shareLabel && this.view.task) {
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
        MenuItem({ content: $r('app.string.select_host') }).onClick(() => { this.panel = 'hosts'; })
        MenuItem({ content: $r('app.string.refresh') }).onClick(() => this.run(() => this.workspace.reconnect()))
        MenuItem({ content: $r('app.string.settings') }).onClick(() => { this.panel = 'settings'; })
      }
    }
  }

  @Builder
  header() {
    Row({ space: 8 }) {
      if (this.view.task || this.panel || this.creating || this.selectedFile) {
        IconAction({ icon: $r('sys.symbol.chevron_left'), controlId: 'back', label: $r('app.string.back'),
          available: !this.busy, onTap: () => { this.onBackPress(); } })
      }
      Column({ space: 1 }) {
        Text(this.selectedFile ? $r('app.string.preview') : this.panel === 'settings' ? $r('app.string.settings') :
          (this.panel === 'hosts' || this.panel === 'new-host') ? $r('app.string.select_host') : this.panel === 'detail' ? $r('app.string.task_info') :
          this.creating ? $r('app.string.create_new') : this.view.task ? this.headerTitle() :
          this.view.shareLabel ? $r('app.string.choose_target') : $r('app.string.tasks'))
          .fontSize(20).lineHeight(28).fontWeight(FontWeight.Medium).maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis }).fontColor($r('app.color.ink'))
        if (this.view.device && !this.panel && this.view.task) {
          Text(this.hostName(this.view.device)).fontSize(13).lineHeight(18).fontColor($r('app.color.muted'))
        }
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      if (!this.panel && !this.selectedFile && !this.creating) {
        if (this.view.linked && !this.view.task) {
          IconAction({ icon: $r('sys.symbol.plus'), controlId: 'new-task', label: $r('app.string.create_new'), available: !this.busy,
            onTap: () => { this.creating = true; this.title = ''; this.project = ''; } })
        }
        Button({ type: ButtonType.Circle }) {
          SymbolGlyph($r('sys.symbol.more')).fontSize(22).fontColor([$r('app.color.ink')]).accessibilityLevel('no')
        }.id('account-menu').width(44).height(44).backgroundColor(Color.Transparent).enabled(!this.busy)
          .accessibilityText(this.view.task ? $r('app.string.task_info') : $r('app.string.account_options')).bindMenu(this.headerMenu)
      }
    }.width('100%').constraintSize({ minHeight: 48 })
  }

  @Builder
  settings() {
    Column({ space: 12 }) {
      Text(this.view.account).sectionTitle()
      Row({ space: 8 }) {
        Text($r('app.string.notification_settings')).layoutWeight(1).fontSize(16)
        PillAction({ label: this.view.pushEnabled ? $r('app.string.disable_notifications') : $r('app.string.enable_notifications'),
          available: !this.busy, onTap: () => this.run(() => this.workspace.changePush(!this.view.pushEnabled)) })
      }.width('100%')
      if (this.view.pushStatus) { Text(this.view.pushStatus).fontSize(14).lineHeight(20).fontColor($r('app.color.muted')) }
      PillAction({ label: $r('app.string.settings_notifications'), onTap: () => this.run(() => this.workspace.notificationSettings()) })
      PillAction({ label: $r('app.string.sign_out'), onTap: () => this.run(async () => {
        await this.workspace.logout(); this.phone = ''; this.org = ''; this.otp = ''; this.consent = false; this.codeSent = false; this.enterprise = false;
      }) })
    }.width('100%').padding(12)
  }

  @Builder
  directory() {
    if (this.panel === 'settings') { this.settings() }
    else if (this.panel === 'hosts' || this.panel === 'new-host') {
      List() {
        ForEach(this.view.devices, (item: Item) => {
          ListItem() { DirectoryRow({ title: this.deviceLabel(item), targetId: item.id, computer: true, offline: !!item.offline,
            open: () => this.run(() => this.chooseHost(item.id)) }) }
        }, (item: Item) => item.id)
      }.layoutWeight(1).width('100%')
    } else if (this.creating) {
      DirectoryRow({ title: this.hostName(this.view.device), targetId: 'new-task-host', computer: true,
        open: () => { this.panel = 'new-host'; } })
      TextInput({ placeholder: $r('app.string.workspace_path'), text: this.project }).id('project-dir')
        .onChange((v: string) => { this.project = v; })
      TextArea({ placeholder: $r('app.string.first_input'), text: this.title }).id('first-message').height(130)
        .onChange((v: string) => { this.title = v; })
      PillAction({ label: this.view.shareLabel ? $r('app.string.share_new') : $r('app.string.send'), prominent: true,
        available: !this.busy && this.view.linked && (!!this.title.trim() || !!this.view.shareLabel), onTap: () => this.run(() => this.newTask()) })
    } else {
      if (!this.view.device && this.view.devices.length) {
        PillAction({ label: $r('app.string.select_host'), onTap: () => { this.panel = 'hosts'; } })
      }
      TextInput({ placeholder: $r('app.string.search_task'), text: this.query }).id('search-tasks')
        .onChange((v: string) => { this.query = v; })
      Row({ space: 6 }) {
        ForEach(['all', 'active', 'archived'], (v: string) => {
          PillAction({ label: v === 'all' ? $r('app.string.all_tasks') : v === 'active' ? $r('app.string.ready_tasks') : $r('app.string.archived'),
            prominent: this.statusFilter === v, onTap: () => { this.statusFilter = v; } })
        })
      }.alignSelf(ItemAlign.Start)
      List({ space: 3 }) {
        ForEach(this.groups(), (group: string) => {
          ListItemGroup({ header: this.projectHeading(group) }) {
            ForEach(this.homeRows().filter((r: Item) => (r.project || '') === group), (item: Item) => {
              ListItem() { DirectoryRow({ title: item.title, subtitle: this.rowSubtitle(item),
                running: !!item.running && item.host === this.view.device && this.view.linked,
                offline: this.hostOffline(item.host || ''), targetId: item.id, available: !this.busy, open: () => this.run(async () => {
                  await this.selectHost(item.host || ''); await this.workspace.openTask(item.id);
                }) }) }
            }, (item: Item) => (item.host || '') + '/' + item.id)
          }
        }, (g: string) => g)
        if (!this.homeRows().length) {
          ListItem() { Text(this.query ? $r('app.string.no_matches') : $r('app.string.no_tasks')).fontSize(15).fontColor($r('app.color.muted')).padding(12) }
        }
        if (this.view.moreTasks && this.view.linked) {
          ListItem() { PillAction({ label: $r('app.string.more_tasks'), available: !this.busy, onTap: () => this.run(() => this.workspace.more()) }) }
        }
      }.layoutWeight(1).width('100%')
    }
  }

  @Builder
  projectHeading(group: string) {
    Text(group ? group.split(/[\\/]/).filter((s: string) => !!s).pop() || group : $r('app.string.dialogue'))
      .fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.muted')).padding(8)
  }

  @Builder
  errorNotice() {
    if (this.notice || this.view.error) {
      Text(this.notice || this.view.error).fontSize(14).lineHeight(20).fontColor($r('app.color.danger')).width('100%')
        .padding(8).backgroundColor($r('app.color.chip')).borderRadius(8).copyOption(CopyOptions.InApp)
    }
  }

  build() {
    Column({ space: 6 }) {
      if (this.initializing) {
        Blank(); Image($r('app.media.login_hero')).width(128).height(128).objectFit(ImageFit.Contain).accessibilityText('Cindy'); Blank()
      } else if (!this.view.account) {
        this.login()
      } else {
        this.header()
        if (this.view.shareLabel) {
          Column({ space: 4 }) {
            Text($r('app.string.share_title', this.view.shareLabel)).maxLines(3).fontSize(14).fontColor($r('app.color.ink'))
            Flex({ wrap: FlexWrap.Wrap, alignItems: ItemAlign.Center, space: { main: LengthMetrics.vp(6) } }) {
              if (this.view.task) {
                PillAction({ label: $r('app.string.choose_target'), onTap: () => this.run(() => this.workspace.back()) })
                PillAction({ label: $r('app.string.share_draft'), available: !this.busy, onTap: () => this.run(() => this.workspace.acceptShare()) })
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
        if (this.selectedFile) { this.filePreview() }
        else if (this.panel === 'detail') {
          Text(this.headerTitle()).sectionTitle()
          Text(this.hostName(this.view.device)).fontSize(15)
          if (this.view.taskContext) { Text(this.view.taskContext).fontSize(14).lineHeight(20) }
          Text(this.view.tasks.find((r: Item) => r.id === this.view.task)?.project || $r('app.string.dialogue')).fontSize(14)
        } else if (this.view.task) { this.taskContent() } else { this.directory() }
      }
    }.padding(this.view.account ?  { left: 14, right: 14, top: 6, bottom: 6 } : 0).width('100%').height('100%').backgroundColor(this.initializing ? $r('app.color.brand_splash') : this.view.account ? $r('app.color.canvas') : $r('app.color.login_bg'))
  }
}

@Extend(Button) function primaryLogin() {
  .width('100%').constraintSize({ minHeight: 48 }).fontSize(16).fontWeight(FontWeight.Medium)
    .fontColor($r('app.color.on_action')).backgroundColor($r('app.color.action'))
}

@Extend(Text) function sectionTitle() {
  .fontSize(20).lineHeight(28).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink'))
}
