# PePe Terminal(SSH) v2.1.4 릴리즈 노트

> 이번 릴리즈는 **DBeaver 수준의 SQL Tool**을 새로 구축하고, 터미널·파일전송·AI Chat 전반의 **성능과 안정성**을 끌어올린 대형 업데이트입니다.

---

## 🗄️ SQL Tool — DBeaver 수준으로 전면 강화

### 아키텍처
- **JDBC 사이드카 구조**로 전환 — Java 프로세스가 JSON-RPC로 실제 JDBC 드라이버를 구동
- **SSH 터널(local port forwarding)** 지원 — DB가 내부망에 있어도 같은 세션의 SSH 터널로 접속
- **JDBC 드라이버 관리자** (DBeaver 스타일) — Maven 좌표 기본 제공, JAR/폴더/아티팩트 추가, 다운로드, 드라이버 복제, 실제 경로 표시
- 다중 DBMS: **Altibase / Oracle / MySQL / MariaDB / PostgreSQL / MSSQL / SQLite**

### 스키마 브라우저 & 객체 상세
- DBeaver 스타일 트리: 스키마 > 객체 그룹 > 객체 > 컬럼, **저장소(테이블스페이스)**, **Global metadata**(Public/User 시노님·이중화 객체)
- 객체 상세 패널: 컬럼/제약조건/외래키/인덱스/참조/트리거/DDL, 뷰 Definition, 프로시저·함수·패키지·트리거·시퀀스·인덱스·테이블스페이스 상세
- **엔티티 관계도(ER 다이어그램)** — 중앙 테이블 + 참조 부모/자식, PK/FK 마커, 관계선
- **관리(Administer) / 시스템 정보(System Info)** 노드 — DBMS별 세션 관리자·상태·변수·엔진·권한 등, 행 선택 시 **마스터-디테일**(SQL 전문 + Name/Value 상세)
  - Altibase 세션 관리자/Properties/Module Memory Usage는 DBeaver 원본 쿼리·표시와 동기화
- **모든 상세 그리드 헤더 클릭 정렬**, 테이블/테이블스페이스 **사이즈 게이지 바**

### 편집 & 실행
- **PK 기반 인라인 데이터 편집** + 네이티브 트랜잭션(commit/rollback), 타입별 리터럴 변환(DATE 등)
- 행 추가/삭제/복제/취소, 선택 행 데이터 추출(파일/이미지), Result Set Fetch Size
- **실행 계획(EXPLAIN PLAN) 뷰어** — DBeaver 스타일 트리(펼침/접기)
- AI 자동 생성(Claude/Gemini/Codex 선택), 즐겨찾기/저장 쿼리, SQL 포맷, 단축키

---

## 🔌 SQL Tool 연결 안정화 (이번 빌드)
- **Keep-alive(60초)** — 유휴 시 가벼운 검증으로 DB/SSH 터널 idle timeout 끊김 방지
- **exec 자동 복구** — 연결 끊김류 오류 시 1회 자동 재연결 후 재시도
- **자동 연결 1회 제한** — 실패 시 무한 재시도 루프(상태 깜빡임) 제거
- **연결 상태 컬러 배지**(연결 중 / 연결됨 / 연결 안됨) + **↻ 재연결 버튼**

---

## ⚡ 성능 개선
- **장시간 사용 시 느려짐 해소** — 터미널 출력마다 찍히던 디버그 로그(`[PTY-IN]`/`[REFIT]`/`[DOFIT]`/`[SCHED-RESIZE]`) 제거(콘솔 버퍼 상시 누적 주범)
- **프리즘 커서** — 숨겨진 패널은 갱신 스킵 + 주기 완화로 상시 재그리기 비용 대폭 절감
- **AI Chat 스트리밍** — 스트리밍 중에는 평문 렌더(마크다운 재파싱 회피) → AI 응답 중 터미널 입력 지연 완화
- **파일 전송 속도 개선** — AES-NI 가속 GCM 암호 우선, SFTP 파이프라인 윈도우 확대(8MB), 압축 비활성
- 메인 프로세스 진단 로그는 **개발 모드 전용**(패키지 빌드에서 무출력)

---

## 🖥️ 터미널 / 파일전송 / UX
- 파일전송 탭이 **활성 SSH 세션의 현재 경로(pwd)** 로 열림
- vi 등에서 **backspace 키 시퀀스가 연결 즉시 적용**
- **키 시퀀스 기본값**: Delete = `VT220 Del (Esc[3~)`, Backspace = `Backspace (Ctrl+H)` — 기존 세션에도 일괄 적용
- 모양 > **파워 커서**일 때 벨(backspace 막힘 등) 발생 시 **화면 흔들림** 효과
- 에디터 탭 **마우스 휠(가운데) 클릭으로 닫기**
- 깜빡임 제거: 조회 결과 그리드(원자적 교체), 실행 버튼 영역(180ms 지연 표시)

---

## 🐛 버그 수정
- **MySQL 인덱스 상세** — 모든 테이블의 PK가 `PRIMARY`로 동일해 동명 인덱스 컬럼이 뒤섞이던 문제 (TABLE_NAME 필터)
- **Mermaid 렌더 실패** — 한글 라벨/특수문자 보호
- **MSSQL 인증** — DLL Maven 좌표로 수정
- 알림창(alert/confirm) → **모달**로 전면 교체

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
