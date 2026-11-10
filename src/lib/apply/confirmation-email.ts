import "server-only";

import { ApplyStatus } from "@/generated/prisma/enums";
import { googleConnection } from "@/lib/google/account";
import { getMessage, searchMessages, type ReadMail } from "@/lib/google/gmail";
import { companyKey } from "@/lib/google/matching";
import { logServerError } from "@/lib/log";
import { prisma } from "@/lib/prisma";

// After a submit, the employer's ATS usually mails a confirmation. With
// Gmail connected, the apply page looks for it once in a while for a few
// days and keeps its subject and sender with the attempt.

/** Mail the ATS sends from, besides the company's own domain. */
const ATS_SENDERS = /greenhouse(-mail)?\.io|lever\.co|hire\.lever\.co|ashbyhq\.com|workablemail\.com|workable\.com|smartrecruiters\.com|myworkday\.com|workday\.com/i;
const LOOKS_LIKE_CONFIRMATION = /thank|receiv|application|applying|submitted/i;

/** The mail that confirms an application to `company`, among mail received after the submit. */
export function pickConfirmation(mails: readonly Pick<ReadMail, "from" | "subject" | "text" | "date">[], company: string, submittedAt: Date): Pick<ReadMail, "from" | "subject"> | null {
  const key = companyKey(company);
  return (
    mails.find((mail) => {
      if (mail.date < submittedAt) return false;
      const about = `${mail.subject}\n${mail.text}`;
      if (!LOOKS_LIKE_CONFIRMATION.test(mail.subject)) return false;
      const namesCompany = key.length > 1 && companyKey(about).includes(key);
      return namesCompany || (ATS_SENDERS.test(mail.from) && company.trim() !== "" && about.toLowerCase().includes(company.trim().toLowerCase()));
    }) ?? null
  );
}

const LOOK_FOR_DAYS = 3;

/** Looks in Gmail for an attempt's confirmation mail, when there's none yet; never fails the page. */
export async function linkConfirmationEmail(attemptId: string): Promise<void> {
  try {
    const attempt = await prisma.applyAttempt.findUnique({ where: { id: attemptId }, select: { status: true, submittedAt: true, confirmationEmail: true, application: { select: { company: true } } } });
    if (!attempt || attempt.status !== ApplyStatus.SUBMITTED || !attempt.submittedAt || attempt.confirmationEmail) return;
    if (Date.now() - attempt.submittedAt.getTime() > LOOK_FOR_DAYS * 86_400_000) return;
    const google = await googleConnection();
    if (google.status !== "connected" || !google.canRead || google.signInProblem) return;
    const signal = AbortSignal.timeout(5_000);
    const after = Math.floor(attempt.submittedAt.getTime() / 1000) - 60;
    const ids = await searchMessages(`after:${after}`, { max: 15, signal });
    const mails = (await Promise.all(ids.map((id) => getMessage(id, signal)))).filter((mail): mail is ReadMail => mail !== null);
    const found = pickConfirmation(mails, attempt.application.company, new Date(attempt.submittedAt.getTime() - 60_000));
    if (found) await prisma.applyAttempt.update({ where: { id: attemptId }, data: { confirmationEmail: `${found.subject} · ${found.from}` } });
  } catch (error) {
    logServerError("auto-apply email", error);
  }
}
