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

      // Capacitor Keyboard 의 resize:body 는 window.resize 이벤트를 안 쏘기 때문에
      // xterm-fit-addon 이 cols/rows 재계산을 못 함. 키보드 show/hide 직후
      // resize 이벤트 강제 디스패치 + body class 토글로 CSS 후처리 가능하게.
      const { Keyboard } = await import('@capacitor/keyboard')
      Keyboard.addListener('keyboardWillShow', (info) => {
        document.body.classList.add('keyboard-open')
        document.documentElement.style.setProperty('--keyboard-h', `${info.keyboardHeight}px`)
        // 시간차 두고 resize 이벤트 여러 번 — fit-addon 이 정확한 viewport 잡을 시간 확보
        setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
        setTimeout(() => window.dispatchEvent(new Event('resize')), 250)
      })
      Keyboard.addListener('keyboardDidShow', () => {
        window.dispatchEvent(new Event('resize'))
      })
      Keyboard.addListener('keyboardWillHide', () => {
        document.body.classList.remove('keyboard-open')
        document.documentElement.style.setProperty('--keyboard-h', '0px')
        setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
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
