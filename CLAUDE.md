# MemoryLane

Local-first Windows screenshot journal: captures the primary display on an interval, stores
JPEGs + metadata in SQLite, OCRs them, and lets the user browse, search, and review "what was I
doing?". Tauri 2 (Rust) backend, React 19 + TypeScript + Vite frontend. Windows is the only
shipping target; keep non-Windows code compiling behind `cfg` stubs.

Product direction lives in `PRODUCT_ROADMAP.md` and `COMPETITIVE_ROADMAP.md`. Positioning is
"work recall for power users", not a consumer life archive.

## Commands

| Task | Command |
| --- | --- |
| Run the desktop app (dev) | `npm run tauri dev` |
| Frontend type-check + build | `npm run build` |
| Type-check only | `npx tsc --noEmit -p .` |
| Rust check / tests | `npm run check:rust` / `npm run test:rust` |
| Everything before a commit | `npm run verify` |
| Live screen-capture test (opt-in) | `cargo test --manifest-path src-tauri/Cargo.toml --lib live_ -- --include-ignored --nocapture` |
| Release installers | `npm run build:desktop` |

- `npm run tauri` goes through `scripts/tauri-dev.mjs`: it pins `CARGO_TARGET_DIR` to
  `%LOCALAPPDATA%\memorylane\cargo-target` and kills stale `memorylane.exe` processes first.
  Release bundles land in that target dir, not `src-tauri/target` (CI relies on this).
- A cold `cargo check` takes several minutes; give it a long timeout.
- `npm run dev` alone serves the UI at `localhost:1420`, but every `invoke`/`listen` and
  `getCurrentWindow()` throws outside Tauri, so the page crashes. To inspect UI in a plain
  browser, load a throwaway HTML page that calls `mockWindows("main")` and `mockIPC(...)` from
  `@tauri-apps/api/mocks` before importing `/src/main.tsx`. Don't commit that harness.

## Layout

```
src-tauri/src/
  backend.rs          # nearly all backend: DB schema, settings, capture loop, OCR, search,
                      # intelligence, backup, tray, all #[tauri::command]s, run()
  backend/capture.rs  # primary-display capture (WGC -> GDI fallback, blank/lock detection)
  backend/tests.rs    # backend unit tests
src/
  App.tsx             # app state, data loading, keyboard shortcuts, workspace switching
  components/         # TopBar, Sidebar, Viewer, Inspector, Filmstrip, QuickLook, primitives
  components/workspaces/  # Calendar, Gallery (All Captures), Review, Intelligence
  components/modals/  # SettingsModal, Dialogs (theme picker, onboarding, shortcuts, confirm)
  hooks/              # useArchiveSearch, useDayIntelligence
  utils/app.tsx       # formatting, theme/setting resolvers, small helpers
  utils/motion.ts     # runViewTransition + prefersReducedMotion
  styles/             # see "Styling" below; App.css only @imports these
  types.ts            # payload types mirroring the Rust serde structs (camelCase)
  constants.ts        # limits, storage keys, theme options
```

New backend commands: add the fn in `backend.rs`, register it in `generate_handler!` inside
`run()`, and add the matching payload type to `src/types.ts`. Rust structs use
`#[serde(rename_all = "camelCase")]`; keep the TS types in sync by hand.

## Backend notes

- Capture runs on a background thread in `run()`, plus tray "Capture now" and the
  `capture_now` command. All three go through `capture_once` and handle
  `CaptureRunResult::{Captured, CapturedWithPolicy, Suppressed}` and emit `capture-suppressed` /
  `capture-error` / `captures-updated` events. Keep the three call sites consistent.
- Capture uses Windows.Graphics.Capture (via the `windows` crate) because GDI BitBlt returns black
  for GPU-composited content. GDI (`screenshots` crate) is only the fallback. Locked/UAC desktops
  and all-black frames are skipped (reported as suppressed with mode `skip`), never saved.
- Privacy policy (`evaluate_capture_policy`) runs before capturing: excluded apps/keywords skip,
  pause rules auto-pause, sensitive keywords skip/redact/pause per `sensitiveCaptureMode`.
  Redacted captures must never store the real pixels, title, or process name.
- OCR shells out to Tesseract if installed (`resolve_tesseract_executable`); the app must work
  without it.
- The capture worker also runs coalesced storage maintenance at startup, after captures/settings/imports,
  and on a five-minute deadline while paused. `backend/storage.rs` owns transactional schema
  migrations, byte accounting, and durable file-deletion retries; ordinary stats never scan the tree.
- Data lives under the Tauri app data dir (`captures/` + `memorylane.db`). Everything stays
  local: never add network calls, telemetry, or cloud features.
- Window material: `set_window_material` applies Mica through `window-vibrancy`. It returns
  `false` on Windows 10, and the UI then sets `data-material="solid"`.

## Frontend conventions

- **Styling is token-driven.** `styles/theme.css` defines palette values (`--palette-*`) per theme,
  semantic tokens (`--bg-*`, `--fill-1..4`, `--text-1..3`, `--accent*`, `--separator*`,
  `--material-*`), and scales (`--r-*`, `--shadow-*`, `--space-*`, `--text-*`, `--ease-*`,
  `--dur-*`). Use tokens; don't hardcode colours, radii, or durations in component CSS.
  Themes override **palette values only**, so every theme (including light `arctic-slate`)
  works automatically. Add any new light theme to `LIGHT_THEME_IDS`.
- Stylesheets are split by area: `base` (buttons, inputs, chips), `shell` (grid, sidebar, toolbar,
  inspector, filmstrip, toast), `stage` (viewer, Quick Look), `workspaces`, `overlays`
  (popovers, sheets, segmented control, tooltip), `motion` (all keyframes + View Transitions +
  reduced-motion). Put keyframes in `motion.css`.
- Separate regions with spacing, fills, and shadows, not borders. Popovers and sheets use
  the `--material-*` + `--material-blur` surfaces.
- **Motion:** use CSS and the View Transitions API, not an animation library. Use
  `runViewTransition` from `utils/motion.ts`: `kind: "workspace"` for workspace switches, or a
  hero morph via `heroSource` + `heroTargetSelector` (`[data-hero="viewer"]`,
  `[data-hero="quicklook"]`). It already falls back when the API is missing or reduced motion is on.
  Switch workspaces through `switchWorkspace(...)` in `App.tsx`, never `setWorkspaceMode` directly.
- Reuse the primitives in `components/primitives.tsx`: `SegmentedControl` (sliding indicator),
  `useSlidingIndicator`, `useDismiss` (outside-click + Escape), `WorkspaceHeader`, `Kbd`.
- Right-click menus go through `useContextMenu` (`components/ContextMenu.tsx`); capture menus come
  from `buildCaptureMenu` in `App.tsx` so every surface offers the same actions. The provider
  suppresses the WebView menu everywhere else (Shift + right-click keeps it in dev builds).
- Transient feedback goes through `setActionMessage` (auto-dismissing toast). Don't add
  persistent status bars.
- UI copy uses Title Case for buttons and menu items, and sentence case for descriptions.
- Keyboard: Space opens Quick Look, P pauses or resumes, C captures, Ctrl K or `/` focuses search,
  ←/→ steps captures, `?` shows shortcuts. Update `KeyboardShortcutsModal` and `QuickStartModal`
  in `Dialogs.tsx` whenever a shortcut changes.

## Gotchas

- The title bar uses `data-tauri-drag-region`. Tauri already toggles maximize on double-click
  there, so don't add an `onDoubleClick` maximize handler, or it will toggle twice.
- The window is `transparent: true` (for Mica). Only make window or content backgrounds
  translucent under `:root[data-material="mica"]`. The default must stay opaque, or the desktop
  shows through on Windows 10.
- A running view transition covers the page with `::view-transition`. It has
  `pointer-events: none` so clicks still land, so keep that rule.
- `useDismiss` handles Escape in the capture phase. Components that need their own Escape
  behaviour (e.g. the search field clearing first) pass `closeOnEscape: false`.
- Files are CRLF in git (autocrlf). Scripted edits that rewrite whole files with LF are
  fine, because git normalizes them.

## Workflow

- Run `npm run verify` (or at least `npx tsc --noEmit -p .` + `npm run check:rust`) before
  calling work done.
- Commit messages follow Conventional Commits with a scope: `feat(ui): …`, `fix(capture): …`,
  `chore: …`, `release: cut x.y.z`. Keep unrelated changes in separate commits.
- `.github/skills/` holds the `security-specialist` and `senior-desktop-uiux-designer` guides,
  and `.github/prompts/` holds audit prompts. Consult them for security or UX-heavy work.
