import type { ReactNode } from "react";
import { Check } from "lucide-react";
import type { ThemeId, ThemeOption } from "../../types";
import { Kbd } from "../primitives";

type ThemePickerProps = {
  disabled?: boolean;
  options: ThemeOption[];
  selectedThemeId: ThemeId;
  onSelect: (themeId: ThemeId) => void;
};

export function ThemePicker({ disabled = false, options, selectedThemeId, onSelect }: ThemePickerProps) {
  return (
    <div className="theme-grid" role="radiogroup" aria-label="Theme">
      {options.map((option) => {
        const isSelected = option.id === selectedThemeId;
        const [background, surface, accent, secondary] = option.swatches;
        return (
          <button
            key={option.id}
            className={isSelected ? "theme-card active" : "theme-card"}
            type="button"
            role="radio"
            aria-checked={isSelected}
            disabled={disabled}
            onClick={() => onSelect(option.id)}
          >
            <span className="theme-preview" style={{ background }} aria-hidden="true">
              <span className="theme-preview-sidebar" style={{ background: surface }} />
              <span className="theme-preview-content">
                <span className="theme-preview-line" style={{ background: accent }} />
                <span className="theme-preview-line short" style={{ background: secondary }} />
              </span>
              {isSelected ? (
                <span className="theme-preview-check" style={{ background: accent }}>
                  <Check size={11} strokeWidth={3} />
                </span>
              ) : null}
            </span>
            <span className="theme-card-copy">
              <strong>{option.name}</strong>
              <span>{option.mood}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

type KeyboardShortcutsModalProps = {
  onClose: () => void;
  onOpenSettings: () => void;
};

const SHORTCUT_GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: "Navigate",
    items: [
      ["← / →", "Previous or next capture"],
      ["J / K", "Next or previous capture"],
      ["↑ / ↓", "Change day"],
      ["Home / End", "First capture or now"],
      ["T", "Jump to today"],
    ],
  },
  {
    title: "View",
    items: [
      ["Space", "Quick Look"],
      ["V", "Timeline"],
      ["R", "Review"],
      ["I", "Intelligence"],
      ["F11", "Full screen"],
    ],
  },
  {
    title: "Search & review",
    items: [
      ["Ctrl K or /", "Search"],
      ["N / Shift N", "Next or previous result"],
      ["B", "Bookmark"],
      ["F", "Favorite"],
      ["Delete", "Delete capture"],
      ["Shift F10", "Actions for the focused capture"],
    ],
  },
  {
    title: "Capture",
    items: [
      ["P", "Pause or resume"],
      ["C", "Capture now"],
      ["O", "Open captures folder"],
      ["S", "Settings"],
    ],
  },
];

export function KeyboardShortcutsModal({ onClose, onOpenSettings }: KeyboardShortcutsModalProps) {
  return (
    <div className="sheet-overlay" role="presentation" onClick={onClose}>
      <section className="sheet dialog-sheet shortcuts-sheet" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" onClick={(event) => event.stopPropagation()}>
        <header className="sheet-head">
          <div>
            <h2 id="shortcuts-title">Keyboard Shortcuts</h2>
            <p>Press Esc to close.</p>
          </div>
        </header>
        <div className="sheet-body shortcut-groups">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} className="shortcut-group" aria-label={group.title}>
              <h3>{group.title}</h3>
              <ul>
                {group.items.map(([keys, label]) => (
                  <li key={keys}>
                    <span>{label}</span>
                    <Kbd>{keys}</Kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <footer className="sheet-foot">
          <button className="button button-plain" type="button" onClick={onOpenSettings}>
            Settings
          </button>
          <button className="button button-accent" type="button" onClick={onClose}>
            Done
          </button>
        </footer>
      </section>
    </div>
  );
}

type ConfirmationModalProps = {
  body: ReactNode;
  confirmLabel: string;
  isConfirmDisabled?: boolean;
  title: string;
  tone?: "danger" | "neutral";
  onClose: () => void;
  onConfirm: () => void;
};

export function ConfirmationModal({ body, confirmLabel, isConfirmDisabled = false, title, tone = "danger", onClose, onConfirm }: ConfirmationModalProps) {
  return (
    <div className="sheet-overlay" role="presentation" onClick={onClose}>
      <section className="sheet alert-sheet" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="confirmation-title">{title}</h2>
        <div className="alert-body">{body}</div>
        <footer className="alert-actions">
          <button className="button" type="button" onClick={onClose} autoFocus>
            Cancel
          </button>
          <button className={tone === "danger" ? "button button-danger" : "button button-accent"} type="button" onClick={onConfirm} disabled={isConfirmDisabled}>
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
