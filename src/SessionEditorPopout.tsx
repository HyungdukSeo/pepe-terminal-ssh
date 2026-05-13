// src/SessionEditorPopout.tsx
// popout 창 (별도 BrowserWindow) 에서 SessionEditor 만 단독 렌더링
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SessionEditor } from './components/SessionEditor';
import type { Session, Folder } from './components/SessionEditor';

const SessionEditorPopout: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { t } = useTranslation('sessionEditor');
  const [session, setSession] = useState<Session | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const data = await (window as any).api?.listSessions?.();
        if (!data) { setLoaded(true); return; }
        const sessions: Session[] = data.sessions || [];
        const flds: Folder[] = data.folders || [];
        setFolders(flds);
        if (sessionId === 'new') {
          setSession({
            id: 'new-' + Date.now(),
            name: '',
            host: '',
            port: 22,
            username: '',
            auth: { type: 'password' as const, password: '' },
          } as any);
        } else {
          const s = sessions.find(x => x.id === sessionId);
          if (s) setSession(s);
          else setSession(null);
        }
      } catch (e) {
        console.error('[popout] load failed', e);
      }
      setLoaded(true);
    })();
  }, [sessionId]);

  const handleSave = async (s: Session) => {
    try {
      await (window as any).api?.saveSession?.(s);
      (window as any).api?.sessionEditorSaved?.({ session: s });
    } catch (e) {
      console.error('[popout] save failed', e);
    }
  };

  const handleCancel = () => {
    (window as any).api?.sessionEditorClose?.();
  };

  // 드래그 가능한 커스텀 헤더 — 페이스트 모달과 동일 스타일
  const Header = () => (
    <div style={{
      height: 36, padding: '0 14px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      background: '#222', borderBottom: '1px solid #333',
      WebkitAppRegion: 'drag', cursor: 'move', userSelect: 'none', flexShrink: 0,
    } as any}>
      <strong style={{ fontSize: 13, color: '#eee' }}>{t('title')}</strong>
      <button onClick={handleCancel} style={{
        WebkitAppRegion: 'no-drag',
        background: 'transparent', border: 'none', color: '#aaa',
        cursor: 'pointer', fontSize: 16, padding: '0 4px',
      } as any}>✕</button>
    </div>
  );

  if (!loaded) {
    return <div style={{ height: '100vh', background: '#111', display: 'flex', flexDirection: 'column' }}>
      <Header />
      <div style={{ padding: 20, color: '#aaa', flex: 1 }}>{t('loading')}</div>
    </div>;
  }
  if (!session) {
    return <div style={{ height: '100vh', background: '#111', display: 'flex', flexDirection: 'column' }}>
      <Header />
      <div style={{ padding: 20, color: '#aaa', flex: 1 }}>{t('notFound')}</div>
    </div>;
  }
  return (
    <div style={{ height: '100vh', background: '#111', display: 'flex', flexDirection: 'column' }}>
      <Header />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <SessionEditor session={session} folders={folders} onSave={handleSave} onCancel={handleCancel} />
      </div>
    </div>
  );
};

export default SessionEditorPopout;
