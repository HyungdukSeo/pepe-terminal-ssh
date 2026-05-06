PePe Terminal — Bundled X Server
=================================

이 폴더에 VcXsrv portable 바이너리를 풀어 놓으세요.

다운로드:
  https://sourceforge.net/projects/vcxsrv/

방법:
  1. VcXsrv 인스톨러 (.exe) 다운로드
  2. 7zip 등으로 인스톨러 압축 해제 (또는 임시 디렉터리에 일반 설치 후 파일 복사)
  3. 다음 파일/폴더들을 이 폴더(resources/x11-server/)에 복사:
       - vcxsrv.exe
       - 모든 .dll 파일 (xkbcomp.exe, libcrypto-*.dll 등 동봉된 것 전부)
       - fonts/ 폴더 (있으면)
       - locale/ 폴더 (있으면)
       - bitmaps/ 폴더 (있으면)

빌드 시 electron-builder 가 이 폴더를 자동으로 패키징합니다
(extraResources 설정 → 설치된 앱의 resources/x11-server/ 로 복사).

미설치 상태로 빌드해도 빌드 자체는 성공합니다 — 다만 X11 forwarding 시
내장 X 서버 (제한적 호환) 로 fallback 됩니다.

크기 참고: VcXsrv full 패키지 약 5~10MB.
