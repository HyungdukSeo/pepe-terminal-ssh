// src/components/DriverManagerModal.tsx
//
// DBeaver-style JDBC driver manager. Lets the user:
//  - browse all registered drivers (built-in + user-defined),
//  - edit name / className / URL template / default port / JAR list,
//  - import JAR files from disk into the user driver folder,
//  - "Test load" — calls jdbc:load-driver to verify URLClassLoader + class instantiation,
//  - save (creates a user override for the same id),
//  - remove (user-defined only — removing a user override restores the built-in).

import React, { useEffect, useState } from 'react';

type Dialect = 'altibase' | 'mysql' | 'postgres' | 'oracle' | 'mssql' | 'sqlite' | 'generic';

export interface JdbcDriverDef {
  id: string;
  name: string;
  className: string;
  urlTemplate: string;
  defaultPort: number;
  jars: string[];
  builtin: boolean;
  dialect: Dialect;
  note?: string;
  // Enriched by main process listDrivers — JAR diagnostics.
  diag?: { usable: boolean; existing: string[]; missing: string[]; resolved: string[] };
}

interface Props {
  open: boolean;
  onClose: () => void;
}

const inputStyle: React.CSSProperties = {
  background: '#1e1e1e', color: '#d4d4d4', border: '1px solid #444',
  borderRadius: 3, padding: '4px 8px', fontSize: 12, fontFamily: 'monospace',
};

const newDraft = (): JdbcDriverDef => ({
  id: `user-${Date.now().toString(36)}`,
  name: '신규 드라이버',
  className: '',
  urlTemplate: 'jdbc:???://{host}:{port}/{database}',
  defaultPort: 0,
  jars: [],
  builtin: false,
  dialect: 'generic',
});

export const DriverManagerModal: React.FC<Props> = ({ open, onClose }) => {
  const [drivers, setDrivers] = useState<JdbcDriverDef[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [draft, setDraft] = useState<JdbcDriverDef | null>(null);
  const [roots, setRoots] = useState<{ bundled: string; user: string }>({ bundled: '', user: '' });
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string>('');

  const reload = async () => {
    const api: any = (window as any).api || {};
    const list: JdbcDriverDef[] = await api.jdbcListDrivers?.() || [];
    const r = await api.jdbcDriverRoots?.() || { bundled: '', user: '' };
    setDrivers(list);
    setRoots(r);
    setSelectedId(prev => {
      if (prev && list.find(d => d.id === prev)) return prev;
      return list[0]?.id || '';
    });
    setTestMsg('');
  };
  useEffect(() => { if (open) reload(); }, [open]);

  // Reset the draft when the selection changes (deep clone so we don't mutate state in-place)
  useEffect(() => {
    if (!selectedId) { setDraft(null); return; }
    const d = drivers.find(x => x.id === selectedId);
    setDraft(d ? JSON.parse(JSON.stringify(d)) : null);
    setTestMsg('');
  }, [selectedId, drivers]);

  if (!open) return null;

  const selectedOriginal = drivers.find(x => x.id === selectedId) || null;
  const isDirty = !!draft && JSON.stringify(draft) !== JSON.stringify(selectedOriginal);

  const apiAny: any = (window as any).api || {};

  const handleSave = async () => {
    if (!draft) return;
    const r = await apiAny.jdbcSaveDriver?.(draft);
    if (r?.success) { await reload(); setSelectedId(draft.id); }
    else alert(`저장 실패: ${r?.error || '?'}`);
  };

  const handleRemove = async () => {
    if (!selectedOriginal) return;
    if (!confirm(`드라이버 정의를 제거합니다: ${selectedOriginal.name} (${selectedOriginal.id})\n빌트인 id 와 동일한 사용자 정의면 빌트인이 복원됩니다.`)) return;
    const r = await apiAny.jdbcRemoveDriver?.(selectedOriginal.id);
    if (r?.success) { await reload(); }
    else alert(`제거 실패: ${r?.error || '?'}`);
  };

  const handleAdd = () => {
    const d = newDraft();
    setDrivers(prev => [...prev, d]);
    setSelectedId(d.id);
    setDraft(d);
  };

  const handleImportJar = async () => {
    const r = await apiAny.jdbcPickAndImportJar?.();
    if (!r || r.canceled) return;
    if (!r.success) { alert(`JAR 가져오기 실패: ${r.error || '?'}`); return; }
    if (draft) setDraft({ ...draft, jars: [...draft.jars, ...(r.imported || [])] });
  };

  const handleTestLoad = async () => {
    if (!draft) return;
    setTesting(true); setTestMsg('테스트 중...');
    try {
      // Save first if dirty — load uses the current driver definition.
      if (isDirty) {
        const sr = await apiAny.jdbcSaveDriver?.(draft);
        if (!sr?.success) { setTestMsg(`❌ 저장 실패: ${sr?.error || '?'}`); return; }
        await reload();
      }
      const r = await apiAny.jdbcLoadDriver?.(draft);
      if (r?.success) setTestMsg(`✅ ${draft.className} 로드 OK`);
      else setTestMsg(`❌ ${r?.error || '?'}`);
    } catch (e: any) {
      setTestMsg(`❌ 예외: ${e?.message || e}`);
    } finally { setTesting(false); }
  };

  const resolvedExists = (j: string): boolean => {
    if (!draft?.diag) return false;
    const r = j.replace('${bundled}', roots.bundled).replace('${userJdbc}', roots.user);
    return (draft.diag.existing || []).includes(r);
  };

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 5000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#252526', color: '#d4d4d4', fontFamily: 'system-ui, sans-serif',
          width: 920, maxWidth: '94vw', height: 620, maxHeight: '92vh',
          borderRadius: 6, display: 'flex', flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600 }}>🗂 JDBC 드라이버 관리자</span>
          <span style={{ color: '#888', fontSize: 11 }}>({drivers.length})</span>
          <button
            onClick={onClose}
            title="닫기"
            style={{ marginLeft: 'auto', background: 'transparent', color: '#aaa', border: 0, fontSize: 20, cursor: 'pointer', lineHeight: 1 }}
          >×</button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* Left: driver list */}
          <div style={{ width: 280, borderRight: '1px solid #333', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {drivers.map(d => {
                const usable = d.diag?.usable;
                const active = selectedId === d.id;
                return (
                  <div
                    key={d.id}
                    onClick={() => setSelectedId(d.id)}
                    style={{
                      padding: '6px 12px', cursor: 'pointer',
                      background: active ? '#094771' : 'transparent',
                      borderBottom: '1px solid #2a2a2a',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: usable ? '#5fb55f' : '#e07050' }}>{usable ? '✓' : '⚠'}</span>
                      <span style={{ fontWeight: 600, color: active ? '#fff' : '#ddd' }}>{d.name}</span>
                      {d.builtin && (
                        <span style={{ marginLeft: 'auto', fontSize: 10, color: '#888', background: '#2a2a2a', border: '1px solid #444', padding: '0 4px', borderRadius: 2 }}>
                          builtin
                        </span>
                      )}
                    </div>
                    <div style={{ color: '#888', fontSize: 11, marginTop: 2, marginLeft: 14 }}>{d.dialect} · {d.className || '(클래스 없음)'}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ padding: 8, borderTop: '1px solid #333', display: 'flex', gap: 6 }}>
              <button
                onClick={handleAdd}
                title="신규 사용자 드라이버 추가"
                style={{ flex: 1, background: '#0e639c', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
              >+ 추가</button>
              {!!selectedOriginal && (
                <button
                  onClick={handleRemove}
                  title="제거 (빌트인 id 와 동일한 사용자 정의면 빌트인 복원)"
                  style={{ background: '#5a1d1d', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
                >- 제거</button>
              )}
            </div>
          </div>

          {/* Right: detail */}
          <div style={{ flex: 1, overflow: 'auto', padding: 14, minWidth: 0 }}>
            {!draft && <div style={{ color: '#888' }}>드라이버를 선택하거나 추가하세요.</div>}
            {draft && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8, alignItems: 'center' }}>
                  <label style={{ color: '#bbb', fontSize: 12 }}>이름</label>
                  <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} style={inputStyle} />
                  <label style={{ color: '#bbb', fontSize: 12 }}>Dialect</label>
                  <select
                    value={draft.dialect}
                    onChange={e => setDraft({ ...draft, dialect: e.target.value as Dialect })}
                    style={inputStyle}
                  >
                    <option value="altibase">altibase</option>
                    <option value="mysql">mysql</option>
                    <option value="postgres">postgres</option>
                    <option value="oracle">oracle</option>
                    <option value="mssql">mssql</option>
                    <option value="sqlite">sqlite</option>
                    <option value="generic">generic</option>
                  </select>
                  <label style={{ color: '#bbb', fontSize: 12 }}>Driver 클래스</label>
                  <input
                    value={draft.className}
                    onChange={e => setDraft({ ...draft, className: e.target.value })}
                    placeholder="예: org.postgresql.Driver"
                    style={inputStyle}
                  />
                  <label style={{ color: '#bbb', fontSize: 12 }}>URL 템플릿</label>
                  <input
                    value={draft.urlTemplate}
                    onChange={e => setDraft({ ...draft, urlTemplate: e.target.value })}
                    placeholder="jdbc:scheme://{host}:{port}/{database}"
                    style={inputStyle}
                  />
                  <label style={{ color: '#bbb', fontSize: 12 }}>기본 포트</label>
                  <input
                    type="number"
                    value={draft.defaultPort}
                    onChange={e => setDraft({ ...draft, defaultPort: parseInt(e.target.value || '0', 10) || 0 })}
                    style={{ ...inputStyle, width: 100 }}
                  />
                </div>

                {/* JAR list */}
                <div style={{ marginTop: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>JAR 파일</span>
                    <button
                      onClick={handleImportJar}
                      title="로컬 JAR 파일을 user 드라이버 폴더로 복사 후 추가"
                      style={{ background: '#3a7d3a', color: '#fff', border: 0, padding: '2px 8px', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}
                    >+ JAR 가져오기</button>
                    <button
                      onClick={() => draft && setDraft({ ...draft, jars: [...draft.jars, '${userJdbc}/'] })}
                      title="템플릿 항목 추가 (직접 편집)"
                      style={{ background: '#444', color: '#ddd', border: 0, padding: '2px 8px', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}
                    >+ 빈 항목</button>
                  </div>
                  {draft.jars.length === 0 && (
                    <div style={{ color: '#888', fontSize: 11, padding: '6px 0' }}>JAR 항목이 없습니다.</div>
                  )}
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                    {draft.jars.map((j, idx) => {
                      const exists = resolvedExists(j);
                      return (
                        <li key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
                          <span style={{ color: exists ? '#5fb55f' : '#e07050' }}>{exists ? '✓' : '⚠'}</span>
                          <input
                            value={j}
                            onChange={e => {
                              const nx = draft.jars.slice();
                              nx[idx] = e.target.value;
                              setDraft({ ...draft, jars: nx });
                            }}
                            style={{ ...inputStyle, flex: 1 }}
                          />
                          <button
                            onClick={() => setDraft({ ...draft, jars: draft.jars.filter((_, i) => i !== idx) })}
                            title="항목 제거"
                            style={{ background: 'transparent', color: '#888', border: 0, cursor: 'pointer', fontSize: 14, padding: '0 4px' }}
                          >×</button>
                        </li>
                      );
                    })}
                  </ul>
                  {draft.note && (
                    <div style={{ marginTop: 10, padding: 8, background: '#3a2a14', border: '1px solid #6a4a24', borderRadius: 3, color: '#ffd680', fontSize: 11, lineHeight: 1.4 }}>
                      💡 {draft.note}
                    </div>
                  )}
                </div>

                <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    onClick={handleSave}
                    disabled={!isDirty}
                    title="현재 정의를 저장 (빌트인 id 면 사용자 오버라이드 생성)"
                    style={{ background: isDirty ? '#0e639c' : '#444', color: '#fff', border: 0, padding: '6px 14px', borderRadius: 3, cursor: isDirty ? 'pointer' : 'not-allowed', fontSize: 12 }}
                  >💾 저장</button>
                  <button
                    onClick={handleTestLoad}
                    disabled={testing}
                    title="JAR 들에서 driver 클래스를 실제로 로드 / 인스턴스화"
                    style={{ background: '#3a7d3a', color: '#fff', border: 0, padding: '6px 14px', borderRadius: 3, cursor: testing ? 'wait' : 'pointer', fontSize: 12 }}
                  >🧪 테스트 로드</button>
                  {testMsg && (
                    <span style={{ color: testMsg.startsWith('✅') ? '#5fb55f' : (testMsg.startsWith('테스트') ? '#bbb' : '#fcc'), fontSize: 12, fontFamily: 'monospace' }}>
                      {testMsg}
                    </span>
                  )}
                </div>

                <div style={{ marginTop: 14, color: '#888', fontSize: 11, fontFamily: 'monospace', lineHeight: 1.6 }}>
                  <div>bundled root: <span style={{ color: '#9cdcfe' }}>{roots.bundled || '(?)'}</span></div>
                  <div>user root:&nbsp;&nbsp;&nbsp; <span style={{ color: '#9cdcfe' }}>{roots.user || '(?)'}</span></div>
                  <div style={{ marginTop: 4 }}>
                    토큰 <code style={{ color: '#ffd680' }}>${'{bundled}'}</code> / <code style={{ color: '#ffd680' }}>${'{userJdbc}'}</code> 는 위 경로로 자동 치환됩니다.
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div style={{ padding: '8px 14px', borderTop: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <button
            onClick={async () => {
              if (!confirm('사이드카 JVM 을 재시작합니다.\n진행 중인 모든 JDBC 연결이 끊깁니다. 계속할까요?')) return;
              const r: any = await apiAny.jdbcRestartSidecar?.();
              if (r?.success) {
                alert(`✅ 사이드카 재시작 OK\n버전: ${r.result?.version}\nJava: ${r.result?.javaVersion}`);
                await reload();
              } else {
                alert(`❌ 사이드카 재시작 실패: ${r?.error || '?'}`);
              }
            }}
            title="JVM 프로세스 종료 후 새 JAR 로 재spawn — 빌드 업데이트 적용 / 드라이버 캐시 클리어용"
            style={{ background: '#5a3d1d', color: '#fff', border: 0, padding: '5px 14px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
          >🔄 사이드카 재시작</button>
          <button
            onClick={onClose}
            style={{ background: '#444', color: '#fff', border: 0, padding: '5px 14px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
          >닫기</button>
        </div>
      </div>
    </div>
  );
};
