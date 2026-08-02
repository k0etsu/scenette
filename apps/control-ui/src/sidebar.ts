import { Asset, AssetPatch, AssetType, TEXT_FONT_FAMILIES, TEXT_FONT_WEIGHTS, resolveTextStyle } from "@scenette/protocol";
import {
  ICON_EYE,
  ICON_EYE_OFF,
  ICON_LOCK,
  ICON_UNLOCK,
  ICON_TRASH,
  ICON_DUPLICATE,
  ICON_PLAY,
  ICON_PAUSE,
  ICON_TEXT,
  ICON_IMAGE,
  ICON_VIDEO,
  ICON_AUDIO,
} from "./icons";

export interface SidebarCallbacks {
  onSelect: (assetId: string) => void;
  onToggleHidden: (assetId: string, hidden: boolean) => void;
  onToggleLocked: (assetId: string, locked: boolean) => void;
  onDelete: (assetId: string) => void;
  onDuplicate: (assetId: string) => void;
  onPatch: (assetId: string, patch: AssetPatch) => void;
  onMove: (assetId: string, x: number, y: number) => void;
  onResize: (assetId: string, width: number, height: number) => void;
  onCreateClick: () => void;
}

const TYPE_ICON: Record<AssetType, string> = {
  text: ICON_TEXT,
  image: ICON_IMAGE,
  gif: ICON_IMAGE,
  video: ICON_VIDEO,
  audio: ICON_AUDIO,
};

// Objects list + properties panel — lets a streamer/mod adjust an existing
// asset's position/size/rotation/z-index/opacity/blur/flip/lock/visibility,
// its text content, or (for video/audio) playback state, without deleting
// and re-placing/re-uploading it.
export class Sidebar {
  private assets = new Map<string, Asset>();
  private selectedAssetId?: string;

  // Two independent reasons a rebuild must be deferred (see upsertAsset):
  // a slider mid-drag (mousedown without mouseup yet -- explicitly tracked
  // rather than relying on document.activeElement, since clicking/dragging
  // a range input doesn't reliably focus it in every browser), and a text
  // field with real focus (typing in the name/text inputs, which now patch
  // live on every keystroke -- see item 4's realtime requirement -- so the
  // remote echo of that same keystroke arrives while still typing).
  private draggingControl = false;
  private focusedField = false;
  private get interacting(): boolean {
    return this.draggingControl || this.focusedField;
  }

  private readonly objectsList: HTMLElement;
  private readonly propertiesPanel: HTMLElement;

  constructor(
    private readonly objectsPanelRoot: HTMLElement,
    private readonly propertiesPanelRoot: HTMLElement,
    private readonly callbacks: SidebarCallbacks
  ) {
    this.objectsPanelRoot.innerHTML = `
      <div class="sidebar-header">
        <span>Objects</span>
        <button type="button" data-role="create-button" class="sidebar-icon-button">+</button>
      </div>
      <div class="objects-list"></div>
    `;
    this.objectsList = this.objectsPanelRoot.querySelector(".objects-list")!;
    this.objectsPanelRoot.querySelector('[data-role="create-button"]')!.addEventListener("click", () => {
      this.callbacks.onCreateClick();
    });

    this.propertiesPanel = this.propertiesPanelRoot;
    this.propertiesPanel.addEventListener("mousedown", (event) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") this.draggingControl = true;
    });
    window.addEventListener("mouseup", this.handleWindowMouseUp);
    // "focusin"/"focusout" (not "focus"/"blur", which don't bubble) so one
    // listener on the panel covers every field rebuilt into it across
    // renders, rather than needing to rebind per-render like the field-
    // specific listeners in renderProperties().
    this.propertiesPanel.addEventListener("focusin", (event) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") this.focusedField = true;
    });
    this.propertiesPanel.addEventListener("focusout", (event) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") this.focusedField = false;
    });
    this.renderProperties();
  }

  // window outlives a single Sidebar instance (objectsPanelRoot/
  // propertiesPanelRoot are static containers reused across room switches),
  // so this needs a stable reference to remove in dispose() -- otherwise
  // every switch leaves the previous instance's handler still firing.
  private readonly handleWindowMouseUp = (): void => {
    this.draggingControl = false;
  };

  dispose(): void {
    window.removeEventListener("mouseup", this.handleWindowMouseUp);
  }

  setAssets(assets: Asset[]): void {
    this.assets = new Map(assets.map((a) => [a.assetId, a]));
    this.renderObjectsList();
    if (this.selectedAssetId && !this.assets.has(this.selectedAssetId)) {
      this.selectedAssetId = undefined;
    }
    this.renderProperties();
  }

  upsertAsset(asset: Asset): void {
    this.assets.set(asset.assetId, asset);
    this.renderObjectsList();
    // Rebuilding the properties panel (innerHTML) while a range/text input
    // inside it is mid-drag destroys and recreates that element, which
    // drops the browser's mouse capture and stops the drag after a single
    // tick. The panel already reflects the in-progress value via the
    // input's own local listener, so skip the rebuild until the mouse is
    // released (see `interacting`, tracked via mousedown/mouseup above).
    if (asset.assetId === this.selectedAssetId && !this.interacting) this.renderProperties();
  }

  removeAsset(assetId: string): void {
    this.assets.delete(assetId);
    this.renderObjectsList();
    if (assetId === this.selectedAssetId) {
      this.selectedAssetId = undefined;
      this.renderProperties();
    }
  }

  setSelected(assetId: string | undefined): void {
    this.selectedAssetId = assetId;
    this.renderObjectsList();
    this.renderProperties();
  }

  private renderObjectsList(): void {
    const scrollTop = this.objectsList.scrollTop;
    this.objectsList.innerHTML = "";
    const sorted = [...this.assets.values()].sort((a, b) => b.zIndex - a.zIndex);
    for (const asset of sorted) {
      const row = document.createElement("div");
      row.className = "object-row" + (asset.assetId === this.selectedAssetId ? " selected" : "");

      const icon = document.createElement("span");
      icon.className = "object-icon";
      icon.innerHTML = TYPE_ICON[asset.type];

      const name = document.createElement("span");
      name.className = "object-name";
      name.textContent = displayName(asset);
      name.title = displayName(asset);

      // Reads this.assets.get(assetId) fresh at click time rather than
      // closing over the `asset` from this render pass -- with a fast
      // double-click (or any click before the server round-trip re-renders
      // the row), a captured-at-render-time value would be stale, sending
      // the same "toggle" value twice instead of actually toggling back.
      const eyeButton = document.createElement("button");
      eyeButton.type = "button";
      eyeButton.className = "sidebar-icon-button";
      eyeButton.innerHTML = asset.hidden ? ICON_EYE_OFF : ICON_EYE;
      eyeButton.title = asset.hidden ? "Show to viewers" : "Hide from viewers";
      eyeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        const current = this.assets.get(asset.assetId);
        if (current) this.callbacks.onToggleHidden(asset.assetId, !current.hidden);
      });

      const lockButton = document.createElement("button");
      lockButton.type = "button";
      lockButton.className = "sidebar-icon-button";
      lockButton.innerHTML = asset.locked ? ICON_LOCK : ICON_UNLOCK;
      lockButton.title = asset.locked ? "Unlock" : "Lock (prevent drag/resize)";
      lockButton.addEventListener("click", (event) => {
        event.stopPropagation();
        const current = this.assets.get(asset.assetId);
        if (current) this.callbacks.onToggleLocked(asset.assetId, !current.locked);
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "sidebar-icon-button";
      deleteButton.innerHTML = ICON_TRASH;
      deleteButton.title = "Delete";
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        this.callbacks.onDelete(asset.assetId);
      });

      row.append(icon, name, eyeButton, lockButton, deleteButton);
      row.addEventListener("click", () => this.callbacks.onSelect(asset.assetId));
      this.objectsList.appendChild(row);
    }
    this.objectsList.scrollTop = scrollTop;
  }

  private renderProperties(): void {
    const asset = this.selectedAssetId ? this.assets.get(this.selectedAssetId) : undefined;
    if (!asset) {
      this.propertiesPanel.innerHTML = "";
      this.propertiesPanel.style.display = "none";
      return;
    }
    this.propertiesPanel.style.display = "flex";

    const assetId = asset.assetId;
    const patch = (p: AssetPatch) => this.callbacks.onPatch(assetId, p);

    this.propertiesPanel.innerHTML = `
      <div class="sidebar-header">
        <input
          type="text"
          data-role="name"
          class="prop-name-input"
          placeholder="${escapeHtml(displayName(asset))}"
          value="${escapeHtml(asset.name ?? "")}"
        />
        <span class="prop-name-suffix">- properties</span>
      </div>
      <div class="properties-buttons">
        <button type="button" data-role="delete" class="sidebar-icon-button danger">${ICON_TRASH}</button>
        <button type="button" data-role="toggle-hidden" class="sidebar-icon-button">${asset.hidden ? ICON_EYE_OFF : ICON_EYE}</button>
        <button type="button" data-role="toggle-locked" class="sidebar-icon-button">${asset.locked ? ICON_LOCK : ICON_UNLOCK}</button>
        <button type="button" data-role="duplicate" class="sidebar-icon-button">${ICON_DUPLICATE}</button>
      </div>
      <div class="prop-row">
        <label class="prop-label">Z-index</label>
        <input type="number" data-role="zindex" value="${asset.zIndex}" />
      </div>
      <div class="prop-row-pair">
        <div>
          <label class="prop-label">X</label>
          <input type="number" data-role="x" value="${Math.round(asset.x)}" />
        </div>
        <div>
          <label class="prop-label">Y</label>
          <input type="number" data-role="y" value="${Math.round(asset.y)}" />
        </div>
      </div>
      <div class="prop-row-pair">
        <div>
          <label class="prop-label">Width</label>
          <input type="number" data-role="width" value="${Math.round(asset.width)}" min="20" />
        </div>
        <div>
          <label class="prop-label">Height</label>
          <input type="number" data-role="height" value="${Math.round(asset.height)}" min="20" />
        </div>
      </div>
      <div class="prop-slider-row">
        <label class="prop-label">Rotation</label>
        <input type="number" data-role="rotation-number" class="prop-slider-number" value="${normalizeRotation(asset.rotation)}" />
      </div>
      <input type="range" data-role="rotation" min="-180" max="180" value="${normalizeRotation(asset.rotation)}" />
      <div class="prop-slider-row">
        <label class="prop-label">Opacity</label>
        <input type="number" data-role="opacity-number" class="prop-slider-number" value="${Math.round(asset.opacity * 100)}" />
      </div>
      <input type="range" data-role="opacity" min="0" max="100" value="${Math.round(asset.opacity * 100)}" />
      <div class="prop-slider-row">
        <label class="prop-label">Blur</label>
        <input type="number" data-role="blur-number" class="prop-slider-number" value="${asset.blur}" />
      </div>
      <input type="range" data-role="blur" min="0" max="20" value="${asset.blur}" />
      <div class="properties-buttons">
        <button type="button" data-role="flip-x" class="sidebar-flip-button${asset.flipX ? " active" : ""}">Flip H</button>
        <button type="button" data-role="flip-y" class="sidebar-flip-button${asset.flipY ? " active" : ""}">Flip V</button>
      </div>
      ${asset.type === "text" ? textSettingsHtml(asset) : ""}
      ${asset.type === "video" || asset.type === "audio" ? `
        <div class="sidebar-header"><span>Playback</span></div>
        <div class="properties-buttons">
          <button type="button" data-role="play-pause" class="sidebar-icon-button playback-button">${asset.paused ? ICON_PLAY : ICON_PAUSE}</button>
          <label class="prop-checkbox"><input type="checkbox" data-role="loop" ${asset.loop ? "checked" : ""} /> Loop</label>
          <label class="prop-checkbox"><input type="checkbox" data-role="muted" ${asset.muted ? "checked" : ""} /> Mute</label>
        </div>
        <div class="prop-slider-row">
          <label class="prop-label">Volume</label>
          <input type="number" data-role="volume-number" class="prop-slider-number" value="${Math.round(asset.volume * 100)}" />
        </div>
        <input type="range" data-role="volume" min="0" max="100" value="${Math.round(asset.volume * 100)}" />
      ` : ""}
    `;

    const el = <T extends HTMLElement>(role: string) => this.propertiesPanel.querySelector<T>(`[data-role="${role}"]`)!;

    const nameInput = el<HTMLInputElement>("name");
    const commitName = () => patch({ name: nameInput.value.trim() });
    nameInput.addEventListener("change", commitName);
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") nameInput.blur();
    });

    el<HTMLButtonElement>("delete").addEventListener("click", () => this.callbacks.onDelete(assetId));
    // Reads this.assets.get(assetId) fresh at click time -- see the same
    // note on the objects-list eye/lock buttons above for why closing over
    // `asset` from this render pass would go stale on a rapid second click.
    el<HTMLButtonElement>("toggle-hidden").addEventListener("click", () => {
      const current = this.assets.get(assetId);
      if (current) this.callbacks.onToggleHidden(assetId, !current.hidden);
    });
    el<HTMLButtonElement>("toggle-locked").addEventListener("click", () => {
      const current = this.assets.get(assetId);
      if (current) this.callbacks.onToggleLocked(assetId, !current.locked);
    });
    el<HTMLButtonElement>("duplicate").addEventListener("click", () => this.callbacks.onDuplicate(assetId));

    if (asset.type === "text") {
      // "input" (not "change") so edits made here also show up live for
      // every other view (canvas, browser-source) as the user types,
      // matching the canvas's own inline double-click editor.
      const textArea = el<HTMLTextAreaElement>("text-content");
      textArea.addEventListener("input", () => patch({ text: textArea.value }));

      el<HTMLInputElement>("font-size").addEventListener("change", (e) =>
        patch({ fontSize: Number((e.target as HTMLInputElement).value) })
      );
      el<HTMLSelectElement>("font-family").addEventListener("change", (e) =>
        patch({ fontFamily: (e.target as HTMLSelectElement).value })
      );
      el<HTMLSelectElement>("font-weight").addEventListener("change", (e) =>
        patch({ fontWeight: (e.target as HTMLSelectElement).value })
      );
      el<HTMLSelectElement>("text-align").addEventListener("change", (e) =>
        patch({ textAlign: (e.target as HTMLSelectElement).value as "left" | "center" | "right" })
      );

      const bgSwatch = el<HTMLInputElement>("bg-color-swatch");
      const bgHex = el<HTMLInputElement>("bg-color-hex");
      const textSwatch = el<HTMLInputElement>("text-color-swatch");
      const textHex = el<HTMLInputElement>("text-color-hex");
      // Swatch and hex text input are two views of the same value -- kept
      // in sync locally on "input" (no round-trip needed just to reflect
      // typing back into the paired control) and only patched on "change"
      // (release/blur), matching bindSlider's range/number pairing above.
      bgSwatch.addEventListener("input", () => (bgHex.value = bgSwatch.value));
      bgSwatch.addEventListener("change", () => patch({ backgroundColor: bgSwatch.value }));
      bgHex.addEventListener("change", () => {
        bgSwatch.value = bgHex.value;
        patch({ backgroundColor: bgHex.value });
      });
      textSwatch.addEventListener("input", () => (textHex.value = textSwatch.value));
      textSwatch.addEventListener("change", () => patch({ textColor: textSwatch.value }));
      textHex.addEventListener("change", () => {
        textSwatch.value = textHex.value;
        patch({ textColor: textHex.value });
      });
      el<HTMLButtonElement>("swap-colors").addEventListener("click", () => {
        const current = this.assets.get(assetId);
        if (!current) return;
        const s = resolveTextStyle(current);
        patch({ backgroundColor: s.textColor, textColor: s.backgroundColor });
      });

      // No paired number field for this one (unlike bindSlider's usual
      // range+number pair) -- "input" (not "change") so it patches live on
      // every drag tick, same as every other slider in the app.
      const bgAlpha = el<HTMLInputElement>("bg-alpha");
      bgAlpha.addEventListener("input", () => patch({ backgroundAlpha: Number(bgAlpha.value) / 100 }));

      el<HTMLInputElement>("shadow-enabled").addEventListener("change", (e) =>
        patch({ shadowEnabled: (e.target as HTMLInputElement).checked })
      );
      el<HTMLInputElement>("shadow-x").addEventListener("change", (e) =>
        patch({ shadowX: Number((e.target as HTMLInputElement).value) })
      );
      el<HTMLInputElement>("shadow-y").addEventListener("change", (e) =>
        patch({ shadowY: Number((e.target as HTMLInputElement).value) })
      );
      el<HTMLInputElement>("shadow-blur").addEventListener("change", (e) =>
        patch({ shadowBlur: Number((e.target as HTMLInputElement).value) })
      );
      el<HTMLInputElement>("shadow-color").addEventListener("change", (e) =>
        patch({ shadowColor: (e.target as HTMLInputElement).value })
      );

      el<HTMLInputElement>("outline-enabled").addEventListener("change", (e) =>
        patch({ outlineEnabled: (e.target as HTMLInputElement).checked })
      );
      el<HTMLInputElement>("outline-color").addEventListener("change", (e) =>
        patch({ outlineColor: (e.target as HTMLInputElement).value })
      );
      // "input" (not "change") so it patches live on every drag tick, same
      // as every other slider in the app.
      el<HTMLInputElement>("outline-width").addEventListener("input", (e) =>
        patch({ outlineWidth: Number((e.target as HTMLInputElement).value) })
      );
    }

    el<HTMLInputElement>("zindex").addEventListener("change", (e) =>
      patch({ zIndex: Number((e.target as HTMLInputElement).value) })
    );

    const xInput = el<HTMLInputElement>("x");
    const yInput = el<HTMLInputElement>("y");
    const sendPosition = () => this.callbacks.onMove(assetId, Number(xInput.value), Number(yInput.value));
    xInput.addEventListener("change", sendPosition);
    yInput.addEventListener("change", sendPosition);

    const widthInput = el<HTMLInputElement>("width");
    const heightInput = el<HTMLInputElement>("height");
    const sendSize = () => this.callbacks.onResize(assetId, Number(widthInput.value), Number(heightInput.value));
    widthInput.addEventListener("change", sendSize);
    heightInput.addEventListener("change", sendSize);

    this.bindSlider(patch, "rotation", "rotation-number", -180, 180, (v) => ({ rotation: v }));
    this.bindSlider(patch, "opacity", "opacity-number", 0, 100, (v) => ({ opacity: v / 100 }));
    this.bindSlider(patch, "blur", "blur-number", 0, 20, (v) => ({ blur: v }));

    el<HTMLButtonElement>("flip-x").addEventListener("click", () => {
      const current = this.assets.get(assetId);
      if (current) patch({ flipX: !current.flipX });
    });
    el<HTMLButtonElement>("flip-y").addEventListener("click", () => {
      const current = this.assets.get(assetId);
      if (current) patch({ flipY: !current.flipY });
    });

    if (asset.type === "video" || asset.type === "audio") {
      el<HTMLButtonElement>("play-pause").addEventListener("click", () => {
        const current = this.assets.get(assetId);
        if (current) patch({ paused: !current.paused });
      });
      el<HTMLInputElement>("loop").addEventListener("change", (e) =>
        patch({ loop: (e.target as HTMLInputElement).checked })
      );
      el<HTMLInputElement>("muted").addEventListener("change", (e) =>
        patch({ muted: (e.target as HTMLInputElement).checked })
      );
      this.bindSlider(patch, "volume", "volume-number", 0, 100, (v) => ({ volume: v / 100 }));
    }
  }

  // Wires a slider + its paired numeric input together: dragging the slider
  // live-updates the number, typing in the number live-updates the slider,
  // and either one sends the patch. Both fire a final renderProperties() on
  // "change" (release/blur) to pick up anything that changed via other
  // clients while this one was mid-edit -- see the mid-drag rebuild note in
  // upsertAsset for why that rebuild must NOT happen while `interacting`.
  private bindSlider(
    patch: (p: AssetPatch) => void,
    rangeRole: string,
    numberRole: string,
    min: number,
    max: number,
    toPatch: (value: number) => AssetPatch
  ): void {
    const range = this.propertiesPanel.querySelector<HTMLInputElement>(`[data-role="${rangeRole}"]`)!;
    const number = this.propertiesPanel.querySelector<HTMLInputElement>(`[data-role="${numberRole}"]`)!;
    const apply = (value: number) => {
      const clamped = Math.min(max, Math.max(min, value));
      range.value = String(clamped);
      number.value = String(clamped);
      patch(toPatch(clamped));
    };
    range.addEventListener("input", () => apply(Number(range.value)));
    range.addEventListener("change", () => this.renderProperties());
    number.addEventListener("input", () => {
      if (number.value === "" || number.value === "-") return;
      const parsed = Number(number.value);
      if (Number.isFinite(parsed)) apply(parsed);
    });
    number.addEventListener("change", () => this.renderProperties());
  }
}

// The rotation slider/input work in -180..180 (0 in the middle), but
// CSS rotate() and the stored value are just degrees with no inherent
// range -- an asset rotated via some other path (or a legacy value) could
// sit outside that window (e.g. 350deg, equivalent to -10deg). Normalize
// to the nearest equivalent angle in -180..180 purely for display; the
// value sent back on edit is already in that range going forward.
function normalizeRotation(deg: number): number {
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

function textSettingsHtml(asset: Asset): string {
  const s = resolveTextStyle(asset);
  const fontOptions = TEXT_FONT_FAMILIES.map(
    (f) => `<option value="${f}"${f === s.fontFamily ? " selected" : ""}>${f}</option>`
  ).join("");
  const weightOptions = TEXT_FONT_WEIGHTS.map(
    (w) => `<option value="${w}"${w === s.fontWeight ? " selected" : ""}>${w}</option>`
  ).join("");
  const alignOptions = (["left", "center", "right"] as const)
    .map((a) => `<option value="${a}"${a === s.textAlign ? " selected" : ""}>${a}</option>`)
    .join("");

  return `
    <div class="sidebar-header"><span>text settings</span></div>
    <label class="prop-label">Text</label>
    <textarea data-role="text-content" rows="3">${escapeHtml(asset.text ?? "")}</textarea>
    <div class="prop-row-pair">
      <div>
        <label class="prop-label">Size:</label>
        <input type="number" data-role="font-size" value="${s.fontSize}" min="1" />
      </div>
      <div>
        <label class="prop-label">Family:</label>
        <select data-role="font-family">${fontOptions}</select>
      </div>
    </div>
    <div class="prop-row-pair">
      <div>
        <label class="prop-label">Weight:</label>
        <select data-role="font-weight">${weightOptions}</select>
      </div>
      <div>
        <label class="prop-label">Align:</label>
        <select data-role="text-align">${alignOptions}</select>
      </div>
    </div>
    <div class="color-swap-row">
      <div class="color-field">
        <label class="prop-label">background</label>
        <input type="color" data-role="bg-color-swatch" value="${s.backgroundColor}" />
        <input type="text" data-role="bg-color-hex" value="${s.backgroundColor}" />
      </div>
      <button type="button" data-role="swap-colors" class="toolbar-button">swap &#8646;</button>
      <div class="color-field">
        <label class="prop-label">text</label>
        <input type="color" data-role="text-color-swatch" value="${s.textColor}" />
        <input type="text" data-role="text-color-hex" value="${s.textColor}" />
      </div>
    </div>
    <div class="prop-slider-row">
      <label class="prop-label">Background Alpha:</label>
    </div>
    <input type="range" data-role="bg-alpha" min="0" max="100" value="${Math.round(s.backgroundAlpha * 100)}" />
    <label class="prop-checkbox"><input type="checkbox" data-role="shadow-enabled" ${s.shadowEnabled ? "checked" : ""} /> shadow</label>
    <div class="prop-row-pair">
      <div>
        <label class="prop-label">X</label>
        <input type="number" data-role="shadow-x" value="${s.shadowX}" />
      </div>
      <div>
        <label class="prop-label">Y</label>
        <input type="number" data-role="shadow-y" value="${s.shadowY}" />
      </div>
      <div>
        <label class="prop-label">blur</label>
        <input type="number" data-role="shadow-blur" value="${s.shadowBlur}" min="0" />
      </div>
    </div>
    <div>
      <label class="prop-label">Color:</label>
      <input type="color" data-role="shadow-color" value="${s.shadowColor}" />
    </div>
    <label class="prop-checkbox"><input type="checkbox" data-role="outline-enabled" ${s.outlineEnabled ? "checked" : ""} /> outline</label>
    <div class="prop-slider-row">
      <input type="color" data-role="outline-color" value="${s.outlineColor}" />
      <input type="range" data-role="outline-width" min="0" max="20" value="${s.outlineWidth}" />
    </div>
  `;
}

function displayName(asset: Asset): string {
  if (asset.name) return asset.name;
  if (asset.type === "text") {
    const text = asset.text ?? "";
    return text.length > 24 ? text.slice(0, 24) + "…" : text || "(empty text)";
  }
  if (asset.s3Key) {
    const fileName = asset.s3Key.split("/").pop() ?? asset.s3Key;
    return fileName;
  }
  return asset.assetId;
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}
