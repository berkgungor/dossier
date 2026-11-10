import { z } from "zod";

import { DECLINE, FACT_LABELS, factHome, savedAnswer, type AnswerBank, type ApplicantFacts, type FactKey } from "./answers";
import type { AtsAdapter } from "./ats";
import { plainLabel, type FormField } from "./fields";

// What auto-apply puts in each field, and why. Pure: the page work is in
// runtime.ts, the AI's part in the map-apply-fields task.

/**
 * - filled: from the profile, the answer bank or a saved answer.
 * - document: the tailored resume or cover letter.
 * - drafted: written by the AI; shown for review, never submitted unreviewed.
 * - needs-you: required, and nothing supports an answer. Never guessed.
 * - skipped: optional, and nothing to put there.
 */
export const PLAN_STATUSES = ["filled", "document", "drafted", "needs-you", "skipped"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const planEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.string(),
  required: z.boolean(),
  options: z.array(z.string()),
  /** What's put in it: text, the option chosen, "yes" for a ticked box, or the document's file name. */
  value: z.string(),
  status: z.enum(PLAN_STATUSES),
  /** Where the value came from, or what to do about it, for the review screen. */
  note: z.string(),
  /** The page of a multi-page form it's on, from 1. */
  page: z.number().int().min(1),
});
export type PlanEntry = z.infer<typeof planEntrySchema>;

/** Label patterns, in order: the first match decides. */
const LABEL_KEYS: readonly [RegExp, FactKey][] = [
  [/how did you (hear|find|learn)|where did you (hear|find|see)|referr(al|ed) (source|by)|^source$/, "howDidYouHear"],
  [/first name|given name|forename|vorname|prénom/, "firstName"],
  [/last name|surname|family name|nachname/, "lastName"],
  [/^(full |legal |your )?name$|^name and surname$/, "fullName"],
  [/e-?mail/, "email"],
  [/phone|mobile|telephone|telefon/, "phone"],
  [/linkedin/, "linkedin"],
  [/github/, "github"],
  [/portfolio/, "portfolio"],
  [/cover letter|motivation(al)? letter|anschreiben/, "coverLetter"],
  [/resume|résumé|\bcv\b|curriculum vitae|lebenslauf/, "resume"],
  [/sponsor/, "sponsorship"],
  [/authori[sz]ed to work|work authori[sz]ation|right to work|eligible to work|legally (able|allowed|permitted) to work|work permit/, "authorized"],
  [/salary|compensation|pay expectation|desired pay|gehalt/, "salary"],
  [/18 years|over 18|at least 18|of legal (working )?age/, "over18"],
  [/zip|postal code|postcode/, "postalCode"],
  [/^state$|state\/province|state of residence|^province$/, "state"],
  [/relocat/, "relocate"],
  [/notice period|kündigungsfrist/, "noticePeriod"],
  [/start date|when can you start|earliest (start|date)|available to start|availability to start/, "startDate"],
  [/current (company|employer)|company name|^employer$|^organi[sz]ation$/, "currentCompany"],
  [/current (title|role|position)|job title/, "currentTitle"],
  [/website|personal (site|page)|^url$|blog/, "website"],
  [/gender|^sex$/, "gender"],
  [/\brace\b|ethnic|hispanic|latin[oax]/, "race"],
  [/veteran/, "veteran"],
  [/disabilit/, "disability"],
  [/^city$|city of residence|current city/, "city"],
  [/^country$|country of residence/, "country"],
  [/^address$|street address|address line/, "address"],
  [/location|where are you (based|located)|city.*country/, "location"],
];

const CONSENT = /\b(agree|consent|acknowledge|privacy|terms|gdpr|data processing|datenschutz)\b/;

/** What a field asks for: the adapter's known name first, then its label. */
export function keyOf(field: Pick<FormField, "name" | "label" | "type">, adapter: Pick<AtsAdapter, "known">): FactKey | null {
  const known = adapter.known[field.name];
  if (known) return field.type === "textarea" && known === "coverLetter" ? "coverLetterText" : known;
  const label = plainLabel(field.label).toLowerCase();
  if (field.type === "checkbox" && CONSENT.test(label)) return "consent";
  const key = LABEL_KEYS.find(([pattern]) => pattern.test(label))?.[1] ?? null;
  // A cover letter asked for as text, and documents only as files.
  if (key === "coverLetter" && field.type !== "file") return "coverLetterText";
  if (field.type === "file" && key !== "resume" && key !== "coverLetter") return null;
  if (key === "resume" && field.type !== "file") return null;
  return key;
}

const YES = /^(yes|ja|oui|sí|si|true|y)\b/i;
const NO = /^(no|nein|non|false|n)\b/i;
const DECLINES = /decline|prefer not|don[’']?t wish|do not wish|not to (say|disclose|answer|self.?identify)|rather not|choose not/i;
const norm = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The option that says `value`, or null: yes/no and "decline" by meaning, the rest by text. */
export function chooseOption(options: readonly string[], value: string): string | null {
  if (!value || options.length === 0) return null;
  if (value === DECLINE) return options.find((option) => DECLINES.test(option)) ?? null;
  if (value === "yes" || value === "no") return options.find((option) => (value === "yes" ? YES : NO).test(option.trim())) ?? null;
  const wanted = norm(value);
  return (
    options.find((option) => norm(option) === wanted) ??
    options.find((option) => norm(option).startsWith(wanted) || wanted.startsWith(norm(option))) ??
    options.find((option) => norm(option).includes(wanted)) ??
    null
  );
}

/** How a yes/no answer reads in a text field. */
const yesNoText = (value: string) => (value === "yes" ? "Yes" : value === "no" ? "No" : value);

const LINKS: readonly FactKey[] = ["linkedin", "github", "portfolio", "website"];

export type Documents = { resume: string | null; coverLetter: string | null; coverLetterText: string };

/** One field filled from a fact, or not. */
function fromFact(field: FormField, key: FactKey, facts: ApplicantFacts, documents: Documents): Pick<PlanEntry, "value" | "status" | "note"> {
  const source = factHome(key) === "profile" ? "profile" : "answer bank";
  if (key === "resume" || key === "coverLetter") {
    const file = documents[key];
    if (file) return { value: file, status: "document", note: key === "resume" ? "Tailored resume" : "Cover letter" };
    return missing(field, `${FACT_LABELS[key]}: this application has none yet.`);
  }
  if (key === "coverLetterText") {
    if (documents.coverLetterText) return { value: documents.coverLetterText, status: "document", note: "Cover letter" };
    return missing(field, "Cover letter: this application has none yet.");
  }
  // Text fields asking about work authorization take the details, if given.
  let raw = facts[key];
  if (key === "authorized" && !["select", "radio", "checkbox"].includes(field.type)) raw = facts.authorizationDetails || facts.authorized;
  if (!raw) return missing(field, `${FACT_LABELS[key]}: add it in ${source === "profile" ? "your profile" : "Settings → Auto-apply"}.`);
  if (field.type === "checkbox") {
    if (raw === "yes") return { value: "yes", status: "filled", note: `From your ${source}` };
    if (raw === "no") return { value: "", status: field.required ? "needs-you" : "skipped", note: field.required ? `${FACT_LABELS[key]}: required, but your answer is no.` : `From your ${source}` };
  }
  if (field.type === "select" || field.type === "radio") {
    const option = chooseOption(field.options, raw);
    if (option) return { value: option, status: "filled", note: `From your ${source}` };
    return missing(field, raw === DECLINE ? `${FACT_LABELS[key]}: the form has no "decline" choice.` : `${FACT_LABELS[key]}: no choice matches “${yesNoText(raw)}”.`);
  }
  if (raw === DECLINE) return missing(field, `${FACT_LABELS[key]}: declining needs a choice, and this is a text field.`);
  // "linkedin.com/in/jane" as a full address: a URL field refuses it otherwise.
  if (LINKS.includes(key) && !/^[a-z]+:\/\//i.test(raw)) return { value: `https://${raw}`, status: "filled", note: `From your ${source}` };
  return { value: yesNoText(raw), status: "filled", note: `From your ${source}` };
}

function missing(field: FormField, note: string): Pick<PlanEntry, "value" | "status" | "note"> {
  return { value: "", status: field.required ? "needs-you" : "skipped", note };
}

/**
 * Plans every field it can from facts alone, and lists the rest for the AI.
 * A value the form already holds, such as an email it filled in itself, is left as it is.
 */
export function planFields(
  fields: readonly FormField[],
  adapter: Pick<AtsAdapter, "known">,
  facts: ApplicantFacts,
  answers: Pick<AnswerBank, "custom">,
  documents: Documents,
  page = 1,
): { plan: PlanEntry[]; forAi: FormField[] } {
  const plan: PlanEntry[] = [];
  const forAi: FormField[] = [];
  for (const field of fields) {
    const base = { id: field.id, label: plainLabel(field.label) || field.name, type: field.type, required: field.required, options: field.options, page };
    const key = keyOf(field, adapter);
    if (key) {
      plan.push({ ...base, ...fromFact(field, key, facts, documents) });
      continue;
    }
    const saved = savedAnswer(field.label, answers.custom);
    if (saved !== null) {
      const value = field.options.length > 0 ? chooseOption(field.options, saved) : saved;
      if (value) {
        plan.push({ ...base, value, status: "filled", note: "Your saved answer" });
        continue;
      }
    }
    if (field.type === "file") {
      plan.push({ ...base, ...missing(field, "A file Dossier has nothing for.") });
      continue;
    }
    // Something there already (the ATS's own default): leave it.
    if (field.current) {
      plan.push({ ...base, value: field.current, status: "skipped", note: "Already filled in by the form" });
      continue;
    }
    forAi.push(field);
  }
  return { plan, forAi };
}

/** An AI answer for one field, as the map-apply-fields task returns it. */
export type AiAnswer = { id: string; answer: string | null; note: string; unverified: string[] };

/** Adds the AI's answers: drafted when it could answer, needs-you or skipped when it couldn't. */
export function withAiAnswers(fields: readonly FormField[], answers: readonly AiAnswer[], page = 1): PlanEntry[] {
  return fields.map((field) => {
    const base = { id: field.id, label: plainLabel(field.label) || field.name, type: field.type, required: field.required, options: field.options, page };
    const answer = answers.find((entry) => entry.id === field.id);
    let value = answer?.answer?.trim() ?? "";
    if (value && field.options.length > 0) value = chooseOption(field.options, value) ?? "";
    if (value && field.type === "checkbox") value = YES.test(value) ? "yes" : "";
    if (!value) return { ...base, value: "", status: field.required ? "needs-you" : "skipped", note: answer?.note || "Your profile doesn't say." };
    // Names or numbers the profile doesn't back: the user decides.
    if (answer!.unverified.length > 0) return { ...base, value, status: "needs-you", note: `Check this: ${answer!.unverified.join(", ")} isn't in your profile.` };
    return { ...base, value, status: "drafted", note: answer!.note || "Drafted by the AI from your profile" };
  });
}

/** Whether the plan can go without review (Settings → Auto-apply, "Submit without review"). */
export function cleanPlan(plan: readonly PlanEntry[]): boolean {
  return plan.every((entry) => entry.status !== "drafted" && entry.status !== "needs-you");
}

/** What still stops a submit: required fields with nothing in them. */
export const blockingEntries = (plan: readonly PlanEntry[]) => plan.filter((entry) => entry.status === "needs-you");
