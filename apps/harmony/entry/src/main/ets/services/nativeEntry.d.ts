import { UIAbility, Want } from '@kit.AbilityKit';
import { Workspace } from './workspace';
export function launch(want: Want, owner: UIAbility): void;
export function foreground(active: boolean): void;
export function installInputs(workspace: Workspace): void;
