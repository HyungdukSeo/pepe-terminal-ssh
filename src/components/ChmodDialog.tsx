// src/components/ChmodDialog.tsx
// 권한 변경 다이얼로그 — SSH/SFTP 세션 전용
import React, { useState, useEffect } from 'react';

const api = (window as any).api || {};

type Props = {
  mode: string;           // 'local' | 'remote'
  termId?: string;
  paths: string[];        // 절대 경로
  initialMode?: number;   // 0o600 등 (없으면 0o644)
  hasDir?: boolean;       // 선택 중 디렉토리 포함 여부
  onClose: () => void;
  onApplied: () => void;
};

export const ChmodDialog: React.FC<Props> = ({ mode, termId, paths, initialMode, hasDir, onClose, onApplied }) => {
  const initOctal = (initialMode ?? 0o644) & 0o777;
  const [octal, setOctal] = useState<string>(initOctal.toString(8).padStart(3, '0'));
  const [recursive, setRecursive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // octal → 체크박스
  const parseBits = (oct: string) => {
    const n = parseInt(oct, 8);
    if (isNaN(n)) return { o: 0, g: 0, t: 0 };
    return { o: (n >> 6) & 7, g: (n >> 3) & 7, t: n & 7 };
  };
  const { o, g, t } = parseBits(octal);

  const bitOn = (group: 'o' | 'g' | 't', bit: number, on: boolean) => {
    const cur = parseBits(octal);
    const v = on ? (cur[group] | bit) : (cur[group] & ~bit);
    const next = { ...cur, [group]: v };
    const n = (next.o << 6) | (next.g << 3) | next.t;
    setOctal(n.toString(8).padStart(3, '0'));
  };

  const onOctalChange = (v: string) => {
    // 0~7 만 허용, 최대 4자리
    const clean = v.replace(/[^0-7]/g, '').slice(0, 4);
    setOctal(clean);
  };

  const apply = async () => {
    setBusy(true);
    setErr(null);
    try {
      const m = parseInt(octal, 8);
      if (isNaN(m) || m < 0 || m > 0o7777) { setErr('유효하지 않은 권한 값입니다'); setBusy(false); return; }
      const r = await api.feChmod?.({ mode, termId, paths, octal: m, recursive });
      if (r?.success === false) {
        setErr(r.error || '권한 변경 실패');
        setBusy(false);
        return;
      }
      onApplied();
      onClose();
    } catch (e: any) {
      setErr(e?.message || String(e));
      setBusy(false);
    }
  };

  // ESC 닫기, Enter 적용
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Enter' && !busy) apply();
  };

  useEffect(() => {
    // 다이얼로그 마운트 시 input 에 포커스
    const t = setTimeout(() => { (document.querySelector('.chmod-octal-input') as HTMLInputElement)?.focus(); }, 30);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="cf-backdrop">
      <div className="cf-dialog chmod-dialog" onKeyDown={onKeyDown} tabIndex={-1}>
        <div className="cf-titlebar">
          <span className="cf-title">권한 변경</span>
          <button className="cf-close" onClick={onClose} title="취소">✕</button>
        </div>
        <div className="cf-body">
          <div className="cf-row chmod-octal-row">
            <span className="cf-label">파일/폴더 권한(P):</span>
            <input
              className="cf-input chmod-octal-input"
              value={octal}
              onChange={e => onOctalChange(e.target.value)}
              style={{ width: 90 }}
            />
          </div>
          <div className="chmod-grid">
            <div className="chmod-col">
              <div className="chmod-col-title">소유자</div>
              <label><input type="checkbox" checked={!!(o & 4)} onChange={e => bitOn('o', 4, e.target.checked)} /> 읽기</label>
              <label><input type="checkbox" checked={!!(o & 2)} onChange={e => bitOn('o', 2, e.target.checked)} /> 쓰기</label>
              <label><input type="checkbox" checked={!!(o & 1)} onChange={e => bitOn('o', 1, e.target.checked)} /> 실행</label>
            </div>
            <div className="chmod-col">
              <div className="chmod-col-title">그룹</div>
              <label><input type="checkbox" checked={!!(g & 4)} onChange={e => bitOn('g', 4, e.target.checked)} /> 읽기</label>
              <label><input type="checkbox" checked={!!(g & 2)} onChange={e => bitOn('g', 2, e.target.checked)} /> 쓰기</label>
              <label><input type="checkbox" checked={!!(g & 1)} onChange={e => bitOn('g', 1, e.target.checked)} /> 실행</label>
            </div>
            <div className="chmod-col">
              <div className="chmod-col-title">기타</div>
              <label><input type="checkbox" checked={!!(t & 4)} onChange={e => bitOn('t', 4, e.target.checked)} /> 읽기</label>
              <label><input type="checkbox" checked={!!(t & 2)} onChange={e => bitOn('t', 2, e.target.checked)} /> 쓰기</label>
              <label><input type="checkbox" checked={!!(t & 1)} onChange={e => bitOn('t', 1, e.target.checked)} /> 실행</label>
            </div>
          </div>
          {hasDir && (
            <label className="chmod-recursive">
              <input type="checkbox" checked={recursive} onChange={e => setRecursive(e.target.checked)} />
              하위 디렉터리 포함(I)
            </label>
          )}
          <div className="chmod-note">이 명령은 일부 UNIX 호스트에서만 적용됩니다.</div>
          {err && <div className="chmod-error">{err}</div>}
          <div className="chmod-target-list">
            {paths.length > 1 ? `${paths.length}개 항목` : paths[0]}
          </div>
        </div>
        <div className="cf-actions">
          <button className="cf-btn cf-btn-primary" disabled={busy} onClick={apply}>{busy ? '적용 중...' : '확인'}</button>
          <button className="cf-btn" onClick={onClose}>취소</button>
        </div>
      </div>
    </div>
  );
};
