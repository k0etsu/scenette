// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Variable } from "@scenette/protocol";
import { VariablesPanel, VariablesCallbacks } from "../src/variablesPanel";

function variable(key: string, value: string, type: Variable["type"] = "number", createdAt = "2026-01-01T00:00:00.000Z"): Variable {
  return { key, value, type, createdAt };
}

function makeCallbacks(overrides: Partial<VariablesCallbacks> = {}): VariablesCallbacks {
  return {
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onDelete: vi.fn(),
    onSet: vi.fn(),
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
  it("renders a row per variable in insertion order (not sorted)", () => {
    const panel = new VariablesPanel(root, makeCallbacks());
    panel.setVariables([
      variable("second", "2", "number", "2026-01-02T00:00:00.000Z"),
      variable("first", "1", "number", "2026-01-01T00:00:00.000Z"),
    ]);
    const names = () => [...root.querySelectorAll(".variable-name")].map((n) => n.textContent);
    // Deliberately NOT reordered by name/createdAt -- keeps the given order.
    expect(names()).toEqual(["second", "first"]);
  });

  it("shows a -/+ stepper for number variables and a plain value for text (no inline form)", () => {
    const panel = new VariablesPanel(root, makeCallbacks());
    panel.setVariables([variable("kills", "4", "number"), variable("greeting", "hi", "text", "2026-01-02T00:00:00.000Z")]);
    // Full editing lives in the properties card, but quick -/+ stays in the list.
    expect(root.querySelectorAll(".variable-stepper")).toHaveLength(1);
    expect(root.querySelector(".variables-form")).toBeFalsy();
    const values = [...root.querySelectorAll(".variable-value")].map((v) => v.textContent);
    expect(values).toEqual(["4", "hi"]);
    expect(root.querySelector(".variable-value-text")?.textContent).toBe("hi");
  });

  it("the list -/+ buttons adjust a number variable and do not also select the row", () => {
    const onSet = vi.fn();
    const onSelect = vi.fn();
    const panel = new VariablesPanel(root, makeCallbacks({ onSet, onSelect }));
    panel.setVariables([variable("kills", "4", "number")]);
    const [minus, plus] = [...root.querySelectorAll(".variable-stepper .sidebar-icon-button")] as HTMLElement[];
    plus.click();
    expect(onSet).toHaveBeenLastCalledWith("kills", "number", "5");
    minus.click();
    minus.click();
    // Optimistic accumulation: 5 -> 4 -> 3 across rapid clicks.
    expect(onSet).toHaveBeenLastCalledWith("kills", "number", "3");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("upsertVariable adds/updates a row without a full setVariables call", () => {
    const panel = new VariablesPanel(root, makeCallbacks());
    panel.setVariables([variable("kills", "4")]);
    panel.upsertVariable(variable("kills", "5"));
    expect((root.querySelector(".variable-value") as HTMLElement).textContent).toBe("5");
  });

  it("removeVariable drops the row", () => {
    const panel = new VariablesPanel(root, makeCallbacks());
    panel.setVariables([variable("kills", "4")]);
    panel.removeVariable("kills");
    expect(root.querySelector(".variable-row")).toBeFalsy();
  });
});

describe("stable ordering (linked-list behavior)", () => {
  const names = () => [...document.querySelectorAll(".variable-name")].map((n) => n.textContent);

  it("upsert keeps an existing key in place; a new key appends at the bottom", () => {
    const panel = new VariablesPanel(root, makeCallbacks());
    panel.setVariables([variable("a", "1"), variable("b", "2"), variable("c", "3")]);
    panel.upsertVariable(variable("b", "99")); // edit in the middle
    expect(names()).toEqual(["a", "b", "c"]);
    panel.upsertVariable(variable("d", "0")); // new
    expect(names()).toEqual(["a", "b", "c", "d"]);
  });

  it("removing a middle row leaves a gap; the next new variable appends at the bottom", () => {
    const panel = new VariablesPanel(root, makeCallbacks());
    panel.setVariables([variable("a", "1"), variable("b", "2"), variable("c", "3")]);
    panel.removeVariable("b");
    expect(names()).toEqual(["a", "c"]);
    panel.upsertVariable(variable("new", "0"));
    expect(names()).toEqual(["a", "c", "new"]);
  });

  it("renameKey swaps the key in place, not moving the row to the bottom", () => {
    const panel = new VariablesPanel(root, makeCallbacks());
    panel.setVariables([variable("a", "1"), variable("b", "2"), variable("c", "3")]);
    panel.renameKey("b", "beta", variable("beta", "2"));
    expect(names()).toEqual(["a", "beta", "c"]);
  });

  it("a snapshot reconcile preserves existing order and appends new keys", () => {
    const panel = new VariablesPanel(root, makeCallbacks());
    panel.setVariables([variable("a", "1"), variable("b", "2")]);
    // Server sends the same set in a different order, plus a new key.
    panel.setVariables([variable("b", "2"), variable("z", "9"), variable("a", "1")]);
    expect(names()).toEqual(["a", "b", "z"]);
  });
});

describe("selection", () => {
  it("clicking a row selects the variable (does not expand anything in place)", () => {
    const onSelect = vi.fn();
    const panel = new VariablesPanel(root, makeCallbacks({ onSelect }));
    panel.setVariables([variable("kills", "4")]);
    (root.querySelector(".variable-row") as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: "kills", value: "4" }));
    // No inline form/expansion is rendered in the panel.
    expect(root.querySelector(".variables-form")).toBeFalsy();
    expect(root.querySelector("input")).toBeFalsy();
  });

  it("setSelectedKey highlights the matching row", () => {
    const panel = new VariablesPanel(root, makeCallbacks());
    panel.setVariables([variable("a", "1"), variable("b", "2", "number", "2026-01-02T00:00:00.000Z")]);
    panel.setSelectedKey("b");
    const rows = [...root.querySelectorAll(".variable-row")];
    expect(rows[0].classList.contains("selected")).toBe(false);
    expect(rows[1].classList.contains("selected")).toBe(true);
  });

  it("the '+' header button requests a new variable via onAdd", () => {
    const onAdd = vi.fn();
    const panel = new VariablesPanel(root, makeCallbacks({ onAdd }));
    (root.querySelector('[data-role="add"]') as HTMLElement).click();
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("nextNewVariableKey returns a non-colliding default name", () => {
    const panel = new VariablesPanel(root, makeCallbacks());
    expect(panel.nextNewVariableKey()).toBe("New Variable");
    panel.setVariables([variable("New Variable", "0"), variable("New Variable 2", "0", "number", "2026-01-02T00:00:00.000Z")]);
    expect(panel.nextNewVariableKey()).toBe("New Variable 3");
  });
});

describe("delete", () => {
  it("the row delete button calls onDelete and does not also select the row", () => {
    const onDelete = vi.fn();
    const onSelect = vi.fn();
    const panel = new VariablesPanel(root, makeCallbacks({ onDelete, onSelect }));
    panel.setVariables([variable("kills", "4")]);
    (root.querySelector(".variable-row .sidebar-icon-button") as HTMLElement).click();
    expect(onDelete).toHaveBeenCalledWith("kills");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
