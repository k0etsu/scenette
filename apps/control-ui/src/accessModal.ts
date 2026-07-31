import { listMembers, revokeMember, createInvite, listInvites, revokeInvite, Member, Invite } from "./auth";
import { ICON_TRASH, ICON_PLUS } from "./icons";

// Room access management: current members (revocable, except the owner's
// own row) and pending single-use invite links (create/copy/revoke). Talks
// to the accounts HTTP API directly rather than going through main.ts
// callbacks -- everything it needs (httpApiUrl, roomId, the stored session
// token via auth.ts) is passed into open() or pulled from localStorage,
// and nothing here needs to coordinate with canvas/sidebar state.
export class AccessModal {
  private httpApiUrl = "";
  private roomId = "";
  private readonly membersList: HTMLElement;
  private readonly invitesList: HTMLElement;

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = `
      <div class="access-modal-content">
        <div class="sidebar-header">
          <span>Room access</span>
          <button type="button" data-role="close" class="sidebar-icon-button">✕</button>
        </div>
        <div class="access-section">
          <div class="sidebar-header"><span>Members</span></div>
          <div data-role="members-list"></div>
        </div>
        <div class="access-section">
          <div class="sidebar-header">
            <span>Invite links</span>
            <button type="button" data-role="create-invite" class="sidebar-icon-button">${ICON_PLUS}</button>
          </div>
          <div data-role="invites-list"></div>
        </div>
      </div>
    `;

    this.membersList = root.querySelector('[data-role="members-list"]')!;
    this.invitesList = root.querySelector('[data-role="invites-list"]')!;

    root.querySelector('[data-role="close"]')!.addEventListener("click", () => this.close());
    // Clicking the dimmed backdrop (not the content box itself) closes too.
    root.addEventListener("click", (event) => {
      if (event.target === root) this.close();
    });
    root.querySelector('[data-role="create-invite"]')!.addEventListener("click", () => this.handleCreateInvite());
  }

  async open(httpApiUrl: string, roomId: string): Promise<void> {
    this.httpApiUrl = httpApiUrl;
    this.roomId = roomId;
    this.root.style.display = "flex";
    await this.refresh();
  }

  close(): void {
    this.root.style.display = "none";
  }

  private async refresh(): Promise<void> {
    const [members, invites] = await Promise.all([
      listMembers(this.httpApiUrl, this.roomId).catch(() => []),
      listInvites(this.httpApiUrl, this.roomId).catch(() => []),
    ]);
    this.renderMembers(members);
    this.renderInvites(invites);
  }

  private renderMembers(members: Member[]): void {
    this.membersList.innerHTML = "";
    if (members.length === 0) {
      this.membersList.innerHTML = '<div class="access-empty">No members yet.</div>';
      return;
    }
    for (const member of members) {
      const row = document.createElement("div");
      row.className = "access-row";

      const label = document.createElement("span");
      label.className = "access-row-label";
      label.textContent = `${member.accountId} (${member.role})`;
      row.appendChild(label);

      // The owner's own membership row is what makes them the owner -- the
      // server refuses to revoke it regardless, but hiding the button here
      // avoids a pointless round-trip that would just come back as an error.
      if (member.role !== "owner") {
        const revokeButton = document.createElement("button");
        revokeButton.type = "button";
        revokeButton.className = "sidebar-icon-button danger";
        revokeButton.innerHTML = ICON_TRASH;
        revokeButton.title = "Revoke access";
        revokeButton.addEventListener("click", async () => {
          await revokeMember(this.httpApiUrl, this.roomId, member.accountId).catch(() => {});
          await this.refresh();
        });
        row.appendChild(revokeButton);
      }

      this.membersList.appendChild(row);
    }
  }

  private renderInvites(invites: Invite[]): void {
    this.invitesList.innerHTML = "";
    if (invites.length === 0) {
      this.invitesList.innerHTML = '<div class="access-empty">No pending invite links.</div>';
      return;
    }
    for (const invite of invites) {
      const row = document.createElement("div");
      row.className = "access-row";

      const label = document.createElement("div");
      label.className = "access-row-label";
      label.innerHTML = `<div>Invite link</div><div class="access-row-sub">created ${new Date(invite.createdAt).toLocaleString()}</div>`;
      row.appendChild(label);

      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "sidebar-icon-button";
      copyButton.textContent = "Copy";
      copyButton.title = "Copy invite link";
      copyButton.addEventListener("click", () => this.copyInviteLink(invite.inviteToken));
      row.appendChild(copyButton);

      const revokeButton = document.createElement("button");
      revokeButton.type = "button";
      revokeButton.className = "sidebar-icon-button danger";
      revokeButton.innerHTML = ICON_TRASH;
      revokeButton.title = "Revoke this invite";
      revokeButton.addEventListener("click", async () => {
        await revokeInvite(this.httpApiUrl, this.roomId, invite.inviteToken).catch(() => {});
        await this.refresh();
      });
      row.appendChild(revokeButton);

      this.invitesList.appendChild(row);
    }
  }

  private async handleCreateInvite(): Promise<void> {
    const invite = await createInvite(this.httpApiUrl, this.roomId).catch(() => undefined);
    if (!invite) return;
    await this.refresh();
    await this.copyInviteLink(invite.inviteToken);
  }

  private inviteUrl(inviteToken: string): string {
    return `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(inviteToken)}`;
  }

  private async copyInviteLink(inviteToken: string): Promise<void> {
    const url = this.inviteUrl(inviteToken);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard API can be denied (insecure context, permissions) --
      // fall back to a visible prompt so the link is still usable.
      window.prompt("Copy this invite link:", url);
    }
  }
}
