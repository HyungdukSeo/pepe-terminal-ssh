#!/usr/bin/env bash
# v3.0.1 — iOS 빌드 셋업 스크립트
#
# clone 직후 한 번 실행하면 Xcode에서 ios/App/App.xcworkspace 를 열어
# 바로 빌드할 수 있는 상태로 준비합니다.
#
# 요구사항: macOS + Xcode + Node.js + CocoaPods
#   $ sudo gem install cocoapods   # CocoaPods 미설치 시
#
# 사용법 (프로젝트 어디서든):
#   $ ./ios/setup.sh
# 또는:
#   $ npm run setup:ios

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OS="$(uname -s)"
if [ "$OS" != "Darwin" ]; then
  echo "⚠️  iOS 빌드는 macOS 환경에서만 가능합니다 (현재: $OS)."
  echo "    스크립트를 macOS에서 다시 실행해 주세요."
  exit 1
fi

echo "▶ [1/4] npm 의존성 설치"
npm install

echo "▶ [2/4] 웹 번들 빌드 (vite)"
npm run build:web

echo "▶ [3/4] Capacitor sync (웹 번들 → ios/App/App/public)"
npx cap sync ios

echo "▶ [4/4] CocoaPods 설치 (ios/App/Pods)"
if ! command -v pod >/dev/null 2>&1; then
  echo "❌ CocoaPods 미설치. 다음 명령으로 설치 후 재실행:"
  echo "    sudo gem install cocoapods"
  exit 1
fi
( cd ios/App && pod install )

cat <<'EOF'

✅ 셋업 완료.
   Xcode에서 다음 파일을 열어 빌드하세요:
     ios/App/App.xcworkspace   (.xcodeproj 아님!)

   웹/네이티브 코드 수정 후엔 다음 중 하나 실행:
     • npm run cap:sync       (웹 변경만)
     • npm run setup:ios      (의존성/Pods 포함 전체 재셋업)
EOF
