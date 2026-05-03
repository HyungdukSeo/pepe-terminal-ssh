import React from 'react'
import ReactDOM from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import App from './App'
import './index.css'

declare global {
  interface Window {
    api?: any
    __setApiImpl?: (impl: any) => void
  }
}

async function bootstrap() {
  // Electron path: window.api was set by preload — leave it alone.
  // Capacitor iOS path: install our adapter behind the index.html proxy.
  if (window.__setApiImpl) {
    if (Capacitor.getPlatform() === 'ios') {
      document.body.classList.add('is-ios')
      const { createIosApi } = await import('./utils/iosApi')
      window.__setApiImpl(createIosApi())

      // 키보드 띄웠을 때 .app-root 가 줄어들어 xterm 이 마지막 줄까지 보이도록.
      // iOS 의 100vh 는 정적이라 키보드 영향을 안 받음. visualViewport API 가
      // 키보드만큼 줄어든 실제 보이는 영역을 알려주므로 그 값으로 --app-h CSS
      // 변수를 갱신. .app-root { height: var(--app-h) } 가 받아서 layout 재계산.
      // window.resize 디스패치로 xterm-fit-addon 도 재계산 트리거.
      const vv = window.visualViewport
      if (vv) {
        const sync = () => {
          document.documentElement.style.setProperty('--app-h', `${vv.height}px`)
          window.dispatchEvent(new Event('resize'))
        }
        vv.addEventListener('resize', sync)
        vv.addEventListener('scroll', sync)
        sync()
      }
      // Capacitor Keyboard 가 정확한 키보드 높이를 알려주므로 그 값으로 --keyboard-h
      // CSS 변수 set. 터미널 키바가 'bottom: var(--keyboard-h)' 로 키보드 위에 부상.
      const { Keyboard } = await import('@capacitor/keyboard')
      Keyboard.addListener('keyboardWillShow', (info) => {
        document.body.classList.add('keyboard-open')
        document.documentElement.style.setProperty('--keyboard-h', `${info.keyboardHeight}px`)
        setTimeout(() => window.dispatchEvent(new Event('resize')), 250)
      })
      Keyboard.addListener('keyboardWillHide', () => {
        document.body.classList.remove('keyboard-open')
        document.documentElement.style.setProperty('--keyboard-h', '0px')
        setTimeout(() => window.dispatchEvent(new Event('resize')), 250)
      })
    }
    // 'web' platform leaves the proxy stubs in place (async no-ops).
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void bootstrap()
