import { changePassword, changeEmail, deleteAccount } from "./auth";

// Account-level settings, reachable from the dashboard: change password,
// change/clear the (optional) contact email, or permanently delete the
// account. Self-contained like accessModal.ts -- talks to auth.ts directly
// rather than going through main.ts callbacks, since nothing here needs to
// coordinate with room/canvas state. Deleting the account is the one
// exception that needs to leave the app entirely (see handleDeleteAccount).
export class SettingsModal {
  private httpApiUrl = "";
  // Set by open() for the duration of this modal visit -- called after a
  // successful email change so the dashboard behind the modal (which
  // rendered from a session snapshot taken before the modal opened) can
  // refetch and pick up the new emailVerified/personalRoomId state instead
  // of only catching up on the next full reload.
  private onEmailChanged: (() => void) | undefined;
  private readonly statusEl: HTMLElement;
  private readonly emailInput: HTMLInputElement;
  private readonly currentPasswordInput: HTMLInputElement;
  private readonly newPasswordInput: HTMLInputElement;
  private readonly deletePasswordInput: HTMLInputElement;

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = `
      <div class="access-modal-content">
        <div class="sidebar-header">
          <span>Account settings</span>
          <button type="button" data-role="close" class="sidebar-icon-button">✕</button>
        </div>
        <div data-role="status" class="access-status"></div>

        <div class="access-section">
          <div class="sidebar-header"><span>Change password</span></div>
          <input type="password" data-role="current-password" class="settings-input" placeholder="Current password" autocomplete="current-password" />
          <input type="password" data-role="new-password" class="settings-input" placeholder="New password (8+ characters)" autocomplete="new-password" />
          <button type="button" data-role="save-password" class="toolbar-button">Update password</button>
        </div>

        <div class="access-section">
          <div class="sidebar-header"><span>Email</span></div>
          <input type="email" data-role="email" class="settings-input" placeholder="Email (optional)" autocomplete="email" />
          <button type="button" data-role="save-email" class="toolbar-button">Update email</button>
        </div>

        <div class="access-section">
          <div class="sidebar-header"><span>Delete account</span></div>
          <div class="access-empty">
            Permanently deletes your account and every room you own, including all of its assets. This cannot be undone.
          </div>
          <input type="password" data-role="delete-password" class="settings-input" placeholder="Confirm your password" autocomplete="current-password" />
          <button type="button" data-role="delete-account" class="toolbar-button danger">Delete account</button>
        </div>
      </div>
    `;

    this.statusEl = root.querySelector('[data-role="status"]')!;
    this.emailInput = root.querySelector('[data-role="email"]')!;
    this.currentPasswordInput = root.querySelector('[data-role="current-password"]')!;
    this.newPasswordInput = root.querySelector('[data-role="new-password"]')!;
    this.deletePasswordInput = root.querySelector('[data-role="delete-password"]')!;

    root.querySelector('[data-role="close"]')!.addEventListener("click", () => this.close());
    root.addEventListener("click", (event) => {
      if (event.target === root) this.close();
    });
    root.querySelector('[data-role="save-password"]')!.addEventListener("click", () => this.handleSavePassword());
    root.querySelector('[data-role="save-email"]')!.addEventListener("click", () => this.handleSaveEmail());
    root.querySelector('[data-role="delete-account"]')!.addEventListener("click", () => this.handleDeleteAccount());
  }

  open(httpApiUrl: string, currentEmail: string | undefined, onEmailChanged?: () => void): void {
    this.httpApiUrl = httpApiUrl;
    this.onEmailChanged = onEmailChanged;
    this.statusEl.textContent = "";
    this.currentPasswordInput.value = "";
    this.newPasswordInput.value = "";
    this.deletePasswordInput.value = "";
    this.emailInput.value = currentEmail ?? "";
    this.root.style.display = "flex";
  }

  close(): void {
    this.root.style.display = "none";
  }

  private async handleSavePassword(): Promise<void> {
    this.statusEl.textContent = "";
    try {
      await changePassword(this.httpApiUrl, this.currentPasswordInput.value, this.newPasswordInput.value);
      this.currentPasswordInput.value = "";
      this.newPasswordInput.value = "";
      this.statusEl.textContent = "Password updated.";
    } catch (err) {
      this.statusEl.textContent = `Failed to update password: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async handleSaveEmail(): Promise<void> {
    this.statusEl.textContent = "";
    try {
      await changeEmail(this.httpApiUrl, this.emailInput.value.trim());
      this.statusEl.textContent = "Email updated.";
      this.onEmailChanged?.();
    } catch (err) {
      this.statusEl.textContent = `Failed to update email: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async handleDeleteAccount(): Promise<void> {
    this.statusEl.textContent = "";
    if (!this.deletePasswordInput.value) {
      this.statusEl.textContent = "Enter your password to confirm.";
      return;
    }
    // A second, explicit confirmation on top of the password -- this is
    // irreversible and takes every room the account owns down with it, not
    // just the account itself.
    if (!window.confirm("Permanently delete your account and every room you own? This cannot be undone.")) {
      return;
    }
    try {
      await deleteAccount(this.httpApiUrl, this.deletePasswordInput.value);
      // The account (and its session) no longer exists -- nothing left to
      // do but leave the app entirely, same destination as a normal logout.
      window.location.href = window.location.pathname;
    } catch (err) {
      this.statusEl.textContent = `Failed to delete account: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
