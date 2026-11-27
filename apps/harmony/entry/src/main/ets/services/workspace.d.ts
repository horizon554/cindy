import { common } from '@kit.AbilityKit';
export interface Row { host?: string; detail?: string; id: string; title: string; running?: boolean; project?: string; summary?: string; updated?: string; status?: string; media?: MediaInfo[]; messageText?: string; offline?: boolean; role?: string }
export interface Choice { label: string; detail: string; selected: boolean }
export interface Question { key: string; valid?: boolean; label: string; multi: boolean; free: boolean; value: string; options: Choice[] }
export interface Card { id: string; revision: number; kind: string; title: string; detail: string; questions: Question[]; complete?: boolean; approvalKey?: string; risk?: string; code?: string }
export interface MediaInfo { path?: string; name: string; size?: number; mimeType?: string }
export interface Attachment extends MediaInfo { id: string }
export interface FolderList { path: string; parent: string; rows: Row[] }
export interface ViewState {
  homeIndex?: Row[]; attachments: Attachment[]; transfer: string; voice: string; pushEnabled: boolean; pushStatus: string; shareLabel: string;
  ssoWaiting: boolean; ssoMethods: Row[]; verification: string; accounts: Row[]; account: string; relay: string; devices: Row[]; tasks: Row[]; messages: Row[];
  linked: boolean; moreTasks: boolean; hasOlder: boolean; paused: boolean; running: boolean;
  retryable: boolean; activity: string; draft: string; delivery: string; pendingLabel?: string; agent?: string; model?: string; provider?: string; permission?: string; voicePreview?: string; uploadName?: string; failedFile?: string; shareVersion?: number; shareFiles?: string[]; shareText?: string; cards: Card[];
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
  openTask(id: string): Promise<void>;
  create(title: string, project?: string, firstText?: string, engine?: string): Promise<boolean | undefined>;
  browse(path: string): Promise<FolderList>;
  shareImage(index: number): string;
  engines(): Promise<string[]>;
  preferences(kind: string): Promise<Row[]>;
  applyPreference(kind: string, value: string): Promise<void>;
  retryFile(): Promise<boolean | undefined>;
  discardFailed(): void;
  reconnect(): Promise<void>;
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
  startVoice(): void;
  finishVoice(): void;
  cancelVoice(): void;
  dismissShare(): void;
  acceptShare(): Promise<void>;
  notificationSettings(): Promise<void>;
  changePush(enabled: boolean): Promise<void>;
  logout(): Promise<void>;
}
