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
      export { resolveRemoteInvokeTimeoutMs } from './packages/device-link/src/invokePolicy.ts';
      export { messageCostParts } from './packages/maker-shared/src/usageCostDetails.ts';
      export { formatCompactTokens } from './packages/maker-shared/src/usageFormat.ts';
      export { resolveSessionTotalMoney } from './apps/mobile/src/session/remoteMoney.ts';
      export { readSentPastedTextRanges, readSentSlashCommandRanges } from './apps/mobile/src/session/sentMessageAtoms.ts';
      export { readAgentInputReferences } from './packages/maker-shared/src/agentInputProjection.ts';
      export { readChatReplyQuote } from './packages/maker-shared/src/chatReplyQuote.ts';
      export { isSyntheticTriggerText } from './packages/maker-shared/src/syntheticTrigger.ts';
      export { buildTaskDeepLink } from './packages/maker-shared/src/brandIdentity.ts';
      export { isSharedTaskPeer } from './packages/device-link/src/sharedTaskPeer.ts';
      export { hasBotGroupCollection, botGroupMemberLinks, botGroupResourceRef, botGroupChatDataFromResource, BOT_GROUP_CLIENT_PRIMITIVES } from './apps/mobile/src/session/botGroupRemote.ts';
      export { createConversationListState } from './packages/maker-shared/src/chatConversationList.ts';
      export { latestBotGroupMessage, botGroupActivityAt, chatGroupMemberName } from './packages/maker-shared/src/botGroupPresentation.ts';
      export { botGroupMessageSummaryText, readBotGroupTaskCard } from './packages/maker-shared/src/botGroupChat.ts';
      export { HomeDeviceSyncLimiter } from './apps/mobile/src/session/homeDeviceSync.ts';
      export { resolveMobileSessionRightStatus } from './apps/mobile/src/session/sessionRightStatus.ts';
      export { mobileSessionBulkPatch } from './packages/maker-shared/src/sessionSelection.ts';
      export { buildSessionScheduleIndex } from './packages/maker-shared/src/sessionList.ts';
      export { normalizeScheduleList, normalizeScheduleRuns } from './packages/maker-shared/src/scheduleModel.ts';
      export { getSessionListCollapseView } from './packages/maker-shared/src/sessionListCollapse.ts';
      export { sessionTaskProjectIconDirectory } from './packages/maker-shared/src/worktreePaths.ts';
      export { hasPendingSessionInterruption } from './packages/maker-shared/src/sessionActivity.ts';
      export { resolveLoginStage } from './apps/mobile/src/auth/loginSkinLayout.ts';
      export { buildLegacyAttachmentOssRef, parseAttachmentOssRef, isSharedTaskMediaKey } from './packages/device-link/src/attachmentOssRef.ts';
      export { DeviceLinkClient } from './packages/device-link/src/client.ts';
      export { permissionModeOrAsk } from './packages/maker-shared/src/permissionMode.ts';
      export { isAnsweredAsyncQuestionClientId, normalizeAskQuestions, answerKey, askQuestionOptions, askAnswerError, encodeMultiSelectAnswer, selectionFromAnswer, buildPermissionReviewPresentation } from './packages/maker-shared/src/interaction.ts';
      export { isTurnContinuationBoundaryEvent } from './packages/maker-shared/src/turnContinuation.ts';
      export { providerMonogram, buildMobileModelSections, flattenProviderSections } from './apps/mobile/src/session/providerModelSections.ts';
      export { resolveModelIconKind } from './packages/model-providers/src/sections.ts';
      export { resolveProviderLogoKind, isProviderLogoKind, PROVIDER_LOGO_PATHS, MODEL_SPECTRUM_COLORS,
        CINDY_MARK_TRANSFORM, CINDY_MARK_PATH, CINDY_MARK_EARRING_PATH, CINDY_MARK_EARRING_COLOR } from './packages/model-providers/src/providerBranding.ts';
      export { OPENAI_PROVIDER_PATH, ANTHROPIC_PROVIDER_PATH, XD_SYMBOL_PATHS, XD_VIEW_BOX } from './apps/mobile/src/components/vendorIconPaths.ts';
      export { resolveProviderSvgColorScheme } from './apps/mobile/src/session/resolveProviderSvgColorScheme.ts';
      export { PROTOCOL_VERSION, providerPickerListArgs } from './packages/device-link/src/protocol.ts';
      export { readVoiceCallRecord } from './apps/desktop/src/shared/voiceConversation.ts';
      export { BOT_AVATAR_MAX_BYTES, isManagedBotAvatarUrl } from './apps/desktop/src/shared/botAvatarValue.ts';
      export { sniffMediaMime } from './apps/desktop/src/main/cindy-media/sniffMediaMime.ts';
      export { DEVICE_LINK_MEDIA_FETCH_CHANNEL } from './packages/maker-shared/src/deviceLinkContract.ts';
      export { REMOTE_RESOURCE_PROTOCOL_VERSION, resolveRemoteText } from './packages/device-link/src/remoteResources.ts';
      export { authApiBaseUrl, deviceLinkApiBaseUrl, chatApiBaseUrl } from './config/endpoint.json';
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
