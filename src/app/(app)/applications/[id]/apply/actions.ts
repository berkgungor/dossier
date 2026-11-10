"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { action } from "@/lib/action";
import { cancelAttempt, continueAttempt, markAttemptSubmitted, setAttemptAnswers, startAutoApply, submitAttempt } from "@/lib/apply/attempts";

const attemptId = z.string().min(1);

/** Auto-apply: opens the employer's form and fills it in; it stops before submitting. */
export const startApplying = action(
  z.object({ applicationId: z.string().min(1), url: z.string().trim().max(2000).optional() }),
  async ({ applicationId, url }) => startAutoApply(applicationId, url),
);

/** Continue, after the user's turn in the browser. */
export const continueApplying = action(z.object({ attemptId }), async ({ attemptId }) => ({ jobId: await continueAttempt(attemptId) }));

/** The user's answers for fields the profile couldn't fill, put in the open form. */
export const setAnswers = action(
  z.object({ attemptId, values: z.array(z.object({ id: z.string().min(1), value: z.string().max(4000), save: z.boolean() })).max(100) }),
  async ({ attemptId, values }, { toast }) => {
    const plan = await setAttemptAnswers(attemptId, values);
    if (values.some((value) => value.save && value.value.trim())) toast("Saved to your answers in Settings → Auto-apply.");
    return { plan };
  },
);

/** Submit, after review. */
export const submitApplication = action(z.object({ attemptId }), async ({ attemptId }) => ({ jobId: await submitAttempt(attemptId) }));

/** "I submitted it myself": marks the application as sent. */
export const markSubmitted = action(z.object({ attemptId, applicationId: z.string().min(1) }), async ({ attemptId, applicationId }, { toast }) => {
  await markAttemptSubmitted(attemptId);
  revalidatePath(`/applications/${applicationId}`);
  toast("Marked as sent.");
  return null;
});

export const cancelApplying = action(z.object({ attemptId }), async ({ attemptId }, { toast }) => {
  await cancelAttempt(attemptId);
  toast("Stopped. Nothing was submitted.");
  return null;
});
