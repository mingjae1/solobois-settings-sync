# Changelog

All notable changes to Soloboi's Settings Sync are documented here.

---

## [Unreleased]

_Add changes for the next release here._
---
## [1.1.8] - 2026-04-03

### Added
- Share flow (`shareSettings`) for public settings snapshots with masked sensitive values and instant URL sharing.
- Local vs Remote diff view in VS Code built-in diff editor, plus sync preview before applying.
- Profile-based sync, custom marketplace registry/update checks, and private extension registration/removal.
- Getting Started wizard and dedicated log channel.

### Improved
- Sidebar/action UX reorganized (collapsible groups, clearer tooltips, better command discoverability).
- Startup/download safety (trust gate, conflict-safe startup sync, authoritative download mode).
- Sensitive-data masking coverage and fallback behavior on parse failure.

### Changed
- `setGistId` now accepts both Gist ID and full Gist URL.
- README was redesigned as a landing-first guide (share/sync quick start first).
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
---

## [1.0.15] - 2026-03-16

### Added
- VS Code compatibility (previously Antigravity-only).
- Profile management: save and switch between multiple sync profiles, each with its own Gist ID and ignore rules.
- Configurable ignored settings and extensions per profile.
- Cross-platform filtering: `antigravity.*` settings and Antigravity-only files are skipped when syncing to VS Code.
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

