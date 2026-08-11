// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { YoutubeUrlModal } from "../src/youtubeUrlModal";

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});

function statusText(): string {
  return (root.querySelector('[data-role="status"]') as HTMLElement).textContent ?? "";
}

function setValue(value: string): void {
  (root.querySelector('[data-role="url"]') as HTMLInputElement).value = value;
}

function click(role: string): void {
  (root.querySelector(`[data-role="${role}"]`) as HTMLElement).click();
}

describe("YoutubeUrlModal", () => {
  it("extracts the video id and calls the submitted callback for a valid URL", () => {
    const modal = new YoutubeUrlModal(root);
    const onSubmit = vi.fn();
    modal.open(onSubmit);
    setValue("https://www.youtube.com/watch?v=dQw4w9WgXcQ");

    click("add");

    expect(onSubmit).toHaveBeenCalledWith("dQw4w9WgXcQ");
    expect(root.style.display).toBe("none"); // closes on success
  });

  it("shows an inline error and does not call back for an invalid URL", () => {
    const modal = new YoutubeUrlModal(root);
    const onSubmit = vi.fn();
    modal.open(onSubmit);
    setValue("not a youtube url");

    click("add");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(statusText()).toMatch(/doesn't look like/i);
    expect(root.style.display).toBe("flex"); // stays open so the user can fix it
  });

  it("submits on Enter in the input, same as clicking Add", () => {
    const modal = new YoutubeUrlModal(root);
    const onSubmit = vi.fn();
    modal.open(onSubmit);
    setValue("https://youtu.be/dQw4w9WgXcQ");

    const input = root.querySelector('[data-role="url"]') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(onSubmit).toHaveBeenCalledWith("dQw4w9WgXcQ");
  });

  it("resets the input and status each time it's opened", () => {
    const modal = new YoutubeUrlModal(root);
    modal.open(vi.fn());
    setValue("garbage");
    click("add");
    expect(statusText()).not.toBe("");

    modal.open(vi.fn());

    expect(statusText()).toBe("");
    expect((root.querySelector('[data-role="url"]') as HTMLInputElement).value).toBe("");
  });

  it("close() hides the modal", () => {
    const modal = new YoutubeUrlModal(root);
    modal.open(vi.fn());
    modal.close();
    expect(root.style.display).toBe("none");
  });

  it("clicking the backdrop (root itself) closes the modal", () => {
    const modal = new YoutubeUrlModal(root);
    modal.open(vi.fn());
    root.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(root.style.display).toBe("none");
  });
});
