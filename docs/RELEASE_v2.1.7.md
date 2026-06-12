# PePe Terminal(SSH) v2.1.7

> 베이스: v2.1.6 + **AI Chat 안정성·가독성·첨부 강화** · 툴 승인 스마트 분류 · Mermaid ASCII 폴백 · 붙여넣기/EPIPE 버그 수정

## 🤖 AI Chat

- **클립보드 paste 첨부** — 입력창에 `Ctrl+V` 로 스크린샷/클립보드 이미지를 바로 첨부 (임시파일 저장 후 절대경로로 AI 에 전달)
- **외부 파일 드래그앤드롭 첨부** — Explorer 에서 이미지/PDF/zip 등을 AI Chat 영역에 끌어다 놓아 첨부
  - 렌더러 drop 처리(`webUtils.getPathForFile`) + 메인 `will-navigate`/`will-download` 백스톱
  - 첨부 시 절대경로를 prompt 에 명시하고 부모 폴더를 `--add-dir` 로 전달해 AI 가 Read 가능
  - ※ 외부 드래그앤드롭은 패키지 설치본에서 동작 (dev 모드는 origin 보안 제약)
  - 📄+ → **📎 파일** 버튼(모든 형식), placeholder 첨부 안내
- **스트리밍 안정망** — `result`/`done` 이벤트 누락으로 응답이 평문 상태로 멈춰 마크다운 렌더가 안 되던 문제: 10초 무응답 시 자동 finalize → 정상 렌더 복구
- **도구 호출 라벨 가독성** — 긴 WebDAV UNC 경로에 가려 파일명이 안 보이던 문제. 도구별 핵심 필드만 표시(Read/Write/Edit→파일경로, Grep→패턴, Bash→명령, Agent→설명 등)
- **툴별 승인 스마트 분류** — 툴 단위 승인 모드에서 단순 읽기 명령(`ls`/`cat`/`find`/`grep`/`git status` 등)은 자동 통과, 변경 명령만 승인 요청. **ClearCase** 대응: `cleartool`/`ct` 의 읽기 서브(ls/desc/lshistory 등) 자동 통과, 쓰기(co/ci/mkelem/...) 및 사용자 alias(`ctco`/`ctci`/`ctcocr`/`actci` 등)는 승인 요청
- **Mermaid ON/OFF 토글** — 렌더 실패/한글 라벨 깨짐 회피용. OFF 시 flowchart 를 트리 스타일 **ASCII 다이어그램**으로 변환 (입력바 ◆/◇ 버튼, 설정 영속화)

## 🐛 버그 수정

- **MCP SSH 서버 EPIPE** — Claude Code 가 컨텍스트 전환/재연결 시 MCP 서버의 stdout 파이프를 닫으면 다음 write 가 EPIPE("nonexistent pipe")로 프로세스를 죽이고, 그 오류가 채팅에 노출되던 문제. `sendMsg`/stdout/stdin/uncaughtException 에 EPIPE 방어 추가 → 조용히 종료
- **여러 줄 붙여넣기 창이 안 닫힘** — 같은 터미널에서 붙여넣기 모달을 빠르게 두 번 열면 옛 창의 지연된 `closed` 이벤트가 새 창의 맵 엔트리를 삭제 → 취소/✕/Esc 가 안 먹던 race condition. 맵이 자기 자신을 가리킬 때만 삭제하도록 가드

## 📦 빌드

- 버전: 2.1.7
- 다운로드: `release/PePe-Terminal-SSH-Setup-2.1.7.exe` (NSIS installer, 서명됨) / `release/PePe-Terminal-SSH-2.1.7-portable.exe` (portable, 서명됨)
- 자동 업데이트: GitHub `v2.1.7` 릴리즈에 `latest.yml` + 설치 exe(+`.blockmap`) 업로드 (파일명이 URL-safe 라 GitHub 자동 치환 없음)

---

### 포함 커밋 (v2.1.6 → v2.1.7)

- `fix: MCP SSH 서버 EPIPE 방어 + 여러 줄 붙여넣기 창 race condition`
- `1355ca9` feat(chat): 클립보드 paste + 외부 파일 드래그앤드롭 첨부
- `f644b87` feat: v2.1.7 AI Chat 안정망 / 도구 라벨 가독성 / 툴 승인 분류 / Mermaid ASCII
