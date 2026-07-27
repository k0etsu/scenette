import { Asset, AssetPatch, AssetType } from "@scenette/protocol";
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

  // Explicitly tracked rather than relying on document.activeElement:
  // clicking/dragging a range input doesn't reliably focus it in every
  // browser (mouse-driven form-control focus behavior differs across
  // engines), so activeElement-based detection silently failed to guard
  // the rebuild below in some browsers -- see upsertAsset.
  private interacting = false;

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
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") this.interacting = true;
    });
    window.addEventListener("mouseup", () => {
      this.interacting = false;
    });
    this.renderProperties();
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
        <span title="${escapeHtml(displayName(asset))}">${escapeHtml(displayName(asset))}</span>
      </div>
      <div class="properties-buttons">
        <button type="button" data-role="delete" class="sidebar-icon-button danger">${ICON_TRASH}</button>
        <button type="button" data-role="toggle-hidden" class="sidebar-icon-button">${asset.hidden ? ICON_EYE_OFF : ICON_EYE}</button>
        <button type="button" data-role="toggle-locked" class="sidebar-icon-button">${asset.locked ? ICON_LOCK : ICON_UNLOCK}</button>
        <button type="button" data-role="duplicate" class="sidebar-icon-button">${ICON_DUPLICATE}</button>
      </div>
      ${asset.type === "text" ? `
        <label class="prop-label">Text</label>
        <textarea data-role="text-content" rows="2">${escapeHtml(asset.text ?? "")}</textarea>
      ` : ""}
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
      const textArea = el<HTMLTextAreaElement>("text-content");
      textArea.addEventListener("change", () => patch({ text: textArea.value }));
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

function displayName(asset: Asset): string {
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
