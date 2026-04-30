import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import SessionEditorPopout from './SessionEditorPopout'
import './index.css'

const params = new URLSearchParams(window.location.search);
const popout = params.get('popout');

// popout=options 모드는 표시 — App 렌더 + auto open Options
if (popout === 'options') {
  (window as any).__popoutMode = 'options';
  document.body.classList.add('popout-options');
}

let root: React.ReactNode;
if (popout === 'session-editor') {
  root = <SessionEditorPopout sessionId={params.get('sessionId') || 'new'} />;
} else {
  root = <App />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{root}</React.StrictMode>
);
