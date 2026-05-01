import React from 'react'
import ReactDOM from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import App from './App'
import './index.css'

declare global {
  interface Window {
    api?: any
  }
}

const createApiFallback = () => {
  const asyncNoOp = async (..._args: any[]) => undefined
  const eventNoOp = (..._args: any[]) => () => {}
  return new Proxy({}, {
    get: (_target, prop) => {
      if (typeof prop === 'string' && prop.startsWith('on')) {
        return eventNoOp
      }
      return asyncNoOp
    },
  })
}

async function bootstrap() {
  if (!window.api) {
    const platform = Capacitor.getPlatform()
    if (platform === 'ios') {
      const { createIosApi } = await import('./utils/iosApi')
      window.api = createIosApi()
    } else {
      window.api = createApiFallback()
    }
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void bootstrap()
