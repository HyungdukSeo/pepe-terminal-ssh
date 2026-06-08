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

// info(관리/시스템 정보) 결과 후처리 — DBeaver 모델과 동일한 컬럼으로 가공. Altibase 타입변환 오류 회피용으로 JS 에서 처리.
type RowDetail = { name: string; value: string }[];
function transformInfoResult(key: string, columns: string[], rows: any[][]): { columns: string[]; rows: any[][]; rowDetails?: RowDetail[] } {
  const idx = (name: string) => columns.findIndex(c => c.toUpperCase() === name.toUpperCase());
  const s = (v: any) => (v == null ? '' : String(v)).trim();
  if (key === 'altibaseProperty') {
    // DBeaver AltibaseProperty: Name / Dynamic((ATTR & 0x2)==0 → 동적) / 값(숫자면 "값  [min, max]", 문자면 VALUE1..n)
    const iName = idx('NAME'), iAttr = idx('ATTR'), iMin = idx('MIN'), iMax = idx('MAX');
    const vIdx = columns.map((c, i) => (/^VALUE\d+$/i.test(c) ? i : -1)).filter(i => i >= 0);
    const out: any[][] = [];
    const rowDetails: RowDetail[] = [];
    for (const r of rows) {
      const name = s(r[iName]);
      const attr = parseInt(s(r[iAttr]), 10);
      const dynamic = !isNaN(attr) && (attr & 0x2) === 0 ? '[v]' : '[ ]';
      const min = iMin >= 0 ? s(r[iMin]) : '';
      const max = iMax >= 0 ? s(r[iMax]) : '';
      let value: string;
      if (min !== '' || max !== '') {
        value = `${vIdx.length ? s(r[vIdx[0]]) : ''}  [${min}, ${max}]`;
      } else {
        value = vIdx.map(i => s(r[i])).filter(x => x !== '').join(', ');
      }
      out.push([name, dynamic, value]);
      // 하단 상세 — min/max/value 원시값 포함
      const det: RowDetail = [
        { name: 'Name', value: name },
        { name: 'Dynamic', value: dynamic },
        { name: 'Min', value: min },
        { name: 'Max', value: max },
      ];
      vIdx.forEach((vi, k) => det.push({ name: `Value${k + 1}`, value: s(r[vi]) }));
      det.push({ name: 'Attr', value: s(r[iAttr]) });
      rowDetails.push(det);
    }
    return { columns: ['Name', 'Dynamic', '값'], rows: out, rowDetails };
  }
  if (key === 'altibaseMemoryModule') {
    // DBeaver AltibaseMemoryModule: 이름 / Allocated Size(ByteNumberFormat) / Allocation Count
    const iName = idx('NAME'), iSize = idx('ALLOC_SIZE'), iCount = idx('ALLOC_COUNT');
    const fmtBytes = (raw: string): string => {
      const n = parseFloat(raw);
      if (!isFinite(n)) return raw;
      const units = ['', 'K', 'M', 'G', 'T', 'P'];
      let u = 0, v = n;
      while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
      const str = u === 0 ? String(Math.round(v)) : (v >= 100 ? v.toFixed(0) : v.toFixed(1));
      return str + units[u];
    };
    const fmtCount = (raw: string): string => { const n = parseInt(raw, 10); return isNaN(n) ? raw : n.toLocaleString(); };
    const out = rows.map(r => [s(r[iName]), fmtBytes(s(r[iSize])), fmtCount(s(r[iCount]))]);
    const rowDetails: RowDetail[] = rows.map(r => [
      { name: 'Name', value: s(r[iName]) },
      { name: 'Allocated Size', value: s(r[iSize]) },
      { name: 'Allocation Count', value: s(r[iCount]) },
    ]);
    return { columns: ['이름', 'Allocated Size', 'Allocation Count'], rows: out, rowDetails };
  }
  return { columns, rows };
}

const ICON_MAP: Record<ObjectKind, string> = { table: '📄', view: '👁', index: '🔑', sequence: '🔢', procedure: '⚙', function: 'ƒ', synonym: '🔗', package: '📦', trigger: '🔔', tablespace: '💾', replication: '🔄', info: 'ℹ' };
const LABEL_MAP: Record<ObjectKind, string> = { table: 'TABLE', view: 'VIEW', index: 'INDEX', sequence: 'SEQUENCE', procedure: 'PROCEDURE', function: 'FUNCTION', synonym: 'PUBLIC SYNONYM', package: 'PACKAGE', trigger: 'TRIGGER', tablespace: 'TABLESPACE', replication: 'REPLICATION', info: 'INFO' };

export const ObjectDetailPanel: React.FC<Props> = (p) => {
  const { tab, backend, connected, running, colsCacheRef, pksCacheRef, defsCacheRef, inflightDefRef, detailCacheRef,
    columnsRev, pkRev, defRev, objDetailRev, setDefRev, setObjDetailRev,
    loadColumns, loadPrimaryKey, loadDefinition, runSql, setActiveEditorTabId, onSubTab, onPropSubTab } = p;
  void columnsRev; void pkRev; void defRev; void objDetailRev;

  // info(관리/시스템 정보) 그리드에서 선택된 행 (마스터-디테일)
  const [selectedInfoRow, setSelectedInfoRow] = React.useState<number>(-1);
  const [showInfoSql, setShowInfoSql] = React.useState<boolean>(false);
  const [infoSort, setInfoSort] = React.useState<{ col: number; dir: 'asc' | 'desc' } | null>(null);
  const [tableSort, setTableSort] = React.useState<Record<string, { col: number; dir: 'asc' | 'desc' }>>({});

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
  const detailKey = `${objKind}:${objSchema}:${objName.toUpperCase()}${tab.objectTable ? ':' + tab.objectTable.toUpperCase() : ''}`;
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
  const declKey = `${objKind}:decl:${objName.toUpperCase()}${tab.objectTable ? ':' + tab.objectTable.toUpperCase() : ''}`;
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
      backend.indexDetail(objName, objSchema, tab.objectTable).then(d => { detailCacheRef.current.set(detailKey, d || { table: '', columns: [], unique: false }); setObjDetailRev(v => v + 1); });
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
    // 엔티티 관계도(ER): 컬럼/PK/외래키/참조 lazy fetch
    if (objKind === 'table' && sub === 'er') {
      if (!colsCache) loadColumns(objName);
      if (pkCols.length === 0 && !pksCacheRef.current.has(objName.toUpperCase())) loadPrimaryKey(objName);
      if (fks === undefined) backend.tableForeignKeys(objName, objSchema).then(rows => { detailCacheRef.current.set(subDataKey('fks'), rows || []); setObjDetailRev(v => v + 1); });
      if (refs === undefined) backend.tableReferencedBy(objName, objSchema).then(rows => { detailCacheRef.current.set(subDataKey('refs'), rows || []); setObjDetailRev(v => v + 1); });
    }
    // 인덱스 Declaration: detail 가 캐시에 들어오면 CREATE INDEX 합성 (빈 detail 도 안내 메시지로)
    if (objKind === 'index' && sub === 'declaration' && declText === undefined && detail !== undefined) {
      const d: any = detail || {};
      const dbType = backend?.type;
      let ddl: string;
      if (d.table) {
        if (dbType === 'mysql') {
          // MySQL: 백틱 식별자. PRIMARY 는 CREATE INDEX 불가 → ALTER TABLE ADD PRIMARY KEY.
          const q = (s: string) => '`' + String(s).replace(/`/g, '``') + '`';
          const cols = (d.columns || []).map((c: any) => {
            const cn = typeof c === 'string' ? c : c.name;
            const desc = typeof c === 'string' ? false : c.sortOrder === 'D';
            return q(cn) + (desc ? ' DESC' : '');
          });
          const using = d.typeName ? ` USING ${d.typeName}` : '';
          if (objName.toUpperCase() === 'PRIMARY') {
            ddl = `ALTER TABLE ${q(d.table)} ADD PRIMARY KEY (${cols.join(', ')})${using};`;
          } else {
            ddl = `CREATE ${d.unique ? 'UNIQUE ' : ''}INDEX ${q(objName)} ON ${q(d.table)} (${cols.join(', ')})${using};`;
          }
        } else {
          // Altibase/Oracle 등: 큰따옴표 식별자 + INDEXTYPE/TABLESPACE 절.
          const q = (s: string) => `"${s}"`;
          const sch = (d.tableSchema || objSchema || '').toUpperCase();
          const idxSchema = (objSchema || '').toUpperCase();
          const tblSchema = sch || idxSchema;
          const cols = (d.columns || []).map((c: any) => typeof c === 'string'
            ? q(c)
            : (q(c.name) + (c.sortOrder === 'D' ? ' DESC' : '')));
          const head = `CREATE ${d.unique ? 'UNIQUE ' : ''}INDEX ${idxSchema ? q(idxSchema) + '.' : ''}${q(objName)} ON ${tblSchema ? q(tblSchema) + '.' : ''}${q(d.table)} (${cols.join(', ')})`;
          const parts: string[] = [head];
          if (d.typeName) parts.push(`INDEXTYPE IS ${d.typeName}`);
          if (d.tablespace) parts.push(`TABLESPACE ${q(d.tablespace)}`);
          ddl = parts.join('\n') + ';';
        }
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
    // Replication 상세 (properties + hosts + items) — DBeaver AltibaseReplication 패턴.
    //   캐시에 빈 properties 가 있으면 다시 시도 (이전 fetch 가 실패한 경우 대비).
    if (objKind === 'replication') {
      const cached: any = detail;
      const needFetch = cached === undefined
        || (cached && (!cached.properties || Object.keys(cached.properties).length === 0));
      if (needFetch) {
        backend.replicationDetail(objName).then(d => { detailCacheRef.current.set(detailKey, d || { properties: {}, hosts: [], items: [] }); setObjDetailRev(v => v + 1); });
      }
    }
    // 관리/시스템 정보(info) — 사전정의 쿼리 실행 결과를 그리드로 표시
    if (objKind === 'info' && detail === undefined && tab.objectInfoSql) {
      backend.exec(tab.objectInfoSql, 5000)
        .then(r => {
          const t = tab.objectInfoTransform
            ? transformInfoResult(tab.objectInfoTransform, r.columns || [], r.rows || [])
            : { columns: r.columns || [], rows: r.rows || [], rowDetails: undefined as RowDetail[] | undefined };
          detailCacheRef.current.set(detailKey, { columns: t.columns, rows: t.rows, rowDetails: t.rowDetails, error: '' }); setObjDetailRev(v => v + 1);
        })
        .catch((e: any) => { detailCacheRef.current.set(detailKey, { columns: [], rows: [], error: String(e?.message || e) }); setObjDetailRev(v => v + 1); });
    }
    // SYNONYM Declaration — objSchema 있으면 user-소유, 없으면 PUBLIC 으로 합성.
    if (objKind === 'synonym' && sub === 'declaration' && declText === undefined) {
      backend.synonymTarget(objName, objSchema).then(t => {
        const isPublic = !objSchema;
        const head = isPublic ? 'CREATE PUBLIC SYNONYM' : 'CREATE SYNONYM';
        const name = isPublic ? objName : `${objSchema}.${objName}`;
        const ddl = t
          ? `${head} ${name} FOR ${t.ownerName ? t.ownerName + '.' : ''}${t.objectName};`
          : `-- 시노님 대상 정보 없음`;
        defsCacheRef.current.set(declKey, ddl); setDefRev(v => v + 1);
      });
    }
    void inflightDefRef;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, backend, sub, propSub, objName, objKind, objSchema, detail]);

  // ── ER: 관련 테이블 컬럼 lazy fetch (외래키/참조 로딩 후) ──
  React.useEffect(() => {
    if (!connected || !backend || sub !== 'er' || objKind !== 'table') return;
    const related = new Set<string>();
    (fks || []).forEach((f: any) => { if (f.refTable) related.add(f.refTable.toUpperCase()); });
    (refs || []).forEach((r: any) => { if (r.fromTable) related.add(r.fromTable.toUpperCase()); });
    related.forEach(t => { if (!colsCacheRef.current.has(t)) loadColumns(t); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, backend, sub, objKind, fks, refs]);

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
      case 'replication': return [{ id: 'properties', label: 'Properties' }, { id: 'replItems', label: '이중화 대상' }, { id: 'replHosts', label: '원격 호스트' }];
      case 'info':      return [{ id: 'properties', label: 'Properties' }];
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
  // 헤더 클릭 정렬을 지원하는 범용 테이블. sortId 로 표마다 정렬 상태 분리.
  type SortCol = { label: string; align?: 'left' | 'right' | 'center'; thStyle?: React.CSSProperties; value: (row: any, idx: number) => any; render: (row: any, idx: number) => React.ReactNode };
  const cmpVal = (a: any, b: any): number => {
    const sa = a == null ? '' : String(a), sb = b == null ? '' : String(b);
    const na = parseFloat(sa), nb = parseFloat(sb);
    const bothNum = sa.trim() !== '' && sb.trim() !== '' && !isNaN(na) && !isNaN(nb) && /^-?[\d.,]+$/.test(sa.trim()) && /^-?[\d.,]+$/.test(sb.trim());
    return bothNum ? na - nb : sa.localeCompare(sb);
  };
  const toggleTableSort = (sortId: string, col: number) => setTableSort(p => {
    const c = p[sortId];
    const dir: 'asc' | 'desc' = c && c.col === col && c.dir === 'asc' ? 'desc' : 'asc';
    return { ...p, [sortId]: { col, dir } };
  });
  const renderSortableTable = (sortId: string, columns: SortCol[], data: any[]) => {
    const sc = tableSort[sortId];
    const order = data.map((_, i) => i);
    if (sc && sc.col >= 0 && sc.col < columns.length) {
      const get = columns[sc.col].value;
      order.sort((a, b) => cmpVal(get(data[a], a), get(data[b], b)) * (sc.dir === 'asc' ? 1 : -1));
    }
    return (
      <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontFamily: 'monospace', fontSize: 12 }}>
        <thead>
          <tr style={{ position: 'sticky', top: 0, background: '#2d2d2d', color: '#9cdcfe' }}>
            {columns.map((c, ci) => (
              <th key={ci} onClick={() => toggleTableSort(sortId, ci)} title="클릭: 정렬"
                style={{ padding: '4px 8px', textAlign: c.align || 'left', borderBottom: '1px solid #3f3f46', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', ...c.thStyle }}>
                {c.label}<span style={{ color: '#dcdcaa' }}>{sc && sc.col === ci ? (sc.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {order.map((orig, p) => (
            <tr key={orig} style={{ background: p % 2 ? '#222' : '#1e1e1e' }}>
              {columns.map((c, ci) => (
                <td key={ci} style={{ padding: '3px 8px', color: '#d4d4d4', textAlign: c.align || 'left' }}>{c.render(data[orig], orig)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  const renderColumnsTable = () => {
    if (!colsCache) return <div style={{ padding: 12, color: '#888' }}>로딩...</div>;
    if (colsCache.length === 0) return <div style={{ padding: 12, color: '#666' }}>컬럼 정보 없음</div>;
    const isPkOf = (c: ColumnInfo) => pkCols.some(p => p.toUpperCase() === c.name.toUpperCase());
    return renderSortableTable(`cols:${objName}`, [
      { label: '#', align: 'right', value: (_r, i) => i, render: (_r, i) => <span style={{ color: '#888' }}>{i + 1}</span> },
      { label: '컬럼명', value: r => r.name, render: r => <span style={{ color: r.nullable ? '#d4d4d4' : '#ffd680' }}>{r.name}</span> },
      { label: '타입', value: r => r.typeText || '', render: r => <span style={{ color: '#9cdcfe' }}>{r.typeText || '-'}</span> },
      { label: 'NULL', align: 'center', value: r => (r.nullable ? 1 : 0), render: r => (r.nullable ? 'Y' : 'N') },
      { label: 'PK', align: 'center', value: r => (isPkOf(r) ? 1 : 0), render: r => <span style={{ color: isPkOf(r) ? '#ffd680' : '#666' }}>{isPkOf(r) ? '🔑' : ''}</span> },
    ], colsCache);
  };

  const renderSimpleListTable = (data: any[] | undefined, headers: { key: string; label: string; render?: (row: any) => React.ReactNode }[], emptyMsg = '없음', sortId = 'list') => {
    if (data === undefined) return <div style={{ padding: 12, color: '#888' }}>로딩...</div>;
    if (data.length === 0) return <div style={{ padding: 12, color: '#666' }}>{emptyMsg}</div>;
    const sortVal = (row: any, key: string) => { const v = row[key]; return Array.isArray(v) ? v.join(', ') : v; };
    return renderSortableTable(`${sortId}:${objName}`, headers.map(h => ({
      label: h.label,
      value: (row: any) => sortVal(row, h.key),
      render: (row: any) => (h.render ? h.render(row) : (row[h.key] ?? '-')),
    })), data);
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
    ], '없음', 'constraints');
    if (propSub === 'fks') return renderSimpleListTable(fks, [
      { key: 'name', label: '이름' },
      { key: 'columns', label: '컬럼', render: r => (r.columns || []).join(', ') },
      { key: 'refTable', label: '참조 테이블' },
      { key: 'refColumns', label: '참조 컬럼', render: r => (r.refColumns || []).join(', ') },
    ], '없음', 'fks');
    if (propSub === 'indexes') return renderSimpleListTable(detailCacheRef.current.get(subDataKey('indexes')), [
      { key: 'name', label: '이름' },
      { key: 'columns', label: '컬럼', render: r => (r.columns || []).join(', ') },
    ], '없음', 'indexes');
    if (propSub === 'refs') return renderSimpleListTable(refs, [
      { key: 'name', label: '이름' }, { key: 'fromTable', label: '참조하는 테이블' },
      { key: 'fromColumns', label: '컬럼', render: r => (r.fromColumns || []).join(', ') },
    ], '없음', 'refs');
    if (propSub === 'triggers') return renderSimpleListTable(triggers, [
      { key: 'name', label: '이름' }, { key: 'event', label: '이벤트' }, { key: 'timing', label: 'BEFORE/AFTER' },
    ], '없음', 'triggers');
    if (propSub === 'ddl') return renderMonacoText(ddlText);
    return null;
  };

  // ── 엔티티 관계도(ER 다이어그램) ──
  const renderER = () => {
    // 뷰: 단일 박스(컬럼만)
    if (objKind === 'view') {
      if (colsCache === undefined) return <div style={{ padding: 12, color: '#888' }}>로딩...</div>;
    } else {
      if (colsCache === undefined || fks === undefined || refs === undefined) return <div style={{ padding: 12, color: '#888' }}>로딩...</div>;
    }

    type ERCol = { name: string; type: string; pk: boolean; fk: boolean };
    type ERBox = { key: string; name: string; cols: ERCol[]; x: number; y: number; w: number; h: number; central?: boolean };

    const BW = 230, HEAD = 26, RH = 18, GX = 130, GY = 30, PAD = 24, MAXROWS = 20;
    const boxBodyRows = (n: number) => Math.min(n, MAXROWS) + (n > MAXROWS ? 1 : 0);
    const boxH = (n: number) => HEAD + Math.max(1, boxBodyRows(n)) * RH;

    const fkColSet = new Set<string>();
    (fks || []).forEach((f: any) => (f.columns || []).forEach((c: string) => fkColSet.add(c.toUpperCase())));
    const buildCols = (raw: ColumnInfo[] | undefined, pks: string[], fkCols: Set<string>): ERCol[] =>
      (raw || []).map(c => ({
        name: c.name, type: c.typeText || '',
        pk: pks.some(p => p.toUpperCase() === c.name.toUpperCase()),
        fk: fkCols.has(c.name.toUpperCase()),
      }));

    const central: ERBox = {
      key: objName.toUpperCase(), name: objName, central: true,
      cols: buildCols(colsCache || undefined, pkCols, fkColSet),
      x: 0, y: 0, w: BW, h: boxH((colsCache || []).length),
    };

    const rightNames: string[] = objKind === 'table'
      ? [...new Set<string>((fks || []).map((f: any) => String(f.refTable)).filter(Boolean))] : [];
    const leftNames: string[] = objKind === 'table'
      ? [...new Set<string>((refs || []).map((r: any) => String(r.fromTable)).filter(Boolean))]
        .filter(t => t.toUpperCase() !== objName.toUpperCase()) : [];

    const relColsOf = (name: string): ColumnInfo[] | undefined => colsCacheRef.current.get(name.toUpperCase());
    const relPkOf = (name: string): string[] => pksCacheRef.current.get(name.toUpperCase()) || [];

    const hasLeft = leftNames.length > 0;
    const centralX = hasLeft ? PAD + BW + GX : PAD;
    const rightX = centralX + BW + GX;

    let ly = PAD;
    const leftBoxes: ERBox[] = leftNames.map((name: string) => {
      const raw = relColsOf(name);
      const b: ERBox = { key: name.toUpperCase(), name, cols: buildCols(raw, relPkOf(name), new Set()), x: PAD, y: ly, w: BW, h: boxH((raw || []).length) };
      ly += b.h + GY; return b;
    });
    let ry = PAD;
    const rightBoxes: ERBox[] = rightNames.map((name: string) => {
      const raw = relColsOf(name);
      const b: ERBox = { key: name.toUpperCase(), name, cols: buildCols(raw, relPkOf(name), new Set()), x: rightX, y: ry, w: BW, h: boxH((raw || []).length) };
      ry += b.h + GY; return b;
    });

    const sideMax = Math.max(ly, ry, PAD + central.h + PAD);
    central.x = centralX;
    central.y = Math.max(PAD, (sideMax - central.h) / 2);

    const allBoxes = [central, ...leftBoxes, ...rightBoxes];
    const canvasW = (rightBoxes.length ? rightX + BW : centralX + BW) + PAD;
    const canvasH = Math.max(...allBoxes.map(b => b.y + b.h)) + PAD;

    // 컬럼의 세로 중심 y (박스 내). 못 찾거나 범위 밖이면 헤더 중심.
    const anchorY = (b: ERBox, colName?: string) => {
      if (colName) {
        const idx = b.cols.findIndex(c => c.name.toUpperCase() === colName.toUpperCase());
        if (idx >= 0 && idx < MAXROWS) return b.y + HEAD + idx * RH + RH / 2;
      }
      return b.y + HEAD / 2;
    };

    type Link = { x1: number; y1: number; x2: number; y2: number };
    const links: Link[] = [];
    // 외래키: central(자식, FK 보유) → 참조 테이블(부모, PK)
    (fks || []).forEach((f: any) => {
      const rb = rightBoxes.find(b => b.name.toUpperCase() === String(f.refTable).toUpperCase());
      if (!rb) return;
      links.push({
        x1: central.x + BW, y1: anchorY(central, (f.columns || [])[0]),
        x2: rb.x, y2: anchorY(rb, (f.refColumns || [])[0]),
      });
    });
    // 참조됨: 다른 테이블(자식, FK) → central(부모, PK)
    (refs || []).forEach((r: any) => {
      const lb = leftBoxes.find(b => b.name.toUpperCase() === String(r.fromTable).toUpperCase());
      if (!lb) return;
      links.push({
        x1: lb.x + BW, y1: anchorY(lb, (r.fromColumns || [])[0]),
        x2: central.x, y2: anchorY(central, pkCols[0]),
      });
    });

    const orthoPath = (l: Link) => {
      const midX = (l.x1 + l.x2) / 2;
      return `M${l.x1},${l.y1} L${midX},${l.y1} L${midX},${l.y2} L${l.x2},${l.y2}`;
    };

    const renderBox = (b: ERBox) => {
      const shown = b.cols.slice(0, MAXROWS);
      const extra = b.cols.length - shown.length;
      return (
        <div key={b.key} style={{
          position: 'absolute', left: b.x, top: b.y, width: b.w,
          border: b.central ? '2px solid #0e9c6b' : '1px solid #3f3f46',
          borderRadius: 4, background: '#252526', boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
          fontFamily: 'monospace', fontSize: 11, overflow: 'hidden',
        }}>
          <div style={{
            height: HEAD, lineHeight: `${HEAD}px`, padding: '0 8px', fontWeight: 700,
            background: b.central ? '#0e9c6b' : '#2d2d2d', color: b.central ? '#fff' : '#9cdcfe',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }} title={b.name}>📄 {b.name}</div>
          <div>
            {shown.length === 0 ? (
              <div style={{ height: RH, lineHeight: `${RH}px`, padding: '0 8px', color: '#666' }}>(컬럼 로딩...)</div>
            ) : shown.map((c, i) => (
              <div key={c.name} style={{
                height: RH, lineHeight: `${RH}px`, padding: '0 8px', display: 'flex', gap: 6,
                background: i % 2 ? '#222' : '#252526', whiteSpace: 'nowrap', overflow: 'hidden',
              }}>
                <span style={{ width: 14, flex: '0 0 auto', textAlign: 'center' }}>{c.pk ? '🔑' : (c.fk ? '🔗' : '')}</span>
                <span style={{ color: c.pk ? '#ffd680' : '#d4d4d4', flex: '0 0 auto' }}>{c.name}</span>
                <span style={{ color: '#6a9955', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.type}</span>
              </div>
            ))}
            {extra > 0 && <div style={{ height: RH, lineHeight: `${RH}px`, padding: '0 8px', color: '#888' }}>… 외 {extra}개</div>}
          </div>
        </div>
      );
    };

    return (
      <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'auto', background: '#1e1e1e' }}>
        <div style={{ position: 'absolute', top: 6, right: 10, zIndex: 5, color: '#888', fontSize: 11, background: 'rgba(30,30,30,0.8)', padding: '2px 8px', borderRadius: 3 }}>
          🔑 PK · 🔗 FK · 선: 관계({links.length})
        </div>
        <div style={{ position: 'relative', width: canvasW, height: canvasH }}>
          <svg width={canvasW} height={canvasH} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
            <defs>
              <marker id="erFk" markerWidth="9" markerHeight="9" refX="4" refY="4" markerUnits="userSpaceOnUse">
                <circle cx="4" cy="4" r="3" fill="#6a9955" />
              </marker>
              <marker id="erPk" markerWidth="10" markerHeight="12" refX="2" refY="6" orient="auto" markerUnits="userSpaceOnUse">
                <line x1="2" y1="1" x2="2" y2="11" stroke="#6a9955" strokeWidth="2" />
              </marker>
            </defs>
            {links.map((l, i) => (
              <path key={i} d={orthoPath(l)} fill="none" stroke="#6a9955" strokeWidth="1.4"
                markerStart="url(#erFk)" markerEnd="url(#erPk)" />
            ))}
          </svg>
          {allBoxes.map(renderBox)}
          {objKind === 'table' && links.length === 0 && (
            <div style={{ position: 'absolute', left: central.x, top: central.y + central.h + 16, color: '#888', fontSize: 12 }}>
              이 테이블과 연결된 외래키 관계가 없습니다.
            </div>
          )}
        </div>
      </div>
    );
  };

  // ── 상단 탭 컨텐츠 ──
  const renderContent = () => {
    if (objKind === 'info') {
      const d: any = detail || {};
      const cols: string[] = d.columns || [];
      const rows: any[][] = d.rows || [];
      const refresh = () => { detailCacheRef.current.delete(detailKey); setObjDetailRev(v => v + 1); };
      const toolbar = (
        <div style={{ flex: '0 0 auto', borderBottom: '1px solid #333', background: '#252526' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px' }}>
            <button onClick={refresh} disabled={!connected || running}
              style={{ background: '#0e639c', color: '#fff', border: 0, padding: '3px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}>↻ 새로 고침</button>
            <button onClick={() => setShowInfoSql(v => !v)} title="실행 쿼리 보기/숨기기"
              style={{ background: showInfoSql ? '#37373d' : 'transparent', color: '#bbb', border: '1px solid #3f3f46', padding: '3px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}>
              {showInfoSql ? '쿼리 숨기기' : '쿼리 보기'}</button>
            {detail !== undefined && !d.error && <span style={{ marginLeft: 'auto', color: '#888', fontSize: 11 }}>{rows.length.toLocaleString()}행</span>}
          </div>
          {showInfoSql && (
            <div style={{ padding: '6px 10px', borderTop: '1px solid #333', maxHeight: 110, overflow: 'auto', color: '#9cdcfe', fontSize: 11, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: '#1e1e1e' }}>{tab.objectInfoSql}</div>
          )}
        </div>
      );
      let body: React.ReactNode;
      if (detail === undefined) body = <div style={{ padding: 12, color: '#888' }}>로딩...</div>;
      else if (d.error) body = <div style={{ padding: 12, color: '#f48771', whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 12 }}>✗ {d.error}</div>;
      else if (cols.length === 0) body = <div style={{ padding: 12, color: '#666' }}>결과 없음</div>;
      else {
        // 헤더 클릭 정렬 — 원본 인덱스 배열(order)을 정렬해 rows/rowDetails 정합성 유지.
        const order = rows.map((_, i) => i);
        if (infoSort && infoSort.col >= 0 && infoSort.col < cols.length) {
          const { col, dir } = infoSort;
          const cmp = (a: any, b: any) => {
            const sa = a == null ? '' : String(a), sb = b == null ? '' : String(b);
            const na = parseFloat(sa), nb = parseFloat(sb);
            const bothNum = sa.trim() !== '' && sb.trim() !== '' && !isNaN(na) && !isNaN(nb) && /^-?[\d.,]+$/.test(sa.trim()) && /^-?[\d.,]+$/.test(sb.trim());
            if (bothNum) return na - nb;
            return sa.localeCompare(sb);
          };
          order.sort((a, b) => cmp(rows[a][col], rows[b][col]) * (dir === 'asc' ? 1 : -1));
        }
        const origIdx = selectedInfoRow >= 0 && selectedInfoRow < order.length ? order[selectedInfoRow] : -1;
        const sel = origIdx >= 0 ? rows[origIdx] : null;
        const rowDetail: RowDetail | null = (origIdx >= 0 && d.rowDetails && d.rowDetails[origIdx]) || null;
        const sqlColIdx = cols.findIndex(c => /^sql$|query/i.test(c));
        const toggleSort = (ci: number) => {
          setSelectedInfoRow(-1);
          setInfoSort(p => p && p.col === ci ? { col: ci, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { col: ci, dir: 'asc' });
        };
        const sqlText = sel && sqlColIdx >= 0 ? (sel[sqlColIdx] == null ? '' : String(sel[sqlColIdx])) : '';
        // Name/Value 상세 그룹핑 (DBeaver Session Details 유사)
        const grp = (name: string): string => {
          if (/^sql$|query/i.test(name)) return 'SQL';
          if (/lock/i.test(name)) return 'Wait';
          if (/time.?limit|timeout/i.test(name)) return 'Timeout';
          if (/login|idle|time.?zone|territory/i.test(name)) return '시간/세션';
          if (/client|comm|connection|protocol|pid|app/i.test(name)) return '연결';
          return '기타';
        };
        const grid = (
          <div style={{ flex: 1, minHeight: 80, overflow: 'auto' }}>
            <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontFamily: 'monospace', fontSize: 12, minWidth: '100%' }}>
              <thead>
                <tr style={{ position: 'sticky', top: 0, background: '#2d2d2d', color: '#9cdcfe', zIndex: 1 }}>
                  <th style={{ padding: '4px 8px', textAlign: 'right', borderBottom: '1px solid #3f3f46', borderRight: '1px solid #3f3f46' }}>#</th>
                  {cols.map((c, i) => {
                    const isSql = /^sql$|query/i.test(c);
                    const arrow = infoSort && infoSort.col === i ? (infoSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
                    return (
                      <th key={i} onClick={() => toggleSort(i)} title="클릭: 정렬"
                        style={{ padding: '4px 10px', textAlign: 'left', borderBottom: '1px solid #3f3f46', whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none', ...(isSql ? { maxWidth: 280 } : {}) }}>
                        {c}<span style={{ color: '#dcdcaa' }}>{arrow}</span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {order.map((orig, p) => {
                  const row = rows[orig];
                  const on = p === selectedInfoRow;
                  return (
                    <tr key={orig} onClick={() => setSelectedInfoRow(p === selectedInfoRow ? -1 : p)}
                      style={{ background: on ? '#094771' : (p % 2 ? '#222' : '#1e1e1e'), cursor: 'pointer' }}>
                      <td style={{ padding: '3px 8px', textAlign: 'right', color: '#888', borderRight: '1px solid #333' }}>{p + 1}</td>
                      {cols.map((_c, ci) => {
                        const isSql = /^sql$|query/i.test(cols[ci]);
                        const val = row[ci] == null ? null : String(row[ci]);
                        return (
                          <td key={ci} title={isSql && val ? val : undefined}
                            style={{ padding: '3px 10px', color: on ? '#fff' : '#d4d4d4', whiteSpace: 'nowrap', ...(isSql ? { maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' } : {}) }}>
                            {val == null ? <span style={{ color: '#666' }}>(null)</span> : val}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
        // 하단 Session Details (선택 행) — SQL 전문 + Name/Value 그룹 트리
        const detailPane = sel && (
          <div style={{ flex: '0 0 220px', minHeight: 120, borderTop: '2px solid #3f3f46', display: 'flex', background: '#1e1e1e' }}>
            {sqlColIdx >= 0 && (
              <div style={{ flex: '0 0 42%', display: 'flex', flexDirection: 'column', borderRight: '1px solid #333' }}>
                <div style={{ padding: '4px 8px', color: '#9cdcfe', fontSize: 11, background: '#252526', borderBottom: '1px solid #333' }}>📄 SQL</div>
                <textarea readOnly value={sqlText || '(없음)'} style={{ flex: 1, resize: 'none', border: 0, outline: 'none', background: '#1e1e1e', color: '#d4d4d4', fontFamily: 'monospace', fontSize: 12, padding: 8, whiteSpace: 'pre-wrap' }} />
              </div>
            )}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <div style={{ padding: '4px 8px', color: '#9cdcfe', fontSize: 11, background: '#252526', borderBottom: '1px solid #333' }}>🗂 상세 (행 {selectedInfoRow + 1})</div>
              <div style={{ flex: 1, overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace', fontSize: 12 }}>
                  <tbody>
                    {rowDetail ? (
                      // 변환된 항목(예: Altibase Property) — Min/Max/Value 원시값 평면 표시
                      rowDetail.map((kv, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #2a2a2a' }}>
                          <td style={{ padding: '3px 8px', color: '#9cdcfe', width: 160, verticalAlign: 'top', whiteSpace: 'nowrap' }}>{kv.name}</td>
                          <td style={{ padding: '3px 8px', color: '#d4d4d4', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{kv.value === '' ? <span style={{ color: '#666' }}>(없음)</span> : kv.value}</td>
                        </tr>
                      ))
                    ) : (
                      ['SQL', 'Wait', 'Timeout', '시간/세션', '연결', '기타'].map(group => {
                        const idxs = cols.map((c, i) => ({ c, i })).filter(x => grp(x.c) === group);
                        if (idxs.length === 0) return null;
                        return (
                          <React.Fragment key={group}>
                            <tr><td colSpan={2} style={{ padding: '3px 8px', color: '#dcdcaa', background: '#2a2a2a', fontWeight: 700, borderBottom: '1px solid #3f3f46' }}>{group}</td></tr>
                            {idxs.map(({ c, i }) => (
                              <tr key={i} style={{ borderBottom: '1px solid #2a2a2a' }}>
                                <td style={{ padding: '3px 8px 3px 18px', color: '#9cdcfe', width: 220, verticalAlign: 'top', whiteSpace: 'nowrap' }}>{c}</td>
                                <td style={{ padding: '3px 8px', color: '#d4d4d4', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{sel[i] == null ? <span style={{ color: '#666' }}>(null)</span> : String(sel[i])}</td>
                              </tr>
                            ))}
                          </React.Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
        body = (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {grid}
            {detailPane}
          </div>
        );
      }
      return <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>{toolbar}{body}</div>;
    }
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
    if (sub === 'er' && isTableLike) return renderER();
    if (sub === 'columns' && objKind === 'index') {
      if (detail === undefined) return <div style={{ padding: 12, color: '#888' }}>로딩...</div>;
      const d: any = detail || {};
      const cols = (d.columns || []) as ({ name: string; sortOrder?: 'A' | 'D' } | string)[];
      if (!d.table && cols.length === 0) return <div style={{ padding: 12, color: '#666' }}>인덱스 정보 없음</div>;
      if (cols.length === 0) return <div style={{ padding: 12, color: '#666' }}>(없음)</div>;
      const norm = cols.map(c => (typeof c === 'string' ? { name: c, so: 'A' } : { name: c.name, so: c.sortOrder || 'A' }));
      return renderSortableTable(`idxcols:${objName}`, [
        { label: '이름', value: (r: any) => r.name, render: (r: any) => <span style={{ color: '#d4d4d4' }}>{r.name}</span> },
        { label: '컬럼', value: (r: any) => r.name, render: (r: any) => <span style={{ color: '#9cdcfe' }}>{r.name}</span> },
        { label: 'Ascending', align: 'center', value: (r: any) => r.so, render: (r: any) => (r.so === 'D' ? '[   ]' : '[ ✓ ]') },
      ], norm);
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
        return renderSortableTable(`pkg:${kindFilter}:${objName}`, [
          { label, value: (r: any) => r.name, render: (r: any) => <span style={{ color: '#d4d4d4' }}>{r.name}</span> },
          { label: 'Schema Name', value: (r: any) => r.schema, render: (r: any) => <span style={{ color: '#9cdcfe' }}>{r.schema}</span> },
          { label: '패키지', value: (r: any) => r.package, render: (r: any) => <span style={{ color: '#d4d4d4' }}>{r.package}</span> },
          { label: '타입', value: (r: any) => r.type, render: (r: any) => <span style={{ color: '#dcdcaa' }}>{r.type}</span> },
        ], rows);
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
      void th; void td; void tableStyle;
      if (sub === 'datafiles') {
        const cols: string[] = d.dataFileColumns || [];
        const rows: string[][] = d.dataFileRows || [];
        if (!rows.length) return <div style={{ padding: 12, color: '#666' }}>데이터 파일 없음</div>;
        return renderSortableTable(`tbsDatafiles:${objName}`, cols.map((c, ci) => ({
          label: c, value: (r: string[]) => (r[ci] || '').toString(),
          render: (r: string[]) => <span style={{ color: ci === 0 ? '#d4d4d4' : '#9cdcfe' }}>{(r[ci] || '').toString()}</span>,
        })), rows);
      }
      if (sub === 'tbsTables') {
        const rows = d.tables || [];
        if (!rows.length) return <div style={{ padding: 12, color: '#666' }}>테이블 없음</div>;
        return renderSortableTable(`tbsTables:${objName}`, [
          { label: 'Schema', value: (r: any) => r.schema, render: (r: any) => <span style={{ color: '#9cdcfe' }}>{r.schema}</span> },
          { label: 'Table', value: (r: any) => r.table, render: (r: any) => <span style={{ color: '#d4d4d4' }}>{r.table}</span> },
          { label: 'Partition', value: (r: any) => r.partition || '', render: (r: any) => <span style={{ color: '#888' }}>{r.partition || ''}</span> },
        ], rows);
      }
      if (sub === 'tbsIndexes') {
        const rows = d.indexes || [];
        if (!rows.length) return <div style={{ padding: 12, color: '#666' }}>인덱스 없음</div>;
        return renderSortableTable(`tbsIndexes:${objName}`, [
          { label: 'Schema', value: (r: any) => r.schema, render: (r: any) => <span style={{ color: '#9cdcfe' }}>{r.schema}</span> },
          { label: 'Index', value: (r: any) => r.index, render: (r: any) => <span style={{ color: '#d4d4d4' }}>{r.index}</span> },
          { label: 'Partition', value: (r: any) => r.partition || '', render: (r: any) => <span style={{ color: '#888' }}>{r.partition || ''}</span> },
          { label: 'Table Schema', value: (r: any) => r.tableSchema, render: (r: any) => <span style={{ color: '#9cdcfe' }}>{r.tableSchema}</span> },
          { label: 'Table', value: (r: any) => r.table, render: (r: any) => <span style={{ color: '#d4d4d4' }}>{r.table}</span> },
        ], rows);
      }
    }
    // Replication: properties / 이중화 대상(SYS_REPL_ITEMS_) / 원격 호스트(SYS_REPL_HOSTS_)
    if (objKind === 'replication') {
      if (detail === undefined) return <div style={{ padding: 12, color: '#888' }}>로딩...</div>;
      const d: any = detail || {};
      const th: React.CSSProperties = { padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #3f3f46' };
      const td: React.CSSProperties = { padding: '3px 8px' };
      const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontFamily: 'monospace', fontSize: 12 };
      if (sub === 'properties') {
        const props: Record<string, string> = d.properties || {};
        const keys = Object.keys(props);
        // 빈 상태일 때도 진단 정보 표시 — 사용자가 무엇이 안 되는지 확인 가능.
        return (
          <div>
            <table style={tableStyle}>
              <thead><tr style={{ background: '#2d2d2d', color: '#9cdcfe' }}><th style={{ ...th, width: 220 }}>속성</th><th style={th}>값</th></tr></thead>
              <tbody>
                {/* 항상 보이는 헤더 정보 */}
                <tr style={{ background: '#1e1e1e' }}>
                  <td style={{ ...td, color: '#dcdcaa' }}>REPLICATION_NAME</td>
                  <td style={{ ...td, color: '#9cdcfe' }}>{objName}</td>
                </tr>
                {keys.length === 0 ? (
                  <tr style={{ background: '#222' }}>
                    <td style={{ ...td, color: '#e0a060' }}>(no data)</td>
                    <td style={{ ...td, color: '#888' }}>SYS_REPLICATIONS_ 조회 결과 비어있음 — 권한/뷰 확인</td>
                  </tr>
                ) : keys.map((k, i) => (
                  <tr key={k} style={{ background: (i + 1) % 2 ? '#222' : '#1e1e1e' }}>
                    <td style={{ ...td, color: '#dcdcaa' }}>{k}</td>
                    <td style={{ ...td, color: '#d4d4d4', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{props[k]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      if (sub === 'replItems') {
        const rows = d.items || [];
        if (!rows.length) return <div style={{ padding: 12, color: '#666' }}>이중화 대상 없음</div>;
        return (
          <table style={tableStyle}>
            <thead><tr style={{ background: '#2d2d2d', color: '#9cdcfe' }}>
              <th style={th}>Local User</th><th style={th}>Local Table</th><th style={th}>Local Partition</th>
              <th style={th}>Remote User</th><th style={th}>Remote Table</th><th style={th}>Remote Partition</th>
            </tr></thead>
            <tbody>{rows.map((r: any, i: number) => (
              <tr key={i} style={{ background: i % 2 ? '#222' : '#1e1e1e' }}>
                <td style={{ ...td, color: '#9cdcfe' }}>{r.localUser}</td>
                <td style={{ ...td, color: '#d4d4d4' }}>{r.localTable}</td>
                <td style={{ ...td, color: '#888' }}>{r.localPartition || ''}</td>
                <td style={{ ...td, color: '#9cdcfe' }}>{r.remoteUser}</td>
                <td style={{ ...td, color: '#d4d4d4' }}>{r.remoteTable}</td>
                <td style={{ ...td, color: '#888' }}>{r.remotePartition || ''}</td>
              </tr>
            ))}</tbody>
          </table>
        );
      }
      if (sub === 'replHosts') {
        const rows = d.hosts || [];
        if (!rows.length) return <div style={{ padding: 12, color: '#666' }}>원격 호스트 없음</div>;
        return (
          <table style={tableStyle}>
            <thead><tr style={{ background: '#2d2d2d', color: '#9cdcfe' }}>
              <th style={th}>Host No</th><th style={th}>IP</th><th style={th}>Port</th><th style={th}>Conn Type</th>
            </tr></thead>
            <tbody>{rows.map((r: any, i: number) => (
              <tr key={i} style={{ background: i % 2 ? '#222' : '#1e1e1e' }}>
                <td style={{ ...td, color: '#888' }}>{r.hostNo}</td>
                <td style={{ ...td, color: '#d4d4d4' }}>{r.ip}</td>
                <td style={{ ...td, color: '#dcdcaa' }}>{r.port}</td>
                <td style={{ ...td, color: '#9cdcfe' }}>{r.connType}</td>
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
    <div style={{ flex: '1 1 0', minHeight: 200, borderBottom: '1px solid #333', display: 'flex', flexDirection: 'column', background: '#1e1e1e', overflow: 'hidden' }}>
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
