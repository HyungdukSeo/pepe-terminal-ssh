# PePe Terminal(SSH) v2.1.1

> 베이스: v2.1.0 + AI 에이전트(Codex·Gemini) 전면 통합 및 안정화

v2.1.0 에서 "에이전트 전환 버튼"만 있던 Codex / Gemini 를 **Claude 와 동일한 수준의 1급 에이전트**로 끌어올린 릴리즈입니다.

## 🆕 Codex 에이전트 정식 통합

- **도구 사용 타임라인** — Claude 처럼 Read / Edit / Shell 등 도구 호출 내역을 채팅창에 단계별로 표시
- **계획 승인 흐름** — 계획(plan) 제시 → 승인 → 거절 시 인디케이터 후 재표시. 자동 승인 체크 시 즉시 진행
- **토큰 / 사용 한도 표시** — 컨텍스트 사용량과 남은 요금 한도(rate limit)를 표시. 탭 진입 시 대화 전에도 한도 조회
- **UNC / WebDAV 경로 접근** — 원격 파일 분석을 위해 sandbox 를 `danger-full-access` 로 운용
- **한글 인코딩 정상화** — CP949 stdin 인코딩 처리, `codex.exe` 직접 spawn 으로 cmd.exe/node 체인 우회
- **모델 목록 정비** — GPT-5.5 / 5.4 / 5.3 등 모델 선택, ERROR JSON 파싱·ANSI 제거 개선
- **응답 누락 버그 수정** — `setMessages` updater 순수성 문제로 응답이 보이지 않던 근본 원인 해결

## 🆕 Gemini 에이전트 정식 통합

- **도구 사용 표시** — Gemini CLI 의 tool_use / tool_result 이벤트를 채팅 타임라인으로 변환
- **계획 승인 흐름** — 파일 편집(write)·ClearCase 도구 사용 시 권한 허용창 표시. read/grep 등 조회성 도구는 자동 진행. 자동 승인 체크 시 즉시 진행
- **모델 가용성 정상화** — 404 유발 모델 오탐 수정. Code Assist 요금제(tier) 조회로 사용 가능한 모델만 활성화하고 미지원 모델은 "지원안함" 표시
- **사용량 / 할당량 표시** — `loadCodeAssist` + `retrieveUserQuota` 로 잔여 할당량과 리셋 시각 표시
- **SSH MCP 원격 접근** — `ssh_exec` / `ssh_read_file` / `ssh_write_file` MCP 서버로 원격 서버 파일 분석 지원
- **한국어 기본 응답** — 별도 지정 없이 한국어로 답변
- **`update_topic` 노이즈 제거** — 응답 텍스트에 섞여 나오던 토픽 지시문 필터링
- **OAuth 자격증명 하드코딩 제거** — 보안 강화

## 🆕 AI 사용량 패널

- Codex / Gemini 사용량 패널 추가 — 컨텍스트 구성과 한도를 Claude 사용량 패널과 동일한 형식으로 표시
- 슬래시 명령 팔레트(모델·effort·permission/approval)를 **에이전트별로 동적 구성** — Codex 는 Approval Policy, Gemini 는 effort 섹션 숨김 등

## 🎨 mermaid 다이어그램 렌더링 안정화

- **인코딩 깨짐 hang 차단** — Codex 한글 인코딩 문제로 mermaid 파서가 무한 루프에 빠지던 현상 차단
- **Gemini 다이어그램 복원** — 스트리밍 delta 의 선행 개행이 잘려 코드블록이 붙던 문제, `sequenceDiagram` 펜스가 조기 종료되던 문제 수정
- **흰 배경 문제 수정** — `rect rgb(...)` 의 밝은 파스텔 색을 저투명 톤으로 변환하고, 렌더된 SVG 의 밝은 배경을 방어적으로 투명화해 다크 배경으로 통일
- **파싱 오류 수정** — 라벨/메시지 텍스트의 HTML 엔티티(`&lt;` `&gt;`)가 `;` 문장 구분자로 오인되던 문제를 전각 부등호(`＜` `＞`) 치환으로 해결

## 🎨 UI 개선

- **AI 대화창 핀 레이아웃 정리** — 패널 고정 시 빠른연결바 / 도구모음바 / 일괄전송바 / 세션 사이드바를 가리거나 함께 늘었다 줄지 않도록 콘텐츠 영역만 조정
- **터미널 패널 고정 버튼** — 고정 해제 상태에서 사이드바 트리거에 핀 버튼 추가, 도구모음과 동일한 핀 아이콘 사용
- **브랜드 SVG 아이콘** — 에이전트 탭 및 채팅 응답 헤더에 Anthropic / Google / OpenAI 공식 로고 SVG 적용 (이모지 → 일관된 브랜드 아이콘)

## 🐛 버그 수정

- **브라우저 무한 새로고침 해결** — webview `src` 를 url state 에 묶어 리다이렉트(google.com 등)마다 reload 되던 무한 루프 차단. `src` 는 초기 1회만 설정
- **세션 트리 폴더 재귀 복사** — 하위 폴더·세션까지 함께 복사, 복사 메뉴 라벨/붙여넣기 대상 수정
- **사이드바 unpin 즉시 반영** — 고정 해제 시 세션 사이드바 / 터미널 패널 즉시 숨김
- 일괄 파일전송 로그(TransferLog) 의 삭제 이벤트를 워크스페이스별로 격리
- 자격증명 모달 포커스 트랩 / 비밀번호 표시 토글 / xterm 포커스 가로채기 차단
- 파일 탐색기 탭별 인스턴스 격리, 활성 SSH 세션 자동 선택
- 이력 삭제 `confirm()` → React 모달로 교체

## 📦 빌드

- 버전: 2.1.1
- 신규 컴포넌트: `mcpSshServer.cjs` (Gemini SSH MCP 서버)

---

**다운로드**: `release/PePe Terminal(SSH) Setup 2.1.1.exe` (NSIS installer) / `release/PePe Terminal(SSH) 2.1.1.exe` (portable)
