"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { PageHeader } from "@/components/page-header";
import { toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { ApplyStatus } from "@/generated/prisma/enums";
import { useJob } from "@/hooks/use-job";
import type { PlanEntry, PlanStatus } from "@/lib/apply/plan";

import { cancelApplying, continueApplying, markSubmitted, setAnswers, startApplying, submitApplication } from "./actions";

export type AttemptView = {
  id: string;
  status: ApplyStatus;
  /** The ATS's name, or null for a form Dossier read on its own. */
  ats: string | null;
  bestEffort: boolean;
  /** A form over several pages (Workday): Continue goes on to the next. */
  multiPage: boolean;
  url: string;
  plan: PlanEntry[];
  message: string | null;
  pageUrl: string;
  confirmationUrl: string;
  submittedAt: string | null;
  autoSubmitted: boolean;
  confirmationEmail: string | null;
  shots: { form: boolean; confirmation: boolean };
  /** Changes with each save, so a new screenshot isn't taken from the cache. */
  version: number;
};

const STATUS_TEXT: Record<PlanStatus, string> = {
  filled: "Filled in",
  document: "Attached",
  drafted: "Drafted by AI: check it",
  "needs-you": "Needs you",
  skipped: "Left empty",
};

const STATUS_CLASS: Record<PlanStatus, string> = {
  filled: "text-muted",
  document: "text-muted",
  drafted: "text-warning",
  "needs-you": "font-medium text-danger",
  skipped: "text-faint",
};

/** Entries the user can change: on the form's current page, and not a file. */
const editable = (entry: PlanEntry, page: number) => entry.page === page && entry.type !== "file";

export function ApplyScreen({
  application,
  problem,
  link,
  attempt,
  jobId,
  visibleBrowser,
  autoSubmit,
}: {
  application: { id: string; title: string; company: string };
  /** Why it can't start yet (no resume, an agent draft not approved), or null. */
  problem: string | null;
  /** The link to apply at, from the posting, or why there isn't one. */
  link: { url: string | null; problem: string | null };
  attempt: AttemptView | null;
  jobId: string | null;
  visibleBrowser: boolean;
  autoSubmit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [following, setFollowing] = useState(jobId);
  const [url, setUrl] = useState(link.url ?? "");
  const [values, setValues] = useState<Record<string, { value: string; save: boolean }>>({});
  const job = useJob(following, 0, (update) => {
    if (update.status === "DONE" || update.status === "FAILED") {
      setFollowing(null);
      setValues({});
      router.refresh();
    }
  });

  const run = (work: () => Promise<{ ok: boolean; data?: unknown }>) =>
    startTransition(async () => {
      const result = await work();
      const started = result.ok && typeof result.data === "object" && result.data !== null && "jobId" in result.data ? String(result.data.jobId) : null;
      if (started) setFollowing(started);
      router.refresh();
    });

  const working = following !== null || attempt?.status === "FILLING" || attempt?.status === "SUBMITTING";
  const open = attempt && ["REVIEW", "NEEDS_YOU"].includes(attempt.status);
  const page = Math.max(1, ...(attempt?.plan.map((entry) => entry.page) ?? []));
  const changed = Object.keys(values).length > 0;
  const blocking = attempt?.plan.filter((entry) => entry.status === "needs-you") ?? [];
  const backHref = `/applications/${application.id}`;

  return (
    <>
      <PageHeader
        title="Auto-apply"
        before={
          <Link href={backHref} className="text-meta text-muted hover:text-ink">
            ← {application.title}
          </Link>
        }
        description={`Dossier fills in ${application.company || "the employer"}'s application form from your profile, your answers and the tailored documents, then stops before submitting so you can check it.${autoSubmit ? " Submit without review is on: a form filled from your profile and answers alone, with nothing drafted or missing, is submitted at once." : ""}`}
      />
      <div className="flex flex-col gap-5 px-10 pb-16">
        {working && (
          <Card className="flex flex-wrap items-center justify-between gap-3" role="status">
            <p className="text-sm">{job?.step ?? (attempt?.status === "SUBMITTING" ? "Submitting…" : "Opening the form…")}</p>
            {attempt && (
              <Button variant="text" disabled={pending} onClick={() => run(async () => toastResult(await cancelApplying({ attemptId: attempt.id })))}>
                Cancel
              </Button>
            )}
          </Card>
        )}

        {!working && attempt?.status === "SUBMITTED" && (
          <Card className="flex flex-col gap-3" role="status">
            <h2 className="text-[15px] font-medium">Submitted{attempt.autoSubmitted ? " without review" : ""}</h2>
            <p className="text-sm text-muted">
              {attempt.submittedAt && `On ${new Date(attempt.submittedAt).toLocaleString()}. `}The application is marked as sent.
            </p>
            {attempt.confirmationUrl && (
              <p className="text-sm break-all">
                Confirmation page:{" "}
                <a href={attempt.confirmationUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                  {attempt.confirmationUrl}
                </a>
              </p>
            )}
            {attempt.confirmationEmail && <p className="text-sm">Confirmation email: {attempt.confirmationEmail}</p>}
            {attempt.shots.confirmation && <Screenshot attempt={attempt} of="confirmation" />}
          </Card>
        )}

        {!working && open && attempt && (
          <>
            {attempt.message && (
              <Card className={attempt.status === "NEEDS_YOU" ? "border-warning" : ""} role="alert">
                <p className="text-sm text-pretty">{attempt.message}</p>
              </Card>
            )}
            <Card padding="none" className="flex flex-col gap-4 px-7 py-6">
              <div className="flex flex-col gap-1">
                <h2 className="text-[15px] font-medium">
                  {attempt.ats ? `${attempt.ats} form` : "The form"}
                  {attempt.bestEffort && " · best effort"}
                </h2>
                <p className="text-meta text-muted break-all">{attempt.pageUrl || attempt.url}</p>
              </div>
              {attempt.plan.length > 0 && (
                <table className="w-full text-sm">
                  <caption className="sr-only">What Dossier put in each field</caption>
                  <thead>
                    <tr className="text-left text-meta text-muted">
                      <th scope="col" className="py-2 pr-4 font-normal">Field</th>
                      <th scope="col" className="py-2 pr-4 font-normal">Value</th>
                      <th scope="col" className="py-2 font-normal">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attempt.plan.map((entry) => {
                      const edit = values[entry.id];
                      const canEdit = editable(entry, page) && attempt.status === "REVIEW";
                      return (
                        <tr key={`${entry.page}-${entry.id}`} className="border-t border-line align-top">
                          <th scope="row" className="py-2.5 pr-4 font-normal">
                            {entry.label}
                            {entry.required && <span className="text-muted"> (required)</span>}
                          </th>
                          <td className="py-2.5 pr-4">
                            {canEdit ? (
                              <div className="flex flex-col gap-1.5">
                                {entry.options.length > 0 ? (
                                  <select
                                    aria-label={entry.label}
                                    className="rounded-control border border-line-control bg-input px-2 py-1.5"
                                    value={edit?.value ?? entry.value}
                                    onChange={(event) => setValues({ ...values, [entry.id]: { value: event.target.value, save: edit?.save ?? false } })}
                                  >
                                    <option value="">Choose…</option>
                                    {entry.options.map((option) => (
                                      <option key={option}>{option}</option>
                                    ))}
                                  </select>
                                ) : (
                                  <Input
                                    aria-label={entry.label}
                                    value={edit?.value ?? entry.value}
                                    onChange={(event) => setValues({ ...values, [entry.id]: { value: event.target.value, save: edit?.save ?? false } })}
                                  />
                                )}
                                {(entry.status === "needs-you" || entry.status === "drafted") && (
                                  <Checkbox
                                    label="Save to my answers"
                                    checked={edit?.save ?? false}
                                    onChange={(event) => setValues({ ...values, [entry.id]: { value: edit?.value ?? entry.value, save: event.target.checked } })}
                                  />
                                )}
                              </div>
                            ) : (
                              <span className="whitespace-pre-wrap">{entry.type === "checkbox" ? (entry.value === "yes" ? "Ticked" : "Not ticked") : entry.value || "—"}</span>
                            )}
                          </td>
                          <td className="py-2.5">
                            <span className={STATUS_CLASS[entry.status]}>{STATUS_TEXT[entry.status]}</span>
                            {entry.note && <p className="text-meta text-muted">{entry.note}</p>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {attempt.status === "REVIEW" && changed && (
                  <Button
                    variant="secondary"
                    disabled={pending}
                    onClick={() =>
                      run(async () => {
                        const result = toastResult(await setAnswers({ attemptId: attempt.id, values: Object.entries(values).map(([id, entry]) => ({ id, ...entry })) }));
                        if (result.ok) setValues({});
                        return result;
                      })
                    }
                  >
                    Put my answers in the form
                  </Button>
                )}
                {attempt.status === "REVIEW" && (
                  <Button disabled={pending || changed || blocking.length > 0} onClick={() => run(async () => toastResult(await submitApplication({ attemptId: attempt.id })))}>
                    Submit application
                  </Button>
                )}
                {((attempt.status === "NEEDS_YOU" && visibleBrowser) || (attempt.status === "REVIEW" && attempt.multiPage && !changed && blocking.length === 0)) && (
                  <Button variant="secondary" disabled={pending} onClick={() => run(async () => toastResult(await continueApplying({ attemptId: attempt.id })))}>
                    Continue
                  </Button>
                )}
                {attempt.status === "NEEDS_YOU" && !visibleBrowser && attempt.pageUrl && (
                  <a href={attempt.pageUrl} target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-2">
                    Open the form in your browser
                  </a>
                )}
                {attempt.status === "NEEDS_YOU" && (
                  <Button variant="text" disabled={pending} onClick={() => run(async () => toastResult(await markSubmitted({ attemptId: attempt.id, applicationId: application.id })))}>
                    I submitted it myself
                  </Button>
                )}
                <Button variant="text" disabled={pending} onClick={() => run(async () => toastResult(await cancelApplying({ attemptId: attempt.id })))}>
                  Cancel
                </Button>
              </div>
              {blocking.length > 0 && attempt.status === "REVIEW" && (
                <p className="text-meta text-muted">
                  {blocking.length === 1 ? "One required field needs" : `${blocking.length} required fields need`} your answer before you can submit. Dossier never guesses them.
                </p>
              )}
            </Card>
            {attempt.shots.form && <Screenshot attempt={attempt} of="form" />}
          </>
        )}

        {!working && !open && (
          <Card padding="none" className="flex flex-col gap-4 px-7 py-6">
            {attempt && (attempt.status === "FAILED" || attempt.status === "CANCELLED") && attempt.message && (
              <p role="alert" className="text-sm text-pretty">
                The last attempt stopped: {attempt.message}
              </p>
            )}
            <Input
              label="Application form link"
              hint={link.problem && !url ? link.problem : "The employer's own form: Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Workday (best effort) or any other. Not LinkedIn's Easy Apply."}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://…"
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                disabled={pending || Boolean(problem) || !url.trim()}
                onClick={() => run(async () => toastResult(await startApplying({ applicationId: application.id, url })))}
              >
                {attempt?.status === "SUBMITTED" ? "Fill in again" : "Fill in the form"}
              </Button>
              {problem && <p className="text-sm text-muted">{problem}</p>}
            </div>
            <p className="text-meta text-muted">
              {visibleBrowser
                ? "Dossier's browser window shows what it does. If the form has a captcha or a sign-in, you finish that step there."
                : "Dossier's browser is hidden. A captcha or a sign-in stops it, and you finish on the employer's site."}
            </p>
          </Card>
        )}
      </div>
    </>
  );
}

function Screenshot({ attempt, of }: { attempt: AttemptView; of: "form" | "confirmation" }) {
  const src = `/api/apply/${attempt.id}/screenshot?of=${of}&v=${attempt.version}`;
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="block w-full max-w-[900px] overflow-hidden rounded-panel border border-line-card">
      {/* eslint-disable-next-line @next/next/no-img-element -- a screenshot from the app's own route, not an asset to optimize */}
      <img src={src} alt={of === "form" ? "The form as Dossier filled it in" : "The page after submitting"} className="w-full" />
    </a>
  );
}
