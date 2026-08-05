import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

describe('provider model resolve wiring', () => {
  it('rechecks the latest apply token before any resolved model reaches a consumer', () => {
    const resolveStart = registerSource.indexOf('.then(async (resolved) => {',
      registerSource.indexOf('resolveFetchedModels: (spec, result) => {'));
    const resolveEnd = registerSource.indexOf('.catch(() => undefined);', resolveStart);
    const consumer = registerSource.slice(resolveStart, resolveEnd);

    expect(resolveStart).toBeGreaterThan(-1);
    expect(resolveEnd).toBeGreaterThan(resolveStart);
    expect(consumer).toMatch(
      /if \(!resolved \|\| !isLatestModelResolveResult\(resolved\)\) return;/,
    );
    expect(consumer.indexOf('isLatestModelResolveResult(resolved)')).toBeLessThan(
      consumer.indexOf('broadcastToAllWindows(MAKER_PUSH.PROVIDER_MODELS_RESOLVED'),
    );
    expect(consumer.indexOf('isLatestModelResolveResult(resolved)')).toBeLessThan(
      consumer.indexOf('setResolvedProviderModels('),
    );
    const configRead = consumer.indexOf('await getCustomProvider(spec.savedProviderId)');
    const configWrite = consumer.indexOf('await updateCustomProviderIfUnchanged(');
    const postReadGuard = consumer.indexOf(
      'if (!isLatestModelResolveResult(resolved)) return;',
      configRead,
    );
    expect(configRead).toBeGreaterThan(-1);
    expect(postReadGuard).toBeGreaterThan(configRead);
    expect(configWrite).toBeGreaterThan(postReadGuard);
  });
});
