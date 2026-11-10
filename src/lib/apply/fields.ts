// A form's fields as auto-apply reads them from the page, whatever the ATS.

export const FIELD_TYPES = ["text", "email", "tel", "url", "number", "date", "textarea", "select", "radio", "checkbox", "file"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export type FormField = {
  /** Marks the element (or a radio group's elements) as data-dossier-field="…". */
  id: string;
  label: string;
  type: FieldType;
  /** Its name, id or data-automation-id, for an adapter's known fields. */
  name: string;
  required: boolean;
  /** A select's or radio group's choices, as shown; a checkbox has none. */
  options: string[];
  /** What it holds now, e.g. a value the ATS filled in itself. */
  current: string;
};

/** The attribute that marks the fields read. */
export const FIELD_ATTRIBUTE = "data-dossier-field";

/**
 * Reads the visible fields of the page's forms, in page order, and marks
 * each with FIELD_ATTRIBUTE. Runs in the page (page.evaluate), so it uses
 * nothing from outside: plain DOM code without helpers.
 */
export function readFieldsInPage(attribute: string): FormField[] {
  const clean = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
  const visible = (element: Element) => {
    const html = element as HTMLElement;
    if (html.closest("[hidden], [aria-hidden='true']")) return false;
    const style = getComputedStyle(html);
    return style.display !== "none" && style.visibility !== "hidden" && html.getClientRects().length > 0;
  };
  // A label's own words, without the text of controls inside it (a select's options).
  const labelText = (label: Element) => {
    const copy = label.cloneNode(true) as Element;
    copy.querySelectorAll("select, textarea, input, option").forEach((node) => node.remove());
    return clean(copy.textContent);
  };
  const labelOf = (element: Element): string => {
    const control = element as HTMLInputElement;
    const labelled = control.getAttribute("aria-labelledby");
    if (labelled) {
      const text = labelled
        .split(/\s+/)
        .map((id) => clean(document.getElementById(id)?.textContent))
        .join(" ");
      if (clean(text)) return clean(text);
    }
    if (control.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
      if (forLabel && labelText(forLabel)) return labelText(forLabel);
    }
    const wrapping = control.closest("label");
    if (wrapping && labelText(wrapping)) return labelText(wrapping);
    const aria = control.getAttribute("aria-label");
    if (clean(aria)) return clean(aria);
    // A label-like element just before it in its container, as many ATS draw them.
    const container = control.parentElement?.closest("[data-automation-id], .field, .form-group, .application-question, li, div");
    // Only a container of this one control: a bigger one's label is another field's.
    const own = container && container.querySelectorAll("input:not([type='hidden']), select, textarea").length === 1 ? container : null;
    const heading = own?.querySelector("label, legend, [class*='label'], [data-automation-id*='label' i]");
    if (heading && labelText(heading)) return labelText(heading);
    return clean(control.getAttribute("placeholder")) || clean(control.getAttribute("name"));
  };
  const nameOf = (element: Element) =>
    element.getAttribute("name") || element.id || element.getAttribute("data-automation-id") || element.closest("[data-automation-id]")?.getAttribute("data-automation-id") || "";
  const requiredOf = (element: Element, label: string) =>
    (element as HTMLInputElement).required || element.getAttribute("aria-required") === "true" || /[*✱]\s*$|\(required\)/i.test(label);

  const fields: FormField[] = [];
  const radioGroups = new Map<string, FormField>();
  const controls = document.querySelectorAll("input, select, textarea");
  for (let index = 0; index < controls.length; index++) {
    const element = controls[index] as HTMLInputElement;
    const tag = element.tagName.toLowerCase();
    const kind = tag === "select" ? "select" : tag === "textarea" ? "textarea" : (element.type || "text").toLowerCase();
    if (["hidden", "submit", "button", "reset", "image", "password", "search"].includes(kind)) continue;
    if (element.disabled) continue;
    // File inputs are often hidden behind a styled button: keep them anyway.
    if (kind !== "file" && !visible(element)) continue;

    if (kind === "radio") {
      const group = element.name || `radio-${index}`;
      const optionLabel = clean(element.closest("label")?.textContent) || clean(document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent) || element.value;
      let field = radioGroups.get(group);
      if (!field) {
        const legend = clean(element.closest("fieldset")?.querySelector("legend")?.textContent);
        const groupLabel = legend || clean(element.closest("[role='radiogroup'], [role='group']")?.getAttribute("aria-label")) || clean(element.closest("[role='radiogroup'], [role='group']")?.querySelector("label, legend, [class*='label']")?.textContent) || group;
        field = { id: `f${fields.length}`, label: groupLabel, type: "radio", name: group, required: element.required || /\*\s*$/.test(groupLabel), options: [], current: "" };
        radioGroups.set(group, field);
        fields.push(field);
      }
      field.options.push(optionLabel);
      if (element.checked) field.current = optionLabel;
      element.setAttribute(attribute, field.id);
      continue;
    }

    const label = labelOf(element);
    const type = (["text", "email", "tel", "url", "number", "date", "textarea", "select", "checkbox", "file"].includes(kind) ? kind : "text") as FieldType;
    const options: string[] = [];
    if (type === "select") {
      const select = element as unknown as HTMLSelectElement;
      for (let option = 0; option < select.options.length; option++) {
        const item = select.options[option];
        // The "Select…" placeholder isn't a choice.
        if (item.value === "" && option === 0) continue;
        options.push(clean(item.textContent));
      }
    }
    const id = `f${fields.length}`;
    element.setAttribute(attribute, id);
    const current =
      type === "checkbox" ? (element.checked ? "yes" : "") : type === "select" ? clean((element as unknown as HTMLSelectElement).selectedOptions[0]?.textContent) : type === "file" ? (element.files?.length ? "attached" : "") : element.value;
    fields.push({ id, label, type, name: nameOf(element), required: requiredOf(element, label), options, current: type === "select" && (element as unknown as HTMLSelectElement).value === "" ? "" : current });
  }
  return fields;
}

/** A label without the marks forms add: "First name *" → "First name". */
export const plainLabel = (label: string) => label.replace(/\s*[*✱]\s*$/, "").replace(/\s*\((required|optional)\)\s*$/i, "").trim();
