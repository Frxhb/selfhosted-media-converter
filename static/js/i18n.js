/**
 * i18n Localization Engine for Media Converter Pro
 */

let currentLang = localStorage.getItem('mcp_locale') || 'de';
let translations = {};

async function loadLocale(lang) {
  try {
    const v = window.ASSET_VERSION ? `?v=${window.ASSET_VERSION}` : "";
    const res = await fetch(`/static/locales/${lang}.json${v}`);
    if (!res.ok) throw new Error(`Could not load locale ${lang}`);
    translations = await res.json();
    currentLang = lang;
    localStorage.setItem('mcp_locale', lang);
    applyTranslations();
    document.documentElement.lang = lang;
  } catch (err) {
    console.warn(`[i18n] Failed to load locale '${lang}', falling back to 'de'`, err);
    if (lang !== 'de') {
      loadLocale('de');
    }
  }
}

function getNestedValue(obj, keyPath) {
  return keyPath.split('.').reduce((prev, curr) => (prev && prev[curr] !== undefined ? prev[curr] : null), obj);
}

function t(key, fallback = '') {
  const value = getNestedValue(translations, key);
  return value !== null ? value : (fallback || key);
}

window.t = t;
window.getLocale = () => currentLang;

function applyTranslations() {
  // Synchronize language dropdown selectors
  document.querySelectorAll('#lang-selector, .lang-select-btn').forEach(sel => {
    if (sel.value !== currentLang) {
      sel.value = currentLang;
    }
  });

  // Elements with data-i18n attribute
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const translated = t(key);
    if (translated) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (el.hasAttribute('placeholder')) {
          el.placeholder = translated;
        } else {
          el.value = translated;
        }
      } else {
        const textSpan = el.querySelector('.i18n-text');
        if (textSpan) {
          textSpan.textContent = translated;
        } else if (translated.includes('<') && translated.includes('>')) {
          el.innerHTML = translated;
        } else if (el.children.length === 0) {
          el.textContent = translated;
        } else {
          let textNode = Array.from(el.childNodes).find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0);
          if (textNode) {
            textNode.textContent = translated;
          } else {
            el.innerHTML = translated;
          }
        }
      }
    }
  });

  // Elements with data-i18n-title
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    const translated = t(key);
    if (translated) el.title = translated;
  });

  // Elements with data-i18n-placeholder
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const translated = t(key);
    if (translated) el.placeholder = translated;
  });

  // Trigger quality/options refresh if functions exist
  if (typeof updateDownloadQualityOptions === 'function') {
    updateDownloadQualityOptions();
  }
  if (typeof updateYtdlpPreview === 'function') {
    updateYtdlpPreview();
  }
  // Re-render dynamic lists/badges that use t() internally, so they
  // reflect the new language immediately instead of waiting for the
  // next natural refresh (websocket update, tab switch, modal open, ...).
  if (typeof renderTabQueue === 'function') {
    ['video', 'audio', 'images', 'tools'].forEach(tab => renderTabQueue(tab));
  }
  if (typeof refreshOutputFiles === 'function') {
    refreshOutputFiles();
  }
  if (typeof refreshFiles === 'function') {
    refreshFiles();
  }
  if (typeof loadServerConfig === 'function') {
    loadServerConfig();
  }
  if (typeof loadCookiesStatus === 'function') {
    loadCookiesStatus();
  }
  if (typeof loadJobs === 'function') {
    loadJobs();
  }
  if (typeof refreshPipelines === 'function') {
    refreshPipelines();
  }
  if (typeof refreshSubscriptions === 'function') {
    refreshSubscriptions();
  }
  if (typeof fetchStats === 'function') {
    fetchStats();
  }
  window.dispatchEvent(new CustomEvent('mcp_i18n_changed', { detail: { lang: currentLang } }));
}

function switchLanguage(lang) {
  loadLocale(lang);
}

// Auto-initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  loadLocale(currentLang);
});
