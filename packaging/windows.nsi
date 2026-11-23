Unicode True
Name "GoHarness Desktop"
!ifndef PAYLOAD
  !error "PAYLOAD is required"
!endif
!ifndef OUTPUT
  !error "OUTPUT is required"
!endif
!ifndef CHANNEL
  !error "CHANNEL is required"
!endif
OutFile "${OUTPUT}"
RequestExecutionLevel user
!include "MUI2.nsh"
InstallDir "$LOCALAPPDATA\Programs\GoHarness Desktop ${CHANNEL}"
InstallDirRegKey HKCU "Software\GoHarness\Desktop\${CHANNEL}" "InstallDir"
!define MUI_ABORTWARNING
!define MUI_ICON "${PAYLOAD}\goh-desktop.ico"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Section "Install"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File "${PAYLOAD}\goh-desktop.exe"
  File "${PAYLOAD}\goh-desktop.ico"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateDirectory "$SMPROGRAMS\GoHarness Desktop ${CHANNEL}"
  CreateShortCut "$SMPROGRAMS\GoHarness Desktop ${CHANNEL}\GoHarness Desktop.lnk" "$INSTDIR\goh-desktop.exe" "" "$INSTDIR\goh-desktop.ico"
  WriteRegStr HKCU "Software\GoHarness\Desktop\${CHANNEL}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GoHarnessDesktop-${CHANNEL}" "DisplayName" "GoHarness Desktop (${CHANNEL})"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GoHarnessDesktop-${CHANNEL}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GoHarnessDesktop-${CHANNEL}" "DisplayIcon" "$INSTDIR\goh-desktop.ico"
SectionEnd
Section "Uninstall"
  SetShellVarContext current
  Delete "$SMPROGRAMS\GoHarness Desktop ${CHANNEL}\GoHarness Desktop.lnk"
  RMDir "$SMPROGRAMS\GoHarness Desktop ${CHANNEL}"
  Delete "$INSTDIR\goh-desktop.exe"
  Delete "$INSTDIR\goh-desktop.ico"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\GoHarness\Desktop\${CHANNEL}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GoHarnessDesktop-${CHANNEL}"
SectionEnd
