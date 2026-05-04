// 터치 길게 누르기 → 우클릭(컨텍스트 메뉴) 시뮬레이션.
// 한 번에 하나의 터치만 활성이라는 가정 (모듈 레벨 타이머).
// 600ms = iOS 시스템 long-press 표준. 너무 짧으면 스크롤 중 오발동.

let timer: ReturnType<typeof setTimeout> | null = null
let startX = 0
let startY = 0

const clear = () => {
  if (timer) { clearTimeout(timer); timer = null }
}

export function makeLongPressHandlers(
  onLongPress: (clientX: number, clientY: number) => void,
  ms: number = 600,
) {
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0]
      if (!t) return
      startX = t.clientX
      startY = t.clientY
      clear()
      timer = setTimeout(() => {
        timer = null
        onLongPress(startX, startY)
      }, ms)
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0]
      if (!t || !timer) return
      if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) {
        clear()
      }
    },
    onTouchEnd: () => clear(),
    onTouchCancel: () => clear(),
  }
}
