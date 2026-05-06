# PePe Terminal(SSH) v2.0.7

> X11 forwarding (번들 VcXsrv) · 도구 모음 바 · 세션 편집기 라이브 적용 · 커스텀 커서 스타일

---

## ✨ 주요 신규 기능

### X11 Forwarding (Qt/GTK 모두 지원)

원격 GUI 앱(`xclock`, `wireshark`, `gedit` 등)을 Windows 데스크톱에 바로 띄울 수 있게 됐습니다.

- **번들 VcXsrv** — 설치 시 `resources/x11-server.zip` 자동 압축 해제 (NSIS install-time PowerShell). 별도 설치 불필요
- **자체 X11 서버 폴백** — Shape extension 포함, 번들 X 서버 사용 안 할 시 작동
- **SSH X11 forwarding race condition 수정** — `x11-req` 가 `conn.shell` 직전에 동기 등록되도록 보정
- **MIT-MAGIC-COOKIE-1 인증** + 진단 로그 + 좀비 프로세스 정리
- **도구 메뉴/바에서 X 서버 시작 / 중지 / 상태 조회** — DISPLAY=:0 자동 매핑

### 도구 모음 바 (Toolbar)

자주 쓰는 토글/액션을 아이콘 바로 묶었습니다.

- 📁 파일 전송 / ⚡ 빠른연결 토글 / 🤖 Claude 채팅 토글 / 📢 일괄전송 토글
- 🖥️ X 서버 시작 / 🛑 중지 / ℹ️ 상태
- ⚙️ 옵션
- **⋮⋮ 핸들 드래그**로 빠른연결 바 좌측 / 우측에 스냅 (마그네틱 힌트 라벨)
- 위치 (`top` / `qc-left` / `qc-right`) 와 표시 여부 localStorage 영속
- 빠른연결 바 표시 시 기본 위치 = 우측

### 세션 편집기 — Xshell 풍 트리 사이드바

좌측 카테고리 트리: **연결 / 사용자 인증 / SSH 점프 / 로그인 스크립트 / 터미널 / 모양 / 고급 / 파일트리 / X11**

- **모양 카테고리** — 테마 미리보기 박스 (실제 색상으로 Normal/Bold/Underline/Reversed/Cursor 샘플)
- **커서 스타일 9종** — block / underline / bar / 🔥flame / ✦star / ♥heart / ●circle / 🌈rainbow / 💥power
- **백스페이스 빈 입력 시 효과** — power = 화면 흔들림, heart/star/flame/rainbow = 파티클 분사
- **`적용` / `닫기` / `연결` 버튼 분리** — 적용은 설정만 저장 후 창 유지, 연결은 새 탭으로 열림
- **미리보기 글자 크기 13px 고정** — 사용자 fontSize 무관

### 세션 라이브 적용 (재연결 불필요)

미니탭 우클릭 + 터미널 우클릭에 **세션 편집** 추가. 적용 시 해당 터미널에 즉시 반영:

- 테마 / 폰트 / 폰트 크기 / 스크롤백 / 커서 스타일 / 커서 깜박임
- 세션 복제 시 커서 스타일/깜박임도 함께 복제 (`termCursorStyleCache`)

### bar+blink 커스텀 오버레이

xterm.js 5.x 의 `cursorStyle: 'bar' + cursorBlink: true` 가 일부 환경에서 깜박이지 않던 문제 해결:

- 자체 DOM 오버레이로 직접 그려 깜박임 보장
- 글자 뒤(`cursorX+1` 셀) 위치 — 텍스트 겹침 방지
- 셀 크기/스크롤 변경에 동기화

---

## 🪟 검색 / 붙여넣기 / 세션 편집기 BrowserWindow 분리

기존 인라인 모달이 메인 창 안에서만 동작하던 문제 개선:

- **검색 바**: 🪟 버튼으로 외부 BrowserWindow 분리. alwaysOnTop, 핀 토글
- **여러 줄 붙여넣기**: 별도 BrowserWindow (`thickFrame: false` 로 Aero Snap 비활성)
- 검색 이력은 메인 프로세스 메모리 보관 (앱 종료 시 휘발)
- 외부 검색 창에서도 현재 탭 / 전체 탭 / 정규식 / 대소문자 모드 모두 동작

---

## 🐛 버그 수정 / UX 개선

- **NSIS 설치 진행 표시** — 카테고리 단위 단일 라인 라벨, ShowInstDetails show
- **NSIS 제거 시 x11-server 통째 삭제** — `cmd /c rmdir /S /Q` 로 빠른 cleanup (파일 단위 출력 X)
- **vi 풀스크린 작게 뜨는 문제** — 윈도우 focus / visibilitychange 시 forceSyncNow 추가, refit 다단계 (100/300/700/1200ms)
- **여러 줄 붙여넣기 모달 띄워있는 동안 터미널 키 입력 차단** — paste 결과 모달 종료 시까지 stdin block
- **`ls -l;\n...` 처럼 짧은 다중라인은 그냥 입력** — 모달 안 띄움 (개행 횟수 임계값)
- **X11 forwarding 행 정렬** — 가운데 정렬 + input 너비 70px 고정
- **세션편집기 모양 미리보기 fontSize 고정** — 사용자 글자 크기 무관

---

## 📦 다운로드

| 파일 | 설명 |
|---|---|
| `PePe Terminal(SSH) Setup 2.0.7.exe` | NSIS 인스톨러 (코드 서명됨, x11-server 자동 추출) |
| `PePe Terminal(SSH) 2.0.7.exe` | 포터블 (코드 서명됨) |

**시스템 요구사항**: Windows 10/11 x64

> X11 forwarding 은 Linux 서버 + 번들 VcXsrv (또는 외부 X 서버) 조합에서 동작. Qt / GTK / Tk / Java(Swing) 모두 확인됨.

---

## 🛠 기술 스택

Electron 30 + React 18 + TypeScript + Vite · xterm.js 5.3 · Monaco Editor · node-pty · ssh2 · webdav-server · marked · mermaid 10 · @anthropic-ai/claude-code

---

## 만든 사람

- Code: **Claude Opus 4.7 (1M context)**
- Prompt / Direction: **ghjeong**

---

이전 버전: [v2.0.6](RELEASE_v2.0.6.md) — 백그라운드 PWD 자동추적 + UI 개선
