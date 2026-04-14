# Changelog

All notable user-facing changes to Soloboi's Settings Sync are documented here.

## [Unreleased]

### Fixed
- Added pre-upload sensitive-content review for sync files, with per-file actions: mask, exclude, keep original, or cancel upload.
- Applied the same sensitive-content review flow to both base sync files and `additionalFiles`.
- In silent uploads, automatically masks detected sensitive content before upload.

<details>
<summary>한국어 (요약)</summary>

- 업로드 전 민감정보 검토 단계를 추가하고 파일별로 `마스킹/제외/원본 유지/업로드 취소`를 선택할 수 있게 했습니다.
- 기본 동기화 파일과 `additionalFiles` 모두에 동일한 민감정보 검토 흐름을 적용했습니다.
- 자동 업로드(silent)에서는 감지된 민감정보를 자동 마스킹 후 업로드하도록 변경했습니다.

</details>

---
## [1.2.1] - 2026-04-14

### Changed
- Improved README landing page with quick start, feature summary, and doc navigation links.
- Normalized command ID notation in English/Korean docs for private extension workflows.

### Fixed
- Added `additional__*` managed-file deletion handling so removed additional files are also removed from Gist.
- Applied public-redaction flow to `additionalFiles` payloads before uploading to a public Gist.

<details>
<summary>한국어 (요약)</summary>

- README 랜딩 구성을 보강해 빠른 시작, 기능 요약, 문서 이동 링크를 정리했습니다.
- 영문/국문 문서의 Private Extension 관련 커맨드 표기를 전체 command ID 형식으로 통일했습니다.
- `additional__*` 파일을 관리 대상 삭제 로직에 포함해, 추가 파일 제거 시 Gist 잔존 파일이 남지 않도록 수정했습니다.
- Public Gist 업로드 시 `additionalFiles` 내용에도 마스킹 로직을 적용했습니다.

</details>

---

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
