# Changelog

All notable changes to Soloboi's Settings Sync are documented here.

---

## [1.1.1] - 2026-04-02

### Added
- **Sync Preview / Diff**: Preview changes before applying downloads (`soloboisSettingsSync.syncPreview`) and compare local vs remote without applying (`soloboisSettingsSync.showLocalVsRemoteDiff`).
- **Gist Trust Gate** (`soloboisSettingsSync.gistTrust`): Extension install/uninstall is blocked for untrusted Gists (Gists not owned by the currently logged-in GitHub account) unless explicitly marked as trusted.
- **Custom Marketplace Manager**: Register multiple OpenVSX-compatible marketplaces and define fallback scan order (`addMarketplace`, `removeMarketplace`, `reorderMarketplace`).
- **Custom Marketplace Update Check**: Check and install extension updates from custom marketplaces (`checkCustomMarketplaceUpdates`), with optional auto-update (`customMarketplaceAutoUpdate`) and optional startup checks (`customMarketplaceUpdateCheck`).
- **Private Extensions Helper**: Register private/unlisted extensions with optional VSIX URL and notes for guided installs during sync (`registerPrivateExtension`, `privateExtensions`).
- **Public Gist Toggle**: Toggle whether newly created sync Gists should be Public or Private (Secret) (`togglePublicGist`, `publicGist`).
- **Auto-Sync Master Toggle**: Added `soloboisSettingsSync.autoSync` to control startup sync and auto-upload watchers in one place.

<details>
<summary>한국어 (요약)</summary>

- 미리보기/Diff + 로컬 vs 원격 비교
- Gist 신뢰도 게이트로 익스텐션 설치/삭제 보호
- 커스텀 마켓플레이스 등록/우선순위 + 업데이트 확인/설치
- Private 익스텐션(VSIX URL/메모) 등록 지원
- Public Gist 토글, `autoSync` 마스터 토글 추가

</details>

---

## [1.0.16] - 2026-03-23

### Added
- **Smart Extension Removal**: Uninstalling an extension now automatically prevents it from being reinstalled on the next sync. No extra steps needed — the extension tracks your intent silently.
- **Auto-ignore on Uninstall**: When an extension is removed, its contributed settings keys are automatically added to `ignoredSettings` so they no longer pollute synced configurations.
- **Marketplace Health Check** (`soloboisSettingsSync.checkExtensionHealth`): Scans all extensions in your sync list against the VS Code Marketplace and reports any that are missing or deprecated.
- **Settings E2E Test** (`soloboisSettingsSync.runSettingsE2ETest`): Launches an isolated VS Code instance with your current settings to detect errors before they reach other devices.
- **Conflict-Safe Startup Sync**: On startup, if local changes are newer than the remote Gist, local state is uploaded first instead of being overwritten.
- **Authoritative Download Mode** (`soloboisSettingsSync.authoritativeDownload`): When enabled, remote settings are applied as the strict source of truth — local keys absent in the remote are removed.
- **Default Secret Key Filters**: `ignoredSettings` now ships with common secret-key patterns (`*token*`, `*secret*`, `*password*`, `*apikey*`, `*api_key*`) to prevent accidental credential sync.

### Improved
- **Extension Install Reliability**: VS Code's built-in install API is now tried first; CLI (`code --install-extension`) is used only as a fallback, fixing install failures on Antigravity and non-standard environments.
- **Gist API Robustness**: Added request timeout (15s), automatic retry with backoff (up to 2 retries) for network errors and rate limits, and pagination support for users with large Gist collections (up to 500 Gists).
- **Stale Gist File Cleanup**: Files removed from a sync profile are now automatically deleted from the Gist on the next upload, keeping the remote clean.
- **Auto-upload Race Condition Fix**: Downloads now suppress auto-upload triggers for a brief window after applying remote changes, preventing unnecessary upload/download loops.
- **Extension Change Detection**: Auto-upload on extension install/uninstall now correctly diffs the before/after snapshot, avoiding false triggers.

<details>
<summary>한국어 (요약)</summary>

- 익스텐션 제거 의도 추적 + 설정 키 자동 ignore
- 마켓 헬스체크 + 격리 E2E 테스트 추가
- 시작 시 충돌 방지(로컬이 최신이면 선업로드)
- 다운로드 권한 모드 + 기본 시크릿 패턴 필터
- 설치/Gist API/정리/레이스 컨디션 안정화

</details>

---

## [1.0.15] - 2026-03-16

### Added
- VS Code compatibility (previously Antigravity-only).
- Profile management: save and switch between multiple sync profiles, each with its own Gist ID and ignore rules.
- Configurable ignored settings and extensions per profile.
- Cross-platform filtering: `antigravity.*` settings and Antigravity-only files are skipped when syncing to VS Code.

<details>
<summary>한국어 (요약)</summary>

- VS Code 호환 추가
- 다중 프로필(각각 Gist/무시 규칙) 지원
- 프로필별 ignored settings/extensions 지원
- VS Code로 동기화 시 Antigravity 전용 항목 제외

</details>

---

## [1.0.14] - 2026-03-05

### Added
- Initial release with core sync functionality.
- GitHub Gist integration via VS Code's built-in GitHub authentication (no PAT required).
- Sync for `settings.json`, `keybindings.json`, user snippets, and extensions list.
- Auto-upload on file change, auto-download on startup.
- Gist history browser with rollback support.
- Ignored items manager UI for settings keys and extension IDs.
- Status bar indicator (idle / uploading / downloading / error).

<details>
<summary>한국어 (요약)</summary>

- 최초 릴리즈: Gist 기반 설정/단축키/스니펫/익스텐션 동기화
- 자동 업/다운 + 히스토리/롤백 + 무시 목록 UI + 상태바

</details>
