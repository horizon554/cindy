import {
  isModelCurrency,
  parseListModelsResponseV2,
  type ModelCurrency,
} from '@cindy/model-access-protocol';

import type { ModelAccessGatewayModel } from '../../shared/modelAccess.js';

/** Non-enumerable provenance on the parsed array keeps each wire model entry byte-for-byte intact. */
export function isStrictlyResolvedGatewayModels(
  models: readonly ModelAccessGatewayModel[],
): boolean {
  return (models as readonly ModelAccessGatewayModel[] & { resolvedSource?: unknown }).resolvedSource === true;
}

/** Parse ListModels v2 or the pre-S3 unversioned envelope without replacing last-good data. */
export function normalizeGatewayModelsPayload(
  payload: unknown,
  fallbackCurrency: ModelCurrency,
): ModelAccessGatewayModel[] | null {
  if (
    payload &&
    typeof payload === 'object' &&
    'schemaVersion' in payload &&
    (payload as { schemaVersion?: unknown }).schemaVersion === 2
  ) {
    const parsed = parseListModelsResponseV2(payload);
    if (!parsed.ok) return null;
    const models = parsed.value.models.map((model) => ({
      ...(model as unknown as ModelAccessGatewayModel),
      currency: isModelCurrency(model.currency) ? model.currency : fallbackCurrency,
    }));
    Object.defineProperty(models, 'resolvedSource', { value: true, enumerable: false });
    return models;
  }

  // Before S3, the server sent the unversioned { models: [...] } envelope. Keep this
  // tolerant path deliberately narrow: malformed entries are ignored as before, while
  // a syntactically valid empty array remains a successful empty result.
  if (!payload || typeof payload !== 'object') return null;
  const rawModels = (payload as { models?: unknown }).models;
  if (!Array.isArray(rawModels)) return null;
  return rawModels
    .filter(
      (model): model is ModelAccessGatewayModel =>
        Boolean(
          model &&
            typeof model === 'object' &&
            typeof (model as { id?: unknown }).id === 'string' &&
            (model as { id: string }).id,
        ),
    )
    .map((model) => ({
      ...model,
      currency: isModelCurrency(model.currency) ? model.currency : fallbackCurrency,
    }));
}

/** Apply server currency when present, otherwise infer it from the current build region. */
export function applyGatewayModelCurrency(
  models: readonly ModelAccessGatewayModel[],
  fallbackCurrency: ModelCurrency,
): ModelAccessGatewayModel[] {
  return models.map((model) => ({
    ...model,
    currency: model.currency ?? fallbackCurrency,
  }));
}

export type { ModelCurrency };
