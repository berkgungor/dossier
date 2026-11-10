import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FIELD_ATTRIBUTE, plainLabel, readFieldsInPage } from "./fields";

// readFieldsInPage() runs in the employer's page; here in jsdom, which has no
// layout, so every element gets a box unless it's display: none.
beforeEach(() => {
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    return (getComputedStyle(this).display === "none" ? [] : [{}]) as unknown as DOMRectList;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("readFieldsInPage", () => {
  it("reads each field's label, type, requirement and choices, and marks it", () => {
    document.body.innerHTML = `
      <form>
        <label for="first">First name *</label><input id="first" name="first_name">
        <label>Email<input type="email" name="email" required value="jane@example.com"></label>
        <label>Gender<select name="gender"><option value="">Select…</option><option>Female</option><option>Decline to self-identify</option></select></label>
        <span id="why-label">Why us?</span><textarea aria-labelledby="why-label" aria-required="true"></textarea>
        <input aria-label="Phone" type="tel">
        <div class="field"><span class="label">Postal code</span><input data-automation-id="postal"></div>
        <input placeholder="Website" type="url">
        <fieldset><legend>Relocate?</legend>
          <label><input type="radio" name="relocate" value="y" required> Yes</label>
          <label><input type="radio" name="relocate" value="n" checked> No</label>
        </fieldset>
        <label><input type="checkbox" name="consent" checked> I agree</label>
        <input type="file" name="resume" style="display:none">
        <input type="hidden" name="token"><input type="password"><input disabled name="off"><input name="gone" style="display:none">
        <button type="submit">Send</button>
      </form>`;
    const fields = readFieldsInPage(FIELD_ATTRIBUTE);
    expect(fields.map(({ label, type, required }) => [label, type, required])).toEqual([
      ["First name *", "text", true],
      ["Email", "email", true],
      ["Gender", "select", false],
      ["Why us?", "textarea", true],
      ["Phone", "tel", false],
      ["Postal code", "text", false],
      ["Website", "url", false],
      ["Relocate?", "radio", true],
      ["I agree", "checkbox", false],
      ["resume", "file", false],
    ]);
    expect(fields[1].current).toBe("jane@example.com");
    expect(fields[2].options).toEqual(["Female", "Decline to self-identify"]);
    expect(fields[5].name).toBe("postal");
    expect(fields[7]).toMatchObject({ options: ["Yes", "No"], current: "No" });
    expect(fields[8].current).toBe("yes");
    // Both radio buttons carry their group's mark.
    expect(document.querySelectorAll(`[${FIELD_ATTRIBUTE}="${fields[7].id}"]`)).toHaveLength(2);
    expect(document.querySelector(`[${FIELD_ATTRIBUTE}="${fields[0].id}"]`)?.id).toBe("first");
  });

  it("leaves a label to its own field when a container holds several", () => {
    document.body.innerHTML = `<div><label>Name</label><input name="a"><input name="b"></div>`;
    expect(readFieldsInPage(FIELD_ATTRIBUTE).map((field) => field.label)).toEqual(["a", "b"]);
  });
});

describe("plainLabel", () => {
  it("drops the marks forms add", () => {
    expect(plainLabel("First name *")).toBe("First name");
    expect(plainLabel("Resume/CV ✱")).toBe("Resume/CV");
    expect(plainLabel("Portfolio (optional)")).toBe("Portfolio");
  });
});
