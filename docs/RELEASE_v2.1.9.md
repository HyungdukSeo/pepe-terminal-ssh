# PePe Terminal(SSH) v2.1.9

> 베이스: v2.1.8 + **AI 원격 파일 접근 WebDAV → MCP 전환 · codex MCP 연동 · 도구 사용 표시 개선 · 인코딩/노이즈 정리 · AI Chat 안정화**

## 🔌 AI 원격 파일 접근 — WebDAV 제거, MCP 도구로 통일

느리고 불안정하던 WebDAV UNC 마운트 방식을 제거하고, 모든 AI 에이전트가 `pepe_ssh` MCP 도구로 원격 SSH 파일을 다루도록 통일했습니다.

- **MCP 검색 도구 추가**: `ssh_grep`(원격 내용 검색, grep -rn) · `ssh_glob`(파일명 검색, find -name). 기존 `ssh_exec`/`ssh_read_file`/`ssh_write_file`/`ssh_list_sessions`와 함께 SSH 연결 위에서 직접 동작 (WebDAV 불필요).
- **codex MCP 연동**: codex 도 `pepe_ssh` MCP 사용. 임시 `CODEX_HOME`에 `config.toml`을 생성해 주입하고 `auth.json`을 복사해 **로그인 유지** — 사용자의 `~/.codex` 설정을 오염시키지 않습니다. (claude/gemini는 기존 방식 유지)
- claude `allowedTools`에 read/write/grep/glob/list 전부 허용.
- **로컬/네트워크 드라이브**(C:\, 매핑 드라이브 등)는 영향 없음 — 에이전트가 네이티브 파일 도구로 직접 접근하며, 메시지의 드라이브 경로를 자동 감지해 작업 범위(`--add-dir`)에 추가합니다.

## 🧰 도구 사용 표시 개선

- **접힘 상태**: 동작 + 파일명만 (`📖 읽기 NtcMain.c`, `✏️ 수정 main.ts`, `🔍 검색 "pattern"`, `▶ 실행 grep`) — 경로 노출 없이 한눈에.
- **펼침 상태**: 전체 경로 + 상세 + 결과 내용.
- **그룹 요약**도 동작 단위로 (`📖 읽기 2개, 🔍 검색 1개`).
- **Edit diff**: 라인 단위 LCS diff — 공통 줄은 컨텍스트(회색), 바뀐 줄만 `+`(초록)/`-`(빨강), 긴 공통 구간은 변경 주변 ±3줄만 남기고 접기.
- **도구 결과 정리**: MCP 결과(`{content:[{type:text}]}`)에서 텍스트만 추출 — claude/codex 모두 raw JSON·`\r\n` 리터럴 노출 제거, 줄바꿈 보존.

## 🌏 인코딩 / 셸 노이즈

- **EUC-KR/CP949 자동 폴백**: ssh_exec/grep 출력과 ssh_read_file 모두, UTF-8 디코드 실패(`�`) 시 CP949로 재디코드해 덜 깨지는 쪽을 채택 — EUC-KR 소스의 한글 정상 표시.
- 원격 셸 rc(`.cshrc` 등)가 비-TTY 실행에서 뱉는 `stty: standard input: Invalid argument` 류 노이즈 라인 필터.

## 🐛 AI Chat 안정화 / 기타 (v2.1.8 → v2.1.9 누적)

- **스트리밍 안정화**: 프로세스 생존 확인(`agent:is-running`) 기반 안전망 — "잘 되다가 끊김"·중단 버튼 미활성 문제 해결.
- **첨부 동작**: 이미지/문서(ppt/docx/xlsx 등) 첨부 전송 경로 수정(useCallback 의존성·빈 텍스트 가드·버튼 활성).
- **Mermaid 안정화**: 라벨 따옴표 처리 확장(공백/한글/`?` 포함 라벨), 렌더 실패 시 ASCII 폴백, 재렌더 race 시 원본 코드 잔존 방지(`isConnected` 가드).
- **도구 입력 요약** JSON.parse 방어(try/catch), 결과 미리보기 줄바꿈 보존.
- git 로컬 stderr 콘솔 노출 억제, 앱 종료 보장(프로세스 트리 강제정리).

## 📦 빌드

- 버전: 2.1.9
- 다운로드: `release/PePe-Terminal-SSH-Setup-2.1.9.exe` (NSIS installer, 서명됨) / `release/PePe-Terminal-SSH-2.1.9-portable.exe` (portable, 서명됨)
- 자동 업데이트: GitHub `v2.1.9` 릴리즈에 `latest.yml` + Setup exe + `.blockmap` 업로드.

---

### 포함 커밋 (v2.1.8 → v2.1.9)

- `dadc712` codex MCP 연동 + AI Chat 도구 표시·인코딩 개선
- `09c5326` 도구 입력 요약 시 WebDAV 경로 JSON.parse 방어
- `be96d52` 도구 결과 미리보기 줄바꿈 보존
- `a20626d` AI Chat streaming 안정화 · 첨부 · Mermaid 폴백 · 도구 사용 상세
- `d08988e` git stderr 억제 + 종료 보장 + agent 생존확인 IPC
