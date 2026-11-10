// Fake application forms in the shape of Greenhouse, Lever, Ashby and
// Workday, plus one no ATS knows, for auto-apply's tests. Served under
// /ats/ by e2e/fake-jobs.mts and by the browser tests in src/lib/apply.
// They copy the markers and field names auto-apply's adapters look for,
// never a real employer's page. What each form was sent is kept in
// `submissions`.

import type { IncomingMessage, ServerResponse } from "node:http";

export type Submission = { form: string; body: string };
export const submissions: Submission[] = [];
/** Workday accounts made on the fake Workday, by email. */
const workdayAccounts = new Map<string, string>();

const page = (title: string, body: string, head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

const GREENHOUSE = (action: string, extra = "") =>
  page(
    "Marketing Manager at Acme",
    `<div id="grnhse_app"><h1>Marketing Manager</h1>
<form id="application-form" method="post" action="${action}" enctype="multipart/form-data">
  <div class="field"><label for="first_name">First Name *</label><input id="first_name" name="first_name" required></div>
  <div class="field"><label for="last_name">Last Name *</label><input id="last_name" name="last_name" required></div>
  <div class="field"><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
  <div class="field"><label for="phone">Phone</label><input id="phone" name="phone" type="tel"></div>
  <div class="field"><label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" required style="position:absolute;left:-9999px"></div>
  <div class="field"><label for="cover_letter">Cover Letter</label><input id="cover_letter" name="cover_letter" type="file"></div>
  <div class="field"><label for="question_1">LinkedIn Profile</label><input id="question_1" name="question_1"></div>
  <div class="field"><label for="question_2">Are you legally authorized to work in the United States? *</label>
    <select id="question_2" name="question_2" required><option value="">Select...</option><option>Yes</option><option>No</option></select></div>
  <div class="field"><label for="question_3">Will you now or in the future require sponsorship for employment visa status (e.g. H-1B)? *</label>
    <select id="question_3" name="question_3" required><option value="">Select...</option><option>Yes</option><option>No</option></select></div>
  <div class="field"><label for="question_4">Why do you want to work at Acme? *</label><textarea id="question_4" name="question_4" required></textarea></div>
  <div class="field"><label for="gender">Gender</label>
    <select id="gender" name="job_application[gender]"><option value="">Please select</option><option>Female</option><option>Male</option><option>Decline To Self Identify</option></select></div>
  <div class="field"><label for="hispanic">Are you Hispanic/Latino?</label>
    <select id="hispanic" name="job_application[hispanic_ethnicity]"><option value="">Please select</option><option>Yes</option><option>No</option><option>Decline To Self Identify</option></select></div>
  <div class="field"><label for="veteran">Veteran Status</label>
    <select id="veteran" name="job_application[veteran_status]"><option value="">Please select</option><option>I am not a protected veteran</option><option>I identify as one or more of the classifications of protected veteran</option><option>I don't wish to answer</option></select></div>
  ${extra}
  <button id="submit_app" type="submit">Submit Application</button>
</form></div>`,
  );

const LEVER = page(
  "Acme – Senior Marketing Manager",
  `<div class="lever-application"><h2>Submit your application</h2>
<form method="post" action="/ats/lever/acme/202/apply" enctype="multipart/form-data">
  <div class="application-question"><label>Resume/CV ✱<input type="file" name="resume" required></label></div>
  <div class="application-question"><label>Full name ✱<input name="name" required></label></div>
  <div class="application-question"><label>Email ✱<input name="email" type="email" required></label></div>
  <div class="application-question"><label>Phone<input name="phone"></label></div>
  <div class="application-question"><label>Current company<input name="org"></label></div>
  <div class="application-question"><label>LinkedIn URL<input name="urls[LinkedIn]"></label></div>
  <div class="application-question"><label>GitHub URL<input name="urls[GitHub]"></label></div>
  <div class="application-question"><label>What is your notice period? *<input name="cards[notice]" required></label></div>
  <div class="application-question"><label>Additional information<textarea name="comments"></textarea></label></div>
  <div class="application-question"><label>Gender<select name="eeo[gender]"><option value="">Select ...</option><option>Male</option><option>Female</option><option>Decline to self-identify</option></select></label></div>
  <button id="btn-submit" type="submit">Submit application</button>
</form></div>`,
);

const ASHBY = page(
  "Acme – Marketing Manager",
  `<div id="ashby_embed"><h1>Application</h1>
<form id="ashby-form" action="/ats/ashby/acme/303/application" method="post">
  <div><label for="_systemfield_name">Name *</label><input id="_systemfield_name" name="_systemfield_name" required></div>
  <div><label for="_systemfield_email">Email *</label><input id="_systemfield_email" name="_systemfield_email" type="email" required></div>
  <div><label for="_systemfield_resume">Resume *</label><input id="_systemfield_resume" name="_systemfield_resume" type="file" required></div>
  <div><label for="ph">Phone number</label><input id="ph" name="phone_q"></div>
  <div><label for="loc">Where are you located?</label><input id="loc" name="loc_q"></div>
  <fieldset><legend>Are you willing to relocate? *</legend>
    <label><input type="radio" name="relocate_q" value="yes" required> Yes</label>
    <label><input type="radio" name="relocate_q" value="no"> No</label></fieldset>
  <div><label for="sal">Salary expectations</label><input id="sal" name="salary_q"></div>
  <button class="ashby-application-form-submit-button" type="submit">Submit Application</button>
</form></div>
<script>
  // Ashby submits without leaving the page, and says so in it.
  document.getElementById("ashby-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    const body = [...data.entries()].map(([key, value]) => key + "=" + (typeof value === "string" ? value : value.name)).join("&");
    await fetch(event.target.action, { method: "POST", body });
    document.body.innerHTML = "<h1>Application submitted</h1><p>Thanks for applying to Acme.</p>";
  });
</script>`,
);

const GENERIC = page(
  "Join Acme",
  `<main><h1>Apply to Acme</h1>
<form method="post" action="/ats/careers/acme/apply" enctype="multipart/form-data">
  <p><label for="n">Your name</label> <input id="n" name="n" required></p>
  <p><label for="e">Email address</label> <input id="e" name="e" type="email" required></p>
  <p><label for="t">Mobile</label> <input id="t" name="t"></p>
  <p><label for="cv">Upload your CV</label> <input id="cv" name="cv" type="file" required></p>
  <p><label for="proud">Tell us about a marketing campaign you're proud of</label> <textarea id="proud" name="proud" required></textarea></p>
  <p><label for="licence">Do you hold a valid driver's license?</label>
    <select id="licence" name="licence" required><option value="">Choose</option><option>Yes</option><option>No</option></select></p>
  <button type="submit">Send application</button>
</form></main>`,
);

// A form whose site refuses what it's sent, as when an email was used before.
const REFUSING = GENERIC.replace('action="/ats/careers/acme/apply"', 'action="/ats/careers/refusing/apply"');
const REFUSED = REFUSING.replace("<h1>Apply to Acme</h1>", '<h1>Apply to Acme</h1><p role="alert">You already applied with this email address.</p>');

const CAPTCHA = GREENHOUSE("/ats/greenhouse/captcha/jobs/1", '<div class="g-recaptcha" data-sitekey="fake" style="width:300px;height:78px;border:1px solid #ccc">I\'m not a robot</div>');

const THANKS = page("Thank you", "<h1>Thank you for applying!</h1><p>We'll be in touch.</p>");

// ─── Workday ─────────────────────────────────────────────────────────────────

const WD = "/ats/workday/acme/job/404";
const wdId = (name: string) => `data-automation-id="${name}"`;
const wdInput = (name: string, label: string, type = "text", required = true) =>
  `<div ${wdId(`formField-${name}`)}><label for="${name}">${label}${required ? " *" : ""}</label><input id="${name}" name="${name}" ${wdId(name)} type="${type}" ${required ? 'aria-required="true"' : ""}></div>`;
const wdStep = (step: number, heading: string, fields: string) =>
  page(
    `Acme · ${heading}`,
    `<div ${wdId("applyFlowPage")}><h2>${heading}</h2>
<form method="post" action="${WD}/step/${step}" enctype="multipart/form-data">${fields}
<button ${wdId("bottom-navigation-next-button")} type="submit">Save and Continue</button></form></div>`,
  );

function workday(path: string, method: string, body: string, signedIn: boolean): { status?: number; html?: string; location?: string; cookie?: string } | null {
  const rest = path.slice(WD.length);
  if (rest === "") return { html: page("Marketing Manager · Acme", `<h1 ${wdId("jobPostingHeader")}>Marketing Manager</h1><a ${wdId("adventureButton")} href="${WD}/apply">Apply</a>`) };
  if (rest === "/apply") return { html: page("Start your application", `<h2>Start Your Application</h2><a ${wdId("applyManually")} href="${WD}/login">Apply Manually</a>`) };
  if (rest === "/login" && method === "GET") {
    return {
      html: page(
        "Sign In",
        `<h2>Sign In</h2><form method="post" action="${WD}/login">${wdInput("email", "Email Address", "email")}${wdInput("password", "Password", "password")}
<button ${wdId("signInSubmitButton")} type="submit">Sign In</button></form><a ${wdId("createAccountLink")} href="${WD}/create">Create Account</a>`,
      ),
    };
  }
  if (rest === "/login") {
    const form = new URLSearchParams(body);
    if (workdayAccounts.get(form.get("email") ?? "") !== form.get("password")) return { status: 303, location: `${WD}/login` };
    return { status: 303, location: `${WD}/step/1`, cookie: "wd=1" };
  }
  if (rest === "/create" && method === "GET") {
    return {
      html: page(
        "Create Account",
        `<h2>Create Account</h2><form method="post" action="${WD}/create">${wdInput("email", "Email Address", "email")}${wdInput("password", "Password", "password")}${wdInput("verifyPassword", "Verify New Password", "password")}
<label><input type="checkbox" ${wdId("createAccountCheckbox")} required> I agree to the terms</label>
<button ${wdId("createAccountSubmitButton")} type="submit">Create Account</button></form>`,
      ),
    };
  }
  if (rest === "/create") {
    const form = new URLSearchParams(body);
    workdayAccounts.set(form.get("email") ?? "", form.get("password") ?? "");
    return { status: 303, location: `${WD}/step/1`, cookie: "wd=1" };
  }
  if (!signedIn) return { status: 303, location: `${WD}/login` };
  if (rest === "/step/1" && method === "GET") {
    return { html: wdStep(1, "My Information", wdInput("legalNameSection_firstName", "First Name") + wdInput("legalNameSection_lastName", "Last Name") + wdInput("phone-number", "Phone Number", "tel") + wdInput("addressSection_city", "City") + wdInput("addressSection_postalCode", "Postal Code")) };
  }
  if (rest === "/step/2" && method === "GET") {
    return {
      html: wdStep(
        2,
        "My Experience",
        `<div ${wdId("formField-resume")}><label for="res">Resume/CV *</label><input id="res" type="file" name="resume" ${wdId("file-upload-input-ref")}></div>` + wdInput("linkedinQuestion", "LinkedIn", "url", false),
      ),
    };
  }
  if (rest === "/step/3" && method === "GET") {
    const select = (name: string, label: string, options: string[]) =>
      `<div ${wdId(`formField-${name}`)}><label for="${name}">${label} *</label><select id="${name}" name="${name}" required><option value="">Select One</option>${options.map((option) => `<option>${option}</option>`).join("")}</select></div>`;
    return {
      html: wdStep(
        3,
        "Application Questions",
        select("q1", "Are you legally authorized to work in the country in which this job is located?", ["Yes", "No"]) +
          select("q2", "Will you now or in the future require sponsorship for employment visa status?", ["Yes", "No"]) +
          select("q4", "Are you at least 18 years of age?", ["Yes", "No"]) +
          select("q3", "How did you hear about us?", ["Company Website", "LinkedIn", "Referral"]),
      ),
    };
  }
  const step = /^\/step\/(\d)$/.exec(rest);
  if (step && method === "POST") {
    submissions.push({ form: `workday-step-${step[1]}`, body });
    return { status: 303, location: step[1] === "3" ? `${WD}/review` : `${WD}/step/${Number(step[1]) + 1}` };
  }
  if (rest === "/review") {
    return {
      html: page(
        "Review",
        `<div ${wdId("applyFlowPage")}><h2>Review</h2><p>Check your application.</p><form method="post" action="${WD}/submit"><button ${wdId("bottom-navigation-next-button")} type="submit">Submit</button></form></div>`,
      ),
    };
  }
  if (rest === "/submit") {
    submissions.push({ form: "workday", body: "submitted" });
    return { status: 303, location: `${WD}/done` };
  }
  if (rest === "/done") return { html: page("Submitted", "<h1>Application Submitted</h1><p>Thank you for applying to Acme.</p>") };
  return null;
}

// ─── Serving ─────────────────────────────────────────────────────────────────

const FORMS: Record<string, string> = {
  "/ats/greenhouse/acme/jobs/101": GREENHOUSE("/ats/greenhouse/acme/jobs/101"),
  "/ats/greenhouse/captcha/jobs/1": CAPTCHA,
  "/ats/lever/acme/202/apply": LEVER,
  "/ats/ashby/acme/303/application": ASHBY,
  "/ats/careers/acme/apply": GENERIC,
  "/ats/careers/refusing/apply": REFUSING,
};
const THANK_YOU: Record<string, string> = {
  "/ats/greenhouse/acme/jobs/101": "/ats/greenhouse/acme/jobs/101/confirmation",
  "/ats/greenhouse/captcha/jobs/1": "/ats/greenhouse/captcha/jobs/1/confirmation",
  "/ats/lever/acme/202/apply": "/ats/lever/acme/202/thanks",
  "/ats/careers/acme/apply": "/ats/careers/acme/thank-you",
};

/** Answers a request under /ats/; false when it isn't one. */
export function serveAts(request: IncomingMessage, response: ServerResponse): boolean {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/ats-submissions") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ submissions }));
    return true;
  }
  if (url.pathname === "/ats-reset" && request.method === "POST") {
    submissions.length = 0;
    workdayAccounts.clear();
    response.writeHead(204).end();
    return true;
  }
  if (!url.pathname.startsWith("/ats/")) return false;
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const method = request.method ?? "GET";
    const html = (status: number, text: string) => response.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(text);
    if (url.pathname.startsWith(WD)) {
      const answer = workday(url.pathname, method, body, /(^|;\s*)wd=1/.test(request.headers.cookie ?? ""));
      if (!answer) return html(404, page("Not found", "<p>Not found</p>"));
      if (answer.location) {
        return response.writeHead(answer.status ?? 303, { location: answer.location, ...(answer.cookie ? { "set-cookie": `${answer.cookie}; Path=/` } : {}) }).end();
      }
      return html(answer.status ?? 200, answer.html!);
    }
    if (method === "POST" && url.pathname === "/ats/careers/refusing/apply") return html(422, REFUSED);
    if (method === "POST" && url.pathname in FORMS) {
      submissions.push({ form: url.pathname, body });
      if (THANK_YOU[url.pathname]) return response.writeHead(303, { location: THANK_YOU[url.pathname] }).end();
      return response.writeHead(204).end();
    }
    if (url.pathname in FORMS) return html(200, FORMS[url.pathname]);
    if (Object.values(THANK_YOU).includes(url.pathname)) return html(200, THANKS);
    html(404, page("Not found", "<p>Not found</p>"));
  });
  return true;
}
