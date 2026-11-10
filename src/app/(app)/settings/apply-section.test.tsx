import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_ANSWERS } from "@/lib/apply/answers";

import { saveApplyAnswers, updateSettings } from "./actions";
import { ApplySection } from "./apply-section";

vi.mock("./actions", () => ({
  updateSettings: vi.fn(async () => ({ ok: true, data: null })),
  saveApplyAnswers: vi.fn(async () => ({ ok: true, data: null })),
}));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));

const open = (answers = EMPTY_ANSWERS) => render(<ApplySection initial={{ answers, autoSubmit: false, agentAutoApply: false }} />);
const lastSaved = () => vi.mocked(saveApplyAnswers).mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.mocked(updateSettings).mockClear();
  vi.mocked(saveApplyAnswers).mockClear();
});

describe("Auto-apply settings", () => {
  it("saves the answer bank as it's filled in", async () => {
    const user = userEvent.setup();
    open();
    expect(screen.getByRole("heading", { name: "Auto-apply" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Are you authorized to work where you apply?"), "yes");
    await user.selectOptions(screen.getByLabelText("Do you need visa sponsorship?"), "no");
    await user.type(screen.getByLabelText("ZIP code"), "10001");
    await act(() => new Promise((resolve) => setTimeout(resolve, 700)));
    expect(lastSaved()).toMatchObject({ authorized: "yes", sponsorship: "no", postalCode: "10001" });
  });

  it("declines to self-identify, or keeps the user's own answer", async () => {
    const user = userEvent.setup();
    open();
    await user.selectOptions(screen.getByLabelText("Gender"), "decline");
    await user.selectOptions(screen.getByLabelText("Veteran status"), "My answer…");
    await user.type(screen.getByLabelText("Veteran status: your answer"), "Not a protected veteran");
    await act(() => new Promise((resolve) => setTimeout(resolve, 700)));
    expect(lastSaved()).toMatchObject({ gender: "decline", veteran: "Not a protected veteran" });
  });

  it("switches Submit without review and agent drafts on", async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole("switch", { name: "Submit without review" }));
    await user.click(screen.getByRole("switch", { name: "Fill in forms for approved agent drafts" }));
    expect(updateSettings).toHaveBeenCalledWith({ applyAutoSubmit: true });
    expect(updateSettings).toHaveBeenCalledWith({ agentAutoApply: true });
  });

  it("lists saved answers and removes one", async () => {
    const user = userEvent.setup();
    open({ ...EMPTY_ANSWERS, custom: [{ question: "Do you hold a valid driver's license?", answer: "Yes" }] });
    expect(screen.getByText("Do you hold a valid driver's license?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText("None yet.")).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 700)));
    expect(lastSaved()).toMatchObject({ custom: [] });
  });
});
