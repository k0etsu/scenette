import { Asset } from "./asset";

// Shared between control-ui (editor canvas) and browser-source (OBS render)
// so a text asset looks pixel-identical in both -- every consumer must read
// styling through resolveTextStyle() rather than falling back to its own
// hardcoded defaults, which is what caused the two to visibly diverge before
// this field set existed (browser-source had no text-specific CSS at all).
//
// Every entry here must actually be loadable -- either a real font Google
// hosts (browse/search at https://fonts.google.com, then add BOTH the
// family name here AND a matching family=...&weight entry to the <link
// href="https://fonts.googleapis.com/css2?..."> in *both*
// apps/control-ui/index.html and apps/browser-source/index.html -- they
// must stay identical, or a text asset will render with this font in one
// app but not the other), or a font already present on essentially every
// OS by default (only "Comic Sans MS" qualifies here, hence no matching
// Google Fonts <link> entry for it). Don't add a name here that isn't
// backed by one of those two -- it'll silently render as the browser's
// default sans-serif instead of actually looking like anything distinct.
export const TEXT_FONT_FAMILIES = [
  "Roboto",
  "Roboto Mono",
  "Space Mono",
  "Comic Neue",
  "Comic Sans MS",
  "Redressed",
  "Averia Serif Libre",
] as const;

export const TEXT_FONT_WEIGHTS = ["100", "200", "300", "400", "500", "600", "700", "800", "900"] as const;

// Colour fields are the one text-styling input that's a free-form string an
// editor can type anything into (the hex box), so they're the natural XSS
// carrier: control-ui builds its properties panel via innerHTML, and an
// unescaped colour value could break out of the value="..." attribute. The
// sink itself is escaped, but validating here too keeps a hostile value from
// ever being stored/broadcast. Accepts what a real colour actually is -- hex,
// a CSS named colour, or an rgb()/hsl() function -- none of which can contain
// the <>"'` characters an injection needs.
const SAFE_CSS_COLOR = /^#[0-9a-fA-F]{3,8}$|^[a-zA-Z]{3,20}$|^(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$/;

export function isSafeColor(value: string): boolean {
  return SAFE_CSS_COLOR.test(value);
}

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

// Only the text-styling fields, not a full Asset -- lets callers (e.g. a
// brand-new asset that doesn't exist as a real Asset yet) resolve the
// all-defaults style without needing to fabricate one.
type TextStyleSource = Pick<
  Asset,
  | "fontFamily"
  | "fontSize"
  | "fontWeight"
  | "textAlign"
  | "textColor"
  | "backgroundColor"
  | "backgroundAlpha"
  | "shadowEnabled"
  | "shadowX"
  | "shadowY"
  | "shadowBlur"
  | "shadowColor"
  | "outlineEnabled"
  | "outlineColor"
  | "outlineWidth"
>;

export function resolveTextStyle(asset: TextStyleSource): ResolvedTextStyle {
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

// A brand-new text asset (before any per-asset override exists) uses
// exactly these values -- e.g. for measuring its initial auto-fit size
// before the asset:add round-trip even happens.
export const DEFAULT_TEXT_STYLE: ResolvedTextStyle = resolveTextStyle({});

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
