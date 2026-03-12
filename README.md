# Soloboi's Settings Sync for Antigravity 🚀

Version | Installs | Rating | OpenVSX | Downloads
--- | --- | --- | --- | ---
[![Version](https://img.shields.io/visual-studio-marketplace/v/soloboi.solobois-settings-sync.svg)](https://marketplace.visualstudio.com/items?itemName=soloboi.solobois-settings-sync) | [![Installs](https://img.shields.io/visual-studio-marketplace/i/soloboi.solobois-settings-sync.svg)](https://marketplace.visualstudio.com/items?itemName=soloboi.solobois-settings-sync) | [![Rating](https://img.shields.io/visual-studio-marketplace/r/soloboi.solobois-settings-sync.svg)](https://marketplace.visualstudio.com/items?itemName=soloboi.solobois-settings-sync) | [![Open VSX](https://img.shields.io/open-vsx/v/soloboi/solobois-settings-sync.svg)](https://open-vsx.org/extension/soloboi/solobois-settings-sync) | [![Downloads](https://img.shields.io/open-vsx/dt/soloboi/solobois-settings-sync.svg)](https://open-vsx.org/extension/soloboi/solobois-settings-sync)

Soloboi's Settings Sync is primarily designed for **Antigravity**. It allows you to seamlessly synchronize your settings, keybindings, extensions, and snippets across multiple devices using GitHub Gist.

## Works With

- **Antigravity** (Tested & Recommended)
- VS Code (Compatible)

## Features

- **One-Click Synchronization**: Sync everything with a single command or button.
- **GitHub Gist Integration**: Securely store and version your configurations.
- **Auto-Backup**: Automatically creates local backups before applying remote changes.
- **Selective Sync**: Fine-grained control over which settings to ignore across different machines.
- **Extension Management**: Keep your extension list in sync, with optional auto-cleanup of local-only extensions.
- **Gist History**: Browse and rollback to previous configuration versions.

## Cross-Platform Note (VS Code <-> Antigravity)

- Some settings can be omitted when syncing between VS Code and Antigravity.
- Antigravity is VS Code-based, but Antigravity-only settings may be difficult to apply directly in VS Code.
- Some settings may require manual user edits.
- Omitted settings are shown to the user after sync.

## Commands

Command | Description
--- | ---
`soloboisSettingsSync.login` | Login to GitHub to enable synchronization.
`soloboisSettingsSync.logout` | Logout from GitHub.
`soloboisSettingsSync.syncNow` | Perform a full sync (Upload & Download).
`soloboisSettingsSync.uploadNow` | Manually upload current local settings to Gist.
`soloboisSettingsSync.downloadNow` | Manually download and apply settings from Gist.
`soloboisSettingsSync.showHistory` | Open the history of your settings Gist.

## Settings

Setting | Default | Description
--- | --- | ---
`soloboisSettingsSync.gistId` | `""` | GitHub Gist ID for synchronization. Auto-created on first upload.
`soloboisSettingsSync.autoSyncOnStartup` | `true` | Automatically download and apply settings on startup.
`soloboisSettingsSync.autoUploadOnChange` | `true` | Automatically upload settings when local configuration changes.
`soloboisSettingsSync.autoUploadDelay` | `5000` | Delay (ms) before auto-uploading after a change.
`soloboisSettingsSync.ignoredSettings` | `[]` | List of setting keys (glob patterns) to exclude from sync.
`soloboisSettingsSync.removeExtensions` | `false` | Automatically uninstall extensions not present in the remote list.
`soloboisSettingsSync.publicGist` | `false` | Use Public Gist instead of Secret (Private) for storage.

## Security

- **Private by Default**: All sync Gists are created as Secret (Private) to ensure your settings are not public.
- **Secure Authentication**: Uses VS Code's built-in Authentication Provider; we never touch your password.

## Mirrors

- [GitLab](https://gitlab.com/soloboi/solobois-settings-sync) (Official Mirror)

---

### Happy Coding! 😊

## Soloboi's Settings Sync for Antigravity (한국어) 🚀

Soloboi's Settings Sync는 **Antigravity**를 위해 설계된 익스텐션으로, 여러 기기 간에 설정, 단축키, 익스텐션, 스니펫을 GitHub Gist를 통해 완벽하게 동기화합니다.

## 호환성 (Works With)

- **Antigravity** (권장 및 테스트 완료)
- VS Code (호환)

## 주요 기능

- **원클릭 동기화**: 버튼 하나나 명령어 입력만으로 모든 설정을 동기화합니다.
- **GitHub Gist 통합**: 보안이 강화된 Gist에 설정을 버전별로 저장합니다.
- **자동 백업**: 원격 설정을 적용하기 전에 로컬에 자동 백업을 생성합니다.
- **선택적 동기화**: 기기별로 제외할 설정을 세밀하게 제어할 수 있습니다.
- **익스텐션 관리**: 설치된 익스텐션 목록을 동기화하고, 선택적으로 로컬에만 있는 익스텐션을 자동 삭제합니다.
- **동기화 기록**: Gist 히스토리를 통해 이전 설정 버전으로 되돌릴 수 있습니다.

## VS Code <-> 안티그래비티 연동 안내

- 꼭 VS Code와 안티그래비티 사이의 연동에는 일부 설정값이 누락될 수 있습니다.
- 안티그래비티가 VS Code 기반이지만 안티그래비티만의 설정값은 VS Code에서 적용이 어렵고, 일부 설정값은 사용자가 직접 수정해야합니다.
- 누락된 설정은 동기화 이후 사용자에게 안내됩니다.

## 명령어

명령어 | 설명
--- | ---
`soloboisSettingsSync.login` | 동기화를 위해 GitHub에 로그인합니다.
`soloboisSettingsSync.logout` | GitHub에서 로그아웃합니다.
`soloboisSettingsSync.syncNow` | 전체 동기화(업로드 및 다운로드)를 수행합니다.
`soloboisSettingsSync.uploadNow` | 현재 로컬 설정을 Gist에 수동으로 업로드합니다.
`soloboisSettingsSync.downloadNow` | Gist에서 설정을 수동으로 다운로드하여 적용합니다.
`soloboisSettingsSync.showHistory` | 설정 Gist의 히스토리를 확인합니다.

## 설정

설정과 이름 | 기본값 | 설명
--- | --- | ---
`soloboisSettingsSync.gistId` | `""` | 동기화에 사용할 GitHub Gist ID. 첫 업로드 시 자동 생성됩니다.
`soloboisSettingsSync.autoSyncOnStartup` | `true` | 시작 시 자동으로 설정을 다운로드하고 적용합니다.
`soloboisSettingsSync.autoUploadOnChange` | `true` | 설정 변경 시 자동으로 업로드합니다.
`soloboisSettingsSync.autoUploadDelay` | `5000` | 변경 감지 후 자동 업로드 대기 시간(ms).
`soloboisSettingsSync.ignoredSettings` | `[]` | 동기화에서 제외할 설정 키 목록(glob 패턴 지원).
`soloboisSettingsSync.removeExtensions` | `false` | 원격 목록에 없는 로컬 익스텐션을 자동으로 삭제합니다.
`soloboisSettingsSync.publicGist` | `false` | Gist를 비밀(Secret) 대신 공개(Public)로 생성합니다.

## 보안

- **기본 비밀 설정**: 모든 동기화용 Gist는 기본적으로 비밀(Secret)로 생성되어 안전합니다.
- **안전한 인증**: VS Code의 내장 인증 기능을 사용하며, 사용자의 비밀번호에 절대 접근하지 않습니다.

---