# PePe Terminal(SSH) v2.0.8

## 🆕 새 기능

### Claude Code 통합 강화
- **사용량 패널 추가** — Anthropic OAuth API (`/api/oauth/usage`) 연동, 5h/주간/월간 한도와 잔량 실시간 표시
- **모델 목록 동적 갱신** — `/v1/models` API 로 사용 가능한 모델을 자동 조회. 새 모델 출시 시 즉시 선택 가능
- **effort 선택** (low/medium/high) — Claude 추론 깊이 조절
- **권한 모드 3종 정리** — `권한 요청` / `편집 자동 수락` / `계획 모드`
  - 모드별 도구별 승인 기본값 자동 토글
  - 각 모드에 아이콘 배지 표시
- **거부한 계획 다시 보기** — 실수로 계획을 거부했어도 해당 대화 이력에서 다시 확인 가능
- **도구 호출 타임라인 접기/펼치기** — 그룹 단위 + 항목 단위 양쪽 접을 수 있음
- **사이드바 hover 동작 개선** — unpin 상태에선 마우스가 2~3초 머물면 표시 (즉시 안 뜸)
- **Claude 창을 터미널 세션창 내부에 배치** — 고정핀 시 위/아래 꽉 채움
- **slash 명령 메뉴 갱신** — 현재 개발된 기능에 맞게

### 로컬 셸 파일트리 + cwd 자동추적
- **PowerShell / cmd / git bash / WSL** 모두 파일트리 표시 가능
- 셸별 OSC 7 hook 을 spawn 인자로 주입 → **사용자에게 hook 명령이 echo 안 됨**
  - PowerShell 5.1 / pwsh 7+ : `-NoLogo -NoExit -Command "..."` (`[char]27` 사용으로 5.1 호환)
  - cmd : `/K "prompt $E]7;file:///$P$E\$P$G"`
  - bash / git bash : `--init-file <임시rc>` (사용자 `.bashrc` 도 자동 source)
  - zsh : 임시 ZDOTDIR + `.zshrc`
- 터미널에서 `cd` 하면 파일트리 경로도 자동으로 따라감 (SSH 와 동일 UX)

### 기타
- **vi 멀티라인 paste** — insert 모드 우클릭 → 붙여넣기 시 여러 줄 정상 붙여넣기
- **vim `set mouse=a` 자동 동작** — DA2 응답 (xterm 버전) 패치로 vim 이 ttymouse=sgr 자동 선택. 마우스 클릭/드래그 정상 처리
- **vim 탭 전환 시 W11 경고 차단** — `\x1b[I/O` focus 이벤트 송신 차단
- **mermaid stale "Syntax error" 잔존 SVG 제거**
- **세션 복제 시 미니탭바 우클릭 → "다른 워크스페이스로 이동" 복구**
- **여러 세션 선택 후 새 워크스페이스로 한 번에 연결** (미니탭/가로/세로/타일)

## 🐛 버그 수정

### 분할창 세션복제 후 source 프롬프트에 `[r` 잔상 발생
- **원인**: 비활성 분할창의 미니탭을 더블클릭으로 세션복제할 때 source 컨테이너가 layout 갱신 중 일시적으로 0-size 가 되어 `FitAddon.proposeDimensions()` 가 `{cols:2, rows:1}` 같은 비현실 값 반환 → `term.resize(2,1)` 가 즉시 적용되어 화면을 2-col 로 reflow → 다시 정상 사이즈로 reflow 되며 프롬프트가 잘려 `[r` (root@... 의 일부) 잔상으로 보임
- **해결**: `FitAddon.fit()` monkey-patch — 부모 컨테이너 `clientWidth/Height < 20px` 또는 `proposeDimensions` 결과가 NaN/0 이면 호출 자체를 skip. cols/rows 가 아니라 **컨테이너 픽셀 크기** 기준이라 사용자가 의도적으로 좁은 패널을 사용하는 케이스도 정상 동작

### MaxListenersExceededWarning (메모리 누수)
- **원인**: `ensureSSHSetup` / `ensurePtySetup` 이 termId 마다 ipcRenderer 에 직접 listener 추가 → N개 termId 면 5N 개 SSH listener + 2N 개 PTY listener 누적 → 11개 초과 시 EventEmitter 누수 경고
- **해결**: 이벤트당 전역 dispatcher 1개만 IPC 에 등록, termId → handler Map 으로 라우팅. 항상 SSH 5개 / PTY 2개 listener 만 유지

### 기타
- **Markdown setext heading 오작동** — SSH 로그의 `==` 라인이 H1 으로 렌더링되던 문제 (zero-width space 로 중화)
- **터미널 우클릭 메뉴가 화면 밖으로 벗어남**
- **Claude 대화 이력 1 에서 거부한 계획이 다른 대화 2 에서도 보이던 문제**
- **사이드바 unpin 상태에서 일괄전송바/빠른연결바 크기 축소되던 문제**
- **세션관리창 다중 선택 후 우클릭 → 새 워크스페이스 연결**

## 🔧 내부 개선

- xterm v5.3 의 `_core.coreService` / `_core.coreMouseService` 직접 패치 인프라 정리
- 마우스 이벤트 직접 forwarding (1002 mode click 미작동 회피)
- 세션 resize 중복 차단 — `lastResizeMap`, `lastContainerSizeMap`, `fitCooldownUntil`, `pendingResize` 4단 안전망
- main process IPC dedup — 동일 사이즈 / tiny 사이즈 차단
- `disposeSSHHandlers` / `disposePtyHandlers` export — 향후 termId 정리 시점에 호출 가능

---

**다운로드**:
- `PePe Terminal(SSH) Setup 2.0.8.exe` — 설치 버전 (NSIS, perMachine)
- `PePe Terminal(SSH) 2.0.8.exe` — 포터블 (단일 실행)
