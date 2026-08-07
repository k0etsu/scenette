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

  it("shows the current value for number and text variables (no inline stepper/form)", () => {
    const panel = new VariablesPanel(root, makeCallbacks());
    panel.setVariables([variable("kills", "4", "number"), variable("greeting", "hi", "text", "2026-01-02T00:00:00.000Z")]);
    // Editing now lives in the properties card -- the list is display-only.
    expect(root.querySelector(".variable-stepper")).toBeFalsy();
    expect(root.querySelector(".variables-form")).toBeFalsy();
    const values = [...root.querySelectorAll(".variable-value")].map((v) => v.textContent);
    expect(values).toEqual(["4", "hi"]);
    expect(root.querySelector(".variable-value-text")?.textContent).toBe("hi");
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
