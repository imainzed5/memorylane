# MemoryLane

<p align="center">
  <img src="assets/brand/memorylane-icon-256.png" alt="MemoryLane app icon" width="160" />
</p>

<p align="center">
  <strong>Search everything you've seen on your screen.</strong><br />
  A private, local-first screenshot journal for Windows.
</p>

---

You saw it somewhere. An error message, a Slack thread, a price, a link, half a paragraph you meant to come back to. Now it's gone, and you can't remember which window it was in.

MemoryLane remembers for you. It quietly captures your screen on a schedule, reads the text in every capture, and lets you scroll back through your day or search for it. Everything stays on your own PC.

## What it does

- **Recall your day.** Browse captures by day on a visual timeline, then step through them one by one or open any capture in Quick Look.
- **Search what was on screen.** Captures are OCR'd, so you can type a word you remember and jump to the moment it appeared.
- **Review and reflect.** Calendar, gallery, review, and intelligence views show where your time went.
- **Stay in control.** Pause with one key, capture on demand, and choose how often MemoryLane captures, how long it keeps captures, and how much disk space they can use.
- **Keep it out of the way.** MemoryLane lives in the system tray and is fully keyboard-driven.

## Private by design

A tool that sees your screen has to be trustworthy, so MemoryLane works like this:

- **100% local.** Captures and their index are stored in your app data folder. There is no account, cloud, telemetry, or network sync.
- **Privacy rules.** Exclude apps or window titles, auto-pause on certain keywords, and choose whether sensitive captures are skipped, redacted, or pause recording. A redacted capture never stores the real pixels, window title, or app name.
- **Smart skipping.** Lock screens, UAC prompts, and blank frames are never saved.
- **Starts paused.** Nothing is recorded until you finish setup and press **Start Recording**.

## Getting started

MemoryLane runs on **Windows 10 and Windows 11**.

There are no published downloads yet, so for now you build it from source. You'll need [Node.js](https://nodejs.org/), [Rust](https://rustup.rs/) 1.89 or newer, and the [Tauri prerequisites for Windows](https://tauri.app/start/prerequisites/).

```powershell
npm install
npm run tauri dev
```

A short setup guide opens on first launch. There you pick a theme and capture settings, then start recording.

> **Tip:** Install [Tesseract OCR](https://github.com/UB-Mannheim/tesseract/wiki) to enable text search. MemoryLane works without it, but you'll only be able to browse captures, not search them.

## Keyboard shortcuts

Press `?` in the app to see this list at any time.

| Key | Action |
| --- | --- |
| `Ctrl+K` / `/` | Search |
| `Space` | Open or close Quick Look |
| `←` / `→` | Previous or next capture |
| `↑` / `↓` | Previous or next day |
| `Home` / `End` | First or latest capture of the day |
| `T` | Jump to today |
| `,` / `.` | Load an earlier or later part of the timeline |
| `P` | Pause or resume recording |
| `C` | Capture now |
| `O` | Open the captures folder |
| `Delete` | Delete the selected capture |
| `Escape` | Close a dialog or Quick Look, or clear search |

## Storage and retention

MemoryLane deletes captures automatically based on your retention and storage limits, even while recording is paused. If Windows has a file locked, MemoryLane retries later, including after a restart. Settings show pending cleanup separately from live captures. Archives from older versions are migrated automatically, and the originals are left untouched.

## For developers

MemoryLane is built with [Tauri 2](https://tauri.app/) (Rust) and React 19 + TypeScript + Vite.

| Command | What it does |
| --- | --- |
| `npm run tauri dev` | Run the desktop app in development |
| `npm run build` | Type-check and build the frontend |
| `npm run check:rust` | Check the Rust code |
| `npm run test:rust` | Run Rust tests |
| `npm run verify` | All of the above, run before committing |
| `npm run build:desktop` | Build the Windows installers |

Release bundles are written to `%LOCALAPPDATA%\memorylane\cargo-target\release\bundle`. To bundle the optional OCR installer into NSIS packages, place `tesseract-installer.exe` in `src-tauri/resources/tesseract/` before packaging.

See [`CLAUDE.md`](CLAUDE.md) for architecture notes and conventions.

## License

[MIT](LICENSE)
