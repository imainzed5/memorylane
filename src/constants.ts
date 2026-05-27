import type { ThemeId, ThemeOption } from "./types";

export const EMPTY_DENSITY = [0.08, 0.12, 0.18, 0.26, 0.22, 0.16, 0.12, 0.08];
export const INTERVAL_MIN_MINUTES = 1;
export const INTERVAL_MAX_MINUTES = 240;
export const INTERVAL_OPTIONS = [1, 2, 5, 10, 15, 30, 60, 120];
export const TIMELINE_PAGE_LIMIT = 240;
export const TIMELINE_VIRTUAL_WINDOW = 72;
export const TIMELINE_THUMB_WIDTH_PX = 96;
export const LEGACY_THEME_ID: ThemeId = "amber-noir";
export const ONBOARDING_THEME_ID: ThemeId = "obsidian-jade";
export const QUICKSTART_DISMISS_STORAGE_KEY = "memorylane.quickstart.v1.dismissed";
export const SEARCH_SUGGESTIONS = [
  "around 3 PM yesterday",
  "release notes",
  "app:figma",
  "tag:roadmap",
  "bookmarked favorite",
];
export const ICON_SIZE = 18;
export const ICON_STROKE_WIDTH = 1.8;

export const MATCH_SOURCE_LABELS: Record<string, string> = {
  note: "note",
  ocr: "ocr",
  window: "window",
  app: "app",
  tag: "tag",
  bookmark: "bookmark",
  favorite: "favorite",
  time: "time",
  day: "day",
  metadata: "metadata",
  "exact phrase": "exact phrase",
  "all terms": "all terms",
};

export const THEME_OPTIONS: ThemeOption[] = [
  {
    id: "amber-noir",
    name: "Amber Noir",
    mood: "warm, editorial, grounded",
    swatches: ["#0f0d0b", "#251f1b", "#d58a33", "#2f5d8a"],
  },
  {
    id: "obsidian-jade",
    name: "Obsidian Jade",
    mood: "cool, focused, terminal-adjacent",
    swatches: ["#0b0f0e", "#0e1411", "#3ecf8e", "#1e5f8a"],
  },
  {
    id: "arctic-slate",
    name: "Arctic Slate",
    mood: "clean, minimal, professional",
    swatches: ["#f0f2f5", "#ffffff", "#3a6fd8", "#7c5cbf"],
  },
  {
    id: "deep-plum",
    name: "Deep Plum",
    mood: "dramatic, editorial, premium dark",
    swatches: ["#0d0b12", "#18151f", "#9b6dff", "#d4547a"],
  },
  {
    id: "midnight-blue",
    name: "Midnight Blue",
    mood: "sleek, modern, lightly corporate",
    swatches: ["#090c12", "#101521", "#4d8ef0", "#2a7a8a"],
  },
];
