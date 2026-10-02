# MemoryLane

<p align="center">
  <img src="memorylane_logo.jpg" alt="MemoryLane logo" width="560" />
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

## Getting started

MemoryLane currently runs on Windows 10 and Windows 11.

To run it from source, you’ll need Node.js, npm, Rust, and the Tauri prerequisites for Windows.

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
| `Home` / `End` | Jump to the first or latest capture of the day |
| `Space` | Pause or resume captures |
| `C` | Capture now |
| `O` | Open the captures folder |
| `T` | Jump to today |
| `,` / `.` | Load an earlier or later part of the timeline |
| `Delete` | Delete the selected capture |
| `Escape` | Close Settings |

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
