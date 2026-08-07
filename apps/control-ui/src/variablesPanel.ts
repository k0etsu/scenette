import { Variable } from "@scenette/protocol";
import { ICON_EXPAND, ICON_PLUS, ICON_TRASH } from "./icons";

export interface VariablesCallbacks {
  // Clicking a variable selects it and focuses it in the properties card
  // (the bottom half of the sidebar) -- editing happens there, not inline.
  onSelect: (variable: Variable) => void;
  // The "+" header button -- opens a blank variable form in the properties card.
  onAdd: () => void;
  onDelete: (key: string) => void;
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

  setVariables(variables: Variable[]): void {
    this.variables = new Map(variables.map((v) => [v.key, v]));
    if (this.selectedKey && !this.variables.has(this.selectedKey)) this.selectedKey = undefined;
    this.renderList();
  }

  upsertVariable(variable: Variable): void {
    this.variables.set(variable.key, variable);
    this.renderList();
  }

  removeVariable(key: string): void {
    this.variables.delete(key);
    if (this.selectedKey === key) this.selectedKey = undefined;
    this.renderList();
  }

  // Which row to highlight -- driven by the shared selection (cleared when an
  // asset is selected instead). Set by main.ts, kept in sync with the card.
  setSelectedKey(key: string | undefined): void {
    this.selectedKey = key;
    this.renderList();
  }

  private renderList(): void {
    this.list.innerHTML = "";
    const sorted = [...this.variables.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const variable of sorted) {
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

      const value = document.createElement("span");
      value.className = "variable-value" + (variable.type === "text" ? " variable-value-text" : "");
      value.textContent = variable.value;

      row.append(deleteButton, name, value);
      row.addEventListener("click", () => this.callbacks.onSelect(variable));
      this.list.appendChild(row);
    }
  }
}
