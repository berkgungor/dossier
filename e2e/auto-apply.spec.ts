import { expect, test, type Page } from "@playwright/test";

import { FAKE_JOBS_PORT, fakeAtsSubmissions, resetData, resetFakeAts, sql } from "./support";

// Auto-apply: the Ledgerly draft is applied for on the fake ATS forms
// (e2e/fake-ats.mts), never a real employer's site. Dossier fills each form
// in, stops for review, and submits once approved.

const FORMS = `http://localhost:${FAKE_JOBS_PORT}/ats`;
const ANSWERS = {
  authorized: "yes",
  sponsorship: "no",
  over18: "yes",
  noticePeriod: "Two weeks",
  postalCode: "10001",
  howDidYouHear: "Company Website",
  gender: "decline",
  race: "decline",
  veteran: "decline",
  consent: "yes",
};

let applicationId = "";

async function setAnswers(answers: Record<string, unknown>, autoSubmit = false) {
  await sql(`DELETE FROM "Setting" WHERE key IN ('applyAnswers', 'applyAutoSubmit')`);
  await sql(`INSERT INTO "Setting" (key, value, "updatedAt") VALUES ('applyAnswers', $1, now()), ('applyAutoSubmit', $2, now())`, [JSON.stringify(answers), String(autoSubmit)]);
}

/** Opens Auto-apply from the application's page and fills in the form at `path`. */
async function fillIn(page: Page, path: string) {
  await page.goto(`/applications/${applicationId}`);
  await page.getByRole("link", { name: "Auto-apply" }).click();
  await expect(page.getByRole("heading", { name: "Auto-apply", level: 1 })).toBeVisible();
  await page.getByLabel("Application form link").fill(`${FORMS}${path}`);
  await page.getByRole("button", { name: /^Fill in/ }).click();
}

const row = (page: Page, label: string | RegExp) => page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: label }) });

test.beforeAll(async () => {
  await resetData();
  [{ id: applicationId }] = await sql<{ id: string }>(`SELECT id FROM "Application" WHERE company = 'Ledgerly' LIMIT 1`);
});

test.beforeEach(async () => {
  await resetFakeAts();
  await setAnswers(ANSWERS);
});

test("fills in a Greenhouse form, stops for review and submits on approval", async ({ page }) => {
  await fillIn(page, "/greenhouse/acme/jobs/101");
  await expect(page.getByRole("heading", { name: "Greenhouse form" })).toBeVisible({ timeout: 45_000 });

  await expect(row(page, "First Name (required)").getByRole("textbox")).toHaveValue("Jane");
  await expect(row(page, "Resume/CV (required)")).toContainText("Attached");
  await expect(row(page, /authorized to work in the United States/).getByRole("combobox")).toHaveValue("Yes");
  await expect(row(page, /sponsorship/).getByRole("combobox")).toHaveValue("No");
  await expect(row(page, "Gender")).toContainText("Filled in");
  await expect(row(page, /Why do you want to work at Acme/)).toContainText("Drafted by AI: check it");
  await expect(page.getByRole("img", { name: "The form as Dossier filled it in" })).toBeVisible();
  // Nothing goes out before the review.
  expect(await fakeAtsSubmissions()).toEqual([]);

  await page.getByRole("button", { name: "Submit application" }).click();
  await expect(page.getByRole("heading", { name: "Submitted" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/Confirmation page:.*\/confirmation/)).toBeVisible();
  await expect(page.getByRole("img", { name: "The page after submitting" })).toBeVisible();

  const [sent] = await fakeAtsSubmissions();
  expect(sent.form).toBe("/ats/greenhouse/acme/jobs/101");
  expect(sent.body).toContain("jane.doe@example.com");
  expect(sent.body).toMatch(/filename="[^"]*Resume\.pdf"/);
  const [{ status }] = await sql<{ status: string }>(`SELECT status FROM "Application" WHERE id = $1`, [applicationId]);
  expect(status).toBe("SENT");
});

test("reads a form no adapter knows and asks for what the profile can't answer", async ({ page }) => {
  await fillIn(page, "/careers/acme/apply");
  const licence = row(page, /driver's license/);
  await expect(licence).toContainText("Needs you", { timeout: 45_000 });
  await expect(row(page, /marketing campaign/)).toContainText("Drafted by AI");
  await expect(page.getByRole("button", { name: "Submit application" })).toBeDisabled();

  await licence.getByRole("combobox").selectOption("Yes");
  await licence.getByLabel("Save to my answers").check();
  await page.getByRole("button", { name: "Put my answers in the form" }).click();
  await expect(licence).toContainText("You entered this");

  await page.getByRole("button", { name: "Submit application" }).click();
  await expect(page.getByRole("heading", { name: "Submitted" })).toBeVisible({ timeout: 45_000 });
  expect((await fakeAtsSubmissions())[0].body).toMatch(/name="licence"\r\n\r\nYes/);

  // The saved answer is in Settings → Auto-apply.
  await page.goto("/settings?section=apply");
  await expect(page.getByText("Do you hold a valid driver's license?")).toBeVisible();
});

test("submits a Lever form without review when every answer came from the profile", async ({ page }) => {
  await setAnswers(ANSWERS, true);
  await fillIn(page, "/lever/acme/202/apply");
  await expect(page.getByRole("heading", { name: "Submitted without review" })).toBeVisible({ timeout: 45_000 });
  expect((await fakeAtsSubmissions())[0].form).toBe("/ats/lever/acme/202/apply");
});

test("makes a Workday account and goes through its pages", async ({ page }) => {
  await fillIn(page, "/workday/acme/job/404");
  await expect(page.getByRole("heading", { name: "Workday form · best effort" })).toBeVisible({ timeout: 45_000 });
  await expect(row(page, "Postal Code (required)").getByRole("textbox")).toHaveValue("10001");
  await expect(row(page, "How did you hear about us? (required)")).toContainText("Filled in");
  await page.getByRole("button", { name: "Submit application" }).click();
  await expect(page.getByRole("heading", { name: "Submitted" })).toBeVisible({ timeout: 45_000 });
  expect((await fakeAtsSubmissions()).map((submission) => submission.form)).toEqual(["workday-step-1", "workday-step-2", "workday-step-3", "workday"]);
});

test("stops at a captcha and never solves it", async ({ page }) => {
  await fillIn(page, "/greenhouse/captcha/jobs/1");
  await expect(page.getByRole("alert").filter({ hasText: "Dossier never solves captchas" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("button", { name: "Submit application" })).toHaveCount(0);
  await page.getByRole("button", { name: "I submitted it myself" }).click();
  await expect(page.getByRole("heading", { name: "Submitted" })).toBeVisible();
  expect(await fakeAtsSubmissions()).toEqual([]);
});

test("doesn't fill in LinkedIn's Easy Apply", async ({ page }) => {
  await page.goto(`/applications/${applicationId}/apply`);
  await page.getByLabel("Application form link").fill("https://www.linkedin.com/jobs/view/123");
  await page.getByRole("button", { name: /^Fill in/ }).click();
  await expect(page.getByText(/doesn't fill in LinkedIn's Easy Apply/)).toBeVisible();
});

test("keeps the answer bank in Settings → Auto-apply", async ({ page }) => {
  await setAnswers({});
  await page.goto("/settings?section=apply");
  await page.getByLabel("Are you authorized to work where you apply?").selectOption("yes");
  await page.getByLabel("ZIP code").fill("94107");
  await page.getByLabel("Veteran status").selectOption({ label: "Decline to self-identify" });
  await page.getByRole("switch", { name: "Submit without review" }).click();
  await expect
    .poll(async () => (await sql<{ value: string }>(`SELECT value FROM "Setting" WHERE key = 'applyAnswers'`))[0]?.value ?? "")
    .toContain('"postalCode":"94107"');
  const [{ value }] = await sql<{ value: string }>(`SELECT value FROM "Setting" WHERE key = 'applyAnswers'`);
  expect(JSON.parse(value)).toMatchObject({ authorized: "yes", veteran: "decline" });
  await expect.poll(async () => (await sql<{ value: string }>(`SELECT value FROM "Setting" WHERE key = 'applyAutoSubmit'`))[0]?.value).toBe("true");
});
