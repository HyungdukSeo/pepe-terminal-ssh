# PePe Terminal(SSH) v2.1.2

> 베이스: v2.1.1 + AI 채팅 UX 대폭 강화 (검색·컨텍스트 공유 토글·이력 자동 선택·hyperpower 커서) + mermaid 안정화

## 🆕 AI 채팅 UX 대폭 강화

### 메시지 검색 (🔍)
- 헤더 🔍 버튼으로 검색바 토글 — 현재 대화의 모든 메시지 본문·코드·라벨에서 텍스트 찾기
- `N/M` 카운터, ↑↓ 이전/다음 hit 이동, Enter/Shift+Enter, Esc 닫기
- 매칭 부분 노란 하이라이트, 현재 hit 은 주황색 + 빨간 윤곽, smooth 스크롤로 자동 이동
- 스트리밍 중 메시지가 늘어나도 자동 재하이라이트

### 에이전트 간 컨텍스트 공유 토글 (🔗)
- 헤더 🔗 버튼으로 Claude/Gemini/Codex 간 대화 컨텍스트 공유 ON/OFF
- ON (기본): 모든 에이전트가 서로의 답변·도구 사용을 보면서 이어 대화
- OFF: 각 에이전트는 자기 스레드만 봄 — 사이드바 이력도 참여한 에이전트 별로 분리, 메시지 화면도 필터링
- 단 이전에 ON 모드에서 만들어진 **mixed-agent 대화는 OFF 모드에서도 그대로 보존** (히스토리 무결성)
- 토글 시 Claude `--resume` 세션 폐기 → 이전 모드의 cross-agent 메모리가 부활하는 문제 차단
- UIPrefs 영속화, 시각화: ON = 초록 글로우 / OFF = 빨간 사선 차단 표시
- 에이전트별 streaming 추적 — 한 에이전트 응답 대기 중에도 다른 에이전트로 전송 가능

### 가장 최근 대화 자동 선택
- 앱 시작 / 에이전트 전환 / 공유 모드 토글 시 현재 view 의 가장 최근 대화를 자동 로드
- 현재 view 에 이력 없으면 새 대화 상태 (UI 만 리셋)
- `+` 새 대화 버튼 클릭 시 자동 선택은 비활성 — 사용자 의도 보존

### 사이드바 이력에 참여 에이전트 표시
- 각 대화 항목 옆에 참여한 모든 에이전트의 브랜드 아이콘 표시 (Claude / Gemini / Codex)
- 다중 에이전트면 첫 등장 순서로 살짝 겹쳐 컴팩트하게
- 공유 OFF 시 현재 에이전트가 한 번이라도 참여한 대화만 사이드바에 표시

### 🗑 휴지통 버튼
- 현재 대화의 내용(메시지·도구·사용량) 만 비우고 history 항목은 유지 → 같은 대화로 돌아와도 빈 상태로 시작
- 진행 중 백그라운드 프로세스도 함께 종료
- `+` 새 대화 버튼과 명확히 구분된 동작

### 헤더 레이아웃 정리
- CSS Grid `1fr auto 1fr` 3열 구조로 변경 — 좌(에이전트 탭 + 버전) / 중앙(📌🔍🔗) / 우(+/≡/🗑/×)
- 좌·우 폭 차이와 무관하게 중앙 버튼들이 항상 정중앙 정렬, 겹침 없음
- 채팅 응답 헤더 아이콘을 탭과 동일한 브랜드 SVG 로 통일

## 🆕 hyperpower 스타일 커서

기존 커서 모양(파워/하트/별/불꽃/무지개/동그라미)을 vercel/hyperpower 영감으로 전면 재작성:

- **단일 canvas 파티클 시스템** — DOM 노드 폭증 회피, rAF 1개, 활동 없으면 자동 정지
- 테마별로 색/모양(원·이모지)/중력/페이드/흔들림/파티클 수/속도/합성모드/스폰 위치 분리 설정
- **power 만 격렬한 누적 흔들림** (hyperpower 시그니처) — 빨리 타이핑할수록 더 격렬한 진동
- 모든 테마 커서 셀 중앙에서 분사
- 신규 **🔮 프리즘 커서** — 네이티브 block 커서를 유지하면서 cursor 색을 25ms 주기로 무지개 7색 사이 선형 보간 → 글자는 자동 반전 표시되고 커서만 무지개 순환

### subgraph 모양 컨테이너 (mermaid 한계 극복)
- mermaid 자체에는 사각형 외 컨테이너가 없지만 SVG 후처리로 가능:
  - ★ ☆ ⭐ → 별 / △ ▲ ▽ ▼ → 삼각형 / ◆ ◇ → 마름모 / ⬠ ⬟ → 오각형 / ⬢ ⬣ → 육각형
- subgraph title 에 모양 기호 포함 시 자동으로 polygon 으로 교체
- "삼각형 안에 동그라미" 같은 비전형 중첩 시각화 가능

## 🔧 mermaid 안정화 (한글·다이어그램 깨짐 다수 수정)

- `closeDanglingMermaidFences` 의 `isMermaidSyntax` 가 ASCII 전용 정규식이라 **한글 노드 ID 줄을 prose 로 오인해 펜스 조기 종료** 하던 문제 해결 (가장 큰 렌더 실패 원인). 한글 식별자 + `>` (asymmetric) + `@{` (v11 shape) 모두 인식
- 한글/Unicode 노드 ID 를 안전한 영문 alias (`n1`, `n2`, ...) 로 변환. edges 참조도 함께 교체. 따옴표/shape brackets/엣지 라벨/asymmetric `>...]` / 주석(`%%...`) 영역은 보호 → 라벨 안 한글은 alias 안 됨
- mermaid v11 `ID@{ shape: X, label: "Y" }` 새 문법 호환:
  - `tri`/`triangle` 은 native 처리에 맡김 (사다리꼴 강제 변환 X)
  - 그 외 shape 는 전통 노드 모양으로 변환 (15종 매핑)
- subgraph: 한글 ID / quoted title / 공백 / 빈 title 형태 정규화
- 노드 label 의 따옴표 안 leading/trailing 공백 trim (단 trim 결과가 빈 문자열이면 원본 유지)
- `direction TB|LR|...` 내부 지시 제거 (subgraph header 와 충돌 회피)
- classDiagram 의 도형 문자 클래스 이름(`┌─┐` 등) → 안전한 영문 alias (`C1`)
- HTML 엔티티(`&lt;` `&gt;`)가 `;` 문장 구분자로 오인되던 문제 → 전각 부등호(`＜` `＞`) 치환
- 라이트 테마 배경(흰 박스) 흑백 통일, 모델이 넣는 라이트 톤 `rect rgb()` 자동 dim

## 🔧 Gemini / Codex 강화

- **Gemini 응답 누수 제거** — `update_topic(strategic_intent='...')` / `save_memory(...)` 함수 호출을 균형 잡힌 괄호 파서로 안전하게 제거 (multiline · unescape 따옴표 · 긴 값 모두 처리)
- **Gemini 거짓 에러 무시** — 응답 끝에 메타 도구가 있어 발생하는 `Invalid stream: empty response or malformed tool call` 류 메시지를 텍스트가 정상 전달된 경우 무시
- **Gemini 자동승인 기본 OFF** — 신규 사용자는 항상 "계획 먼저 보여주고 승인" 흐름
- **공유 OFF + Gemini 첫 turn**: `save_memory`/`update_topic` 도구 사용 금지 + 자동 로드된 사용자 메모리 무시 시스템 지시 추가
- 시스템 프롬프트 톤 개편 — "ASCII 절대 금지" 위협 톤 → "라벨에 한글 OK, 식별자만 영문" 가이드 톤. 빈 라벨/title 금지 + 도형별 mermaid 문법 표 + 완전한 예시 다이어그램 + 다크 테마 색상 주의

## 🔧 UI · 워크스페이스

### 패널 비율 균등 정렬 버튼
- 도구 모음에 ⊞ 버튼 추가 — 현재 워크스페이스의 모든 행/열 분할 비율을 균등으로 리셋
- 2×2 SVG 아이콘 + 우하단 ✓ 마크로 "정렬 완료" 의미 강조

### 비-터미널 워크스페이스에서 세션 더블클릭 동작
- 브라우저/파일비교/로그분석/VPN/다국어/SQL Tool 워크스페이스에서 세션 더블클릭 시 자동으로 터미널 워크스페이스로 전환 후 연결 (없으면 새 터미널 워크스페이스 생성)

### 우클릭 글꼴 변경 시 PTY/SSH resize 전파
- 우클릭 다이얼로그로 폰트/사이즈 변경 시 fit 후 변경된 cols/rows 를 ptyResize/resizeSSH 로 전파 → vi 같은 풀스크린 앱이 옛 row 수만 채워 아래가 비어 보이던 문제 해결

### 도구모음 행 빈 공간 색
- 빠른연결 바 옆/우측 빈 공간이 부모 배경으로 비쳐 도구모음과 색이 달라 보이던 문제 수정 — `.quickconnect-row` 배경을 도구모음과 동일하게, 도구모음이 단독일 때 행 가득 채움

### Pin 버튼 / 부팅 시 셸 미스매치
- AI 채팅 핀/언핀 버튼 위치를 + 새 대화 버튼 옆으로 정렬
- `defaultShellName` 이 shells 목록에 없는 값(예: 'CMD')일 때 path 가 PowerShell 로 폴백되면서 탭 이름과 실제 셸이 불일치하던 문제 수정

## 🐛 기타 버그 수정

- 브라우저 워크스페이스 (`BrowserPane.tsx`) — webview src 를 url state 에 바인딩하면 리다이렉트마다 reload 되어 google.com 같은 사이트에서 무한 새로고침 발생. src 는 초기 URL ref 로 1회만 설정 (hyungduk → 통합)
- `🗑` 휴지통 버튼이 history 항목까지 지우는 게 아니라 내용만 비우도록
- 비활성 분기 stream 종료 시 streamingAgents 정리 — 다른 탭으로 전환한 채 응답 끝나면 streaming 상태가 영구히 남던 문제

## 📦 빌드

- 버전: 2.1.2
- 헤더 레이아웃 CSS Grid 도입
- mermaid sanitizer 약 400 라인 추가 (한글·도형·v11 호환)
- 도구모음 SVG 아이콘 ⊞ 추가

---

**다운로드**: `release/PePe Terminal(SSH) Setup 2.1.2.exe` (NSIS installer) / `release/PePe Terminal(SSH) 2.1.2.exe` (portable)
