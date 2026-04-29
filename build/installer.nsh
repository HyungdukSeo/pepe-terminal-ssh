!macro customInit
  ; 모든 사용자 / 전용 모두 Program Files에 설치
  StrCpy $INSTDIR "$PROGRAMFILES\PePe Terminal(SSH)"
!macroend

!macro customInstall
  ; Folder background context menu
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\PepeTerminal" "" "Open PePe Terminal here"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\PepeTerminal" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\PepeTerminal\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'

  ; Folder context menu
  WriteRegStr HKCU "Software\Classes\Directory\shell\PepeTerminal" "" "Open PePe Terminal here"
  WriteRegStr HKCU "Software\Classes\Directory\shell\PepeTerminal" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\PepeTerminal\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; X 서버 (VcXsrv) 압축 해제 — resources/x11-server.zip → resources/x11-server/
  IfFileExists "$INSTDIR\resources\x11-server.zip" 0 +3
    DetailPrint "X11 서버 압축 해제 중 (VcXsrv 약 50MB)..."
    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path \"$INSTDIR\resources\x11-server.zip\" -DestinationPath \"$INSTDIR\resources\x11-server\" -Force"'
    Delete "$INSTDIR\resources\x11-server.zip"
!macroend

!macro customUnInstall
  ; 탐색기 우클릭 메뉴 삭제
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\PepeTerminal"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\PepeTerminal"
  DeleteRegKey HKLM "Software\Classes\Directory\Background\shell\PepeTerminal"
  DeleteRegKey HKLM "Software\Classes\Directory\shell\PepeTerminal"

  ; 압축 해제된 X 서버 정리
  RMDir /r "$INSTDIR\resources\x11-server"

  ; 사용자 데이터 삭제 확인
  MessageBox MB_YESNO|MB_ICONQUESTION "사용자 데이터(세션, 설정)를 삭제하시겠습니까?" IDNO +4
    SetShellVarContext current
    RMDir /r "$APPDATA\PePe Terminal(SSH)"
    SetShellVarContext all
    RMDir /r "$APPDATA\PePe Terminal(SSH)"
!macroend
