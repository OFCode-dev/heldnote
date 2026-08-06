export const LIMITS = {
  DRAFT_FLUSH_MAX_MS: 300,
  MAX_NOTE_SIZE_BYTES: 2 * 1024 * 1024, // 2 MB — provisional, see Task 21
  PROTECTED_RECENT_COUNT: 50,
  PROTECTED_RECENT_MS: 24 * 60 * 60 * 1000,
  PER_NOTE_HISTORY_BYTE_BUDGET: 10 * 1024 * 1024, // 10 MB — provisional, see Task 21
  GLOBAL_HISTORY_BYTE_BUDGET: 200 * 1024 * 1024, // 200 MB — provisional, see Task 21
};
