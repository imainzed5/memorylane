# MemoryLane

<p align="center">
  <img src="assets/brand/memorylane-icon-256.png" alt="MemoryLane app icon" width="160" />
</p>

> **Ever wonder where your day went?**

MemoryLane helps you look back. It takes screenshots of your desktop on a schedule you choose and arranges them into a visual timeline. When the day gets busy and the details blur together, browse your captures to remember what you were working on.

## Take a look back

- Browse captures by day.
- Skim a thumbnail timeline and open the moments you want to see.
- Pause scheduled captures or take one immediately.
- Choose how often to capture, how long to keep captures, and how much storage to use.
- Keep MemoryLane handy from the system tray.

## Your captures stay local

MemoryLane saves captures in its local app data folder. It doesn’t put them in a shared sync folder.

Retention and cleanup continue while recording is paused. If Windows locks a removed file, MemoryLane keeps a cleanup record and retries, including after restart. Storage settings distinguish pending cleanup from live captures. Locked files may keep usage above the storage limit until they can be removed. Files outside the live archive are counted and preserved.

An older MemoryLane archive is migrated automatically only into an uninitialized destination. Existing archives, including empty archives after deletion, are preserved. The migration leaves the older source intact and records its decision outside the archive so restoring a backup cannot repeat it.

## Getting started

MemoryLane currently runs on Windows 10 and Windows 11.

To run it from source, you’ll need Node.js, npm, Rust 1.89 or newer, and the Tauri prerequisites for Windows.

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Start the app:

   ```powershell
   npm run tauri -- dev
   ```

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Left` / `Right` | View the previous or next capture |
| `Up` / `Down` | Choose the previous or next day |
| `Home` | Jump to the first loaded capture of the day |
| `End` | Jump to the latest loaded capture when today is selected |
| `Space` | Open or close Quick Look |
| `P` | Pause or resume captures |
| `C` | Capture now |
| `O` | Open the captures folder |
| `T` | Jump to today |
| `,` / `.` | Load an earlier or later part of the timeline |
| `Delete` | Delete the selected capture |
| `Escape` | Close the active dialog or Quick Look, or clear search |
| `Ctrl+K` / `/` | Focus search |
| `?` | Show keyboard shortcuts |

## Build from source

These commands are for development and packaging:

| Command | What it does |
| --- | --- |
| `npm run build` | Build the app’s frontend |
| `npm run check:rust` | Check the Rust code |
| `npm run test:rust` | Run Rust tests |
| `npm run verify` | Build the frontend, check Rust, and run Rust tests |
| `npm run build:desktop` | Build the Windows desktop installer |

The desktop build is written to `%LOCALAPPDATA%\\memorylane\\cargo-target\\release\\bundle`.

For the optional OCR installer in NSIS packages, place `tesseract-installer.exe` in `src-tauri/resources/tesseract/` before packaging.

## License

MIT
