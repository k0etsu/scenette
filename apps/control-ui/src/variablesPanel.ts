import { Variable, VariableType } from "@scenette/protocol";
import { ICON_EXPAND, ICON_MINUS, ICON_PLUS, ICON_TRASH } from "./icons";

export interface VariablesCallbacks {
  // Clicking a variable selects it and focuses it in the properties card
  // (the bottom half of the sidebar) -- full editing happens there.
  onSelect: (variable: Variable) => void;
  // The "+" header button instantly creates a new default variable.
  onAdd: () => void;
  onDelete: (key: string) => void;
  // Quick in-list -/+ adjust for number variables (upsert of the new value).
  onSet: (key: string, type: VariableType, value: string) => void;
}

// The variables LIST (upper sidebar). Just names + current values, selectable;
// all editing lives in the shared properties card (see Sidebar's variable
// card), so a click here never expands anything in place.
export class VariablesPanel {
  private variables = new Map<string, Variable>();
  private selectedKey?: string;
  private readonly list: HTMLElement;

  constructor(private readonly root: HTMLElement, private readonly callbacks: VariablesCallbacks) {
    root.innerHTML = `
      <div class="sidebar-header">
        <span class="sidebar-icon-button" data-role="expand">${ICON_EXPAND}</span>
        <span>variables</span>
        <button type="button" class="sidebar-icon-button" data-role="add">${ICON_PLUS}</button>
      </div>
      <div class="variables-list"></div>
    `;
    this.list = root.querySelector(".variables-list")!;

    root.querySelector('[data-role="add"]')!.addEventListener("click", () => this.callbacks.onAdd());
    const expandButton = root.querySelector<HTMLElement>('[data-role="expand"]')!;
    expandButton.addEventListener("click", () => {
      const collapsed = root.classList.toggle("panel-collapsed");
      expandButton.title = collapsed ? "Expand" : "Collapse";
    });
  }

  // Rows keep a stable insertion order (not sorted by name/createdAt), so
  // renaming or editing a variable never makes it jump position and a deleted
  // middle row leaves a gap that new variables append past -- see renderList,
  // which iterates this Map in insertion order. Reconciled against each
  // snapshot so existing keys keep their slot and only genuinely-new keys are
  // appended (server map order is not guaranteed stable across snapshots).
  setVariables(variables: Variable[]): void {
    const incoming = new Map(variables.map((v) => [v.key, v]));
    const next = new Map<string, Variable>();
    for (const key of this.variables.keys()) {
      const v = incoming.get(key);
      if (v) next.set(key, v); // keep known keys in their current position
    }
    for (const v of variables) {
      if (!next.has(v.key)) next.set(v.key, v); // append new keys at the bottom
    }
    this.variables = next;
    if (this.selectedKey && !this.variables.has(this.selectedKey)) this.selectedKey = undefined;
    this.renderList();
  }

  // Map.set keeps an existing key's position (updating its value in place) and
  // appends a genuinely new key -- exactly the wanted linked-list behavior.
  upsertVariable(variable: Variable): void {
    this.variables.set(variable.key, variable);
    this.renderList();
  }

  removeVariable(key: string): void {
    this.variables.delete(key);
    if (this.selectedKey === key) this.selectedKey = undefined;
    this.renderList();
  }

  // Rename in place: swap the key at its current position rather than
  // delete-then-append (which would move the row to the bottom).
  renameKey(oldKey: string, newKey: string, variable: Variable): void {
    if (!this.variables.has(oldKey)) {
      this.variables.set(newKey, variable);
    } else {
      const next = new Map<string, Variable>();
      for (const [key, v] of this.variables) {
        if (key === oldKey) next.set(newKey, variable);
        else next.set(key, v);
      }
      this.variables = next;
    }
    if (this.selectedKey === oldKey) this.selectedKey = newKey;
    this.renderList();
  }

  // Which row to highlight -- driven by the shared selection (cleared when an
  // asset is selected instead). Set by main.ts, kept in sync with the card.
  setSelectedKey(key: string | undefined): void {
    this.selectedKey = key;
    this.renderList();
  }

  get(key: string): Variable | undefined {
    return this.variables.get(key);
  }

  // A non-colliding default key for an instant "+"-created variable:
  // "New Variable", then "New Variable 2", "New Variable 3", ...
  nextNewVariableKey(): string {
    const base = "New Variable";
    if (!this.variables.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base} ${n}`;
      if (!this.variables.has(candidate)) return candidate;
    }
  }

  private renderList(): void {
    this.list.innerHTML = "";
    // Insertion order (the Map's natural iteration order) -- deliberately not
    // sorted, so positions stay stable across renames/edits/deletes.
    for (const variable of this.variables.values()) {
      const row = document.createElement("div");
      row.className = "variable-row" + (variable.key === this.selectedKey ? " selected" : "");

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "sidebar-icon-button";
      deleteButton.innerHTML = ICON_TRASH;
      deleteButton.title = "Delete";
      deleteButton.addEventListener("click", (event) => {
        // Don't also select the row we're deleting.
        event.stopPropagation();
        this.callbacks.onDelete(variable.key);
      });

      const name = document.createElement("span");
      name.className = "variable-name";
      name.textContent = variable.key;

      row.append(deleteButton, name);
      row.addEventListener("click", () => this.callbacks.onSelect(variable));

      if (variable.type === "number") {
        // Quick -/+ adjust without opening the card. Optimistically advance the
        // stored value so rapid clicks accumulate (rather than all computing off
        // the same pre-round-trip value), and stop propagation so the click
        // doesn't also select/focus the row.
        const stepper = document.createElement("div");
        stepper.className = "variable-stepper";

        const value = document.createElement("span");
        value.className = "variable-value";
        value.textContent = variable.value;

        const adjust = (delta: number) => {
          const current = this.variables.get(variable.key);
          if (!current) return;
          const next = String((Number(current.value) || 0) + delta);
          this.variables.set(variable.key, { ...current, value: next });
          value.textContent = next;
          this.callbacks.onSet(variable.key, "number", next);
        };

        const minus = document.createElement("button");
        minus.type = "button";
        minus.className = "sidebar-icon-button";
        minus.innerHTML = ICON_MINUS;
        minus.addEventListener("click", (e) => {
          e.stopPropagation();
          adjust(-1);
        });

        const plus = document.createElement("button");
        plus.type = "button";
        plus.className = "sidebar-icon-button";
        plus.innerHTML = ICON_PLUS;
        plus.addEventListener("click", (e) => {
          e.stopPropagation();
          adjust(1);
        });

        stepper.append(minus, value, plus);
        row.appendChild(stepper);
      } else {
        const value = document.createElement("span");
        value.className = "variable-value variable-value-text";
        value.textContent = variable.value;
        row.appendChild(value);
      }

      this.list.appendChild(row);
    }
  }
}
