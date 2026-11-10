import { describe, expect, it } from "vitest";

import { applicantFacts, EMPTY_ANSWERS, type AnswerBank } from "./answers";
import { adapterOf, GENERIC } from "./ats";
import type { FormField } from "./fields";
import { blockingEntries, chooseOption, cleanPlan, keyOf, planFields, withAiAnswers } from "./plan";

const field = (overrides: Partial<FormField>): FormField => ({ id: "f0", label: "", type: "text", name: "", required: false, options: [], current: "", ...overrides });

const answers: AnswerBank = { ...EMPTY_ANSWERS, authorized: "yes", sponsorship: "no", noticePeriod: "1 month", gender: "decline", custom: [{ question: "Preferred pronouns?", answer: "she/her" }] };
const facts = applicantFacts(
  {
    basics: { name: "Jane van der Berg", headline: "", email: "jane@example.com", phone: "+31 6 1234 5678", dob: "", website: "", address: "", city: "Rotterdam", country: "Netherlands", linkedin: "linkedin.com/in/jane", summary: "", showAge: false },
    experience: [{ id: "e1", role: "Product Designer", company: "Northwind", current: true, volunteering: false } as never],
  },
  answers,
);
const documents = { resume: "Jane – Acme – Resume.pdf", coverLetter: null, coverLetterText: "Dear Acme,\n\nI'd like to join." };

describe("keyOf", () => {
  it("takes an adapter's known field name over the label", () => {
    expect(keyOf(field({ name: "urls[LinkedIn]", label: "Profile" }), adapterOf("lever"))).toBe("linkedin");
    expect(keyOf(field({ name: "comments", type: "textarea" }), adapterOf("lever"))).toBe("coverLetterText");
  });

  it("reads what a label asks for", () => {
    const cases: [string, FormField["type"], string | null][] = [
      ["First Name *", "text", "firstName"],
      ["Your name", "text", "fullName"],
      ["Email address", "email", "email"],
      ["How did you hear about this job?", "select", "howDidYouHear"],
      ["Will you now or in the future require visa sponsorship?", "select", "sponsorship"],
      ["Are you legally authorized to work in the Netherlands?", "select", "authorized"],
      ["Upload your CV", "file", "resume"],
      ["Cover letter", "textarea", "coverLetterText"],
      ["Cover letter", "file", "coverLetter"],
      ["Portfolio (optional)", "url", "portfolio"],
      ["Tell us about a project you're proud of", "textarea", null],
      ["Resume", "text", null],
      ["Photo", "file", null],
    ];
    for (const [label, type, key] of cases) expect(keyOf(field({ label, type }), GENERIC), label).toBe(key);
  });

  it("treats a privacy checkbox as consent", () => {
    expect(keyOf(field({ label: "I agree to the privacy policy", type: "checkbox" }), GENERIC)).toBe("consent");
  });
});

describe("chooseOption", () => {
  it("picks yes, no and decline by meaning", () => {
    expect(chooseOption(["Select…", "Yes, I am", "No"], "yes")).toBe("Yes, I am");
    expect(chooseOption(["Yes", "No, I don't"], "no")).toBe("No, I don't");
    expect(chooseOption(["Female", "Male", "I don't wish to answer"], "decline")).toBe("I don't wish to answer");
    expect(chooseOption(["Female", "Male"], "decline")).toBeNull();
  });

  it("matches the rest by text", () => {
    expect(chooseOption(["Company Website", "LinkedIn"], "company website")).toBe("Company Website");
    expect(chooseOption(["Referral from an employee", "Other"], "Referral")).toBe("Referral from an employee");
    expect(chooseOption(["A", "B"], "")).toBeNull();
  });
});

describe("planFields", () => {
  const fields = [
    field({ id: "f0", name: "first_name", label: "First Name *", required: true }),
    field({ id: "f1", name: "resume", label: "Resume", type: "file", required: true }),
    field({ id: "f2", label: "Are you legally authorized to work here?", type: "select", options: ["Yes", "No"], required: true }),
    field({ id: "f3", label: "Gender", type: "select", options: ["Female", "Male", "Decline To Self Identify"] }),
    field({ id: "f4", label: "Salary expectation", required: true }),
    field({ id: "f5", label: "Preferred pronouns?" }),
    field({ id: "f6", label: "Why us?", type: "textarea", required: true }),
    field({ id: "f7", name: "cover_letter", label: "Cover Letter", type: "file" }),
    field({ id: "f8", label: "Referral code", current: "ABC" }),
  ];
  const { plan, forAi } = planFields(fields, adapterOf("greenhouse"), facts, answers, documents);
  const entry = (id: string) => plan.find((item) => item.id === id)!;

  it("fills from the profile, the answer bank and the documents", () => {
    expect(entry("f0")).toMatchObject({ value: "Jane", status: "filled", label: "First Name" });
    expect(entry("f1")).toMatchObject({ value: "Jane – Acme – Resume.pdf", status: "document" });
    expect(entry("f2")).toMatchObject({ value: "Yes", status: "filled" });
    expect(entry("f3")).toMatchObject({ value: "Decline To Self Identify", status: "filled" });
    expect(entry("f5")).toMatchObject({ value: "she/her", note: "Your saved answer" });
  });

  it("never guesses a required answer it doesn't have", () => {
    expect(entry("f4")).toMatchObject({ status: "needs-you", value: "" });
    expect(entry("f4").note).toContain("Settings → Auto-apply");
    expect(blockingEntries(plan).map((item) => item.id)).toEqual(["f4"]);
  });

  it("skips what's optional and missing, and leaves what the form filled in", () => {
    expect(entry("f7")).toMatchObject({ status: "skipped" });
    expect(entry("f8")).toMatchObject({ status: "skipped", value: "ABC" });
  });

  it("leaves questions nothing answers for the AI", () => {
    expect(forAi.map((item) => item.id)).toEqual(["f6"]);
  });
});

describe("withAiAnswers", () => {
  const fields = [
    field({ id: "a", label: "Why us?", type: "textarea", required: true }),
    field({ id: "b", label: "Driving licence?", type: "select", options: ["Yes", "No"], required: true }),
    field({ id: "c", label: "Tell us more", type: "textarea" }),
    field({ id: "d", label: "Years at Ledgerly", required: true }),
  ];
  const plan = withAiAnswers(fields, [
    { id: "a", answer: "I like payments.", note: "", unverified: [] },
    { id: "b", answer: null, note: "Your profile doesn't say", unverified: [] },
    { id: "c", answer: "Maybe", note: "", unverified: [] },
    { id: "d", answer: "7 years", note: "", unverified: ["7"] },
  ]);

  it("marks the AI's answers as drafted, and what it couldn't answer as needing the user", () => {
    expect(plan.map((entry) => entry.status)).toEqual(["drafted", "needs-you", "drafted", "needs-you"]);
    expect(plan[1].note).toBe("Your profile doesn't say");
    expect(plan[3].note).toContain("7");
  });

  it("keeps a plan with drafts or gaps from going without review", () => {
    expect(cleanPlan(plan)).toBe(false);
    const { plan: facts_only } = planFields([field({ name: "email", label: "Email" })], adapterOf("greenhouse"), facts, answers, documents);
    expect(cleanPlan(facts_only)).toBe(true);
  });

  it("drops an answer that isn't one of the field's choices", () => {
    const [entry] = withAiAnswers([field({ id: "x", type: "select", options: ["Yes", "No"], required: true })], [{ id: "x", answer: "Perhaps", note: "", unverified: [] }]);
    expect(entry.status).toBe("needs-you");
  });
});
