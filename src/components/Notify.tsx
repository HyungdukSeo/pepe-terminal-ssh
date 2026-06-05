// src/components/Notify.tsx
//
// 전역 알림/확인 모달 — window.alert / window.confirm 대체.
//   - native 다이얼로그는 Electron 에서 포커스를 빼앗아 입력기 caret stuck 을 유발한다.
//   - 모듈 레벨 subscriber + <NotifyHost /> 한 번 마운트 패턴.
//   - 사용:
//        import { notifyError, notifyOk, notifyInfo, notifyConfirm } from './Notify';
//        notifyError('연결 실패', err.message);
//        if (await notifyConfirm('삭제', '정말 삭제할까요?')) { ... }

import React, { useEffect, useState } from 'react';

export type NotifyKind = 'info' | 'success' | 'error';
export interface NotifyMsg {
  id: number;
  kind: NotifyKind;
  title: string;
  message: string;
  // confirm 모드 — resolve(true) on 확인, resolve(false) on 취소/외부클릭
  resolve?: (ok: boolean) => void;
}

let _nextId = 1;
type Listener = (msgs: NotifyMsg[]) => void;
const _queue: NotifyMsg[] = [];
const _listeners = new Set<Listener>();
function _emit() { _listeners.forEach(l => l([..._queue])); }
function _push(msg: Omit<NotifyMsg, 'id'>): NotifyMsg {
  const m: NotifyMsg = { ...msg, id: _nextId++ };
  _queue.push(m); _emit(); return m;
}
export function notifyInfo(title: string, message = '') { _push({ kind: 'info', title, message }); }
export function notifyOk(title: string, message = '')   { _push({ kind: 'success', title, message }); }
export function notifyError(title: string, message = '') { _push({ kind: 'error', title, message }); }
export function notifyConfirm(title: string, message = ''): Promise<boolean> {
  return new Promise(resolve => { _push({ kind: 'info', title, message, resolve }); });
}

// 한 번만 App 루트에 마운트. 큐의 첫 메시지를 보여줌.
export const NotifyHost: React.FC = () => {
  const [msgs, setMsgs] = useState<NotifyMsg[]>([]);
  useEffect(() => {
    const l: Listener = setMsgs; _listeners.add(l);
    setMsgs([..._queue]);
    return () => { _listeners.delete(l); };
  }, []);
  const top = msgs[0];
  if (!top) return null;
  const isConfirm = typeof top.resolve === 'function';
  const close = (ok: boolean) => {
    const idx = _queue.findIndex(m => m.id === top.id);
    if (idx >= 0) _queue.splice(idx, 1);
    top.resolve?.(ok);
    _emit();
  };
  const accentColor = top.kind === 'error' ? '#fcc' : top.kind === 'success' ? '#bef5be' : '#9cdcfe';
  const icon = top.kind === 'error' ? '✗' : top.kind === 'success' ? '✓' : 'ℹ';
  return (
    <div
      onClick={() => !isConfirm && close(false)}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: '#252526', color: '#d4d4d4', borderRadius: 6, padding: 16, minWidth: 380, maxWidth: '60vw', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
      >
        <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 13, color: accentColor }}>
          {icon} {top.title}
        </div>
        {top.message && (
          <div style={{ fontSize: 12, color: '#bbb', marginBottom: 14, whiteSpace: 'pre-wrap', fontFamily: 'monospace', maxHeight: 360, overflowY: 'auto' }}>{top.message}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {isConfirm && (
            <button
              onClick={() => close(false)}
              style={{ background: '#444', color: '#fff', border: 0, padding: '5px 14px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
            >취소</button>
          )}
          <button
            autoFocus
            onKeyDown={e => { if (e.key === 'Escape') close(false); }}
            onClick={() => close(true)}
            style={{ background: isConfirm ? '#c0392b' : '#0e639c', color: '#fff', border: 0, padding: '5px 14px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
          >확인</button>
        </div>
      </div>
    </div>
  );
};
