# MemoryLane

<p align="center">
	<img src="memorylane_logo.jpg" alt="MemoryLane logo" width="720" />
</p>

MemoryLane is a Windows-only, local-first screenshot journal for desktop work. It runs in the tray, captures screenshots on a schedule, and gives you a fast timeline for reviewing each day.

## What It Includes

- Tray-based background capture
- Day navigator with capture counts and density bars
- Selected-capture viewer with thumbnail timeline scrubbing
- Metadata-first loading, with full-size images fetched on demand
- Settings for capture interval, retention, storage cap, and startup on boot
- Keyboard shortcuts for browsing, capture control, and folder access
- SQLite-backed local storage

## Requirements

- Windows 10 or Windows 11
- Node.js and npm
- Rust toolchain and Tauri prerequisites

## Run

1. Install dependencies: `npm install`
2. Start the desktop app: `npm run tauri dev`
3. Build the frontend: `npm run build`
4. Check Rust: `npm run check:rust`
5. Run Rust tests: `npm run test:rust`
6. Run all local checks: `npm run verify`
7. Build Windows installers: `npm run build:desktop`

The desktop bundle is written to `%LOCALAPPDATA%\\memorylane\\cargo-target\\release\\bundle`.
The landing page is available separately at `public/landing.html`; the packaged exe opens the app shell from `index.html`.
The `npm run tauri dev` wrapper clears any stale `memorylane.exe` instance and uses a fresh dev target directory on each run, which avoids the Windows file-lock error from a previous session.
In debug builds, closing the window now exits the app instead of leaving the tray process alive, so Cargo can rebuild the exe on the next run.
For the optional OCR installer component in NSIS builds, place `tesseract-installer.exe` in `src-tauri/resources/tesseract/` before packaging.

## Keyboard Shortcuts

- `Left` / `Right`: previous or next capture in the selected day.
- `Up` / `Down`: previous or next day in the sidebar.
- `Home` / `End`: jump to the first or latest capture in the selected day.
- `Space`: toggle pause and resume.
- `C`: capture now.
- `O`: open the captures folder.
- `T`: jump to today.
- `,` / `.`: load earlier or later timeline pages.
- `Delete`: delete the selected capture.
- `Escape`: close the settings modal.

## Notes

- Captures live under the app data directory, not in a shared sync folder.
- The packaging target is Windows-only for now.

## License

MIT
- On startup, the app auto-migrates legacy data from a previous app-data identity when that legacy database contains more captures, so timeline history remains intact.
