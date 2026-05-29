# PePe Terminal(SSH) v2.1.3

> 베이스: v2.1.2 + ClearCase Dynamic View 경로추적 · 멀티 SSH AI 컨텍스트 · 파일전송/비교/로그 강화 · 세션 옵션 분리 + 자동추적 회귀 핫픽스

## 🆕 ClearCase Dynamic View 경로 추적

- ClearCase `setview` 환경에서 프롬프트의 뷰태그(`(view_tag)`)와 경로를 파싱해 `/vobs/...` 경로를 실제 뷰 경로(`/view/<tag>/vobs/...`)로 자동 변환하여 SFTP 접근
- 터미널 cwd 를 OSC7 / 프롬프트 파싱으로 추적해 파일트리가 라이브로 따라감 — 공유 서버에서 실패하던 `/proc` 폴링 대신 프롬프트 파싱으로 동작해 SSH 채널 부담 없음
- `~` 프롬프트는 `$HOME` 캐시로 절대경로 해석, 뷰태그 발견 시 즉시 뷰 루트 캐싱

## 🆕 AI 채팅 멀티 SSH 컨텍스트

- AI 대화창에 여러 SSH 세션을 동시에 컨텍스트로 첨부 (다중 선택 UI)
- LogAnalyzer / FileEditor / Compare 에서 분석 대상 로그·파일을 AI 새 대화에 **파일로 첨부**, 에이전트(Claude / Gemini / Codex) 선택, 새 대화 / 현재 대화 토글 지원
- 첨부 파일 미리보기 모달 (크기 조절 가능)
- 분석 요청 시 중복 누적되던 문제 수정

## 🆕 파일 전송 / 비교 / 로그 분석

- 파일 전송 워크스페이스 **패널별 폴더 멀티탭** — 드래그로 좌우 이동 및 패널 간 이동
- Linux → Linux 전송 시 파일 권한(mode) 보존
- 경로바에서 중복되던 상위폴더 / 새로고침 버튼 제거 (우측 버튼으로 일원화)
- 경로를 찾을 수 없을 때 모달 안내 + 잘못된 경로로 진입하지 않음
- 네트워크 `.lnk` 바로가기 해석 강화 — 해석된 실제 경로 표시
- 로컬 셸에서 파일 열기 (sftp 로컬 파일시스템 폴백)
- **Araxis 스타일 파일 비교** + "All match" 안내 모달 + 좌/우 파일 다운로드 버튼, 최대 파일 크기 100MB
- **실시간 로그 분석** (watch, csh/tcsh 호환 `/bin/sh -c stdbuf tail`)
- FileEditor / Compare EUC-KR 인코딩 지원 및 자동 감지, 최대 파일 크기 5MB → 100MB

## 🆕 세션 관리 / UX

- 세션 드래그앤드롭 순서 변경 + 다중 선택 폴더 이동
- **세션 옵션 분리**: 파일트리 보여주기(SFTP 자동 연결) ↔ 파일트리 자동추적(cwd 동기화 전용) — 보여주기 OFF 면 자동추적 비활성화
- 세션별 Backspace / Delete 키 시퀀스 설정 (VT220 / ASCII127 / Backspace — Xshell 호환)
- 메뉴 / 옵션 다국어(i18n), 매뉴얼 보강, 파일전송 충돌 기억
- 매뉴얼 Aero Snap (투명도 유지) + 반응 속도 개선
- 터미널 패널 컨트롤에 동작 상태 표시 닷 (플로팅 확대 / PWD 자동추적 활성 표시)
- 미니탭 드래그 이미지 정리, "워크스페이스로 이동" 은 터미널 워크스페이스로만 제한

## 🐛 버그 수정

- **PWD 자동추적 회귀 핫픽스** — 옵션 분리(`fileTreeEnabled`/`autoTrackPwd`) 이전에 만든 세션은 `fileTreeEnabled` 가 미설정이라 새 게이트(`autoTrackPwd && fileTreeEnabled`)에서 자동추적이 꺼져, ClearCase `/vobs` 등 cwd 추적이 로그인 홈(`/user1/dev`)에 머물던 문제. 세션 로드 시 `autoTrackPwd=true` 이고 `fileTreeEnabled!==true` 인 세션을 `fileTreeEnabled=true` 로 정규화하여 접속 즉시 추적 동작
- AI 대화 이름 인라인 변경 정상화 (Electron 에서 `window.prompt` 무동작 → 인라인 입력)
- 대화 중 git 관련 내용이 없는데도 git bar 가 뜨던 오탐 차단
- X 버튼 종료 시 앱 · dev 서버가 확실히 종료되도록 수정 (Aero Snap 프리뷰 윈도우 잔존 문제)
- 파일 패널 클릭 시 깜빡임 제거
- 종료 시 dedicated SFTP 리소스 누수 정리 (`closeTab`/`closePanel`/`handleCloseSession` 통일)
- `%TEMP%` 잔여 임시파일 자동 정리 (30분 경과 pepe/gemini/claude-mcp 임시파일)
- 메모리 릭 점검 및 정리

## 📦 빌드

- 버전: 2.1.3
- 다운로드: `release/PePe Terminal(SSH) Setup 2.1.3.exe` (NSIS installer, 서명됨) / `release/PePe Terminal(SSH) 2.1.3.exe` (portable, 서명됨)

---

### 포함 커밋 (v2.1.2 → v2.1.3)

- `f75c9b8` fix(session): 기존 세션 PWD 자동추적 회귀 수정 (fileTreeEnabled 마이그레이션)
- `5e1d481` feat(terminal): 세션별 Backspace/Delete 키 시퀀스 설정 (Xshell 호환)
- `c98fc73` feat(session/ux): 파일트리·PWD 자동추적 옵션 분리 + 종료 시 리소스 누수 수정
- `dd55ba5` feat(compare): 좌/우 파일 다운로드 버튼 추가
- `164e9cb` chore(temp): %TEMP% 잔여 임시파일 자동 정리 + mermaid 디버그 덤프 제거
- `08a6aa3` fix(window): X 버튼 종료 시 앱·dev서버 확실히 종료 + 프롬프트 cwd 파싱 강건화
- `0d64fc0` feat(ssh): ClearCase dynamic view 경로추적 + 멀티SSH 컨텍스트 + 파일트리 라이브 갱신
- `f438c47` feat(chat): AI 채팅 SSH 컨텍스트 멀티 세션 지원
- `fd54bf1` feat(sessions): 드래그앤드롭 순서 변경 + 다중 폴더 이동
- `8b93312` feat(editor/compare/log): AI 분석 에이전트 선택 + 인코딩 + 패널 분할/스크롤 개선
- `dca86a3` feat(chat/compare/log): 첨부 미리보기 + All match 모달 + AI 분석 파일첨부
- `7b90bd7` feat(compare/log/i18n+ux): Araxis 스타일 비교 + 실시간 로그 분석 + AI 연동
- `c78d714` feat(i18n+ux): 메뉴/옵션 다국어 + 파일전송 충돌 기억 + 매뉴얼 보강
- `8653aa5` perf(window): 매뉴얼 Aero Snap 반응 속도 개선
- `45f2d66` feat(window): 매뉴얼 Aero Snap 추가
- `f36efa8` feat: 파일전송 멀티탭 + 권한보존 + 미니탭 UX + .lnk 해석 강화
- `0300459` fix(chat): 대화 이름 인라인 변경 + git bar 오탐 차단
