import { z } from "zod";

import type { ProfileData } from "@/lib/profile";

// The answer bank (Settings → Auto-apply): what application forms ask again
// and again, answered once. Shared with the browser, so it holds no
// server-only code. Stored as the `applyAnswers` setting.

const text = (max = 500) => z.string().trim().max(max).catch("");
const yesNo = z.enum(["", "yes", "no"]).catch("");
/** An EEO answer: "" leaves it alone, "decline" picks the form's "decline to self-identify". */
const eeo = z.string().trim().max(120).catch("");

export const DECLINE = "decline";

export const customAnswerSchema = z.object({
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().min(1).max(4000),
});
export type CustomAnswer = z.infer<typeof customAnswerSchema>;

export const answerBankSchema = z.object({
  /** "Are you legally authorized to work in …?" */
  authorized: yesNo,
  /** What to write where a form asks in words, e.g. "EU citizen, no visa needed". */
  authorizationDetails: text(),
  /** "Will you now or in the future require sponsorship?" */
  sponsorship: yesNo,
  salary: text(200),
  /** "Are you at least 18 years old?", which US forms ask. */
  over18: yesNo,
  /** The US state and ZIP code, which the profile's address doesn't hold. */
  state: text(100),
  postalCode: text(20),
  relocate: yesNo,
  startDate: text(200),
  noticePeriod: text(200),
  howDidYouHear: text(200),
  github: text(300),
  portfolio: text(300),
  gender: eeo,
  race: eeo,
  veteran: eeo,
  disability: eeo,
  /** Tick a form's privacy-policy and data-processing consent boxes. */
  consent: yesNo,
  /** Questions answered before, kept to answer them the same way again. */
  custom: z.array(customAnswerSchema).max(200).catch([]),
});
export type AnswerBank = z.infer<typeof answerBankSchema>;

export const EMPTY_ANSWERS: AnswerBank = answerBankSchema.parse({});

/** The answer bank's keys a form field can ask for, besides the custom questions. */
export type AnswerKey = Exclude<keyof AnswerBank, "custom">;

/** What a form field can ask for. */
export type FactKey =
  | "firstName"
  | "lastName"
  | "fullName"
  | "email"
  | "phone"
  | "location"
  | "city"
  | "country"
  | "address"
  | "linkedin"
  | "website"
  | "currentCompany"
  | "currentTitle"
  | "resume"
  | "coverLetter"
  | "coverLetterText"
  | AnswerKey;

export const FACT_LABELS: Record<FactKey, string> = {
  firstName: "First name",
  lastName: "Last name",
  fullName: "Full name",
  email: "Email",
  phone: "Phone",
  location: "Location",
  city: "City",
  country: "Country",
  address: "Address",
  linkedin: "LinkedIn",
  website: "Website",
  currentCompany: "Current company",
  currentTitle: "Current title",
  resume: "Resume",
  coverLetter: "Cover letter",
  coverLetterText: "Cover letter",
  authorized: "Work authorization",
  authorizationDetails: "Work authorization",
  sponsorship: "Visa sponsorship",
  salary: "Salary expectation",
  over18: "At least 18",
  state: "State",
  postalCode: "ZIP code",
  relocate: "Relocation",
  startDate: "Start date",
  noticePeriod: "Notice period",
  howDidYouHear: "How you heard of the job",
  github: "GitHub",
  portfolio: "Portfolio",
  gender: "Gender",
  race: "Race or ethnicity",
  veteran: "Veteran status",
  disability: "Disability status",
  consent: "Privacy consent",
};

const DOCUMENT_KEYS: readonly FactKey[] = ["resume", "coverLetter", "coverLetterText"];
const PROFILE_FACTS: readonly FactKey[] = ["firstName", "lastName", "fullName", "email", "phone", "location", "city", "country", "address", "linkedin", "website", "currentCompany", "currentTitle"];

/** Where the user fills in what a key needs, for "Add it in …". */
export function factHome(key: FactKey): "profile" | "answers" | "documents" {
  if (DOCUMENT_KEYS.includes(key)) return "documents";
  return PROFILE_FACTS.includes(key) ? "profile" : "answers";
}

/** Everything a form can be filled with, except the documents. */
export type ApplicantFacts = Record<Exclude<FactKey, "resume" | "coverLetter" | "coverLetterText">, string>;

/** "Jane van der Berg" → first "Jane", last "van der Berg": the first word is the given name. */
export function splitName(name: string): { first: string; last: string } {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return { first: words[0] ?? "", last: "" };
  return { first: words[0], last: words.slice(1).join(" ") };
}

/** The facts a form can ask for, from the profile and the answer bank. */
export function applicantFacts(profile: Pick<ProfileData, "basics" | "experience">, answers: AnswerBank): ApplicantFacts {
  const { basics } = profile;
  const { first, last } = splitName(basics.name);
  // The current paid role, else the latest one.
  const current = profile.experience.find((entry) => entry.current && !entry.volunteering) ?? null;
  return {
    authorized: answers.authorized,
    authorizationDetails: answers.authorizationDetails,
    sponsorship: answers.sponsorship,
    salary: answers.salary,
    over18: answers.over18,
    state: answers.state,
    postalCode: answers.postalCode,
    relocate: answers.relocate,
    startDate: answers.startDate,
    noticePeriod: answers.noticePeriod,
    howDidYouHear: answers.howDidYouHear,
    github: answers.github,
    portfolio: answers.portfolio,
    gender: answers.gender,
    race: answers.race,
    veteran: answers.veteran,
    disability: answers.disability,
    consent: answers.consent,
    firstName: first,
    lastName: last,
    fullName: basics.name.trim(),
    email: basics.email.trim(),
    phone: basics.phone.trim(),
    location: [basics.city, basics.country].map((part) => part.trim()).filter(Boolean).join(", "),
    city: basics.city.trim(),
    country: basics.country.trim(),
    address: basics.address.trim(),
    linkedin: basics.linkedin.trim(),
    website: basics.website.trim() || answers.portfolio,
    currentCompany: current?.company.trim() ?? "",
    currentTitle: current?.role.trim() ?? "",
  };
}

/** A question as compared with the answer bank's: lower case, letters and digits only. */
export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/\*|\(required\)|\(optional\)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The saved answer to the same question, if there is one. */
export function savedAnswer(question: string, custom: readonly CustomAnswer[]): string | null {
  const wanted = normalizeQuestion(question);
  if (!wanted) return null;
  return custom.find((entry) => normalizeQuestion(entry.question) === wanted)?.answer ?? null;
}

/** Adds or replaces a saved answer, keyed by its question. */
export function withSavedAnswer(custom: readonly CustomAnswer[], entry: CustomAnswer): CustomAnswer[] {
  const key = normalizeQuestion(entry.question);
  return [...custom.filter((saved) => normalizeQuestion(saved.question) !== key), entry];
}
