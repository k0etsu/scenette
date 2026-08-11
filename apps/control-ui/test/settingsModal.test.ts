// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/auth", () => ({
  changePassword: vi.fn(),
  changeEmail: vi.fn(),
  deleteAccount: vi.fn(),
}));

import { SettingsModal } from "../src/settingsModal";
import * as auth from "../src/auth";

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
  vi.clearAllMocks();
});

function statusText(): string {
  return (root.querySelector('[data-role="status"]') as HTMLElement).textContent ?? "";
}

function click(role: string): void {
  (root.querySelector(`[data-role="${role}"]`) as HTMLElement).click();
}

function setValue(role: string, value: string): void {
  (root.querySelector(`[data-role="${role}"]`) as HTMLInputElement).value = value;
}

describe("email change", () => {
  it("calls onEmailChanged after a successful update -- the dashboard behind it was rendered from a stale session", async () => {
    vi.mocked(auth.changeEmail).mockResolvedValue(undefined);
    const onEmailChanged = vi.fn();

    const modal = new SettingsModal(root);
    modal.open("https://api.example.com", undefined, onEmailChanged);
    setValue("email", "new@example.com");
    click("save-email");
    await vi.waitFor(() => expect(auth.changeEmail).toHaveBeenCalled());

    expect(onEmailChanged).toHaveBeenCalledTimes(1);
    expect(statusText()).toBe("Email updated.");
  });

  it("does not call onEmailChanged when the update fails", async () => {
    vi.mocked(auth.changeEmail).mockRejectedValue(new Error("That email is already in use"));
    const onEmailChanged = vi.fn();

    const modal = new SettingsModal(root);
    modal.open("https://api.example.com", undefined, onEmailChanged);
    setValue("email", "taken@example.com");
    click("save-email");
    await vi.waitFor(() => expect(statusText()).toMatch(/Failed to update email/));

    expect(onEmailChanged).not.toHaveBeenCalled();
  });

  it("is a no-op when open() was not given a callback", async () => {
    vi.mocked(auth.changeEmail).mockResolvedValue(undefined);

    const modal = new SettingsModal(root);
    modal.open("https://api.example.com", undefined);
    setValue("email", "new@example.com");
    click("save-email");
    await vi.waitFor(() => expect(statusText()).toBe("Email updated."));
  });
});
