import { describe, it, expect } from "vitest";
import { Asset } from "../src/asset";
import { resolveTextStyle, textStyleToCss, TEXT_FONT_FAMILIES, TEXT_FONT_WEIGHTS } from "../src/textStyle";

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    roomId: "room1",
    assetId: "a1",
    type: "text",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: 0,
    visible: true,
    hidden: false,
    locked: false,
    opacity: 1,
    blur: 0,
    flipX: false,
    flipY: false,
    loop: true,
    muted: false,
    volume: 1,
    paused: true,
    seq: 1,
    uploadedAt: "2026-01-01T00:00:00.000Z",
    keep: false,
    ...overrides,
  };
}

describe("resolveTextStyle", () => {
  it("fills in every field with a default when the asset has none set", () => {
    const style = resolveTextStyle(makeAsset());
    expect(style).toEqual({
      fontFamily: "Roboto",
      fontSize: 24,
      fontWeight: "400",
      textAlign: "left",
      textColor: "#ffffff",
      backgroundColor: "#000000",
      backgroundAlpha: 0.4,
      shadowEnabled: false,
      shadowX: 0,
      shadowY: 0,
      shadowBlur: 5,
      shadowColor: "#000000",
      outlineEnabled: false,
      outlineColor: "#000000",
      outlineWidth: 0,
    });
  });

  it("prefers explicitly-set asset fields over defaults", () => {
    const style = resolveTextStyle(makeAsset({ fontFamily: "Comic Neue", fontSize: 40, textColor: "#123456" }));
    expect(style.fontFamily).toBe("Comic Neue");
    expect(style.fontSize).toBe(40);
    expect(style.textColor).toBe("#123456");
    // Untouched fields still fall back to defaults.
    expect(style.backgroundColor).toBe("#000000");
  });
});

describe("textStyleToCss", () => {
  it("maps a resolved style onto the expected CSS property names/values", () => {
    const css = textStyleToCss(resolveTextStyle(makeAsset()));
    expect(css.fontFamily).toBe('"Roboto", system-ui, sans-serif');
    expect(css.fontSize).toBe("24px");
    expect(css.fontWeight).toBe("400");
    expect(css.textAlign).toBe("left");
    expect(css.color).toBe("#ffffff");
    expect(css.background).toBe("rgba(0, 0, 0, 0.4)");
    expect(css.textShadow).toBe("none");
    expect(css.webkitTextStroke).toBe("0");
  });

  it("renders an active textShadow/outline when enabled", () => {
    const css = textStyleToCss(
      resolveTextStyle(
        makeAsset({
          shadowEnabled: true,
          shadowX: 1,
          shadowY: 2,
          shadowBlur: 3,
          shadowColor: "#ff0000",
          outlineEnabled: true,
          outlineWidth: 2,
          outlineColor: "#00ff00",
        })
      )
    );
    expect(css.textShadow).toBe("1px 2px 3px #ff0000");
    expect(css.webkitTextStroke).toBe("2px #00ff00");
  });
});

describe("TEXT_FONT_FAMILIES / TEXT_FONT_WEIGHTS", () => {
  it("lists the full set of selectable fonts", () => {
    expect(TEXT_FONT_FAMILIES).toContain("Roboto");
    expect(TEXT_FONT_FAMILIES).toContain("Comic Sans MS");
    expect(TEXT_FONT_FAMILIES).toHaveLength(12);
  });

  it("lists weights 100-900 in steps of 100", () => {
    expect(TEXT_FONT_WEIGHTS).toEqual(["100", "200", "300", "400", "500", "600", "700", "800", "900"]);
  });
});
