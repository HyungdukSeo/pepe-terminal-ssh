// src/components/TabBar.tsx
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { Tab } from '../App';
import { ContextMenu } from './ContextMenu';

type ShellInfo = { name: string; path: string; icon?: string };
type Props = {
  tabs: Tab[];
  activeTabId: string | null;
  onChange: (id: string) => void;
  onAddTab: (shellName?: string, shellPath?: string) => void;
  onAddBrowserTab?: (url?: string) => void;
  onAddCompareTab?: () => void;
  onAddLogAnalyzerTab?: () => void;
  onAddVpnTab?: () => void;
  onAddI18nEditorTab?: () => void;
  onCloseTab: (id: string) => void;
  onRenameTab?: (id: string, name: string) => void;
  onReorderTabs?: (fromId: string, toId: string) => void;
  onDetachTab?: (id: string, screenX?: number, screenY?: number) => void;
  hasSession?: Record<string, boolean>;
  themeName?: string;
  themeList?: string[];
  onThemeChange?: (name: string) => void;
  availableShells?: ShellInfo[];
};

export const TabBar: React.FC<Props> = ({ tabs, activeTabId, onChange, onAddTab, onAddBrowserTab, onAddCompareTab, onAddLogAnalyzerTab, onAddVpnTab, onAddI18nEditorTab, onCloseTab, onRenameTab, onReorderTabs, onDetachTab, hasSession, themeName, themeList, onThemeChange, availableShells }) => {
  const { t } = useTranslation('tabBar');
  const { t: tc } = useTranslation('common');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [shellMenu, setShellMenu] = useState<{ x: number; y: number } | null>(null);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const startRename = (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    setRenamingId(tabId);
    setRenameValue(tab.title);
  };

  const submitRename = () => {
    if (renamingId && renameValue.trim()) {
      onRenameTab?.(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  };

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const scrollBy = (dx: number) => { scrollRef.current?.scrollBy({ left: dx, behavior: 'smooth' }); };
  // 탭이 영역을 넘는지 감지 → 스크롤 버튼 노출 여부
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    window.addEventListener('resize', check);
    return () => { ro.disconnect(); window.removeEventListener('resize', check); };
  }, [tabs.length]);
  return (
    <div className="tab-bar">
      <div className="tab-bar-scroll" ref={scrollRef} onWheel={e => {
        e.currentTarget.scrollLeft += e.deltaY > 0 ? 60 : -60;
      }}>
      {tabs.map(tab => (
        <div
          key={tab.id}
          className={`tab-item ${tab.id === activeTabId ? 'active' : ''}${draggingId === tab.id ? ' dragging' : ''}${dragOverId === tab.id && draggingId && draggingId !== tab.id ? ' drag-over' : ''}`}
          draggable={renamingId !== tab.id}
          onDragStart={e => {
            setDraggingId(tab.id);
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('application/x-pepe-tab', tab.id); } catch {}
          }}
          onDragEnd={e => {
            const sx = e.screenX, sy = e.screenY;
            setDraggingId(null); setDragOverId(null);
            // 창 밖에 드롭하면 새 창으로 분리
            if (!onDetachTab) return;
            (async () => {
              try {
                const b: any = await (window as any).api?.getWindowBounds?.();
                if (b && (sx < b.x || sx > b.x + b.width || sy < b.y || sy > b.y + b.height)) {
                  onDetachTab(tab.id, sx, sy);
                }
              } catch {}
            })();
          }}
          onDragOver={e => {
            if (!draggingId || draggingId === tab.id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (dragOverId !== tab.id) setDragOverId(tab.id);
          }}
          onDragLeave={() => { if (dragOverId === tab.id) setDragOverId(null); }}
          onDrop={e => {
            e.preventDefault();
            if (draggingId && draggingId !== tab.id) onReorderTabs?.(draggingId, tab.id);
            setDraggingId(null);
            setDragOverId(null);
          }}
          onClick={() => onChange(tab.id)}
          onMouseDown={e => { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); onCloseTab(tab.id); } }}
          onAuxClick={e => { if (e.button === 1) { e.preventDefault(); onCloseTab(tab.id); } }}
          onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, tabId: tab.id }); }}
        >
          {hasSession?.[tab.id] && <span className="tab-status-dot" />}
          {renamingId === tab.id ? (
            <input
              className="tab-rename-input"
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onBlur={submitRename}
              onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenamingId(null); }}
              autoFocus
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <span>{(() => {
              if (tab.customTitle) return tab.title;
              switch (tab.type) {
                case 'compare': return t('compareWorkspace');
                case 'logAnalyzer': return t('logAnalyzerWorkspace');
                case 'vpn': return t('vpnWorkspace');
                case 'i18nEditor': return t('translationEditor');
                case 'fileExplorer': return tab.title.startsWith('📁') ? t('fileTransferTab', { defaultValue: tab.title }) : tab.title;
              }
              const m = tab.title.match(/^Workspace (\d+)$/);
              if (m) return t('workspaceN', { n: m[1] });
              return tab.title;
            })()}</span>
          )}
          <button
            className="tab-close"
            onClick={e => { e.stopPropagation(); onCloseTab(tab.id); }}
          >
            &times;
          </button>
        </div>
      ))}
      </div>
      <button className="tab-add-btn" onClick={e => {
        const r = e.currentTarget.getBoundingClientRect();
        setAddMenu({ x: r.left, y: r.bottom });
      }} title={t('addTooltip')}>+</button>
      {overflowing && (
        <div className="tab-scroll-group">
          <button className="tab-scroll-btn" onClick={() => scrollBy(-150)} title={t('scrollPrev')}>‹</button>
          <button className="tab-scroll-btn" onClick={() => scrollBy(150)} title={t('scrollNext')}>›</button>
        </div>
      )}
      {themeList && onThemeChange && (
        <select className="theme-select" value={themeName} onChange={e => onThemeChange(e.target.value)}>
          {themeList.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x} y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            { label: tc('rename'), onClick: () => startRename(contextMenu.tabId) },
            ...(onDetachTab ? [{ label: '새 창으로 열기', onClick: () => onDetachTab(contextMenu.tabId) }] : []),
            { label: tc('close'), onClick: () => onCloseTab(contextMenu.tabId) },
          ]}
        />
      )}
      {shellMenu && availableShells && (
        <ContextMenu
          x={shellMenu.x} y={shellMenu.y}
          onClose={() => setShellMenu(null)}
          items={availableShells.map(sh => ({
            label: `${sh.icon || ''} ${sh.name}`.trim(),
            onClick: () => onAddTab(sh.name, sh.path),
          }))}
        />
      )}
      {addMenu && (
        <ContextMenu
          x={addMenu.x} y={addMenu.y}
          onClose={() => setAddMenu(null)}
          items={[
            {
              label: `🐚  ${t('shellSelect')}`,
              submenu: (availableShells && availableShells.length > 0
                ? availableShells.map(sh => ({ label: `${sh.icon || '▪'}  ${sh.name}`, onClick: () => onAddTab(sh.name, sh.path) }))
                : [{ label: t('terminalWorkspace'), onClick: () => onAddTab() }]
              ),
            },
            {
              label: `🗂  ${t('workspace')}`,
              submenu: [
                { label: t('terminalWorkspace'), onClick: () => onAddTab() },
                { label: t('browserWorkspace'), onClick: () => onAddBrowserTab?.() },
                { label: t('compareWorkspace'), onClick: () => onAddCompareTab?.() },
                { label: t('logAnalyzerWorkspace'), onClick: () => onAddLogAnalyzerTab?.() },
                { label: t('vpnWorkspace'), onClick: () => onAddVpnTab?.() },
                { label: t('translationEditor'), onClick: () => onAddI18nEditorTab?.() },
              ],
            },
          ]}
        />
      )}
    </div>
  );
};
