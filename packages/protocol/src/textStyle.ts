import { Asset } from "./asset";

// Shared between control-ui (editor canvas) and browser-source (OBS render)
// so a text asset looks pixel-identical in both -- every consumer must read
// styling through resolveTextStyle() rather than falling back to its own
// hardcoded defaults, which is what caused the two to visibly diverge before
// this field set existed (browser-source had no text-specific CSS at all).
export const TEXT_FONT_FAMILIES = [
  "Roboto",
  "Roboto Mono",
  "Space Mono",
  "Comic Neue",
  "Comic Sans MS",
  "Redressed",
  "RuneScape",
  "Mantinia",
  "VCR Mono",
  "Bloody",
  "AveriaSerifLibre",
  "Andy Bold",
] as const;

export const TEXT_FONT_WEIGHTS = ["100", "200", "300", "400", "500", "600", "700", "800", "900"] as const;

export interface ResolvedTextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  textAlign: "left" | "center" | "right";
  textColor: string;
  backgroundColor: string;
  backgroundAlpha: number;
  shadowEnabled: boolean;
  shadowX: number;
  shadowY: number;
  shadowBlur: number;
  shadowColor: string;
  outlineEnabled: boolean;
  outlineColor: string;
  outlineWidth: number;
}

export function resolveTextStyle(asset: Asset): ResolvedTextStyle {
  return {
    fontFamily: asset.fontFamily ?? "Roboto",
    fontSize: asset.fontSize ?? 24,
    fontWeight: asset.fontWeight ?? "400",
    textAlign: asset.textAlign ?? "left",
    textColor: asset.textColor ?? "#ffffff",
    backgroundColor: asset.backgroundColor ?? "#000000",
    backgroundAlpha: asset.backgroundAlpha ?? 0.4,
    shadowEnabled: asset.shadowEnabled ?? false,
    shadowX: asset.shadowX ?? 0,
    shadowY: asset.shadowY ?? 0,
    shadowBlur: asset.shadowBlur ?? 5,
    shadowColor: asset.shadowColor ?? "#000000",
    outlineEnabled: asset.outlineEnabled ?? false,
    outlineColor: asset.outlineColor ?? "#000000",
    outlineWidth: asset.outlineWidth ?? 0,
  };
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// A plain string-keyed record (not CSSStyleDeclaration -- this package has
// no "dom" lib, since it's also imported by Node-side Lambda code) mapping
// directly onto CSSStyleDeclaration property names. Both control-ui's canvas
// and browser-source's renderer apply this via Object.assign(el.style, ...)
// so they can't drift apart on the actual field-to-CSS mapping.
export function textStyleToCss(s: ResolvedTextStyle): Record<string, string> {
  return {
    fontFamily: `"${s.fontFamily}", system-ui, sans-serif`,
    fontSize: `${s.fontSize}px`,
    fontWeight: s.fontWeight,
    textAlign: s.textAlign,
    color: s.textColor,
    background: hexToRgba(s.backgroundColor, s.backgroundAlpha),
    textShadow: s.shadowEnabled ? `${s.shadowX}px ${s.shadowY}px ${s.shadowBlur}px ${s.shadowColor}` : "none",
    webkitTextStroke: s.outlineEnabled ? `${s.outlineWidth}px ${s.outlineColor}` : "0",
  };
}
