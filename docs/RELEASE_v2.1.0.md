# PePe Terminal(SSH) v2.1.0

> 베이스: hyungduk/main (v2.0.9) + nyaong902/v2.1.0 자체 개선 cherry-pick

## 🆕 새 워크스페이스 (hyungduk 기여 → 통합 완료)

상위 메뉴 **도구** 또는 탭바 **`＋` > 워크스페이스** 에서 접근:

- **🌐 브라우저 워크스페이스** — Electron `<webview>` 로 외부 사이트 렌더 (Anthropic Console, GitHub, 매뉴얼 등 한 화면에서)
- **🔍 파일 비교 워크스페이스** — 두 디렉토리(로컬/원격 SFTP) 재귀 walk 후 차이점 트리 + 라인 diff. 50,000 entry 상한으로 폭주 방지
- **📈 로그 분석 워크스페이스** — SSH 세션에서 로그 파일 수집 / 필터 / CSV 내보내기
- **🔒 VPN 워크스페이스** — OpenVPN 자격증명 관리 + 연결/해제 (macOS Universal Binary 번들 포함)
- **🌍 다국어 편집 워크스페이스** — i18n 번역 키 편집기 (5개 기본 언어 번들: ko/en/ja/zh-Hans/zh-Hant)
- **🗄️ SQL Tool 워크스페이스** — Altibase 등 DBMS 세션 우클릭 → SQL Tool 진입, SSH exec 채널로 `isql` 실행 + 쿼리/결과 보존

→ 모든 워크스페이스를 **ErrorBoundary 로 격리** — 한 컴포넌트 크래시가 전체 앱 종료시키지 않음

## 🆕 파일 패널 / 파일 전송 대규모 개선

### 가상 폴더 네이티브 통합
- **shell:* 가상 폴더 라우팅** — 휴지통 / 제어판 / 내 PC / 네트워크 / 라이브러리 / 다운로드 / 문서 / 사진 / 음악 / 동영상 모두 진입 가능
- **Windows 네이티브 아이콘 추출** — `SHParseDisplayName` + `SHGetFileInfo(SHGFI_PIDL | SHGFI_ICON)` 으로 가상 폴더 각각의 OS 정식 아이콘 표시
- **shell-pidl 체인 ParseName 따라가기** — 데스크톱 하위의 가상 항목까지 고유 아이콘 (Desktop > 갤러리/라이브러리 등)
- **shell:Desktop aggregator 중복 .lnk dedupe** — OneDrive Desktop / Public Desktop 등 여러 소스에서 중복 열거되던 React duplicate key warning 해결

### Path bar 친화 표시
- shell: 경로의 친화 라벨 ↔ 실제 경로 양방향 매핑
- 클릭 시 "바탕 화면" 그대로 표시, 라벨 입력해도 navigate 가능
- 드라이브 dropdown 제거 → 사이드바 트리로 일원화

### MTP / 인코딩 / 컨텍스트 메뉴
- 안드로이드/iOS MTP 디바이스 enumerate (USB 연결 시)
- 파일명 인코딩 (utf-8 / cp949 / euc-kr) 런타임 변경
- 우클릭 메뉴 확장 — 복사 / 붙여넣기 / 권한 변경 / 이름 바꾸기 / 삭제

### 일괄 파일 전송
- 빠른연결 SSH 세션을 source dropdown 에 `🟢 ... (빠른연결)` 로 표시
- 일괄 파일전송 > 원격 파일(다른 서버) 피커에도 빠른연결 세션 합류

## 🆕 ClaudeChat 강화

### Plan 승인 모달 편집/추가요구
- markdown 원본을 **textarea 로 편집** 후 진행 가능
- "➕ 추가 요구사항" 입력 영역 — 진행 시 `[추가 요구사항]` 으로 덧붙여 전송
- 모달 영역을 chat 컨테이너 내부로 한정 → 입력창은 안 가림 (unpin/pin 양쪽)

### Git 상태 바 (조건부)
- 입력창 위에 `⎇ branch  +N −M  [PR 생성]` 표시
- 활성 SSH 세션 우선, 없으면 로컬 cwd 자동 감지
- **대화에 git 키워드(git/PR/github/commit/branch ...)가 포함될 때만 표시** — 무관한 대화에선 숨김
- PR 생성 버튼 → AI 에게 `gh pr create` 자동 요청

### AI Agent 전환
- 헤더의 🤖 Claude / ✨ Gemini / 🧠 Codex 전환 버튼을 **not-installed / loading 화면에도 추가** — 미설치 상태에서도 다른 AI 로 돌아갈 수 있음
- agent 전환 후 chat view 재마운트 시 자동 scroll-to-bottom

## 🔧 빠른연결 / 자격증명 UX 개선

- **세션 복제 시 자격증명 자동 재사용** — 빠른연결 후 입력한 id/pwd 가 `termSessionMap.quickSession` 에 저장되어, 같은 세션 복제 시 추가 입력 없이 바로 연결
- **인증 실패 시 id/pwd 두 필드 모두 재표시** — 이전 username 은 hint 로 pre-fill, 새 비밀번호 받기
- **무한 재시도 루프 차단** — 잘못된 비밀번호로 실패 후 같은 비번으로 재시도하던 버그 수정
- **취소 후 재시도 가능** — 자격증명 모달 취소 시 안내 메시지 + 터미널 클릭 1회 또는 미니탭 우클릭 → 재연결 로 모달 재오픈

## 🔧 터미널 UX 개선

### Resize 안정성
- **xterm 5.3 grow buffer 버그 수동 보정** — fit() 후 buffer 끝 빈줄 trim + `ybase/ydisp/y` 재계산. 분할창 닫기 / maximize / restore 시 컨텐츠 손실 / 첫줄 잘림 해결
- **ConPTY repaint drop window** — PTY resize 후 8초 동안 `\x1b[?25l...\x1b[H` 패턴의 전체화면 repaint 차단해 cursor 위치 깨짐 방지. resize 이벤트 즉시 drop window 활성화 (debounce 80ms 대기 X)
- **schedulePtyResize** — 1.5s debounce + 8s drop window 로 maximize → restore round-trip cover

### Scroll 안정성
- **tail -F 등 빠른 출력 중 viewport 안정화** — scrollback 증가로 인한 viewport drift 방지 (SSH/PTY 양쪽)
- ydisp 를 "끝에서부터의 offset" 기준으로 보존 → 새 출력 와도 사용자가 보던 라인 그대로 유지

### Mini-tab UX
- **세션 복제** — 수동 클릭 감지 (500ms 내 2번 클릭) 로 layout 재렌더와 무관하게 안정 동작
- **우클릭 메뉴 정상화** — 찾기 / 화면 지우기 / 스크롤 버퍼 크기 변경 모두 작업 후 터미널 포커스 복귀

### 패널 영속화
- **분할 비율 드래그 후 영속화** — `node.sizes` 트리에 저장 → 워크스페이스 전환 후 복원

## 🔧 포커스 / 모달 UX

- **세션 편집 / 옵션 / 매뉴얼 닫힘 시 자동 포커스 복귀** — `restoreTermFocusRef` 0/30/80/150/300ms 다중 재시도 + `activeElement.blur()` 강제
- **showQuickConnect / showBroadcast 영구 toolbar 가시성** 을 모달 anyOpen 체크에서 제외 — 옵션 닫힘 정상 감지 (이전엔 항상 "다른 모달 열려있음" 판정해서 포커스 복귀 안 됨)
- 스크롤 버퍼 크기 변경 다이얼로그 / SessionEditor / Options 모든 닫기 경로에서 포커스 복귀

## 🎨 그 외 개선

- **Codex / Gemini AI 에이전트 통합 강화** — sandbox 권한 드롭다운 연동, 채팅창 내 에이전트 전환
- **macOS** — OpenVPN universal binary 번들, claude:check PATH 보강, nvm alias 체인 resolve
- **VPN credential safeStorage** — session-* per-instance sessionData 비활성화로 자격증명 영속 깨짐 해결
- **File Compare** — Mac 에서 우측 라인 한 줄 밀려보이는 EOL 정규화 (Mac 전용 적용)

## 🐛 핵심 버그 수정

- 터미널 resize 시 컨텐츠 손실 / 첫줄 잘림 / cursor desync
- 분할창 닫기 후 viewport 빈 공간 / 스크롤 위치 reset
- maximize / restore 사이클 후 컨텐츠 사라짐
- 파일 패널 alert() 6군데 → React 모달로 교체 (OS 포커스 잃지 않음)
- 패널 분할 비율이 워크스페이스 전환 시 초기화되던 문제

## 📦 빌드 / 의존성

- 베이스 머지: hyungduk/main 31개 커밋 + nyaong902/v2.1.0 7개 cherry-pick
- 신규 라이브러리: `i18next`, `react-i18next`
- 신규 컴포넌트: BrowserPane, CompareWorkspace, LogAnalyzer, VpnWorkspace, TranslationEditor, SqlToolWorkspace, ChmodDialog, ConflictDialog, RenameDialog, RemotePathPicker, TransferLog, ErrorBoundary

---

**다운로드**: `release/PePe Terminal(SSH) Setup 2.1.0.exe` (NSIS installer) / `release/PePe Terminal(SSH) 2.1.0.exe` (portable)
