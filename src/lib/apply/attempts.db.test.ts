import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { serveAts, submissions } from "../../../e2e/fake-ats.mts";
import { createTestClient, resetDatabase } from "@/test/db";

// Auto-apply end to end in headless Chromium, against the fake ATS forms
// (e2e/fake-ats.mts) on a local server: detect, fill, stop for review,
// submit, record. The AI and the PDFs are stand-ins.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
const testEnv = vi.hoisted(() => ({ DOSSIER_SECRET: "s".repeat(40), DOSSIER_APPLY_TEST_ORIGINS: "", DOSSIER_DATA_DIR: "/tmp" }));
vi.mock("@/lib/env", () => ({ env: testEnv }));
vi.mock("@/lib/pdf/render", () => ({ renderPdf: async () => new TextEncoder().encode("%PDF-1.4 fake") }));
vi.mock("@/lib/google/account", () => ({ googleConnection: async () => ({ status: "not-configured" }) }));
const ai = vi.hoisted(() => ({ asked: [] as string[][] }));
vi.mock("@/lib/ai/config", () => ({ isAiUsable: async () => true }));
vi.mock("@/lib/ai", async () => {
  const { MockProvider } = await import("@/lib/ai/providers/mock");
  return {
    getAiProvider: async () =>
      new MockProvider({
        reply: (call) => {
          const fields = JSON.parse(call.messages[0].content.split("The fields:\n")[1]) as { id: string; label: string }[];
          ai.asked.push(fields.map((field) => field.label));
          return {
            answers: fields.map((field) =>
              /why|tell us/i.test(field.label)
                ? { id: field.id, answer: "I enjoy building campaigns with a product team.", note: "From your experience" }
                : { id: field.id, answer: null, note: "Your profile doesn't say" },
            ),
          };
        },
      }),
  };
});
const jobs = vi.hoisted(() => ({ started: [] as { type: string; input: unknown }[] }));
vi.mock("@/lib/jobs/runner", () => ({
  defineJob: <T,>(definition: T) => definition,
  startJob: async (definition: { type: string }, input: unknown) => {
    jobs.started.push({ type: definition.type, input });
    return `job-${jobs.started.length}`;
  },
}));

const { cancelAttempt, continueAttempt, fillFormJob, markAttemptSubmitted, recoverInterruptedAttempts, setAttemptAnswers, startAutoApply, submitAttempt, submitFormJob, applyUrlFor, APPLY_MESSAGES } = await import("./attempts");
const { closeAllSessions } = await import("./browser");
const { saveSettings, loadSettings } = await import("@/lib/settings-data");
const { EMPTY_ANSWERS } = await import("./answers");

const prisma = () => db.client!;
const context = { id: "job", step: async () => {}, signal: new AbortController().signal };
let server: Server;
let origin = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    if (!serveAts(request, response)) response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  testEnv.DOSSIER_APPLY_TEST_ORIGINS = origin;
});

afterAll(async () => {
  await closeAllSessions();
  // The shared browser: closed so the test process can end.
  const state = (globalThis as { applyBrowser?: { browser: Promise<{ close: () => Promise<void> }> | null } }).applyBrowser;
  await (await state?.browser)?.close();
  server.close();
});

const units = (texts: Record<string, string>) => Object.entries(texts).map(([id, text]) => ({ id, label: id, text }));

beforeEach(async () => {
  await resetDatabase(prisma());
  submissions.length = 0;
  jobs.started = [];
  ai.asked = [];
  await prisma().profileField.createMany({
    data: [
      { key: "name", value: "Jane Doe" },
      { key: "email", value: "jane.doe@example.com" },
      { key: "phone", value: "+1 212 555 0100" },
      { key: "city", value: "New York" },
      { key: "country", value: "United States" },
      { key: "linkedin", value: "linkedin.com/in/janedoe" },
    ],
  });
  await prisma().application.create({
    data: {
      id: "app",
      company: "Acme",
      role: "Marketing Manager",
      postingText: "Acme is hiring a Marketing Manager in New York.",
      documents: {
        create: [
          { kind: "RESUME", units: units({ summary: "Marketing manager." }) },
          { kind: "COVER_LETTER", units: units({ greeting: "Dear Acme team,", "paragraph:1": "I'd like to lead your campaigns.", "sign-off": "Best regards," }) },
        ],
      },
    },
  });
  await saveSettings({
    applyAnswers: { ...EMPTY_ANSWERS, authorized: "yes", sponsorship: "no", over18: "yes", noticePeriod: "Two weeks", gender: "decline", race: "decline", veteran: "decline", postalCode: "10001", howDidYouHear: "Company Website", consent: "yes" },
  });
});

/** Starts an attempt at a fake form and fills it in, as its job would. */
async function fillIn(path: string) {
  const { attemptId } = await startAutoApply("app", `${origin}${path}`);
  await fillFormJob.run({ attemptId, resume: false }, context);
  const attempt = await prisma().applyAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  const plan = (attempt.plan ?? []) as { label: string; value: string; status: string; page: number; id: string }[];
  return { attemptId, attempt, plan, entry: (label: string) => plan.find((item) => item.label === label) };
}

async function submit(attemptId: string) {
  await submitAttempt(attemptId);
  await submitFormJob.run({ attemptId }, context);
  return prisma().applyAttempt.findUniqueOrThrow({ where: { id: attemptId } });
}

describe("auto-apply", { timeout: 60_000 }, () => {
  it("fills in a Greenhouse form, stops for review, and submits on approval", async () => {
    const { attemptId, attempt, entry } = await fillIn("/ats/greenhouse/acme/jobs/101");
    expect(attempt).toMatchObject({ status: "REVIEW", ats: "greenhouse" });
    expect(attempt.screenshot?.length).toBeGreaterThan(1000);
    expect(entry("First Name")).toMatchObject({ value: "Jane", status: "filled" });
    expect(entry("Last Name")).toMatchObject({ value: "Doe" });
    expect(entry("Resume/CV")).toMatchObject({ value: "Jane Doe – Acme – Resume.pdf", status: "document" });
    expect(entry("Are you legally authorized to work in the United States?")).toMatchObject({ value: "Yes" });
    expect(entry("Will you now or in the future require sponsorship for employment visa status (e.g. H-1B)?")).toMatchObject({ value: "No" });
    expect(entry("Gender")).toMatchObject({ value: "Decline To Self Identify" });
    expect(entry("Are you Hispanic/Latino?")).toMatchObject({ value: "Decline To Self Identify" });
    expect(entry("Veteran Status")).toMatchObject({ value: "I don't wish to answer" });
    expect(entry("Why do you want to work at Acme?")).toMatchObject({ status: "drafted" });
    // Nothing was sent before the review.
    expect(submissions).toHaveLength(0);

    const submitted = await submit(attemptId);
    expect(submitted).toMatchObject({ status: "SUBMITTED", autoSubmitted: false });
    expect(submitted.confirmationUrl).toContain("/confirmation");
    expect(submitted.submittedAt).toBeInstanceOf(Date);
    const [sent] = submissions;
    expect(sent.body).toContain("jane.doe@example.com");
    expect(sent.body).toContain('filename="Jane Doe – Acme – Resume.pdf"');
    expect(sent.body).toContain("I enjoy building campaigns");
    expect(await prisma().application.findUniqueOrThrow({ where: { id: "app" } })).toMatchObject({ status: "SENT" });
  });

  it("reads a form no adapter knows, asks the AI, and leaves what it can't answer to the user", async () => {
    const { attemptId, attempt, entry } = await fillIn("/ats/careers/acme/apply");
    expect(attempt).toMatchObject({ status: "REVIEW", ats: "generic" });
    expect(entry("Your name")).toMatchObject({ value: "Jane Doe" });
    expect(entry("Upload your CV")).toMatchObject({ status: "document" });
    expect(entry("Tell us about a marketing campaign you're proud of")).toMatchObject({ status: "drafted" });
    const licence = entry("Do you hold a valid driver's license?")!;
    expect(licence).toMatchObject({ status: "needs-you", value: "" });
    await expect(submitAttempt(attemptId)).rejects.toThrow("driver's license");

    await setAttemptAnswers(attemptId, [{ id: licence.id, value: "Yes", save: true }]);
    expect((await loadSettings()).applyAnswers.custom).toEqual([{ question: "Do you hold a valid driver's license?", answer: "Yes" }]);
    expect(await submit(attemptId)).toMatchObject({ status: "SUBMITTED" });
    expect(submissions[0].body).toMatch(/name="licence"\r\n\r\nYes/);
  });

  it("submits without review only when everything came from the profile and the answers", async () => {
    await saveSettings({ applyAutoSubmit: true });
    const { attempt, entry } = await fillIn("/ats/lever/acme/202/apply");
    expect(entry("What is your notice period?")).toMatchObject({ value: "Two weeks", status: "filled" });
    expect(entry("Additional information")).toMatchObject({ status: "document" });
    expect(ai.asked).toEqual([]);
    expect(attempt).toMatchObject({ status: "SUBMITTED", autoSubmitted: true });
    expect(submissions[0].body).toContain("Dear Acme team,");

    // A drafted answer still stops for review.
    const greenhouse = await fillIn("/ats/greenhouse/acme/jobs/101");
    expect(greenhouse.attempt.status).toBe("REVIEW");
  });

  it("knows Ashby's form, which confirms without leaving the page", async () => {
    const { attemptId, attempt, entry } = await fillIn("/ats/ashby/acme/303/application");
    expect(attempt.ats).toBe("ashby");
    expect(entry("Are you willing to relocate?")).toMatchObject({ status: "needs-you" });
    await setAttemptAnswers(attemptId, [{ id: entry("Are you willing to relocate?")!.id, value: "Yes", save: false }]);
    expect(await submit(attemptId)).toMatchObject({ status: "SUBMITTED" });
    expect(submissions[0].body).toContain("relocate_q=yes");
  });

  it("stops for a captcha and never solves it", async () => {
    const { attemptId, attempt } = await fillIn("/ats/greenhouse/captcha/jobs/1");
    expect(attempt.status).toBe("NEEDS_YOU");
    expect(attempt.message).toContain("Dossier never solves captchas");
    // The user finished on the employer's site.
    await markAttemptSubmitted(attemptId);
    expect(await prisma().applyAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({ status: "SUBMITTED" });
  });

  it("makes a Workday account, goes through the wizard and submits after review", async () => {
    const { attemptId, attempt, plan, entry } = await fillIn("/ats/workday/acme/job/404");
    expect({ status: attempt.status, ats: attempt.ats, message: attempt.message, page: attempt.pageUrl }).toMatchObject({ status: "REVIEW", ats: "workday", message: null });
    expect(new Set(plan.map((item) => item.page))).toEqual(new Set([1, 2, 3]));
    expect(entry("Postal Code")).toMatchObject({ value: "10001" });
    expect(entry("Are you at least 18 years of age?")).toMatchObject({ value: "Yes" });
    expect(entry("How did you hear about us?")).toMatchObject({ value: "Company Website" });
    expect((await loadSettings()).applyAccountsEnc).toMatch(/^v1\./);
    expect(submissions.map((item) => item.form)).toEqual(["workday-step-1", "workday-step-2", "workday-step-3"]);
    expect(await submit(attemptId)).toMatchObject({ status: "SUBMITTED" });
    expect(submissions.at(-1)!.form).toBe("workday");
  });

  it("signs in to Workday with the account it made before", async () => {
    await fillIn("/ats/workday/acme/job/404");
    const again = await fillIn("/ats/workday/acme/job/404");
    expect(again.attempt).toMatchObject({ status: "REVIEW", message: null });
    // The first attempt was replaced.
    expect(await prisma().applyAttempt.count({ where: { status: "CANCELLED" } })).toBe(1);
  });

  it("goes back to review with the form's errors when the site refuses it", async () => {
    const { attemptId, entry } = await fillIn("/ats/careers/refusing/apply");
    await setAttemptAnswers(attemptId, [{ id: entry("Do you hold a valid driver's license?")!.id, value: "No", save: false }]);
    const refused = await submit(attemptId);
    expect(refused).toMatchObject({ status: "REVIEW", message: "The form refused it: You already applied with this email address." });
  });

  it("carries on after the user's turn, and stops again while the captcha is there", async () => {
    const { attemptId } = await fillIn("/ats/greenhouse/captcha/jobs/1");
    const jobId = await continueAttempt(attemptId);
    expect(jobId).toMatch(/^job-/);
    await fillFormJob.run({ attemptId, resume: true }, context);
    expect(await prisma().applyAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({ status: "NEEDS_YOU" });
    await closeAllSessions();
    await expect(continueAttempt(attemptId)).rejects.toThrow(APPLY_MESSAGES.gone);
  });

  it("waits for the user's consent before making a Workday account", async () => {
    await saveSettings({ applyAnswers: { ...EMPTY_ANSWERS, consent: "" } });
    const { attempt } = await fillIn("/ats/workday/acme/job/404");
    expect(attempt.status).toBe("NEEDS_YOU");
    expect(attempt.message).toContain("agree to its terms");
  });

  it("refuses LinkedIn's own pages and addresses on a private network", async () => {
    await prisma().application.update({ where: { id: "app" }, data: { postingUrl: "https://www.linkedin.com/jobs/view/1" } });
    expect((await applyUrlFor("app")).problem).toContain("Easy Apply");
    await prisma().application.update({ where: { id: "app" }, data: { postingText: "Apply: https://jobs.lever.co/acme/abc" } });
    expect((await applyUrlFor("app")).url).toBe("https://jobs.lever.co/acme/abc");
    await expect(startAutoApply("app", "http://10.0.0.1/apply")).rejects.toThrow("public internet");
  });

  it("needs a tailored resume and an approved draft", async () => {
    await prisma().application.update({ where: { id: "app" }, data: { awaitingReview: true } });
    await expect(startAutoApply("app", `${origin}/ats/careers/acme/apply`)).rejects.toThrow("Approve this job agent draft");
  });

  it("closes forms on cancel and after a restart", async () => {
    const { attemptId } = await fillIn("/ats/careers/acme/apply");
    await cancelAttempt(attemptId);
    expect((await prisma().applyAttempt.findUniqueOrThrow({ where: { id: attemptId } })).status).toBe("CANCELLED");
    const left = await prisma().applyAttempt.create({ data: { applicationId: "app", url: "https://example.com", status: "SUBMITTING" } });
    await recoverInterruptedAttempts();
    expect(await prisma().applyAttempt.findUniqueOrThrow({ where: { id: left.id } })).toMatchObject({ status: "FAILED", message: APPLY_MESSAGES.interruptedSubmit });
  });
});
