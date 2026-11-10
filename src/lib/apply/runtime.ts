import "server-only";

import type { Page } from "playwright-core";

import { adapterOf, detectAts, type AtsAdapter } from "./ats";
import { FIELD_ATTRIBUTE, readFieldsInPage, type FormField } from "./fields";
import type { PlanEntry } from "./plan";

// What auto-apply does in the page: open the form, read it, fill it in,
// notice what only the user may do (captchas, sign-ins), and submit.

const NAVIGATION_TIMEOUT_MS = 30_000;
const SETTLE_MS = 5_000;

/** A file to upload: the tailored resume or cover letter as a PDF. */
export type UploadFile = { name: string; mimeType: string; buffer: Buffer };

/** Waits for the page to settle after a load or a click, without waiting forever for a busy one. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => {});
}

const has = (page: Page) => async (selector: string) => (await page.locator(selector).count().catch(() => 0)) > 0;

/** An element's attribute, or null at once when there's no such element (Playwright would wait for one). */
async function attribute(page: Page, selector: string, name: string): Promise<string | null> {
  const element = page.locator(selector).first();
  return (await element.count()) > 0 ? element.getAttribute(name) : null;
}

/** The first heading's text, or "" when there's none. */
async function heading(page: Page): Promise<string> {
  const element = page.locator("h1, h2, h3").first();
  return (await element.count()) > 0 ? element.innerText().catch(() => "") : "";
}

/**
 * Opens the posting or form at `url` and gets to the form itself: an ATS's
 * own form page, a Greenhouse form embedded in a company's site, or the
 * "Apply" button that shows it. Returns the ATS it found.
 */
export async function openForm(page: Page, url: string): Promise<AtsAdapter> {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  if (response && response.status() >= 400) throw new FormError(`The page answered ${response.status()}. Check the link.`);
  await settle(page);
  let adapter = await detectAts(new URL(page.url()), has(page));

  // A Greenhouse form embedded in the company's page: open the form itself.
  const embedded = await attribute(page, "iframe#grnhse_iframe", "src");
  if (embedded) {
    await page.goto(new URL(embedded, page.url()).toString(), { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    await settle(page);
    adapter = adapterOf("greenhouse");
  }

  const formUrl = adapter.formUrl?.(new URL(page.url()));
  if (formUrl && formUrl !== page.url()) {
    await page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    await settle(page);
  }

  if (adapter.openForm) {
    const button = page.locator(adapter.openForm).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      await settle(page);
    }
  }
  return adapter;
}

/** An error to show the user as it is. */
export class FormError extends Error {}

const CAPTCHA = [
  'iframe[src*="recaptcha/api2/bframe"]',
  'iframe[src*="recaptcha"][title*="challenge" i]',
  '.g-recaptcha:not([data-size="invisible"])',
  'iframe[src*="hcaptcha.com"][title*="challenge" i]',
  '.h-captcha:not([data-size="invisible"])',
  ".cf-turnstile",
  'iframe[src*="challenges.cloudflare.com"]',
  "[data-dossier-captcha]",
].join(", ");

/** What only the user may do on this page, or null: Dossier never solves a captcha or signs in to a site it has no account for. */
export async function blocker(page: Page, { accounts }: { accounts: boolean }): Promise<"captcha" | "sign-in" | null> {
  const visible = async (selector: string) => {
    const all = page.locator(selector);
    const count = await all.count().catch(() => 0);
    for (let index = 0; index < count; index++) if (await all.nth(index).isVisible().catch(() => false)) return true;
    return false;
  };
  if (await visible(CAPTCHA)) return "captcha";
  if (!accounts && (await visible('input[type="password"]'))) return "sign-in";
  return null;
}

/** The page's fields, read and marked so each can be found again. */
export async function readFields(page: Page): Promise<FormField[]> {
  return page.evaluate(readFieldsInPage, FIELD_ATTRIBUTE);
}

const fieldLocator = (page: Page, id: string) => page.locator(`[${FIELD_ATTRIBUTE}="${id}"]`);

/**
 * Puts one plan entry in its field. Returns why it couldn't, or null. Only
 * filled, document and drafted entries are put in: the rest stay empty for
 * the user.
 */
export async function fillEntry(page: Page, entry: PlanEntry, files: { resume: UploadFile | null; coverLetter: UploadFile | null }): Promise<string | null> {
  if (entry.status !== "filled" && entry.status !== "document" && entry.status !== "drafted") return null;
  const field = fieldLocator(page, entry.id);
  try {
    switch (entry.type) {
      case "file": {
        const file = files.resume?.name === entry.value ? files.resume : files.coverLetter?.name === entry.value ? files.coverLetter : null;
        if (!file) return "The file isn't there.";
        await field.first().setInputFiles(file);
        return null;
      }
      case "select":
        await field.first().selectOption({ label: entry.value });
        return null;
      case "radio": {
        const count = await field.count();
        for (let index = 0; index < count; index++) {
          const option = field.nth(index);
          const label = await option.evaluate((input: HTMLInputElement) =>
            (input.closest("label")?.textContent || document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent || input.value).replace(/\s+/g, " ").trim(),
          );
          if (label === entry.value) {
            await option.check();
            return null;
          }
        }
        return "None of its choices is there any more.";
      }
      case "checkbox":
        if (entry.value === "yes") await field.first().check();
        else await field.first().uncheck();
        return null;
      default:
        await field.first().fill(entry.value);
        // Autocomplete fields (a location) want a choice from their list; the first is the typed text's best match.
        const control = field.first();
        if ((await control.getAttribute("role")) === "combobox" || (await control.getAttribute("aria-autocomplete"))) {
          const option = page.locator('[role="option"]').first();
          if (await option.isVisible({ timeout: 1_500 }).catch(() => false)) await option.click();
        }
        return null;
    }
  } catch {
    return "Dossier couldn't put this in the form.";
  }
}

/** Fills in every entry; ones it couldn't fill become needs-you, with why. */
export async function fillPlan(page: Page, plan: PlanEntry[], files: { resume: UploadFile | null; coverLetter: UploadFile | null }): Promise<PlanEntry[]> {
  const filled: PlanEntry[] = [];
  for (const entry of plan) {
    const problem = await fillEntry(page, entry, files);
    filled.push(problem ? { ...entry, status: entry.required ? "needs-you" : "skipped", note: problem } : entry);
  }
  return filled;
}

export async function screenshot(page: Page): Promise<Buffer> {
  return page.screenshot({ fullPage: true, type: "png", timeout: 15_000 });
}

const CONFIRMED = /thank(s| you)[^.]{0,40}(appl(y|ying|ication)|interest|submitting)|application (has been |was )?(submitted|received|sent)|we('ve| have) received your application|successfully (applied|submitted)/i;
const CONFIRMED_URL = /confirmation|thank-?you|thanks|success|submitted/i;

export type SubmitOutcome =
  | { outcome: "submitted"; url: string }
  | { outcome: "captcha" }
  | { outcome: "errors"; errors: string[] }
  | { outcome: "unclear"; url: string };

/** Whether the page says the application went through. */
export async function confirmed(page: Page): Promise<boolean> {
  if (CONFIRMED_URL.test(new URL(page.url()).pathname)) return true;
  const text = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  return CONFIRMED.test(text);
}

/** The form's own error messages, for the user. */
async function formErrors(page: Page): Promise<string[]> {
  const errors = page.locator('[role="alert"], .error:not(:empty), .field-error, [data-automation-id="errorMessage"], [aria-invalid="true"]');
  const texts: string[] = [];
  const count = Math.min(await errors.count().catch(() => 0), 10);
  for (let index = 0; index < count; index++) {
    const item = errors.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const text = (await item.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const label = text || (await item.getAttribute("aria-label").catch(() => null)) || (await item.getAttribute("name").catch(() => null)) || "";
    if (label && !texts.includes(label)) texts.push(label);
  }
  if (texts.length > 0) return texts;
  // Else the fields the browser itself refuses, which show no message in the page.
  const invalid = await page
    .locator("form :invalid:not(form):not(fieldset)")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const control = element as HTMLInputElement;
        const label = (control.labels?.[0]?.textContent ?? control.getAttribute("aria-label") ?? control.name).replace(/\s+/g, " ").trim();
        return `${label}: ${control.validationMessage}`;
      }),
    )
    .catch(() => [] as string[]);
  for (const text of invalid.slice(0, 10)) if (!texts.includes(text)) texts.push(text);
  return texts;
}

/** Presses the form's submit button and waits to see what happened. */
export async function submitForm(page: Page, adapter: AtsAdapter): Promise<SubmitOutcome> {
  const button = page.locator(adapter.submit).filter({ visible: true }).first();
  if ((await button.count()) === 0) throw new FormError("Dossier can't find the form's submit button. Submit it yourself on the employer's site.");
  await button.click();
  // A confirmation page, a captcha, or the form's errors: whichever comes first.
  const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await settle(page);
    if (await confirmed(page)) return { outcome: "submitted", url: page.url() };
    if ((await blocker(page, { accounts: true })) === "captcha") return { outcome: "captcha" };
    const errors = await formErrors(page);
    if (errors.length > 0) return { outcome: "errors", errors };
    await page.waitForTimeout(1_000);
  }
  return { outcome: "unclear", url: page.url() };
}

/** Whether the submit button is on this page: the last page of a form spread over several. */
export async function atLastPage(page: Page, adapter: AtsAdapter): Promise<boolean> {
  if (!adapter.next) return true;
  return (await page.locator(adapter.submit).filter({ visible: true }).count()) > 0;
}

/** Goes to the next page of a form spread over several; returns its errors if it didn't. */
export async function nextPage(page: Page, adapter: AtsAdapter): Promise<string[]> {
  const before = page.url();
  const title = await heading(page);
  await page.locator(adapter.next!).filter({ visible: true }).first().click();
  await settle(page);
  if (page.url() !== before || (await heading(page)) !== title) return [];
  const errors = await formErrors(page);
  return errors.length > 0 ? errors : ["The form didn't go on to its next page."];
}
