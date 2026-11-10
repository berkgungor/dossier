import { describe, expect, it } from "vitest";

import { newPassword, verificationLink } from "./workday";

describe("Workday accounts", () => {
  it("makes passwords Workday's rules accept, different each time", () => {
    const password = newPassword();
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/\d/);
    expect(password).toMatch(/[^A-Za-z0-9]/);
    expect(password.length).toBeGreaterThanOrEqual(16);
    expect(newPassword()).not.toBe(password);
  });

  it("finds the verification link in the site's mail", () => {
    expect(verificationLink("Hi,\nOpen https://acme.example/privacy or https://acme.wd1.myworkdayjobs.com/verify?token=abc to verify.")).toBe("https://acme.wd1.myworkdayjobs.com/verify?token=abc");
    expect(verificationLink("No links here.")).toBeNull();
  });
});
