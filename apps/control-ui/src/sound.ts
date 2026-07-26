import { ICON_EXPAND } from "./icons";

const LOCAL_VOLUME_KEY = "scenette.localVolume";

export interface SoundCallbacks {
  // Global volume is room state (a master multiplier broadcast to every
  // client, control-ui AND browser-source) -- only a user-initiated drag on
  // that slider needs to actually send it over the network.
  onGlobalVolumeChange: (globalVolume: number) => void;
  // Fires whenever either slider moves, or an external (collaborator's)
  // global-volume change arrives -- tells the caller to recompute this
  // preview's actual playing volume (asset.volume * global * local).
  onMultipliersChanged: (globalVolume: number, localVolume: number) => void;
}

// Built once rather than re-rendered (innerHTML) on every update, unlike
// some of the sidebar's older panels -- see sidebar.ts's `interacting` flag
// for the bug that pattern caused with sliders (a rebuild mid-drag destroys
// the dragged element and drops the browser's mouse capture on it). Setting
// .value on an element that's never removed/recreated has no such problem.
export class SoundPanel {
  private globalVolume = 1;
  private localVolume: number;

  private readonly globalSlider: HTMLInputElement;
  private readonly globalLabel: HTMLElement;
  private readonly localSlider: HTMLInputElement;
  private readonly localLabel: HTMLElement;

  constructor(private readonly root: HTMLElement, private readonly callbacks: SoundCallbacks) {
    this.localVolume = loadLocalVolume();

    root.innerHTML = `
      <div class="sidebar-header">
        <span class="sidebar-icon-button" data-role="expand">${ICON_EXPAND}</span>
        <span>Sound</span>
        <span></span>
      </div>
      <label class="prop-label" data-role="global-label"></label>
      <input type="range" data-role="global-slider" min="0" max="100" />
      <label class="prop-label" data-role="local-label"></label>
      <input type="range" data-role="local-slider" min="0" max="100" />
    `;

    this.globalLabel = root.querySelector('[data-role="global-label"]')!;
    this.globalSlider = root.querySelector('[data-role="global-slider"]')!;
    this.localLabel = root.querySelector('[data-role="local-label"]')!;
    this.localSlider = root.querySelector('[data-role="local-slider"]')!;

    this.globalSlider.value = String(Math.round(this.globalVolume * 100));
    this.localSlider.value = String(Math.round(this.localVolume * 100));
    this.updateLabels();

    this.globalSlider.addEventListener("input", () => {
      this.globalVolume = Number(this.globalSlider.value) / 100;
      this.updateLabels();
      this.callbacks.onGlobalVolumeChange(this.globalVolume);
      this.callbacks.onMultipliersChanged(this.globalVolume, this.localVolume);
    });

    this.localSlider.addEventListener("input", () => {
      this.localVolume = Number(this.localSlider.value) / 100;
      saveLocalVolume(this.localVolume);
      this.updateLabels();
      this.callbacks.onMultipliersChanged(this.globalVolume, this.localVolume);
    });

    const expandButton = root.querySelector<HTMLElement>('[data-role="expand"]')!;
    expandButton.addEventListener("click", () => {
      const collapsed = root.classList.toggle("panel-collapsed");
      expandButton.title = collapsed ? "Expand" : "Collapse";
    });
  }

  // Applies a collaborator's global-volume change (or the server's echo of
  // our own) -- always safe to call mid-drag on either slider since this
  // only ever sets .value/.textContent on already-existing elements.
  setGlobalVolume(globalVolume: number): void {
    this.globalVolume = globalVolume;
    this.globalSlider.value = String(Math.round(globalVolume * 100));
    this.updateLabels();
    this.callbacks.onMultipliersChanged(this.globalVolume, this.localVolume);
  }

  private updateLabels(): void {
    const globalPct = Math.round(this.globalVolume * 100);
    const localPct = Math.round(this.localVolume * 100);
    this.globalLabel.textContent = `Global Volume (${globalPct}%)`;
    this.localLabel.textContent = `Local Volume (${localPct}% of ${globalPct}%)`;
  }
}

function loadLocalVolume(): number {
  const raw = window.localStorage.getItem(LOCAL_VOLUME_KEY);
  const parsed = raw ? Number(raw) : 1;
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
}

function saveLocalVolume(value: number): void {
  window.localStorage.setItem(LOCAL_VOLUME_KEY, String(value));
}
