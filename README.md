# PePe Terminal (SSH)

SSH 터미널 클라이언트 — Electron 데스크톱 앱 + iOS(Capacitor) 빌드 지원.

- 스택: Electron + Vite + React + TypeScript + xterm.js + ssh2
- iOS: Capacitor + NMSSH (Swift 네이티브 SSH/SFTP 플러그인)

---

## 데스크톱 (Electron) 빌드

```bash
npm install
npm run dev          # 개발 모드
npm run build        # 배포 빌드 (Windows/macOS)
```

---

## iOS 빌드 (v3.0.1+)

clone 직후 Xcode에서 바로 빌드할 수 있도록 generated 파일(`ios/App/App/public/`,
`capacitor.config.json`, `config.xml`)을 트래킹하고 있습니다.
처음 셋업 시 한 번만 셋업 스크립트를 실행하세요.

### 요구사항
- macOS + Xcode 15+
- Node.js 18+
- CocoaPods (`sudo gem install cocoapods`)

### 절차
```bash
git clone -b v3.0.1 <repo-url>
cd pepe-terminal-ssh
npm run setup:ios          # = bash ios/setup.sh
                           # npm install + 웹 빌드 + cap sync + pod install
open ios/App/App.xcworkspace   # ⚠️ .xcodeproj 가 아닌 .xcworkspace
```
이후 Xcode에서 ▶ 버튼으로 빌드/실행.

### 코드 수정 후 재빌드
- 웹(React/TS) 코드만 수정: `npm run cap:sync`
- 네이티브(Swift)·의존성 변경 포함: `npm run setup:ios`

### 트러블슈팅
- `Pods` 폴더 없음 / 워크스페이스 안 열림 → `cd ios/App && pod install`
- WebView가 빈 화면 → `npm run build:web && npx cap sync ios`
- 시뮬레이터/디바이스 인식 실패 → Xcode → Signing & Capabilities 에서 Team 설정 확인

---

## 라이선스 / 만든이
- 만든이: Claude (feat. ghjeong[prompt])
