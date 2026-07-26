import { Variable, VariableType } from "@scenette/protocol";
import { ICON_EXPAND, ICON_MINUS, ICON_PLUS, ICON_TRASH } from "./icons";

export interface VariablesCallbacks {
  // Upsert -- covers both creating a new variable and editing/incrementing
  // an existing one's value (key is immutable once created).
  onSet: (key: string, type: VariableType, value: string) => void;
  onDelete: (key: string) => void;
}

export class VariablesPanel {
  private variables = new Map<string, Variable>();
  private readonly list: HTMLElement;
  private readonly form: HTMLElement;

  constructor(private readonly root: HTMLElement, private readonly callbacks: VariablesCallbacks) {
    root.innerHTML = `
      <div class="sidebar-header">
        <span class="sidebar-icon-button" data-role="expand">${ICON_EXPAND}</span>
        <span>variables</span>
        <button type="button" class="sidebar-icon-button" data-role="add">${ICON_PLUS}</button>
      </div>
      <div class="variables-list"></div>
      <div class="variables-form" style="display: none"></div>
    `;
    this.list = root.querySelector(".variables-list")!;
    this.form = root.querySelector(".variables-form")!;

    root.querySelector('[data-role="add"]')!.addEventListener("click", () => this.openForm());
    const expandButton = root.querySelector<HTMLElement>('[data-role="expand"]')!;
    expandButton.addEventListener("click", () => {
      const collapsed = root.classList.toggle("panel-collapsed");
      expandButton.title = collapsed ? "Expand" : "Collapse";
    });
  }

  setVariables(variables: Variable[]): void {
    this.variables = new Map(variables.map((v) => [v.key, v]));
    this.renderList();
  }

  upsertVariable(variable: Variable): void {
    this.variables.set(variable.key, variable);
    this.renderList();
  }

  removeVariable(key: string): void {
    this.variables.delete(key);
    this.renderList();
    if (this.form.dataset.editingKey === key) this.closeForm();
  }

  private renderList(): void {
    this.list.innerHTML = "";
    const sorted = [...this.variables.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const variable of sorted) {
      const row = document.createElement("div");
      row.className = "variable-row";

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "sidebar-icon-button";
      deleteButton.innerHTML = ICON_TRASH;
      deleteButton.title = "Delete";
      deleteButton.addEventListener("click", () => this.callbacks.onDelete(variable.key));

      const name = document.createElement("span");
      name.className = "variable-name";
      name.textContent = variable.key;
      name.title = "Click to edit";
      name.addEventListener("click", () => this.openForm(variable));

      row.append(deleteButton, name);

      if (variable.type === "number") {
        const stepper = document.createElement("div");
        stepper.className = "variable-stepper";

        const minus = document.createElement("button");
        minus.type = "button";
        minus.className = "sidebar-icon-button";
        minus.innerHTML = ICON_MINUS;
        minus.addEventListener("click", () => {
          const current = this.variables.get(variable.key);
          if (current) this.callbacks.onSet(current.key, "number", String((Number(current.value) || 0) - 1));
        });

        const value = document.createElement("span");
        value.className = "variable-value";
        value.textContent = variable.value;

        const plus = document.createElement("button");
        plus.type = "button";
        plus.className = "sidebar-icon-button";
        plus.innerHTML = ICON_PLUS;
        plus.addEventListener("click", () => {
          const current = this.variables.get(variable.key);
          if (current) this.callbacks.onSet(current.key, "number", String((Number(current.value) || 0) + 1));
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

  private openForm(existing?: Variable): void {
    this.form.dataset.editingKey = existing?.key ?? "";
    this.form.style.display = "block";
    this.form.innerHTML = `
      <label class="prop-label">variable key:</label>
      <input type="text" data-role="key" value="${escapeHtml(existing?.key ?? "")}" ${existing ? "disabled" : ""} />
      <label class="prop-label">value:</label>
      <input data-role="value" value="${escapeHtml(existing?.value ?? "0")}" />
      <label class="prop-label">type:
        <select data-role="type">
          <option value="number">number</option>
          <option value="text">text</option>
        </select>
      </label>
      <p class="variables-help">Variables let you keep around common numbers or text to adjust quickly! Use them in Text objects by wrapping the variable key in curly braces, like this: <code>{variable}</code></p>
      <p class="variables-help">Future API endpoints will allow for powerful integrations.</p>
      <div class="properties-buttons">
        <button type="button" data-role="save">Save</button>
        <button type="button" data-role="cancel">Cancel</button>
      </div>
    `;

    const keyInput = this.form.querySelector<HTMLInputElement>('[data-role="key"]')!;
    const valueInput = this.form.querySelector<HTMLInputElement>('[data-role="value"]')!;
    const typeSelect = this.form.querySelector<HTMLSelectElement>('[data-role="type"]')!;
    typeSelect.value = existing?.type ?? "number";
    valueInput.type = typeSelect.value === "number" ? "number" : "text";
    typeSelect.addEventListener("change", () => {
      valueInput.type = typeSelect.value === "number" ? "number" : "text";
    });

    this.form.querySelector('[data-role="save"]')!.addEventListener("click", () => {
      const key = existing ? existing.key : keyInput.value.trim();
      if (!key) return;
      this.callbacks.onSet(key, typeSelect.value as VariableType, valueInput.value);
      this.closeForm();
    });
    this.form.querySelector('[data-role="cancel"]')!.addEventListener("click", () => this.closeForm());
  }

  private closeForm(): void {
    delete this.form.dataset.editingKey;
    this.form.style.display = "none";
    this.form.innerHTML = "";
  }
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}
