import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import { env } from "@/lib/env";
import { isPublicAddress } from "@/lib/posting-fetch";

// Auto-apply's browser. Unlike the PDF printer's, it opens employers' sites,
// and a filled-in form stays open while the user reviews it: one page per
// attempt, kept in this process until it's submitted, cancelled, or left
// alone for SESSION_IDLE_MS. DOSSIER_APPLY_BROWSER says where it runs:
// headless here (the default), a visible window here ("headed"), or the
// user's computer, through scripts/apply-browser.mjs (a ws:// address),
// where the user can take over for a captcha or a sign-in.

/** A form waiting for review is closed after this long without anything done to it. */
export const SESSION_IDLE_MS = 30 * 60_000;

export type BrowserMode = "headless" | "headed" | "remote";

export function browserMode(): BrowserMode {
  const setting = env.DOSSIER_APPLY_BROWSER;
  if (!setting) return "headless";
  return setting === "headed" ? "headed" : "remote";
}

/** Whether the user can see the browser and finish a step in it themselves. */
export const canTakeOver = () => browserMode() !== "headless";

type Session = { context: BrowserContext; page: Page; timer: ReturnType<typeof setTimeout> | null; onExpire: () => void };
type State = { browser: Promise<Browser> | null; sessions: Map<string, Session> };

// On globalThis, so the dev server's hot reloads keep the open forms.
const globalForApply = globalThis as unknown as { applyBrowser?: State };
const state: State = (globalForApply.applyBrowser ??= { browser: null, sessions: new Map() });

function browser(): Promise<Browser> {
  if (!state.browser) {
    const setting = env.DOSSIER_APPLY_BROWSER;
    const launching =
      setting && setting !== "headed"
        ? chromium.connect(setting, { timeout: 15_000 })
        : chromium.launch({ headless: setting !== "headed", args: ["--disable-dev-shm-usage"] });
    launching.then(
      (launched) =>
        launched.on("disconnected", () => {
          if (state.browser === launching) state.browser = null;
          // The forms went with it.
          for (const [id, session] of state.sessions) {
            if (session.context.browser() === launched) void closeSession(id).then(session.onExpire);
          }
        }),
      () => {
        if (state.browser === launching) state.browser = null;
      },
    );
    state.browser = launching;
  }
  return state.browser;
}

/** Origins the end-to-end tests serve their fake forms from (DOSSIER_APPLY_TEST_ORIGINS). */
function testOrigins(): Set<string> {
  return new Set((env.DOSSIER_APPLY_TEST_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean));
}

const verdicts = new Map<string, Promise<boolean>>();

/** Whether a host is on the public internet, so a posting's link can't reach the server's own network. */
export function isPublicHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return Promise.resolve(isPublicAddress(host));
  let verdict = verdicts.get(host);
  if (!verdict) {
    verdict = lookup(host, { all: true }).then(
      (addresses) => addresses.length > 0 && addresses.every((entry) => isPublicAddress(entry.address)),
      () => false,
    );
    verdicts.set(host, verdict);
    // DNS answers change: ask again after a while.
    setTimeout(() => verdicts.delete(host), 10 * 60_000).unref?.();
  }
  return verdict;
}

/** Whether the browser may open an address: http(s) on the public internet, or a test origin. */
export async function mayOpen(address: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.protocol === "data:" || url.protocol === "blob:") return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (testOrigins().has(url.origin)) return true;
  return isPublicHost(url.hostname);
}

/** Opens a page for an attempt; `onExpire` runs when it's closed for being left alone. */
export async function openSession(id: string, onExpire: () => void): Promise<Page> {
  await closeSession(id);
  const context = await (await browser()).newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: false, locale: "en-US" });
  await context.route("**/*", async (route) => ((await mayOpen(route.request().url())) ? route.continue() : route.abort("blockedbyclient")));
  // A step that can't be done in this long is reported, not waited on.
  context.setDefaultTimeout(10_000);
  const page = await context.newPage();
  // A page that opens another (an "Apply" link with target=_blank) carries on in it.
  context.on("page", (opened) => {
    const session = state.sessions.get(id);
    if (session) session.page = opened;
  });
  state.sessions.set(id, { context, page, timer: null, onExpire });
  touchSession(id);
  return page;
}

/** The attempt's open page, or null when it's gone (closed, expired, or Dossier restarted). */
export function sessionPage(id: string): Page | null {
  const session = state.sessions.get(id);
  if (!session || session.page.isClosed()) return null;
  touchSession(id);
  return session.page;
}

/** Restarts the attempt's idle timer. */
function touchSession(id: string): void {
  const session = state.sessions.get(id);
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => void closeSession(id).then(session.onExpire), SESSION_IDLE_MS);
  session.timer.unref?.();
}

export async function closeSession(id: string): Promise<void> {
  const session = state.sessions.get(id);
  if (!session) return;
  state.sessions.delete(id);
  if (session.timer) clearTimeout(session.timer);
  await session.context.close().catch(() => {});
}

/** Closes every open form, e.g. before Delete everything. */
export async function closeAllSessions(): Promise<void> {
  await Promise.all([...state.sessions.keys()].map(closeSession));
}
