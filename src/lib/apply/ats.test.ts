import { describe, expect, it } from "vitest";

import { adapterOf, atsFromUrl, detectAts, isLinkedIn, resolveOffLinkedIn } from "./ats";
import { applicantFacts, EMPTY_ANSWERS, normalizeQuestion, savedAnswer, splitName, withSavedAnswer } from "./answers";

describe("ATS detection", () => {
  it("knows an ATS by its address", () => {
    expect(atsFromUrl(new URL("https://job-boards.greenhouse.io/acme/jobs/1"))?.id).toBe("greenhouse");
    expect(atsFromUrl(new URL("https://jobs.eu.lever.co/acme/abc"))?.id).toBe("lever");
    expect(atsFromUrl(new URL("https://jobs.ashbyhq.com/acme/abc"))?.id).toBe("ashby");
    expect(atsFromUrl(new URL("https://apply.workable.com/acme/j/ABC/"))?.id).toBe("workable");
    expect(atsFromUrl(new URL("https://jobs.smartrecruiters.com/Acme/123"))?.id).toBe("smartrecruiters");
    expect(atsFromUrl(new URL("https://acme.wd3.myworkdayjobs.com/en-US/careers/job/1"))?.id).toBe("workday");
    expect(atsFromUrl(new URL("https://notgreenhouse.io.example.com/"))).toBeNull();
  });

  it("knows an embedded ATS by the page's markers, else reads the form itself", async () => {
    const markers = (present: string) => async (selector: string) => selector.split(", ").includes(present);
    expect((await detectAts(new URL("https://acme.example/careers"), markers('input[name="_systemfield_email"]'))).id).toBe("ashby");
    expect((await detectAts(new URL("https://acme.example/careers"), markers("nothing"))).id).toBe("generic");
  });

  it("finds the form's own page from a posting's", () => {
    expect(adapterOf("lever").formUrl!(new URL("https://jobs.lever.co/acme/abc"))).toBe("https://jobs.lever.co/acme/abc/apply");
    expect(adapterOf("lever").formUrl!(new URL("https://jobs.lever.co/acme/abc/apply"))).toBeNull();
    expect(adapterOf("ashby").formUrl!(new URL("https://jobs.ashbyhq.com/acme/abc"))).toBe("https://jobs.ashbyhq.com/acme/abc/application");
    expect(adapterOf("workable").formUrl!(new URL("https://apply.workable.com/acme/j/ABC/"))).toBe("https://apply.workable.com/acme/j/ABC/apply");
  });
});

describe("LinkedIn", () => {
  it("is never applied on, but a company's own link is found instead", () => {
    expect(isLinkedIn(new URL("https://www.linkedin.com/jobs/view/1"))).toBe(true);
    expect(resolveOffLinkedIn({ links: ["https://www.linkedin.com/jobs/view/1", "https://jobs.lever.co/acme/abc"], postingText: "" })).toBe("https://jobs.lever.co/acme/abc");
    expect(resolveOffLinkedIn({ links: [], postingText: "Apply at https://boards.greenhouse.io/acme/jobs/9." })).toBe("https://boards.greenhouse.io/acme/jobs/9");
    expect(resolveOffLinkedIn({ links: ["https://acme.example/careers/1"], postingText: "" })).toBe("https://acme.example/careers/1");
    expect(resolveOffLinkedIn({ links: ["javascript:alert(1)", "https://linkedin.com/x"], postingText: "nothing here" })).toBeNull();
  });
});

describe("the answer bank", () => {
  it("splits a name into given name and the rest", () => {
    expect(splitName("Jane van der Berg")).toEqual({ first: "Jane", last: "van der Berg" });
    expect(splitName("Prince")).toEqual({ first: "Prince", last: "" });
  });

  it("finds a saved answer to the same question, however it's written", () => {
    const custom = withSavedAnswer([{ question: "Preferred pronouns?", answer: "she/her" }], { question: "Notice period *", answer: "1 month" });
    expect(normalizeQuestion("Notice period *")).toBe("notice period");
    expect(savedAnswer("NOTICE PERIOD (required)", custom)).toBe("1 month");
    expect(savedAnswer("preferred pronouns", custom)).toBe("she/her");
    expect(savedAnswer("", custom)).toBeNull();
    expect(withSavedAnswer(custom, { question: "notice period", answer: "2 months" })).toHaveLength(2);
  });

  it("takes the current role and falls back to the portfolio for a website", () => {
    const facts = applicantFacts(
      {
        basics: { name: "Jane Doe", headline: "", email: "", phone: "", dob: "", website: "", address: "", city: "", country: "Netherlands", linkedin: "", summary: "", showAge: false },
        experience: [{ role: "Volunteer", company: "Food bank", current: true, volunteering: true } as never, { role: "Designer", company: "Northwind", current: true, volunteering: false } as never],
      },
      { ...EMPTY_ANSWERS, portfolio: "https://jane.example" },
    );
    expect(facts).toMatchObject({ currentCompany: "Northwind", currentTitle: "Designer", website: "https://jane.example", location: "Netherlands" });
  });
});
