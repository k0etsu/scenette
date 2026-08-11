import { extractYoutubeVideoId } from "@scenette/protocol";

// A minimal single-field modal for the context-menu "Add YouTube" entry --
// mirrors AccessModal/SettingsModal's shell (backdrop-click-to-close, a
// status line for inline feedback) rather than a bare window.prompt(),
// which can't show "that doesn't look like a YouTube URL" without a
// jarring native alert() and would be the only native dialog in an
// otherwise consistently-themed app.
export class YoutubeUrlModal {
  private readonly statusEl: HTMLElement;
  private readonly urlInput: HTMLInputElement;
  private onSubmit: (videoId: string) => void = () => {};

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = `
      <div class="access-modal-content">
        <div class="sidebar-header">
          <span>Add YouTube video</span>
          <button type="button" data-role="close" class="sidebar-icon-button">✕</button>
        </div>
        <div data-role="status" class="access-status"></div>
        <input type="text" data-role="url" class="settings-input" placeholder="https://www.youtube.com/watch?v=..." />
        <button type="button" data-role="add" class="toolbar-button">Add</button>
      </div>
    `;

    this.statusEl = root.querySelector('[data-role="status"]')!;
    this.urlInput = root.querySelector('[data-role="url"]')!;

    root.querySelector('[data-role="close"]')!.addEventListener("click", () => this.close());
    root.addEventListener("click", (event) => {
      if (event.target === root) this.close();
    });
    root.querySelector('[data-role="add"]')!.addEventListener("click", () => this.handleSubmit());
    this.urlInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.handleSubmit();
    });
  }

  open(onSubmit: (videoId: string) => void): void {
    this.onSubmit = onSubmit;
    this.statusEl.textContent = "";
    this.urlInput.value = "";
    this.root.style.display = "flex";
    this.urlInput.focus();
  }

  close(): void {
    this.root.style.display = "none";
  }

  private handleSubmit(): void {
    const videoId = extractYoutubeVideoId(this.urlInput.value.trim());
    if (!videoId) {
      this.statusEl.textContent = "That doesn't look like a valid YouTube URL.";
      return;
    }
    this.onSubmit(videoId);
    this.close();
  }
}
