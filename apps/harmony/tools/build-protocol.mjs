// Bundle the client contracts and the mobile login geometry used by ArkUI.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
await build({
  absWorkingDir: root,
  stdin: {
    resolveDir: root,
    contents: `
      export { resolveMobileSessionRightStatus } from './apps/mobile/src/session/sessionRightStatus.ts';
      export { mobileSessionBulkPatch } from './packages/maker-shared/src/sessionSelection.ts';
      export { normalizeScheduleList } from './packages/maker-shared/src/scheduleModel.ts';
      export { getSessionListCollapseView } from './packages/maker-shared/src/sessionListCollapse.ts';
      export { sessionTaskProjectIconDirectory } from './packages/maker-shared/src/worktreePaths.ts';
      export { hasPendingSessionInterruption } from './packages/maker-shared/src/sessionActivity.ts';
      export { resolveLoginStage } from './apps/mobile/src/auth/loginSkinLayout.ts';
      export { buildLegacyAttachmentOssRef, parseAttachmentOssRef, isSharedTaskMediaKey } from './packages/device-link/src/attachmentOssRef.ts';
      export { DeviceLinkClient } from './packages/device-link/src/client.ts';
      export { permissionModeOrAsk } from './packages/maker-shared/src/permissionMode.ts';
      export { normalizeAskQuestions, answerKey, askQuestionOptions, askAnswerError, encodeMultiSelectAnswer, selectionFromAnswer, buildPermissionReviewPresentation } from './packages/maker-shared/src/interaction.ts';
      export { isTurnContinuationBoundaryEvent } from './packages/maker-shared/src/turnContinuation.ts';
      export { buildMobileModelSections, flattenProviderSections } from './apps/mobile/src/session/providerModelSections.ts';
      export { PROTOCOL_VERSION, providerPickerListArgs } from './packages/device-link/src/protocol.ts';
      export { authApiBaseUrl, deviceLinkApiBaseUrl } from './config/endpoint.json';
    `,
  },
  banner: { js: "import systemDateTime from '@ohos.systemDateTime'; const harmonyNow = () => systemDateTime.getUptime(systemDateTime.TimeType.ACTIVE);" },
  define: { 'performance.now': 'harmonyNow' },
  bundle: true, format: 'esm', target: 'es2021',
  nodePaths: [fileURLToPath(new URL('node_modules', import.meta.url))],
  outfile: 'apps/harmony/entry/src/main/ets/services/protocol.generated.js',
  plugins: [{
    name: 'cindy-workspace',
    setup(b) {
      b.onResolve({filter: /^@cindy\//}, ({path}) => {
        const [, name, ...subpath] = path.split('/');
        const dir = resolve(root, 'packages', name);
        const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
        const target = pkg.exports?.[subpath.length ? './' + subpath.join('/') : '.'] ?? pkg.main;
        return { path: resolve(dir, typeof target === 'string' ? target : target.import ?? target.default) };
      });
    }
  }]
});
