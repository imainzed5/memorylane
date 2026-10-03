import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, CircleAlert, Clock3, HardDrive, Monitor, PanelBottom, Plus, ShieldCheck, X } from "lucide-react";
import type { OcrHealthPayload, SensitiveCaptureMode, ThemeId, ThemeOption } from "../../types";
import { ICON_STROKE_WIDTH } from "../../constants";
import { Kbd, SegmentedControl } from "../primitives";
import { ThemePicker } from "./Dialogs";

export type OnboardingChoices = {
  excludedProcesses: string[];
  sensitiveWindowKeywords: string[];
  sensitiveCaptureMode: SensitiveCaptureMode;
  intervalMinutes: number;
  retentionDays: number;
};

type OnboardingModalProps = {
  initialChoices: OnboardingChoices;
  isSaving: boolean;
  ocrHealth: OcrHealthPayload | null;
  selectedThemeId: ThemeId;
  storagePath: string;
  themeOptions: ThemeOption[];
  onFinish: (choices: OnboardingChoices, startRecording: boolean) => void;
  onSelectTheme: (themeId: ThemeId) => void;
};

const STEPS = ["Welcome", "Privacy", "Finish"] as const;

// Rules match by case-insensitive substring of the process name, so no ".exe" needed.
const APP_SUGGESTIONS: Array<{ label: string; value: string }> = [
  { label: "1Password", value: "1password" },
  { label: "Bitwarden", value: "bitwarden" },
  { label: "KeePass", value: "keepass" },
  { label: "LastPass", value: "lastpass" },
];

const KEYWORD_SUGGESTIONS: Array<{ label: string; keywords: string[] }> = [
  { label: "Passwords", keywords: ["password"] },
  { label: "Banking", keywords: ["bank"] },
  { label: "One-time codes", keywords: ["otp", "verification code"] },
  { label: "Private browsing", keywords: ["inprivate", "incognito"] },
];

const DEFAULT_APPS = APP_SUGGESTIONS.map((app) => app.value);
const DEFAULT_KEYWORDS = KEYWORD_SUGGESTIONS.slice(0, 3).flatMap((group) => group.keywords);

const INTERVAL_CHOICES = [1, 5, 10, 15, 30];

const RETENTION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "7", label: "1 Week" },
  { value: "30", label: "1 Month" },
  { value: "90", label: "3 Months" },
  { value: "365", label: "1 Year" },
];

const MODE_OPTIONS: Array<{ value: SensitiveCaptureMode; label: string }> = [
  { value: "skip", label: "Skip" },
  { value: "redact", label: "Redact" },
  { value: "pause", label: "Pause" },
];

const MODE_HELP: Record<SensitiveCaptureMode, string> = {
  skip: "That screenshot is not saved at all.",
  redact: "The screenshot is saved blacked out, without the window title or app.",
  pause: "Recording pauses until you resume it.",
};

/** Seeds a fresh install with privacy-preserving suggestions; keeps any rules already set. */
export function withOnboardingDefaults(current: OnboardingChoices): OnboardingChoices {
  return {
    ...current,
    excludedProcesses: current.excludedProcesses.length > 0 ? current.excludedProcesses : DEFAULT_APPS,
    sensitiveWindowKeywords: current.sensitiveWindowKeywords.length > 0 ? current.sensitiveWindowKeywords : DEFAULT_KEYWORDS,
  };
}

const sameEntry = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * First-launch setup. Fresh installs start paused, so nothing is captured until the user
 * picks Start Recording here (or resumes later). Replaces the old theme + quick-start dialogs.
 */
export function OnboardingModal({
  initialChoices,
  isSaving,
  ocrHealth,
  selectedThemeId,
  storagePath,
  themeOptions,
  onFinish,
  onSelectTheme,
}: OnboardingModalProps) {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<"next" | "previous" | null>(null);
  const [choices, setChoices] = useState<OnboardingChoices>(() => withOnboardingDefaults(initialChoices));
  const [appDraft, setAppDraft] = useState("");
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // Move focus to each step's heading so screen readers announce the new step.
  useEffect(() => {
    if (direction) {
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [direction, step]);

  const goTo = (next: number) => {
    setDirection(next > step ? "next" : "previous");
    setStep(next);
  };

  const update = (patch: Partial<OnboardingChoices>) => setChoices((current) => ({ ...current, ...patch }));

  const toggleApp = (value: string) =>
    update({
      excludedProcesses: choices.excludedProcesses.some((entry) => sameEntry(entry, value))
        ? choices.excludedProcesses.filter((entry) => !sameEntry(entry, value))
        : [...choices.excludedProcesses, value],
    });

  const toggleKeywords = (keywords: string[]) => {
    const isOn = keywords.every((keyword) => choices.sensitiveWindowKeywords.some((entry) => sameEntry(entry, keyword)));
    update({
      sensitiveWindowKeywords: isOn
        ? choices.sensitiveWindowKeywords.filter((entry) => !keywords.some((keyword) => sameEntry(entry, keyword)))
        : [...choices.sensitiveWindowKeywords, ...keywords.filter((keyword) => !choices.sensitiveWindowKeywords.some((entry) => sameEntry(entry, keyword)))],
    });
  };

  const addCustomApps = (event: FormEvent) => {
    event.preventDefault();
    const additions = appDraft
      .split(/[,\n]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !choices.excludedProcesses.some((existing) => sameEntry(existing, entry)));
    if (additions.length > 0) {
      update({ excludedProcesses: [...choices.excludedProcesses, ...additions] });
    }
    setAppDraft("");
  };

  const customApps = choices.excludedProcesses.filter((entry) => !APP_SUGGESTIONS.some((app) => sameEntry(app.value, entry)));
  const intervalLabel = `${choices.intervalMinutes} minute${choices.intervalMinutes === 1 ? "" : "s"}`;
  const ocrReady = ocrHealth?.engineAvailable ?? false;

  return (
    <div className="sheet-overlay" role="presentation">
      <section className="sheet onboarding-sheet" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <header className="sheet-head onboarding-head">
          <ol className="onboarding-steps" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
            {STEPS.map((label, index) => (
              <li key={label} className={index === step ? "is-current" : index < step ? "is-done" : undefined} aria-current={index === step ? "step" : undefined}>
                <span className="onboarding-step-dot" aria-hidden="true">
                  {index < step ? <Check size={11} strokeWidth={3} /> : index + 1}
                </span>
                {label}
              </li>
            ))}
          </ol>
        </header>

        <div className="sheet-body onboarding-body">
          <div key={step} className={["onboarding-step", direction ? `slide-${direction}` : ""].join(" ").trim()}>
            {step === 0 ? (
              <>
                <div className="onboarding-intro">
                  <h2 id="onboarding-title" ref={headingRef} tabIndex={-1}>
                    Welcome to MemoryLane
                  </h2>
                  <p>A private, searchable record of what was on your screen, so you can always answer “what was I doing?”</p>
                </div>
                <div className="onboarding-facts">
                  <Fact icon={Monitor} title="Captures your main screen">
                    One screenshot every few minutes. Locked screens and blank frames are never saved.
                  </Fact>
                  <Fact icon={HardDrive} title="Stays on this PC">
                    Nothing is uploaded, ever.{storagePath ? <> Everything is stored in <code title={storagePath}>{storagePath}</code>.</> : null}
                  </Fact>
                  <Fact icon={PanelBottom} title="Lives in the tray">
                    Closing the window keeps it running. Pause any time with <Kbd>P</Kbd> or from the tray icon.
                  </Fact>
                </div>
                <p className="onboarding-note">
                  <ShieldCheck className="lucide-icon" size={14} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                  Recording stays off until you finish setup.
                </p>
              </>
            ) : null}

            {step === 1 ? (
              <>
                <div className="onboarding-intro">
                  <h2 id="onboarding-title" ref={headingRef} tabIndex={-1}>
                    Decide what stays private
                  </h2>
                  <p>Set these before the first screenshot. You can change them any time in Settings.</p>
                </div>

                <div className="onboarding-section">
                  <span className="field-label">Never capture these apps</span>
                  <div className="chip-grid" role="group" aria-label="Apps to never capture">
                    {APP_SUGGESTIONS.map((app) => {
                      const isOn = choices.excludedProcesses.some((entry) => sameEntry(entry, app.value));
                      return (
                        <button key={app.value} className={isOn ? "chip chip-choice active" : "chip chip-choice"} type="button" aria-pressed={isOn} onClick={() => toggleApp(app.value)}>
                          {isOn ? <Check size={12} strokeWidth={2.6} aria-hidden="true" /> : null}
                          {app.label}
                        </button>
                      );
                    })}
                    {customApps.map((entry) => (
                      <button key={entry} className="chip chip-choice active" type="button" aria-label={`Remove ${entry}`} onClick={() => toggleApp(entry)}>
                        {entry}
                        <X size={12} strokeWidth={2.6} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                  <form className="onboarding-add" onSubmit={addCustomApps}>
                    <input value={appDraft} placeholder="Add another app, e.g. slack.exe" aria-label="Add an app to never capture" onChange={(event) => setAppDraft(event.currentTarget.value)} />
                    <button className="button" type="submit" disabled={appDraft.trim().length === 0}>
                      <Plus className="lucide-icon" size={14} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                      Add
                    </button>
                  </form>
                </div>

                <div className="onboarding-section">
                  <span className="field-label">Watch for sensitive window titles</span>
                  <div className="chip-grid" role="group" aria-label="Sensitive window titles">
                    {KEYWORD_SUGGESTIONS.map((group) => {
                      const isOn = group.keywords.every((keyword) => choices.sensitiveWindowKeywords.some((entry) => sameEntry(entry, keyword)));
                      return (
                        <button key={group.label} className={isOn ? "chip chip-choice active" : "chip chip-choice"} type="button" aria-pressed={isOn} onClick={() => toggleKeywords(group.keywords)}>
                          {isOn ? <Check size={12} strokeWidth={2.6} aria-hidden="true" /> : null}
                          {group.label}
                        </button>
                      );
                    })}
                  </div>
                  <SegmentedControl ariaLabel="When a sensitive window is detected" options={MODE_OPTIONS} value={choices.sensitiveCaptureMode} onChange={(mode) => update({ sensitiveCaptureMode: mode })} stretch />
                  <p className="field-help">{MODE_HELP[choices.sensitiveCaptureMode]}</p>
                </div>

                <div className="onboarding-columns">
                  <div className="onboarding-section">
                    <span className="field-label">Capture every</span>
                    <div className="chip-grid" role="radiogroup" aria-label="Capture interval">
                      {INTERVAL_CHOICES.map((minutes) => (
                        <button
                          key={minutes}
                          className={minutes === choices.intervalMinutes ? "chip chip-choice active" : "chip chip-choice"}
                          type="button"
                          role="radio"
                          aria-checked={minutes === choices.intervalMinutes}
                          onClick={() => update({ intervalMinutes: minutes })}
                        >
                          {minutes} min
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="onboarding-section">
                    <span className="field-label">Keep screenshots for</span>
                    <SegmentedControl
                      ariaLabel="Keep screenshots for"
                      options={RETENTION_OPTIONS}
                      value={RETENTION_OPTIONS.some((option) => Number(option.value) === choices.retentionDays) ? String(choices.retentionDays) : null}
                      onChange={(value) => update({ retentionDays: Number(value) })}
                      size="sm"
                      stretch
                    />
                  </div>
                </div>
              </>
            ) : null}

            {step === 2 ? (
              <>
                <div className="onboarding-intro">
                  <h2 id="onboarding-title" ref={headingRef} tabIndex={-1}>
                    Make it yours
                  </h2>
                  <p>Pick a look, then start recording.</p>
                </div>

                <ThemePicker disabled={isSaving} options={themeOptions} selectedThemeId={selectedThemeId} onSelect={onSelectTheme} />

                <div className={ocrReady ? "onboarding-status is-ready" : "onboarding-status"}>
                  {ocrReady ? (
                    <Check className="lucide-icon" size={15} strokeWidth={2.4} aria-hidden="true" />
                  ) : (
                    <CircleAlert className="lucide-icon" size={15} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                  )}
                  <p>
                    {ocrReady ? (
                      <>
                        <strong>Text search is ready.</strong> Words on screen are searchable with <Kbd>Ctrl K</Kbd>.
                      </>
                    ) : (
                      <>
                        <strong>Text search needs Tesseract OCR.</strong> You can still browse by time and app. Install it any time, then reindex from Settings.
                      </>
                    )}
                  </p>
                </div>

                <p className="onboarding-tips">
                  <Clock3 className="lucide-icon" size={14} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                  <span>
                    Captures every {intervalLabel}. <Kbd>C</Kbd> captures now, <Kbd>Space</Kbd> opens Quick Look, <Kbd>?</Kbd> lists every shortcut.
                  </span>
                </p>
              </>
            ) : null}
          </div>
        </div>

        <footer className="sheet-foot">
          {step === 0 ? (
            <button className="button button-plain" type="button" onClick={() => onFinish(choices, false)} disabled={isSaving}>
              Skip Setup
            </button>
          ) : (
            <button className="button button-plain" type="button" onClick={() => goTo(step - 1)} disabled={isSaving}>
              Back
            </button>
          )}
          <span className="sheet-foot-spacer" />
          {step < STEPS.length - 1 ? (
            <button className="button button-accent" type="button" onClick={() => goTo(step + 1)}>
              Continue
            </button>
          ) : (
            <>
              <button className="button" type="button" onClick={() => onFinish(choices, false)} disabled={isSaving}>
                Finish Without Recording
              </button>
              <button className="button button-accent" type="button" onClick={() => onFinish(choices, true)} disabled={isSaving}>
                {isSaving ? "Saving…" : "Start Recording"}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

type FactProps = {
  icon: typeof Monitor;
  title: string;
  children: React.ReactNode;
};

function Fact({ icon: Icon, title, children }: FactProps) {
  return (
    <article className="onboarding-fact">
      <span className="onboarding-fact-icon" aria-hidden="true">
        <Icon className="lucide-icon" size={17} strokeWidth={ICON_STROKE_WIDTH} />
      </span>
      <div>
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
    </article>
  );
}
