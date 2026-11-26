import { common } from '@kit.AbilityKit';
export interface Row { id: string; title: string; offline?: boolean; role?: string }
export interface Choice { label: string; detail: string; selected: boolean }
export interface Question { key: string; label: string; multi: boolean; free: boolean; value: string; options: Choice[] }
export interface Card { id: string; revision: number; kind: string; title: string; detail: string; questions: Question[] }
export interface Attachment { id: string; name: string }
export interface ViewState {
  attachments: Attachment[]; transfer: string; voice: string; pushEnabled: boolean; pushStatus: string; shareLabel: string;
  ssoWaiting: boolean; ssoMethods: Row[]; verification: string; accounts: Row[]; account: string; relay: string; devices: Row[]; tasks: Row[]; messages: Row[];
  linked: boolean; moreTasks: boolean; hasOlder: boolean; paused: boolean; running: boolean;
  retryable: boolean; activity: string; draft: string; delivery: string; cards: Card[];
  device: string; task: string; live: string; error: string;
}
export class Workspace {
  constructor(changed: (state: ViewState) => void);
  init(context: common.UIAbilityContext): Promise<void>;
  code(phone: string): Promise<void>;
  login(phone: string, code: string): Promise<void>;
  discover(org: string): Promise<void>;
  startSSO(id: string): Promise<void>;
  cancelSSO(): Promise<void>;
  verificationCode(): Promise<void>;
  verifyOrganization(code: string): Promise<void>;
  choose(id: string): Promise<void>;
  devices(): Promise<void>;
  openDevice(id: string): Promise<void>;
  openTask(id: string): Promise<void>;
  create(title: string): Promise<void>;
  reconnect(): Promise<void>;
  more(): Promise<void>;
  older(): Promise<void>;
  decide(id: string, choice: string): Promise<void>;
  editAnswer(id: string, key: string, value: string, select: boolean): void;
  retryOriginal(): Promise<void>;
  checkDelivery(): Promise<void>;
  control(resume: boolean): Promise<void>;
  editDraft(text: string): void;
  flushDraft(): Promise<void>;
  back(): Promise<void>;
  send(text: string): Promise<void>;
  addFile(kind: string): Promise<boolean | undefined>;
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
