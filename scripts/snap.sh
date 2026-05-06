#!/bin/bash
# iPad 시뮬레이터 스크린샷 캡처 도우미
#
# 사용법:
#   bash scripts/snap.sh <이름>          # 예: bash scripts/snap.sh 01-first-launch
#   bash scripts/snap.sh <이름> landscape # 가로 모드 캡처
#   bash scripts/snap.sh list            # 지금까지 캡처한 목록 보기
#   bash scripts/snap.sh open            # 스크린샷 폴더 Finder에서 열기
#
# 결과: docs/screenshots/ipad/<이름>.png

set -euo pipefail

PROJ_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="$PROJ_ROOT/docs/screenshots/ipad"
mkdir -p "$OUTPUT_DIR"

case "${1:-}" in
    "")
        echo "사용법: bash scripts/snap.sh <이름>"
        echo ""
        echo "예시:"
        echo "  bash scripts/snap.sh 01-first-launch"
        echo "  bash scripts/snap.sh 02-session-list"
        echo "  bash scripts/snap.sh 04-keybar landscape"
        echo "  bash scripts/snap.sh list"
        echo "  bash scripts/snap.sh open"
        echo ""
        echo "매뉴얼 스크린샷 목록:"
        echo "  01-first-launch       첫 실행 화면 (빈 패널)"
        echo "  02-session-list       세션 리스트 (사이드바)"
        echo "  03-session-editor     세션 편집기"
        echo "  04-keybar             터미널 키바 (키보드 열린 상태)"
        echo "  05-terminal-connected 터미널 접속 상태"
        echo "  06-split-view         분할 화면"
        echo "  07-file-tree          파일 트리"
        echo "  08-panel-header       패널 헤더 버튼"
        echo "  09-landscape          가로 모드"
        echo "  10-multi-select       다중 선택 (체크박스)"
        ;;
    list)
        echo "=== 캡처된 스크린샷 ==="
        if ls "$OUTPUT_DIR"/*.png &>/dev/null; then
            ls -1 "$OUTPUT_DIR"/*.png | while read f; do
                SIZE=$(stat -f%z "$f" 2>/dev/null || stat --printf="%s" "$f" 2>/dev/null)
                echo "  $(basename "$f")  ($(( SIZE / 1024 ))KB)"
            done
        else
            echo "  (없음)"
        fi
        ;;
    open)
        open "$OUTPUT_DIR"
        ;;
    *)
        NAME="$1"
        OUTPUT="$OUTPUT_DIR/${NAME}.png"

        xcrun simctl io booted screenshot "$OUTPUT" 2>/dev/null
        if [ $? -eq 0 ]; then
            SIZE=$(stat -f%z "$OUTPUT" 2>/dev/null || stat --printf="%s" "$OUTPUT" 2>/dev/null)
            echo "✓ ${NAME}.png ($(( SIZE / 1024 ))KB) → docs/screenshots/ipad/"
        else
            echo "✗ 캡처 실패 — iPad 시뮬레이터가 실행 중인지 확인하세요."
            exit 1
        fi
        ;;
esac
