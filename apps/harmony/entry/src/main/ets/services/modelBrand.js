import util from '@ohos.util';
import { resolveModelIconKind, resolveProviderLogoKind, isProviderLogoKind, providerMonogram,
  PROVIDER_LOGO_PATHS, ANTHROPIC_PROVIDER_PATH, OPENAI_PROVIDER_PATH, XD_SYMBOL_PATHS, XD_VIEW_BOX,
  CINDY_MARK_TRANSFORM, CINDY_MARK_PATH, CINDY_MARK_EARRING_PATH, CINDY_MARK_EARRING_COLOR,
  MODEL_SPECTRUM_COLORS, resolveProviderSvgColorScheme } from './protocol.generated';

export function providerBrand(provider) {
  const kind = isProviderLogoKind(provider.logoKind) ? provider.logoKind : resolveProviderLogoKind(provider.id, provider.routing);
  return { kind: kind || '', monogram: providerMonogram(provider.name || provider.id), customSvg: typeof provider.customIcon === 'string' ? provider.customIcon : undefined };
}

export function modelBrand(icon, source) {
  const mark = typeof icon === 'string' && resolveModelIconKind(icon);
  if (!mark) return source;
  const kind = mark === 'claude' ? 'anthropic' : mark === 'codex' ? 'openai' : 'cindy';
  return { kind, monogram: providerMonogram(kind) };
}

function path(d, color) { return `<path d="${d}" fill="${color}"/>`; }

function artwork(kind, ink, mode) {
  let viewBox = '0 0 24 24', content;
  if (kind === 'cindy') {
    content = `<g transform="${CINDY_MARK_TRANSFORM}">${path(CINDY_MARK_PATH, ink)}${path(CINDY_MARK_EARRING_PATH, CINDY_MARK_EARRING_COLOR)}</g>`;
  } else if (kind === 'xd') {
    viewBox = XD_VIEW_BOX;
    content = XD_SYMBOL_PATHS.map(d => path(d, ink)).join('');
  } else if (kind === 'openai-spectrum') {
    const colors = MODEL_SPECTRUM_COLORS[mode];
    const stops = colors.map((color, i) => `<stop offset="${i / (colors.length - 1)}" stop-color="${color}"/>`).join('');
    content = `<defs><linearGradient id="s" x2="100%" y2="100%">${stops}</linearGradient></defs>${path(OPENAI_PROVIDER_PATH, 'url(#s)')}`;
  } else {
    const d = kind === 'anthropic' ? ANTHROPIC_PROVIDER_PATH : kind === 'openai' ? OPENAI_PROVIDER_PATH : PROVIDER_LOGO_PATHS[kind];
    if (!d) return '';
    content = path(d, ink);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="${viewBox}">${content}</svg>`;
}

export function brandImage(brand, ink, dark, useCustom) {
  const mode = dark ? 'dark' : 'light';
  const svg = useCustom && brand.customSvg ? resolveProviderSvgColorScheme(brand.customSvg, mode) : artwork(brand.kind, ink, mode);
  if (!svg) return '';
  return 'data:image/svg+xml;base64,' + new util.Base64Helper().encodeToStringSync(new util.TextEncoder().encodeInto(svg));
}
