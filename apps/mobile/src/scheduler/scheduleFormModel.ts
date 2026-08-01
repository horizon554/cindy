import { BUNDLED_CATALOG, resolveDefaultModel } from '@cindy/model-providers';
import type { MobileScheduleModelDefaults } from '@cindy/maker-shared/schedule-form';

export * from '@cindy/maker-shared/schedule-form';

/** Mobile injects bundled catalog values into maker-shared without reversing package dependencies. */
export const MOBILE_SCHEDULE_MODEL_DEFAULTS: MobileScheduleModelDefaults = {
  'claude-code': resolveDefaultModel(
    BUNDLED_CATALOG,
    'claude-code',
    'session',
    'claude-sonnet-4-6',
  ),
  codex: resolveDefaultModel(BUNDLED_CATALOG, 'codex', 'session', 'gpt-5.5'),
};
