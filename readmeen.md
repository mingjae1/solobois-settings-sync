# Soloboi's Settings Sync (English)

Back up, sync, and share your VS Code/Antigravity setup through GitHub Gist.

[![VS Marketplace Version](https://vsmarketplacebadges.dev/version/soloboi.solobois-settings-sync.svg?style=for-the-badge)](https://marketplace.visualstudio.com/items?itemName=soloboi.solobois-settings-sync)
[![VS Marketplace Installs](https://vsmarketplacebadges.dev/installs/soloboi.solobois-settings-sync.svg?style=for-the-badge)](https://marketplace.visualstudio.com/items?itemName=soloboi.solobois-settings-sync)
[![VS Marketplace Rating](https://vsmarketplacebadges.dev/rating/soloboi.solobois-settings-sync.svg?style=for-the-badge)](https://marketplace.visualstudio.com/items?itemName=soloboi.solobois-settings-sync&ssr=false#review-details)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/soloboi/solobois-settings-sync?style=for-the-badge&label=Open%20VSX%20Downloads)](https://open-vsx.org/extension/soloboi/solobois-settings-sync)
[![GitHub Stars](https://img.shields.io/github/stars/mingjae1/solobois-settings-sync?style=for-the-badge&label=GitHub%20Stars)](https://github.com/mingjae1/solobois-settings-sync/stargazers)
[![GitHub License](https://img.shields.io/github/license/mingjae1/solobois-settings-sync?style=for-the-badge)](https://github.com/mingjae1/solobois-settings-sync/blob/main/LICENSE.md)

## Why this extension?
- Keep the same dev environment across laptop, desktop, and remote containers.
- Review diffs before apply, then restore any previous snapshot if needed.
- Publish a clean, shareable setup link for your team or community.

## Quick Start (3 min)
1. `Soloboi's Settings Sync: Login to GitHub`
2. `Soloboi's Settings Sync: Upload Settings to Gist`
3. On another machine, run `Soloboi's Settings Sync: Set Gist ID`
4. Run `Soloboi's Settings Sync: Download Settings from Gist`

<details>
<summary>Details: User Manual</summary>

### Daily Sync
- Recommended command: `soloboisSettingsSync.syncNow`
- Uses download-first then upload flow for safer reconciliation.

### Backup & Restore
- Backup: `soloboisSettingsSync.uploadNow`
- Restore: `soloboisSettingsSync.downloadNow`
- History restore: `soloboisSettingsSync.showHistory`

### Setup Sharing (Promotion/Distribution)
- Command: `soloboisSettingsSync.shareSettings`
- Creates a public/unlisted Gist link for sharing.
- Uses masked snapshot flow for safer public distribution.

### Private Extensions
- Register/remove: `registerPrivateExtension`, `removePrivateExtension`
- Auto-detect: `autoDetectPrivateExtensions`
- Upload VSIX to Gist: `uploadPrivateVsixToGist`

### Frequent Commands
- `soloboisSettingsSync.syncNow`
- `soloboisSettingsSync.uploadNow`
- `soloboisSettingsSync.downloadNow`
- `soloboisSettingsSync.showLocalVsRemoteDiff`
- `soloboisSettingsSync.showHistory`
- `soloboisSettingsSync.shareSettings`

### Recommended Settings
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
<summary>Details: Sharing/Promotion Tips</summary>

- Separate private backup Gist from public sharing Gist.
- Run `showLocalVsRemoteDiff` before publishing.
- For team onboarding, include install link + gist link + apply order.

</details>

## Language Switch
- [한국어 문서](./readmekr.md)
- [Root README](./README.md)

## Changelog
See [CHANGELOG.md](./CHANGELOG.md) for release notes.
