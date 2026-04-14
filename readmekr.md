# Soloboi's Settings Sync (한국어)

VS Code/Antigravity 설정을 GitHub Gist로 백업, 동기화, 공유할 수 있는 확장입니다.

[![VS Marketplace Version](https://vsmarketplacebadges.dev/version/soloboi.solobois-settings-sync.svg?style=for-the-badge)](https://marketplace.visualstudio.com/items?itemName=soloboi.solobois-settings-sync)
[![VS Marketplace Installs](https://vsmarketplacebadges.dev/installs/soloboi.solobois-settings-sync.svg?style=for-the-badge)](https://marketplace.visualstudio.com/items?itemName=soloboi.solobois-settings-sync)
[![VS Marketplace Rating](https://vsmarketplacebadges.dev/rating/soloboi.solobois-settings-sync.svg?style=for-the-badge)](https://marketplace.visualstudio.com/items?itemName=soloboi.solobois-settings-sync&ssr=false#review-details)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/soloboi/solobois-settings-sync?style=for-the-badge&label=Open%20VSX%20Downloads)](https://open-vsx.org/extension/soloboi/solobois-settings-sync)
[![GitHub Stars](https://img.shields.io/github/stars/mingjae1/solobois-settings-sync?style=for-the-badge&label=GitHub%20Stars)](https://github.com/mingjae1/solobois-settings-sync/stargazers)
[![GitHub License](https://img.shields.io/github/license/mingjae1/solobois-settings-sync?style=for-the-badge)](https://github.com/mingjae1/solobois-settings-sync/blob/main/LICENSE.md)

## 왜 쓰면 좋은가요?
- 여러 PC/노트북에서 같은 개발 환경을 빠르게 맞출 수 있습니다.
- 설정 변경 이력을 확인하고, 필요하면 이전 상태로 복원할 수 있습니다.
- 공유용 스냅샷 링크를 만들어 팀/커뮤니티에 배포하기 쉽습니다.

## 빠른 시작 (3분)
1. `Soloboi's Settings Sync: Login to GitHub`
2. `Soloboi's Settings Sync: Upload Settings to Gist`
3. 다른 기기에서 `Soloboi's Settings Sync: Set Gist ID`
4. `Soloboi's Settings Sync: Download Settings from Gist`

## 사이드바로 쓰기
- Activity Bar에서 `Soloboi's Settings Sync` 아이콘을 열면 기능이 섹션별로 정리됩니다.
- `Sync`: Upload / Download / Sync Now / Diff / Share
- `Profile & Gist`: Gist 공개/비공개 토글, Gist ID 설정, 프로필 전환, 히스토리 복원
- `Private Extensions`: 등록/자동감지/VSIX 업로드
- `Filters`: 제외할 확장/설정 키 관리
- `Experiments`: Docker 경로 진단, 마켓플레이스 상태 점검, 설정 E2E 테스트
- `Help`: Getting Started, 설정 열기, 경로 선택, 저장소/이슈, 로그 보기

<details>
<summary>자세히 보기: 사용자 매뉴얼</summary>

### 일상 동기화
- 권장 커맨드: `soloboisSettingsSync.syncNow`
- 다운로드(충돌 확인) 후 업로드 순서로 처리해 덮어쓰기 실수를 줄입니다.

### 백업/복원
- 백업: `soloboisSettingsSync.uploadNow`
- 복원: `soloboisSettingsSync.downloadNow`
- 이력 복원: `soloboisSettingsSync.showHistory`

### 세팅 공유 (홍보/배포)
- 커맨드: `soloboisSettingsSync.shareSettings`
- 공개/언리스트 Gist 링크를 생성해 공유할 수 있습니다.
- 공유 시 민감 정보 마스킹 스냅샷 기반으로 배포할 수 있습니다.

### 프로필 & Gist 운영
- 여러 프로필별로 `gistId`, `ignoredSettings`, `ignoredExtensions`를 분리 저장할 수 있습니다.
- 사이드바에서 기존 Sync Gist 목록을 바로 선택해 활성 Gist를 바꿀 수 있습니다.
- 신규 Gist 생성 시 Public/Private 기본값을 토글할 수 있습니다.

### Private Extension 관리
- 등록/해제: `registerPrivateExtension`, `removePrivateExtension`
- 자동 감지: `autoDetectPrivateExtensions`
- VSIX 포함 업로드: `uploadPrivateVsixToGist`

### 고급 동기화 옵션 (설정)
- `syncPreview`: 적용 전 변경 요약 미리보기
- `gistTrust`: 신뢰되지 않은 Gist의 확장 설치/제거 차단
- `authoritativeDownload`: 원격 `settings.json`을 기준으로 로컬 불필요 키 제거
- `removeExtensions`: 원격 목록에 없는 로컬 확장 자동 제거
- `syncAntigravityConfig`: Antigravity 전용 설정 파일 동기화
- `additionalFiles`: 임의 파일을 추가 동기화 대상으로 포함

### 자주 쓰는 커맨드
- `soloboisSettingsSync.syncNow`
- `soloboisSettingsSync.uploadNow`
- `soloboisSettingsSync.downloadNow`
- `soloboisSettingsSync.showLocalVsRemoteDiff`
- `soloboisSettingsSync.showHistory`
- `soloboisSettingsSync.shareSettings`

### 권장 설정
```json
{
  "soloboisSettingsSync.autoSync": true,
  "soloboisSettingsSync.autoSyncOnStartup": true,
  "soloboisSettingsSync.autoUploadOnChange": true,
  "soloboisSettingsSync.pathStrategy": "auto"
}
```

</details>

<details>
<summary>자세히 보기: 공유/홍보 운영 팁</summary>

- 개인 백업용 Gist와 공개 공유용 Gist를 분리하면 운영이 안정적입니다.
- 공유 전에는 `showLocalVsRemoteDiff`로 노출 항목을 마지막 확인하세요.
- 팀 온보딩 문서에 "설치 링크 + Gist 링크 + 적용 순서"를 같이 적어두면 재현성이 올라갑니다.

</details>

## 문서 언어 전환
- [English Docs](./readmeen.md)
- [Root README](./README.md)

## Changelog
릴리즈 노트는 [CHANGELOG.md](./CHANGELOG.md)에서 확인할 수 있습니다.
