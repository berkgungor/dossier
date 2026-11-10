import "server-only";

import { randomBytes } from "node:crypto";

import type { Page } from "playwright-core";
import { z } from "zod";

import { googleConnection } from "@/lib/google/account";
import { getMessage, searchMessages } from "@/lib/google/gmail";
import { APPLY_ACCOUNTS, decryptSecret, encryptSecret } from "@/lib/secrets";
import { loadSettings, saveSettings } from "@/lib/settings-data";

import { settle } from "./runtime";

// Workday (best effort): each employer's site wants a candidate account.
// Dossier makes one with the user's email and a password of its own, keeps
// it encrypted per site (APPLY_ACCOUNTS), and opens the verification link
// from Gmail when the site sends one. Without Gmail it stops for the user.

const accountsSchema = z.record(z.string(), z.object({ email: z.string(), password: z.string() }));
type Accounts = z.infer<typeof accountsSchema>;

async function loadAccounts(): Promise<Accounts> {
  const { applyAccountsEnc } = await loadSettings();
  if (!applyAccountsEnc) return {};
  try {
    return accountsSchema.parse(JSON.parse(decryptSecret(APPLY_ACCOUNTS, applyAccountsEnc)));
  } catch {
    // Unreadable after DOSSIER_SECRET changed: new accounts are made instead.
    return {};
  }
}

async function saveAccount(host: string, account: { email: string; password: string }): Promise<void> {
  const accounts = { ...(await loadAccounts()), [host]: account };
  await saveSettings({ applyAccountsEnc: encryptSecret(APPLY_ACCOUNTS, JSON.stringify(accounts)) });
}

/** A password Workday's rules accept: upper and lower case, a digit and a symbol. */
export function newPassword(): string {
  return `Dz${randomBytes(12).toString("base64url")}7!`;
}

/** The first link in a mail that verifies or activates an account. */
export function verificationLink(text: string): string | null {
  const links = text.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [];
  return links.find((link) => /verif|activat|confirm/i.test(link)) ?? null;
}

const VERIFY_WAIT_MS = 120_000;

/** Waits for the site's verification mail in Gmail and returns its link; null without Gmail or when none comes. */
async function verificationFromGmail(since: Date, signal: AbortSignal): Promise<string | null> {
  const google = await googleConnection();
  if (google.status !== "connected" || !google.canRead || google.signInProblem) return null;
  const deadline = Date.now() + VERIFY_WAIT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const ids = await searchMessages("newer_than:1d (verify OR verification OR activate OR confirm)", { max: 10, signal });
    for (const id of ids) {
      const mail = await getMessage(id, signal);
      if (!mail || mail.date < new Date(since.getTime() - 60_000)) continue;
      const link = verificationLink(mail.text);
      if (link) return link;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return null;
}

const id = (name: string) => `[data-automation-id="${name}"]`;
const isVisible = (page: Page, selector: string) => page.locator(selector).first().isVisible().catch(() => false);

export type SignInOutcome = { ok: true } | { ok: false; reason: "consent" | "verify" | "refused"; message: string };

/**
 * Gets past Workday's "Apply" choice and its sign-in: signs in with the
 * site's saved account, or makes one. Agreeing to the site's terms for the
 * account takes the answer bank's consent.
 */
export async function workdaySignIn(page: Page, { email, consent, signal }: { email: string; consent: boolean; signal: AbortSignal }): Promise<SignInOutcome> {
  if (await isVisible(page, id("applyManually"))) {
    await page.locator(id("applyManually")).first().click();
    await settle(page);
  }
  const passwordShown = async () => isVisible(page, 'input[type="password"]');
  if (!(await passwordShown()) && !(await isVisible(page, id("createAccountLink"))) && !(await isVisible(page, id("signInLink")))) return { ok: true };

  const host = new URL(page.url()).host;
  const saved = (await loadAccounts())[host];
  if (saved) {
    if (await isVisible(page, id("signInLink"))) {
      await page.locator(id("signInLink")).first().click();
      await settle(page);
    }
    await page.locator(id("email")).first().fill(saved.email);
    await page.locator(id("password")).first().fill(saved.password);
    await page.locator(id("signInSubmitButton")).first().click();
    await settle(page);
    if (await passwordShown()) return { ok: false, reason: "refused", message: `Workday didn't accept the account Dossier made on ${host}. Sign in yourself, then press Continue.` };
    return { ok: true };
  }

  if (!consent) {
    return { ok: false, reason: "consent", message: "Workday asks you to make an account and agree to its terms. Allow privacy consent in Settings → Auto-apply, or make the account yourself, then press Continue." };
  }
  if (await isVisible(page, id("createAccountLink"))) {
    await page.locator(id("createAccountLink")).first().click();
    await settle(page);
  }
  const password = newPassword();
  const started = new Date();
  await page.locator(id("email")).first().fill(email);
  await page.locator(id("password")).first().fill(password);
  await page.locator(id("verifyPassword")).first().fill(password);
  if (await isVisible(page, id("createAccountCheckbox"))) await page.locator(id("createAccountCheckbox")).first().check();
  await page.locator(id("createAccountSubmitButton")).first().click();
  await settle(page);
  await saveAccount(host, { email, password });

  // Some sites want the address verified before the account works.
  const text = await page.locator("body").innerText().catch(() => "");
  if (/verify|verification|activate/i.test(text) && (await passwordShown()) === false && !(await isVisible(page, id("applyFlowPage")))) {
    const link = await verificationFromGmail(started, signal);
    if (!link) return { ok: false, reason: "verify", message: `Workday sent a verification email to ${email}. Open its link, then press Continue.` };
    await page.goto(link, { waitUntil: "domcontentloaded" });
    await settle(page);
    await page.locator(id("email")).first().fill(email);
    await page.locator(id("password")).first().fill(password);
    await page.locator(id("signInSubmitButton")).first().click();
    await settle(page);
  }
  if (await passwordShown()) return { ok: false, reason: "refused", message: `Workday didn't accept the new account on ${host}. Finish signing in yourself, then press Continue.` };
  return { ok: true };
}
