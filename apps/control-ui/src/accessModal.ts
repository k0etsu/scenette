import { listMembers, revokeMember, createInvite, listInvites, revokeInvite, Member, Invite } from "./auth";
import { ICON_TRASH, ICON_PLUS } from "./icons";

// Room access management: current members (revocable, except the owner's
// own row) and pending single-use invite links (create/copy/revoke). Talks
// to the accounts HTTP API directly (via auth.ts, which sends the HttpOnly
// session cookie automatically) rather than going through main.ts callbacks
// -- everything it needs (httpApiUrl, roomId) is passed into open(), and
// nothing here needs to coordinate with canvas/sidebar state.
export class AccessModal {
  private httpApiUrl = "";
  private roomId = "";
  // Local copies, mutated directly on create/revoke rather than always
  // re-querying the server afterward -- listMembers/listPendingInvites both
  // read through a DynamoDB GSI, which is only eventually consistent with
  // a just-written item. Re-fetching immediately after a create/revoke
  // occasionally raced that propagation lag and looked like the modal
  // "not updating" for a moment. The server round-trip already tells us
  // exactly what changed, so there's nothing to re-derive by re-querying.
  private members: Member[] = [];
  private invites: Invite[] = [];
  private readonly membersList: HTMLElement;
  private readonly invitesList: HTMLElement;
  private readonly statusEl: HTMLElement;

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = `
      <div class="access-modal-content">
        <div class="sidebar-header">
          <span>Room access</span>
          <button type="button" data-role="close" class="sidebar-icon-button">✕</button>
        </div>
        <div data-role="status" class="access-status"></div>
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
    this.statusEl = root.querySelector('[data-role="status"]')!;

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
    this.statusEl.textContent = "";
    this.root.style.display = "flex";
    try {
      const [members, invites] = await Promise.all([
        listMembers(httpApiUrl, roomId),
        listInvites(httpApiUrl, roomId),
      ]);
      this.members = members;
      this.invites = invites;
      this.renderMembers();
      this.renderInvites();
    } catch (err) {
      this.statusEl.textContent = `Failed to load room access: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  close(): void {
    this.root.style.display = "none";
  }

  private renderMembers(): void {
    this.membersList.innerHTML = "";
    if (this.members.length === 0) {
      this.membersList.innerHTML = '<div class="access-empty">No members yet.</div>';
      return;
    }
    for (const member of this.members) {
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
        revokeButton.addEventListener("click", () => this.handleRevokeMember(member.accountId));
        row.appendChild(revokeButton);
      }

      this.membersList.appendChild(row);
    }
  }

  private renderInvites(): void {
    this.invitesList.innerHTML = "";
    if (this.invites.length === 0) {
      this.invitesList.innerHTML = '<div class="access-empty">No pending invite links.</div>';
      return;
    }
    for (const invite of this.invites) {
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
      revokeButton.addEventListener("click", () => this.handleRevokeInvite(invite.inviteToken));
      row.appendChild(revokeButton);

      this.invitesList.appendChild(row);
    }
  }

  private async handleCreateInvite(): Promise<void> {
    this.statusEl.textContent = "";
    try {
      const invite = await createInvite(this.httpApiUrl, this.roomId);
      this.invites = [...this.invites, invite];
      this.renderInvites();
      await this.copyInviteLink(invite.inviteToken);
    } catch (err) {
      this.statusEl.textContent = `Failed to create invite: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async handleRevokeInvite(inviteToken: string): Promise<void> {
    this.statusEl.textContent = "";
    try {
      await revokeInvite(this.httpApiUrl, this.roomId, inviteToken);
      this.invites = this.invites.filter((i) => i.inviteToken !== inviteToken);
      this.renderInvites();
    } catch (err) {
      this.statusEl.textContent = `Failed to revoke invite: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async handleRevokeMember(accountId: string): Promise<void> {
    this.statusEl.textContent = "";
    try {
      await revokeMember(this.httpApiUrl, this.roomId, accountId);
      this.members = this.members.filter((m) => m.accountId !== accountId);
      this.renderMembers();
    } catch (err) {
      this.statusEl.textContent = `Failed to revoke access: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private inviteUrl(inviteToken: string): string {
    return `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(inviteToken)}`;
  }

  private async copyInviteLink(inviteToken: string): Promise<void> {
    const url = this.inviteUrl(inviteToken);
    try {
      await navigator.clipboard.writeText(url);
      this.statusEl.textContent = "Invite link copied to clipboard.";
    } catch {
      // Clipboard API can be denied (insecure context, permissions) --
      // fall back to a visible prompt so the link is still usable.
      window.prompt("Copy this invite link:", url);
    }
  }
}
