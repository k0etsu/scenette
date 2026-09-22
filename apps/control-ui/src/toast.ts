// Lightweight, dependency-free toast notifications -- top-center, dismissible
// by click, and auto-dismissed after a timeout. Used in place of inline
// status text (e.g. on the login form) that either sat blank most of the
// time (wasting layout space) or bloated the surrounding UI whenever a
// message was shown.
let container: HTMLDivElement | undefined;

function getContainer(): HTMLDivElement {
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }
  return container;
}

const TOAST_TIMEOUT_MS = 6000;

export function showToast(message: string, kind: "info" | "error" = "info"): void {
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;

  const text = document.createElement("span");
  text.className = "toast-text";
  text.textContent = message;
  el.appendChild(text);

  const dismiss = () => el.remove();

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.textContent = "✕";
  close.setAttribute("aria-label", "Dismiss");
  close.addEventListener("click", dismiss);
  el.appendChild(close);

  getContainer().appendChild(el);
  setTimeout(dismiss, TOAST_TIMEOUT_MS);
}
