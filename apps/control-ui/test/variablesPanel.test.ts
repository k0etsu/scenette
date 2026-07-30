// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Variable } from "@scenette/protocol";
import { VariablesPanel, VariablesCallbacks } from "../src/variablesPanel";

function variable(key: string, value: string, type: Variable["type"] = "number", createdAt = "2026-01-01T00:00:00.000Z"): Variable {
  return { key, value, type, createdAt };
}

function makeCallbacks(overrides: Partial<VariablesCallbacks> = {}): VariablesCallbacks {
  return {
    onSet: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});

describe("list rendering", () => {
  it("renders a row per variable, sorted by createdAt", () => {
    const panel = new VariablesPanel(root, makeCallbacks());
    panel.setVariables([
      variable("second", "2", "number", "2026-01-02T00:00:00.000Z"),
      variable("first", "1", "number", "2026-01-01T00:00:00.000Z"),
    ]);
    const names = [...root.querySelectorAll(".variable-name")].map((n) => n.textContent);
    expect(names).toEqual(["first", "second"]);
  });

  it("shows a numeric stepper for number-type variables", () => {
    const panel = new VariablesPanel(root, makeCallbacks());
    panel.setVariables([variable("kills", "4", "number")]);
    expect(root.querySelector(".variable-stepper")).toBeTruthy();
    expect((root.querySelector(".variable-value") as HTMLElement).textContent).toBe("4");
  });

  it("shows a plain value (no stepper) for text-type variables", () => {
    const panel = new VariablesPanel(root, makeCallbacks());
    panel.setVariables([variable("greeting", "hi", "text")]);
    expect(root.querySelector(".variable-stepper")).toBeFalsy();
    expect(root.querySelector(".variable-value-text")?.textContent).toBe("hi");
  });

  it("upsertVariable adds/updates a row without needing a full setVariables call", () => {
    const panel = new VariablesPanel(root, makeCallbacks());
    panel.setVariables([variable("kills", "4")]);
    panel.upsertVariable(variable("kills", "5"));
    expect((root.querySelector(".variable-value") as HTMLElement).textContent).toBe("5");
  });

  it("removeVariable removes the row", () => {
    const panel = new VariablesPanel(root, makeCallbacks());
    panel.setVariables([variable("kills", "4")]);
    panel.removeVariable("kills");
    expect(root.querySelectorAll(".variable-row")).toHaveLength(0);
  });
});

describe("number variable stepper", () => {
  it("increments by 1 and sends the update via onSet", () => {
    const onSet = vi.fn();
    const panel = new VariablesPanel(root, makeCallbacks({ onSet }));
    panel.setVariables([variable("kills", "4")]);
    const plus = [...root.querySelectorAll(".variable-stepper button")][1] as HTMLElement;
    plus.click();
    expect(onSet).toHaveBeenCalledWith("kills", "number", "5");
  });

  it("decrements by 1", () => {
    const onSet = vi.fn();
    const panel = new VariablesPanel(root, makeCallbacks({ onSet }));
    panel.setVariables([variable("kills", "4")]);
    const minus = [...root.querySelectorAll(".variable-stepper button")][0] as HTMLElement;
    minus.click();
    expect(onSet).toHaveBeenCalledWith("kills", "number", "3");
  });

  it("treats a non-numeric stored value as 0 before incrementing", () => {
    const onSet = vi.fn();
    const panel = new VariablesPanel(root, makeCallbacks({ onSet }));
    panel.setVariables([variable("kills", "not-a-number")]);
    const plus = [...root.querySelectorAll(".variable-stepper button")][1] as HTMLElement;
    plus.click();
    expect(onSet).toHaveBeenCalledWith("kills", "number", "1");
  });
});

describe("create/edit form", () => {
  it("opens with defaults when adding a new variable", () => {
    new VariablesPanel(root, makeCallbacks());
    (root.querySelector('[data-role="add"]') as HTMLElement).click();
    const keyInput = root.querySelector('[data-role="key"]') as HTMLInputElement;
    expect(keyInput.disabled).toBe(false);
    expect(keyInput.value).toBe("");
  });

  it("creating a variable sends onSet with the entered key/type/value", () => {
    const onSet = vi.fn();
    new VariablesPanel(root, makeCallbacks({ onSet }));
    (root.querySelector('[data-role="add"]') as HTMLElement).click();

    (root.querySelector('[data-role="key"]') as HTMLInputElement).value = "newvar";
    (root.querySelector('[data-role="value"]') as HTMLInputElement).value = "42";
    (root.querySelector('[data-role="type"]') as HTMLSelectElement).value = "number";
    (root.querySelector('[data-role="save"]') as HTMLElement).click();

    expect(onSet).toHaveBeenCalledWith("newvar", "number", "42");
  });

  it("does not call onSet when saving with an empty key", () => {
    const onSet = vi.fn();
    new VariablesPanel(root, makeCallbacks({ onSet }));
    (root.querySelector('[data-role="add"]') as HTMLElement).click();
    (root.querySelector('[data-role="save"]') as HTMLElement).click();
    expect(onSet).not.toHaveBeenCalled();
  });

  it("editing an existing variable disables the key field and keeps its key fixed", () => {
    const onSet = vi.fn();
    const panel = new VariablesPanel(root, makeCallbacks({ onSet }));
    panel.setVariables([variable("kills", "4")]);
    (root.querySelector(".variable-name") as HTMLElement).click();

    const keyInput = root.querySelector('[data-role="key"]') as HTMLInputElement;
    expect(keyInput.disabled).toBe(true);
    expect(keyInput.value).toBe("kills");

    (root.querySelector('[data-role="value"]') as HTMLInputElement).value = "9";
    (root.querySelector('[data-role="save"]') as HTMLElement).click();
    expect(onSet).toHaveBeenCalledWith("kills", "number", "9");
  });

  it("cancel closes the form without calling onSet", () => {
    const onSet = vi.fn();
    new VariablesPanel(root, makeCallbacks({ onSet }));
    (root.querySelector('[data-role="add"]') as HTMLElement).click();
    (root.querySelector('[data-role="cancel"]') as HTMLElement).click();
    expect(onSet).not.toHaveBeenCalled();
    expect((root.querySelector(".variables-form") as HTMLElement).style.display).toBe("none");
  });

  it("removing the variable currently being edited closes the form", () => {
    const panel = new VariablesPanel(root, makeCallbacks());
    panel.setVariables([variable("kills", "4")]);
    (root.querySelector(".variable-name") as HTMLElement).click();
    expect((root.querySelector(".variables-form") as HTMLElement).style.display).toBe("block");

    panel.removeVariable("kills");
    expect((root.querySelector(".variables-form") as HTMLElement).style.display).toBe("none");
  });
});

describe("expand/collapse", () => {
  it("toggles the panel-collapsed class", () => {
    new VariablesPanel(root, makeCallbacks());
    const expandButton = root.querySelector('[data-role="expand"]') as HTMLElement;
    expandButton.click();
    expect(root.classList.contains("panel-collapsed")).toBe(true);
    expandButton.click();
    expect(root.classList.contains("panel-collapsed")).toBe(false);
  });
});
