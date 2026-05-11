# PePe Terminal(SSH) v2.0.9

## 🆕 새 기능

### vim 등 풀스크린 TUI 화면 꽉 차게 렌더
- **DECSET 1049 / 47 / 1047 CSI 핸들러** — vim / less / htop 등 alt-buffer 진입 시 즉시 fit + 강제 resize
- **post-connect 다단계 강제 resize** (200/600/1500/3000ms) — 비활성 탭이나 숨김 컨테이너에서 SSH 접속됐어도 PTY 사이즈 정확히 동기화
- **`ssh:resize` IPC 에 `force` 플래그** — dedup 우회로 SIGWINCH 재전송

### 빠른연결 / 비밀번호 모달 UX 대폭 개선
- **빠른연결 시 PowerShell 깜빡임 + "연결 중" 휘발 문제 해결** — `quickConnectPending` 표식으로 PTY 스폰 차단, 즉시 "▶ SSH 연결을 시도하는 중..." placeholder 표시
- **IP 만 입력해도 연결 가능** — username/password 빠진 건 모달로 받음
- **비밀번호 입력 모달** — 터미널 'Password:' 출력 대신 화면 모달
  - 활성 패널 (`.layout-leaf`) 내부에 React portal 로 마운트 → 분할창/세션 전환 시 해당 패널 정중앙에 표시
  - `pointer-events: none` backdrop → 다른 세션 더블클릭 가능 (여러 비밀번호 모달 동시 진행)
  - 활성 세션 termId 의 모달만 표시, 그 외는 "대기 중 N개" 안내
  - 닫힌 미니탭의 유령 항목 자동 정리
- **인증 실패 시 비밀번호 재프롬프트** — `authentication methods failed` 패턴 감지, 잘못된 캐시 비밀번호 삭제 후 모달 재호출
- **비밀번호 저장 권유 모달** — 새로 입력한 비밀번호로 접속 성공 시 "이 세션에 저장할까요?" 인앱 모달
- **취소 시 안내 메시지** — 터미널에 "✕ 연결 취소됨." 표시

### Claude / 세션 / 파일트리 사이드바 UX 통일
- **Claude 사이드바를 `workspace-file-tree` 패턴으로 미러** — `position: fixed; right: 20px`, 트리거 컬럼 자리 비움 (session 사이드바의 `left: 22px` 대칭)
- **트리거 풀-높이** — `top: 40px ~ bottom: 24px` 로 우측 20px 컬럼 완전히 채움. 둥근 모서리 제거로 투명 모드에서도 desktop 안 새도록
- **clip-path reveal 애니메이션** — 트리거 쪽(우측)에서 좌측으로 펼쳐지듯 등장 (`inset(0 0 0 100%)` → `inset(0 0 0 0)`)
- **pinned 모드** — 트리거 안 그림, 패널이 풀-너비 차지
- **세션 / 파일트리 트리거에 Claude 와 동일한 UX 적용** — 클릭 토글 / 2.5초 hover 자동 열림 (기존엔 hover 즉시 열렸음)

### VcXsrv 번들 설치 속도 ↑ + 진행 표시
- PowerShell `Expand-Archive` → **Windows 10+ 내장 `tar.exe` (bsdtar)** — 50MB zip 해제가 30초+ → ~3초로 단축
- NSIS `installSection.nsh` 자동 패치 (`SetDetailsPrint none` → `listonly`) — 설치 진행 중 detail 패널에 파일 복사 메시지 실시간 표시 (기본 템플릿은 강제 숨김 처리됨)
- `npm run build` 가 electron-builder 호출 직전에 패치 스크립트 자동 실행 → node_modules 재설치돼도 매번 재패치

### 도움말 > 정보 — 자동 버전/릴리즈노트 갱신
- **`app:get-version` IPC** — `package.json` 의 version 자동 반영
- **`app:get-release-notes` IPC** — `docs/RELEASE_v{현재버전}.md` 파일 자동 읽음
- 빌드 시 `extraResources` 에 release notes 번들 → 설치본/포터블 모두 동일
- 다음 릴리즈부터 `package.json` bump + 해당 버전 release notes 작성만 하면 About 다이얼로그에 자동 반영

### 기타
- **세션 편집기 Auth 라디오 정렬** — `display: inline-flex` 로 `○ Password   ○ Key` 한 줄 정렬
- **워크스페이스 탭 전환 후 비밀번호 모달 즉시 표시** — `layoutSignature` deps 로 활성 termId 변경 감지

## 🐛 버그 수정

### 빠른연결 SSH 시 로컬 셸이 종료되는 문제
- **원인**: `findEmptyActiveInPanel` 이 sessionId 만 보고 빈 슬롯으로 판정 → 기존 PTY 활성 미니탭의 termId 를 재사용 → SSH 가 PTY 를 takeover 하며 "셸이 종료되었습니다" 출력
- **해결**: `isTermPty / isTermConnected / isTermConnecting` 도 체크해서 기존 termId 재사용 차단, 새 미니탭 생성. `ptyExitSuppressed` 표식으로 일반 takeover 메시지도 1회 억제

### 비밀번호 입력 대기 중인 termId 인식 누락
- A 세션 Password 모달 띄워둔 상태에서 B 세션 더블클릭 시 A 의 termId 가 재사용되던 문제
- `isTermConnecting()` 이 `activePasswordPrompt` / `quickConnectPending` 도 포함하도록

### 빠른연결 같은 IP/username 재연결 시 반응 없음
- `findEmptyActiveInPanel` 이 SSH 연결 상태 미체크 → 이미 연결된 termId 재사용 → main process 의 `'already'` 응답 → no-op
- `isTermConnected / isTermConnecting` 체크 추가

### 비밀번호 모달 표시 / 위치 이슈
- 워크스페이스 탭 전환 후 모달이 안 보이는 문제 — 모든 탭에서 활성 termId 검색하는 폴백 로직 추가
- 미니탭 전환 시 모달 위치가 갱신 안 되는 문제 — `layoutSignature` (activeIdx 포함) deps 추가
- 모달 위치를 활성 패널 (`.layout-leaf`) 내부에 React portal 로 마운트 — 분할창/세션 전환에도 정확히 패널 정중앙

### Claude 사이드바 투명 모드 누수
- 사이드바 / 트리거가 투명 모드에서 함께 투명해지던 문제 — 명시적 `#0d0f10` 강제, 자손 `background-color: inherit`
- 트리거의 둥근 모서리 바깥쪽이 투명해지던 문제 — `border-radius` 제거
- 우측 컬럼의 빈 공간이 desktop 으로 새던 문제 — 트리거 풀-높이로 확장
- Claude 패널이 트리거와 겹쳐 보이던 문제 — `right: 20px` 로 트리거 자리 비움
- autohide hidden 상태에서 패널이 trigger 영역 20px 와 겹쳐 보이던 문제 — clip-path 사용으로 완전 해결

## 🔧 내부 개선

- `writeToTerm(termId, text)` export 추가 — 외부에서 시스템 메시지 직접 출력 가능
- `markQuickConnectPending` / `clearQuickConnectPending` export — 빠른연결 상태 전환 명확히
- `ptyExitSuppressed` Set — SSH takeover 시 "셸이 종료되었습니다" 1회 억제
- `quickConnectPlaceholderShown` Set — placeholder 메시지 중복 출력 방지 (tab 전환 시)
- main.ts `ssh:quick-connect` 가 `'need-credentials'` 반환 — username 빠진 경우 모달에 username 인풋 노출

---

**다운로드**:
- `PePe Terminal(SSH) Setup 2.0.9.exe` — 설치 버전 (NSIS, perMachine)
- `PePe Terminal(SSH) 2.0.9.exe` — 포터블 (단일 실행)
