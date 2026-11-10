"use client";

import { useState } from "react";

import { useTrackSave } from "@/components/save-tracker";
import { toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { useAutosave } from "@/hooks/use-autosave";
import { DECLINE, type AnswerBank } from "@/lib/apply/answers";

import { saveApplyAnswers, updateSettings } from "./actions";
import { SettingsSectionIntro } from "./settings-screen";

type YesNo = "" | "yes" | "no";
type TextKey = "authorizationDetails" | "state" | "postalCode" | "salary" | "startDate" | "noticePeriod" | "howDidYouHear" | "github" | "portfolio";
type EeoKey = "gender" | "race" | "veteran" | "disability";

const YES_NO: { key: "authorized" | "sponsorship" | "relocate" | "over18" | "consent"; label: string; hint?: string }[] = [
  { key: "authorized", label: "Are you authorized to work where you apply?", hint: "In the US: authorized to work in the United States." },
  { key: "sponsorship", label: "Do you need visa sponsorship?", hint: "Now or in the future, e.g. an H-1B." },
  { key: "over18", label: "Are you at least 18 years old?" },
  { key: "relocate", label: "Are you willing to relocate?" },
  {
    key: "consent",
    label: "Accept privacy notices and account terms on forms",
    hint: "Yes lets Dossier tick a form's privacy-policy or data-processing box and make Workday accounts for you. Otherwise those stop for you.",
  },
];

const TEXTS: { key: TextKey; label: string; placeholder: string }[] = [
  { key: "authorizationDetails", label: "Work authorization, in words", placeholder: "e.g. US citizen, no sponsorship needed" },
  { key: "state", label: "State", placeholder: "e.g. New York" },
  { key: "postalCode", label: "ZIP code", placeholder: "e.g. 10001" },
  { key: "salary", label: "Salary expectation", placeholder: "e.g. $120,000 a year" },
  { key: "startDate", label: "Earliest start date", placeholder: "e.g. 1 February 2027, or Immediately" },
  { key: "noticePeriod", label: "Notice period", placeholder: "e.g. 1 month" },
  { key: "howDidYouHear", label: "How did you hear about the job?", placeholder: "e.g. Company website" },
  { key: "github", label: "GitHub", placeholder: "https://github.com/…" },
  { key: "portfolio", label: "Portfolio", placeholder: "https://…" },
];

const EEO: { key: EeoKey; label: string }[] = [
  { key: "gender", label: "Gender" },
  { key: "race", label: "Race or ethnicity" },
  { key: "veteran", label: "Veteran status" },
  { key: "disability", label: "Disability status" },
];

const LEAVE = "";
const OWN = "__own";

/**
 * Settings → Auto-apply: the answer bank for questions forms ask again and
 * again, and how far auto-apply may go on its own. Answers save as they're typed.
 */
export function ApplySection({ initial }: { initial: { answers: AnswerBank; autoSubmit: boolean; agentAutoApply: boolean } }) {
  const track = useTrackSave();
  const [answers, setAnswers] = useState(initial.answers);
  const [switches, setSwitches] = useState({ applyAutoSubmit: initial.autoSubmit, agentAutoApply: initial.agentAutoApply });
  useAutosave(answers, (value) => track(saveApplyAnswers(value)));

  const flip = (key: keyof typeof switches, on: boolean) => {
    const previous = switches;
    setSwitches({ ...switches, [key]: on });
    void track(updateSettings({ [key]: on })).then((result) => {
      if (!toastResult(result).ok) setSwitches(previous);
    });
  };
  const set = <K extends keyof AnswerBank>(key: K, value: AnswerBank[K]) => setAnswers((current) => ({ ...current, [key]: value }));

  return (
    <>
      <SettingsSectionIntro title="Auto-apply">
        Dossier fills in employers&apos; application forms from your profile, these answers and the tailored documents. It never invents an answer: a required
        question nothing here covers stops for you. Leave a question empty to answer it yourself each time.
      </SettingsSectionIntro>
      <Card padding="none" className="flex flex-col gap-5 px-7 py-[26px]">
        <Toggle
          label="Submit without review"
          description="When every field came from your profile and these answers, with nothing drafted by AI or missing, submit at once. Off: Dossier always stops before submitting."
          checked={switches.applyAutoSubmit}
          onCheckedChange={(on) => flip("applyAutoSubmit", on)}
        />
        <Toggle
          label="Fill in forms for approved agent drafts"
          description="When you approve a job agent draft, Dossier starts filling in its application form."
          checked={switches.agentAutoApply}
          onCheckedChange={(on) => flip("agentAutoApply", on)}
        />
      </Card>
      <Card padding="none" className="grid gap-x-[18px] gap-y-5 px-7 py-[26px] sm:grid-cols-2">
        {YES_NO.map(({ key, label, hint }) => (
          <Select key={key} label={label} hint={hint} value={answers[key]} onChange={(event) => set(key, event.target.value as YesNo)}>
            <option value="">Ask me each time</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </Select>
        ))}
        {TEXTS.map(({ key, label, placeholder }) => (
          <Input key={key} label={label} placeholder={placeholder} value={answers[key]} maxLength={key === "github" || key === "portfolio" ? 300 : 200} onChange={(event) => set(key, event.target.value)} />
        ))}
      </Card>
      <Card padding="none" className="flex flex-col gap-5 px-7 py-[26px]">
        <div className="flex flex-col gap-1.5">
          <h3 className="text-[15px] font-medium">Voluntary self-identification</h3>
          <p className="text-sm text-muted">The voluntary EEO questions US forms ask: gender, race or ethnicity (including Hispanic or Latino), veteran and disability status. “Decline to self-identify” picks the form&apos;s own decline choice.</p>
        </div>
        <div className="grid gap-x-[18px] gap-y-5 sm:grid-cols-2">
          {EEO.map(({ key, label }) => {
            const value = answers[key];
            const mode = value === LEAVE ? LEAVE : value === DECLINE ? DECLINE : OWN;
            return (
              <div key={key} className="flex flex-col gap-2">
                <Select label={label} value={mode} onChange={(event) => set(key, event.target.value === OWN ? " " : event.target.value)}>
                  <option value={LEAVE}>Leave it to me</option>
                  <option value={DECLINE}>Decline to self-identify</option>
                  <option value={OWN}>My answer…</option>
                </Select>
                {mode === OWN && <Input aria-label={`${label}: your answer`} value={value === " " ? "" : value} maxLength={120} onChange={(event) => set(key, event.target.value || " ")} />}
              </div>
            );
          })}
        </div>
      </Card>
      <Card padding="none" className="flex flex-col gap-4 px-7 py-[26px]">
        <div className="flex flex-col gap-1.5">
          <h3 className="text-[15px] font-medium">Saved answers</h3>
          <p className="text-sm text-muted">Answers you saved from a form&apos;s review, used again when a form asks the same question.</p>
        </div>
        {answers.custom.length === 0 ? (
          <p className="text-sm text-muted">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {answers.custom.map((entry) => (
              <li key={entry.question} className="flex items-start justify-between gap-4 border-t border-line pt-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{entry.question}</p>
                  <p className="text-sm whitespace-pre-wrap text-muted">{entry.answer}</p>
                </div>
                <Button variant="danger-text" size="sm" onClick={() => set("custom", answers.custom.filter((saved) => saved !== entry))}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
