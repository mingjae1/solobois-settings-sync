# Changelog

All notable user-facing changes to Soloboi's Settings Sync are documented here.

## [Unreleased]

_Add changes for the next release here._

<details>
<summary>한국어 (요약)</summary>

_다음 릴리즈에 포함될 변경사항을 여기에 작성하세요._

</details>

---
## [1.2.0] - 2026-04-14

### Added
- File manager picker commands:
  - `soloboisSettingsSync.pickUserDataDir`
  - `soloboisSettingsSync.pickExtensionsDir`
  - `soloboisSettingsSync.pickAdditionalFiles`
- Sidebar Help shortcuts for the new picker commands.
- code-server fallback for extensions path: `~/.local/share/code-server/extensions`.
- Smoke-test coverage for public-share masking behavior.

### Changed
- Removed Playwright-based end-user commands from the extension surface:
  - `captureMarketplaceScreenshot`
  - `importWebSnippet`
- README rewritten to a user-first structure (Installation, Quick Start, Commands, Settings, Troubleshooting).

---
## [1.1.9] - 2026-04-08

### Added
- Private extension sync with gist-embedded VSIX payload (Tier 1).
- Docker environment info command (shows active paths/strategy).
- `pathStrategy` setting (`auto` / `docker` / `standard`).

### Fixed
- Docker/container path selection reliability improvements.
- code-server CLI install fallback improvements.
- Encoding/notification display fixes on some systems.

## [1.1.8] - 2026-04-03

### Added
- Local vs Remote diff view and sync preview.
- Share settings flow with sensitive value masking.
- Profile-based sync and private extension registry commands.

## [1.0.16] - 2026-03-23

### Added
- Conflict-safe startup sync.
- Authoritative download mode.
- Default secret-pattern filtering for ignored settings.

## [1.0.15] - 2026-03-16

### Added
- VS Code compatibility and profile management.

## [1.0.14] - 2026-03-05

### Added
- Initial release (gist sync, settings/keybindings/snippets/extensions, history, status bar).
