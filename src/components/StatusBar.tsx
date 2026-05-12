// src/components/StatusBar.tsx
import React, { useState, useEffect } from 'react';
import type { Tab } from '../App';
import type { LayoutNode, PanelSession } from '../utils/layoutUtils';
import { collectAllSessions } from '../utils/layoutUtils';

type Props = {
  activeTab: Tab | null;
  selectedPanelId: string | null;
  tabs: Tab[];
  onClickVpn?: () => void;
};

function getActiveSession(layout: LayoutNode, panelId: string | null): PanelSession | null {
  if (!panelId) return null;
  if (layout.type === 'leaf') {
    if (layout.id === panelId) {
      return layout.panel.sessions[layout.panel.activeIdx] || null;
    }
    return null;
  }
  for (const c of layout.children) {
    const r = getActiveSession(c, panelId);
    if (r) return r;
  }
  return null;
}

export const StatusBar: React.FC<Props> = ({ activeTab, selectedPanelId, tabs, onClickVpn }) => {
  const [time, setTime] = useState(new Date());
  const [copyInfo, setCopyInfo] = useState<string | null>(null);
  const [vpnState, setVpnState] = useState<{ status: string; assignedIp?: string; configName?: string }>({ status: 'disconnected' });

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // VPN 상태 구독
  useEffect(() => {
    const api = (window as any).api;
    if (!api) return;
    (async () => { try { setVpnState(await api.vpnState?.() || { status: 'disconnected' }); } catch {} })();
    const off = api.onVpnState?.((s: any) => setVpnState(s || { status: 'disconnected' }));
    return () => off?.();
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const { charCount, lineCount } = (e as CustomEvent).detail;
      setCopyInfo(`복사됨: ${charCount}자 / ${lineCount}줄`);
      setTimeout(() => setCopyInfo(null), 3000);
    };
    window.addEventListener('status-copy', handler);
    return () => window.removeEventListener('status-copy', handler);
  }, []);

  // 활성 세션 정보
  const activeSess = activeTab ? getActiveSession(activeTab.layout, selectedPanelId) : null;

  // 전체 연결 수
  const totalSessions = tabs
    .filter(t => t.type !== 'fileExplorer')
    .reduce((sum, t) => sum + collectAllSessions(t.layout).filter(s => s.sessionId).length, 0);

  const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateStr = time.toLocaleDateString();

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        {activeSess && activeSess.sessionId ? (
          <>
            <span className="status-dot connected" />
            <span className="status-info">{activeSess.sessionName}</span>
          </>
        ) : (
          <>
            <span className="status-dot disconnected" />
            <span className="status-info">연결 없음</span>
          </>
        )}
        <span className="status-separator">|</span>
        <span className="status-info">세션: {totalSessions}개</span>
        {activeTab && (
          <>
            <span className="status-separator">|</span>
            <span className="status-info">{activeTab.title}</span>
          </>
        )}
      </div>
      <div className="status-bar-right">
        {copyInfo && <span className="status-copy-info">{copyInfo}</span>}
        {copyInfo && <span className="status-separator">|</span>}
        <span
          className="status-info"
          onClick={onClickVpn}
          style={{ cursor: onClickVpn ? 'pointer' : 'default', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          title={vpnState.status === 'connected'
            ? `VPN 연결됨${vpnState.assignedIp ? ` (${vpnState.assignedIp})` : ''} — 클릭해서 VPN 화면 열기`
            : `VPN ${vpnState.status} — 클릭해서 VPN 화면 열기`}>
          <span style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
            background: vpnState.status === 'connected' ? '#7fcf6e'
              : vpnState.status === 'error' ? '#e36b6b'
              : (vpnState.status === 'disconnected' ? '#555' : '#d8b556'),
            boxShadow: vpnState.status === 'connected' ? '0 0 6px #7fcf6e' : 'none',
          }} />
          <span style={{ fontSize: 11 }}>VPN{vpnState.status === 'connected' && vpnState.assignedIp ? ` · ${vpnState.assignedIp}` : ''}</span>
        </span>
        <span className="status-separator">|</span>
        <span className="status-info">{dateStr}</span>
        <span className="status-separator">|</span>
        <span className="status-info">{timeStr}</span>
      </div>
    </div>
  );
};
