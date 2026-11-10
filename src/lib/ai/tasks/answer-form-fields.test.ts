import { describe, expect, it } from "vitest";

import { demoProfile } from "@/lib/demo-profile";

import type { ChatCall } from "../provider";
import { MockProvider } from "../providers/mock";

import { ANSWER_FORM_FIELDS_VERSION, answerFormFields } from "./answer-form-fields";

const options = { creativity: "BALANCED" as const, strict: true, language: null };
const fields = [
  { id: "f0", label: "Why do you want to join?", type: "textarea" as const, name: "q0", required: true, options: [], current: "" },
  { id: "f1", label: "Driving licence?", type: "select" as const, name: "q1", required: true, options: ["Yes", "No"], current: "" },
];

describe("answerFormFields", () => {
  it("asks for the fields with the profile, without contact details, under the never-invent rule", async () => {
    let call: ChatCall | undefined;
    const provider = new MockProvider({
      reply: (received) => {
        call = received;
        return {
          answers: [
            { id: "f0", answer: "  I design payment flows.  ", note: "From your experience" },
            { id: "f1", answer: null, note: "Your profile doesn't say" },
            { id: "made-up", answer: "x", note: "" },
          ],
        };
      },
    });
    const { data, promptVersion } = await answerFormFields(provider, { profile: demoProfile(), posting: "Acme is hiring.", notes: ["Notice period: 1 month"], fields }, options);
    expect(promptVersion).toBe(ANSWER_FORM_FIELDS_VERSION);
    expect(data).toEqual([
      { id: "f0", answer: "I design payment flows.", note: "From your experience" },
      { id: "f1", answer: null, note: "Your profile doesn't say" },
    ]);
    expect(call!.system).toContain("Never invent experience");
    expect(call!.system).toContain("never agree to terms");
    const prompt = call!.messages[0].content;
    expect(prompt).toContain('"choices"');
    expect(prompt).toContain("Notice period: 1 month");
    expect(prompt).not.toContain(demoProfile().basics.email);
  });

  it("asks nothing when there's nothing to answer", async () => {
    const provider = new MockProvider();
    expect((await answerFormFields(provider, { profile: demoProfile(), posting: "", notes: [], fields: [] }, options)).data).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });

  it("leaves the never-invent rule out when strict mode is off", async () => {
    const provider = new MockProvider({ reply: () => ({ answers: [] }) });
    await answerFormFields(provider, { profile: demoProfile(), posting: "", notes: [], fields }, { ...options, strict: false });
    expect(provider.calls[0].system).not.toContain("Never invent experience");
  });
});
