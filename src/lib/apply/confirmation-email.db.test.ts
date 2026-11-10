import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient, resetDatabase } from "@/test/db";

import { linkConfirmationEmail, pickConfirmation } from "./confirmation-email";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
const google = vi.hoisted(() => ({ connected: true, mails: [] as { id: string; from: string; subject: string; text: string; date: Date }[] }));
vi.mock("@/lib/google/account", () => ({
  googleConnection: async () => (google.connected ? { status: "connected", canRead: true, signInProblem: null } : { status: "disconnected" }),
}));
vi.mock("@/lib/google/gmail", () => ({
  searchMessages: async () => google.mails.map((mail) => mail.id),
  getMessage: async (id: string) => google.mails.find((mail) => mail.id === id) ?? null,
}));

const prisma = () => db.client!;
const submittedAt = new Date("2026-11-09T10:00:00Z");
const later = new Date("2026-11-09T10:05:00Z");

describe("pickConfirmation", () => {
  it("takes the mail after the submit that confirms an application to the company", () => {
    const mails = [
      { from: "news@shop.example", subject: "Thanks for your order", text: "", date: later },
      { from: "no-reply@greenhouse.io", subject: "Thank you for applying", text: "Your application to Acme Corp was received.", date: later },
      { from: "jobs@acme.example", subject: "Thanks for applying to Acme", text: "", date: new Date("2026-11-08T10:00:00Z") },
    ];
    expect(pickConfirmation(mails, "Acme Corp", submittedAt)?.from).toBe("no-reply@greenhouse.io");
    expect(pickConfirmation(mails, "Nowhere Ltd", submittedAt)).toBeNull();
  });
});

describe("linkConfirmationEmail", () => {
  beforeEach(async () => {
    await resetDatabase(prisma());
    google.connected = true;
    google.mails = [{ id: "m1", from: "Acme Careers <jobs@acme.example>", subject: "Thanks for applying to Acme", text: "We received your application.", date: later }];
    await prisma().application.create({ data: { id: "app", company: "Acme" } });
  });

  it("keeps the confirmation mail's subject and sender with a submitted attempt", async () => {
    await prisma().applyAttempt.create({ data: { id: "a", applicationId: "app", url: "https://x.example", status: "SUBMITTED", submittedAt: new Date(Date.now() - 60_000) } });
    google.mails[0].date = new Date();
    await linkConfirmationEmail("a");
    expect((await prisma().applyAttempt.findUniqueOrThrow({ where: { id: "a" } })).confirmationEmail).toBe("Thanks for applying to Acme · Acme Careers <jobs@acme.example>");
  });

  it("looks only for a recent submit, and only with Gmail connected", async () => {
    await prisma().applyAttempt.create({ data: { id: "old", applicationId: "app", url: "https://x.example", status: "SUBMITTED", submittedAt: new Date("2026-01-01") } });
    await prisma().applyAttempt.create({ data: { id: "open", applicationId: "app", url: "https://x.example", status: "REVIEW" } });
    await prisma().applyAttempt.create({ data: { id: "new", applicationId: "app", url: "https://x.example", status: "SUBMITTED", submittedAt: new Date() } });
    google.connected = false;
    for (const id of ["old", "open", "new", "missing"]) await linkConfirmationEmail(id);
    const found = await prisma().applyAttempt.findMany({ where: { confirmationEmail: { not: null } } });
    expect(found).toEqual([]);
  });
});
