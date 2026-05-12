# OpenVPN macOS 바이너리 번들

이 디렉토리에 OpenVPN 바이너리 + 의존 dylib 를 배치하면 mac 빌드에 포함됩니다.

## 준비 방법

가장 간단한 경로:
1. `brew install openvpn`
2. `brew --prefix openvpn` 으로 설치 경로 확인 (보통 `/opt/homebrew/opt/openvpn` 또는 `/usr/local/opt/openvpn`)
3. `sbin/openvpn` 바이너리 + 의존 dylib (`otool -L openvpn` 로 확인) 를 이 폴더로 복사

또는 Tunnelblick 의 [public OpenVPN binaries](https://tunnelblick.net/cReleases.html) 에서
사전 빌드된 universal binary 추출.

## 권한

macOS 는 root 권한이 필요합니다. PePe 는 sudo-prompt 를 통해 Authorization Services
다이얼로그를 띄워 admin password 를 요청합니다.

## 라이선스

OpenVPN community 는 GPLv2. 재배포 시 소스 링크 표기 필요 — [OpenVPN GitHub](https://github.com/OpenVPN/openvpn).
