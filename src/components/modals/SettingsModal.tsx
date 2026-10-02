import { useRef, useState, type MutableRefObject } from "react";
import { Clock3, Database, Palette, Power, Shield, ShieldCheck, X } from "lucide-react";
import type {
  OcrHealthPayload,
  PerformanceSnapshotPayload,
  SensitiveCaptureMode,
  StorageStatsPayload,
  ThemeId,
  ThemeOption,
} from "../../types";
import { ICON_STROKE_WIDTH, INTERVAL_MAX_MINUTES, INTERVAL_MIN_MINUTES, INTERVAL_OPTIONS } from "../../constants";
import { clampIntervalMinutes, formatStorageValue } from "../../utils/app";
import { SegmentedControl } from "../primitives";
import { ThemePicker } from "./Dialogs";

type StatusTone = "neutral" | "success" | "error";

export type SettingsModalProps = {
  backupImportPath: string;
  backupPassphrase: string;
  backupStatus: string;
  backupStatusTone: StatusTone;
  draftExcludedProcessesText: string;
  draftExcludedWindowKeywordsText: string;
  draftIntervalMinutes: number;
  draftPauseProcessesText: string;
  draftPauseWindowKeywordsText: string;
  draftRetentionDays: number;
  draftSensitiveCaptureMode: SensitiveCaptureMode;
  draftSensitiveWindowKeywordsText: string;
  draftStartupOnBoot: boolean;
  draftStorageCapGb: number;
  draftThemeId: ThemeId;
  isBackupBusy: boolean;
  isCustomInterval: boolean;
  isReindexBusy: boolean;
  maintenanceProgress: number;
  maintenanceStage: string;
  ocrHealth: OcrHealthPayload;
  ocrReindexStatus: string;
  ocrReindexStatusTone: StatusTone;
  performanceSnapshot: PerformanceSnapshotPayload;
  settingsDirty: boolean;
  startupOnBootSupported: boolean;
  storagePath: string;
  storageStats: StorageStatsPayload;
  themeOptions: ThemeOption[];
  onBackupImportPathChange: (nextValue: string) => void;
  onBackupPassphraseChange: (nextValue: string) => void;
  onClose: () => void;
  onDraftExcludedProcessesTextChange: (nextValue: string) => void;
  onDraftExcludedWindowKeywordsTextChange: (nextValue: string) => void;
  onDraftIntervalChange: (nextValue: number) => void;
  onDraftPauseProcessesTextChange: (nextValue: string) => void;
  onDraftPauseWindowKeywordsTextChange: (nextValue: string) => void;
  onDraftRetentionChange: (nextValue: number) => void;
  onDraftSensitiveCaptureModeChange: (nextValue: SensitiveCaptureMode) => void;
  onDraftSensitiveWindowKeywordsTextChange: (nextValue: string) => void;
  onDraftStartupOnBootChange: (nextValue: boolean) => void;
  onDraftStorageCapChange: (nextValue: number) => void;
  onDraftThemeChange: (nextValue: ThemeId) => void;
  onEnableCustomInterval: () => void;
  onExportBackup: () => void;
  onImportBackup: () => void;
  onOpenCapturesFolder: () => void;
  onReindexAllCaptures: () => void;
  onResetDraft: () => void;
  onSaveSettings: () => void;
  onSelectPresetInterval: (nextValue: number) => void;
};

type SectionId = "appearance" | "privacy" | "cadence" | "startup" | "storage" | "backup";

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: "appearance", label: "Appearance" },
  { id: "privacy", label: "Privacy" },
  { id: "cadence", label: "Cadence" },
  { id: "startup", label: "Startup" },
  { id: "storage", label: "Storage" },
  { id: "backup", label: "Backup" },
];

const SENSITIVE_MODE_OPTIONS: Array<{ value: SensitiveCaptureMode; label: string }> = [
  { value: "skip", label: "Skip" },
  { value: "redact", label: "Redact" },
  { value: "pause", label: "Pause" },
];

const SENSITIVE_MODE_HELP: Record<SensitiveCaptureMode, string> = {
  skip: "Matching captures are not saved at all.",
  redact: "Matching captures are saved with the image and metadata blacked out.",
  pause: "Recording pauses until you resume it.",
};

function statusClass(tone: StatusTone): string {
  return tone === "error" ? "field-help warning" : tone === "success" ? "field-help success" : "field-help";
}

export function SettingsModal(props: SettingsModalProps) {
  const {
    backupImportPath,
    backupPassphrase,
    backupStatus,
    backupStatusTone,
    draftExcludedProcessesText,
    draftExcludedWindowKeywordsText,
    draftIntervalMinutes,
    draftPauseProcessesText,
    draftPauseWindowKeywordsText,
    draftRetentionDays,
    draftSensitiveCaptureMode,
    draftSensitiveWindowKeywordsText,
    draftStartupOnBoot,
    draftStorageCapGb,
    draftThemeId,
    isBackupBusy,
    isCustomInterval,
    isReindexBusy,
    maintenanceProgress,
    maintenanceStage,
    ocrHealth,
    ocrReindexStatus,
    ocrReindexStatusTone,
    performanceSnapshot,
    settingsDirty,
    startupOnBootSupported,
    storagePath,
    storageStats,
    themeOptions,
  } = props;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<SectionId, HTMLElement | null>>({
    appearance: null,
    privacy: null,
    cadence: null,
    startup: null,
    storage: null,
    backup: null,
  });
  const [activeSection, setActiveSection] = useState<SectionId>("appearance");
  const ignoreScrollUntilRef = useRef(0);

  const goToSection = (id: SectionId) => {
    setActiveSection(id);
    // Don't let the smooth scroll drag the switcher through the sections in between.
    ignoreScrollUntilRef.current = performance.now() + 700;
    sectionRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Keep the switcher in sync while scrolling: the last section whose top has passed the viewport top wins.
  const syncActiveSection = () => {
    const container = scrollRef.current;
    if (!container || performance.now() < ignoreScrollUntilRef.current) {
      return;
    }
    const threshold = container.getBoundingClientRect().top + 24;
    let current: SectionId = "appearance";
    for (const { id } of SECTIONS) {
      const section = sectionRefs.current[id];
      if (section && section.getBoundingClientRect().top <= threshold) {
        current = id;
      }
    }
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 4) {
      current = SECTIONS[SECTIONS.length - 1].id;
    }
    setActiveSection(current);
  };

  const bindSection = (id: SectionId) => (element: HTMLElement | null) => {
    (sectionRefs as MutableRefObject<Record<SectionId, HTMLElement | null>>).current[id] = element;
  };

  return (
    <div className="sheet-overlay" role="presentation" onClick={props.onClose}>
      <section className="sheet settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
        <header className="sheet-head">
          <div>
            <h2 id="settings-title">Settings</h2>
            <p>{settingsDirty ? "You have unsaved changes" : "All changes saved"}</p>
          </div>
          <button className="sheet-close" type="button" onClick={props.onClose} aria-label="Close settings" title="Close (Esc)">
            <X className="lucide-icon" size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </header>

        <div className="sheet-switcher">
          <SegmentedControl ariaLabel="Settings sections" options={SECTIONS.map(({ id, label }) => ({ value: id, label }))} value={activeSection} onChange={goToSection} size="sm" stretch />
        </div>

        <div ref={scrollRef} className="sheet-body" onScroll={syncActiveSection}>
          <section className="settings-group" ref={bindSection("appearance")}>
            <h3>
              <Palette className="lucide-icon" size={15} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
              Appearance
            </h3>
            <ThemePicker options={themeOptions} selectedThemeId={draftThemeId} onSelect={props.onDraftThemeChange} />
          </section>

          <section className="settings-group" ref={bindSection("privacy")}>
            <h3>
              <Shield className="lucide-icon" size={15} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
              Privacy
            </h3>
            <p className="field-help">MemoryLane is local-first. These rules decide what gets skipped, auto-paused or redacted.</p>

            <div className="field-grid">
              <ListField id="excluded-processes-input" label="Never capture these apps" placeholder="banking.exe, password-manager.exe" help="Process names, separated by commas or new lines." value={draftExcludedProcessesText} onChange={props.onDraftExcludedProcessesTextChange} />
              <ListField id="excluded-windows-input" label="Never capture windows containing" placeholder="Payroll, HR portal" help="Skips capture when a window title contains any of these." value={draftExcludedWindowKeywordsText} onChange={props.onDraftExcludedWindowKeywordsTextChange} />
              <ListField id="pause-processes-input" label="Pause recording for these apps" placeholder="teams.exe, zoom.exe" help="Recording pauses while one of these is in front." value={draftPauseProcessesText} onChange={props.onDraftPauseProcessesTextChange} />
              <ListField id="pause-windows-input" label="Pause recording for windows containing" placeholder="Interview panel, Incognito" help="Strict pause rules by window title." value={draftPauseWindowKeywordsText} onChange={props.onDraftPauseWindowKeywordsTextChange} />
              <ListField id="sensitive-keywords-input" label="Sensitive keywords" placeholder="password, otp, bank" help="When a window title matches, use the mode below." value={draftSensitiveWindowKeywordsText} onChange={props.onDraftSensitiveWindowKeywordsTextChange} />
              <div className="field">
                <span className="field-label">When sensitive content is detected</span>
                <SegmentedControl ariaLabel="Sensitive capture mode" options={SENSITIVE_MODE_OPTIONS} value={draftSensitiveCaptureMode} onChange={props.onDraftSensitiveCaptureModeChange} stretch />
                <p className="field-help">{SENSITIVE_MODE_HELP[draftSensitiveCaptureMode]}</p>
              </div>
            </div>
          </section>

          <section className="settings-group" ref={bindSection("cadence")}>
            <h3>
              <Clock3 className="lucide-icon" size={15} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
              Capture cadence
              <span className="settings-group-meta">Every {draftIntervalMinutes} min</span>
            </h3>
            <div className="chip-grid" role="radiogroup" aria-label="Capture interval">
              {INTERVAL_OPTIONS.map((option) => (
                <button
                  key={option}
                  className={option === draftIntervalMinutes && !isCustomInterval ? "chip chip-choice active" : "chip chip-choice"}
                  type="button"
                  role="radio"
                  aria-checked={option === draftIntervalMinutes && !isCustomInterval}
                  onClick={() => props.onSelectPresetInterval(option)}
                >
                  {option < 60 ? `${option} min` : `${option / 60} hr`}
                </button>
              ))}
              <button className={isCustomInterval ? "chip chip-choice active" : "chip chip-choice"} type="button" role="radio" aria-checked={isCustomInterval} onClick={props.onEnableCustomInterval}>
                Custom
              </button>
            </div>
            {isCustomInterval ? (
              <label className="field field-inline" htmlFor="interval-minutes">
                <span className="field-label">Minutes between captures</span>
                <input
                  id="interval-minutes"
                  type="number"
                  min={INTERVAL_MIN_MINUTES}
                  max={INTERVAL_MAX_MINUTES}
                  step={1}
                  value={draftIntervalMinutes}
                  onChange={(event) => props.onDraftIntervalChange(clampIntervalMinutes(Math.round(Number(event.currentTarget.value) || INTERVAL_MIN_MINUTES)))}
                />
                <p className="field-help">
                  Between {INTERVAL_MIN_MINUTES} and {INTERVAL_MAX_MINUTES}.
                </p>
              </label>
            ) : null}
          </section>

          <section className="settings-group" ref={bindSection("startup")}>
            <h3>
              <Power className="lucide-icon" size={15} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
              Startup
            </h3>
            <label className={startupOnBootSupported ? "switch-row" : "switch-row is-disabled"} htmlFor="startup-on-boot">
              <span className="switch-copy">
                <strong>Open MemoryLane when Windows starts</strong>
                <span>{startupOnBootSupported ? "Starts in the tray after you sign in so capture keeps running." : "Not available in this build."}</span>
              </span>
              <input
                id="startup-on-boot"
                className="switch"
                type="checkbox"
                role="switch"
                checked={draftStartupOnBoot}
                disabled={!startupOnBootSupported}
                onChange={(event) => props.onDraftStartupOnBootChange(event.currentTarget.checked)}
              />
            </label>
          </section>

          <section className="settings-group" ref={bindSection("storage")}>
            <h3>
              <Database className="lucide-icon" size={15} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
              Storage
              <span className="settings-group-meta">
                {formatStorageValue(storageStats.usedGb)} of {storageStats.storageCapGb.toFixed(1)} GB
              </span>
            </h3>
            <div className="meter" role="presentation">
              <span style={{ width: `${Math.max(0, Math.min(100, storageStats.usagePercent))}%` }} />
            </div>
            <div className="field-grid">
              <label className="field" htmlFor="retention-days">
                <span className="field-label">Keep captures for (days)</span>
                <input id="retention-days" type="number" min={1} max={365} value={draftRetentionDays} onChange={(event) => props.onDraftRetentionChange(Math.max(1, Number(event.currentTarget.value) || 1))} />
                <p className="field-help">Older days are removed automatically.</p>
              </label>
              <label className="field" htmlFor="storage-cap-gb">
                <span className="field-label">Storage limit (GB)</span>
                <input id="storage-cap-gb" type="number" min={0.5} max={100} step={0.5} value={draftStorageCapGb} onChange={(event) => props.onDraftStorageCapChange(Math.max(0.5, Number(event.currentTarget.value) || 0.5))} />
                <p className="field-help">Oldest days are removed when the archive grows past this.</p>
              </label>
            </div>
            <div className="path-row">
              <code className="path-readout">{storagePath}</code>
              <button className="button button-small" type="button" onClick={props.onOpenCapturesFolder}>
                Open Folder
              </button>
            </div>
            <p className="field-help">
              {storageStats.captureCount} captures · last search {performanceSnapshot.lastSearchMs} ms · last summary {performanceSnapshot.lastIntelligenceMs} ms · cache hits{" "}
              {performanceSnapshot.searchCacheHits}/{performanceSnapshot.intelligenceCacheHits}
            </p>
          </section>

          <section className="settings-group" ref={bindSection("backup")}>
            <h3>
              <ShieldCheck className="lucide-icon" size={15} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
              Backup & maintenance
            </h3>
            <div className="field-grid">
              <label className="field" htmlFor="backup-passphrase">
                <span className="field-label">Backup passphrase</span>
                <input id="backup-passphrase" type="password" value={backupPassphrase} placeholder="At least 8 characters" onChange={(event) => props.onBackupPassphraseChange(event.currentTarget.value)} />
                <p className="field-help">Encrypts exports and decrypts imports locally.</p>
              </label>
              <label className="field" htmlFor="backup-import-path">
                <span className="field-label">Backup file to import (.mlbk)</span>
                <input id="backup-import-path" type="text" value={backupImportPath} placeholder="C:/path/to/memorylane_backup.mlbk" onChange={(event) => props.onBackupImportPathChange(event.currentTarget.value)} />
              </label>
            </div>
            <div className="button-row">
              <button className="button" type="button" onClick={props.onExportBackup} disabled={isBackupBusy}>
                {isBackupBusy ? "Working…" : "Export Backup"}
              </button>
              <button className="button" type="button" onClick={props.onImportBackup} disabled={isBackupBusy}>
                {isBackupBusy ? "Working…" : "Import Backup"}
              </button>
              <button className="button" type="button" onClick={props.onReindexAllCaptures} disabled={isReindexBusy || !ocrHealth.engineAvailable}>
                {isReindexBusy ? "Reindexing…" : "Rebuild OCR Index"}
              </button>
            </div>
            {maintenanceStage ? <p className="field-help">{maintenanceStage}</p> : null}
            {maintenanceProgress > 0 ? (
              <div className="meter" role="presentation">
                <span style={{ width: `${Math.max(1, Math.min(100, maintenanceProgress))}%` }} />
              </div>
            ) : null}
            {!ocrHealth.engineAvailable ? <p className="field-help warning">{ocrHealth.statusMessage}</p> : null}
            {ocrReindexStatus ? <p className={statusClass(ocrReindexStatusTone)}>{ocrReindexStatus}</p> : null}
            {backupStatus ? <p className={statusClass(backupStatusTone)}>{backupStatus}</p> : null}
          </section>
        </div>

        <footer className="sheet-foot">
          <button className="button button-plain" type="button" onClick={props.onResetDraft} disabled={!settingsDirty}>
            Revert
          </button>
          <button className="button button-accent" type="button" onClick={props.onSaveSettings} disabled={!settingsDirty}>
            Save Changes
          </button>
        </footer>
      </section>
    </div>
  );
}

type ListFieldProps = {
  help: string;
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (nextValue: string) => void;
};

function ListField({ help, id, label, placeholder, value, onChange }: ListFieldProps) {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <textarea id={id} value={value} placeholder={placeholder} rows={2} onChange={(event) => onChange(event.currentTarget.value)} />
      <p className="field-help">{help}</p>
    </label>
  );
}
