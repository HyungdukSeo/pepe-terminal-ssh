// src/components/RenameDialog.tsx
// 파일/폴더 이름 변경 다이얼로그 — portal 로 렌더
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  initialName: string;
  isDir: boolean;
  onConfirm: (newName: string) => void;
  onCancel: () => void;
};

export const RenameDialog: React.FC<Props> = ({ initialName, isDir, onConfirm, onCancel }) => {
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    console.log(`[ps-dbg] RenameDialog MOUNT initialName="${initialName}" isDir=${isDir} hasFocus=${document.hasFocus()} activeEl=${document.activeElement?.tagName}/${(document.activeElement as any)?.className || ''}`);
    const focus = (tag: string) => {
      try {
        el.focus();
        const v = el.value;
        const isDotfile = v.startsWith('.');
        const dot = (isDir || isDotfile) ? -1 : v.lastIndexOf('.');
        el.setSelectionRange(0, dot > 0 ? dot : v.length);
        console.log(`[ps-dbg] RenameDialog focus[${tag}] hasFocus=${document.hasFocus()} activeIsInput=${document.activeElement === el}`);
      } catch {}
    };
    focus('sync');
    const t = setTimeout(() => focus('t30'), 30);
    return () => { console.log('[ps-dbg] RenameDialog UNMOUNT'); clearTimeout(t); };
  }, [isDir, initialName]);

  const submit = () => {
    const v = value.trim();
    if (!v) { onCancel(); return; }
    if (v === initialName) { onCancel(); return; }
    onConfirm(v);
  };

  return createPortal(
    <div className="rn-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="rn-dialog" onMouseDown={e => e.stopPropagation()}>
        <div className="rn-title">이름 바꾸기</div>
        <div className="rn-body">
          <label className="rn-label">새 이름</label>
          <input
            ref={inputRef}
            className="rn-input"
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); submit(); }
              else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
            }}
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
        </div>
        <div className="rn-actions">
          <button className="rn-btn rn-btn-primary" onClick={submit}>확인</button>
          <button className="rn-btn" onClick={onCancel}>취소</button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
