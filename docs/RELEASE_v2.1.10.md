# PePe Terminal(SSH) v2.1.10

> 베이스: v2.1.9 + **Claude 529 자동 재시도 · 세션 검색/AI 정리 · AI Chat 첨부 영속화 · Codex 경고 제거 · 터미널 검색 UX 개선**

## 🔁 Claude 529 자동 재시도

피크 시간대에 Opus 등 상위 모델에서 자주 발생하는 **HTTP 529 (Overloaded)** 를 사용자에게 노출하지 않고 자동으로 재시도합니다.

- 응답 시작 전 과부하만 재시도 (이미 응답이 흐른 뒤의 에러는 그대로 노출).
- 백오프 **1.5s → 3s → 4.5s**, 최대 **3회** 재시도 (총 4회 시도).
- 재시도 중에는 `⏳ 서버 과부하(529) — N초 후 재시도 (k/3)...` 안내만 표시.
- stop 누르면 재시도도 즉시 취소.

## 🗂️ 세션 관리 — 검색 + AI 자동 정리

- **세션 검색바**: 좌측 세션 트리 상단에 검색 입력 추가 — 이름/호스트로 즉시 필터.
- **세션 전체 초기화** 다이얼로그 (`sessions:clear`).
- **AI 자동 분류 정리**: claude/gemini/codex 중 가용한 에이전트로 현재 세션 목록을 분석해 폴더 자동 분류 (`sessions:replace-all`).

## 📎 AI Chat — 첨부 마운트 세션별 영속화

파일 트리에서 우클릭으로 AI Chat에 첨부한 파일/폴더(`mountEntries`)가 앱 재시작 후에도 유지됩니다.

- **저장된 세션 id 단위**로 영속화 (quick connect 등 임시 세션은 제외).
- termId/UNC 경로는 매 연결마다 바뀌므로 **`remotePath + isDir`만 저장**.
- 같은 sessionId의 세션을 다시 연결하면 이전 첨부가 **자동 복원** (사용자가 직접 지운 상태면 그대로 유지).

## 🤖 Codex — project-local config 경고 제거

- 경고 `Ignored unsupported project-local config keys in C:\Users\<user>\.codex\config.toml: notify` 제거.
- 원인: codex `cwd` 가 `USERPROFILE` 이라 `<cwd>/.codex/config.toml`(사용자 실제 config)을 project-local 로 잘못 인식.
- 수정: SSH 컨텍스트로 임시 `CODEX_HOME` 을 만들 때는 그 dir 을 cwd 로도 사용 (`.codex` 하위 없음 → project-local 스캔 안 발생, auth 손실 없음).

## 🔍 터미널 검색 UX

- **매치 없을 때 스크롤이 맨 위로 튀는 문제** — 검색바 열 때 모든 터미널의 viewport 를 anchor 로 저장하고, 검색 중에는 갱신하지 않음. 매치 실패 시 anchor 로 복귀해 사용자가 보던 위치 유지.
- **다른 미니탭으로 활성 전환 시 처음부터 다시 검색하던 문제** — 미니탭/패널 전환 시에는 새 타겟에 하이라이트만 다시 칠하고 viewport 는 그대로 둠. Next/Prev 로 명시적으로 이동.

## 📦 빌드

- 버전: 2.1.10
- 다운로드: `release/PePe-Terminal-SSH-Setup-2.1.10.exe` (NSIS installer, 서명됨) / `release/PePe-Terminal-SSH-2.1.10-portable.exe` (portable, 서명됨)
- 자동 업데이트: GitHub `v2.1.10` 릴리즈에 `latest.yml` + Setup exe + `.blockmap` 업로드.

---

### 포함 커밋 (v2.1.9 → v2.1.10)

- `5a593be` 터미널 검색 — 미니탭 전환 시 처음부터 다시 찾는 문제 (하이라이트만 다시 칠함)
- `49749ff` 터미널 검색 — 매치 없을 때 스크롤이 맨 위로 튀는 문제 (anchor 기반 복원)
- `646fb23` Claude 529 자동 재시도 + 세션 검색·AI 정리 + 첨부 프리셋 영속화
- `d7f2059` Codex project-local config 경고(notify) 제거 — cwd 를 임시 CODEX_HOME 으로
