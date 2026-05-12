// src/components/BrowserPane.tsx
// 브라우저 워크스페이스 — Electron <webview> 로 외부 사이트 렌더.
// 뒤로/앞으로/새로고침/URL 입력 바를 제공.
import React, { useState, useRef, useEffect } from 'react';

type Props = {
  initialUrl: string;
  onTitleChange?: (title: string) => void;
};

export const BrowserPane: React.FC<Props> = ({ initialUrl, onTitleChange }) => {
  const webviewRef = useRef<any>(null);
  const [url, setUrl] = useState(initialUrl);
  const [editUrl, setEditUrl] = useState(initialUrl);
  const [canBack, setCanBack] = useState(false);
  const [canFwd, setCanFwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [zoom, setZoom] = useState(1.0); // 1.0 = 100%

  useEffect(() => {
    const wv: any = webviewRef.current;
    if (!wv) return;
    const onNav = () => {
      try { setUrl(wv.getURL()); setEditUrl(wv.getURL()); } catch {}
      try { setCanBack(wv.canGoBack()); setCanFwd(wv.canGoForward()); } catch {}
    };
    const onStart = () => setLoading(true);
    const onStop = () => { setLoading(false); onNav(); };
    const onTitle = (e: any) => onTitleChange?.(e.title || '');
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-navigate-in-page', onNav);
    wv.addEventListener('did-start-loading', onStart);
    wv.addEventListener('did-stop-loading', onStop);
    wv.addEventListener('page-title-updated', onTitle);
    return () => {
      try {
        wv.removeEventListener('did-navigate', onNav);
        wv.removeEventListener('did-navigate-in-page', onNav);
        wv.removeEventListener('did-start-loading', onStart);
        wv.removeEventListener('did-stop-loading', onStop);
        wv.removeEventListener('page-title-updated', onTitle);
      } catch {}
    };
  }, [onTitleChange]);

  const go = (target: string) => {
    let t = target.trim();
    if (!t) return;
    if (!/^[a-z]+:\/\//i.test(t)) {
      // URL 형태가 아니면 (공백 또는 점이 없으면) 구글 검색으로 폴백
      if (!t.includes('.') && !t.includes(':')) {
        t = 'https://www.google.com/search?q=' + encodeURIComponent(t);
      } else {
        t = 'https://' + t;
      }
    }
    try { webviewRef.current?.loadURL(t); } catch {}
  };

  // 줌 — webview.setZoomFactor 로 페이지 스케일 조정. 0.25 ~ 5.0 범위.
  const applyZoom = (z: number) => {
    const clamped = Math.max(0.25, Math.min(5.0, +z.toFixed(2)));
    setZoom(clamped);
    try { webviewRef.current?.setZoomFactor?.(clamped); } catch {}
  };
  const zoomIn = () => applyZoom(zoom + 0.1);
  const zoomOut = () => applyZoom(zoom - 0.1);
  const zoomReset = () => applyZoom(1.0);

  // 페이지 로드 / 네비게이션 후 zoom factor 가 리셋되므로 다시 적용
  useEffect(() => {
    const wv: any = webviewRef.current;
    if (!wv) return;
    const reapply = () => { try { wv.setZoomFactor?.(zoom); } catch {} };
    wv.addEventListener('did-stop-loading', reapply);
    wv.addEventListener('did-navigate', reapply);
    return () => {
      try { wv.removeEventListener('did-stop-loading', reapply); wv.removeEventListener('did-navigate', reapply); } catch {}
    };
  }, [zoom]);

  // Ctrl/Cmd + (+/-/0) 단축키 + Ctrl/Cmd + 휠 줌 — webview 외부에서 입력 받을 때만 동작.
  // webview 내부에서 받은 휠/키는 페이지가 자체 처리하므로 별도 처리 필요.
  // → webview 의 'before-input-event' 로 Ctrl+= / Ctrl+- 가로채서 줌 변경.
  useEffect(() => {
    const wv: any = webviewRef.current;
    if (!wv) return;
    const onInput = (e: any) => {
      if (e.type !== 'keyDown') return;
      const ctrl = e.control || e.meta;
      if (!ctrl) return;
      if (e.key === '=' || e.key === '+') { applyZoom(zoom + 0.1); e.preventDefault?.(); }
      else if (e.key === '-' || e.key === '_') { applyZoom(zoom - 0.1); e.preventDefault?.(); }
      else if (e.key === '0') { applyZoom(1.0); e.preventDefault?.(); }
    };
    try { wv.addEventListener('before-input-event', onInput); } catch {}
    return () => { try { wv.removeEventListener('before-input-event', onInput); } catch {} };
  }, [zoom]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: '#1a1a1a' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', background: '#222', borderBottom: '1px solid #333' }}>
        <button className="panel-btn" disabled={!canBack} onClick={() => webviewRef.current?.goBack()} title="뒤로">◀</button>
        <button className="panel-btn" disabled={!canFwd} onClick={() => webviewRef.current?.goForward()} title="앞으로">▶</button>
        <button className="panel-btn" onClick={() => loading ? webviewRef.current?.stop() : webviewRef.current?.reload()} title={loading ? '중지' : '새로고침'}>{loading ? '✕' : '⟳'}</button>
        <input
          type="text"
          value={editUrl}
          onChange={e => setEditUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') go(editUrl); }}
          spellCheck={false}
          style={{ flex: 1, padding: '4px 8px', background: '#111', border: '1px solid #333', borderRadius: 3, color: '#ddd', fontSize: 12 }}
          placeholder="URL 또는 검색어"
        />
        <button className="panel-btn" onClick={() => go(editUrl)} title="이동">↵</button>
        <div style={{ width: 1, height: 18, background: '#333', margin: '0 2px' }} />
        <button className="panel-btn" onClick={zoomOut} title="축소 (Ctrl+-)">−</button>
        <button className="panel-btn" onClick={zoomReset} title="100% (Ctrl+0)" style={{ minWidth: 42, fontSize: 11 }}>
          {Math.round(zoom * 100)}%
        </button>
        <button className="panel-btn" onClick={zoomIn} title="확대 (Ctrl+=)">+</button>
        <div style={{ width: 1, height: 18, background: '#333', margin: '0 2px' }} />
        <button className="panel-btn" onClick={() => { try { webviewRef.current?.openDevTools(); } catch {} }} title="DevTools">{'<>'}</button>
      </div>
      {/* @ts-ignore — webview 는 React 표준 element 가 아니지만 Electron 환경에서 동작 */}
      <webview
        ref={webviewRef as any}
        src={url}
        style={{ flex: 1, width: '100%', display: 'flex' } as any}
        allowpopups={'true' as any}
      />
    </div>
  );
};
