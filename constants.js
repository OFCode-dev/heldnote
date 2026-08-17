export const LIMITS = {
  DRAFT_FLUSH_MAX_MS: 300,
  MAX_NOTE_SIZE_BYTES: 2 * 1024 * 1024, // 2 MB — provisional, see Task 21
  PROTECTED_RECENT_COUNT: 50,
  PROTECTED_RECENT_MS: 24 * 60 * 60 * 1000,
  PER_NOTE_HISTORY_BYTE_BUDGET: 10 * 1024 * 1024, // 10 MB — provisional, see Task 21
  // NOT ENFORCED ANYWHERE YET. Unlike the two limits above (MAX_NOTE_SIZE_BYTES
  // is checked on the draft path, PER_NOTE_HISTORY_BYTE_BUDGET bounds the
  // pruning ladder), nothing reads this value. Enforcing it means summing
  // version bytes across every note before deciding what to prune — a real
  // change to runMaintenance()'s shape, not a constant lookup. Stated here
  // because a budget that looks enforced and is not is worse than one that is
  // openly a placeholder.
  GLOBAL_HISTORY_BYTE_BUDGET: 200 * 1024 * 1024, // 200 MB — provisional, see Task 21
};

// Google Drive backup (drive-sync.js). Empty string = feature hidden: the
// Drive section of the backup panel only renders when a client id is set.
// This is an OAuth *client* id — public by design, not a secret.
export const GOOGLE_DRIVE_CLIENT_ID = '';
