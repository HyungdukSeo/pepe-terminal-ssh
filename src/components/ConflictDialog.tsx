// src/components/ConflictDialog.tsx
// 파일 충돌 — 덮어쓰기/건너뛰기/이어쓰기/이름 바꾸기 선택 다이얼로그
import React, { useState, useEffect } from 'react';

const api = (window as any).api || {};

export type ConflictInfo = {
  requestId: string;
  transferId: string;
  rel: string;
  name: string;
  srcIsDir: boolean;
  dstIsDir: boolean;
  srcSize: number;
  dstSize: number;
  srcMtime: number; // seconds
  dstMtime: number; // seconds
  srcPath: string;
  dstPath: string;
  direction: 'upload' | 'download' | 'local-copy' | 'remote-remote';
};

const formatDate = (sec: number): string => {
  if (!sec) return '-';
  const d = new Date(sec * 1000);
  const days = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const dd = d.getDate();
  const h = d.getHours();
  const mi = d.getMinutes();
  const s = d.getSeconds();
  const ampm = h < 12 ? '오전' : '오후';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${y}년 ${m}월 ${dd}일 ${days[d.getDay()]}, ${ampm} ${hour12}:${String(mi).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
};

const formatBytes = (n: number): string => {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
};

type Props = {
  info: ConflictInfo;
  onResolved: () => void;
};

export const ConflictDialog: React.FC<Props> = ({ info, onResolved }) => {
  const [action, setAction] = useState<'overwrite' | 'skip' | 'resume' | 'rename'>('overwrite');
  const [applyAll, setApplyAll] = useState(false);
  const [newName, setNewName] = useState(info.name);

  // 같은 충돌이 연달아 뜰 때 입력값 초기화
  useEffect(() => {
    setAction('overwrite');
    setApplyAll(false);
    setNewName(info.name);
  }, [info.requestId]);

  const titleText = info.srcIsDir ? '폴더가 존재합니다' :
    info.direction === 'upload' ? '업로드 할 파일이 존재합니다' :
    info.direction === 'download' ? '다운로드 할 파일이 존재합니다' :
    '파일이 존재합니다';

  const resolve = (cancel?: boolean) => {
    const decision = cancel ? { cancel: true } : { action, applyAll, newName: action === 'rename' ? newName : undefined };
    api.feResolveConflict?.(info.requestId, decision);
    onResolved();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') resolve(false);
    if (e.key === 'Escape') resolve(true);
  };

  // resume 은 디렉토리에는 의미 없음
  const showResume = !info.srcIsDir;

  return (
    <div className="cf-backdrop">
      <div className="cf-dialog" onKeyDown={onKeyDown} tabIndex={-1}>
        <div className="cf-titlebar">
          <span className="cf-title">{titleText}</span>
          <button className="cf-close" onClick={() => resolve(true)} title="취소">✕</button>
        </div>
        <div className="cf-body">
          <div className="cf-row cf-row-msg">
            <span className="cf-warn-ico">⚠</span>
            <span>이 폴더에 이미 아래 이름의 개체가 있습니다.<br/>수행할 작업을 선택하십시오.</span>
          </div>
          <div className="cf-row">
            <span className="cf-label">이름(N):</span>
            <span className="cf-value">{info.name}</span>
          </div>
          <div className="cf-row">
            <span className="cf-label">대상:</span>
            <div className="cf-target">
              <span className="cf-icon">{info.dstIsDir ? '📁' : '📄'}</span>
              <div>
                <div>{formatDate(info.dstMtime)}</div>
                {!info.dstIsDir && <div className="cf-sub">{formatBytes(info.dstSize)}</div>}
                <div className="cf-sub cf-path" title={info.dstPath}>{info.dstPath}</div>
              </div>
            </div>
          </div>
          <div className="cf-row">
            <span className="cf-label">원본:</span>
            <div className="cf-target">
              <span className="cf-icon">{info.srcIsDir ? '📁' : '📄'}</span>
              <div>
                <div>{formatDate(info.srcMtime)}</div>
                {!info.srcIsDir && <div className="cf-sub">{formatBytes(info.srcSize)}</div>}
                <div className="cf-sub cf-path" title={info.srcPath}>{info.srcPath}</div>
              </div>
            </div>
          </div>
          <div className="cf-row cf-row-action">
            <span className="cf-label">동작(C):</span>
            <select className="cf-select" value={action} onChange={e => setAction(e.target.value as any)}>
              <option value="overwrite">덮어쓰기</option>
              <option value="skip">건너뛰기</option>
              {showResume && <option value="resume">계속 업로드</option>}
              <option value="rename">이름 바꾸기</option>
            </select>
            <label className="cf-apply-all">
              <input type="checkbox" checked={applyAll} onChange={e => setApplyAll(e.target.checked)} />
              모두 적용(A)
            </label>
          </div>
          {action === 'rename' && (
            <div className="cf-row cf-row-rename">
              <span className="cf-label">새 이름:</span>
              <input className="cf-input" value={newName} onChange={e => setNewName(e.target.value)} autoFocus />
            </div>
          )}
        </div>
        <div className="cf-actions">
          <button className="cf-btn cf-btn-primary" onClick={() => resolve(false)}>확인</button>
          <button className="cf-btn" onClick={() => resolve(true)}>취소</button>
        </div>
      </div>
    </div>
  );
};

// 전송 충돌 큐 관리 컴포넌트 — TransferLog 등 상위에서 한번만 마운트하면 됨
export const ConflictDialogQueue: React.FC = () => {
  const [queue, setQueue] = useState<ConflictInfo[]>([]);

  useEffect(() => {
    const unsub = api.onSFTPConflict?.((p: any) => {
      try {
        const d = JSON.parse(p.data) as ConflictInfo;
        setQueue(q => [...q, d]);
      } catch {}
    });
    return () => { try { unsub?.(); } catch {} };
  }, []);

  if (queue.length === 0) return null;
  const current = queue[0];
  return <ConflictDialog info={current} onResolved={() => setQueue(q => q.slice(1))} />;
};
