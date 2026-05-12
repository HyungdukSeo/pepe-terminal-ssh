# OpenVPN Windows 바이너리 번들 (개발자용 — 1회 작업)

이 폴더에 OpenVPN community 바이너리와 의존 DLL 을 배치하면 `npm run build` 가
PePe 인스톨러 안에 자동 포함시킵니다.

**최종 사용자는 손댈 게 없습니다** — PePe 인스톨러만 설치하면 VPN 기능이 바로
동작합니다. 별도 OpenVPN 설치, TAP/Wintun 드라이버 설치, 환경변수 설정 모두
불필요. (Wintun 은 userspace DLL 이라 그냥 같이 들어있기만 하면 됨)

---

## 1회 설정 (5분)

### 1) OpenVPN community Windows 다운로드

https://openvpn.net/community-downloads/ 에서 **2.6.x 64-bit MSI** 또는 EXE installer 받기
(예: `OpenVPN-2.6.13-I001-amd64.msi`)

### 2) 로컬에 임시 설치

기본 경로(`C:\Program Files\OpenVPN`)에 설치. 설치 후 즉시 제거해도 무방
(파일은 이 폴더로 복사한 뒤니까).

### 3) 다음 파일을 이 폴더 (`resources/openvpn-win/`) 에 복사

`C:\Program Files\OpenVPN\bin\` 에서 **실제로 존재하는 파일만**:

| 파일 | OpenVPN 2.6 | OpenVPN 2.7+ | 설명 |
|---|---|---|---|
| `openvpn.exe` | 필수 | 필수 | 메인 실행 파일 |
| `libssl-3-x64.dll` | 필수 | 필수 | OpenSSL 3 (TLS) |
| `libcrypto-3-x64.dll` | 필수 | 필수 | OpenSSL 3 (crypto) |
| `libpkcs11-helper-1.dll` | 필수 | 필수 | PKCS#11 인증서 지원 |
| `wintun.dll` | 필수 | ❌ 제거됨 | 2.6 까지 Wintun 드라이버. 2.7 부터 ovpn-dco 로 대체되어 미동봉 |
| `liblzo2-2.dll` | 동적 링크 | 정적 링크 (보통) | 2.7 빌드에 따라 다름. 없으면 그냥 패스 |

**중요**: `wintun.dll` 이나 `liblzo2-2.dll` 이 설치 폴더에 없다고 외부에서 받지 마세요.
ABI 미스매치로 openvpn 이 비정상 동작합니다. 설치 폴더에 있는 파일만 동봉.

OpenVPN 빌드에 따라 추가로 필요할 수 있는 파일:
- `libxxhash.dll`
- `vcruntime140.dll` / `vcruntime140_1.dll` / `msvcp140.dll` (이미 시스템에 있을 가능성 큼)

복사가 끝나면 폴더 구조:

```
resources/openvpn-win/
├── README.md
├── openvpn.exe
├── wintun.dll
├── libssl-3-x64.dll
├── libcrypto-3-x64.dll
├── liblzo2-2.dll
└── libpkcs11-helper-1.dll
```

### 4) 검증

```
node scripts/verify-openvpn-bundle.js
```

필수 파일 누락 시 어떤 파일이 빠졌는지 알려줍니다. 통과하면 `npm run build` 진행.

---

## 라이선스 (재배포 의무)

OpenVPN community 2.x 는 GPLv2. PePe 인스톨러로 재배포하려면:

1. **소스 링크 표기** — PePe의 About / README 에 `https://github.com/OpenVPN/openvpn`
   링크 추가 (GPLv2 §3 의무)
2. **PePe 본체는 GPL 감염 없음** — 별도 프로세스로 spawn 하므로 PePe 코드의
   라이선스(MIT/proprietary) 유지 가능 (LGPL/GPL 의 "프로세스 경계" 해석)
3. **Wintun** 은 BSD-style 라이선스로 표기 의무 가벼움

---

## 동작 원리

- PePe (Electron 일반 권한) 가 `sudo-prompt` 로 admin 권한 spawn:
  `openvpn.exe --config user.ovpn --management 127.0.0.1 <port> ...`
- openvpn.exe 가 admin 으로 실행되며 `wintun.dll` 을 동적 로드 → 가상 어댑터 생성
- PePe 는 일반 권한으로 `127.0.0.1:<port>` 에 TCP 접속 → state/log/bytecount 스트리밍
- 권한 경계가 깔끔하게 분리됨 (PePe 본체 일반 권한 유지)
