import "server-only";

import type { Page } from "playwright-core";
import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { ApplicationStatus, ApplyStatus, DocumentKind } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { getAiProvider } from "@/lib/ai";
import { isAiUsable } from "@/lib/ai/config";
import { guardSources, unverifiedFacts } from "@/lib/ai/fact-guard";
import { loadTaskOptions } from "@/lib/ai/task-options";
import { answerFormFields } from "@/lib/ai/tasks";
import { extractedOf, SIGN_OFF_UNIT, unitsSchema } from "@/lib/application-data";
import { resolveFileName } from "@/lib/file-name";
import { defineJob, startJob, type JobContext } from "@/lib/jobs/runner";
import { isParagraph } from "@/lib/letter-frame";
import { logServerError } from "@/lib/log";
import { renderPdf } from "@/lib/pdf/render";
import { prisma } from "@/lib/prisma";
import { loadFactTexts, loadProfile } from "@/lib/profile-data";
import { loadSettings, saveSettings } from "@/lib/settings-data";
import { applyStatusChange } from "@/lib/status-changes";

import { applicantFacts, withSavedAnswer } from "./answers";
import { adapterOf, isLinkedIn, resolveOffLinkedIn, type AtsAdapter } from "./ats";
import { canTakeOver, closeSession, mayOpen, openSession, sessionPage } from "./browser";
import { blockingEntries, cleanPlan, planEntrySchema, planFields, withAiAnswers, type Documents, type PlanEntry } from "./plan";
import { atLastPage, blocker, confirmed, fillEntry, fillPlan, FormError, nextPage, openForm, readFields, screenshot, submitForm, type UploadFile } from "./runtime";
import { workdaySignIn } from "./workday";

// Auto-apply: fill in the employer's form from the profile, the answer bank
// and the tailored documents, stop before submitting for the user's review,
// and submit once they approve (or at once, when Settings → Auto-apply says
// so and nothing was drafted or is missing). Filling and submitting run as
// background jobs; the form stays open in browser.ts between them.

/** The key of an application's auto-apply jobs, to find them again after a reload. */
export const applyJobKey = (applicationId: string) => `apply:${applicationId}`;

/** A form spread over more pages than this is given to the user. */
const MAX_PAGES = 12;

export const APPLY_MESSAGES = {
  interrupted: "Dossier restarted, and the form it had open closed. Start again.",
  interruptedSubmit: "Dossier restarted while submitting. Check the employer's site or your email to see whether it went through.",
  expired: "The form was closed after 30 minutes without changes. Start again.",
  gone: "The form isn't open any more. Start again.",
} as const;

const OPEN: ApplyStatus[] = [ApplyStatus.FILLING, ApplyStatus.REVIEW, ApplyStatus.NEEDS_YOU, ApplyStatus.SUBMITTING];

export const readPlan = (value: unknown): PlanEntry[] => z.array(planEntrySchema).catch([]).parse(value ?? []);

/** Why an application can't be auto-applied yet, or null. */
export function notReady(application: { awaitingReview: boolean; documents: { kind: DocumentKind }[] }): string | null {
  if (application.awaitingReview) return "Approve this job agent draft first.";
  if (!application.documents.some((document) => document.kind === DocumentKind.RESUME)) return "Write the tailored resume first.";
  return null;
}

/** The address to apply at: the one given, else the posting's, never LinkedIn's own (Easy Apply isn't automated). */
export async function applyUrlFor(applicationId: string, given?: string): Promise<{ url: string | null; problem: string | null }> {
  const application = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    select: { postingUrl: true, postingText: true, posting: { select: { url: true } }, agentCandidate: { select: { url: true } } },
  });
  const candidate = given?.trim() || application.postingUrl.trim();
  if (!candidate) return { url: null, problem: "Paste the link to the employer's application form." };
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { url: null, problem: "That isn't a web address." };
  }
  if (!/^https?:$/.test(url.protocol)) return { url: null, problem: "That isn't a web address." };
  if (!isLinkedIn(url)) return { url: url.toString(), problem: null };
  const elsewhere = resolveOffLinkedIn({
    links: [application.posting?.url, application.agentCandidate?.url].filter((link): link is string => Boolean(link)),
    postingText: application.postingText,
  });
  if (elsewhere) return { url: elsewhere, problem: null };
  return { url: null, problem: "Dossier doesn't fill in LinkedIn's Easy Apply, which LinkedIn's terms don't allow. Paste the link to the company's own application form." };
}

/** Starts filling in an application's form; returns the attempt and its job. */
export async function startAutoApply(applicationId: string, given?: string): Promise<{ attemptId: string; jobId: string }> {
  const application = await prisma.application.findUnique({ where: { id: applicationId }, select: { awaitingReview: true, documents: { select: { kind: true } } } });
  if (!application) throw new ActionError("That application no longer exists.");
  const problem = notReady(application);
  if (problem) throw new ActionError(problem);
  const { url, problem: urlProblem } = await applyUrlFor(applicationId, given);
  if (!url) throw new ActionError(urlProblem!);
  if (!(await mayOpen(url))) throw new ActionError("Dossier only opens forms on the public internet.");

  // One attempt at a time per application.
  for (const open of await prisma.applyAttempt.findMany({ where: { applicationId, status: { in: OPEN } }, select: { id: true } })) {
    await closeSession(open.id);
    await prisma.applyAttempt.update({ where: { id: open.id }, data: { status: ApplyStatus.CANCELLED, message: "Replaced by a new attempt." } });
  }
  const attempt = await prisma.applyAttempt.create({ data: { applicationId, url }, select: { id: true } });
  const jobId = await startJob(fillFormJob, { attemptId: attempt.id, resume: false }, { key: applyJobKey(applicationId), applicationId });
  return { attemptId: attempt.id, jobId };
}

const expire = (attemptId: string) => () =>
  void prisma.applyAttempt
    .updateMany({ where: { id: attemptId, status: { in: [ApplyStatus.FILLING, ApplyStatus.REVIEW, ApplyStatus.NEEDS_YOU] } }, data: { status: ApplyStatus.FAILED, message: APPLY_MESSAGES.expired } })
    .catch((error: unknown) => logServerError("auto-apply", error));

/** The documents to upload, as PDFs named with the file-name pattern, and the letter as text. */
async function documentsFor(applicationId: string): Promise<{ files: { resume: UploadFile | null; coverLetter: UploadFile | null }; documents: Documents }> {
  const [application, settings, profile] = await Promise.all([
    prisma.application.findUniqueOrThrow({ where: { id: applicationId }, select: { company: true, role: true, documents: { select: { kind: true, units: true } } } }),
    loadSettings(),
    loadProfile(),
  ]);
  const has = (kind: DocumentKind) => application.documents.find((document) => document.kind === kind);
  const file = async (kind: "RESUME" | "COVER_LETTER"): Promise<UploadFile | null> => {
    if (!has(kind)) return null;
    const name = resolveFileName(settings.fileNamePattern, { name: profile.basics.name, company: application.company, role: application.role, doc: kind, date: new Date() });
    const pdf = await renderPdf(`/print/${kind === "RESUME" ? "resume" : "letter"}/${applicationId}`);
    return { name, mimeType: "application/pdf", buffer: Buffer.from(pdf) };
  };
  const [resume, coverLetter] = await Promise.all([file("RESUME"), file("COVER_LETTER")]);
  const letterUnits = unitsSchema.safeParse(has(DocumentKind.COVER_LETTER)?.units);
  const coverLetterText = letterUnits.success
    ? letterUnits.data
        .filter((unit) => unit.id === "greeting" || isParagraph(unit) || unit.id === SIGN_OFF_UNIT || unit.id === "signature")
        .map((unit) => unit.text.trim())
        .filter(Boolean)
        .join("\n\n")
    : "";
  return { files: { resume, coverLetter }, documents: { resume: resume?.name ?? null, coverLetter: coverLetter?.name ?? null, coverLetterText } };
}

/** Plans one page of the form: facts first, then the AI for the rest, checked by the fact guard. */
async function planPage(
  page: Page,
  { applicationId, adapter, pageNumber, previous, documents, signal, step }: { applicationId: string; adapter: AtsAdapter; pageNumber: number; previous: PlanEntry[]; documents: Documents } & Pick<JobContext, "signal" | "step">,
): Promise<PlanEntry[]> {
  const [settings, profile, facts, application] = await Promise.all([
    loadSettings(),
    loadProfile(),
    loadFactTexts(applicationId),
    prisma.application.findUniqueOrThrow({ where: { id: applicationId }, select: { postingText: true, extracted: true, title: true, company: true, role: true, location: true, mode: true, salary: true, language: true } }),
  ]);
  const fields = await readFields(page);
  const { plan, forAi } = planFields(fields, adapter, applicantFacts(profile, settings.applyAnswers), settings.applyAnswers, documents, pageNumber);
  let answered: PlanEntry[] = [];
  if (forAi.length > 0) {
    if (await isAiUsable()) {
      await step(`Answering ${forAi.length} ${forAi.length === 1 ? "question" : "questions"} from your profile`);
      const options = await loadTaskOptions();
      const { data } = await answerFormFields(
        await getAiProvider(),
        { profile, posting: application.postingText, notes: [...facts, ...settings.applyAnswers.custom.map((entry) => `${entry.question}: ${entry.answer}`)], fields: forAi },
        { ...options, signal },
      );
      const sources = guardSources(profile, extractedOf(application), application.postingText, facts);
      // Only free text is checked: a choice is one of the form's own options.
      answered = withAiAnswers(
        forAi,
        data.map((entry) => ({ ...entry, unverified: options.strict && entry.answer && forAi.find((field) => field.id === entry.id)?.options.length === 0 ? unverifiedFacts(entry.answer, sources) : [] })),
        pageNumber,
      );
    } else {
      answered = withAiAnswers(forAi, forAi.map((field) => ({ id: field.id, answer: null, note: "Needs an AI provider to answer (Settings → AI provider).", unverified: [] })), pageNumber);
    }
  }
  // Field order as on the page; what the user typed in before wins.
  const order = new Map(fields.map((field, index) => [field.id, index]));
  return [...plan, ...answered]
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((entry) => previous.find((typed) => typed.page === pageNumber && typed.label === entry.label && typed.note === TYPED) ?? entry);
}

const TYPED = "You entered this";

/** Stops for the user: saves why, the plan so far and what the page looks like. */
async function stopFor(attemptId: string, page: Page, message: string, plan: PlanEntry[]) {
  await prisma.applyAttempt.update({
    where: { id: attemptId },
    data: { status: ApplyStatus.NEEDS_YOU, message, plan: plan as Prisma.InputJsonValue, screenshot: new Uint8Array(await screenshot(page)), pageUrl: page.url() },
  });
  return { status: ApplyStatus.NEEDS_YOU };
}

const blockerMessage = (kind: "captcha" | "sign-in") => {
  const where = canTakeOver() ? "in Dossier's browser window, then press Continue" : "on the employer's site yourself: Dossier's browser is hidden (see DOSSIER_APPLY_BROWSER)";
  return kind === "captcha" ? `The form has a captcha. Dossier never solves captchas: solve it ${where}.` : `The site asks you to sign in. Sign in ${where}.`;
};

/** Fills in the form, page by page, and stops before submitting. */
async function fill({ attemptId, resume }: { attemptId: string; resume: boolean }, { step, signal }: JobContext): Promise<{ status: ApplyStatus }> {
  const attempt = await prisma.applyAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.status !== ApplyStatus.FILLING) return { status: attempt?.status ?? ApplyStatus.CANCELLED };
  const settings = await loadSettings();
  const profile = await loadProfile();
  let previous = readPlan(attempt.plan);

  let page = resume ? sessionPage(attemptId) : null;
  let adapter: AtsAdapter;
  if (resume && !page) throw new FormError(APPLY_MESSAGES.gone);
  if (!page) {
    await step("Opening the form");
    page = await openSession(attemptId, expire(attemptId));
    adapter = await openForm(page, attempt.url);
    await prisma.applyAttempt.update({ where: { id: attemptId }, data: { ats: adapter.id } });
  } else {
    adapter = adapterOf(attempt.ats as AtsAdapter["id"]);
    // Finished in the browser by the user, captcha and all.
    if (await confirmed(page)) return recordSubmitted(attemptId, page, false);
  }

  await step("Getting your documents ready");
  const { files, documents } = await documentsFor(attempt.applicationId);

  let pageNumber = Math.max(1, ...previous.map((entry) => entry.page));
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    signal.throwIfAborted();
    if (adapter.account) {
      await step("Signing in to Workday");
      const signedIn = await workdaySignIn(page, { email: profile.basics.email, consent: settings.applyAnswers.consent === "yes", signal });
      if (!signedIn.ok) return stopFor(attemptId, page, signedIn.message, previous);
    }
    const blocked = await blocker(page, { accounts: Boolean(adapter.account) });
    if (blocked) return stopFor(attemptId, page, blockerMessage(blocked), previous);

    await step(pageNumber === 1 ? `Filling in the ${adapter.id === "generic" ? "form" : `${adapter.label} form`}` : `Filling in page ${pageNumber}`);
    const planned = await planPage(page, { applicationId: attempt.applicationId, adapter, pageNumber, previous, documents, signal, step });
    if (planned.length === 0 && pageNumber === 1) {
      return stopFor(attemptId, page, "Dossier found no application form on this page. Open the form yourself and paste its link, or fill it in on the employer's site.", previous);
    }
    const filled = await fillPlan(page, planned, files);
    previous = [...previous.filter((entry) => entry.page !== pageNumber), ...filled];
    if (await atLastPage(page, adapter)) break;
    // Required fields left empty on an earlier page stop the wizard: Workday won't go on.
    if (blockingEntries(filled).length > 0) {
      await prisma.applyAttempt.update({ where: { id: attemptId }, data: { status: ApplyStatus.REVIEW, message: null, plan: previous as Prisma.InputJsonValue, screenshot: new Uint8Array(await screenshot(page)), pageUrl: page.url() } });
      return { status: ApplyStatus.REVIEW };
    }
    const errors = await nextPage(page, adapter);
    if (errors.length > 0) return stopFor(attemptId, page, `The form didn't go on: ${errors.join("; ")}`, previous);
    pageNumber += 1;
  }

  await prisma.applyAttempt.update({
    where: { id: attemptId },
    data: { status: ApplyStatus.REVIEW, message: null, plan: previous as Prisma.InputJsonValue, screenshot: new Uint8Array(await screenshot(page)), pageUrl: page.url() },
  });
  if (settings.applyAutoSubmit && cleanPlan(previous) && (await atLastPage(page, adapter))) {
    await step("Submitting");
    await prisma.applyAttempt.update({ where: { id: attemptId }, data: { status: ApplyStatus.SUBMITTING, autoSubmitted: true } });
    return submit({ attemptId }, { step });
  }
  return { status: ApplyStatus.REVIEW };
}

/** Records a submitted form: the page after submit, and the application as Sent. */
async function recordSubmitted(attemptId: string, page: Page | null, autoSubmitted: boolean): Promise<{ status: ApplyStatus }> {
  const shot = page ? new Uint8Array(await screenshot(page).catch(() => Buffer.alloc(0))) : null;
  const attempt = await prisma.applyAttempt.update({
    where: { id: attemptId },
    data: {
      status: ApplyStatus.SUBMITTED,
      message: null,
      submittedAt: new Date(),
      confirmation: shot && shot.length > 0 ? shot : null,
      confirmationUrl: page?.url() ?? "",
      ...(autoSubmitted ? { autoSubmitted } : {}),
    },
    select: { applicationId: true },
  });
  const application = await prisma.application.findUnique({ where: { id: attempt.applicationId }, select: { status: true } });
  if (application?.status === ApplicationStatus.DRAFT) await applyStatusChange(prisma, attempt.applicationId, ApplicationStatus.SENT);
  await closeSession(attemptId);
  return { status: ApplyStatus.SUBMITTED };
}

/** Presses submit on the open form and records what happened. */
async function submit({ attemptId }: { attemptId: string }, { step }: Pick<JobContext, "step">): Promise<{ status: ApplyStatus }> {
  const attempt = await prisma.applyAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.status !== ApplyStatus.SUBMITTING) return { status: attempt?.status ?? ApplyStatus.CANCELLED };
  const page = sessionPage(attemptId);
  if (!page) {
    await prisma.applyAttempt.update({ where: { id: attemptId }, data: { status: ApplyStatus.FAILED, message: APPLY_MESSAGES.gone } });
    return { status: ApplyStatus.FAILED };
  }
  await step("Submitting");
  const outcome = await submitForm(page, adapterOf(attempt.ats as AtsAdapter["id"]));
  if (outcome.outcome === "submitted") return recordSubmitted(attemptId, page, false);
  const plan = readPlan(attempt.plan);
  if (outcome.outcome === "captcha") return stopFor(attemptId, page, blockerMessage("captcha"), plan);
  if (outcome.outcome === "errors") {
    await prisma.applyAttempt.update({
      where: { id: attemptId },
      data: { status: ApplyStatus.REVIEW, autoSubmitted: false, message: `The form refused it: ${outcome.errors.join("; ")}`, screenshot: new Uint8Array(await screenshot(page)), pageUrl: page.url() },
    });
    return { status: ApplyStatus.REVIEW };
  }
  return stopFor(attemptId, page, "Dossier pressed Submit but can't tell whether it went through. Check the employer's site or your email, then mark it as applied.", plan);
}

/** Fills in an attempt's form, or carries on with it after the user's turn (`resume`). */
export const fillFormJob = defineJob({
  type: "auto-apply-fill",
  input: z.object({ attemptId: z.string().min(1), resume: z.boolean() }),
  result: z.object({ status: z.enum(ApplyStatus) }),
  run: (input, context) => failed(input.attemptId, () => fill(input, context)),
});

export const submitFormJob = defineJob({
  type: "auto-apply-submit",
  input: z.object({ attemptId: z.string().min(1) }),
  result: z.object({ status: z.enum(ApplyStatus) }),
  run: (input, context) => failed(input.attemptId, () => submit(input, context)),
});

/** Runs a step; when it throws, the attempt fails with the job's message and its form closes. */
async function failed<T>(attemptId: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const message = error instanceof FormError || error instanceof ActionError ? error.message : null;
    await prisma.applyAttempt
      .updateMany({ where: { id: attemptId, status: { in: OPEN } }, data: { status: ApplyStatus.FAILED, message: message ?? "Something went wrong while filling in the form. Try again." } })
      .catch(() => {});
    await closeSession(attemptId);
    throw error;
  }
}

async function openAttempt(attemptId: string, statuses: ApplyStatus[]) {
  const attempt = await prisma.applyAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw new ActionError("That attempt no longer exists.");
  if (!statuses.includes(attempt.status)) throw new ActionError("That form isn't waiting for this any more. Reload the page.");
  return attempt;
}

/** Continue: after the user's turn in the browser (a captcha, a sign-in) or a changed answer. */
export async function continueAttempt(attemptId: string): Promise<string> {
  const attempt = await openAttempt(attemptId, [ApplyStatus.NEEDS_YOU, ApplyStatus.REVIEW]);
  if (!sessionPage(attemptId)) {
    await prisma.applyAttempt.update({ where: { id: attemptId }, data: { status: ApplyStatus.FAILED, message: APPLY_MESSAGES.gone } });
    throw new ActionError(APPLY_MESSAGES.gone);
  }
  await prisma.applyAttempt.update({ where: { id: attemptId }, data: { status: ApplyStatus.FILLING, message: null } });
  return startJob(fillFormJob, { attemptId, resume: true }, { key: applyJobKey(attempt.applicationId), applicationId: attempt.applicationId });
}

/**
 * Puts the user's answers in the open form, on its current page, and saves
 * the ones they asked to keep in the answer bank.
 */
export async function setAttemptAnswers(attemptId: string, values: { id: string; value: string; save: boolean }[]): Promise<PlanEntry[]> {
  const attempt = await openAttempt(attemptId, [ApplyStatus.REVIEW, ApplyStatus.NEEDS_YOU]);
  const page = sessionPage(attemptId);
  if (!page) throw new ActionError(APPLY_MESSAGES.gone);
  const plan = readPlan(attempt.plan);
  const current = Math.max(1, ...plan.map((entry) => entry.page));
  let { applyAnswers } = await loadSettings();
  const updated: PlanEntry[] = [];
  for (const entry of plan) {
    const given = values.find((value) => value.id === entry.id);
    if (!given || entry.page !== current || entry.type === "file") {
      updated.push(entry);
      continue;
    }
    const value = given.value.trim();
    const next: PlanEntry = value ? { ...entry, value, status: "filled", note: TYPED } : { ...entry, value: "", status: entry.required ? "needs-you" : "skipped", note: "Left empty" };
    const problem = value ? await fillEntry(page, next, { resume: null, coverLetter: null }) : null;
    if (problem) throw new ActionError(`${entry.label}: ${problem}`);
    if (value && given.save) applyAnswers = { ...applyAnswers, custom: withSavedAnswer(applyAnswers.custom, { question: entry.label, answer: value }) };
    updated.push(next);
  }
  await saveSettings({ applyAnswers });
  await prisma.applyAttempt.update({
    where: { id: attemptId },
    data: { plan: updated as Prisma.InputJsonValue, screenshot: new Uint8Array(await screenshot(page)), status: ApplyStatus.REVIEW, message: attempt.status === ApplyStatus.REVIEW ? attempt.message : null },
  });
  return updated;
}

/** Submit, after the user's review. Refused while required fields are empty. */
export async function submitAttempt(attemptId: string): Promise<string> {
  const attempt = await openAttempt(attemptId, [ApplyStatus.REVIEW]);
  const blocking = blockingEntries(readPlan(attempt.plan));
  if (blocking.length > 0) throw new ActionError(`Fill in ${blocking.map((entry) => `“${entry.label}”`).join(", ")} first.`);
  const page = sessionPage(attemptId);
  if (!page) {
    await prisma.applyAttempt.update({ where: { id: attemptId }, data: { status: ApplyStatus.FAILED, message: APPLY_MESSAGES.gone } });
    throw new ActionError(APPLY_MESSAGES.gone);
  }
  if (!(await atLastPage(page, adapterOf(attempt.ats as AtsAdapter["id"])))) throw new ActionError("The form has more pages: fill in what's missing, then press Continue.");
  await prisma.applyAttempt.update({ where: { id: attemptId }, data: { status: ApplyStatus.SUBMITTING, message: null } });
  return startJob(submitFormJob, { attemptId }, { key: applyJobKey(attempt.applicationId), applicationId: attempt.applicationId });
}

/** "I submitted it": the user finished on the employer's site. */
export async function markAttemptSubmitted(attemptId: string): Promise<void> {
  await openAttempt(attemptId, [ApplyStatus.NEEDS_YOU, ApplyStatus.REVIEW, ApplyStatus.FAILED]);
  await recordSubmitted(attemptId, sessionPage(attemptId), false);
}

export async function cancelAttempt(attemptId: string): Promise<void> {
  await closeSession(attemptId);
  await prisma.applyAttempt.updateMany({ where: { id: attemptId, status: { in: OPEN } }, data: { status: ApplyStatus.CANCELLED, message: null } });
}

/** At startup: the forms a previous process had open are gone. */
export async function recoverInterruptedAttempts(): Promise<void> {
  await prisma.applyAttempt.updateMany({ where: { status: ApplyStatus.SUBMITTING }, data: { status: ApplyStatus.FAILED, message: APPLY_MESSAGES.interruptedSubmit } });
  await prisma.applyAttempt.updateMany({ where: { status: { in: OPEN } }, data: { status: ApplyStatus.FAILED, message: APPLY_MESSAGES.interrupted } });
}

/** Settings → Auto-apply "Fill in forms for approved agent drafts": starts one, and logs why it couldn't. */
export async function autoApplyApprovedDraft(applicationId: string): Promise<void> {
  if (!(await loadSettings()).agentAutoApply) return;
  try {
    await startAutoApply(applicationId);
  } catch (error) {
    if (!(error instanceof ActionError)) logServerError("auto-apply", error);
  }
}
