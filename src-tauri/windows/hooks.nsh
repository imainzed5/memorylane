!include "LogicLib.nsh"

!macro NSIS_HOOK_POSTINSTALL
  ; Skip OCR setup if Tesseract already exists on PATH.
  nsExec::ExecToStack 'where tesseract.exe'
  Pop $0
  Pop $1
  ${If} $0 == 0
    DetailPrint "Tesseract already installed. Skipping OCR component."
    Goto ml_ocr_done
  ${EndIf}

  IfSilent ml_skip_ocr

  IfFileExists "$INSTDIR\resources\tesseract\tesseract-installer.exe" 0 ml_missing_ocr_installer

  MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON1 \
    "MemoryLane can install an optional OCR component (Tesseract).$\r$\n$\r$\nTesseract lets MemoryLane index screenshot text so search works for words inside images.$\r$\n$\r$\nInstall OCR component now? (Recommended)" \
    IDYES ml_install_ocr IDNO ml_skip_ocr

  ml_install_ocr:
    DetailPrint "Installing optional OCR component (Tesseract)..."
    ExecWait '"$INSTDIR\resources\tesseract\tesseract-installer.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-' $2
    ${If} $2 == 0
      DetailPrint "OCR component installed successfully."
    ${Else}
      MessageBox MB_ICONEXCLAMATION|MB_OK "OCR component install failed (exit code $2). MemoryLane will still run, but OCR search will be unavailable until Tesseract is installed."
    ${EndIf}
    Goto ml_ocr_done

  ml_missing_ocr_installer:
    DetailPrint "OCR component package is not bundled. Skipping optional OCR setup."
    Goto ml_ocr_done

  ml_skip_ocr:
    DetailPrint "Skipped optional OCR component install."

  ml_ocr_done:
!macroend
