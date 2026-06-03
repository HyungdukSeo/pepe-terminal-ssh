// src/components/ObjectDetailPanel.tsx
//
// DBeaver 스타일 객체 상세 패널. SqlToolWorkspace 의 EditorTab 이 kind='object' 일 때 사용.
// kind 별로 다른 서브탭 구성:
//   table     : Properties(컬럼/제약조건/외래키/인덱스/참조/트리거/DDL) + Data + 엔티티 관계도
//   view      : Properties(컬럼/Definition) + Data + 엔티티 관계도
//   index     : 인덱스 칼럼 + Declaration
//   sequence  : Declaration
//   procedure : 프로시저 파라미터 + Source
//   function  : 함수 파라미터 + Source
//   synonym   : Declaration

import React from 'react';
import Editor from '@monaco-editor/react';
import type { JdbcBackend, ColumnInfo } from './jdbcBackend';
import type { EditorTab, ObjectKind } from './SqlToolWorkspace';

interface Props {
  tab: EditorTab;
  backend: JdbcBackend | null;
  connected: boolean;
  running: boolean;
  colsCacheRef: React.MutableRefObject<Map<string, ColumnInfo[]>>;
  pksCacheRef: React.MutableRefObject<Map<string, string[]>>;
  defsCacheRef: React.MutableRefObject<Map<string, string>>;
  inflightDefRef: React.MutableRefObject<Map<string, Promise<string>>>;
  detailCacheRef: React.MutableRefObject<Map<string, any>>;
  columnsRev: number;
  pkRev: number;
  defRev: number;
  objDetailRev: number;
  setDefRev: React.Dispatch<React.SetStateAction<number>>;
  setObjDetailRev: React.Dispatch<React.SetStateAction<number>>;
  loadColumns: (table: string) => Promise<ColumnInfo[]>;
  loadPrimaryKey: (table: string) => Promise<string[]>;
  loadDefinition: (name: string, kind: 'table' | 'view') => Promise<string>;
  runSql: (sql: string) => void;
  setActiveEditorTabId: (id: string) => void;
  onSubTab: (sub: string) => void;
  onPropSubTab: (sub: string) => void;
}

const ICON_MAP: Record<ObjectKind, string> = { table: '📄', view: '👁', index: '🔑', sequence: '🔢', procedure: '⚙', function: 'ƒ', synonym: '🔗', package: '📦', trigger: '🔔', tablespace: '💾' };
const LABEL_MAP: Record<ObjectKind, string> = { table: 'TABLE', view: 'VIEW', index: 'INDEX', sequence: 'SEQUENCE', procedure: 'PROCEDURE', function: 'FUNCTION', synonym: 'PUBLIC SYNONYM', package: 'PACKAGE', trigger: 'TRIGGER', tablespace: 'TABLESPACE' };

export const ObjectDetailPanel: React.FC<Props> = (p) => {
  const { tab, backend, connected, running, colsCacheRef, pksCacheRef, defsCacheRef, inflightDefRef, detailCacheRef,
    columnsRev, pkRev, defRev, objDetailRev, setDefRev, setObjDetailRev,
    loadColumns, loadPrimaryKey, loadDefinition, runSql, setActiveEditorTabId, onSubTab, onPropSubTab } = p;
  void columnsRev; void pkRev; void defRev; void objDetailRev;

  const objName = tab.objectName!;
  const objKind = tab.objectKind!;
  const objSchema = tab.objectSchema || '';
  const sub = tab.objectSubTab || 'properties';
  const propSub = tab.objectPropSubTab || 'columns';
  const isTableLike = objKind === 'table' || objKind === 'view';
  const isRoutine = objKind === 'procedure' || objKind === 'function';

  // 캐시들
  const colsCache = isTableLike ? colsCacheRef.current.get(objName.toUpperCase()) : null;
  const pkCols = isTableLike ? (pksCacheRef.current.get(objName.toUpperCase()) || []) : [];
  const detailKey = `${objKind}:${objSchema}:${objName.toUpperCase()}`;
  const detail = detailCacheRef.current.get(detailKey);

  // 다중 데이터 캐시 (constraints/fks/refs/triggers/params)
  const subDataKey = (group: string) => `${objKind}:${objSchema}:${objName.toUpperCase()}:${group}`;
  const constraints = detailCacheRef.current.get(subDataKey('constraints'));
  const fks = detailCacheRef.current.get(subDataKey('fks'));
  const refs = detailCacheRef.current.get(subDataKey('refs'));
  const triggers = detailCacheRef.current.get(subDataKey('triggers'));
  const params = detailCacheRef.current.get(subDataKey('params'));

  // Definition / Source / Declaration 텍스트 (모두 defsCacheRef 공용)
  const defKey = `${objKind}:${objName.toUpperCase()}`;
  const defText = defsCacheRef.current.get(defKey);
  const ddlKey = `${objKind}:ddl:${objName.toUpperCase()}`;
  const ddlText = defsCacheRef.current.get(ddlKey);
  const declKey = `${objKind}:decl:${objName.toUpperCase()}`;
  const declText = defsCacheRef.current.get(declKey);
  const srcKey = `${objKind}:src:${objName.toUpperCase()}`;
  const srcText = defsCacheRef.current.get(srcKey);

  // ── lazy fetchers ──
  React.useEffect(() => {
    if (!connected || !backend) return;
    // 컬럼 (테이블/뷰)
    if (isTableLike && !colsCache) loadColumns(objName);
    if (isTableLike && pkCols.length === 0 && !pksCacheRef.current.has(objName.toUpperCase())) loadPrimaryKey(objName);
    // 인덱스 상세 — 무조건 set (실패 시 빈 객체) 해서 무한 로딩 방지
    if (objKind === 'index' && detail === undefined) {
      backend.indexDetail(objName, objSchema).then(d => { detailCacheRef.current.set(detailKey, d || { table: '', columns: [], unique: false }); setObjDetailRev(v => v + 1); });
    }
    // 시퀀스 상세
    if (objKind === 'sequence' && detail === undefined) {
      backend.sequenceDetail(objName, objSchema).then(d => { detailCacheRef.current.set(detailKey, d || {}); setObjDetailRev(v => v + 1); });
    }
    // 프로시저/함수 — 소스 + 파라미터
    if (isRoutine && sub === 'source' && srcText === undefined) {
      backend.routineSource(objName, objKind as 'procedure' | 'function', objSchema).then(t => {
        defsCacheRef.current.set(srcKey, t || '-- (본문 없음)'); setDefRev(v => v + 1);
      });
    }
    if (isRoutine && sub === 'parameters' && params === undefined) {
      backend.routineParameters(objName, objKind as 'procedure' | 'function', objSchema).then(rows => {
        detailCacheRef.current.set(subDataKey('params'), rows || []); setObjDetailRev(v => v + 1);
      });
    }
    // 테이블/뷰의 Properties nested 탭 lazy fetch
    if (objKind === 'table' && sub === 'properties') {
      if (propSub === 'constraints' && constraints === undefined) {
        backend.tableConstraints(objName, objSchema).then(rows => { detailCacheRef.current.set(subDataKey('constraints'), rows || []); setObjDetailRev(v => v + 1); });
      }
      if (propSub === 'fks' && fks === undefined) {
        backend.tableForeignKeys(objName, objSchema).then(rows => { detailCacheRef.current.set(subDataKey('fks'), rows || []); setObjDetailRev(v => v + 1); });
      }
      if (propSub === 'refs' && refs === undefined) {
        backend.tableReferencedBy(objName, objSchema).then(rows => { detailCacheRef.current.set(subDataKey('refs'), rows || []); setObjDetailRev(v => v + 1); });
      }
      if (propSub === 'indexes' && detailCacheRef.current.get(subDataKey('indexes')) === undefined) {
        backend.indexes(objName, objSchema).then(rows => { detailCacheRef.current.set(subDataKey('indexes'), rows || []); setObjDetailRev(v => v + 1); });
      }
      if (propSub === 'triggers' && triggers === undefined) {
        backend.tableTriggers(objName, objSchema).then(rows => { detailCacheRef.current.set(subDataKey('triggers'), rows || []); setObjDetailRev(v => v + 1); });
      }
      if (propSub === 'ddl' && ddlText === undefined) {
        // DDL 은 기존 loadDefinition (CREATE TABLE 합성) 사용 + 캐시
        loadDefinition(objName, 'table').then(t => { defsCacheRef.current.set(ddlKey, t); setDefRev(v => v + 1); });
      }
    }
    if (objKind === 'view' && sub === 'properties' && propSub === 'definition' && defText === undefined) {
      loadDefinition(objName, 'view').then(() => { setDefRev(v => v + 1); });
    }
    // 인덱스 Declaration: detail 가 캐시에 들어오면 CREATE INDEX 합성 (빈 detail 도 안내 메시지로)
    if (objKind === 'index' && sub === 'declaration' && declText === undefined && detail !== undefined) {
      const d: any = detail || {};
      let ddl: string;
      if (d.table) {
        const q = (s: string) => `"${s}"`;
        const sch = (d.tableSchema || objSchema || '').toUpperCase();
        const idxSchema = (objSchema || '').toUpperCase();
        const tblSchema = sch || idxSchema;
        const cols = (d.columns || []).map((c: any) => typeof c === 'string'
          ? q(c)
          : (q(c.name) + (c.sortOrder === 'D' ? ' DESC' : '')));
        // DBeaver Altibase 포맷: 첫 줄에 CREATE INDEX ... ON ... (cols), 그 다음 INDEXTYPE / TABLESPACE 줄.
        const head = `CREATE ${d.unique ? 'UNIQUE ' : ''}INDEX ${idxSchema ? q(idxSchema) + '.' : ''}${q(objName)} ON ${tblSchema ? q(tblSchema) + '.' : ''}${q(d.table)} (${cols.join(', ')})`;
        const parts: string[] = [head];
        if (d.typeName) parts.push(`INDEXTYPE IS ${d.typeName}`);
        if (d.tablespace) parts.push(`TABLESPACE ${q(d.tablespace)}`);
        ddl = parts.join('\n') + ';';
      } else {
        ddl = `-- 인덱스 정보 없음 (조회 실패 또는 카탈로그 미지원)`;
      }
      defsCacheRef.current.set(declKey, ddl); setDefRev(v => v + 1);
    }
    // 시퀀스 Declaration: SYS_TABLES_ 의 의미 있는 컬럼 모두 사용. 정확한 컬럼명에 의존하지 않음.
    if (objKind === 'sequence' && sub === 'declaration' && declText === undefined && detail !== undefined) {
      const d: Record<string, string> = detail || {};
      const keys = Object.keys(d);
      if (keys.length === 0) {
        defsCacheRef.current.set(declKey, `-- 시퀀스 정보 없음`);
      } else {
        const startKey = keys.find(k => /START/i.test(k));
        const incKey = keys.find(k => /INCREMENT/i.test(k));
        const minKey = keys.find(k => /^MIN|MIN_/i.test(k));
        const maxKey = keys.find(k => /^MAX|MAX_/i.test(k));
        const cacheKey = keys.find(k => /CACHE/i.test(k));
        const parts: string[] = [];
        if (startKey && d[startKey]) parts.push(`START WITH ${d[startKey]}`);
        if (incKey && d[incKey])   parts.push(`INCREMENT BY ${d[incKey]}`);
        if (minKey && d[minKey])   parts.push(`MINVALUE ${d[minKey]}`);
        if (maxKey && d[maxKey])   parts.push(`MAXVALUE ${d[maxKey]}`);
        if (cacheKey && d[cacheKey]) parts.push(`CACHE ${d[cacheKey]}`);
        const ddl = `CREATE SEQUENCE ${objSchema ? objSchema + '.' : ''}${objName}${parts.length ? ' ' + parts.join(' ') : ''};`;
        defsCacheRef.current.set(declKey, ddl);
      }
      setDefRev(v => v + 1);
    }
    // Package 상세 (properties + spec/body)
    if (objKind === 'package' && detail === undefined) {
      backend.packageDetail(objName, objSchema).then(d => { detailCacheRef.current.set(detailKey, d || { properties: {}, spec: '', body: '' }); setObjDetailRev(v => v + 1); });
    }
    // Trigger 상세 (properties + ddl)
    if (objKind === 'trigger' && detail === undefined) {
      backend.triggerDetail(objName, objSchema).then(d => { detailCacheRef.current.set(detailKey, d || { properties: {}, ddl: '' }); setObjDetailRev(v => v + 1); });
    }
    // Tablespace 상세 (datafiles + tables + indexes)
    if (objKind === 'tablespace' && detail === undefined) {
      backend.tablespaceDetail(objName).then(d => { detailCacheRef.current.set(detailKey, d || { dataFileColumns: [], dataFileRows: [], tables: [], indexes: [] }); setObjDetailRev(v => v + 1); });
    }
    // PUBLIC SYNONYM Declaration: synonymTarget 으로 CREATE PUBLIC SYNONYM 합성
    if (objKind === 'synonym' && sub === 'declaration' && declText === undefined) {
      backend.synonymTarget(objName).then(t => {
        const ddl = t
          ? `CREATE PUBLIC SYNONYM ${objName} FOR ${t.ownerName ? t.ownerName + '.' : ''}${t.objectName};`
          : `-- 시노님 대상 정보 없음`;
        defsCacheRef.current.set(declKey, ddl); setDefRev(v => v + 1);
      });
    }
    void inflightDefRef;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, backend, sub, propSub, objName, objKind, objSchema, detail]);

  // ── 상단 탭 정의 (kind 별) ──
  const topTabs: { id: string; label: string }[] = (() => {
    switch (objKind) {
      case 'table':     return [{ id: 'properties', label: 'Properties' }, { id: 'data', label: 'Data' }, { id: 'er', label: '엔티티 관계도' }];
      case 'view':      return [{ id: 'properties', label: 'Properties' }, { id: 'data', label: 'Data' }, { id: 'er', label: '엔티티 관계도' }];
      case 'index':     return [{ id: 'columns', label: '인덱스 칼럼' }, { id: 'declaration', label: 'Declaration' }];
      case 'sequence':  return [{ id: 'declaration', label: 'Declaration' }];
      case 'procedure': return [{ id: 'parameters', label: '프로시저 파라미터' }, { id: 'source', label: 'Source' }];
      case 'function':  return [{ id: 'parameters', label: '함수 파라미터' }, { id: 'source', label: 'Source' }];
      case 'synonym':   return [{ id: 'declaration', label: 'Declaration' }];
      case 'package':   return [{ id: 'pkgProcs', label: '프로시저' }, { id: 'pkgFuncs', label: '함수' }, { id: 'source', label: 'Source' }];
      case 'trigger':   return [{ id: 'source', label: 'Source' }];
      case 'tablespace': return [{ id: 'datafiles', label: '데이터 파일' }, { id: 'tbsTables', label: '테이블' }, { id: 'tbsIndexes', label: '인덱스' }];
      default:          return [];
    }
  })();

  const propsNestedTabs: { id: string; label: string }[] = objKind === 'table'
    ? [
        { id: 'columns', label: '컬럼' },
        { id: 'constraints', label: '제약조건' },
        { id: 'fks', label: '외래키' },
        { id: 'indexes', label: '인덱스' },
        { id: 'refs', label: '참조' },
        { id: 'triggers', label: '트리거' },
        { id: 'ddl', label: 'DDL' },
      ]
    : objKind === 'view'
    ? [{ id: 'columns', label: '컬럼' }, { id: 'definition', label: 'Definition' }]
    : [];

  const tabBtnStyle = (active: boolean): React.CSSProperties => ({
    padding: '4px 12px', cursor: 'pointer', fontSize: 12, userSelect: 'none',
    background: active ? '#1e1e1e' : 'transparent',
    color: active ? '#fff' : '#bbb',
    borderRight: '1px solid #333',
    borderTop: active ? '2px solid #569cd6' : '2px solid transparent',
  });

  // ── 렌더 헬퍼 ──
  const renderColumnsTable = () => {
    if (!colsCache) return <div style={{ padding: 12, color: '#888' }}>로딩...</div>;
    if (colsCache.length === 0) return <div style={{ padding: 12, color: '#666' }}>컬럼 정보 없음</div>;
    return (
      <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontFamily: 'monospace', fontSize: 12 }}>
        <thead>
          <tr style={{ position: 'sticky', top: 0, background: '#2d2d2d', color: '#9cdcfe' }}>
            <th style={{ padding: '4px 8px', textAlign: 'right', borderBottom: '1px solid #3f3f46' }}>#</th>
            <th style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #3f3f46' }}>컬럼명</th>
            <th style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #3f3f46' }}>타입</th>
            <th style={{ padding: '4px 8px', textAlign: 'center', borderBottom: '1px solid #3f3f46' }}>NULL</th>
            <th style={{ padding: '4px 8px', textAlign: 'center', borderBottom: '1px solid #3f3f46' }}>PK</th>
          </tr>
        </thead>
        <tbody>
          {colsCache.map((c, i) => {
            const isPk = pkCols.some(p => p.toUpperCase() === c.name.toUpperCase());
            return (
              <tr key={c.name} style={{ background: i % 2 ? '#222' : '#1e1e1e' }}>
                <td style={{ padding: '3px 8px', textAlign: 'right', color: '#888' }}>{i + 1}</td>
                <td style={{ padding: '3px 8px', color: c.nullable ? '#d4d4d4' : '#ffd680' }}>{c.name}</td>
                <td style={{ padding: '3px 8px', color: '#9cdcfe' }}>{c.typeText || '-'}</td>
                <td style={{ padding: '3px 8px', textAlign: 'center' }}>{c.nullable ? 'Y' : 'N'}</td>
                <td style={{ padding: '3px 8px', textAlign: 'center', color: isPk ? '#ffd680' : '#666' }}>{isPk ? '🔑' : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  };

  const renderSimpleListTable = (data: any[] | undefined, headers: { key: string; label: string; render?: (row: any) => React.ReactNode }[], emptyMsg = '없음') => {
    if (data === undefined) return <div style={{ padding: 12, color: '#888' }}>로딩...</div>;
    if (data.length === 0) return <div style={{ padding: 12, color: '#666' }}>{emptyMsg}</div>;
    return (
      <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontFamily: 'monospace', fontSize: 12 }}>
        <thead>
          <tr style={{ position: 'sticky', top: 0, background: '#2d2d2d', color: '#9cdcfe' }}>
            {headers.map(h => <th key={h.key} style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #3f3f46' }}>{h.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i} style={{ background: i % 2 ? '#222' : '#1e1e1e' }}>
              {headers.map(h => <td key={h.key} style={{ padding: '3px 8px', color: '#d4d4d4' }}>{h.render ? h.render(row) : (row[h.key] ?? '-')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  const renderMonacoText = (text: string | undefined, language = 'sql') => {
    if (text === undefined) return <div style={{ padding: 12, color: '#888' }}>로딩...</div>;
    return (
      <Editor height="100%" language={language} theme="vs-dark" value={text}
        options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12, fontFamily: 'monospace', lineNumbers: 'on', renderLineHighlight: 'none', scrollBeyondLastLine: false, automaticLayout: true, wordWrap: 'on' }} />
    );
  };

  // ── Properties 의 nested 탭 컨텐츠 ──
  const renderPropertiesContent = () => {
    if (objKind === 'view') {
      if (propSub === 'columns') return renderColumnsTable();
      if (propSub === 'definition') return renderMonacoText(defText);
    }
    if (objKind !== 'table') return null;
    if (propSub === 'columns') return renderColumnsTable();
    if (propSub === 'constraints') return renderSimpleListTable(constraints, [
      { key: 'name', label: '이름' },
      { key: 'owner', label: '소유자' },
      { key: 'type', label: 'Type' },
      { key: 'validated', label: 'Validated', render: r => r.validated === 'true' ? '[ ✓ ]' : (r.validated === 'false' ? '[   ]' : '') },
      { key: 'condition', label: 'Condition' },
      { key: 'columns', label: '컬럼', render: r => (r.columns || []).join(', ') },
    ]);
    if (propSub === 'fks') return renderSimpleListTable(fks, [
      { key: 'name', label: '이름' },
      { key: 'columns', label: '컬럼', render: r => (r.columns || []).join(', ') },
      { key: 'refTable', label: '참조 테이블' },
      { key: 'refColumns', label: '참조 컬럼', render: r => (r.refColumns || []).join(', ') },
    ]);
    if (propSub === 'indexes') return renderSimpleListTable(detailCacheRef.current.get(subDataKey('indexes')), [
      { key: 'name', label: '이름' },
      { key: 'columns', label: '컬럼', render: r => (r.columns || []).join(', ') },
    ]);
    if (propSub === 'refs') return renderSimpleListTable(refs, [
      { key: 'name', label: '이름' }, { key: 'fromTable', label: '참조하는 테이블' },
      { key: 'fromColumns', label: '컬럼', render: r => (r.fromColumns || []).join(', ') },
    ]);
    if (propSub === 'triggers') return renderSimpleListTable(triggers, [
      { key: 'name', label: '이름' }, { key: 'event', label: '이벤트' }, { key: 'timing', label: 'BEFORE/AFTER' },
    ]);
    if (propSub === 'ddl') return renderMonacoText(ddlText);
    return null;
  };

  // ── 상단 탭 컨텐츠 ──
  const renderContent = () => {
    if (sub === 'properties') return renderPropertiesContent();
    if (sub === 'data' && isTableLike) {
      return (
        <div style={{ padding: 12, color: '#bbb', fontSize: 12, lineHeight: 1.6 }}>
          <div>아래 <b>▶ 데이터</b> 버튼을 누르면 <code>{(backend?.selectAllForTable(objName) || `SELECT * FROM ${objName}`)}</code> 가 실행되고 결과가 하단에 표시됩니다.</div>
          <div style={{ marginTop: 8 }}>
            <button
              onClick={() => runSql((backend?.selectAllForTable(objName) || `SELECT * FROM ${objName}`))}
              disabled={!connected || running}
              style={{ background: '#0e639c', color: '#fff', border: 0, padding: '6px 14px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
            >▶ SELECT * 실행</button>
          </div>
        </div>
      );
    }
    if (sub === 'er') return <div style={{ padding: 12, color: '#888' }}>엔티티 관계도(ER 다이어그램) — 추후 지원 예정</div>;
    if (sub === 'columns' && objKind === 'index') {
      if (detail === undefined) return <div style={{ padding: 12, color: '#888' }}>로딩...</div>;
      const d: any = detail || {};
      const cols = (d.columns || []) as ({ name: string; sortOrder?: 'A' | 'D' } | string)[];
      if (!d.table && cols.length === 0) return <div style={{ padding: 12, color: '#666' }}>인덱스 정보 없음</div>;
      return (
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontFamily: 'monospace', fontSize: 12 }}>
          <thead>
            <tr style={{ position: 'sticky', top: 0, background: '#2d2d2d', color: '#9cdcfe' }}>
              <th style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #3f3f46' }}>이름</th>
              <th style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #3f3f46' }}>컬럼</th>
              <th style={{ padding: '4px 8px', textAlign: 'center', borderBottom: '1px solid #3f3f46' }}>Ascending</th>
            </tr>
          </thead>
          <tbody>
            {cols.length === 0 ? (
              <tr><td style={{ padding: '3px 8px', color: '#666' }} colSpan={3}>(없음)</td></tr>
            ) : cols.map((c, i) => {
              const cn = typeof c === 'string' ? c : c.name;
              const so = typeof c === 'string' ? 'A' : (c.sortOrder || 'A');
              return (
                <tr key={i} style={{ background: i % 2 ? '#222' : '#1e1e1e' }}>
                  <td style={{ padding: '3px 8px', color: '#d4d4d4' }}>{cn}</td>
                  <td style={{ padding: '3px 8px', color: '#9cdcfe' }}>{cn}</td>
                  <td style={{ padding: '3px 8px', textAlign: 'center', color: '#d4d4d4' }}>{so === 'D' ? '[   ]' : '[ ✓ ]'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      );
    }
    if (false && sub === 'storage' && objKind === 'index') {
      if (detail === undefined) return <div style={{ padding: 12, color: '#888' }}>로딩...</div>;
      const d: any = detail || {};
      const rows: [string, string][] = [
        ['Tablespace', d.tablespace || '-'],
        ['Index Type', d.typeName || '-'],
        ['Unique', d.unique ? 'true' : 'false'],
        ['Table', (d.tableSchema ? d.tableSchema + '.' : '') + (d.table || '-')],
      ];
      return (
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontFamily: 'monospace', fontSize: 12 }}>
          <thead>
            <tr style={{ position: 'sticky', top: 0, background: '#2d2d2d', color: '#9cdcfe' }}>
              <th style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #3f3f46', width: 180 }}>속성</th>
              <th style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #3f3f46' }}>값</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, v], i) => (
              <tr key={i} style={{ background: i % 2 ? '#222' : '#1e1e1e' }}>
                <td style={{ padding: '3px 8px', color: '#dcdcaa' }}>{k}</td>
                <td style={{ padding: '3px 8px', color: '#d4d4d4' }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    if (sub === 'declaration') return renderMonacoText(declText);
    // Package: pkgProcs/pkgFuncs/source 탭 — DBeaver 패키지 노드 패턴
    if (objKind === 'package') {
      if (detail === undefined) return <div style={{ padding: 12, color: '#888' }}>로딩...</div>;
      const d: any = detail || {};
      const renderRoutineTable = (kindFilter: 'PROCEDURE' | 'FUNCTION') => {
        const rows = ((d.routines || []) as any[]).filter(r => r.type === kindFilter);
        if (!rows.length) return <div style={{ padding: 12, color: '#666' }}>{kindFilter === 'PROCEDURE' ? '프로시저' : '함수'} 없음</div>;
        const label = kindFilter === 'PROCEDURE' ? '프로시저명' : '함수명';
        return (
          <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontFamily: 'monospace', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#2d2d2d', color: '#9cdcfe' }}>
                <th style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #3f3f46' }}>{label}</th>
                <th style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #3f3f46' }}>Schema Name</th>
                <th style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #3f3f46' }}>패키지</th>
                <th style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #3f3f46' }}>타입</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: any, i: number) => (
                <tr key={i} style={{ background: i % 2 ? '#222' : '#1e1e1e' }}>
                  <td style={{ padding: '3px 8px', color: '#d4d4d4' }}>{r.name}</td>
                  <td style={{ padding: '3px 8px', color: '#9cdcfe' }}>{r.schema}</td>
                  <td style={{ padding: '3px 8px', color: '#d4d4d4' }}>{r.package}</td>
                  <td style={{ padding: '3px 8px', color: '#dcdcaa' }}>{r.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      };
      if (sub === 'pkgProcs') return renderRoutineTable('PROCEDURE');
      if (sub === 'pkgFuncs') return renderRoutineTable('FUNCTION');
      if (sub === 'source') {
        const combined = [d.spec, d.body].filter(Boolean).join('\n\n');
        return renderMonacoText(combined || '-- (소스 없음)');
      }
    }
    // Trigger: source 만 (DBeaver 와 동일)
    if (objKind === 'trigger') {
      if (detail === undefined) return <div style={{ padding: 12, color: '#888' }}>로딩...</div>;
      const d: any = detail || {};
      if (sub === 'source') return renderMonacoText(d.ddl || '-- (소스 없음)');
    }
    // Tablespace: 데이터 파일 / 테이블 / 인덱스
    if (objKind === 'tablespace') {
      if (detail === undefined) return <div style={{ padding: 12, color: '#888' }}>로딩...</div>;
      const d: any = detail || {};
      const th: React.CSSProperties = { padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #3f3f46' };
      const td: React.CSSProperties = { padding: '3px 8px' };
      const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontFamily: 'monospace', fontSize: 12 };
      if (sub === 'datafiles') {
        const cols: string[] = d.dataFileColumns || [];
        const rows: string[][] = d.dataFileRows || [];
        if (!rows.length) return <div style={{ padding: 12, color: '#666' }}>데이터 파일 없음</div>;
        return (
          <table style={tableStyle}>
            <thead><tr style={{ background: '#2d2d2d', color: '#9cdcfe' }}>{cols.map((c, i) => <th key={i} style={th}>{c}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i} style={{ background: i % 2 ? '#222' : '#1e1e1e' }}>
                {cols.map((_c, ci) => <td key={ci} style={{ ...td, color: ci === 0 ? '#d4d4d4' : '#9cdcfe' }}>{(r[ci] || '').toString()}</td>)}
              </tr>
            ))}</tbody>
          </table>
        );
      }
      if (sub === 'tbsTables') {
        const rows = d.tables || [];
        if (!rows.length) return <div style={{ padding: 12, color: '#666' }}>테이블 없음</div>;
        return (
          <table style={tableStyle}>
            <thead><tr style={{ background: '#2d2d2d', color: '#9cdcfe' }}><th style={th}>Schema</th><th style={th}>Table</th><th style={th}>Partition</th></tr></thead>
            <tbody>{rows.map((r: any, i: number) => (
              <tr key={i} style={{ background: i % 2 ? '#222' : '#1e1e1e' }}>
                <td style={{ ...td, color: '#9cdcfe' }}>{r.schema}</td>
                <td style={{ ...td, color: '#d4d4d4' }}>{r.table}</td>
                <td style={{ ...td, color: '#888' }}>{r.partition || ''}</td>
              </tr>
            ))}</tbody>
          </table>
        );
      }
      if (sub === 'tbsIndexes') {
        const rows = d.indexes || [];
        if (!rows.length) return <div style={{ padding: 12, color: '#666' }}>인덱스 없음</div>;
        return (
          <table style={tableStyle}>
            <thead><tr style={{ background: '#2d2d2d', color: '#9cdcfe' }}><th style={th}>Schema</th><th style={th}>Index</th><th style={th}>Partition</th><th style={th}>Table Schema</th><th style={th}>Table</th></tr></thead>
            <tbody>{rows.map((r: any, i: number) => (
              <tr key={i} style={{ background: i % 2 ? '#222' : '#1e1e1e' }}>
                <td style={{ ...td, color: '#9cdcfe' }}>{r.schema}</td>
                <td style={{ ...td, color: '#d4d4d4' }}>{r.index}</td>
                <td style={{ ...td, color: '#888' }}>{r.partition || ''}</td>
                <td style={{ ...td, color: '#9cdcfe' }}>{r.tableSchema}</td>
                <td style={{ ...td, color: '#d4d4d4' }}>{r.table}</td>
              </tr>
            ))}</tbody>
          </table>
        );
      }
    }
    if (sub === 'source') return renderMonacoText(srcText);
    if (sub === 'parameters' && isRoutine) {
      if (params === undefined) return <div style={{ padding: 12, color: '#888' }}>로딩...</div>;
      if (params.length === 0) return <div style={{ padding: 12, color: '#666' }}>파라미터 없음</div>;
      return (
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontFamily: 'monospace', fontSize: 12 }}>
          <thead>
            <tr style={{ position: 'sticky', top: 0, background: '#2d2d2d', color: '#9cdcfe' }}>
              <th style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #3f3f46' }}>컬럼명</th>
              <th style={{ padding: '4px 8px', textAlign: 'right', borderBottom: '1px solid #3f3f46' }}>#</th>
              <th style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #3f3f46' }}>데이터 유형</th>
              <th style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #3f3f46' }}>파라미터 타입</th>
              <th style={{ padding: '4px 8px', textAlign: 'right', borderBottom: '1px solid #3f3f46' }}>길이</th>
              <th style={{ padding: '4px 8px', textAlign: 'right', borderBottom: '1px solid #3f3f46' }}>Scale</th>
              <th style={{ padding: '4px 8px', textAlign: 'right', borderBottom: '1px solid #3f3f46' }}>정밀도</th>
              <th style={{ padding: '4px 8px', textAlign: 'center', borderBottom: '1px solid #3f3f46' }}>Not Null</th>
            </tr>
          </thead>
          <tbody>
            {(params as any[]).map((p: any, i: number) => (
              <tr key={i} style={{ background: i % 2 ? '#222' : '#1e1e1e' }}>
                <td style={{ padding: '3px 8px', color: '#d4d4d4' }}>{p.name || '-'}</td>
                <td style={{ padding: '3px 8px', textAlign: 'right', color: '#888' }}>{p.order || ''}</td>
                <td style={{ padding: '3px 8px', color: '#9cdcfe' }}>{p.type || '-'}</td>
                <td style={{ padding: '3px 8px', color: '#dcdcaa' }}>{p.inOut || '-'}</td>
                <td style={{ padding: '3px 8px', textAlign: 'right', color: '#d4d4d4' }}>{p.length !== undefined ? p.length : ''}</td>
                <td style={{ padding: '3px 8px', textAlign: 'right', color: '#d4d4d4' }}>{p.scale !== undefined ? p.scale : ''}</td>
                <td style={{ padding: '3px 8px', textAlign: 'right', color: '#d4d4d4' }}>{p.precision !== undefined ? p.precision : ''}</td>
                <td style={{ padding: '3px 8px', textAlign: 'center' }}>{p.nullable === false ? '[ ✓ ]' : '[   ]'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    return null;
  };

  return (
    <div style={{ flex: '1 1 auto', minHeight: 200, borderBottom: '1px solid #333', display: 'flex', flexDirection: 'column', background: '#1e1e1e', overflow: 'hidden' }}>
      {/* 객체 헤더 */}
      <div style={{ padding: '6px 10px', borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', gap: 8, background: '#252526' }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{ICON_MAP[objKind]} {objName}</span>
        <span style={{ color: '#888', fontSize: 11 }}>{LABEL_MAP[objKind]}</span>
        {objSchema && <span style={{ color: '#666', fontSize: 11 }}>· {objSchema}</span>}
        {isTableLike && pkCols.length > 0 && (
          <span style={{ color: '#9cdcfe', fontSize: 11, background: '#2a2a2a', border: '1px solid #444', padding: '1px 6px', borderRadius: 3 }}>🔑 {pkCols.join(', ')}</span>
        )}
        {isTableLike && (
          <button
            onClick={() => { setActiveEditorTabId(tab.id); runSql((backend?.selectAllForTable(objName) || `SELECT * FROM ${objName}`)); }}
            disabled={!connected || running}
            title="SELECT * 실행 (결과는 하단)"
            style={{ marginLeft: 'auto', background: '#0e639c', color: '#fff', border: 0, padding: '3px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}
          >▶ 데이터</button>
        )}
      </div>
      {/* 상단 탭 */}
      <div style={{ display: 'flex', alignItems: 'stretch', background: '#252526', borderBottom: '1px solid #333' }}>
        {topTabs.map(t => (
          <div key={t.id} onClick={() => onSubTab(t.id)} style={tabBtnStyle(sub === t.id)}>{t.label}</div>
        ))}
      </div>
      {/* Properties nested 탭 (table/view) */}
      {sub === 'properties' && propsNestedTabs.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'stretch', background: '#2a2a2a', borderBottom: '1px solid #333' }}>
          {propsNestedTabs.map(t => (
            <div key={t.id} onClick={() => onPropSubTab(t.id)} style={{ ...tabBtnStyle(propSub === t.id), fontSize: 11, padding: '3px 10px' }}>{t.label}</div>
          ))}
        </div>
      )}
      {/* 컨텐츠 */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 0 }}>
        {renderContent()}
      </div>
    </div>
  );
};
