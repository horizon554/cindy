import { PickerBrand } from './modelBrand';
import { common } from '@kit.AbilityKit';
export interface CallLine { role: string; text: string; status?: string }
export interface CallTranscript { startedAt: number; endedAt?: number; lines: CallLine[] }
export interface UsagePart { value: string; estimated: boolean }
export interface Row { clientId?: string; createdAt?: string; actions?: boolean; forkable?: boolean; editPlacement?: 'inline' | 'menu'; usage?: UsagePart[]; author?: string; voiceCall?: CallTranscript; agentKind?: string; lead?: boolean; attached?: boolean; remote?: boolean; hasDraft?: boolean; localDraft?: boolean; scheduled?: boolean; scheduleStopped?: boolean; pinnedAt?: string; rightStatus?: string; host?: string; detail?: string; id: string; title: string; running?: boolean; project?: string; summary?: string; updated?: string; created?: string; status?: string; media?: MediaInfo[]; messageText?: string; offline?: boolean; role?: string }
export interface Companion { group?: boolean; recentCall?: boolean; faces?: Companion[]; preview?: string; subtitle?: string; searchText?: string; key: string; id: string; host: string; title: string; avatar: string; avatarImage?: string; cloudImage?: string; preset?: string; actor?: string }
export interface GroupMember extends Companion { role?: string }
export interface GroupProfile { title: string; topic?: string; description?: string; members: GroupMember[] }
export interface PreferenceOption extends Row { brand?: PickerBrand; sectionBrand?: PickerBrand; provider?: string; model?: string; activeSource?: boolean }
export interface Choice { label: string; detail: string; selected: boolean }
export interface Question { key: string; valid?: boolean; label: string; multi: boolean; free: boolean; value: string; options: Choice[] }
export interface Card { id: string; revision: number; kind: string; title: string; detail: string; questions: Question[]; complete?: boolean; approvalKey?: string; risk?: string; code?: string }
export interface MediaInfo { path?: string; name: string; size?: number; mimeType?: string }
export interface PendingUpload { id: string; previewUri?: string; title: string; failed: boolean; uploading: boolean }
export interface Attachment extends MediaInfo { id: string }
export interface FolderList { path: string; parent: string; rows: Row[] }
export interface NewTaskDraft { owner: string; text: string; attachments: Attachment[]; media: Map<string, string> }
export interface ViewState {
  editingMessage?: string; editSubmitting?: boolean; editFileCount?: number; editRecoverable?: boolean;
  companions?: Companion[]; companionError?: boolean; taskCompanion?: Companion; cloudCompanion?: Companion; cloudProfile?: GroupProfile; cloudMessages?: Row[]; cloudOlder?: boolean; cloudLoading?: boolean; cloudError?: boolean;
  liveHosts?: string[]; uploadPending?: boolean; legacyPicker?: boolean; homeIndex?: Row[]; attachments: Attachment[]; transfer: string; voice: string; pushEnabled: boolean; pushStatus: string; shareLabel: string;
  ssoWaiting: boolean; ssoMethods: Row[]; verification: string; accounts: Row[]; account: string; accountEmail?: string; accountAvatar?: string; relay: string; devices: Row[]; tasks: Row[]; messages: Row[];
  linked: boolean; moreTasks: boolean; hasOlder: boolean; paused: boolean; running: boolean;
  retryable: boolean; activity: string; draft: string; delivery: string; pendingLabel?: string; agent?: string; model?: string; provider?: string; permission?: string; voicePreview?: string; voiceCaret?: number; pendingUploads?: PendingUpload[]; pickingFiles?: boolean; waitingToCreate?: boolean; failedFile?: string; shareVersion?: number; shareFiles?: string[]; shareText?: string; cards: Card[];
  device: string; task: string; live: string; error: string;
}
export class Workspace {
  constructor(changed: (state: ViewState) => void, taskHome?: boolean);
  init(context: common.UIAbilityContext): Promise<void>;
  code(phone: string): Promise<void>;
  login(phone: string, code: string): Promise<void>;
  clearMethods(): void;
  discover(org: string): Promise<void>;
  startSSO(id: string): Promise<void>;
  cancelSSO(): Promise<void>;
  verificationCode(): Promise<void>;
  verifyOrganization(code: string): Promise<void>;
  choose(id: string): Promise<void>;
  devices(): Promise<void>;
  openDevice(id: string): Promise<void>;
  loadCompanionCall(key: string, visible: boolean): Promise<void> | undefined;
  companionAvatar(row: Companion, visible: () => boolean): Promise<string>;
  openCompanion(key: string): Promise<void>;
  refreshCompanions(): Promise<void>;
  retryGroupProfile(): Promise<void>;
  messageLink(task: string, id: string): string;
  beginMessageEdit(task: string, id: string): Promise<void>;
  cancelMessageEdit(): void;
  recoverMessageEdit(): Promise<void>;
  forkMessage(task: string, id: string): Promise<void>;
  closeCloudCompanion(): void;
  cloudHistory(older: boolean): Promise<void>;
  openTask(id: string): Promise<void>;
  create(title: string, project?: string, firstText?: string, engine?: string, draftOnly?: boolean): Promise<boolean | undefined>;
  snapshotNew(): NewTaskDraft | undefined;
  beginNew(snapshot?: NewTaskDraft): void;
  leaveNew(confirmDiscard: () => Promise<boolean>): Promise<boolean>;
  cancelNew(): void;
  configureNew(engine?: string): Promise<void>;
  changeHomeTask(host: string, id: string, action: string, title: string, confirmArchive: (names: string[]) => Promise<boolean>): Promise<void>;
  rename(title: string): Promise<void>;
  browse(path: string): Promise<FolderList>;
  shareImage(index: number): string;
  engines(): Promise<string[]>;
  preferences(kind: string): Promise<PreferenceOption[]>;
  applyPreference(kind: string, value: string): Promise<void>;
  removeUpload(id: string): void;
  retryFile(id?: string): Promise<boolean | undefined>;
  reconnect(): Promise<void>;
  setHomeScope(id: string): void;
  more(): Promise<void>;
  older(): Promise<void>;
  decide(id: string, choice: string, confirmedKey?: string): Promise<void>;
  editAnswer(id: string, key: string, value: string, select: boolean): void;
  retryOriginal(): Promise<void>;
  checkDelivery(): Promise<void>;
  control(resume: boolean): Promise<void>;
  editDraft(text: string): void;
  flushDraft(): Promise<void>;
  back(): Promise<void>;
  send(text: string): Promise<void>;
  addFile(kind: string): Promise<boolean | undefined>;
  thumbnail(file: MediaInfo, visible: () => boolean): Promise<string>;
  localPreview(id: string): string;
  previewUrl(path: string): Promise<string>;
  removeFile(id: string): Promise<void>;
  cancelTransfer(): void;
  startVoice(start?: number, end?: number): void;
  finishVoice(): Promise<boolean | undefined>;
  finishVoiceForSend(): Promise<boolean>;
  cancelVoice(): void;
  dismissShare(): void;
  acceptShare(): Promise<void>;
  notificationSettings(): Promise<void>;
  changePush(enabled: boolean): Promise<void>;
  logout(): Promise<void>;
}
