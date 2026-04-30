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
if (popout === 'session-editor') {
  document.body.classList.add('popout-session-editor');
  document.documentElement.style.background = '#1a1a1a';
  document.documentElement.style.margin = '0';
  document.documentElement.style.padding = '0';
  document.body.style.background = '#1a1a1a';
  document.body.style.margin = '0';
  document.body.style.padding = '0';
  document.body.style.border = 'none';
  document.body.style.outline = 'none';
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
