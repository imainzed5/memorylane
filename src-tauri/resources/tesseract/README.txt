Place the bundled OCR installer here with this exact filename:

tesseract-installer.exe

This file is consumed by the NSIS post-install hook to offer an optional,
default-on OCR component install for MemoryLane.

Recommended package: a silent-install-capable Windows Tesseract distribution.
The hook currently executes:

  tesseract-installer.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-

If your installer uses different silent flags, update src-tauri/windows/hooks.nsh.
