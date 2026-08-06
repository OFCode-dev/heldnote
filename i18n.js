const STRINGS = {
  en: {
    'status.saving': 'Saving…',
    'status.saved': 'Saved locally',
    'status.notSaved': 'Not saved — memory only',
    'status.recovered': 'Unsaved draft recovered',
    'status.quotaWarning': 'Storage is nearly full — older history may be trimmed',
    'retention.label': 'Browser retention',
    'retention.persistent': 'Persistent',
    'retention.bestEffort': 'Best effort',
    'retention.sessionOnly': 'Session only',
    'retention.unknown': 'Unknown',
    'error.storageBlocked': 'Storage is blocked in this browser — another tab may be holding it open. Close other tabs and reload.',
    'error.storageCorrupt': 'This browser\'s local storage for Heldnote appears to be corrupted. Notes made in this browser may be unrecoverable.',
    'error.storageUnavailable': 'Local storage is unavailable in this browser. Notes will not be saved.',
    'error.versionMismatch': 'This browser holds newer data than this page. Reload to update.',
    'note.untitled': 'Untitled',
    'notes.new': 'New note',
    'notes.searchLabel': 'Search notes',
    'notes.pin': 'Pin',
    'notes.unpin': 'Unpin',
    'trash.move': 'Move to trash',
    'trash.restore': 'Restore note',
    'trash.deletePermanently': 'Delete permanently',
    'trash.deleteConfirm': 'Delete this note and all of its version history from this browser? This action cannot be undone.',
    'history.title': 'Version history',
    'history.preview': 'Preview version',
    'history.restoreConfirm': 'Restore this version? The current text will remain available as an earlier version.',
    'history.restored': 'Earlier version restored',
    'history.restoreFailed': 'Could not restore this version — try again',
  },
  tr: {
    'status.saving': 'Kaydediliyor…',
    'status.saved': 'Yerel olarak kaydedildi',
    'status.notSaved': 'Kaydedilmedi — yalnızca bellekte',
    'status.recovered': 'Kaydedilmemiş taslak kurtarıldı',
    'status.quotaWarning': 'Depolama neredeyse dolu — eski geçmiş kırpılabilir',
    'retention.label': 'Tarayıcı saklama',
    'retention.persistent': 'Kalıcı',
    'retention.bestEffort': 'En iyi çaba',
    'retention.sessionOnly': 'Yalnızca oturum',
    'retention.unknown': 'Bilinmiyor',
    'error.storageBlocked': 'Bu tarayıcıda depolama engellendi — başka bir sekme açık tutuyor olabilir. Diğer sekmeleri kapatıp sayfayı yenileyin.',
    'error.storageCorrupt': 'Bu tarayıcıdaki Heldnote yerel depolaması bozulmuş görünüyor. Bu tarayıcıda yazılan notlar kurtarılamayabilir.',
    'error.storageUnavailable': 'Bu tarayıcıda yerel depolama kullanılamıyor. Notlar kaydedilmeyecek.',
    'error.versionMismatch': 'Bu tarayıcı bu sayfadan daha yeni veri tutuyor. Güncellemek için sayfayı yenileyin.',
    'note.untitled': 'Başlıksız',
    'notes.new': 'Yeni not',
    'notes.searchLabel': 'Notlarda ara',
    'notes.pin': 'Sabitle',
    'notes.unpin': 'Sabitlemeyi kaldır',
    'trash.move': 'Çöp kutusuna taşı',
    'trash.restore': 'Notu geri yükle',
    'trash.deletePermanently': 'Kalıcı olarak sil',
    'trash.deleteConfirm': 'Bu not ve tüm sürüm geçmişi bu tarayıcıdan silinsin mi? Bu işlem geri alınamaz.',
    'history.title': 'Sürüm geçmişi',
    'history.preview': 'Sürümü önizle',
    'history.restoreConfirm': 'Bu sürüm geri yüklensin mi? Geçerli metin önceki bir sürüm olarak saklanmaya devam edecek.',
    'history.restored': 'Önceki sürüm geri yüklendi',
    'history.restoreFailed': 'Bu sürüm geri yüklenemedi — tekrar deneyin',
  },
};

let currentLanguage = 'en';

export function setLanguage(lang) {
  currentLanguage = STRINGS[lang] ? lang : 'en';
}

export function getLanguage() {
  return currentLanguage;
}

export function detectLanguage() {
  const lang = (navigator.language || '').toLowerCase();
  return lang.startsWith('tr') ? 'tr' : 'en';
}

export function t(key) {
  return STRINGS[currentLanguage][key] || STRINGS.en[key] || key;
}
