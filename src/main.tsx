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
      const { createIosApi } = await import('./utils/iosApi')
      window.__setApiImpl(createIosApi())
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
