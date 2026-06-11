# PePe Terminal(SSH) v2.1.6

> 베이스: v2.1.5 + **메모리 회수 / AI Chat 중단 안정화 / 레거시 SSH 서버 호환 / SQL Tool 그리드 컬럼 reorder · 에러 UI 개선**

## ♻ 메모리 회수 (오래 켜둘수록 무거워지던 문제 완화)

- **`disposeTermFully(termId)`** — 패널 X / 탭 닫기 / 세션 닫기 시 xterm Terminal 인스턴스(`term.dispose()`) + termId-keyed 보조 캐시 30+ 종 (flame interval, 검색 오버레이 DOM, reconnect timer, ssh/pty 이벤트 핸들러, 비밀번호 프롬프트 disposable, 폭/테마/커서스타일 캐시 등) 일괄 정리. 종료된 SSH 패널이 영구히 메모리에 남던 문제 해소
- **ClaudeChat 마크다운 캐시** 한도 500 → 200 으로 축소
- **mermaid render 타임아웃** `.finally(clearTimeout)` 추가 — race 후 살아남던 8s 타이머 정리

## 🛑 AI Chat 중단 안정화 (claude / gemini / codex)

- 중단(■ stop) 직후에도 stdout 버퍼에 남은 응답이 렌더러로 계속 흘러가던 문제 수정
- 메인 프로세스에 **`stoppedAgentProcs` 가드** 도입 — stop 핸들러 호출 즉시 procKey 차단, 이후 stdout/stderr/close 이벤트 송신 자체를 막음 (taskkill 비동기 완료 대기 불필요)

## 🔌 레거시 SSH 서버 호환 (구버전 OpenSSH / Solaris / 임베디드)

- ssh2 의 기본 KEX/cipher 가 modern 만 포함해 `diffie-hellman-group14-sha1` / `ssh-rsa` 만 제공하는 레거시 서버와 협상 실패하던 문제
- 모든 connect 경로(메인 SSH / SQL Tool primary / dedicated SFTP)에 `LEGACY_ALGO_OPT`(SUPPORTED_KEX / SUPPORTED_SERVER_HOST_KEY / SUPPORTED_CIPHER / SUPPORTED_MAC) 적용 — 현재 시스템 crypto 가 지원하는 알고리즘 전체 허용
- 결과: PePe SSH 세션으로 구버전 서버에 옵션 없이 바로 접속 가능

## 🗂 SQL Tool 개선

- **결과 그리드 컬럼 순서 이동** — 헤더를 드래그해서 원하는 위치에 드롭 (드롭 타겟 강조 + 드래그 중 투명도 피드백). 정렬 / 필터 / 폭 / 핀 / 인라인 편집 / PK 기반 update 등 모든 데이터 작업은 원본 인덱스 기준이라 영향 없음
- **SSH 터널 매칭 실패 에러 메시지 사용자 친화** — 이전엔 16+개 터미널 상세 dump 를 빨간 박스에 쏟아냈음. 이제 핵심만:
  - `<host>:<port> 에 연결된 활성 SSH 터미널이 없습니다.`
  - `현재 연결된 SSH: 192.168.191.11, 172.16.71.131, ... (외 N개)`
  - `→ 먼저 <host> 로 SSH 세션을 연결한 뒤 다시 시도하세요.`
  - 전체 디버그 dump 는 메인 콘솔로만
- **에러 박스** — `pre-wrap` + `maxHeight: 96px overflow:auto` + **✕ 닫기 버튼**. 긴 메시지가 화면을 가리지 않음

## 📦 빌드

- 버전: 2.1.6
- 다운로드: `release/PePe Terminal(SSH) Setup 2.1.6.exe` (NSIS installer, 서명됨) / `release/PePe Terminal(SSH) 2.1.6.exe` (portable, 서명됨)
- 자동 업데이트 활성화: GitHub `v2.1.6` 릴리즈에 `latest.yml` + `PePe Terminal(SSH)-Setup-2.1.6.exe` + `.blockmap` 업로드 (latest.yml 의 url 과 동일한 하이픈 이름으로)

---

### 포함 커밋 (v2.1.5 → v2.1.6)

- (이 릴리즈의 통합 커밋 — `feat: v2.1.6 메모리 회수 / AI 중단 안정화 / 레거시 SSH KEX / SQL Tool 컬럼 reorder · 에러 UI`)
