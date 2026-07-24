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
    // inside it is actively focused -- e.g. mid-drag on a slider -- destroys
    // and recreates that element, which drops the browser's mouse capture
    // and stops the drag after a single tick. The panel already reflects the
    // in-progress value via the input's own local listener, so skip the
    // rebuild until focus leaves it.
    const active = document.activeElement;
    const isInteracting = active instanceof HTMLElement && this.propertiesPanel.contains(active);
    if (asset.assetId === this.selectedAssetId && !isInteracting) this.renderProperties();
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
    this.propertiesPanel.style.display = "block";

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
      <label class="prop-label">Rotation: <span data-role="rotation-value">${Math.round(asset.rotation)}</span>°</label>
      <input type="range" data-role="rotation" min="0" max="360" value="${asset.rotation}" />
      <label class="prop-label">Opacity: <span data-role="opacity-value">${Math.round(asset.opacity * 100)}</span>%</label>
      <input type="range" data-role="opacity" min="0" max="100" value="${Math.round(asset.opacity * 100)}" />
      <label class="prop-label">Blur: <span data-role="blur-value">${asset.blur}</span>px</label>
      <input type="range" data-role="blur" min="0" max="20" value="${asset.blur}" />
      <div class="properties-buttons">
        <button type="button" data-role="flip-x" class="sidebar-flip-button${asset.flipX ? " active" : ""}">Flip H</button>
        <button type="button" data-role="flip-y" class="sidebar-flip-button${asset.flipY ? " active" : ""}">Flip V</button>
      </div>
      ${asset.type === "video" || asset.type === "audio" ? `
        <div class="sidebar-header"><span>Playback</span></div>
        <div class="properties-buttons">
          <button type="button" data-role="play-pause">${asset.paused ? ICON_PLAY : ICON_PAUSE}</button>
          <label class="prop-checkbox"><input type="checkbox" data-role="loop" ${asset.loop ? "checked" : ""} /> Loop</label>
          <label class="prop-checkbox"><input type="checkbox" data-role="muted" ${asset.muted ? "checked" : ""} /> Mute</label>
        </div>
        <label class="prop-label">Volume: <span data-role="volume-value">${Math.round(asset.volume * 100)}</span>%</label>
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

    const rotationInput = el<HTMLInputElement>("rotation");
    const rotationValue = el<HTMLElement>("rotation-value");
    rotationInput.addEventListener("input", () => {
      rotationValue.textContent = rotationInput.value;
      patch({ rotation: Number(rotationInput.value) });
    });
    rotationInput.addEventListener("change", () => this.renderProperties());

    const opacityInput = el<HTMLInputElement>("opacity");
    const opacityValue = el<HTMLElement>("opacity-value");
    opacityInput.addEventListener("input", () => {
      opacityValue.textContent = opacityInput.value;
      patch({ opacity: Number(opacityInput.value) / 100 });
    });
    opacityInput.addEventListener("change", () => this.renderProperties());

    const blurInput = el<HTMLInputElement>("blur");
    const blurValue = el<HTMLElement>("blur-value");
    blurInput.addEventListener("input", () => {
      blurValue.textContent = blurInput.value;
      patch({ blur: Number(blurInput.value) });
    });
    blurInput.addEventListener("change", () => this.renderProperties());

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
      const volumeInput = el<HTMLInputElement>("volume");
      const volumeValue = el<HTMLElement>("volume-value");
      volumeInput.addEventListener("input", () => {
        volumeValue.textContent = volumeInput.value;
        patch({ volume: Number(volumeInput.value) / 100 });
      });
      volumeInput.addEventListener("change", () => this.renderProperties());
    }
  }
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
