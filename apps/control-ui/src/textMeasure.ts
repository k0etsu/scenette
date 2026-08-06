import { ResolvedTextStyle, textStyleToCss } from "@scenette/protocol";

// Mirrors the exact CSS canvas.ts applies to a text asset's content element
// (padding/box-sizing/white-space, plus font/color styling) on a throwaway
// offscreen element, so a brand-new text asset's initial width/height
// already matches its own content instead of starting at a placeholder
// size and only correcting itself once the user first edits it.
export function measureTextBoxSize(text: string, style: ResolvedTextStyle, minSize: number): { width: number; height: number } {
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.left = "-99999px";
  probe.style.top = "-99999px";
  probe.style.padding = "4px";
  probe.style.boxSizing = "border-box";
  probe.style.whiteSpace = "pre";
  Object.assign(probe.style, textStyleToCss(style));
  probe.textContent = text;
  document.body.appendChild(probe);
  const width = Math.max(minSize, probe.offsetWidth);
  const height = Math.max(minSize, probe.offsetHeight);
  document.body.removeChild(probe);
  return { width, height };
}
