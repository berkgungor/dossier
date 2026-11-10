#!/usr/bin/env node
// A visible Chromium for auto-apply, on your own computer, for a Dossier
// that runs in Docker or on a server. Dossier fills in forms in it, and you
// take over in it for a captcha or a sign-in. Run it where you sit:
//
//   mkdir -p ~/.dossier-browser && cd ~/.dossier-browser
//   npm install playwright-core@1.64.1 && npx playwright-core install chromium
//   node /path/to/dossier/scripts/apply-browser.mjs
//
// It prints the address to set as DOSSIER_APPLY_BROWSER. The address holds a
// random token: anyone who has it can drive the browser, so keep it out of
// version control and don't expose the port to the internet. Options:
// --port <n> (default 9323), --host <address> (default 0.0.0.0, so Docker's
// host.docker.internal reaches it).

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

// playwright-core from the folder it's run in, not from Dossier's.
const require = createRequire(path.join(process.cwd(), "noop.js"));
let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch {
  console.error("playwright-core isn't installed here. Run: npm install playwright-core@1.64.1 && npx playwright-core install chromium");
  process.exit(1);
}

const port = Number(argument("port", "9323"));
const host = argument("host", "0.0.0.0");
const server = await chromium.launchServer({ headless: false, port, host, wsPath: `/${randomBytes(18).toString("base64url")}` });
const wsPath = new URL(server.wsEndpoint()).pathname;

console.log("Dossier's browser is running. Set this in Dossier's environment and restart it:\n");
console.log(`  DOSSIER_APPLY_BROWSER=ws://host.docker.internal:${port}${wsPath}   # Dossier in Docker on this computer`);
console.log(`  DOSSIER_APPLY_BROWSER=ws://<this computer's address>:${port}${wsPath}   # Dossier on another machine\n`);
console.log("Press Ctrl+C to stop it.");

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
