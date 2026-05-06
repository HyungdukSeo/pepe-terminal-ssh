!macro customInit
  ; 모든 사용자 / 전용 모두 Program Files에 설치
  StrCpy $INSTDIR "$PROGRAMFILES\PePe Terminal(SSH)"
  ; 설치 시 파일 복사 단계도 detail 패널에 출력되도록 — 기본 SetDetailsPrint=lastused → both
  SetDetailsPrint both
!macroend

!macro customHeader
  ; 상세 내역 항상 표시
  ShowInstDetails show
  ShowUninstDetails show
!macroend

; 부드러운 진행 바 — 퍼센티지 갱신 부드럽게
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"

!macro customInstall
  SetDetailsPrint both

  DetailPrint "─────────────────────────────────────────"
  DetailPrint "✓ 1단계 완료: PePe Terminal 본체 파일 복사 (약 170MB)"
  DetailPrint "─────────────────────────────────────────"

  DetailPrint "▶ 2단계: 탐색기 우클릭 메뉴 등록..."
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\PepeTerminal" "" "Open PePe Terminal here"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\PepeTerminal" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\PepeTerminal\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\shell\PepeTerminal" "" "Open PePe Terminal here"
  WriteRegStr HKCU "Software\Classes\Directory\shell\PepeTerminal" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\PepeTerminal\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  DetailPrint "  ✓ 우클릭 메뉴 등록 완료"

  IfFileExists "$INSTDIR\resources\x11-server.zip" 0 lbl_no_x11
    DetailPrint "▶ 3단계: X11 서버(VcXsrv) 번들 설치중"
    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path \"$INSTDIR\resources\x11-server.zip\" -DestinationPath \"$INSTDIR\resources\x11-server\" -Force"'
    Delete "$INSTDIR\resources\x11-server.zip"
    DetailPrint "  ✓ X11 서버 설치 완료 (Qt/GTK X 앱 호환)"
  lbl_no_x11:

  DetailPrint "─────────────────────────────────────────"
  DetailPrint "✓ 모든 설치 완료. PePe Terminal(SSH) v${VERSION}"
  DetailPrint "─────────────────────────────────────────"
!macroend

; customUnInit: 제거 시작 시점 — electron-builder 의 자동 파일 삭제 (수천 개 파일 하나씩 출력) 이전에 실행
; X11 서버 폴더를 cmd /c rmdir 로 미리 통째로 삭제 → 자동 삭제 루프가 도달했을 땐 이미 비어 있어 출력 X
!macro customUnInit
  ${if} ${FileExists} "$INSTDIR\resources\x11-server\*"
    DetailPrint "X11 서버 폴더 삭제 중 (한 번에 처리)..."
    nsExec::Exec 'cmd /c rmdir /S /Q "$INSTDIR\resources\x11-server"'
    DetailPrint "X11 서버 폴더 삭제 완료"
  ${endif}
!macroend

!macro customUnInstall
  ; 탐색기 우클릭 메뉴 삭제
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\PepeTerminal"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\PepeTerminal"
  DeleteRegKey HKLM "Software\Classes\Directory\Background\shell\PepeTerminal"
  DeleteRegKey HKLM "Software\Classes\Directory\shell\PepeTerminal"

  ; 사용자 데이터 삭제 확인
  MessageBox MB_YESNO|MB_ICONQUESTION "사용자 데이터(세션, 설정)를 삭제하시겠습니까?" IDNO +4
    SetShellVarContext current
    RMDir /r "$APPDATA\PePe Terminal(SSH)"
    SetShellVarContext all
    RMDir /r "$APPDATA\PePe Terminal(SSH)"
!macroend
