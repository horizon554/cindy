import type { AgentKind } from '@cindy/maker-scheduler';
import { resolveDefaultModel, type Catalog } from '@cindy/model-providers';

import { getActiveCatalog } from '../maker-host/active-catalog.js';

const FALLBACK_SCHEDULE_MODELS: Record<AgentKind, string> = {
  'claude-code': 'claude-sonnet-4-6',
  codex: 'gpt-5.5',
  pi: '',
};

/** Scheduler defaults follow the active catalog and retain historical fallbacks offline. */
export function defaultModelFor(
  agentKind: AgentKind,
  catalog: Pick<Catalog, 'providers' | 'defaults'> = getActiveCatalog(),
): string {
  // Pi 没有跨来源合法的静态默认,目录默认同样不适用:runner 会用实时连接目录解析
  // {model,providerId}。空字符串可阻止其它调用方制造“看似可用”的 Claude 假路由,
  // 因此 pi 不进 resolver —— 目录里若真给了 pi 默认,也不能在这里落成静态 id。
  if (agentKind === 'pi') return '';
  return resolveDefaultModel(
    catalog,
    agentKind,
    'session',
    FALLBACK_SCHEDULE_MODELS[agentKind],
  );
}
