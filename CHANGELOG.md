# Changelog

All notable changes to Soloboi's Settings Sync are documented here.

---

## [Unreleased]

### Added
- `setGistId` now accepts both raw Gist IDs and full Gist URLs, then normalizes/stores the extracted ID automatically.

### Changed
- README was reorganized into a landing-style layout: quick share/sync onboarding is shown first, while detailed commands/settings are moved into collapsible sections.

<details>
<summary>한국어 (요약)</summary>

- `setGistId`에서 Gist ID뿐 아니라 Gist URL도 입력받아 자동으로 ID를 추출/저장합니다.
- README를 랜딩 페이지 스타일로 재구성했습니다. 상단에는 빠른 공유/동기화만 노출하고, 상세 명령/설정은 접이식으로 정리했습니다.

</details>

---
## [1.1.6] - 2026-04-03

### Fixed
- `publish.bat` argument parsing is now order-independent. Running options in different order (for example, `--no-pause --no-bump`) no longer causes unintended version bumps.
- `publish.bat` default behavior is now explicit: publish current version without bump unless a bump flag is provided.
- Added clear bump flags to `publish.bat`: `--bump-patch`, `--bump-minor`, `--bump-major`.

<details>
<summary>한국어 (요약)</summary>

- `publish.bat` 인자 파싱을 순서 독립으로 수정해 `--no-pause --no-bump` 순서에서도 의도치 않은 버전 증가가 발생하지 않습니다.
- `publish.bat` 기본 동작을 명시적으로 현재 버전 배포(버전 bump 없음)로 통일했습니다.
- 버전 증가 옵션을 명시 플래그로 추가했습니다: `--bump-patch`, `--bump-minor`, `--bump-major`.

</details>

---

---
## [1.1.4] - 2026-04-03

<details>
<summary>한국어 (요약)</summary>



</details>

---

---
## [1.1.3] - 2026-04-03

### Added
- **View Local vs Remote Diff** now opens VS Code's built-in diff editor instead of the Output panel. Settings, keybindings, and extensions are each shown as a side-by-side colored diff (`Remote (Gist) ↔ Local`).
- **Share Your Settings**: Create a public Gist snapshot of your current settings (secrets auto-masked), copy the shareable URL, and rename or revisit previously shared Gists — all from the sidebar or Command Palette.
- **Remove Private Extension**: Each registered private extension in the sidebar now has a click-to-remove action.

### Improved
- Custom Marketplace entries now show an explicit "🗑 Click to remove" note in their tooltip.

<details>
<summary>한국어 (요약)</summary>

- Diff 뷰: Output 탭 → VS Code 내장 diff 에디터 (파일별 side-by-side)
- Share Your Settings: 공개 Gist 스냅샷 생성 + URL 복사 + 이름 변경
- Private Extension 삭제 트리거 추가
- 커스텀 마켓플레이스 항목 삭제 안내 tooltip 개선

</details>

---

## [1.1.2] - 2026-04-03

### Added
- **Collapsible Sidebar Sections**: The activity bar panel is now organized into collapsible groups — Sync, Gist, Settings, Custom Marketplace, Private Extensions, Filters, Help. Keeps the panel clean and lets you focus on what you need.
- **Sensitive Data Guard**: Unified masking engine with level-aware redaction (`private` / `public`). Covers 18 key patterns and 7 value patterns (GitHub PAT, AWS key, OpenAI key, Slack token, DB connection strings). Applied to keybindings and snippets on upload.
- **Marketplace Manager**: Register multiple OpenVSX-compatible marketplaces by domain key. Define fallback scan order — the first marketplace that has the extension wins.
- **Custom Marketplace Update Checker**: Checks installed extensions against registered custom marketplaces for newer versions (semver). Supports optional auto-update on startup or on-demand via sidebar.
- **Private Extension Sync MVP**: Register private/unlisted extensions with optional VSIX URL for auto-install, or get local path guidance when no URL is provided. Detected automatically during download for unknown extensions.
- **Getting Started Wizard**: Step-by-step setup flow for new users (login → gist → first sync).
- **Separate Log Channel**: Extension activity logs are now in a dedicated channel, keeping the main output panel clean for sync reports.

### Improved
- **Sync Now tooltip**: Now explains why it differs from doing Upload + Download separately — remote is fetched first to prevent overwriting, and upload is blocked if download fails.
- **Show History** moved into the Gist section for better discoverability alongside Set Gist ID and Switch Profile.
- **JSONC parse failure fallback**: If `settings.json` cannot be parsed (e.g. contains syntax errors), sensitive values are still redacted before any content is returned.

<details>
<summary>한국어 (요약)</summary>

- 사이드바 섹션 접기/펼치기 (Sync / Gist / Settings / 마켓플레이스 / Private / 필터 / Help)
- 민감정보 통합 마스킹 엔진 (키패턴 18개 + 값패턴 7개, 레벨별 적용)
- 커스텀 마켓플레이스 도메인 키 레지스트리 + 스캔 순서 관리
- 커스텀 마켓 업데이트 확인 + VSIX 자동 설치
- Private 익스텐션 등록 + 다운로드 시 자동 감지/안내
- Getting Started 마법사, 별도 로그 채널 분리
- Sync Now 동작 설명 툴팁 개선, Show History 위치 이동

</details>

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
