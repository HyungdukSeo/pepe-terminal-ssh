# PePe Terminal(SSH) v2.1.5

> 베이스: v2.1.4 + **자동 업데이트(electron-updater / GitHub Releases)** 도입

## 🆕 자동 업데이트

- **electron-updater 기반 자동 업데이트** — 배포 채널은 GitHub Releases (`nyaong902/pepe-terminal-ssh`)
- **시작 시 1회 자동 확인** + 도움말 메뉴의 **`🔄 업데이트 확인`** 수동 트리거
- **사용자 동의식 다운로드** (autoDownload=false) — 새 버전 발견 시 모달로 안내하고, 동의하면 다운로드
- **진행률 모달** — 다운로드 퍼센트 / 전송량 / 속도 표시, 완료 시 **`지금 재시작하여 설치`**(quitAndInstall)
- **상태 모달** — 확인 중 / 새 버전 사용 가능(+릴리즈 노트) / 다운로드 중 / 설치 준비 완료 / 최신 버전 / 미지원 / 오류 (alert 미사용, 전부 모달 처리)
- 자동(시작 시) 확인은 최신이거나 미지원이면 **조용히 무시**, 수동 확인일 때만 결과 모달 표시
- **dev / portable 빌드 가드** — 자동 업데이트는 **NSIS 설치본에서만** 동작 (portable·개발 모드는 미지원 안내)
- 코드 서명(`PePeTerminal_v2.pfx`) 기반으로 electron-updater의 설치 파일 서명 검증 통과

## 🔧 기술 / 빌드 인프라

- `package.json`에 `build.publish`(github provider) 추가 → 빌드 시 `latest.yml` 자동 생성
- `electron-updater`를 메인 프로세스 번들 external 로 지정(ssh2 등과 동일 패턴) — electron-builder 가 production 의존성으로 자동 패키징
- preload 에 업데이트 IPC API(`updaterCheck/Download/QuitAndInstall/GetState`, `onUpdaterStatus`) 노출

## 📦 빌드

- 버전: 2.1.5
- 다운로드: `release/PePe Terminal(SSH) Setup 2.1.5.exe` (NSIS installer, 서명됨) / `release/PePe Terminal(SSH) 2.1.5.exe` (portable, 서명됨)
- 자동 업데이트 활성화: GitHub `v2.1.5` 릴리즈에 `latest.yml` + 설치 exe(+`.blockmap`)를 업로드
  - 단, 업로드 파일명은 `latest.yml`의 `url`(`PePe Terminal(SSH)-Setup-2.1.5.exe`, 하이픈)과 일치해야 함 (공백 이름 그대로 올리면 GitHub가 이름을 바꿔 다운로드가 404)

---

### 포함 커밋 (v2.1.4 → v2.1.5)

- `d17ee78` feat(updater): 자동 업데이트 기능 추가 (electron-updater / GitHub Releases)
