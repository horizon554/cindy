import { appTasks } from '@ohos/hvigor-ohos-plugin';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Build from the same checkout as the HAP on both IDE Run and CLI builds.
execFileSync(process.execPath, [join(__dirname, 'tools/build-protocol.mjs')], { stdio: 'inherit' });
export default { system: appTasks, plugins: [] };
