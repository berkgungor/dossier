import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { DOSSIER_APPLY_TEST_ORIGINS: "http://localhost:3998" } }));
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => (host === "intranet.example" ? [{ address: "10.1.2.3", family: 4 }] : host === "jobs.example" ? [{ address: "93.184.216.34", family: 4 }] : Promise.reject(new Error("ENOTFOUND"))),
}));

const { browserMode, canTakeOver, isPublicHost, mayOpen } = await import("./browser");

describe("the apply browser", () => {
  it("opens only addresses on the public internet", async () => {
    expect(await mayOpen("https://jobs.example/apply")).toBe(true);
    expect(await mayOpen("https://intranet.example/")).toBe(false);
    expect(await mayOpen("http://127.0.0.1:5432/")).toBe(false);
    expect(await mayOpen("http://[::1]/")).toBe(false);
    expect(await mayOpen("http://nowhere.example/")).toBe(false);
    expect(await mayOpen("file:///etc/passwd")).toBe(false);
    expect(await mayOpen("not a url")).toBe(false);
    expect(await mayOpen("data:text/plain,hi")).toBe(true);
    expect(await isPublicHost("93.184.216.34")).toBe(true);
  });

  it("lets the end-to-end tests' fake forms through", async () => {
    expect(await mayOpen("http://localhost:3998/ats/careers/acme/apply")).toBe(true);
    expect(await mayOpen("http://localhost:3999/")).toBe(false);
  });

  it("is headless unless DOSSIER_APPLY_BROWSER says otherwise", () => {
    expect(browserMode()).toBe("headless");
    expect(canTakeOver()).toBe(false);
  });
});
