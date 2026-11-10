import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { after } from "next/server";

import { ApplyStatus } from "@/generated/prisma/enums";
import { applyJobKey, applyUrlFor, notReady, readPlan } from "@/lib/apply/attempts";
import { adapterOf, type AtsId } from "@/lib/apply/ats";
import { browserMode } from "@/lib/apply/browser";
import { linkConfirmationEmail } from "@/lib/apply/confirmation-email";
import { findUnfinishedJobs } from "@/lib/jobs/runner";
import { prisma } from "@/lib/prisma";
import { loadSettings } from "@/lib/settings-data";

import { ApplyScreen } from "./apply-screen";

export const metadata: Metadata = { title: "Auto-apply" };

/** Auto-apply for one application: fill in the employer's form, review it, submit. */
export default async function ApplyPage({ params }: PageProps<"/applications/[id]/apply">) {
  const { id } = await params;
  const application = await prisma.application.findUnique({
    where: { id },
    select: { id: true, title: true, company: true, awaitingReview: true, documents: { select: { kind: true } } },
  });
  if (!application) notFound();

  const [latest, jobs, link, settings] = await Promise.all([
    prisma.applyAttempt.findFirst({
      where: { applicationId: id },
      orderBy: { createdAt: "desc" },
      omit: { screenshot: true, confirmation: true },
    }),
    findUnfinishedJobs(applyJobKey(id)),
    applyUrlFor(id),
    loadSettings(),
  ]);
  const shots = latest
    ? await prisma.applyAttempt.findUnique({ where: { id: latest.id }, select: { screenshot: true, confirmation: true } }).then((row) => ({ form: Boolean(row?.screenshot), confirmation: Boolean(row?.confirmation) }))
    : { form: false, confirmation: false };
  if (latest?.status === ApplyStatus.SUBMITTED && !latest.confirmationEmail) after(() => linkConfirmationEmail(latest.id));

  const adapter = latest ? adapterOf(latest.ats as AtsId) : null;
  return (
    <ApplyScreen
      application={{ id, title: application.title.trim() || "Untitled application", company: application.company }}
      problem={notReady(application)}
      link={link}
      attempt={
        latest && adapter
          ? {
              id: latest.id,
              status: latest.status,
              ats: adapter.id === "generic" ? null : adapter.label,
              bestEffort: Boolean(adapter.bestEffort),
              multiPage: Boolean(adapter.next),
              url: latest.url,
              plan: readPlan(latest.plan),
              message: latest.message,
              pageUrl: latest.pageUrl,
              confirmationUrl: latest.confirmationUrl,
              submittedAt: latest.submittedAt?.toISOString() ?? null,
              autoSubmitted: latest.autoSubmitted,
              confirmationEmail: latest.confirmationEmail,
              shots,
              version: latest.updatedAt.getTime(),
            }
          : null
      }
      jobId={jobs.at(-1)?.id ?? null}
      visibleBrowser={browserMode() !== "headless"}
      autoSubmit={settings.applyAutoSubmit}
    />
  );
}
