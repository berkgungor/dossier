import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlanEntry } from "@/lib/apply/plan";

import { cancelApplying, continueApplying, markSubmitted, setAnswers, startApplying, submitApplication } from "./actions";
import { ApplyScreen, type AttemptView } from "./apply-screen";

vi.mock("./actions", () => ({
  startApplying: vi.fn(async () => ({ ok: true, data: { attemptId: "a", jobId: "job-1" } })),
  continueApplying: vi.fn(async () => ({ ok: true, data: { jobId: "job-2" } })),
  setAnswers: vi.fn(async () => ({ ok: true, data: { plan: [] } })),
  submitApplication: vi.fn(async () => ({ ok: true, data: { jobId: "job-3" } })),
  markSubmitted: vi.fn(async () => ({ ok: true, data: null })),
  cancelApplying: vi.fn(async () => ({ ok: true, data: null })),
}));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/hooks/use-job", () => ({ useJob: (id: string | null) => (id ? { id, status: "RUNNING", step: "Filling in the Greenhouse form", type: "", error: null, result: null } : null) }));

const entry = (overrides: Partial<PlanEntry>): PlanEntry => ({ id: "f0", label: "Field", type: "text", required: false, options: [], value: "", status: "filled", note: "", page: 1, ...overrides });
const attempt = (overrides: Partial<AttemptView>): AttemptView => ({
  id: "a",
  status: "REVIEW",
  ats: "Greenhouse",
  bestEffort: false,
  multiPage: false,
  url: "https://boards.greenhouse.io/acme/jobs/1",
  plan: [],
  message: null,
  pageUrl: "https://boards.greenhouse.io/acme/jobs/1",
  confirmationUrl: "",
  submittedAt: null,
  autoSubmitted: false,
  confirmationEmail: null,
  shots: { form: true, confirmation: false },
  version: 1,
  ...overrides,
});
const open = (props: Partial<Parameters<typeof ApplyScreen>[0]> = {}) =>
  render(
    <ApplyScreen
      application={{ id: "app", title: "Marketing Manager · Acme", company: "Acme" }}
      problem={null}
      link={{ url: "https://boards.greenhouse.io/acme/jobs/1", problem: null }}
      attempt={null}
      jobId={null}
      visibleBrowser={false}
      autoSubmit={false}
      {...props}
    />,
  );

beforeEach(() => {
  for (const mock of [startApplying, continueApplying, setAnswers, submitApplication, markSubmitted, cancelApplying]) vi.mocked(mock).mockClear();
});

describe("ApplyScreen", () => {
  it("starts filling in the form at the posting's link", async () => {
    const user = userEvent.setup();
    open();
    expect(screen.getByLabelText("Application form link")).toHaveValue("https://boards.greenhouse.io/acme/jobs/1");
    await user.click(screen.getByRole("button", { name: "Fill in the form" }));
    expect(startApplying).toHaveBeenCalledWith({ applicationId: "app", url: "https://boards.greenhouse.io/acme/jobs/1" });
    expect(await screen.findByRole("status")).toHaveTextContent("Filling in the Greenhouse form");
  });

  it("says why it can't start yet", () => {
    open({ problem: "Write the tailored resume first.", link: { url: null, problem: "Paste the link to the employer's application form." } });
    expect(screen.getByText("Write the tailored resume first.")).toBeInTheDocument();
    expect(screen.getByText("Paste the link to the employer's application form.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fill in the form" })).toBeDisabled();
  });

  it("shows every field for review, and keeps Submit off while a required one is empty", async () => {
    const user = userEvent.setup();
    open({
      attempt: attempt({
        plan: [
          entry({ id: "f0", label: "First Name", required: true, value: "Jane" }),
          entry({ id: "f1", label: "Resume", type: "file", value: "Resume.pdf", status: "document", note: "Tailored resume" }),
          entry({ id: "f2", label: "Driver's license?", type: "select", required: true, options: ["Yes", "No"], status: "needs-you", note: "Your profile doesn't say." }),
          entry({ id: "f3", label: "Why Acme?", type: "textarea", value: "I like it.", status: "drafted" }),
        ],
      }),
    });
    expect(screen.getByRole("img", { name: "The form as Dossier filled it in" })).toHaveAttribute("src", "/api/apply/a/screenshot?of=form&v=1");
    expect(screen.getByRole("row", { name: /Resume.*Attached/ })).toBeInTheDocument();
    expect(screen.getByText("Drafted by AI: check it")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit application" })).toBeDisabled();
    expect(screen.getByText(/One required field needs your answer/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Driver's license?"), "Yes");
    await user.click(screen.getAllByLabelText("Save to my answers")[0]);
    await user.click(screen.getByRole("button", { name: "Put my answers in the form" }));
    expect(setAnswers).toHaveBeenCalledWith({ attemptId: "a", values: [{ id: "f2", value: "Yes", save: true }] });
  });

  it("submits a reviewed form", async () => {
    const user = userEvent.setup();
    open({ attempt: attempt({ plan: [entry({ value: "Jane" })], message: "The form refused it: Email taken" }) });
    expect(screen.getByRole("alert")).toHaveTextContent("Email taken");
    await user.click(screen.getByRole("button", { name: "Submit application" }));
    expect(submitApplication).toHaveBeenCalledWith({ attemptId: "a" });
  });

  it("hands a captcha to the user, in the visible browser or on the site", async () => {
    const user = userEvent.setup();
    const stopped = attempt({ status: "NEEDS_YOU", message: "The form has a captcha. Dossier never solves captchas." });
    const { unmount } = open({ attempt: stopped, visibleBrowser: true });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(continueApplying).toHaveBeenCalledWith({ attemptId: "a" });
    unmount();

    open({ attempt: stopped });
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the form in your browser" })).toHaveAttribute("href", stopped.pageUrl);
    await user.click(screen.getByRole("button", { name: "I submitted it myself" }));
    expect(markSubmitted).toHaveBeenCalledWith({ attemptId: "a", applicationId: "app" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelApplying).toHaveBeenCalledWith({ attemptId: "a" });
  });

  it("shows a submitted application with its confirmation", () => {
    open({
      attempt: attempt({
        status: "SUBMITTED",
        autoSubmitted: true,
        submittedAt: "2026-11-09T10:00:00.000Z",
        confirmationUrl: "https://boards.greenhouse.io/acme/jobs/1/confirmation",
        confirmationEmail: "Thanks for applying · Acme <jobs@acme.example>",
        shots: { form: true, confirmation: true },
      }),
    });
    expect(screen.getByRole("heading", { name: "Submitted without review" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /confirmation$/ })).toBeInTheDocument();
    expect(screen.getByText(/Confirmation email: Thanks for applying/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "The page after submitting" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fill in again" })).toBeInTheDocument();
  });
});
