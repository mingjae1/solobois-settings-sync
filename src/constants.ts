export const GIST_DESCRIPTION_PREFIX = "Soloboi's Settings Sync - ";
export const GIST_DEFAULT_DESCRIPTION = "Soloboi's Settings Sync - VS Code Settings"; // Used for initial creation
export const LAST_SYNC_KEY = 'soloboisSettingsSync.lastSyncTimestamp';
export const LOCAL_STATE_TIMESTAMP_KEY = 'soloboisSettingsSync.localStateTimestamp';
export const PENDING_UPLOAD_KEY = 'soloboisSettingsSync.pendingUpload';
export const INTENTIONALLY_REMOVED_KEY = 'soloboisSettingsSync.intentionallyRemovedExtensions';
export const DEFAULT_PROFILE_NAME = 'Default';

// Buffer after download completes before re-enabling auto-upload, to avoid
// immediately re-uploading the settings we just applied from remote.
export const AUTO_UPLOAD_SUPPRESSION_BUFFER_MS = 1500;

// Debounce delay after an extension install/uninstall event before triggering upload,
// to coalesce rapid consecutive changes (e.g. bulk install) into a single upload.
export const EXTENSION_CHANGE_UPLOAD_DELAY_MS = 750;

// Marketplace API hostnames
export const OPEN_VSX_HOSTNAME = 'open-vsx.org';
export const VS_MARKETPLACE_HOSTNAME = 'marketplace.visualstudio.com';
