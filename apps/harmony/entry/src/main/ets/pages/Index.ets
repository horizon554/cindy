import { window, FrameCallback, LengthMetrics, KeyboardAvoidMode as WindowKeyboardAvoidMode } from '@kit.ArkUI';
import { deviceInfo } from '@kit.BasicServicesKit';
import { filePreview } from '@kit.PreviewKit';
import { common } from '@kit.AbilityKit';
import { installInputs } from '../services/nativeEntry';
import { ModelBrandIcon } from './ModelBrandIcon';
import { GroupProfilePage } from './GroupProfilePage';
import { CompanionAvatar, companionPortraitKey } from './CompanionAvatar';
import { MessageFooter } from './MessageFooter';
import { LoginBrand } from './LoginBrand';
import { SettingsPage } from './SettingsPage';
import { groupHomeRows, HomeGroup, matchingCompanions } from '../services/homeList';
import { HistorySource } from './HistorySource';
import { HistoryMessage, InteractionPanel, MessageBody } from './TaskContent';
import { ChoiceRow, DirectoryRow, IconAction, PillAction, OptionRow, PreferenceChip } from './Controls';
import { Row as Item, PreferenceOption, Workspace, Companion, ViewState, PendingUpload, Attachment, MediaInfo, Card, FolderList, Question, Choice } from '../services/workspace';

const PRIVACY_URL = 'https://cindy.cn/privacy';
const TERMS_URL = 'https://cindy.cn/terms';

// Updating TextArea.text resets the native selection during layout.
class AfterEditorLayout extends FrameCallback {
  private apply: () => void;
  constructor(apply: () => void) { super(); this.apply = apply; }
  onIdle(): void { this.apply(); }
}

interface DirectoryEntry {
  key: string;
  kind: 'device' | 'heading' | 'task' | 'moreGroup' | 'empty' | 'more';
  group?: HomeGroup;
  task?: Item;
  attention?: string;
}

const DIRECTORY_ROW_INSETS: Padding = { left: 12, right: 22 };
interface TaskRowContent { item: Item }
interface HeadingContent { group: HomeGroup; attention: string }
interface StatusContent { status: string; key: string }

class DrawerGesture implements AttributeModifier<SideBarContainerAttribute> {
  private enabled: boolean;
  constructor(enabled: boolean) { this.enabled = enabled; }
  applyNormalAttribute(sidebar: SideBarContainerAttribute): void {
    if (deviceInfo.sdkApiVersion >= 26) {
      sidebar.showSideBarWithGesture(this.enabled);
    }
  }
}

@Entry
@Component
struct Index {
  @State view: ViewState = { companionsCollapsed: false, showCollapsedCompanionAvatars: true, retryable: false, attachments: [], voice: '', transfer: '', pushStatus: '', pushEnabled: false,
    shareLabel: '', cards: [], activity: '', delivery: '', draft: '', linked: false, paused: false, moreTasks: false,
    hasOlder: false, running: false, ssoWaiting: false, ssoMethods: [], verification: '', accounts: [], account: '',
    relay: '', devices: [], tasks: [], messages: [], live: '', device: '', task: '', error: '' };
  @State loginWidth: number = 375;
  @State loginHeight: number = 740;
  @State phone: string = '';
  @State enterprise: boolean = false;
  @State org: string = '';
  @State otp: string = '';
  @State @Watch('scheduleRoutes') creating: boolean = false;
  @State renaming: string = '';
  @State actionRow?: Item = undefined;
  @State @Watch('scheduleRoutes') groupProfileKey: string = '';
  private paths: NavPathStack = new NavPathStack();
  private routesScheduled: boolean = false;
  // ForEach keeps a task's native row when the workspace replaces its immutable snapshot.
  @State private homeTasks: Map<string, Item> = new Map();
  private lastHomeIndex?: Item[];
  private homeScroller = new ListScroller();
  private projectScroller = new ListScroller();
  private shareScroller = new ListScroller();
  private settingsScroller = new Scroller();
  @State showSearch: boolean = false;
  @State @Watch('scheduleRoutes') pickingShareTarget: boolean = false;
  @State shareQuery: string = '';
  @State sortBy: string = 'recent';
  @State groupProjects: boolean = true;
  @State groupDevices: boolean = true;
  @State projectFilter: string = '';
  @State previewChrome: boolean = true;
  @State composing: boolean = false;
  @State initializing: boolean = true;
  @State busy: boolean = false;
  @State notice: string = '';
  @State codeSent: boolean = false;
  @State consent: boolean = false;
  @State @Watch('scheduleRoutes') panel: string = '';
  @State drawerOpen: boolean = false;
  @State query: string = '';
  @State companionsExpanded: boolean = false;
  @State statusFilter: string = 'active';
  @State scope: string = '';
  @State collapsed: string[] = [];
  @State @Watch('scheduleRoutes') projectList: Item | undefined = undefined;
  @State engine: string = '';
  @State engineOptions: string[] = [];
  @State choices: PreferenceOption[] = [];
  @State folders: FolderList = { path: '', parent: '', rows: [] };
  @State manualInputHeight?: number = undefined;
  @State measuredInputHeight: number = 48;
  @State availableHeight: number = 640;
  @State topInset: number = 0;
  @State bottomInset: number = 0;
  @State keyboardShown: boolean = false;
  private appWindow?: window.Window;
  private environmentListener?: number;
  private areaChanged = (event: window.AvoidAreaOptions): void => {
    if (event.type === window.AvoidAreaType.TYPE_SYSTEM) this.topInset = this.getUIContext().px2vp(event.area.topRect.height);
    if (event.type === window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR) this.bottomInset = this.getUIContext().px2vp(event.area.bottomRect.height);
  };
  private keyboardChanged = (height: number): void => {
    const closing = this.keyboardShown && height === 0;
    this.keyboardShown = height > 0;
    if (closing && this.inputOpen && !this.panel) this.foldComposer();
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
  @State @Watch('scheduleRoutes') selectedFile: MediaInfo | undefined = undefined;
  @State previewSource: string = '';
  @State voiceElapsed: number = 0;
  private voiceTimer: number = -1;
  private editor: TextAreaController = new TextAreaController();
  private selectionDraft: string | undefined = undefined;
  private selectionStart: number = 0;
  private selectionEnd: number = 0;
  private resumeTyping: boolean = false;
  private caretRevision: number = 0;
  @State resend: number = 0;
  @State cardIndex: number = 0;
  private resendTimer: number = -1;
  private historySource: HistorySource = new HistorySource();
  private scroll: Scroller = new Scroller();
  private pulledHistory: boolean = false;
  private followEnd: boolean = true;
  private scrollTimer: number = -1;
  private workspace: Workspace = new Workspace((state: ViewState) => {
    if (state.homeIndex !== this.lastHomeIndex) {
      this.lastHomeIndex = state.homeIndex;
      const tasks = new Map<string, Item>();
      for (const task of state.homeIndex || []) tasks.set(this.homeTaskKey(task), task);
      this.homeTasks = tasks;
    }
    const switched = state.task !== this.view.task;
    const changed = state.messages.length !== this.view.messages.length || state.live !== this.view.live;
    if (state.account !== this.view.account) { this.companionsExpanded = false; this.scope = ''; this.query = ''; this.showSearch = false; this.shareQuery = ''; this.projectFilter = ''; this.sortBy = 'recent'; this.groupProjects = true; this.groupDevices = true; this.collapsed = []; this.projectList = undefined; this.statusFilter = 'active'; }
    if (state.shareVersion !== this.view.shareVersion && state.shareLabel) {
      this.projectList = undefined; this.pickingShareTarget = true; this.shareQuery = ''; this.panel = ''; this.drawerOpen = false;
      this.selectedFile = undefined; this.previewSource = '';
    } else if (!state.shareLabel) { this.pickingShareTarget = false; this.shareQuery = ''; }
    if (this.projectList && !state.devices.some((host: Item) => host.id === this.projectList?.host)) this.projectList = undefined;
    if (this.scope && !state.devices.some((d: Item) => d.id === this.scope)) { this.scope = ''; this.projectFilter = ''; }
    if (!switched && state.task && !this.followEnd && changed) {
      const last = this.view.messages[this.view.messages.length - 1]?.id;
      const index = last ? state.messages.findIndex((r: Item) => r.id === last) : -1;
      if ((index >= 0 && index < state.messages.length - 1) || (!!state.live && state.live !== this.view.live)) this.unread = true;
    }
    this.historySource.replace(state.messages);
    if (state.device !== this.view.device || switched) this.creating = false;
    if (switched || state.device !== this.view.device || state.account !== this.view.account) {
      this.drawerOpen = false; this.panel = ''; this.selectedFile = undefined; this.previewSource = ''; this.inputOpen = false; this.manualInputHeight = undefined; this.actionRow = undefined; this.cardIndex = 0; this.unread = false; this.engine = ''; this.engineOptions = []; this.choices = [];
      this.folders = { path: '', parent: '', rows: [] }; this.project = ''; this.renaming = '';
      this.resetEditorSelection();
    }
    if (this.selectedFile && this.view.pendingUploads?.some((p: PendingUpload) => p.id === this.selectedFile?.path) &&
      !state.pendingUploads?.some((p: PendingUpload) => p.id === this.selectedFile?.path)) {
      this.selectedFile = state.attachments.find((a: Attachment) => this.workspace.localPreview(a.id) === this.previewSource);
      if (!this.selectedFile) this.previewSource = '';
    }
    if (!state.linked) { this.selectedFile = undefined; this.previewSource = ''; }
    if (this.cardIndex >= state.cards.length) this.cardIndex = 0;
    if (state.paused && !this.view.paused) this.inputOpen = true;
    if (state.voice !== this.view.voice) {
      clearInterval(this.voiceTimer);
      this.voiceElapsed = 0;
      if (state.voice === '录音中') {
        const started = Date.now();
        this.voiceTimer = setInterval(() => { this.voiceElapsed = Math.floor((Date.now() - started) / 1000); }, 1000);
      }
    }
    const appearanceChanged = !!state.account !== !!this.view.account;
    const voiceEnded = !!this.view.voice && !state.voice;
    const caretChanged = state.voiceCaret !== this.view.voiceCaret || state.voicePreview !== this.view.voicePreview;
    if (!state.draft && this.view.draft) this.manualInputHeight = undefined;
    const routeChanged = state.cloudCompanion?.key !== this.view.cloudCompanion?.key || switched || state.account !== this.view.account || state.shareLabel !== this.view.shareLabel;
    if (this.groupProfileKey && (this.groupProfileKey !== state.cloudCompanion?.key || state.account !== this.view.account)) this.groupProfileKey = '';
    this.view = state;
    if (routeChanged) this.scheduleRoutes();
    if (!switched && state.voiceCaret !== undefined && (caretChanged || voiceEnded)) {
      const caret = state.voiceCaret;
      const focus = voiceEnded && this.resumeTyping;
      if (voiceEnded) {
        this.resumeTyping = false;
        this.selectionDraft = state.draft; this.selectionStart = caret; this.selectionEnd = caret;
        if (focus || (state.draft && !this.busy)) this.inputOpen = true;
      }
      const revision = ++this.caretRevision;
      this.getUIContext().postFrameCallback(new AfterEditorLayout(() => {
        if (revision !== this.caretRevision || this.view.task !== state.task || this.view.device !== state.device || this.view.voiceCaret !== caret ||
          this.view.voice !== state.voice || this.view.draft !== state.draft || this.view.cards.length || this.selectedFile || this.panel) return;
        if (focus) this.getUIContext().getFocusController().requestFocus(this.creating ? 'first-message' : 'composer');
        this.editor.caretPosition(caret);
      }));
    } else if (voiceEnded) { this.resumeTyping = false; }
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
    this.environmentListener = this.getUIContext().getHostContext()?.getApplicationContext().on('environment', {
      onConfigurationUpdated: () => { this.updateBars(); },
      onMemoryLevel: () => {}
    });
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
        this.appWindow?.off('keyboardHeightChange', this.keyboardChanged);
        this.appWindow = win;
        win.on('keyboardHeightChange', this.keyboardChanged);
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

  // The workspace owns task and draft lifetime. Project its settled state into ArkUI's page stack.
  private scheduleRoutes(): void {
    if (this.routesScheduled) return;
    this.routesScheduled = true;
    Promise.resolve().then(() => {
      this.routesScheduled = false;
      const next: string[] = [];
      if (this.view.account) {
        if (this.projectList) next.push('project');
        if (this.view.task) next.push('task');
        else if (this.view.cloudCompanion) {
          next.push('cloud');
          if (this.view.cloudCompanion.group && this.groupProfileKey === this.view.cloudCompanion.key) next.push('group-profile');
        }
        else if (this.creating) next.push('new');
        if (this.sharePicker()) next.push('share');
        if (this.panel === 'settings') next.push('settings');
        if (this.selectedFile) next.push('preview');
      }
      const current = this.paths.getAllPathName();
      let common = 0;
      while (common < current.length && common < next.length && current[common] === next[common]) common++;
      if (common === current.length && common === next.length) return;
      if (common + 1 === current.length && common + 1 === next.length) {
        this.paths.replacePath(new NavPathInfo(next[common], undefined));
        return;
      }
      if (common < current.length) {
        if (common) this.paths.popToIndex(common - 1, common === next.length);
        else this.paths.clear(!!this.view.account && !next.length);
      }
      for (let i = common; i < next.length; i++) this.paths.pushPath(new NavPathInfo(next[i], undefined), i === next.length - 1);
    });
  }

  onBackPress(): boolean {
    if (this.drawerOpen) { this.drawerOpen = false; return true; }
    if (this.selectedFile) { this.selectedFile = undefined; this.previewSource = ''; return true; }
    if (this.panel) { this.closePanel(); return true; }
    if (!this.view.account && (this.codeSent || this.enterprise) && !this.view.ssoWaiting) {
      this.codeSent = false; this.enterprise = false; this.otp = ''; this.notice = ''; this.workspace.clearMethods(); return true;
    }
    if (this.view.voice) { this.workspace.cancelVoice(); return true; }
    if (this.view.editingMessage) { this.workspace.cancelMessageEdit(); return true; }
    if (this.sharePicker()) { this.workspace.dismissShare(); return true; }
    if (this.creating) {
      this.leaveNewTask();
      return true;
    }
    if (this.view.shareLabel) { this.pickingShareTarget = true; return true; }
    if (this.groupProfileKey) { this.groupProfileKey = ''; return true; }
    if (this.view.cloudCompanion) { this.workspace.closeCloudCompanion(); return true; }
    if (!this.view.task && this.projectList) { this.projectList = undefined; return true; }
    if (!this.view.task && this.showSearch) { this.showSearch = false; this.query = ''; return true; }
    if (!this.view.task) return false;
    this.run(() => this.workspace.back());
    return true;
  }

  private async leaveNewTask(): Promise<void> {
    const left = await this.workspace.leaveNew(() => new Promise<boolean>((resolve) => {
      this.getUIContext().showAlertDialog({
        title: $r('app.string.discard_send_title'), message: $r('app.string.discard_send_hint'),
        cancel: () => resolve(false),
        primaryButton: { value: $r('app.string.keep_waiting'), action: () => resolve(false) },
        secondaryButton: { value: $r('app.string.discard_send'), action: () => resolve(true) }
      });
    }));
    if (left) {
      this.creating = false;
      this.foldComposer();
      this.pickingShareTarget = !!this.view.shareLabel;
    }
  }

  onPageHide(): void {
    this.resumeTyping = false; this.caretRevision++;
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
    if (this.view.task) return this.titleCompanion(false)?.title || this.view.tasks.find((r: Item) => r.id === this.view.task)?.title || $r('app.string.task');
    return this.view.device ? $r('app.string.tasks') : $r('app.string.hosts');
  }

  private async showPreview(file: MediaInfo, local: string = ''): Promise<void> {
    this.previewChrome = true; this.selectedFile = file; this.previewSource = ''; this.zoom = 1; this.panX = 0; this.panY = 0;
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
    } else if (file.path && !this.view.pendingUploads?.some((p: PendingUpload) => p.id === file.path)) {
      const url = await this.workspace.previewUrl(file.path);
      if (this.selectedFile?.path === file.path) await this.openPolicy(url);
    }
  }

  private pendingImage(item: PendingUpload): MediaInfo {
    return { path: item.id, name: item.title, mimeType: 'image/*' };
  }

  private gallery(): MediaInfo[] {
    const drafts: MediaInfo[] = this.view.attachments.filter((a: Attachment) => !!a.mimeType?.startsWith('image/'));
    (this.view.pendingUploads || []).forEach((item: PendingUpload) => {
      if (item.previewUri) drafts.push(this.pendingImage(item));
    });
    if (drafts.some((a: MediaInfo) => !!a.path && a.path === this.selectedFile?.path)) return drafts;
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
      const pending = this.view.pendingUploads?.find((p: PendingUpload) => p.id === next.path);
      await this.showPreview(next, pending?.previewUri || this.workspace.localPreview(draft?.id || next.path || ''));
    }
  }

  @Builder
  filePreview() {
    Stack({ alignContent: Alignment.Bottom }) {
      if (this.previewSource && this.selectedFile?.mimeType?.startsWith('image/')) {
        Stack() {
          Image(this.previewSource).width('100%').height('100%').objectFit(ImageFit.Contain)
            .scale({ x: this.zoom, y: this.zoom }).translate({ x: this.panX, y: this.panY })
        }.width('100%').height('100%').clip(true).onClick(() => { this.previewChrome = !this.previewChrome; }).gesture(GestureGroup(GestureMode.Parallel,
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
        if (this.previewChrome && this.gallery().length > 1) {
          Row({ space: 12 }) {
            IconAction({ icon: $r('sys.symbol.chevron_left'), label: $r('app.string.previous'), available: this.imageIndex() > 0, onTap: () => this.run(() => this.moveImage(-1)) })
            Text((this.imageIndex() + 1).toString() + ' / ' + this.gallery().length.toString()).fontColor($r('app.color.ink'))
            IconAction({ icon: $r('sys.symbol.chevron_right'), label: $r('app.string.next_step'), available: this.imageIndex() + 1 < this.gallery().length, onTap: () => this.run(() => this.moveImage(1)) })
          }
        }
      } else {
        Column({ space: 12 }) {
          Text([this.selectedFile?.mimeType, this.selectedFile?.size ? this.selectedFile.size.toString() + ' B' : ''].filter((s: string | undefined) => !!s).join(' · '))
          .fontSize(14).fontColor($r('app.color.muted'))
        if (this.previewSource) {
          PillAction({ label: $r('app.string.open_file'), onTap: () => this.run(() => this.openSelectedFile()) })
        } else if (!this.busy) { Text($r('app.string.unavailable_preview')).fontSize(14) }
        }.width('100%').height('100%').justifyContent(FlexAlign.Center)
      }
    }.width('100%').layoutWeight(1)
  }

  private expanded(): boolean {
    return this.inputOpen || !!this.view.voice || this.panel === 'permission' || this.panel === 'model';
  }

  private foldComposer(): void {
    this.inputOpen = false;
    this.getUIContext().getFocusController().clearFocus();
  }

  private resetEditorSelection(): void {
    this.selectionDraft = undefined;
    this.resumeTyping = false;
    this.caretRevision++;
  }

  private startDictation(): void {
    if (this.composing) return;
    if (this.selectionDraft === this.view.draft) this.workspace.startVoice(this.selectionStart, this.selectionEnd);
    else this.workspace.startVoice();
  }

  @Builder
  voiceMenu() {
    Menu() {
      MenuItem({ content: $r('app.string.voice_cancel') }).id('cancel-voice').onClick(() => this.workspace.cancelVoice())
    }
  }

  private attachmentCount(): number {
    return this.view.attachments.length + (this.view.pendingUploads?.length || (this.view.transfer && !this.view.uploadPending ? 1 : 0));
  }

  private async editUserMessage(task: string, id: string): Promise<void> {
    await this.workspace.beginMessageEdit(task, id);
    if (this.view.task !== task || this.view.editingMessage !== id) return;
    this.inputOpen = true;
    this.getUIContext().postFrameCallback(new AfterEditorLayout(() => {
      if (this.view.task !== task || this.view.editingMessage !== id) return;
      this.getUIContext().getFocusController().requestFocus('composer');
      this.editor.caretPosition(this.view.draft.length);
    }));
  }

  private async sendFromComposer(): Promise<void> {
    if (this.view.voice && !await this.workspace.finishVoiceForSend()) return;
    if (!this.view.linked || this.composing || this.view.cards.length || (this.view.transfer && !this.view.uploadPending) || this.view.failedFile || this.view.delivery) return;
    if (this.creating) await this.newTask();
    else if (this.view.task) await this.workspace.send(this.view.draft);
  }

  @Builder
  trailingActions() {
    if (this.view.paused) {
      PillAction({ label: $r('app.string.resume'), available: !this.busy && this.view.linked,
        onTap: () => this.run(() => this.workspace.control(true)) })
    }
    if (this.view.running && (this.view.voice || this.view.draft.trim() || this.view.attachments.length || this.view.uploadPending)) {
      this.stopAction()
    }
    if (this.view.voice) {
      Button({ type: ButtonType.Capsule }) {
        Row({ space: 4 }) {
          if (this.view.voice === '录音中') {
            Row().width(8).height(8).borderRadius(4).backgroundColor($r('app.color.recording'))
            Text(Math.floor(this.voiceElapsed / 60) + ':' + (this.voiceElapsed % 60).toString().padStart(2, '0')).fontSize(14).fontColor($r('app.color.ink'))
          } else { LoadingProgress().width(16).height(16).color($r('app.color.muted')) }
        }
      }.id('finish-voice').height(44).constraintSize({ minWidth: 48 }).padding({ left: 6, right: 6 })
        .backgroundColor($r('app.color.chip')).accessibilityText($r('app.string.voice_finish'))
        .accessibilityDescription($r('app.string.voice_cancel_hint')).bindContextMenu(this.voiceMenu, ResponseType.LongPress)
        .onClick(() => { if (this.view.voice === '录音中') this.workspace.finishVoice(); })
    } else {
      IconAction({ icon: $r('sys.symbol.mic'), label: $r('app.string.voice'), controlId: 'voice',
        available: !this.busy && !this.composing && this.view.linked && !this.view.transfer, onTap: () => this.startDictation() })
    }
    if (this.view.running && !this.view.voice && !this.view.draft.trim() && !this.view.attachments.length && !this.view.uploadPending) {
      this.stopAction()
    } else if (this.view.voice || this.view.draft.trim() || this.view.attachments.length || this.view.uploadPending || (this.creating && this.view.shareLabel)) {
      IconAction({ icon: $r('sys.symbol.arrow_up'), label: this.view.voice ? $r('app.string.voice_send') :
        this.view.editingMessage ? $r('app.string.message_resend') : this.creating && this.view.shareLabel ? $r('app.string.share_new') : $r('app.string.send'),
        controlId: this.creating ? 'create-send' : 'send', prominent: true, available: !this.busy && !this.composing && this.view.linked &&
          (!this.view.transfer || !!this.view.uploadPending) && !this.view.failedFile && !this.view.delivery && (!this.view.voice || this.view.voice === '录音中'),
        onTap: () => this.run(() => this.sendFromComposer()) })
    }
  }

  @Builder
  stopAction() {
    IconAction({ icon: $r('sys.symbol.square_fill'), label: $r('app.string.stop'), controlId: 'stop', prominent: true,
      available: !this.busy && this.view.linked, onTap: () => this.run(() => this.workspace.control(false)) })
  }

  private firstAttachmentPreview(): string {
    for (const file of this.view.attachments) {
      const local = file.mimeType?.startsWith('image/') && this.workspace.localPreview(file.id);
      if (local) return local;
    }
    return this.view.pendingUploads?.find((item: PendingUpload) => !!item.previewUri)?.previewUri || '';
  }

  @Builder
  photoRemove(name: string, control: string, pending: boolean, remove: () => void) {
    Button({ type: ButtonType.Normal }) {
      SymbolGlyph($r('sys.symbol.xmark')).fontSize(12).fontColor([$r('app.color.on_action')]).padding(4)
        .backgroundColor($r('app.color.action')).borderRadius(12)
    }.width(44).height(44).position({ x: 40, y: 0 }).align(Alignment.TopEnd).padding(2).backgroundColor(Color.Transparent)
      .id(control).accessibilityText($r('app.string.remove_file', name)).enabled(!this.busy || (pending && !this.creating)).onClick(remove)
  }

  @Builder
  pendingFile(item: PendingUpload, index: number) {
    if (item.previewUri) {
      Stack({ alignContent: Alignment.BottomStart }) {
        Button({ type: ButtonType.Normal }) {
          Stack() {
            Image(item.previewUri).width(72).height(72).objectFit(ImageFit.Cover)
            if (item.failed) {
              Text($r('app.string.retry_upload')).fontSize(13).fontColor($r('app.color.on_action'))
                .padding(4).backgroundColor($r('app.color.action')).borderRadius(8)
            } else {
              LoadingProgress().width(22).height(22).padding(2).color($r('app.color.on_action')).backgroundColor($r('app.color.action')).borderRadius(11)
            }
          }
        }.width(72).height(72).padding(0).borderRadius(12).backgroundColor($r('app.color.chip'))
          .id(item.failed ? (index ? 'retry-' + item.id : 'retry-upload') : 'preview-' + item.id)
          .accessibilityText(item.failed ? $r('app.string.retry_upload_named', item.title) : $r('app.string.preview_image_named', item.title))
          .enabled(!item.failed || (!this.busy && this.view.linked))
          .onClick(() => {
            if (item.failed) this.uploadAttachment('', item.id);
            else this.showPreview(this.pendingImage(item), item.previewUri);
          })
        this.photoRemove(item.title, index ? 'cancel-' + item.id : 'cancel-upload', true,
          () => this.workspace.removeUpload(item.id))
      }.width(84).height(84).id(index ? 'upload-' + item.id : 'pending-upload')
    } else {
      Row({ space: 4 }) {
        if (!item.failed) { LoadingProgress().width(16).height(16).color($r('app.color.muted')) }
        Text(item.title).fontSize(13).fontColor($r('app.color.ink'))
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).constraintSize({ maxWidth: 100 })
        if (item.failed) {
          Button($r('app.string.retry_upload'), { type: ButtonType.Capsule }).id(index ? 'retry-' + item.id : 'retry-upload').height(44)
            .fontSize(13).backgroundColor($r('app.color.chip')).fontColor($r('app.color.ink'))
            .accessibilityText($r('app.string.retry_upload_named', item.title))
            .enabled(!this.busy && this.view.linked).onClick(() => this.uploadAttachment('', item.id))
        }
        IconAction({ icon: $r('sys.symbol.xmark'), label: $r('app.string.remove_file', item.title),
          controlId: index ? 'cancel-' + item.id : 'cancel-upload', available: !(this.creating && this.busy), onTap: () => this.workspace.removeUpload(item.id) })
      }.id(index ? 'upload-' + item.id : 'pending-upload').padding({ left: 6 }).borderRadius(10).backgroundColor($r('app.color.chip'))
    }
  }

  @Builder
  composer() {
    Column({ space: 3 }) {
      if (this.view.editingMessage) {
        Row({ space: 8 }) {
          Text($r('app.string.message_editing')).fontSize(14).fontColor($r('app.color.ink')).layoutWeight(1)
          Button($r('app.string.cancel'), { type: ButtonType.Capsule }).id('message-edit-cancel')
            .fontSize(14).height(44).fontColor($r('app.color.ink')).backgroundColor(Color.Transparent)
            .accessibilityText($r('app.string.message_edit_cancel')).enabled(!this.busy && !this.view.editSubmitting)
            .onClick(() => this.workspace.cancelMessageEdit())
        }.width('100%').padding({ left: 10 })
        if (this.view.editFileCount) {
          Text($r('app.string.message_edit_files', this.view.editFileCount)).fontSize(13)
            .fontColor($r('app.color.muted')).alignSelf(ItemAlign.Start).margin({ left: 10 })
        }
      }
      if (this.expanded()) {
        Button({ type: ButtonType.Normal }) {
          Divider().width(32).strokeWidth(3).color($r('app.color.line'))
        }.id('resize-composer').height(44).width(68).backgroundColor(Color.Transparent).accessibilityText($r('app.string.collapse_input'))
          .onClick(() => this.foldComposer())
          .gesture(PanGesture({ direction: PanDirection.Vertical })
            .onActionStart(() => { this.dragStart = this.measuredInputHeight; })
            .onActionUpdate((e: GestureEvent) => {
              this.manualInputHeight = Math.max(48, Math.min(this.availableHeight * 0.42, this.dragStart - e.offsetY));
            }).onActionEnd((e: GestureEvent) => { if (this.dragStart <= 48 && e.offsetY > 32) this.foldComposer(); }))
      }
      if (this.expanded() && this.attachmentCount() > 0) {
        Scroll() {
          Flex({ wrap: FlexWrap.Wrap, alignItems: ItemAlign.Center, space: { main: LengthMetrics.vp(6), cross: LengthMetrics.vp(6) } }) {
            ForEach(this.view.attachments, (f: Attachment) => {
              if (f.mimeType?.startsWith('image/') && this.workspace.localPreview(f.id)) {
                Stack({ alignContent: Alignment.BottomStart }) {
                  Button({ type: ButtonType.Normal }) {
                    Image(this.workspace.localPreview(f.id)).width(72).height(72).objectFit(ImageFit.Cover)
                  }.id('preview-' + f.id).width(72).height(72).padding(0).borderRadius(12).backgroundColor($r('app.color.chip')).accessibilityText(f.name)
                    .onClick(() => this.run(() => this.showPreview(f, this.workspace.localPreview(f.id))))
                  this.photoRemove(f.name, 'remove-' + f.id, false, () => this.run(() => this.workspace.removeFile(f.id)))
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
            if (this.view.transfer && !this.view.uploadPending && !this.view.pendingUploads?.length) {
              Row({ space: 4 }) {
                LoadingProgress().width(16).height(16).color($r('app.color.muted'))
                Text(this.view.transfer).fontSize(13).fontColor($r('app.color.ink'))
                IconAction({ icon: $r('sys.symbol.xmark'), label: $r('app.string.cancel_file'), controlId: 'cancel-upload',
                  available: !(this.creating && this.busy), onTap: () => this.workspace.cancelTransfer() })
              }.id('pending-upload')
            }
            ForEach(this.view.pendingUploads || [], (item: PendingUpload, index: number) => {
              this.pendingFile(item, index)
            }, (item: PendingUpload, index: number) => JSON.stringify([item.id, item.failed, item.uploading, index]))
          }.width('100%')
        }.id('attachment-tray').align(Alignment.TopStart).width('100%')
          .constraintSize({ maxHeight: Math.max(84, Math.min(204, this.availableHeight * 0.28)) })
          .scrollable(ScrollDirection.Vertical).scrollBar(BarState.Auto)
      }
      Row({ space: 4 }) {
        if (!this.expanded()) {
          IconAction({ icon: $r('sys.symbol.plus'), label: $r('app.string.add_file'), controlId: 'compact-add',
            available: !this.busy && this.view.linked && !this.view.pickingFiles && (!this.view.transfer || !!this.view.uploadPending), onTap: () => { this.panel = 'attachments'; } })
          if (this.attachmentCount() > 0) {
            Button({ type: ButtonType.Capsule }) {
              Stack({ alignContent: Alignment.BottomEnd }) {
                if (this.firstAttachmentPreview()) {
                  Image(this.firstAttachmentPreview()).width(34).height(34).borderRadius(8).objectFit(ImageFit.Cover)
                  if (this.attachmentCount() > 1) {
                    Text('+' + (this.attachmentCount() - 1).toString()).fontSize(11).fontColor($r('app.color.on_action'))
                      .padding({ left: 3, right: 3 }).backgroundColor($r('app.color.action')).borderRadius(6)
                  }
                } else {
                  Text(this.attachmentCount().toString()).fontSize(13).fontColor($r('app.color.ink'))
                }
              }
            }.id('attachment-badge').height(44).constraintSize({ minWidth: 44 }).padding({ left: 5, right: 5 })
              .backgroundColor($r('app.color.chip')).accessibilityText($r('app.string.show_attachments', this.attachmentCount()))
              .onClick(() => { this.inputOpen = true; this.getUIContext().getFocusController().requestFocus(this.creating ? 'first-message' : 'composer'); })
          }
        }
        Stack({ alignContent: Alignment.TopStart }) {
          TextArea({ placeholder: this.creating ? $r('app.string.first_input') : $r('app.string.message'), controller: this.editor,
            text: this.view.voice ? this.view.voicePreview : this.view.draft }).id(this.creating ? 'first-message' : 'composer')
            .width('100%').height(this.expanded() ? this.manualInputHeight : 44)
            .constraintSize({ minHeight: this.expanded() ? 48 : 44, maxHeight: this.expanded() ? Math.max(48, this.availableHeight * 0.42) : 44 })
            .onAreaChange((_: Area, area: Area) => { this.measuredInputHeight = Number(area.height); })
            .fontSize(16).fontColor($r('app.color.ink')).backgroundColor(Color.Transparent)
            .accessibilityLevel(this.view.voice ? 'no' : 'auto')
            .align(this.expanded() ? Alignment.TopStart : Alignment.Start)
            .maxLines(this.expanded() ? undefined : 1)
            .textOverflow(this.expanded() ? TextOverflow.Clip : TextOverflow.Ellipsis)
            .padding({ left: 10, right: 10, top: this.expanded() ? 7 : 0, bottom: this.expanded() ? 3 : 0 })
            .onFocus(() => { this.inputOpen = true; })
            .onBlur(() => { if (!this.panel) { this.inputOpen = false; } })
            .onTextSelectionChange((start: number, end: number) => {
              if (!this.view.voice) {
                this.selectionStart = start; this.selectionEnd = end; this.selectionDraft = this.view.draft;
              }
            })
            .onWillInsert(() => !this.view.voice && !this.view.waitingToCreate && !this.view.editSubmitting)
            .onWillDelete(() => !this.view.voice && !this.view.waitingToCreate && !this.view.editSubmitting)
            .onChange((value: string, preview?: PreviewText) => {
              if (this.view.voice) return;
              this.composing = !!preview?.value;
              if (!this.composing) this.workspace.editDraft(value);
            })
          if (this.view.voice) {
            Button({ type: ButtonType.Normal }) {}.id('voice-edit-draft').width('100%').height(this.measuredInputHeight).position({ x: 0, y: 0 })
              .backgroundColor(Color.Transparent).accessibilityText($r('app.string.voice_resume_typing'))
              .accessibilityDescription(this.view.voicePreview || '')
              .onClick(() => { this.resumeTyping = true; this.workspace.finishVoice(); })
          }
        }.layoutWeight(1)
        if (!this.expanded()) { this.trailingActions() }
      }.width('100%')
      if (this.expanded()) {
        Row({ space: 2 }) {
          IconAction({ icon: $r('sys.symbol.plus'), label: $r('app.string.add_file'), controlId: 'add-attachment',
            available: !this.busy && this.view.linked && !this.view.pickingFiles && (!this.view.transfer || !!this.view.uploadPending),
            onTap: () => { this.panel = 'attachments'; } })
          Scroll() {
            Row({ space: 4 }) {
              if (this.view.permission) {
                PreferenceChip({ value: this.view.permission, control: 'choose-permission', available: !this.busy && this.view.linked && !this.view.running,
                  open: () => this.run(() => this.showChoices('permission')) })
              }
              if (this.view.model || (this.creating && this.view.agent)) {
                PreferenceChip({ value: this.view.model || this.view.agent || '', control: 'choose-model', available: !this.busy && this.view.linked && !this.view.running,
                  open: () => this.run(() => this.showChoices('model')) })
              }
            }
          }.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).align(Alignment.Start).layoutWeight(1)
          this.trailingActions()
        }.width('100%')
      }
    }.width('100%').alignItems(HorizontalAlign.Center).justifyContent(FlexAlign.Center)
      .padding(this.expanded() ? 8 : 4).constraintSize({ minHeight: 55 }).borderWidth(1)
      .borderColor($r('app.color.line')).borderRadius(this.expanded() ? 18 : 30).backgroundColor($r('app.color.panel'))
  }

  @Builder
  taskContent() {
    List({ space: 14, scroller: this.scroll }) {
      if (!this.view.messages.length && this.view.hasOlder && this.view.linked) {
        ListItem() { PillAction({ label: $r('app.string.older'), available: !this.busy,
          onTap: () => this.run(() => this.workspace.older()) }) }
      }
      LazyForEach(this.historySource, (item: Item) => {
        ListItem() {
          Column() {
            HistoryMessage({ item: item, openLink: (url: string) => this.run(() => this.openPolicy(url)),
              loadImage: (file: MediaInfo, visible: () => boolean) => this.workspace.thumbnail(file, visible),
              preview: (file: MediaInfo) => this.run(() => this.showPreview(file, this.workspace.localPreview(file.path || ''))) })
            if (item.actions) {
              MessageFooter({ row: item, task: this.view.task, editing: this.view.editingMessage === item.id, companion: !!this.view.taskCompanion,
                link: (task: string, id: string) => this.workspace.messageLink(task, id),
                addLink: (href: string) => { this.workspace.editDraft([this.view.draft, href].filter((part: string) => !!part).join(' ')); this.inputOpen = true; },
                edit: (task: string, id: string) => this.run(() => this.editUserMessage(task, id)),
                fork: (task: string, id: string) => this.run(() => this.workspace.forkMessage(task, id)) })
            }
          }.width('100%')
        }.padding({ left: 16, right: 16 })
      }, (item: Item) => this.historySource.key(item))
      if (this.view.live) {
        ListItem() { MessageBody({ value: this.view.live, openLink: (url: string) => this.run(() => this.openPolicy(url)) }) }.padding({ left: 16, right: 16 })
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
    Column({ space: 6 }) {
      if (this.unread) {
        PillAction({ label: $r('app.string.new_messages'), onTap: () => { this.followEnd = true; this.unread = false; this.scroll.scrollEdge(Edge.Bottom); } })
      }
      if (this.view.delivery) {
        Column({ space: 4 }) {
          if (this.view.pendingLabel) { Text(this.view.pendingLabel).maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis }) }
          Text(this.view.delivery).fontSize(13).fontColor($r('app.color.warning'))
          PillAction({ label: this.view.editRecoverable ? $r('app.string.message_edit_recover') : this.view.retryable ? $r('app.string.retry_last') : $r('app.string.verify_delivery'),
            available: !this.busy && this.view.linked, onTap: () => this.run(() => this.view.editRecoverable ? this.workspace.recoverMessageEdit() : this.view.retryable ? this.workspace.retryOriginal() : this.workspace.checkDelivery()) })
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
    }.width('100%').padding({ left: 16, right: 16 })
  }

  @Builder
  consentRow() {
    Row({ space: 2 }) {
      Checkbox().select(this.consent).accessibilityText($r('app.string.consent'))
        .selectedColor($r('app.color.action')).onChange((value: boolean) => { this.consent = value; })
      Text($r('app.string.agree')).fontSize(13).fontColor($r('app.color.muted'))
      Text($r('app.string.terms')).fontSize(13).fontColor($r('app.color.ink')).height(44)
        .decoration({ type: TextDecorationType.Underline }).onClick(() => this.run(() => this.openPolicy(TERMS_URL)))
      Text($r('app.string.and')).fontSize(13).fontColor($r('app.color.muted'))
      Text($r('app.string.privacy')).fontSize(13).fontColor($r('app.color.ink')).height(44)
        .decoration({ type: TextDecorationType.Underline }).onClick(() => this.run(() => this.openPolicy(PRIVACY_URL)))
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

  aboutToDisappear(): void {
    if (this.environmentListener !== undefined) {
      this.getUIContext().getHostContext()?.getApplicationContext().off('environment', this.environmentListener);
      this.environmentListener = undefined;
    }
    this.resetEditorSelection();
    this.appWindow?.off('keyboardHeightChange', this.keyboardChanged);
    this.appWindow?.off('avoidAreaChange', this.areaChanged);
    this.appWindow = undefined;
    clearInterval(this.resendTimer);
    clearInterval(this.voiceTimer);
    clearTimeout(this.scrollTimer);
  }

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
          Text($r('app.string.org_help')).fontSize(this.u(22)).fontColor($r('app.color.muted')).margin({ top: 4 }).alignSelf(ItemAlign.Start)
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

  private changeScope(id: string): void {
    this.scope = id;
    this.companionsExpanded = false;
    this.projectFilter = '';
    this.workspace.setHomeScope(id);
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
    const draft = restoring ? this.workspace.snapshotNew() : undefined;
    const sameHost = this.view.device === id;
    const project = this.view.device === id ? this.project : '';
    const owner = this.view.account;
    const selectingScope = this.panel === 'hosts';
    await this.selectHost(id);
    if (selectingScope && this.view.account === owner) { this.changeScope(id); }
    if (restoring && this.view.account === owner && this.view.device === id) {
      this.creating = true;
      if (!sameHost || !this.view.agent) {
        this.workspace.beginNew(draft);
        await this.workspace.configureNew();
      }
      this.project = project;
    }
  }

  private hostOffline(id: string): boolean {
    return this.view.relay !== 'online' || !!this.view.devices.find((r: Item) => r.id === id)?.offline;
  }

  private scopedRows(sharing: boolean = false): Item[] {
    const allowed = this.view.devices.map((r: Item) => r.id);
    return (this.view.homeIndex || []).filter((r: Item) => allowed.includes(r.host || ''))
      .filter((r: Item) => sharing ? !this.hostOffline(r.host || '') && r.status !== 'archived' : !this.scope || this.scope === r.host);
  }

  private homeRows(page: string): Item[] {
    const sharing = page === 'share';
    const project = page === 'project' ? this.projectList : undefined;
    const query = (sharing ? this.shareQuery : project ? '' : this.query).trim().toLowerCase();
    return this.scopedRows(sharing).filter((r: Item) => (!project || (r.host === project.host && r.project === project.project)) && (sharing || ((!this.projectFilter || this.projectFilter === this.groupKey(r)) &&
      (this.statusFilter === 'all' || (r.status === 'archived') === (this.statusFilter === 'archived')))) &&
      (r.title + ' ' + (r.project || '') + ' ' + (r.summary || '')).toLowerCase().includes(query))
      .sort((a: Item, b: Item) => !sharing && this.sortBy === 'created' ?
        (Date.parse(b.created || b.updated || '') || 0) - (Date.parse(a.created || a.updated || '') || 0) :
        (Date.parse(b.updated || '') || 0) - (Date.parse(a.updated || '') || 0));
  }

  private rowTime(item: Item): string {
    const date = new Date(item.updated || '');
    if (!Number.isFinite(date.getTime())) return '';
    return date.toDateString() === new Date().toDateString() ?
      date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0') :
      (date.getMonth() + 1).toString() + '/' + date.getDate().toString();
  }

  private groupKey(item: Item): string { return JSON.stringify([item.host || '', item.project || '']); }

  private homeGroupingLabel(): Resource {
    if (this.groupDevices && this.view.devices.length > 1) {
      return this.groupProjects ? $r('app.string.computer_and_project') : $r('app.string.computer');
    }
    return this.groupProjects ? $r('app.string.project') : $r('app.string.ungrouped');
  }

  private groups(page: string): HomeGroup[] {
    return groupHomeRows(this.homeRows(page), this.groupProjects, page !== 'home', !!this.query.trim(),
      !this.groupDevices || this.scope || this.query.trim() ? [] : this.view.devices.map((device: Item) => device.id), this.collapsed);
  }

  private homeTaskKey(task: Item): string { return JSON.stringify(['task', task.host, task.id]); }

  private currentTask(entry: DirectoryEntry): Item {
    return this.homeTasks.get(entry.key) || entry.task!;
  }

  private directoryEntries(page: string): DirectoryEntry[] {
    const entries: DirectoryEntry[] = [];
    for (const group of this.groups(page)) {
      if (group.kind === 'device') {
        entries.push({ key: group.key, kind: 'device', group });
        continue;
      }
      if (group.kind !== 'task') {
        const attention = this.collapsed.includes(group.key) ? this.groupAttention(group) : '';
        entries.push({ key: group.key, kind: 'heading', group, attention });
        if (this.collapsed.includes(group.key) && !this.query.trim()) continue;
      }
      for (const task of group.rows) {
        entries.push({ key: this.homeTaskKey(task), kind: 'task', task });
      }
      if (group.rows.length < group.total) entries.push({ key: 'more-' + group.key, kind: 'moreGroup', group });
    }
    const matchedBuddies = page === 'home' && !!this.query.trim() && !this.projectFilter && this.statusFilter !== 'archived' && this.matchingCompanions().length > 0;
    if (!entries.length && !matchedBuddies) entries.push({ key: 'empty', kind: 'empty' });
    if (this.view.moreTasks) entries.push({ key: 'more', kind: 'more' });
    return entries;
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

  private startNew(loadDefaults: boolean = true): void {
    this.resetEditorSelection();
    this.project = ''; this.engine = ''; this.inputOpen = false; this.manualInputHeight = undefined;
    this.creating = true; this.panel = this.view.device && (!this.view.shareLabel || !this.hostOffline(this.view.device)) ? '' : 'new-host';
    this.workspace.beginNew();
    if (this.view.linked && loadDefaults) this.run(() => this.workspace.configureNew());
  }

  private async openRow(row: Item): Promise<void> {
    const share = this.view.shareVersion;
    if (this.creating) { this.workspace.cancelNew(); this.creating = false; }
    if (this.view.task && this.view.task !== row.id) await this.workspace.back();
    await this.selectHost(row.host || '');
    if (this.view.task !== row.id) await this.workspace.openTask(row.id);
    if (this.view.shareVersion === share) this.pickingShareTarget = false;
  }

  private async createShareTarget(): Promise<void> {
    const share = this.view.shareVersion;
    if (this.view.task) await this.workspace.back();
    if (this.view.shareVersion !== share || !this.view.shareLabel) return;
    this.pickingShareTarget = false;
    if (!this.creating) {
      this.startNew(false);
      if (this.view.linked) await this.workspace.configureNew();
    }
  }

  private async showChoices(kind: string): Promise<void> {
    const origin = this.panel;
    this.choices = [];
    if (kind === 'engines') this.engineOptions = await this.workspace.engines();
    else this.choices = await this.workspace.preferences(kind);
    if ((this.creating || !!this.view.task) && this.panel === origin) this.panel = kind;
  }

  private async chooseEngine(engine: string): Promise<void> {
    await this.workspace.configureNew(engine);
    if (this.creating && this.panel === 'engines') { this.engine = engine; this.panel = ''; }
  }

  private hostName(id: string): string {
    const host = this.view.devices.find((r: Item) => r.id === id);
    return host ? this.deviceLabel(host) : '';
  }

  private async newTask(): Promise<void> {
    const text = this.view.draft.trim();
    if (!this.view.shareLabel && !text && !this.view.attachments.length && !this.view.uploadPending) return;
    const sharing = !!this.view.shareLabel;
    const version = this.view.shareVersion;
    const created = await this.workspace.create('', this.project.trim(), text, this.engine, sharing);
    if (created && sharing && this.view.shareVersion === version && this.view.shareLabel && this.view.task) {
      await this.workspace.acceptShare();
    }
  }

  private closePanel(): void {
    if (this.panel === 'rename' || this.panel === 'row-actions') this.actionRow = undefined;
    if (this.panel === 'new-host' && !this.view.device) { this.creating = false; this.workspace.cancelNew(); }
    if (this.panel === 'browse' || this.panel === 'path') this.panel = 'projects';
    else if (['status', 'sort', 'group', 'filter', 'companion-display'].includes(this.panel)) this.panel = 'display';
    else this.panel = '';
  }

  private isSheet(): boolean { return !!this.panel && this.panel !== 'settings'; }
  private sharePicker(): boolean { return !!this.view.shareLabel && this.pickingShareTarget; }

  private openRename(): void {
    if (!this.view.task || !this.view.linked || this.busy) return;
    this.actionRow = undefined;
    this.renaming = this.view.tasks.find((row: Item) => row.id === this.view.task)?.title || '';
    this.panel = 'rename';
  }

  private filterLabel(value: string): ResourceStr {
    return value === 'active' ? $r('app.string.ready_tasks') : value === 'archived' ? $r('app.string.archived') : $r('app.string.all_tasks');
  }

  private panelTitle(): ResourceStr {
    switch (this.panel) {
      case 'hosts': case 'new-host': return $r('app.string.select_host');
      case 'settings': return $r('app.string.settings');
      case 'companion-display': return $r('app.string.companions');
      case 'display': return $r('app.string.display_options');
      case 'sort': return $r('app.string.sort_by');
      case 'status': return $r('app.string.task_status');
      case 'group': return $r('app.string.group_by');
      case 'filter': return $r('app.string.filter_project');
      case 'attachments': return $r('app.string.add_file');
      case 'row-actions': return this.actionRow?.title || $r('app.string.task');
      case 'rename': return $r('app.string.rename');
      case 'detail': return $r('app.string.task_info');
      case 'engines': return $r('app.string.engine');
      case 'projects': case 'path': case 'browse': return $r('app.string.workspace_label');
      case 'model': return $r('app.string.model');
      case 'permission': return $r('app.string.permission_mode');
      default: return this.creating ? $r('app.string.create_new') : this.view.shareLabel ? $r('app.string.choose_target') : this.headerTitle();
    }
  }

  @Builder
  homeHostMenu() {
    Menu() {
      MenuItem({ content: $r('app.string.all_hosts') }).selected(!this.scope).selectIcon(true).id('menu-all-hosts')
        .onClick(() => { this.changeScope(''); })
      ForEach(this.view.devices, (host: Item) => {
        MenuItem({ content: this.deviceLabel(host), labelInfo: host.offline ? $r('app.string.offline') : '' }).selected(this.scope === host.id).selectIcon(true)
          .id('menu-host-' + host.id).onClick(() => this.run(async () => {
            const owner = this.view.account;
            await this.selectHost(host.id);
            if (this.view.account === owner && this.view.device === host.id) { this.changeScope(host.id); }
          }))
      }, (host: Item) => host.id)
    }
  }

  @Builder
  homeBar() {
    Row({ space: 4 }) {
      IconAction({ icon: $r('sys.symbol.line_3_horizontal'), controlId: 'navigation', label: $r('app.string.navigation'),
        onTap: () => { this.drawerOpen = true; } })
      Button({ type: ButtonType.Normal }) {
        Row({ space: 4 }) {
          Text(this.scope ? this.hostName(this.scope) : $r('app.string.all_hosts')).fontSize(18).fontWeight(FontWeight.Medium)
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).fontColor($r('app.color.ink')).constraintSize({ maxWidth: '85%' })
          SymbolGlyph($r('sys.symbol.chevron_down')).fontSize(13).fontColor([$r('app.color.muted')])
        }
      }.id('header-title').height(44).layoutWeight(1).backgroundColor(Color.Transparent).bindMenu(this.homeHostMenu)
      IconAction({ icon: $r('sys.symbol.slider_horizontal_2'), controlId: 'account-menu', label: $r('app.string.display_options'),
        reminder: this.statusFilter === 'archived' ? this.getUIContext().getHostContext()?.resourceManager.getStringSync($r('app.string.archived_filter_hint').id) || '' : '',
        onTap: () => { this.panel = 'display'; } })
    }.width('100%').padding({ left: 12, right: 12 })
  }

  private titleCompanion(cloud: boolean): Companion | undefined {
    const selected = cloud ? this.view.cloudCompanion : this.view.taskCompanion;
    if (!selected) return undefined;
    return this.view.companions?.find((row: Companion) => row.key === selected.key) || selected;
  }

  @Builder
  conversationTitle(cloud: boolean) {
    Row({ space: 8 }) {
      if (cloud ? this.view.cloudCompanion : this.view.taskCompanion) {
        ForEach([this.titleCompanion(cloud)!], (row: Companion) => {
          CompanionAvatar({ row, load: (buddy: Companion, visible: () => boolean) => this.workspace.companionAvatar(buddy, visible) })
        }, (row: Companion) => companionPortraitKey(row))
      }
      Text(cloud ? this.titleCompanion(true)?.title || '' : this.headerTitle()).id(cloud ? 'cloud-title' : 'task-title')
        .fontSize(18).fontWeight(FontWeight.Medium).layoutWeight(1)
        .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).fontColor($r('app.color.ink'))
    }.width('100%').height('100%').padding({ left: 8, right: 8 })
  }

  @Builder
  cloudTitle() {
    if (this.view.cloudCompanion?.group) {
      Button({ type: ButtonType.Normal }) { this.conversationTitle(true) }
        .id('group-profile-title-button').width('100%').height('100%').padding(0).backgroundColor(Color.Transparent)
        .accessibilityText(this.titleCompanion(true)?.title || '').accessibilityDescription($r('app.string.group_profile'))
        .onClick(() => { this.groupProfileKey = this.view.cloudCompanion?.key || ''; })
    } else {
      this.conversationTitle(true)
    }
  }

  @Builder
  groupMenu() {
    if (this.view.cloudCompanion?.group) {
      Row() {
        IconAction({ icon: $r('sys.symbol.gearshape'), controlId: 'group-settings', label: $r('app.string.group_settings'),
          onTap: () => { this.groupProfileKey = this.view.cloudCompanion?.key || ''; } })
      }.height('100%').padding({ right: 12 })
    }
  }

  @Builder
  taskTitle() {
    Row() { this.conversationTitle(false) }
      .height('100%').gesture(TapGesture({ count: 2 }).onAction(() => this.openRename()))
  }

  @Builder
  taskMenu() {
    Row() {
      IconAction({ icon: $r('sys.symbol.ellipsis_circle'), controlId: 'account-menu', label: $r('app.string.task_info'),
        onTap: () => { this.panel = 'detail'; } })
    }.height('100%').padding({ right: 12 })
  }

  @Builder
  previewMenu() {
    if (this.previewSource) {
      IconAction({ icon: $r('sys.symbol.ellipsis_circle'), label: $r('app.string.more_actions'), controlId: 'preview-more',
        menuItems: [{ value: $r('app.string.open_file'), action: () => this.run(() => this.openSelectedFile()) }] })
    }
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
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Text(this.view.account).layoutWeight(1).fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink')).maxLines(1)
        IconAction({ icon: $r('sys.symbol.xmark'), label: $r('app.string.close'), onTap: () => { this.drawerOpen = false; } })
      }.width('100%').padding({ left: 12 })
      OptionRow({ label: $r('app.string.search'), value: '', action: () => { this.drawerOpen = false; this.showSearch = true; }, control: 'drawer-search' })
      OptionRow({ label: $r('app.string.select_host'), value: this.scope ? this.hostName(this.scope) : $r('app.string.all_hosts'), action: () => {
        this.drawerOpen = false; this.panel = 'hosts';
      }, control: 'scope' })
      OptionRow({ label: $r('app.string.settings'), value: '', action: () => { this.drawerOpen = false; this.notice = ''; this.panel = 'settings'; }, control: 'settings' })
      Blank().layoutWeight(1)
      OptionRow({ label: $r('app.string.sign_out'), value: '', action: () => { this.drawerOpen = false; this.confirmLogout(); }, control: 'drawer-logout' })
    }.width('100%').height('100%').backgroundColor($r('app.color.panel'))
      .padding({ top: 8, left: 12, right: 12, bottom: 8 })
  }

  private confirmLogout(): void {
    this.getUIContext().showAlertDialog({ message: $r('app.string.logout_confirm'),
      primaryButton: { value: $r('app.string.cancel'), action: () => {} },
      secondaryButton: { value: $r('app.string.sign_out'), action: () => this.run(async () => {
        await this.workspace.logout(); this.phone = ''; this.org = ''; this.otp = ''; this.consent = false; this.codeSent = false; this.enterprise = false;
      }) } });
  }

  @Builder
  sheetOptions() {
    if (this.panel === 'hosts' || this.panel === 'new-host') {
      List() {
        if (this.panel === 'hosts') {
          ListItem() { ChoiceRow({ label: $r('app.string.all_hosts'), group: 'hosts', selected: !this.scope, action: () => { this.changeScope(''); this.panel = ''; }, control: 'all-hosts' }) }.sheetInset()
        }
        ForEach(this.view.devices, (item: Item) => {
          ListItem() { ChoiceRow({ label: this.deviceLabel(item), control: item.id, group: this.panel,
            selected: this.panel === 'new-host' ? item.id === this.view.device : item.id === this.scope,
            detail: item.offline ? this.getUIContext().getHostContext()!.resourceManager.getStringSync($r('app.string.offline').id) : '',
            available: !this.busy && (this.panel !== 'new-host' || !this.hostOffline(item.id)),
            action: () => this.run(() => this.chooseHost(item.id)) }) }.sheetInset()
        }, (item: Item) => item.id)
      }.layoutWeight(1).width('100%')
    } else if (this.panel === 'engines') {
      ChoiceRow({ label: $r('app.string.host_default'), group: 'engine', selected: !this.engine, action: () => { this.run(() => this.chooseEngine('')); }, control: 'engine-default' })
      ForEach(this.engineOptions, (id: string) => {
        ChoiceRow({ label: id, group: 'engine', selected: id === this.engine, action: () => { this.run(() => this.chooseEngine(id)); }, control: 'engine-' + id })
      })
    } else if (this.panel === 'projects') {
      List() {
        ListItem() { ChoiceRow({ label: $r('app.string.dialogue'), group: 'project', selected: !this.project, action: () => { this.project = ''; this.panel = ''; }, control: 'dialogue' }) }.sheetInset()
        ListItem() { OptionRow({ label: $r('app.string.browse_computer'), value: '', action: () => this.run(() => this.browse(this.project || '~')), control: 'browse-computer' }) }.sheetInset()
        ListItem() { OptionRow({ label: $r('app.string.other_path'), value: '', action: () => { this.pathInput = this.project; this.panel = 'path'; }, control: 'choose-path' }) }.sheetInset()
        ForEach(Array.from(new Set(this.view.tasks.map((t: Item) => t.project || '').filter((p: string) => !!p))), (path: string) => {
          ListItem() { ChoiceRow({ label: this.basename(path), detail: path, control: 'project-' + path, group: 'project', selected: this.project === path, action: () => { this.project = path; this.panel = ''; } }) }.sheetInset()
        })
      }.layoutWeight(1).width('100%')
    } else if (this.panel === 'browse') {
      this.infoRow($r('app.string.workspace_label'), this.folders.path)
      if (this.folders.parent) { OptionRow({ label: $r('app.string.parent_folder'), value: '', action: () => this.run(() => this.browse(this.folders.parent)), control: 'parent-folder' }) }
      List() {
        ForEach(this.folders.rows, (dir: Item) => {
          ListItem() { DirectoryRow({ title: dir.title, targetId: dir.id, open: () => this.run(() => this.browse(dir.id)) }) }.sheetInset()
        }, (dir: Item) => dir.id)
      }.layoutWeight(1).width('100%')
      PillAction({ label: $r('app.string.use_path'), prominent: true, onTap: () => { this.project = this.folders.path; this.panel = ''; } })
    } else if (this.panel === 'path') {
      TextInput({ placeholder: $r('app.string.workspace_path'), text: this.pathInput }).id('project-dir').onChange((v: string) => { this.pathInput = v; })
      PillAction({ label: $r('app.string.use_path'), available: !!this.pathInput.trim(), onTap: () => { this.project = this.pathInput.trim(); this.panel = ''; } })
    } else if (this.panel === 'attachments') {
      OptionRow({ label: $r('app.string.album'), value: '', action: () => this.pickAttachment('image'), control: 'pick-image' })
      OptionRow({ label: $r('app.string.file'), value: '', action: () => this.pickAttachment('file'), control: 'pick-file' })
    } else if (this.panel === 'display') {
      OptionRow({ label: $r('app.string.task_status'), value: this.filterLabel(this.statusFilter), showReminder: this.statusFilter === 'archived',
        action: () => { this.panel = 'status'; }, control: 'display-status' })
      OptionRow({ label: $r('app.string.group_by'), value: this.homeGroupingLabel(), action: () => { this.panel = 'group'; }, control: 'display-group' })
      OptionRow({ label: $r('app.string.sort_by'), value: this.sortBy === 'created' ? $r('app.string.by_created') : $r('app.string.recent'), action: () => { this.panel = 'sort'; }, control: 'display-sort' })
      OptionRow({ label: $r('app.string.filter_project'), value: this.projectFilter ? this.projectName(this.projectFilter) : $r('app.string.all_projects'), action: () => { this.panel = 'filter'; }, control: 'display-filter' })
      OptionRow({ label: $r('app.string.companions'), value: '', action: () => { this.panel = 'companion-display'; }, control: 'display-companions' })
      OptionRow({ label: $r('app.string.refresh'), value: '', action: () => { this.panel = ''; this.run(() => this.workspace.reconnect()); }, control: 'refresh-home' })
    } else if (this.panel === 'companion-display') {
      Row({ space: 12 }) {
        Text($r('app.string.show_collapsed_avatars')).fontSize(16).fontColor($r('app.color.ink')).layoutWeight(1)
          .accessibilityLevel('no').onClick(() => this.workspace.setCompanionDisplay('showCollapsedCompanionAvatars', !this.view.showCollapsedCompanionAvatars))
        Toggle({ type: ToggleType.Switch, isOn: this.view.showCollapsedCompanionAvatars }).id('show-collapsed-avatars')
          .selectedColor($r('app.color.action')).accessibilityText($r('app.string.show_collapsed_avatars'))
          .onChange((on: boolean) => this.workspace.setCompanionDisplay('showCollapsedCompanionAvatars', on))
      }.width('100%').constraintSize({ minHeight: 48 }).padding({ left: 12, right: 12 })
    } else if (this.panel === 'status') {
      ForEach(['active', 'archived', 'all'], (filter: string) => {
        ChoiceRow({ label: this.filterLabel(filter), group: 'status', selected: this.statusFilter === filter,
          showReminder: filter === 'archived' && this.statusFilter === filter, action: () => { this.statusFilter = filter; this.panel = ''; }, control: 'status-' + filter })
      })
    } else if (this.panel === 'sort') {
      ChoiceRow({ label: $r('app.string.recent'), group: 'sort', selected: this.sortBy === 'recent', action: () => { this.sortBy = 'recent'; this.panel = ''; }, control: 'recent' })
      ChoiceRow({ label: $r('app.string.by_created'), group: 'sort', selected: this.sortBy === 'created', action: () => { this.sortBy = 'created'; this.panel = ''; }, control: 'sort-created' })
    } else if (this.panel === 'group') {
      if (this.view.devices.length > 1) {
        ChoiceRow({ label: $r('app.string.computer'), multi: true, selected: this.groupDevices,
          action: () => { this.groupDevices = !this.groupDevices; this.panel = ''; }, control: 'group-device' })
      }
      ChoiceRow({ label: $r('app.string.project'), multi: true, selected: this.groupProjects, action: () => { this.groupProjects = !this.groupProjects; this.panel = ''; }, control: 'group-project' })
      ChoiceRow({ label: $r('app.string.ungrouped'), multi: true, selected: !this.groupProjects && !(this.groupDevices && this.view.devices.length > 1), action: () => { this.groupProjects = false; this.groupDevices = false; this.panel = ''; }, control: 'group-flat' })
    } else if (this.panel === 'filter') {
      List() {
        ListItem() { ChoiceRow({ label: $r('app.string.all_projects'), group: 'filter', selected: !this.projectFilter, action: () => { this.projectFilter = ''; this.panel = ''; }, control: 'filter-all' }) }.sheetInset()
        ForEach(Array.from(new Set(this.scopedRows().map((r: Item) => this.groupKey(r)))), (key: string) => {
          ListItem() { ChoiceRow({ label: this.projectName(key), group: 'filter', selected: this.projectFilter === key, action: () => { this.projectFilter = key; this.panel = ''; }, control: 'filter-' + key }) }.sheetInset()
        })
      }.width('100%').layoutWeight(1)
    } else if (this.panel === 'detail') {
      Scroll() {
        Column() {
          OptionRow({ label: $r('app.string.rename'), value: this.headerTitle(), action: () => this.openRename(), control: 'rename-task' }).enabled(this.view.linked && !this.busy)
          this.infoRow($r('app.string.computer'), this.hostName(this.view.device))
          this.infoRow($r('app.string.workspace_label'), this.view.tasks.find((r: Item) => r.id === this.view.task)?.project || $r('app.string.dialogue'))
          if (this.view.agent) { this.infoRow($r('app.string.engine'), this.view.agent) }
          if (this.view.model) { this.infoRow($r('app.string.model'), this.view.model) }
          if (this.view.permission) { this.infoRow($r('app.string.permission_mode'), this.view.permission) }
          if (this.view.hasOlder && this.view.linked) {
            OptionRow({ label: $r('app.string.older'), value: '', action: () => { this.panel = ''; this.run(async () => {
              this.followEnd = false; this.scroll.scrollEdge(Edge.Top); await this.workspace.older();
            }); }, control: 'task-older' })
          }
        }.width('100%').padding({ left: 16, right: 16 })
      }.align(Alignment.Top).layoutWeight(1)
    } else if (this.panel === 'row-actions' && this.actionRow) {
      this.taskRowMenu(this.actionRow)
    } else if (this.panel === 'rename') {
      TextInput({ text: this.renaming }).id('rename-input').maxLength(200).onChange((v: string) => { this.renaming = v; })
      PillAction({ label: $r('app.string.save'), prominent: true, available: !this.busy && !!this.renaming.trim(), onTap: () => this.run(async () => {
        if (this.actionRow) await this.updateHomeTask(this.actionRow, 'rename', this.renaming);
        else await this.workspace.rename(this.renaming);
        this.actionRow = undefined; this.panel = '';
      }) })
    } else if (this.panel === 'model' || this.panel === 'permission') {
      List() {
        if (this.creating && this.panel === 'model' && !this.view.legacyPicker) {
          ListItem() { OptionRow({ label: $r('app.string.engine'), value: this.view.agent || $r('app.string.host_default'), action: () => this.run(() => this.showChoices('engines')), control: 'picker-engine' }) }.sheetInset()
        }
        ForEach(this.choices, (opt: PreferenceOption) => {
          if (opt.sectionBrand) {
            ListItem() {
              Row({ space: 8 }) {
                ModelBrandIcon({ brand: opt.sectionBrand, control: 'provider-' + opt.provider })
                Text(opt.summary).fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.muted')).layoutWeight(1)
              }.padding({ left: 12, right: 12, top: 8, bottom: 4 }).width('100%').accessibilityGroup(true)
            }.sheetInset()
          }
          ListItem() { ChoiceRow({ label: opt.title, detail: opt.provider ? '' : opt.summary || '', description: opt.summary || '',
            brand: opt.brand, control: 'pref-' + opt.id, group: this.panel,
            selected: this.panel === 'permission' ? opt.id === this.view.permission :
              opt.provider ? opt.model === this.view.model && !!opt.activeSource : opt.id === this.view.model,
            available: !this.busy && this.view.linked && !this.view.running, action: () => this.run(async () => {
              await this.workspace.applyPreference(this.panel, opt.id); this.panel = '';
            }) }) }.sheetInset()
        }, (opt: PreferenceOption) => opt.id)
        if (!this.choices.length) { ListItem() { Text($r('app.string.no_choices')).fontColor($r('app.color.muted')).padding(16) }.sheetInset() }
      }.layoutWeight(1).width('100%')
    }
  }

  private pickAttachment(kind: string): void {
    this.panel = '';
    this.inputOpen = true;
    this.uploadAttachment(kind);
  }

  private async uploadAttachment(kind: string, retryId?: string): Promise<void> {
    this.notice = '';
    try {
      if (kind) await this.workspace.addFile(kind);
      else await this.workspace.retryFile(retryId);
    } catch (e) {
      if (!this.view.failedFile) this.notice = (e as Error).message;
    }
  }

  private projectName(key: string): ResourceStr {
    const row = this.scopedRows().find((r: Item) => this.groupKey(r) === key);
    if (!row) return $r('app.string.all_projects');
    return row.project ? (this.scope ? this.basename(row.project) : this.hostName(row.host || '') + ' · ' + this.basename(row.project)) : $r('app.string.dialogue');
  }

  private sheetGutter(): number {
    return ['hosts', 'new-host', 'projects', 'browse', 'filter', 'detail', 'model', 'permission'].includes(this.panel) ? 0 : 16;
  }

  @Builder
  sheetContent() {
    Column({ space: 4 }) {
      Row() {
        IconAction({ icon: $r('sys.symbol.chevron_left'), label: $r('app.string.back'), controlId: 'sheet-back', available: !this.busy, onTap: () => this.closePanel() })
        Text(this.panelTitle()).textAlign(TextAlign.Center).fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink')).layoutWeight(1)
        Blank().width(44)
      }.width('100%').padding({ left: 16, right: 16 })
      this.errorNotice()
      Column({ space: 4 }) { this.sheetOptions() }
        .layoutWeight(1).width('100%').padding({ left: this.sheetGutter(), right: this.sheetGutter() })
    }.width('100%').height('100%').padding({ bottom: 12 })
  }

  @Builder
  newForm() {
    Column({ space: 6 }) {
      Blank().layoutWeight(1)
      OptionRow({ label: $r('app.string.computer'), value: this.hostName(this.view.device) || $r('app.string.select_host'), action: () => { this.panel = 'new-host'; }, control: 'new-task-host' })
      if (this.view.legacyPicker) {
        OptionRow({ label: $r('app.string.engine'), value: this.view.agent || $r('app.string.host_default'), action: () => this.run(() => this.showChoices('engines')), control: 'new-task-engine' })
      }
      OptionRow({ label: $r('app.string.workspace_label'), value: this.project ? this.basename(this.project) : $r('app.string.dialogue'), action: () => { this.panel = 'projects'; }, control: 'new-task-project' })
      this.composer()
    }.width('100%').layoutWeight(1).padding({ left: 16, right: 16 })
  }

  private matchingCompanions(): Companion[] {
    return matchingCompanions(this.view.companions || [], this.query, this.scope);
  }

  private companionSummary(row: Companion): string {
    if (row.recentCall) return this.getUIContext().getHostContext()!.resourceManager.getStringSync($r('app.string.call_history').id);
    return row.preview || row.subtitle || this.getUIContext().getHostContext()!.resourceManager.getStringSync($r('app.string.companion_no_preview').id);
  }

  private companionDescription(row: Companion): string {
    return row.group ? this.getUIContext().getHostContext()!.resourceManager.getStringSync($r('app.string.group_chat').id) : '';
  }

  @Builder
  companionSection() {
    if (this.matchingCompanions().length || (this.view.companionError && !this.query.trim())) {
      ListItem() {
        Row() {
          Button({ type: ButtonType.Normal }) {
            Row({ space: 8 }) {
              SymbolGlyph(this.view.companionsCollapsed && !this.query.trim() ? $r('sys.symbol.chevron_right') : $r('sys.symbol.chevron_down'))
                .fontSize(14).width(22).fontColor([$r('app.color.muted')])
              SymbolGlyph($r('sys.symbol.person_2')).fontSize(19).fontColor([$r('app.color.muted')])
              Text($r('app.string.companions')).fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink'))
              Blank()
              if (this.matchingCompanions().length && (!this.view.companionsCollapsed || this.query.trim() || !this.view.showCollapsedCompanionAvatars)) {
                Text(this.matchingCompanions().length.toString()).id('companions-count').fontSize(14).fontColor($r('app.color.muted'))
              }
            }.width('100%')
          }.id('companions-header').height(44).layoutWeight(1).padding(DIRECTORY_ROW_INSETS).backgroundColor(Color.Transparent)
            .onClick(() => {
              if (this.query.trim()) return;
              if (!this.view.companionsCollapsed) this.companionsExpanded = false;
              this.workspace.setCompanionDisplay('companionsCollapsed', !this.view.companionsCollapsed);
            })
          if (this.view.companionError && !this.query.trim()) {
            IconAction({ icon: $r('sys.symbol.arrow_clockwise'), label: $r('app.string.companions_retry'), controlId: 'companions-retry',
              onTap: () => this.run(() => this.workspace.refreshCompanions()) })
          }
        }.width('100%')
      }
      if (!this.view.companionsCollapsed || this.query.trim()) {
        ForEach(this.companionsExpanded || this.query.trim() ? this.matchingCompanions() : this.matchingCompanions().slice(0, 3), (row: Companion) => {
          ListItem() {
            Button({ type: ButtonType.Normal }) {
              Row({ space: 12 }) {
                CompanionAvatar({ row, portraitSize: 44, load: (buddy: Companion, visible: () => boolean) => this.workspace.companionAvatar(buddy, visible) })
                Column({ space: 3 }) {
                  Text(row.title).id('companion-name').fontSize(16).fontColor($r('app.color.ink')).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
                  Text(this.companionSummary(row)).id(row.recentCall || row.preview ? 'companion-preview' : 'companion-subtitle').fontSize(14).fontColor($r('app.color.muted')).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
                }.alignItems(HorizontalAlign.Start).layoutWeight(1)
              }.width('100%')
            }.id('companion-row-' + row.key).constraintSize({ minHeight: 58 }).width('100%').padding(DIRECTORY_ROW_INSETS).backgroundColor(Color.Transparent)
              .onVisibleAreaChange([0], (visible: boolean, ratio: number) => {
                if (!row.group && !row.actor) this.workspace.loadCompanionCall(row.key, visible && ratio > 0);
              })
              .onDisAppear(() => { if (!row.group && !row.actor) this.workspace.loadCompanionCall(row.key, false); })
              .accessibilityText([row.title, this.companionSummary(row)].join('，')).accessibilityDescription(this.companionDescription(row)).onClick(() => this.run(() => this.workspace.openCompanion(row.key)))
          }
        }, (row: Companion) => JSON.stringify([companionPortraitKey(row), row.preview, row.subtitle, row.recentCall]))
        if (!this.query.trim() && this.matchingCompanions().length > 3) {
          ListItem() {
            Button(this.companionsExpanded ? $r('app.string.companions_less') : $r('app.string.companions_all', this.matchingCompanions().length))
              .id('companions-show-all').height(44).fontColor($r('app.color.muted')).backgroundColor(Color.Transparent)
              .onClick(() => { this.companionsExpanded = !this.companionsExpanded; })
          }
        }
      } else if (this.view.showCollapsedCompanionAvatars && this.matchingCompanions().length) {
        ListItem() {
          Scroll() {
            Row({ space: 8 }) {
              ForEach(this.matchingCompanions(), (row: Companion) => {
                Button({ type: ButtonType.Normal }) {
                  Column({ space: 4 }) {
                    CompanionAvatar({ row, portraitSize: 36, load: (buddy: Companion, visible: () => boolean) => this.workspace.companionAvatar(buddy, visible) })
                    Text(row.title).fontSize(12).lineHeight(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink'))
                      .width('100%').maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).textAlign(TextAlign.Center)
                  }.width('100%')
                }.id('companion-strip-' + row.key).width(48).padding({ top: 6, bottom: 6 }).borderRadius(8).backgroundColor(Color.Transparent)
                  .accessibilityText(row.title).accessibilityDescription(this.companionDescription(row))
                  .onClick(() => this.run(() => this.workspace.openCompanion(row.key)))
              }, (row: Companion) => companionPortraitKey(row))
            }.padding({ left: 16, right: 16, bottom: 12 })
          }.id('companions-strip').width('100%').align(Alignment.Start).scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off)
        }
      }
    }
  }

  @Builder
  cloudConversation() {
    Column() {
      if (this.view.cloudMessages?.length || this.view.cloudOlder) {
        List({ space: 10, initialIndex: this.view.cloudMessages?.length || 0 }) {
          ListItem() {
            if (this.view.cloudOlder) {
              PillAction({ label: $r('app.string.older'), available: !this.view.cloudLoading,
                onTap: () => this.run(() => this.workspace.cloudHistory(true)) })
            }
          }
          ForEach(this.view.cloudMessages, (item: Item) => {
            ListItem() {
              Row() {
                if (item.role === 'user') { Blank().layoutWeight(1) }
                Column({ space: 4 }) {
                  if (item.author) {
                    Text(item.author).fontSize(13).fontColor($r('app.color.muted'))
                  }
                  Text(item.title).fontSize(16).fontColor($r('app.color.ink')).copyOption(CopyOptions.InApp)
                }.alignItems(HorizontalAlign.Start).padding(10).constraintSize({ maxWidth: item.role === 'user' ? '88%' : '100%' })
                  .backgroundColor(item.role === 'user' ? $r('app.color.panel') : Color.Transparent).borderRadius(12)
              }.width('100%').padding(DIRECTORY_ROW_INSETS)
            }
          }, (item: Item) => JSON.stringify([item.id, item.author, item.title]))
        }.id('companion-history').width('100%').layoutWeight(1).maintainVisibleContentPosition(true)
      } else if (this.view.cloudLoading) {
        LoadingProgress().width(32).height(32).margin(24)
      } else if (!this.view.cloudError) {
        Text($r('app.string.companion_empty')).fontColor($r('app.color.muted')).padding(20)
      }
      if (this.view.cloudError) {
        PillAction({ label: $r('app.string.companion_history_retry'), onTap: () => this.run(() => this.workspace.cloudHistory(false)) })
      }
      Text(this.view.cloudCompanion?.group ? $r('app.string.group_readonly') : $r('app.string.companion_readonly')).id('companion-readonly').fontSize(13).fontColor($r('app.color.muted')).padding(12)
    }.height('100%').width('100%').backgroundColor($r('app.color.canvas'))
  }

  @Builder
  directory(page: string) {
    if ((page === 'home' && this.showSearch) || page === 'share') {
      Row() {
        Search({ placeholder: page === 'share' ? $r('app.string.search_task') : $r('app.string.search_home'), value: page === 'share' ? this.shareQuery : this.query }).id('search-tasks').height(40).layoutWeight(1)
          .cancelButton({ style: CancelButtonStyle.INPUT }).onChange((v: string) => { if (page === 'share') this.shareQuery = v; else this.query = v; })
        if (page !== 'share') { IconAction({ icon: $r('sys.symbol.xmark'), label: $r('app.string.close'), controlId: 'close-search',
          onTap: () => { this.showSearch = false; this.query = ''; } }) }
      }.padding({ left: 16, right: 16 })
    }
    if (page === 'share' && this.view.devices.some((d: Item) => !this.hostOffline(d.id))) {
      OptionRow({ label: $r('app.string.create_new'), value: '', action: () => this.run(() => this.createShareTarget()), control: 'share-new-task' })
    }
    Stack({ alignContent: Alignment.BottomEnd }) {
      List({ space: 0, scroller: page === 'project' ? this.projectScroller : page === 'share' ? this.shareScroller : this.homeScroller }) {
        if (page === 'home' && !this.projectFilter && this.statusFilter !== 'archived') {
          this.companionSection()
        }
        ForEach(this.directoryEntries(page), (entry: DirectoryEntry) => {
          if (entry.kind === 'device') {
            ListItem() {
              Button({ type: ButtonType.Normal }) {
                Row({ space: 8 }) {
                  SymbolGlyph(this.collapsed.includes(entry.key) ? $r('sys.symbol.chevron_right') : $r('sys.symbol.chevron_down'))
                    .fontSize(14).width(22).fontColor([$r('app.color.muted')])
                  Text(this.hostName(entry.group!.head.host || '')).fontSize(16)
                    .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink'))
                }.width('100%')
              }.id('device-section-' + entry.group!.head.host).height(44).width('100%').padding(DIRECTORY_ROW_INSETS).backgroundColor(Color.Transparent)
                .onClick(() => this.toggleHomeGroup(entry.key))
            }
          } else if (entry.kind === 'heading') {
            ListItem() { this.projectHeading({ group: entry.group!, attention: entry.attention || '' }) }
          } else if (entry.kind === 'task') {
            this.taskListItem({ item: this.currentTask(entry) })
          } else if (entry.kind === 'moreGroup') {
            ListItem() {
              Button($r('app.string.view_group', entry.group!.total)).id('view-all-' + entry.group!.key).height(44)
                .fontColor($r('app.color.muted')).fontSize(14).backgroundColor(Color.Transparent)
                .onClick(() => this.run(async () => {
                  const project = entry.group!.head;
                  await this.selectHost(project.host || '');
                  if (this.view.device === project.host) this.projectList = project;
                }))
            }
          } else if (entry.kind === 'empty') {
            ListItem() {
              Column({ space: 12 }) {
                Text((page === 'share' ? this.shareQuery : this.query).trim() ? $r('app.string.no_matches') : !this.view.devices.length ? $r('app.string.no_hosts') :
                  this.view.device && this.hostOffline(this.view.device) ? $r('app.string.offline_empty') : $r('app.string.no_tasks')).fontSize(15).fontColor($r('app.color.muted'))
                if ((page === 'share' ? this.shareQuery : this.query).trim()) {
                  PillAction({ label: $r('app.string.clear_search'), onTap: () => { if (page === 'share') this.shareQuery = ''; else this.query = ''; } })
                } else if (!this.view.devices.length) {
                  PillAction({ label: $r('app.string.refresh'), onTap: () => this.run(() => this.workspace.devices()) })
                } else if (page !== 'share' && this.statusFilter !== 'active') {
                  PillAction({ label: $r('app.string.ready_tasks'), onTap: () => { this.statusFilter = 'active'; } })
                }
              }.width('100%').padding(24)
            }
          } else {
            ListItem() { PillAction({ label: $r('app.string.more_tasks'), available: !this.busy, onTap: () => this.run(() => this.workspace.more()) }) }
          }
        }, (entry: DirectoryEntry) => {
          if (entry.kind === 'heading') return JSON.stringify([entry.key, entry.group!.total, entry.attention]);
          if (entry.kind === 'moreGroup') return JSON.stringify([entry.key, entry.group!.total]);
          return entry.key;
        })
      }.width('100%').height('100%').contentEndOffset(76)
      if (page === 'home' && this.view.devices.length) {
        Button({ type: ButtonType.Circle }) { SymbolGlyph($r('sys.symbol.square_and_pencil')).fontSize(23).fontColor([$r('app.color.on_action')]) }
          .id('new-task').width(56).height(56).margin({ right: 20, bottom: 12 }).backgroundColor($r('app.color.action'))
          .accessibilityText($r('app.string.create_new')).onClick(() => this.startNew())
      }
    }.layoutWeight(1).width('100%')
  }

  private homeActionsAvailable(item: Item): boolean {
    return !this.busy && !this.sharePicker() && !!item.host && !this.hostOffline(item.host) && (item.host !== this.view.device || this.view.linked);
  }

  private updateHomeTask(item: Item, action: string, title: string = ''): Promise<void> {
    return this.workspace.changeHomeTask(item.host || '', item.id, action, title, (names: string[]) => {
      return new Promise<boolean>((resolve) => this.getUIContext().showAlertDialog({
        message: $r('app.string.archive_schedules', names.join('、')), cancel: () => resolve(false),
        primaryButton: { value: $r('app.string.cancel'), action: () => resolve(false) },
        secondaryButton: { value: $r('app.string.archive_task'), action: () => resolve(true) }
      }));
    });
  }

  private chooseRowAction(item: Item, action: string): void {
    if (!this.homeActionsAvailable(item)) return;
    const scroller = this.projectList ? this.projectScroller : this.homeScroller;
    scroller.closeAllSwipeActions();
    if (action === 'more') {
      this.actionRow = item; this.panel = 'row-actions';
    } else if (action === 'rename') {
      this.actionRow = item; this.renaming = item.title; this.panel = 'rename';
    } else { this.closePanel(); this.run(() => this.updateHomeTask(item, action)); }
  }

  private pinLabel(item: Item): Resource {
    return item.pinnedAt ? $r('app.string.unpin_task') : $r('app.string.pin_task');
  }

  private archiveLabel(item: Item): Resource {
    return item.status === 'archived' ? $r('app.string.restore_task') : $r('app.string.archive_task');
  }

  @Builder
  taskRowMenu(item: Item) {
    Column() {
      if (item.status !== 'archived' || item.pinnedAt) {
        OptionRow({ label: this.pinLabel(item), value: '', control: 'row-menu-pin',
          action: () => this.chooseRowAction(item, item.pinnedAt ? 'unpin' : 'pin') })
      }
      OptionRow({ label: $r('app.string.rename'), value: '', control: 'row-menu-rename', action: () => this.chooseRowAction(item, 'rename') })
      OptionRow({ label: this.archiveLabel(item), value: '', control: 'row-menu-archive',
        action: () => this.chooseRowAction(item, item.status === 'archived' ? 'restore' : 'archive') })
    }.width('100%')
  }

  @Builder
  swipeTaskAction(item: Item, leading: boolean) {
    Row() {
      if (!leading) {
        IconAction({ icon: $r('sys.symbol.ellipsis_circle'), label: $r('app.string.more_actions'),
          controlId: 'row-swipe-more', onTap: () => this.chooseRowAction(item, 'more') })
      }
      Button(leading ? this.pinLabel(item) : this.archiveLabel(item)).id(leading ? 'row-swipe-pin' : 'row-swipe-archive')
        .height(44).fontSize(14).backgroundColor($r('app.color.chip')).fontColor($r('app.color.ink'))
        .onClick(() => this.chooseRowAction(item, leading ? (item.pinnedAt ? 'unpin' : 'pin') : (item.status === 'archived' ? 'restore' : 'archive')))
    }
  }

  private taskIdentity(item: Item): string {
    const resources = this.getUIContext().getHostContext()!.resourceManager;
    if (item.status === 'archived') return resources.getStringSync($r('app.string.archived').id);
    if (item.lead) return resources.getStringSync($r('app.string.row_lead').id);
    if (item.attached) return resources.getStringSync($r('app.string.row_attached').id);
    if (item.agentKind === 'cc' || item.agentKind === 'claude-code') return 'Claude Code';
    if (item.agentKind === 'codex') return 'Codex';
    if (item.agentKind === 'pi') return 'Pi';
    return item.agentKind || resources.getStringSync($r('app.string.row_engine').id);
  }

  private taskHasPreview(item: Item): boolean {
    return !!item.summary && item.summary !== item.title;
  }

  private taskMarkColor(item: Item): Resource {
    return item.status !== 'archived' && item.running && this.rowStatus(item) === 'running'
      ? $r('app.color.running') : $r('app.color.faint');
  }

  private showsCodexMark(item: Item): boolean {
    return item.agentKind === 'codex' && item.status !== 'archived' && !item.lead && !item.attached;
  }

  @Builder
  taskMark($$: TaskRowContent) {
    Stack({ alignContent: Alignment.Center }) {
      if ($$.item.status === 'archived' || $$.item.lead || $$.item.attached) {
        SymbolGlyph($$.item.status === 'archived' ? $r('sys.symbol.archivebox') : $$.item.lead ? $r('sys.symbol.person_2') : $r('sys.symbol.link'))
          .fontSize($$.item.lead && $$.item.status !== 'archived' ? 20 : 18).fontColor([this.taskMarkColor($$.item)])
      } else if ($$.item.agentKind === 'codex' || $$.item.agentKind === 'pi' || $$.item.agentKind === 'cc' || $$.item.agentKind === 'claude-code') {
        // Tint the painted SVG pixels, preserving open strokes and transparent interiors.
        Stack() {
          Image($$.item.agentKind === 'codex' ? $r('app.media.agent_codex') : $$.item.agentKind === 'pi' ? $r('app.media.agent_pi') : $r('app.media.agent_claude'))
            .width('100%').height('100%')
          Rect().width('100%').height('100%').fill(this.taskMarkColor($$.item)).blendMode(BlendMode.SRC_IN)
        }.width($$.item.agentKind === 'cc' || $$.item.agentKind === 'claude-code' ? 19 : 18).aspectRatio(1)
          .blendMode(BlendMode.SRC_OVER, BlendApplyType.OFFSCREEN)
      } else {
        SymbolGlyph($r('sys.symbol.square_grid_2x2')).fontSize(18).fontColor([this.taskMarkColor($$.item)])
      }
      if ($$.item.status !== 'archived' && ($$.item.hasDraft || $$.item.localDraft)) {
        SymbolGlyph(this.showsCodexMark($$.item) ? $r('sys.symbol.pencil_line') : $r('sys.symbol.square_and_pencil'))
          .id('draft-' + $$.item.id).fontSize(9).fontColor([$r('app.color.muted')])
          .width(12).height(12).position({ x: 15, y: 15 })
          .backgroundColor(this.showsCodexMark($$.item) ? Color.Transparent : $r('app.color.canvas')).borderRadius(6)
          .accessibilityText($r('app.string.row_draft'))
      }
      if ($$.item.remote && $$.item.status !== 'archived' && !$$.item.lead && !$$.item.attached) {
        if ($$.item.agentKind === 'codex') {
          Image($r('app.media.codex_remote_signal')).width(24).height(24).fillColor(this.taskMarkColor($$.item))
            .accessibilityText($r('app.string.row_remote'))
        } else {
          SymbolGlyph($r('sys.symbol.link')).fontSize(10).fontColor([this.taskMarkColor($$.item)])
            .position({ x: 14, y: 0 }).backgroundColor($r('app.color.canvas')).accessibilityText($r('app.string.row_remote'))
        }
      }
    }.width(24).height(24)
      // Android places the mark 5 dp above the row center when a preview is visible.
      .translate({ y: this.taskHasPreview($$.item) ? -5 : 0 }).id('identity-' + $$.item.id).accessibilityText(this.taskIdentity($$.item))
  }

  @Builder
  taskListItem($$: TaskRowContent) {
    ListItem() {
      Button({ type: ButtonType.Normal }) {
        Row({ space: 12 }) {
          this.taskMark({ item: $$.item })
          Column({ space: 2 }) {
            Text($$.item.title).fontSize(15).lineHeight(22).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).fontColor($r('app.color.ink'))
            if (this.taskHasPreview($$.item)) {
              Text($$.item.summary).fontSize(13).lineHeight(18).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).fontColor($r('app.color.muted'))
            }
          }.alignItems(HorizontalAlign.Start).layoutWeight(1)
          Column({ space: 2 }) {
            this.taskStatus({ item: $$.item })
            if ($$.item.scheduled || $$.item.pinnedAt) {
              Row({ space: 4 }) {
                if ($$.item.scheduled) {
                  Stack({ alignContent: Alignment.BottomEnd }) {
                    SymbolGlyph($r('sys.symbol.timer')).fontSize(15).fontColor([$r('app.color.muted')])
                    if ($$.item.scheduleStopped) {
                      SymbolGlyph($r('sys.symbol.pause_fill')).fontSize(8)
                        .fontColor([$r('app.color.muted')]).backgroundColor($r('app.color.canvas'))
                    }
                  }.id('schedule-' + $$.item.id).accessibilityText($$.item.scheduleStopped ? $r('app.string.row_stopped_schedule') : $r('app.string.row_scheduled'))
                }
                if ($$.item.pinnedAt) {
                  SymbolGlyph($r('sys.symbol.pin')).id('pin-' + $$.item.id).fontSize(14).fontColor([$r('app.color.muted')]).accessibilityText($r('app.string.row_pinned'))
                }
              }
            }
          }.alignItems(HorizontalAlign.End)
        }.padding({ top: 4, bottom: 4 }).width('100%')
      }.id(!this.scope && this.view.devices.length > 1 ? JSON.stringify(['task', $$.item.host, $$.item.id]) : $$.item.id)
        .constraintSize({ minHeight: 44 }).width('100%').padding(DIRECTORY_ROW_INSETS).backgroundColor(Color.Transparent).enabled(this.rowAvailable($$.item))
        .priorityGesture(LongPressGesture({ repeat: false }).onAction(() => this.chooseRowAction($$.item, 'more')))
        .accessibilityDescription(this.statusDescription($$.item))
        .onClick(() => { if (!this.panel) this.run(() => this.openRow($$.item)); })
    }.swipeAction({
      start: this.homeActionsAvailable($$.item) && ($$.item.status !== 'archived' || !!$$.item.pinnedAt) ?
        () => { this.swipeTaskAction($$.item, true); } : undefined,
      end: this.homeActionsAvailable($$.item) ? () => { this.swipeTaskAction($$.item, false); } : undefined
    })
  }

  private rowStatus(row: Item): string {
    if (!row.host || !this.view.liveHosts?.includes(row.host)) return 'time';
    return row.rightStatus || (row.running ? 'running' : 'time');
  }

  private groupAttention(group: HomeGroup): string {
    for (const state of ['error', 'awaiting', 'done']) {
      if (group.rows.some((row: Item) => !this.hostOffline(row.host || '') && this.rowStatus(row) === state)) return state;
    }
    return '';
  }

  private statusLabel(status: string): Resource {
    if (status === 'error') return $r('app.string.task_error');
    if (status === 'awaiting') return $r('app.string.task_awaiting');
    if (status === 'done') return $r('app.string.task_done');
    return $r('app.string.working');
  }

  private statusDescription(item: Item): string {
    const resources = this.getUIContext().getHostContext()!.resourceManager;
    const parts: string[] = [this.taskIdentity(item)];
    if (item.status !== 'archived' && (item.hasDraft || item.localDraft)) parts.push(resources.getStringSync($r('app.string.row_draft').id));
    if (item.remote && !item.attached && !item.lead && item.status !== 'archived') parts.push(resources.getStringSync($r('app.string.row_remote').id));
    if (item.pinnedAt) parts.push(resources.getStringSync($r('app.string.row_pinned').id));
    if (item.scheduled) parts.push(resources.getStringSync((item.scheduleStopped ? $r('app.string.row_stopped_schedule') : $r('app.string.row_scheduled')).id));
    const status = this.rowStatus(item);
    const offline = this.hostOffline(item.host || '');
    parts.push(!offline && status === 'time' ? this.rowTime(item) : resources.getStringSync((offline ? $r('app.string.offline') : this.statusLabel(status)).id));
    return parts.filter((part: string) => !!part).join(' · ');
  }

  @Builder
  statusMark($$: StatusContent) {
    Stack() {
      if ($$.status === 'running') {
        LoadingProgress().width(16).height(16).color($r('app.color.muted'))
      } else {
        Row().width(9).height(9).borderRadius(5).backgroundColor($$.status === 'error' ? $r('app.color.status_error') :
          $$.status === 'awaiting' ? $r('app.color.status_awaiting') : $r('app.color.status_done'))
      }
    }.id('status-' + $$.key + '-' + $$.status).width(18).height(18).accessibilityText(this.statusLabel($$.status))
  }

  @Builder
  taskStatus($$: TaskRowContent) {
    if (this.hostOffline($$.item.host || '') || this.rowStatus($$.item) === 'time') {
      Text(this.hostOffline($$.item.host || '') ? $r('app.string.offline') : this.rowTime($$.item))
        .fontSize(12).fontColor($r('app.color.muted'))
    } else { this.statusMark({ status: this.rowStatus($$.item), key: $$.item.id }) }
  }

  @Builder
  projectHeading($$: HeadingContent) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 8 }) {
        SymbolGlyph(this.collapsed.includes($$.group.key) ? $r('sys.symbol.chevron_right') : $r('sys.symbol.chevron_down')).fontSize(12).width(22).fontColor([$r('app.color.muted')])
        SymbolGlyph($$.group.kind === 'pinned' ? $r('sys.symbol.pin') : this.collapsed.includes($$.group.key) ? $r('sys.symbol.folder') : $r('sys.symbol.folder_fill')).fontSize(17).width(22).fontColor([$r('app.color.muted')])
        Text($$.group.kind === 'pinned' ? $r('app.string.pinned_tasks') : this.basename($$.group.head.project || '')).fontSize(15).fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.ink')).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        if ($$.group.kind === 'project' && !this.scope && (!this.groupDevices || !!this.query.trim()) && this.view.devices.length > 1) { Text(this.hostName($$.group.head.host || '')).fontSize(12).fontColor($r('app.color.muted')).maxLines(1) }
        Blank()
        Text($$.group.total.toString()).fontSize(13).fontColor($r('app.color.muted'))
        if ($$.attention) { this.statusMark({ status: $$.attention, key: $$.group.key }) }
      }.width('100%')
    }.width('100%').height(44).padding(DIRECTORY_ROW_INSETS).backgroundColor(Color.Transparent).onClick(() => this.toggleHomeGroup($$.group.key))
  }

  private toggleHomeGroup(key: string): void {
    this.collapsed = this.collapsed.includes(key) ? this.collapsed.filter((g: string) => g !== key) : this.collapsed.concat(key);
  }

  @Builder
  errorNotice() {
    if (this.notice || (this.panel !== 'settings' && this.view.error)) {
      Text(this.notice || this.view.error).fontSize(14).lineHeight(20).fontColor($r('app.color.danger')).width('100%')
        .padding(8).backgroundColor($r('app.color.chip')).borderRadius(8).copyOption(CopyOptions.InApp)
    }
  }

  @Builder
  pageNotices(page: string) {
    if (this.view.shareLabel && (page === 'share' || page === 'task')) {
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
          if (page === 'task') {
            PillAction({ label: $r('app.string.choose_target'), onTap: () => { this.pickingShareTarget = true; } })
            PillAction({ label: $r('app.string.share_draft'), available: !this.busy && this.view.linked, onTap: () => this.run(() => this.workspace.acceptShare()) })
            PillAction({ label: $r('app.string.share_drop'), onTap: () => this.workspace.dismissShare() })
          }
        }
      }.width('100%').alignItems(HorizontalAlign.Start).padding(8).backgroundColor($r('app.color.panel')).borderRadius(12)
    }
    if (page !== 'settings' && this.view.device && !this.view.linked) {
      PillAction({ label: $r('app.string.reconnect'), available: !this.busy && this.view.relay === 'online',
        onTap: () => this.run(() => this.workspace.reconnect()) })
    } else if (page !== 'settings' && this.view.relay !== 'online') {
      Text($r('app.string.connecting')).fontSize(13).fontColor($r('app.color.muted'))
    }
    this.errorNotice()
  }

  @Builder
  screen(page: string) {
    Column({ space: 6 }) {
      this.pageNotices(page)
      if (page === 'new') {
        if (this.creating) { this.newForm() }
      } else if (page === 'task') {
        if (this.view.shareLabel) { this.infoRow($r('app.string.choose_target'), this.headerTitle()) }
        else if (this.view.task) { this.taskContent() }
      } else if (page === 'settings') {
        SettingsPage({ scroller: this.settingsScroller, account: this.view.account, email: this.view.accountEmail || '', avatar: this.view.accountAvatar || '',
            relay: this.view.relay, pushEnabled: this.view.pushEnabled, pushStatus: this.view.pushStatus, busy: this.busy,
            changePush: (enabled: boolean) => this.run(() => this.workspace.changePush(enabled)),
            openNotifications: () => this.run(() => this.workspace.notificationSettings()),
            openPrivacy: () => this.run(() => this.openPolicy(PRIVACY_URL)), openTerms: () => this.run(() => this.openPolicy(TERMS_URL)),
            logout: () => this.confirmLogout() }).layoutWeight(1)
      } else if (page === 'preview') {
        if (this.selectedFile) { this.filePreview() }
      } else {
        this.directory(page)
      }
    }.width('100%').height('100%').backgroundColor($r('app.color.canvas'))
  }

  @Builder
  destination(page: string) {
    if (page === 'task') {
      NavDestination() { this.screen(page) }
        .title(this.taskTitle(), { backgroundColor: $r('app.color.canvas') })
        .menus(this.taskMenu()).onBackPressed(() => this.onBackPress())
    } else if (page === 'cloud') {
      NavDestination() { this.cloudConversation() }
        .title(this.cloudTitle(), { backgroundColor: $r('app.color.canvas') }).menus(this.groupMenu())
        .onBackPressed(() => this.onBackPress())
    } else if (page === 'group-profile') {
      NavDestination() {
        if (this.view.cloudCompanion?.group) {
          GroupProfilePage({ group: this.titleCompanion(true)!, profile: this.view.cloudProfile, loading: this.busy || !!this.view.cloudLoading,
            load: (member: Companion, visible: () => boolean) => this.workspace.companionAvatar(member, visible),
            retry: () => this.run(() => this.workspace.retryGroupProfile()) })
        }
      }.title(this.getUIContext().getHostContext()!.resourceManager.getStringSync($r('app.string.group_profile').id),
        { backgroundColor: $r('app.color.canvas') }).onBackPressed(() => this.onBackPress())
    } else if (page === 'preview') {
      NavDestination() { this.screen(page) }
        .title(this.selectedFile?.name || '').menus(this.previewMenu()).hideTitleBar(!this.previewChrome)
        .onBackPressed(() => this.onBackPress())
    } else if (page === 'settings' && deviceInfo.sdkApiVersion >= 14) {
      NavDestination() { this.screen(page) }
        .title($r('app.string.settings'), { backgroundColor: $r('app.color.canvas') })
        .bindToScrollable([this.settingsScroller]).onBackPressed(() => this.onBackPress())
    } else if (page === 'settings') {
      NavDestination() { this.screen(page) }
        .title(this.getUIContext().getHostContext()!.resourceManager.getStringSync($r('app.string.settings').id),
          { backgroundColor: $r('app.color.canvas') }).onBackPressed(() => this.onBackPress())
    } else {
      NavDestination() { this.screen(page) }
        .title(page === 'project' ? this.basename(this.projectList?.project || '') :
          page === 'share' ? $r('app.string.choose_target') : $r('app.string.create_new'))
        .onBackPressed(() => this.onBackPress())
    }
  }

  @Builder
  workspacePages() {
    SideBarContainer(SideBarContainerType.Overlay) {
      this.drawer()
      Stack() {
        Navigation(this.paths) { this.screen('home') }
          .mode(NavigationMode.Stack).titleMode(NavigationTitleMode.Mini).hideBackButton(true)
          .title(this.homeBar()).navDestination(this.destination).width('100%').height('100%')
          .accessibilityLevel(this.drawerOpen ? 'no-hide-descendants' : 'auto')
        if (this.drawerOpen) {
          Button({ type: ButtonType.Normal }) {}.width('100%').height('100%').backgroundColor($r('app.color.scrim'))
            .accessibilityText($r('app.string.close')).onClick(() => { this.drawerOpen = false; })
        }
      }.width('100%').height('100%')
    }.width('100%').height('100%').sideBarWidth('82%').maxSideBarWidth(340).minSideBarWidth(0)
      .showControlButton(false).divider(null).showSideBar(this.drawerOpen)
      .attributeModifier(new DrawerGesture(!this.view.cloudCompanion && !this.view.task && !this.creating && !this.projectList && !this.selectedFile && !this.panel && !this.view.shareLabel))
      .onChange((open: boolean) => { if (this.drawerOpen !== open) this.drawerOpen = open; })
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
        } else if (!this.view.account) { this.login() }
        else { this.workspacePages() }
      }.padding({ top: this.topInset, bottom: (this.keyboardShown ? 0 : this.bottomInset) + (this.view.account ? 8 : 0) })
        .width('100%').height('100%').onAreaChange((_: Area, area: Area) => {
          this.availableHeight = Number(area.height); if (this.initializing) this.loginWidth = Math.min(440, Number(area.width));
        })
    }.bindSheet(this.isSheet(), this.sheetContent(), {
      height: this.panel === 'browse' ? SheetSize.LARGE : SheetSize.MEDIUM, dragBar: true, showClose: false,
      backgroundColor: $r('app.color.panel'), onWillDismiss: (event: DismissSheetAction) => {
        if (['browse', 'path', 'sort', 'filter', 'status', 'group', 'companion-display'].includes(this.panel)) this.closePanel();
        else { this.closePanel(); event.dismiss(); }
      }
    }).width('100%').height('100%').backgroundColor(this.view.account ? $r('app.color.canvas') : $r('app.color.login_bg'))
  }
}

@Extend(Button) function primaryLogin() {
  .width('100%').fontSize(16).fontWeight(FontWeight.Medium)
    .fontColor($r('app.color.on_action')).backgroundColor($r('app.color.action'))
}

@Extend(Text) function sectionTitle() {
  .fontSize(20).lineHeight(28).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink'))
}

@Extend(ListItem) function sheetInset() {
  .padding({ left: 16, right: 16 })
}
