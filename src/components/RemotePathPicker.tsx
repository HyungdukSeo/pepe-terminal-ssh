// src/components/RemotePathPicker.tsx
// 원격 SFTP / 로컬 디렉토리/파일 선택 모달 — feListDir 로 탐색.
// mode='folder' : 현재 보고 있는 폴더를 선택 (파일은 표시되지만 비활성)
// mode='file'   : 파일 선택 시 onPick(filePath)
import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { FixedSizeList as VList, ListChildComponentProps } from 'react-window';

const api = (window as any).api || {};

type Props = {
  mode: 'folder' | 'file';
  source: 'local' | 'remote';
  termId?: string;          // remote 모드용
  sourceLabel: string;
  initialPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
};

type Entry = { name: string; isDir: boolean; size?: number; mtime?: number };

export const RemotePathPicker: React.FC<Props> = ({ mode, source, termId, sourceLabel, initialPath, onPick, onClose }) => {
  const { t } = useTranslation('fileExplorer');
  const sep = source === 'local' && navigator.platform.startsWith('Win') ? '\\' : '/';
  const [path, setPath] = useState<string>(initialPath || (source === 'local' && navigator.platform.startsWith('Win') ? 'C:\\' : '/'));
  const [editPath, setEditPath] = useState<string>(path);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const load = useCallback(async (dir: string) => {
    setErr(''); setLoading(true); setSelectedFile(null);
    try {
      const r = await api.feListDir?.(source, dir, termId);
      if (r?.error) { setErr(r.error); setEntries([]); }
      else {
        const list = (r?.files || [])
          .filter((f: any) => f.name !== '.' && f.name !== '..')
          .sort((a: any, b: any) => (a.isDir !== b.isDir) ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));
        setEntries(list);
      }
    } catch (e: any) {
      setErr(String(e?.message || e)); setEntries([]);
    }
    setLoading(false);
  }, [source, termId]);

  useEffect(() => { setEditPath(path); load(path); }, [path, load]);

  const navigate = (dir: string) => setPath(dir);
  const enterDir = (name: string) => {
    const newPath = path.endsWith(sep) ? path + name : path + sep + name;
    navigate(newPath);
  };
  const goUp = () => {
    let parent: string;
    if (source === 'local' && navigator.platform.startsWith('Win')) {
      parent = path.replace(/\\[^\\]*\\?$/, '') || path.slice(0, 3);
    } else {
      parent = path.replace(/\/[^/]*\/?$/, '') || '/';
    }
    navigate(parent);
  };

  const confirmPick = () => {
    if (mode === 'folder') {
      onPick(path);
    } else {
      if (!selectedFile) return;
      const full = path.endsWith(sep) ? path + selectedFile : path + sep + selectedFile;
      onPick(full);
    }
    onClose();
  };

  return (
    <div className="session-editor-backdrop" onClick={onClose} style={{ zIndex: 10001 }}>
      <div className="session-editor" onClick={e => e.stopPropagation()} style={{ width: 600, height: 520, display: 'flex', flexDirection: 'column' }}>
        <h3 style={{ marginBottom: 8 }}>{mode === 'folder' ? t('pickFolder') : t('pickFile')} <span style={{ fontSize: 12, color: '#888', fontWeight: 'normal' }}>{sourceLabel}</span></h3>

        {/* 경로 바 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <button onClick={goUp} title={t('up')} style={{ padding: '3px 8px' }}>▲</button>
          <input type="text" value={editPath} onChange={e => setEditPath(e.target.value)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') navigate(editPath); }}
            style={{ flex: 1, fontSize: 12, padding: '4px 6px' }} />
          <button onClick={() => navigate(editPath)} title={t('go')} style={{ padding: '3px 8px' }}>↵</button>
          <button onClick={() => load(path)} title={t('refresh')} style={{ padding: '3px 8px' }}>⟳</button>
        </div>

        {/* 리스트 */}
        <div style={{ flex: 1, minHeight: 0, border: '1px solid #333', borderRadius: 4, background: '#161616', overflow: 'hidden' }}>
          {loading ? (
            <div style={{ color: '#888', fontSize: 12, padding: 16, textAlign: 'center' }}>{t('loading')}</div>
          ) : err ? (
            <div style={{ color: '#e36b6b', fontSize: 12, padding: 16 }}>{err}</div>
          ) : entries.length === 0 ? (
            <div style={{ color: '#666', fontSize: 12, padding: 16, textAlign: 'center' }}>{t('empty')}</div>
          ) : (
            <VList height={420} width="100%" itemCount={entries.length} itemSize={22} overscanCount={12}>
              {({ index, style }: ListChildComponentProps) => {
                const e = entries[index];
                if (!e) return null;
                const isPickable = mode === 'file' ? !e.isDir : false;
                const isSel = !e.isDir && selectedFile === e.name;
                return (
                  <div style={{
                    ...style, display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px',
                    fontSize: 12, cursor: 'pointer', boxSizing: 'border-box',
                    background: isSel ? '#2b4e74' : 'transparent',
                    color: e.isDir ? '#8ac6ff' : (isPickable ? '#ccc' : '#666'),
                  }}
                  onClick={() => {
                    if (e.isDir) enterDir(e.name);
                    else if (mode === 'file') setSelectedFile(e.name);
                  }}
                  onDoubleClick={() => {
                    if (e.isDir) enterDir(e.name);
                    else if (mode === 'file') { setSelectedFile(e.name); setTimeout(confirmPick, 0); }
                  }}
                  >
                    <span>{e.isDir ? '📁' : '📄'}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                    {!e.isDir && typeof e.size === 'number' && <span style={{ color: '#666', fontSize: 10 }}>{(e.size / 1024).toFixed(1)}K</span>}
                  </div>
                );
              }}
            </VList>
          )}
        </div>

        {/* 액션 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
          <span style={{ fontSize: 11, color: '#888' }}>
            {mode === 'folder' ? t('pickFolderHint', { path }) : (selectedFile ? t('pickFileHint', { name: selectedFile }) : t('pickFilePrompt'))}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose}>{t('cancel')}</button>
            <button className="primary" onClick={confirmPick} disabled={mode === 'file' && !selectedFile}>{t('select')}</button>
          </div>
        </div>
      </div>
    </div>
  );
};
