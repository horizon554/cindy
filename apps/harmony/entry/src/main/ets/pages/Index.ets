import { KeyboardAvoidMode as WindowKeyboardAvoidMode } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { installInputs } from '../services/nativeEntry';
import { HistorySource } from './HistorySource';
import { HistoryMessage, InteractionPanel } from './TaskContent';
import { DirectoryRow, IconAction, PillAction } from './Controls';
import { Row as Item, Workspace, ViewState, Attachment, Card } from '../services/workspace';

@Entry
@Component
struct Index {
  @State view: ViewState = { retryable: false, attachments: [], voice: '', transfer: '', pushStatus: '', pushEnabled: false,
    shareLabel: '', cards: [], activity: '', delivery: '', draft: '', linked: false, paused: false, moreTasks: false,
    hasOlder: false, running: false, ssoWaiting: false, ssoMethods: [], verification: '', accounts: [], account: '',
    relay: '', devices: [], tasks: [], messages: [], live: '', device: '', task: '', error: '' };
  @State phone: string = '';
  @State enterprise: boolean = false;
  @State org: string = '';
  @State otp: string = '';
  @State creating: boolean = false;
  @State title: string = '';
  @State composing: boolean = false;
  @State busy: boolean = false;
  @State notice: string = '';
  @State codeSent: boolean = false;
  @State consent: boolean = false;
  private historySource: HistorySource = new HistorySource();
  private scroll: Scroller = new Scroller();
  private followEnd: boolean = true;
  private scrollTimer: number = -1;
  private workspace: Workspace = new Workspace((state: ViewState) => {
    const switched = state.task !== this.view.task;
    const changed = state.messages.length !== this.view.messages.length || state.live !== this.view.live;
    this.historySource.replace(state.messages);
    if (state.device !== this.view.device || switched) this.creating = false;
    this.view = state;
    if (switched) { this.followEnd = true; this.composing = false; }
    if (state.task && this.followEnd && (changed || switched)) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = setTimeout(() => {
        if (this.view.task === state.task && this.followEnd) this.scroll.scrollEdge(Edge.Bottom);
      }, 35);
    }
  });

  aboutToAppear(): void {
    installInputs(this.workspace);
    this.getUIContext().setKeyboardAvoidMode(WindowKeyboardAvoidMode.RESIZE);
    this.run(() => this.workspace.init(this.getUIContext().getHostContext() as common.UIAbilityContext));
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
    if (this.creating) { this.creating = false; this.title = ''; return true; }
    if (!this.view.device) return false;
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

  @Builder
  composer() {
    Column({ space: 3 }) {
      if (this.view.delivery) {
        PillAction({ label: this.view.retryable ? $r('app.string.retry_last') : $r('app.string.verify_delivery'),
          available: !this.busy && this.view.linked,
          onTap: () => this.run(() => this.view.retryable ? this.workspace.retryOriginal() : this.workspace.checkDelivery()) })
      }
      if (this.view.attachments.length) {
        Scroll() {
          Row({ space: 6 }) {
            ForEach(this.view.attachments, (f: Attachment) => {
              Button({ type: ButtonType.Capsule }) {
                Row({ space: 6 }) {
                  Text(f.name).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).constraintSize({ maxWidth: 160 })
                    .fontSize(14).fontColor($r('app.color.ink'))
                  SymbolGlyph($r('sys.symbol.xmark')).fontSize(12).fontColor([$r('app.color.muted')])
                }.padding({ left: 12, right: 12 })
              }.height(44).backgroundColor($r('app.color.chip')).accessibilityText($r('app.string.remove_file', f.name))
                .enabled(!this.busy).onClick(() => this.run(() => this.workspace.removeFile(f.id)))
            }, (f: Attachment) => f.id)
          }
        }.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).align(Alignment.Start).width('100%').height(46)
      }
      TextArea({ placeholder: $r('app.string.message'), text: this.view.draft }).id('composer').maxLines(3)
        .fontSize(16).fontColor($r('app.color.ink')).backgroundColor(Color.Transparent)
        .padding({ left: 10, right: 10, top: 7, bottom: 3 }).constraintSize({ minHeight: 36, maxHeight: 80 })
        .onChange((value: string, preview?: PreviewText) => {
          this.composing = !!preview?.value;
          if (!this.composing) this.workspace.editDraft(value);
        })
      Row({ space: 2 }) {
        if (this.view.transfer) {
          Text(this.view.transfer).fontSize(14).fontColor($r('app.color.muted')).layoutWeight(1)
          PillAction({ label: $r('app.string.cancel_file'), onTap: () => this.workspace.cancelTransfer() })
        } else if (this.view.voice) {
          Text(this.view.voice).fontSize(14).fontColor($r('app.color.ink')).layoutWeight(1)
          IconAction({ icon: $r('sys.symbol.xmark'), label: $r('app.string.voice_cancel'), controlId: 'cancel-voice',
            onTap: () => this.workspace.cancelVoice() })
          IconAction({ icon: $r('sys.symbol.checkmark'), label: $r('app.string.voice_finish'), controlId: 'finish-voice',
            prominent: true, onTap: () => this.workspace.finishVoice() })
        } else {
          IconAction({ icon: $r('sys.symbol.plus'), label: $r('app.string.add_file'), controlId: 'add-attachment',
            available: !this.busy && this.view.linked,
            menuItems: [{ value: $r('app.string.image'), action: () => this.run(async () => { await this.workspace.addFile('image'); }) },
              { value: $r('app.string.file'), action: () => this.run(async () => { await this.workspace.addFile('file'); }) }] })
          IconAction({ icon: $r('sys.symbol.mic'), label: $r('app.string.voice'), controlId: 'voice', available: !this.busy,
            onTap: () => { this.notice = ''; this.workspace.startVoice(); } })
          Blank()
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
    }.width('100%').alignItems(HorizontalAlign.Start).padding(6).borderWidth(1)
      .borderColor($r('app.color.line')).borderRadius(12).backgroundColor($r('app.color.panel'))
  }

  @Builder
  taskContent() {
    if (this.view.hasOlder && this.view.linked) {
      PillAction({ label: $r('app.string.older'), available: !this.busy,
        onTap: () => this.run(async () => { this.followEnd = false; await this.workspace.older(); }) })
    }
    List({ space: 14, scroller: this.scroll }) {
      LazyForEach(this.historySource, (item: Item) => {
        ListItem() { HistoryMessage({ item: item }) }
      }, (item: Item) => item.id + item.title)
      if (this.view.live) {
        ListItem() { Text(this.view.live).fontSize(16).lineHeight(24).fontColor($r('app.color.ink')).copyOption(CopyOptions.InApp) }
      }
    }.id('history').layoutWeight(1).width('100%').maintainVisibleContentPosition(true)
      .onScrollFrameBegin((offset: number, state: ScrollState) => {
        if (state === ScrollState.Scroll && offset < 0) this.followEnd = false;
        return { offsetRemain: offset };
      }).onReachEnd(() => { this.followEnd = true; })
    if (this.view.cards.length) {
      Scroll() {
        Column({ space: 8 }) {
          ForEach(this.view.cards, (card: Card) => {
            InteractionPanel({ card: card, available: !this.busy && this.view.linked,
              edit: (key: string, value: string, selected: boolean) => this.workspace.editAnswer(card.id, key, value, selected),
              decide: (choice: string) => this.run(() => this.workspace.decide(card.id, choice)) })
          }, (card: Card) => card.id + '/' + card.revision.toString())
        }.width('100%')
      }.id('interactions').width('100%').constraintSize({ maxHeight: '36%' })
    }
    if (this.view.running) {
      Text(this.view.activity || $r('app.string.working')).fontSize(13).fontColor($r('app.color.muted')).maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis }).alignSelf(ItemAlign.Start)
    }
    this.composer()
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
    }.width('100%')
  }

  @Builder
  loginForm() {
    if (this.enterprise) {
      TextInput({ placeholder: $r('app.string.org_id'), text: this.org }).id('org')
        .onChange((value: string) => { this.org = value; })
    } else {
      TextInput({ placeholder: $r('app.string.phone'), text: this.phone }).id('phone').type(InputType.PhoneNumber)
        .maxLength(11).onChange((value: string) => { this.phone = value; this.otp = ''; this.codeSent = false; })
      if (this.codeSent) {
        TextInput({ placeholder: $r('app.string.sms'), text: this.otp }).type(InputType.Number)
          .maxLength(8).onChange((value: string) => { this.otp = value; })
      }
    }
    this.consentRow()
    if (this.enterprise) {
      Button($r('app.string.sso_continue')).primaryLogin().enabled(!this.busy && this.consent && !!this.org.trim())
        .onClick(() => this.run(() => this.workspace.discover(this.org)))
      ForEach(this.view.ssoMethods, (item: Item) => {
        PillAction({ label: item.title, available: !this.busy && this.consent,
          onTap: () => this.run(() => this.workspace.startSSO(item.id)) })
      }, (item: Item) => item.id)
    } else {
      Button(this.codeSent ? $r('app.string.sign_in') : $r('app.string.get_code')).primaryLogin()
        .enabled(!this.busy && this.consent && /^1[3-9][0-9]{9}$/.test(this.phone) && (!this.codeSent || this.otp.length > 0))
        .onClick(() => this.run(async () => {
          if (this.codeSent) {
            await this.workspace.login('+86' + this.phone, this.otp);
            this.otp = ''; this.phone = ''; this.codeSent = false;
          } else {
            await this.workspace.code('+86' + this.phone); this.codeSent = true;
          }
        }))
      if (this.codeSent) {
        PillAction({ label: $r('app.string.new_code'), available: !this.busy && this.consent,
          onTap: () => this.run(() => this.workspace.code('+86' + this.phone)) })
      }
    }
    Button(this.enterprise ? $r('app.string.use_phone') : $r('app.string.use_sso'))
      .height(44).width('100%').backgroundColor(Color.Transparent).fontColor($r('app.color.ink')).enabled(!this.busy)
      .onClick(() => { this.enterprise = !this.enterprise; this.notice = ''; })
  }

  @Builder
  login() {
    Scroll() {
      Column({ space: 14 }) {
        Image($r('app.media.cindy')).width(52).height(52).borderRadius(12).accessibilityLevel('no')
        if (this.view.ssoWaiting) {
          Text($r('app.string.sso_wait')).sectionTitle()
          PillAction({ label: $r('app.string.sso_cancel'), available: !this.busy, onTap: () => this.run(() => this.workspace.cancelSSO()) })
        } else if (this.view.verification) {
          Text($r('app.string.verify_for', this.view.verification)).sectionTitle()
          PillAction({ label: $r('app.string.get_code'), available: !this.busy, onTap: () => this.run(() => this.workspace.verificationCode()) })
          TextInput({ placeholder: $r('app.string.code'), text: this.otp }).onChange((v: string) => { this.otp = v; })
          Button($r('app.string.verify')).primaryLogin().enabled(!this.busy && !!this.otp).onClick(() => this.run(async () => {
            await this.workspace.verifyOrganization(this.otp); this.otp = '';
          }))
        } else if (this.view.accounts.length) {
          Text($r('app.string.choose_account')).sectionTitle()
          ForEach(this.view.accounts, (item: Item) => {
            DirectoryRow({ title: item.title, targetId: item.id, available: !this.busy,
              open: () => this.run(() => this.workspace.choose(item.id)) })
          }, (item: Item) => item.id)
        } else {
          Text($r('app.string.app_login')).sectionTitle()
          this.loginForm()
        }
        this.errorNotice()
      }.alignItems(HorizontalAlign.Start).width('100%').constraintSize({ maxWidth: 440 })
        .padding(20).backgroundColor($r('app.color.panel')).borderRadius(12)
    }.width('100%').height('100%').scrollBar(BarState.Off)
  }

  @Builder
  accountMenu() {
    Menu() {
      MenuItem({ content: this.view.account }).enabled(false)
      if (!this.view.device) {
        MenuItem({ content: $r('app.string.refresh') }).onClick(() => this.run(() => this.workspace.devices()))
        MenuItem({ content: this.view.pushEnabled ? $r('app.string.disable_notifications') : $r('app.string.enable_notifications') })
          .onClick(() => this.run(() => this.workspace.changePush(!this.view.pushEnabled)))
        if (this.view.pushStatus) {
          MenuItem({ content: $r('app.string.settings_notifications') }).onClick(() => this.run(() => this.workspace.notificationSettings()))
        }
      }
      MenuItem({ content: $r('app.string.sign_out') }).onClick(() => this.run(async () => {
        await this.workspace.logout();
        this.title = ''; this.phone = ''; this.otp = ''; this.consent = false; this.codeSent = false;
      }))
    }
  }

  @Builder
  header() {
    Row({ space: 4 }) {
      if (this.view.device) {
        IconAction({ icon: $r('sys.symbol.chevron_left'), controlId: 'back', label: $r('app.string.back'),
          available: !this.busy, onTap: () => { this.onBackPress(); } })
      }
      Column({ space: 1 }) {
        Text(this.headerTitle()).fontSize(this.view.task ? 19 : 23).fontWeight(FontWeight.Medium)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).fontColor($r('app.color.ink'))
        if (this.view.device) {
          Text(this.deviceLabel(this.view.devices.find((r: Item) => r.id === this.view.device) || { id: this.view.device, title: this.view.device.slice(-6) }))
            .fontSize(12).fontColor($r('app.color.muted')).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      if (this.view.device && this.view.linked && !this.view.task && !this.creating) {
        IconAction({ icon: $r('sys.symbol.plus'), controlId: 'new-task', label: $r('app.string.create_new'), available: !this.busy,
          onTap: () => { this.creating = true; } })
      }
      Button({ type: ButtonType.Circle }) {
        SymbolGlyph($r('sys.symbol.more')).fontSize(22).fontColor([$r('app.color.ink')]).accessibilityLevel('no')
      }.id('account-menu').width(44).height(44).backgroundColor(Color.Transparent).enabled(!this.busy)
        .accessibilityText($r('app.string.account_options')).bindMenu(this.accountMenu)
    }.width('100%').constraintSize({ minHeight: 48 })
  }

  @Builder
  directory() {
    if (this.view.device && this.view.linked && this.creating) {
      Column({ space: 8 }) {
        TextInput({ placeholder: $r('app.string.title_optional'), text: this.title }).id('task-title').maxLength(120)
          .onChange((v: string) => { this.title = v; })
        Row({ space: 8 }) {
          PillAction({ label: $r('app.string.cancel'), available: !this.busy, onTap: () => { this.creating = false; this.title = ''; } })
          PillAction({ label: $r('app.string.create'), prominent: true, available: !this.busy,
            onTap: () => this.run(async () => { await this.workspace.create(this.title); this.title = ''; }) })
        }.width('100%').justifyContent(FlexAlign.End)
      }.width('100%').padding(12).borderRadius(12).backgroundColor($r('app.color.panel'))
    }
    List({ space: 4 }) {
      ForEach(this.view.device ? this.view.tasks : this.view.devices, (item: Item) => {
        ListItem() {
          DirectoryRow({ title: this.view.device ? item.title : this.deviceLabel(item), targetId: item.id,
            computer: !this.view.device, offline: !!item.offline, available: !this.busy,
            open: () => this.run(() => this.view.device ? this.workspace.openTask(item.id) : this.workspace.openDevice(item.id)) })
        }
      }, (item: Item) => item.id + item.title + String(item.offline))
      if (this.view.moreTasks && this.view.linked) {
        ListItem() { PillAction({ label: $r('app.string.more_tasks'), available: !this.busy, onTap: () => this.run(() => this.workspace.more()) }) }
      }
      if (!this.busy && this.view.relay === 'online' && (this.view.device ? this.view.linked && !this.view.tasks.length : !this.view.devices.length)) {
        ListItem() { Text(this.view.device ? $r('app.string.no_tasks') : $r('app.string.no_hosts')).fontSize(15).fontColor($r('app.color.muted')) }
      }
    }.width('100%').layoutWeight(1)
    if (!this.view.device && this.view.pushStatus) {
      Text(this.view.pushStatus).fontSize(14).fontColor($r('app.color.muted'))
    }
  }

  @Builder
  errorNotice() {
    if (this.notice || this.view.error) {
      Text(this.notice || this.view.error).fontSize(14).fontColor($r('app.color.ink')).width('100%')
        .padding(8).backgroundColor($r('app.color.chip')).borderRadius(8).copyOption(CopyOptions.InApp)
    }
  }

  build() {
    Column({ space: 6 }) {
      if (!this.view.account) {
        this.login()
      } else {
        this.header()
        if (this.view.shareLabel) {
          Column({ space: 4 }) {
            Text($r('app.string.share_title', this.view.shareLabel)).maxLines(2).fontSize(14).fontColor($r('app.color.ink'))
            Row({ space: 6 }) {
              if (this.view.task) {
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
        if (this.view.task) { this.taskContent() } else { this.directory() }
      }
    }.padding({ left: 14, right: 14, top: 6, bottom: 6 }).width('100%').height('100%').backgroundColor($r('app.color.canvas'))
  }
}

@Extend(Button) function primaryLogin() {
  .width('100%').constraintSize({ minHeight: 48 }).fontSize(16).fontWeight(FontWeight.Medium)
    .fontColor($r('app.color.on_action')).backgroundColor($r('app.color.action'))
}

@Extend(Text) function sectionTitle() {
  .fontSize(26).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink'))
}
