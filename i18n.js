const STRINGS = {
  en: {
    'status.saving': 'Saving…',
    'status.saved': 'Saved locally',
    'status.notSaved': 'Not saved — memory only',
    'status.recovered': 'Unsaved draft recovered',
    'retention.label': 'Browser retention',
    'retention.persistent': 'Persistent',
    'retention.bestEffort': 'Best effort',
    'retention.sessionOnly': 'Session only',
    'retention.unknown': 'Unknown',
    'note.untitled': 'Untitled',
    'trash.move': 'Move to trash',
    'trash.restore': 'Restore note',
    'trash.deletePermanently': 'Delete permanently',
    'trash.deleteConfirm': 'Delete this note and all of its version history from this browser? This action cannot be undone.',
    'history.title': 'Version history',
    'history.preview': 'Preview version',
    'history.restoreConfirm': 'Restore this version? The current text will remain available as an earlier version.',
    'history.restored': 'Earlier version restored',
  },
  tr: {
    'status.saving': 'Kaydediliyor…',
    'status.saved': 'Yerel olarak kaydedildi',
    'status.notSaved': 'Kaydedilmedi — yalnızca bellekte',
    'status.recovered': 'Kaydedilmemiş taslak kurtarıldı',
    'retention.label': 'Tarayıcı saklama',
    'retention.persistent': 'Kalıcı',
    'retention.bestEffort': 'En iyi çaba',
    'retention.sessionOnly': 'Yalnızca oturum',
    'retention.unknown': 'Bilinmiyor',
    'note.untitled': 'Başlıksız',
    'trash.move': 'Çöp kutusuna taşı',
    'trash.restore': 'Notu geri yükle',
    'trash.deletePermanently': 'Kalıcı olarak sil',
    'trash.deleteConfirm': 'Bu not ve tüm sürüm geçmişi bu tarayıcıdan silinsin mi? Bu işlem geri alınamaz.',
    'history.title': 'Sürüm geçmişi',
    'history.preview': 'Sürümü önizle',
    'history.restoreConfirm': 'Bu sürüm geri yüklensin mi? Geçerli metin önceki bir sürüm olarak saklanmaya devam edecek.',
    'history.restored': 'Önceki sürüm geri yüklendi',
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
