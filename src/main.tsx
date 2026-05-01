import React from 'react'
import ReactDOM from 'react-dom/client'
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

if (!window.api) {
  window.api = createApiFallback()
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
