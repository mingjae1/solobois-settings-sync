# Soloboi's Settings Sync

Sync VS Code or Antigravity settings across machines using GitHub Gist.

## Features

- Sync `settings.json`, `keybindings.json`, snippets, and extension list
- Profile-based sync (different gist/ignore rules per profile)
- Local vs Remote diff before apply
- Gist history and rollback
- Private extension support (register / auto-detect / gist-embedded VSIX)
- File-manager based path and file selection

## Installation

Install from VS Code Extensions and search for:

- `Soloboi's Settings Sync`

Or via Quick Open (`Ctrl+P`):

```text
ext install soloboi.solobois-settings-sync
```

## Quick Start

1. Run `Soloboi's Settings Sync: Login to GitHub`
2. Run `Soloboi's Settings Sync: Upload Settings to Gist`
3. On another machine, run `Soloboi's Settings Sync: Set Gist ID`
4. Run `Soloboi's Settings Sync: Download Settings from Gist`

## Core Commands

- `soloboisSettingsSync.syncNow` - safe sync (download first, then upload)
- `soloboisSettingsSync.uploadNow` - upload local state to gist
- `soloboisSettingsSync.downloadNow` - apply gist state locally
- `soloboisSettingsSync.showLocalVsRemoteDiff` - open diff view
- `soloboisSettingsSync.showHistory` - browse/restore gist revisions
- `soloboisSettingsSync.shareSettings` - create shareable public snapshot

## Private Extensions

- `soloboisSettingsSync.registerPrivateExtension`
- `soloboisSettingsSync.removePrivateExtension`
- `soloboisSettingsSync.autoDetectPrivateExtensions`
- `soloboisSettingsSync.uploadPrivateVsixToGist`

## Path & File Selection (File Manager)

You can choose paths/files without typing full paths:

- `soloboisSettingsSync.pickUserDataDir`
- `soloboisSettingsSync.pickExtensionsDir`
- `soloboisSettingsSync.pickAdditionalFiles`

These are also available in the sidebar `Help` section.

## Recommended Settings

```json
{
  "soloboisSettingsSync.autoSync": true,
  "soloboisSettingsSync.autoSyncOnStartup": true,
  "soloboisSettingsSync.autoUploadOnChange": true,
  "soloboisSettingsSync.pathStrategy": "auto"
}
```

For Docker-first behavior:

```json
{
  "soloboisSettingsSync.pathStrategy": "docker"
}
```

## Docker/code-server Notes

- Auto strategy checks container signals and uses Docker/code-server paths when detected.
- Extensions path fallback includes:
  - `~/extensions`
  - `~/.local/share/code-server/extensions`
- If auto detection is not what you want, use the picker commands above to set exact directories.

## Security

- Sync targets your own GitHub Gist.
- Sensitive-value filtering is applied in sync/share flows.
- Public share flow is separate from private sync flow.

## Troubleshooting

- If download/apply does not match expectation, run `showLocalVsRemoteDiff` first.
- If paths are wrong in container environments:
  1. Set `pathStrategy` to `docker`, or
  2. Use `pickUserDataDir` / `pickExtensionsDir`.
- If extension installs differ across machines, check private extension registry entries.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release notes.
