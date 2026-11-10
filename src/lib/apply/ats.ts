import type { FactKey } from "./answers";

// The applicant tracking systems auto-apply knows (Greenhouse, Lever, Ashby,
// Workable, SmartRecruiters, and Workday as best effort). Each is known by
// its address, or by markers in the page for one embedded on a company's own
// site. What an adapter knows is data: which field names mean what, how to
// get from the posting to the form, the submit button and the thank-you page.
// Anything else falls to the generic form reader.

export type AtsId = "greenhouse" | "lever" | "ashby" | "workable" | "smartrecruiters" | "workday" | "generic";

export type AtsAdapter = {
  id: AtsId;
  label: string;
  /** Hostnames it's served from. */
  hosts: RegExp;
  /** Elements only its forms have, for one embedded on another site. */
  marker: string;
  /** The form's own address, from a posting's, when they differ. */
  formUrl?: (url: URL) => string | null;
  /** A link or button that opens the form on the posting's page. */
  openForm?: string;
  /** What its fields ask for, by name, id or data-automation-id. */
  known: Record<string, FactKey>;
  /** The final submit button. */
  submit: string;
  /** A wizard's "next page" button, for forms spread over pages. */
  next?: string;
  /** Needs a candidate account first (Workday). */
  account?: boolean;
  /** Best effort: the form changes from employer to employer. */
  bestEffort?: boolean;
};

const SUBMIT = 'button[type="submit"], input[type="submit"]';

export const ADAPTERS: readonly AtsAdapter[] = [
  {
    id: "greenhouse",
    label: "Greenhouse",
    hosts: /(^|\.)greenhouse\.io$/,
    marker: '#grnhse_app, #application_form, #application-form input#first_name, input[name="job_application[first_name]"]',
    known: {
      first_name: "firstName",
      last_name: "lastName",
      email: "email",
      phone: "phone",
      resume: "resume",
      cover_letter: "coverLetter",
      "candidate-location": "location",
      "job_application[first_name]": "firstName",
      "job_application[last_name]": "lastName",
      "job_application[email]": "email",
      "job_application[phone]": "phone",
      "job_application[location]": "location",
      "job_application[gender]": "gender",
      "job_application[race]": "race",
      "job_application[veteran_status]": "veteran",
      "job_application[disability_status]": "disability",
    },
    submit: `#submit_app, ${SUBMIT}`,
  },
  {
    id: "lever",
    label: "Lever",
    hosts: /(^|\.)lever\.co$/,
    marker: 'input[name="urls[LinkedIn]"], .lever-application, form[action*="lever.co"]',
    // jobs.lever.co/<company>/<id> is the posting; its form is at …/apply.
    formUrl: (url) => {
      const parts = url.pathname.split("/").filter(Boolean);
      return parts.length === 2 ? new URL(`/${parts.join("/")}/apply${url.search}`, url).toString() : null;
    },
    known: {
      name: "fullName",
      email: "email",
      phone: "phone",
      location: "location",
      org: "currentCompany",
      "urls[LinkedIn]": "linkedin",
      "urls[GitHub]": "github",
      "urls[Portfolio]": "portfolio",
      "urls[Other]": "website",
      resume: "resume",
      comments: "coverLetterText",
      "eeo[gender]": "gender",
      "eeo[race]": "race",
      "eeo[veteran]": "veteran",
      "eeo[disability]": "disability",
    },
    submit: `#btn-submit, ${SUBMIT}`,
  },
  {
    id: "ashby",
    label: "Ashby",
    hosts: /(^|\.)ashbyhq\.com$/,
    marker: 'input[name="_systemfield_name"], input[name="_systemfield_email"], #ashby_embed',
    // jobs.ashbyhq.com/<company>/<id> is the posting; its form is at …/application.
    formUrl: (url) => {
      const parts = url.pathname.split("/").filter(Boolean);
      return parts.length === 2 ? new URL(`/${parts.join("/")}/application${url.search}`, url).toString() : null;
    },
    known: {
      _systemfield_name: "fullName",
      _systemfield_email: "email",
      _systemfield_phone: "phone",
      _systemfield_location: "location",
      _systemfield_resume: "resume",
      _systemfield_cover_letter: "coverLetter",
      _systemfield_linkedin: "linkedin",
    },
    submit: `.ashby-application-form-submit-button, ${SUBMIT}`,
  },
  {
    id: "workable",
    label: "Workable",
    hosts: /(^|\.)workable\.com$/,
    marker: 'form[data-ui="application-form"], [data-ui="firstname"]',
    formUrl: (url) => (/\/j\/[^/]+\/?$/.test(url.pathname) ? new URL(`${url.pathname.replace(/\/$/, "")}/apply${url.search}`, url).toString() : null),
    known: {
      firstname: "firstName",
      lastname: "lastName",
      email: "email",
      phone: "phone",
      address: "location",
      resume: "resume",
      cover_letter: "coverLetterText",
    },
    submit: `[data-ui="apply-button"], ${SUBMIT}`,
  },
  {
    id: "smartrecruiters",
    label: "SmartRecruiters",
    hosts: /(^|\.)smartrecruiters\.com$/,
    marker: "oc-oneclick-form, spl-form-element, [data-test='oneclick-ui']",
    openForm: '[data-test="footer-apply-button"], a#st-apply',
    known: {
      firstName: "firstName",
      lastName: "lastName",
      email: "email",
      confirmEmail: "email",
      phoneNumber: "phone",
      location: "location",
      linkedIn: "linkedin",
      website: "website",
      resume: "resume",
    },
    submit: `[data-test="footer-submit"], ${SUBMIT}`,
  },
  {
    id: "workday",
    label: "Workday",
    hosts: /(^|\.)(myworkdayjobs|myworkdaysite|workday)\.com$/,
    marker: '[data-automation-id="jobPostingHeader"], [data-automation-id="adventureButton"], [data-automation-id="applyFlowPage"]',
    openForm: '[data-automation-id="adventureButton"]',
    known: {
      legalNameSection_firstName: "firstName",
      legalNameSection_lastName: "lastName",
      email: "email",
      "phone-number": "phone",
      addressSection_city: "city",
      addressSection_addressLine1: "address",
      countryDropdown: "country",
      "file-upload-input-ref": "resume",
      linkedinQuestion: "linkedin",
    },
    submit: '[data-automation-id="pageFooterSubmitButton"], [data-automation-id="bottom-navigation-next-button"]:has-text("Submit")',
    next: '[data-automation-id="bottom-navigation-next-button"]',
    account: true,
    bestEffort: true,
  },
];

export const GENERIC: AtsAdapter = {
  id: "generic",
  label: "Unknown form",
  hosts: /^$/,
  marker: "form",
  known: {},
  submit: SUBMIT,
};

export const adapterOf = (id: AtsId): AtsAdapter => ADAPTERS.find((adapter) => adapter.id === id) ?? GENERIC;

/** LinkedIn's own pages: Easy Apply isn't automated, against LinkedIn's terms. */
export const isLinkedIn = (url: URL) => /(^|\.)linkedin\.com$/.test(url.hostname);

/** The ATS an address belongs to, or null when the page has to tell. */
export function atsFromUrl(url: URL): AtsAdapter | null {
  return ADAPTERS.find((adapter) => adapter.hosts.test(url.hostname)) ?? null;
}

/** The ATS a page belongs to, by its address, else by the markers it has; generic otherwise. */
export async function detectAts(url: URL, has: (selector: string) => Promise<boolean>): Promise<AtsAdapter> {
  const byUrl = atsFromUrl(url);
  if (byUrl) return byUrl;
  for (const adapter of ADAPTERS) if (await has(adapter.marker)) return adapter;
  return GENERIC;
}

/** ATS addresses, to find a company's own apply link in a posting's text. */
const ATS_LINK = /https?:\/\/[^\s"'<>)]*(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|myworkdayjobs\.com)[^\s"'<>)]*/gi;

/**
 * Where to apply instead of LinkedIn: an ATS or company link from the job
 * source's other apply options, else an ATS link in the posting's text.
 * Null when there is none: then the user is told to paste the company's link.
 */
export function resolveOffLinkedIn(options: { links: readonly string[]; postingText: string }): string | null {
  const web = (link: string) => {
    try {
      const url = new URL(link);
      return /^https?:$/.test(url.protocol) && !isLinkedIn(url) ? url : null;
    } catch {
      return null;
    }
  };
  const candidates = options.links.flatMap((link) => web(link) ?? []);
  const ats = candidates.find((url) => atsFromUrl(url));
  if (ats) return ats.toString();
  const inText = [...options.postingText.matchAll(ATS_LINK)].map((match) => web(match[0].replace(/[.,;]+$/, ""))).find(Boolean);
  return inText?.toString() ?? candidates[0]?.toString() ?? null;
}
