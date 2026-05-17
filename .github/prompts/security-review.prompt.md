---
description: "Run a full security review of the MemoryLane desktop app."
argument-hint: "Review the whole app for security risks"
agent: "agent"
---

Perform a full security review of the MemoryLane desktop app.

Context:
- Windows-only, local-first Tauri v2 + React + TypeScript frontend with a Rust backend.
- Main surfaces include screenshot capture, OCR search, encrypted backups, settings, clipboard/path actions, and Windows installer packaging.
- Relevant files: [src/App.tsx](../../src/App.tsx), [src-tauri/src/lib.rs](../../src-tauri/src/lib.rs), [src-tauri/tauri.conf.json](../../src-tauri/tauri.conf.json), [src-tauri/windows/hooks.nsh](../../src-tauri/windows/hooks.nsh), [src-tauri/resources/tesseract/README.txt](../../src-tauri/resources/tesseract/README.txt), [package.json](../../package.json), [README.md](../../README.md).

Review scope:
- Trust boundaries and data flow from capture to storage, search, display, export, import, deletion, and installer/runtime behavior.
- File and path handling, command execution, clipboard use, open-folder actions, and any user-controlled inputs.
- Encryption, passphrases, backup format, integrity checks, error handling, and recovery behavior.
- Tauri permissions, window and tray behavior, and all exposed commands.
- OCR packaging, optional installer flow, and any bundled binaries or post-install hooks.
- Logging, error messages, and any leakage of screenshots, OCR text, notes, or secrets.
- Dependency, configuration, and permission risks that matter for a local desktop app.

What to do:
1. Identify the highest-risk issues first.
2. Explain the exploit or failure mode, the user impact, and the exact fix.
3. Separate confirmed bugs from design risks and defense-in-depth suggestions.
4. Call out anything that looks secure but still deserves verification.
5. End with a short validation checklist and any residual risk.

Output format:
- Findings in severity order with file references.
- Brief summary only after the findings.
- If no major issues are found, say so explicitly and note remaining gaps or untested areas.
