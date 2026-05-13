// src/components/ContextMenu.tsx
import React, { useEffect, useRef, useState } from 'react';

export type MenuItem = {
  label: string;
  onClick?: () => void;
  separator?: boolean;
  header?: boolean;
  submenu?: MenuItem[];
};

type Props = {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
};

export const ContextMenu: React.FC<Props> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });
  const [openSub, setOpenSub] = useState<{ idx: number; x: number; y: number } | null>(null);

  React.useEffect(() => {
    if (!menuRef.current) return;
    const r = menuRef.current.getBoundingClientRect();
    let nx = x, ny = y;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (nx + r.width > vw - 4) nx = Math.max(4, vw - r.width - 4);
    if (ny + r.height > vh - 4) ny = Math.max(4, vh - r.height - 4);
    if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny });
  }, [x, y, items.length]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current) return;
      // 자기 자신 또는 다른 context-menu (submenu) 내부 클릭이면 닫지 않음
      const target = e.target as HTMLElement;
      if (target.closest?.('.context-menu')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return (
    <>
      <div ref={menuRef} className="context-menu" style={{ top: pos.y, left: pos.x }} onClick={e => e.stopPropagation()}>
        {items.map((item, i) => {
          if (item.separator) return <div key={i} style={{ height: 1, background: '#3a3a3a', margin: '4px 0' }} />;
          if (item.header) return <div key={i} style={{ padding: '4px 12px', fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>{item.label}</div>;
          if (item.submenu && item.submenu.length > 0) {
            return (
              <div
                key={i}
                className="context-menu-item"
                onMouseEnter={e => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setOpenSub({ idx: i, x: r.right - 2, y: r.top });
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <span style={{ flex: 1 }}>{item.label}</span>
                <span style={{ color: '#888', fontSize: 10 }}>▶</span>
              </div>
            );
          }
          return (
            <div
              key={i}
              className="context-menu-item"
              onMouseEnter={() => setOpenSub(null)}
              onClick={() => { item.onClick?.(); onClose(); }}
            >
              {item.label}
            </div>
          );
        })}
      </div>
      {openSub && items[openSub.idx]?.submenu && (
        <ContextMenu
          x={openSub.x}
          y={openSub.y}
          items={items[openSub.idx].submenu!}
          onClose={onClose}
        />
      )}
    </>
  );
};
