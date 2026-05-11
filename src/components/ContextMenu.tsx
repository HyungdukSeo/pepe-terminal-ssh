// src/components/ContextMenu.tsx
import React, { useEffect, useRef, useState } from 'react';

export type MenuItem = {
  label: string;
  onClick?: () => void;
  separator?: boolean;
  header?: boolean;
  disabled?: boolean;
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

  // 호버 중인 서브메뉴 인덱스 + 부모 row 의 위치
  const [openSub, setOpenSub] = useState<{ idx: number; top: number; left: number } | null>(null);

  return (
    <div ref={menuRef} className="context-menu" style={{ top: pos.y, left: pos.x }} onClick={e => e.stopPropagation()}>
      {items.map((item, i) => {
        if (item.separator) return <div key={i} className="context-menu-separator" />;
        if (item.header) return <div key={i} style={{ padding: '4px 12px', fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>{item.label}</div>;
        const hasSub = !!(item.submenu && item.submenu.length > 0);
        return (
          <div
            key={i}
            className={`context-menu-item ${item.disabled ? 'disabled' : ''} ${hasSub ? 'has-submenu' : ''} ${openSub?.idx === i ? 'submenu-open' : ''}`}
            onMouseEnter={(e) => {
              if (hasSub) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setOpenSub({ idx: i, top: r.top, left: r.right - 2 });
              } else {
                setOpenSub(null);
              }
            }}
            onClick={() => {
              if (item.disabled) return;
              if (hasSub) return; // 서브메뉴 부모는 클릭으로 닫지 않음
              item.onClick?.();
              onClose();
            }}
          >
            <span className="context-menu-label-text">{item.label}</span>
            {hasSub && <span className="context-menu-arrow">▶</span>}
            {hasSub && openSub?.idx === i && (
              <ContextMenu
                x={openSub.left}
                y={openSub.top}
                items={item.submenu!}
                onClose={onClose}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};
