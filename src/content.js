(() => {
  'use strict';

  const EXT = {
    TAB_ID: 'hagap-bmds-tab',
    BAR_ID: 'hagap-bmds-bar',
    TOAST_ID: 'hagap-bmds-toast',
    MODAL_ID: 'hagap-bmds-modal',
    ATTR: 'data-hagap-bmds',
    SESSION_KEY: 'hagap-bmds-active',
  };

  const DEFAULTS = {
    destinatario: '',
    filterMode: 'days', // 'days' | 'period'
    daysValue: '7', // '7' | '30' | 'all'
    periodValue: 'week', // 'week' | 'month' | 'all' | 'custom'
    customStart: '', // YYYY-MM-DD
    customEnd: '', // YYYY-MM-DD
  };

  const FETCH_CONCURRENCY = 4;
  const FETCH_RETRIES = 2;
  /** Binary chunk size when shipping a single attachment to the offscreen ZIP builder. */
  const TRANSFER_CHUNK_BYTES = 2 * 1024 * 1024;
  /** Below this, one ZIP_BUILD_ADD message is fine (still under MV3 message limits). */
  const SINGLE_MESSAGE_MAX_BYTES = 4 * 1024 * 1024;

  const LOG = (...args) => console.info('[Hagap BMDs]', ...args);

  const LOGO_URL = chrome.runtime.getURL('icons/logo.png');

  /** @type {typeof DEFAULTS} */
  let settings = { ...DEFAULTS };
  let active = false;
  let injectScheduled = false;
  /** @type {number} */
  let injectRafId = 0;
  let lastInjectAt = 0;
  let downloadBusy = false;
  /** Keep bar visible briefly while BMDs filter hash is applying. */
  let forceBarUntil = 0;
  /** Skip storage-driven refilter when the bar already handled the change. */
  let skipNextStorageFilter = false;

  const TAB_LABELS = [
    'primary',
    'principais',
    'promotions',
    'promoções',
    'promocoes',
    'social',
    'updates',
    'atualizações',
    'atualizacoes',
    'forums',
    'fóruns',
    'foruns',
  ];

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULTS, (data) => {
        settings = { ...DEFAULTS, ...data };
        resolve(settings);
      });
    });
  }

  function saveSettings(partial) {
    settings = { ...settings, ...partial };
    skipNextStorageFilter = true;
    return chrome.storage.sync.set(partial);
  }

  function readSessionActive() {
    try {
      return sessionStorage.getItem(EXT.SESSION_KEY) === '1';
    } catch {
      return false;
    }
  }

  function setActive(value) {
    active = Boolean(value);
    try {
      if (active) sessionStorage.setItem(EXT.SESSION_KEY, '1');
      else sessionStorage.removeItem(EXT.SESSION_KEY);
    } catch {
      /* private mode / blocked storage */
    }
  }

  function ensureBarVisible() {
    const bar = document.getElementById(EXT.BAR_ID);
    if (bar) bar.classList.add('is-visible');
  }

  function hideBarOnly() {
    const bar = document.getElementById(EXT.BAR_ID);
    if (bar) bar.classList.remove('is-visible');
    setBarStatus('');
    syncListLayoutOffset();
  }

  function decodeSearchQueryPart(raw) {
    try {
      return decodeURIComponent(String(raw || '').replace(/\+/g, ' '));
    } catch {
      return String(raw || '').replace(/\+/g, ' ');
    }
  }

  function getQueryFromHash(hash = location.hash || '') {
    if (!hash.includes('#search/')) return '';
    const body = hash.replace(/^[^#]*#search\//, '').replace(/^#search\//, '');
    const queryPart = body.split('/')[0] || '';
    return decodeSearchQueryPart(queryPart).trim();
  }

  function getQueryFromSearchBox() {
    const input =
      document.querySelector('input[name="q"]') ||
      document.querySelector('form[role="search"] input[type="text"]') ||
      document.querySelector('input[aria-label*="Pesquisar" i]') ||
      document.querySelector('input[aria-label*="Search" i]');
    return (input?.value || '').trim();
  }

  function getCurrentGmailQuery() {
    return getQueryFromHash() || getQueryFromSearchBox();
  }

  function configuredDestinatario() {
    return (settings.destinatario || '').trim().toLowerCase();
  }

  /** True when query targets the configured destinatário via to:... */
  function queryMentionsConfiguredDestinatario(query = getCurrentGmailQuery()) {
    const to = configuredDestinatario();
    if (!to || !query) return false;
    const q = query.toLowerCase();
    const escaped = to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s("])to\\s*:\\s*"?${escaped}"?(?=$|[\\s")])`, 'i');
    if (re.test(q)) return true;
    return (
      q.includes(`to:${to}`) ||
      q.includes(`to: ${to}`) ||
      q.includes(`to:"${to}"`) ||
      q.includes(`to:'${to}'`)
    );
  }

  /** Legacy helper: BMDs-style search (from:me + has:attachment + to:configured). */
  function isBmdsSearchHash(hash = location.hash || '') {
    const q = getQueryFromHash(hash).toLowerCase();
    if (!q) return false;
    return (
      q.includes('has:attachment') &&
      q.includes('from:me') &&
      queryMentionsConfiguredDestinatario(q)
    );
  }

  function shouldShowBmdsBar() {
    return isBmdsSearchHash();
  }

  /** True unless the current Gmail route contains the full BMDs search query. */
  function isLeavingBmdsContext(hash = location.hash || '') {
    if (!hash.includes('#search/')) return true;
    const q = getQueryFromHash(hash);
    if (!q) return true;
    return !(
      q.toLowerCase().includes('from:me') &&
      q.toLowerCase().includes('has:attachment') &&
      queryMentionsConfiguredDestinatario(q)
    );
  }

  function armBarForce(ms = 2500) {
    forceBarUntil = Date.now() + ms;
  }

  function clearBarForce() {
    forceBarUntil = 0;
  }

  function cancelScheduledInject() {
    injectScheduled = false;
    if (injectRafId) {
      cancelAnimationFrame(injectRafId);
      injectRafId = 0;
    }
  }

  /** Sync hide toolbar when leaving BMDs search (inbox click, other label, wrong to:).
   *  Always keeps / re-injects the BMDs category tab (independent of toolbar). */
  function leaveBmdsContextImmediate() {
    clearBarForce();
    cancelScheduledInject();
    deactivateBmdsUi();
    ensureBmdsTab();
  }

  function isGmailDark() {
    const html = document.documentElement;
    const scheme = html.getAttribute('data-color-scheme');
    if (scheme === 'dark') return true;
    if (scheme === 'light') return false;
    const bg = getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) {
      const lum = (Number(m[1]) * 299 + Number(m[2]) * 587 + Number(m[3]) * 114) / 1000;
      return lum < 80;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function syncThemeClass() {
    document.body.classList.toggle('bmd-dark', isGmailDark());
    const tab = document.getElementById(EXT.TAB_ID);
    if (tab) tab.classList.toggle('theme-dark', isGmailDark());
  }

  function formatDateGmail(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}/${m}/${d}`;
  }

  /** Parse YYYY-MM-DD or YYYY/MM/DD into local Date at midnight. */
  function parseYmd(value) {
    const m = String(value || '').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function toInputDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /** Display DD/MM/AAAA from Date or stored YYYY-MM-DD. */
  function toBrDate(value) {
    const d = value instanceof Date ? value : parseYmd(value);
    if (!d) return '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  /** Mask digits into DD/MM/AAAA (max 10). */
  function maskBrDateInput(raw) {
    const digits = String(raw || '')
      .replace(/\D/g, '')
      .slice(0, 8);
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  }

  /** Parse DD/MM/AAAA into valid calendar Date, or null. */
  function parseBrDate(value) {
    const m = String(value || '')
      .trim()
      .match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const d = new Date(year, month - 1, day);
    if (
      Number.isNaN(d.getTime()) ||
      d.getFullYear() !== year ||
      d.getMonth() !== month - 1 ||
      d.getDate() !== day
    ) {
      return null;
    }
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function bindBrDateMask(input) {
    if (!input) return;
    input.addEventListener('input', () => {
      const next = maskBrDateInput(input.value);
      if (input.value !== next) input.value = next;
    });
    input.addEventListener('blur', () => {
      const next = maskBrDateInput(input.value);
      input.value = next;
    });
  }

  function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  function startOfWeek(date = new Date()) {
    const d = new Date(date);
    const day = d.getDay(); // 0 Sun
    const diff = day === 0 ? -6 : 1 - day; // Monday start
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + diff);
    return d;
  }

  function startOfMonth(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  /**
   * Inclusive custom range via Gmail operators.
   * `before:` is exclusive, so end day uses before:(end+1).
   * `after:` matches the existing Semanal/Mensal pattern (calendar day as bound).
   */
  function customRangeOperators(startYmd, endYmd) {
    const start = parseYmd(startYmd);
    const end = parseYmd(endYmd);
    if (!start || !end) return null;
    if (start.getTime() > end.getTime()) return null;
    return {
      after: formatDateGmail(start),
      before: formatDateGmail(addDays(end, 1)),
    };
  }

  function buildQuery() {
    const to = (settings.destinatario || '').trim();
    if (!to) return null;

    const parts = [`from:me`, `to:${to}`, `has:attachment`];

    if (settings.filterMode === 'days') {
      if (settings.daysValue === '7') parts.push('newer_than:7d');
      else if (settings.daysValue === '30') parts.push('newer_than:30d');
    } else if (settings.periodValue === 'week') {
      parts.push(`after:${formatDateGmail(startOfWeek())}`);
    } else if (settings.periodValue === 'month') {
      parts.push(`after:${formatDateGmail(startOfMonth())}`);
    } else if (settings.periodValue === 'custom') {
      const range = customRangeOperators(settings.customStart, settings.customEnd);
      if (!range) return null;
      parts.push(`after:${range.after}`);
      parts.push(`before:${range.before}`);
    }

    return parts.join(' ');
  }

  function getAccountPath() {
    const m = location.pathname.match(/\/mail\/u\/(\d+)\//);
    return m ? `/mail/u/${m[1]}/` : '/mail/u/0/';
  }

  function applyGmailSearch(query) {
    setActive(true);
    armBarForce();
    const encoded = encodeURIComponent(query).replace(/%20/g, '+');
    const hash = `#search/${encoded}`;

    // Never bounce through #inbox: that hashchange clears BMDs UI.
    // If already on this search, keep the bar and skip navigation.
    if (location.hash === hash) {
      ensureBarVisible();
      scheduleInject();
      return;
    }

    // Hash-only change keeps the content script and BMDs session alive.
    location.hash = hash;
  }

  function showToast(message, withOptionsLink = false) {
    let el = document.getElementById(EXT.TOAST_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = EXT.TOAST_ID;
      el.className = 'hagap-bmds-toast';
      document.body.appendChild(el);
    }
    el.textContent = '';
    el.appendChild(document.createTextNode(message));
    if (withOptionsLink) {
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = 'Configurar';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
      });
      el.appendChild(a);
    }
    el.classList.add('is-visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove('is-visible'), 4200);
  }

  function setBarStatus(text) {
    const bar = document.getElementById(EXT.BAR_ID);
    const status = bar?.querySelector('[data-status]');
    if (!status) return;
    status.textContent = text || '';
    status.hidden = !text;
  }

  function setDownloadBusy(busy) {
    downloadBusy = busy;
    const bar = document.getElementById(EXT.BAR_ID);
    if (!bar) return;
    const downloadBtn = bar.querySelector('[data-action="download"]');
    const backBtn = bar.querySelector('[data-action="back"]');
    if (downloadBtn) {
      downloadBtn.disabled = busy;
      downloadBtn.classList.toggle('is-busy', busy);
    }
    if (backBtn) backBtn.disabled = busy;
  }

  function findCategoryTablist() {
    const lists = Array.from(document.querySelectorAll('[role="tablist"]'));
    for (const list of lists) {
      const text = (list.textContent || '').toLowerCase();
      const hits = TAB_LABELS.filter((l) => text.includes(l)).length;
      if (hits >= 2) return list;
    }

    const candidates = Array.from(
      document.querySelectorAll('div[role="navigation"], div.aKh, div.aKk, div.aeN, div')
    );
    for (const el of candidates) {
      if (el.id === EXT.BAR_ID || el.closest(`#${EXT.BAR_ID}`)) continue;
      const kids = Array.from(el.children);
      if (kids.length < 2 || kids.length > 8) continue;
      const labels = kids.map((c) => (c.textContent || '').trim().toLowerCase());
      const hits = labels.filter((t) => TAB_LABELS.some((l) => t.includes(l))).length;
      if (hits >= 2) return el;
    }
    return null;
  }

  function createTabElement() {
    const btn = document.createElement('div');
    btn.id = EXT.TAB_ID;
    btn.className = 'hagap-bmds-tab';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute(EXT.ATTR, '1');
    btn.tabIndex = 0;
    btn.title = 'BMDs - e-mails enviados com anexos';

    btn.innerHTML = `
      <img class="hagap-bmds-tab__icon" src="${LOGO_URL}" alt="" width="20" height="20" />
      <span class="hagap-bmds-tab__label">BMDs</span>
      <span class="hagap-bmds-tab__underline" aria-hidden="true"></span>
    `;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      activateBmds();
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activateBmds();
      }
    });

    return btn;
  }

  function setNativeTabsInactive(tablist) {
    if (!tablist) return;
    const tabs = tablist.querySelectorAll('[role="tab"], [aria-selected="true"]');
    tabs.forEach((t) => {
      if (t.id === EXT.TAB_ID) return;
      if (t.getAttribute('aria-selected') === 'true') {
        t.setAttribute('aria-selected', 'false');
      }
      t.classList.remove('aS3', 'aS4');
    });
  }

  function deactivateNativeLook(tablist) {
    setNativeTabsInactive(tablist);
  }

  function createFilterBar() {
    const bar = document.createElement('div');
    bar.id = EXT.BAR_ID;
    bar.className = 'hagap-bmds-bar';
    bar.setAttribute(EXT.ATTR, '1');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Filtros BMDs');

    bar.innerHTML = `
      <div class="hagap-bmds-bar__left">
        <span class="hagap-bmds-bar__brand">
          <img class="hagap-bmds-bar__logo" src="${LOGO_URL}" alt="" width="22" height="22" />
          BMDs
        </span>
        <span class="hagap-bmds-bar__hint" data-dest></span>
      </div>
      <div class="hagap-bmds-bar__filters">
        <div class="hagap-bmds-bar__seg" data-seg="filterMode" role="group" aria-label="Modo de tempo">
          <button type="button" data-value="days">Por dias</button>
          <button type="button" data-value="period">Por período</button>
        </div>
        <div class="hagap-bmds-bar__chips" data-panel="days" data-seg="daysValue" role="group" aria-label="Últimos dias">
          <button type="button" class="hagap-bmds-bar__chip" data-value="7">7 dias</button>
          <button type="button" class="hagap-bmds-bar__chip" data-value="30">30 dias</button>
          <button type="button" class="hagap-bmds-bar__chip" data-value="all">Todos</button>
        </div>
        <div class="hagap-bmds-bar__chips" data-panel="period" data-seg="periodValue" role="group" aria-label="Período" hidden>
          <button type="button" class="hagap-bmds-bar__chip" data-value="week">Semanal</button>
          <button type="button" class="hagap-bmds-bar__chip" data-value="month">Mensal</button>
          <button type="button" class="hagap-bmds-bar__chip" data-value="all">Todos</button>
          <button type="button" class="hagap-bmds-bar__chip" data-value="custom">Customizado</button>
        </div>
      </div>
      <div class="hagap-bmds-bar__actions">
        <button type="button" class="hagap-bmds-bar__btn hagap-bmds-bar__btn--accent" data-action="download" title="Baixar anexos BMD dos resultados">Baixar BMDs</button>
        <button type="button" class="hagap-bmds-bar__btn hagap-bmds-bar__btn--ghost" data-action="back" title="Voltar para a caixa de entrada">Voltar</button>
        <button type="button" class="hagap-bmds-bar__btn hagap-bmds-bar__btn--icon" data-action="options" title="Configurar destinatário" aria-label="Configurar">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.07 7.07 0 0 0-1.63-.94l-.36-2.54A.48.48 0 0 0 14 2h-4a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.55-1.63.94l-2.39-.96a.49.49 0 0 0-.59.22L2.63 8.87a.49.49 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.13.22.39.3.59.22l2.39-.96c.5.39 1.04.71 1.63.94l.36 2.54c.05.24.24.41.48.41h4c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.55 1.63-.94l2.39.96c.22.08.46 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/>
          </svg>
        </button>
      </div>
      <span class="hagap-bmds-bar__status" data-status hidden></span>
    `;

    bar.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn || btn.disabled) return;

      const action = btn.getAttribute('data-action');
      if (action === 'options') {
        chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
        return;
      }
      if (action === 'back') {
        goBackToInbox();
        return;
      }
      if (action === 'download') {
        downloadBmdsFromResults();
        return;
      }

      const seg = btn.closest('[data-seg]');
      if (!seg) return;
      const key = seg.getAttribute('data-seg');
      const value = btn.getAttribute('data-value');
      if (!key || !value) return;

      // Custom range: open modal (prefill from storage). Apply happens in the modal.
      if (key === 'periodValue' && value === 'custom') {
        await saveSettings({ filterMode: 'period', periodValue: 'custom' });
        syncBarUI();
        openCustomRangeModal();
        return;
      }

      await saveSettings({ [key]: value });
      syncBarUI();

      // Mode switch and chip change both apply the current mode's selected filter.
      // Keep BMDs session; hash-only search (no #inbox bounce).
      if (active) {
        if (key === 'filterMode' && value === 'period' && settings.periodValue === 'custom') {
          const range = customRangeOperators(settings.customStart, settings.customEnd);
          if (!range) {
            openCustomRangeModal();
            return;
          }
        }
        runFilter();
      }
    });

    return bar;
  }

  function syncBarUI() {
    const bar = document.getElementById(EXT.BAR_ID);
    if (!bar) return;

    bar.querySelectorAll('[data-seg]').forEach((seg) => {
      const key = seg.getAttribute('data-seg');
      const selected = settings[key];
      seg.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('is-selected', b.getAttribute('data-value') === selected);
      });
    });

    const daysPanel = bar.querySelector('[data-panel="days"]');
    const periodPanel = bar.querySelector('[data-panel="period"]');
    if (daysPanel) daysPanel.hidden = settings.filterMode !== 'days';
    if (periodPanel) periodPanel.hidden = settings.filterMode !== 'period';

    const dest = bar.querySelector('[data-dest]');
    if (dest) {
      const email = (settings.destinatario || '').trim();
      if (email) {
        dest.classList.remove('is-warning');
        dest.innerHTML = `Enviados para <strong>${escapeHtml(email)}</strong> · com anexos`;
      } else {
        dest.classList.add('is-warning');
        dest.textContent = 'Destinatário não configurado. Abra Configurar.';
      }
    }
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function findListAnchor() {
    return (
      document.querySelector('div.aeF') ||
      document.querySelector('div[gh="tl"]') ||
      document.querySelector('.AO div.nH > .Cp') ||
      null
    );
  }

  function findStableBarHost(tablist) {
    const toolbar =
      document.querySelector('div[gh="mtb"]') ||
      document.querySelector('div.G-atb') ||
      document.querySelector('div.aeH');
    if (toolbar) return toolbar;

    if (tablist) {
      const underTabs =
        tablist.closest('.aKh') ||
        tablist.closest('[gh="tl"]') ||
        tablist.parentElement;
      if (underTabs) return underTabs;
    }

    return (
      document.querySelector('div.nH.aqK') ||
      document.querySelector('div[role="main"]') ||
      document.body
    );
  }

  function placeFilterBar(tablist) {
    let bar = document.getElementById(EXT.BAR_ID);
    if (!bar) bar = createFilterBar();

    const listAnchor = findListAnchor();
    if (listAnchor?.parentElement) {
      const parent = listAnchor.parentElement;
      if (bar.nextElementSibling !== listAnchor || bar.parentElement !== parent) {
        listAnchor.insertAdjacentElement('beforebegin', bar);
      }
    } else {
      const host = findStableBarHost(tablist);
      if (!host) {
        syncBarUI();
        return bar;
      }

      if (host === document.body) {
        if (bar.parentElement !== document.body) document.body.prepend(bar);
      } else if (bar.previousElementSibling !== host || !bar.isConnected) {
        host.insertAdjacentElement('afterend', bar);
      }
    }

    // In-flow only. Never overlay message rows.
    bar.style.position = 'relative';
    bar.style.top = 'auto';
    bar.style.left = 'auto';
    bar.style.right = 'auto';
    bar.style.bottom = 'auto';
    bar.style.zIndex = '1';

    syncBarUI();
    syncListLayoutOffset();
    return bar;
  }

  function syncListLayoutOffset() {
    const bar = document.getElementById(EXT.BAR_ID);
    const list = findListAnchor();
    if (!list) return;

    const stacked =
      bar &&
      bar.classList.contains('is-visible') &&
      bar.isConnected &&
      bar.nextElementSibling === list;

    if (!stacked) {
      if (list.dataset.hagapBmdsPad === '1') {
        list.style.marginTop = '';
        delete list.dataset.hagapBmdsPad;
      }
      return;
    }

    const cs = getComputedStyle(list);
    if (cs.position !== 'absolute' && cs.position !== 'fixed') {
      if (list.dataset.hagapBmdsPad === '1') {
        list.style.marginTop = '';
        delete list.dataset.hagapBmdsPad;
      }
      return;
    }

    const h = Math.ceil(bar.getBoundingClientRect().height);
    list.dataset.hagapBmdsPad = '1';
    list.style.marginTop = `${h}px`;
  }

  /** Category-row BMDs tab: always mount when Gmail category tabs exist. */
  function ensureBmdsTab() {
    const tablist = findCategoryTablist();
    if (!tablist) return null;
    let tab = document.getElementById(EXT.TAB_ID);
    if (!tab) tab = createTabElement();
    if (!tablist.contains(tab)) {
      tablist.appendChild(tab);
    }
    syncThemeClass();
    return tab;
  }

  function isBmdsTabInCategoryBar() {
    const tablist = findCategoryTablist();
    if (!tablist) return false;
    const tab = document.getElementById(EXT.TAB_ID);
    return Boolean(tab && tablist.contains(tab));
  }

  function injectTab() {
    const tablist = findCategoryTablist();
    const tab = ensureBmdsTab();

    // Keep filter bar available during search even when category tabs unmount
    placeFilterBar(tablist);

    if (isLeavingBmdsContext()) {
      // Hide toolbar only; ensureBmdsTab already ran (and leave re-ensures).
      if (downloadBusy) hideBarOnly();
      else leaveBmdsContextImmediate();
      return Boolean(tablist || document.getElementById(EXT.BAR_ID));
    }

    if (shouldShowBmdsBar()) {
      setActive(true);
      if (tab) {
        tab.classList.add('is-active');
        tab.setAttribute('aria-selected', 'true');
      }
      ensureBarVisible();
      syncListLayoutOffset();
    }

    return Boolean(tablist || document.getElementById(EXT.BAR_ID));
  }

  function scheduleInject() {
    if (injectScheduled) return;
    // On inbox / leaving BMDs: still reinject the category tab; do not skip.
    if (isLeavingBmdsContext() && !downloadBusy) {
      ensureBmdsTab();
      return;
    }
    injectScheduled = true;
    injectRafId = requestAnimationFrame(() => {
      injectRafId = 0;
      injectScheduled = false;
      if (isLeavingBmdsContext()) {
        if (downloadBusy) hideBarOnly();
        else leaveBmdsContextImmediate();
        return;
      }
      const now = Date.now();
      // Throttle bar updates only when the BMDs tab is already mounted.
      if (now - lastInjectAt < 250 && document.getElementById(EXT.BAR_ID) && isBmdsTabInCategoryBar()) {
        if (shouldShowBmdsBar()) {
          setActive(true);
          ensureBarVisible();
        } else {
          hideBarOnly();
        }
        return;
      }
      lastInjectAt = now;
      injectTab();
    });
  }

  function activateBmds() {
    setActive(true);
    armBarForce();
    const tab = document.getElementById(EXT.TAB_ID);
    const tablist = tab?.parentElement || findCategoryTablist();
    if (tab) {
      tab.classList.add('is-active');
      tab.setAttribute('aria-selected', 'true');
    }
    deactivateNativeLook(tablist);

    placeFilterBar(tablist);
    ensureBarVisible();
    syncBarUI();
    runFilter();
  }

  function deactivateBmdsUi() {
    setActive(false);
    clearBarForce();
    const tab = document.getElementById(EXT.TAB_ID);
    if (tab) {
      tab.classList.remove('is-active');
      tab.setAttribute('aria-selected', 'false');
    }
    const bar = document.getElementById(EXT.BAR_ID);
    if (bar) bar.classList.remove('is-visible');
    setBarStatus('');
    syncListLayoutOffset();
  }

  function goBackToInbox() {
    if (downloadBusy) return;
    leaveBmdsContextImmediate();
    const base = `${location.origin}${getAccountPath()}`;
    location.href = `${base}#inbox`;
    showToast('Voltou para a caixa de entrada.');
  }

  function runFilter() {
    const to = (settings.destinatario || '').trim();
    if (!to) {
      showToast('Configure o destinatário dos BMDs.', true);
      return;
    }
    if (
      settings.filterMode === 'period' &&
      settings.periodValue === 'custom' &&
      !customRangeOperators(settings.customStart, settings.customEnd)
    ) {
      openCustomRangeModal();
      return;
    }
    const query = buildQuery();
    if (!query) return;
    setActive(true);
    ensureBarVisible();
    applyGmailSearch(query);
  }

  function closeCustomRangeModal() {
    const modal = document.getElementById(EXT.MODAL_ID);
    if (modal) modal.remove();
  }

  function openCustomRangeModal() {
    closeCustomRangeModal();

    const overlay = document.createElement('div');
    overlay.id = EXT.MODAL_ID;
    overlay.className = 'hagap-bmds-modal';
    overlay.setAttribute(EXT.ATTR, '1');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'hagap-bmds-modal-title');

    const startVal = toBrDate(settings.customStart || addDays(new Date(), -7));
    const endVal = toBrDate(settings.customEnd || new Date());

    overlay.innerHTML = `
      <div class="hagap-bmds-modal__backdrop" data-modal-dismiss="1"></div>
      <div class="hagap-bmds-modal__card">
        <h2 id="hagap-bmds-modal-title" class="hagap-bmds-modal__title">Período customizado</h2>
        <p class="hagap-bmds-modal__hint">Informe o intervalo inclusivo (DD/MM/AAAA). O Gmail usa <code>before:</code> exclusivo; a data fim é ajustada automaticamente.</p>
        <label class="hagap-bmds-modal__field">
          <span>Data início</span>
          <input type="text" data-field="start" inputmode="numeric" autocomplete="off" maxlength="10" placeholder="DD/MM/AAAA" value="${escapeHtml(startVal)}" required />
        </label>
        <label class="hagap-bmds-modal__field">
          <span>Data fim</span>
          <input type="text" data-field="end" inputmode="numeric" autocomplete="off" maxlength="10" placeholder="DD/MM/AAAA" value="${escapeHtml(endVal)}" required />
        </label>
        <p class="hagap-bmds-modal__error" data-error hidden></p>
        <div class="hagap-bmds-modal__actions">
          <button type="button" class="hagap-bmds-bar__btn hagap-bmds-bar__btn--ghost" data-modal="cancel">Cancelar</button>
          <button type="button" class="hagap-bmds-bar__btn hagap-bmds-bar__btn--accent" data-modal="apply">Aplicar</button>
        </div>
      </div>
    `;

    const showError = (msg) => {
      const err = overlay.querySelector('[data-error]');
      if (!err) return;
      err.textContent = msg || '';
      err.hidden = !msg;
    };

    const startInput = overlay.querySelector('[data-field="start"]');
    const endInput = overlay.querySelector('[data-field="end"]');
    bindBrDateMask(startInput);
    bindBrDateMask(endInput);

    const apply = async () => {
      const startBr = (startInput?.value || '').trim();
      const endBr = (endInput?.value || '').trim();
      if (!startBr || !endBr) {
        showError('Preencha data início e data fim.');
        return;
      }
      const startDate = parseBrDate(startBr);
      const endDate = parseBrDate(endBr);
      if (!startDate || !endDate) {
        showError('Use datas válidas no formato DD/MM/AAAA.');
        return;
      }
      if (startDate.getTime() > endDate.getTime()) {
        showError('Data início deve ser anterior ou igual à data fim.');
        return;
      }
      const start = toInputDate(startDate);
      const end = toInputDate(endDate);
      const range = customRangeOperators(start, end);
      if (!range) {
        showError('Intervalo inválido.');
        return;
      }
      await saveSettings({
        filterMode: 'period',
        periodValue: 'custom',
        customStart: start,
        customEnd: end,
      });
      syncBarUI();
      closeCustomRangeModal();
      if (active) runFilter();
    };

    overlay.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.getAttribute('data-modal-dismiss') === '1' || t.getAttribute('data-modal') === 'cancel') {
        closeCustomRangeModal();
        return;
      }
      if (t.getAttribute('data-modal') === 'apply') apply();
    });

    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeCustomRangeModal();
      }
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
        e.preventDefault();
        apply();
      }
    });

    document.body.appendChild(overlay);
    syncThemeClass();
    startInput?.focus();
    startInput?.select();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitFor(predicate, { timeout = 8000, interval = 120 } = {}) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let value = null;
        try {
          value = predicate();
        } catch {
          value = null;
        }
        if (value) {
          resolve(value);
          return;
        }
        if (Date.now() - start >= timeout) {
          resolve(null);
          return;
        }
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  function normalizeThreadId(raw) {
    if (!raw) return '';
    let id = String(raw).trim();
    if (id.startsWith('#')) id = id.slice(1);
    if (id.includes(':')) id = id.split(':').pop();
    return id;
  }

  function getListRoot() {
    return (
      document.querySelector('div[gh="tl"]') ||
      document.querySelector('div.aeF') ||
      document.querySelector('div[role="main"]') ||
      document
    );
  }

  /**
   * Unique thread ids from list rows only (never message-ids).
   * Mixing message-ids inflated "12" for 6 emails and slowed downloads.
   */
  function collectThreadIdsFromList() {
    const ids = [];
    const seen = new Set();

    const add = (raw) => {
      const id = normalizeThreadId(raw);
      if (!id || !/^[a-zA-Z0-9_-]{10,}$/.test(id) || seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    };

    const listRoot = getListRoot();
    // Prefer visible inbox/search rows in document order.
    const rows = listRoot.querySelectorAll(
      'table.F tr.zA, div[gh="tl"] tr.zA, tr.zA, div.zA[data-legacy-thread-id], div[role="row"][data-legacy-thread-id]'
    );
    rows.forEach((row) => {
      if (row.closest(`#${EXT.BAR_ID}`)) return;
      add(row.getAttribute('data-legacy-thread-id') || row.getAttribute('data-thread-id'));
      // Nested attr if row wrapper lacks it.
      if (!row.getAttribute('data-legacy-thread-id') && !row.getAttribute('data-thread-id')) {
        const nested = row.querySelector('[data-legacy-thread-id]');
        if (nested) add(nested.getAttribute('data-legacy-thread-id'));
      }
    });

    if (ids.length === 0) {
      listRoot.querySelectorAll('[data-legacy-thread-id]').forEach((el) => {
        if (el.closest(`#${EXT.BAR_ID}`)) return;
        add(el.getAttribute('data-legacy-thread-id'));
      });
    }

    if (ids.length === 0) {
      listRoot.querySelectorAll('a[href*="#"]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        const m = href.match(
          /#(?:search\/[^/]+|inbox|all|sent|starred|label\/[^/]+)\/([a-zA-Z0-9_-]{10,})(?:\/|$)/
        );
        if (m) add(m[1]);
      });
    }

    LOG('unique threads in list:', ids.length, ids);
    return ids;
  }

  function searchHashWithoutThread() {
    const hash = location.hash || '';
    if (!hash.startsWith('#search/')) return null;
    const body = hash.slice('#search/'.length);
    const slash = body.lastIndexOf('/');
    if (slash === -1) return hash;
    const maybeThread = body.slice(slash + 1);
    if (/^[a-zA-Z0-9_-]{10,}$/.test(maybeThread) && !maybeThread.includes('%') && !maybeThread.includes('+')) {
      return `#search/${body.slice(0, slash)}`;
    }
    return hash;
  }

  /**
   * Gmail download_url attr is NOT a bare URL.
   * Formats: mime:filename:url  OR  mime:size:filename:url
   * (url itself contains colons, e.g. https://...)
   */
  function parseGmailDownloadAttr(raw) {
    const s = String(raw || '').trim();
    if (!s || s.startsWith('javascript:')) return null;

    if (/^https?:\/\//i.test(s) || s.startsWith('/mail/')) {
      return { url: s, filename: '', mime: '' };
    }

    let urlStart = s.search(/https?:\/\//i);
    if (urlStart < 0) urlStart = s.search(/\/mail\//);
    if (urlStart < 0) return null;

    const url = s.slice(urlStart);
    const meta = s.slice(0, urlStart).replace(/:$/, '');
    const parts = meta.split(':');
    let mime = '';
    let filename = '';
    if (parts.length >= 3 && /^\d+$/.test(parts[1])) {
      mime = parts[0];
      filename = parts.slice(2).join(':');
    } else if (parts.length >= 2) {
      mime = parts[0];
      filename = parts.slice(1).join(':');
    } else {
      filename = meta;
    }
    return { url, filename: filename.trim(), mime };
  }

  function filenameFromNode(node) {
    if (!node) return '';
    const rawDl = node.getAttribute?.('download_url') || node.getAttribute?.('data-download-url') || '';
    if (rawDl) {
      const parsed = parseGmailDownloadAttr(rawDl);
      if (parsed?.filename) return cleanAttachmentFilename(parsed.filename);
    }
    const attrs = [
      node.getAttribute?.('download'),
      node.getAttribute?.('aria-label'),
      node.getAttribute?.('data-tooltip'),
      node.getAttribute?.('title'),
    ];
    for (const titled of attrs) {
      if (!titled || typeof titled !== 'string') continue;
      if (titled.includes('download_url') || titled.includes('view=att')) {
        const parsed = parseGmailDownloadAttr(titled);
        if (parsed?.filename) return cleanAttachmentFilename(parsed.filename);
        continue;
      }
      if (/\.\w{2,5}\b/.test(titled) || /bmd/i.test(titled)) {
        const m =
          titled.match(/([^\\/\n]+?\.pdf)\b/i) ||
          titled.match(/([^\\/\n]+?\.\w{2,5})\b/i) ||
          titled.match(/([^\n]{3,120})/);
        if (m) return cleanAttachmentFilename(m[1].trim());
      }
    }
    const text = (node.textContent || '').trim().replace(/\s+/g, ' ');
    if (text && text.length < 180) {
      if (/\.\w{2,5}\b/.test(text) || /bmd/i.test(text) || /^\d{5,}/.test(text)) {
        const m = text.match(/([^\\/\s]+\.pdf)\b/i) || text.match(/([^\\/\s]+\.\w{2,5})\b/i);
        if (m) return cleanAttachmentFilename(m[1].trim());
        // Truncated list chips: "1716249I BMD P..."
        return cleanAttachmentFilename(text.replace(/\.\.\.$/, '').trim());
      }
    }
    return '';
  }

  /** Cached Gmail account key (ik) for silent thread fetches. */
  let cachedGmailIk = '';

  function findIkInText(text) {
    if (!text) return '';
    const fromQuery = text.match(/[?&]ik=([a-zA-Z0-9_-]{8,})/);
    if (fromQuery) return fromQuery[1];
    const fromJson = text.match(/"ik"\s*:\s*"([a-zA-Z0-9_-]{8,})"/);
    if (fromJson) return fromJson[1];
    // GLOBALS[9] is typically the ik string.
    const gm = text.match(
      /GLOBALS\s*=\s*\[[^\]]*?(?:,\s*(?:null|undefined|"[^"]*"|'[^']*'|\d+|true|false|\[[^\]]*\])){8},\s*["']([a-zA-Z0-9_-]{8,})["']/
    );
    if (gm) return gm[1];
    return '';
  }

  function findIkInDom(root = document) {
    const nodes = root.querySelectorAll(
      'a[href*="ik="], [download_url*="ik="], [data-download-url*="ik="], form[action*="ik="], img[src*="ik="]'
    );
    for (const el of nodes) {
      for (const attr of ['href', 'download_url', 'data-download-url', 'action', 'src']) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        const m = v.match(/[?&]ik=([a-zA-Z0-9_-]{8,})/);
        if (m) return m[1];
      }
    }
    for (const s of root.querySelectorAll('script:not([src])')) {
      const ik = findIkInText(s.textContent || '');
      if (ik) return ik;
    }
    return '';
  }

  async function resolveGmailIk() {
    if (cachedGmailIk) return cachedGmailIk;
    const fromDom = findIkInDom(document);
    if (fromDom) {
      cachedGmailIk = fromDom;
      return cachedGmailIk;
    }
    // Page-world GLOBALS[9] (content script cannot read it directly).
    const fromPage = await new Promise((resolve) => {
      const bridge = `hagap-bmds-ik-${Date.now()}`;
      const onMsg = (event) => {
        if (event.source !== window || !event.data || event.data.source !== bridge) return;
        window.removeEventListener('message', onMsg);
        resolve(String(event.data.ik || ''));
      };
      window.addEventListener('message', onMsg);
      try {
        const script = document.createElement('script');
        script.textContent = `(() => {
          let ik = '';
          try { if (typeof GLOBALS !== 'undefined' && GLOBALS && GLOBALS[9]) ik = String(GLOBALS[9]); } catch (e) {}
          window.postMessage({ source: '${bridge}', ik }, '*');
        })();`;
        (document.documentElement || document.head).appendChild(script);
        script.remove();
      } catch {
        window.removeEventListener('message', onMsg);
        resolve('');
      }
      setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve('');
      }, 600);
    });
    if (fromPage) {
      cachedGmailIk = fromPage;
      return cachedGmailIk;
    }
    try {
      const res = await fetch(`${location.origin}${getAccountPath()}`, {
        credentials: 'include',
        cache: 'force-cache',
      });
      const html = await res.text();
      const fromHtml = findIkInText(html);
      if (fromHtml) {
        cachedGmailIk = fromHtml;
        return cachedGmailIk;
      }
    } catch (err) {
      LOG('ik resolve failed', err);
    }
    return '';
  }

  function buildGmailAttUrl(threadOrMsgId, attid, ik = cachedGmailIk) {
    const u = new URL(`${location.origin}${getAccountPath()}`);
    u.searchParams.set('ui', '2');
    u.searchParams.set('view', 'att');
    u.searchParams.set('th', threadOrMsgId);
    u.searchParams.set('attid', attid);
    u.searchParams.set('disp', 'safe');
    u.searchParams.set('zw', '1');
    if (ik) u.searchParams.set('ik', ik);
    return u.toString();
  }

  async function mapPool(items, concurrency, worker) {
    const results = new Array(items.length);
    let next = 0;
    let done = 0;
    const run = async () => {
      while (next < items.length) {
        const idx = next;
        next += 1;
        results[idx] = await worker(items[idx], idx);
        done += 1;
        if (typeof worker.onProgress === 'function') worker.onProgress(done, items.length);
      }
    };
    const n = Math.max(1, Math.min(concurrency, items.length || 1));
    await Promise.all(Array.from({ length: n }, () => run()));
    return results;
  }

  /** Strip UI junk like "PDF Viewer" glued onto filenames ("….pdfVi"). */
  function cleanAttachmentFilename(name) {
    if (!name || typeof name !== 'string') return '';
    let n = name.replace(/\s+/g, ' ').trim();
    n = n.replace(/\.\.\.$/, '').trim();
    // "foo.pdf Viewer" / "foo.pdfVi" / "foo.pdfVisualizar"
    n = n.replace(/\.pdf\s*(viewer|visualizar|visão|visao).*$/i, '.pdf');
    n = n.replace(/\.pdfvi\b/i, '.pdf');
    n = n.replace(/\s+(viewer|visualizar|download|baixar)\s*$/i, '');
    // Generic chip labels that are not real filenames.
    if (/^(anexo|attachment|download|baixar|pdf)s?\b/i.test(n) && !/\.\w{2,5}$/i.test(n)) {
      return '';
    }
    return n.slice(0, 160);
  }

  function filenameQuality(name) {
    const n = (name || '').toLowerCase();
    if (!n) return 0;
    let score = 1;
    if (/\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z)$/i.test(n)) score += 4;
    if (n.includes('bmd')) score += 3;
    if (/^\d{5,}/.test(n)) score += 2;
    if (/^anexo([-_]?\d*)?(\.pdf)?$/i.test(n)) score -= 4;
    if (/pdfvi|viewer/i.test(n)) score -= 5;
    if (n.endsWith('...')) score -= 2;
    return score;
  }

  function isRealGmailAttachmentUrl(url) {
    const href = (url || '').toLowerCase();
    if (!href) return false;
    // Preview / thumbnail / page-render surfaces (not the downloadable attachment).
    if (
      href.includes('view=att') === false &&
      href.includes('attid=') === false &&
      !href.includes('googleusercontent.com/attachment')
    ) {
      return false;
    }
    if (/[?&]disp=(inline|emb|thd|thumb)/i.test(href)) return false;
    if (/[?&]view=(fimg|attimg|img|bv)/i.test(href)) return false;
    if (/cid:|disp=iv|safe=0/i.test(href)) return false;
    // Prefer authentic download URLs.
    return (
      href.includes('view=att') ||
      href.includes('attid=') ||
      href.includes('googleusercontent.com/attachment')
    );
  }

  function isBmdLikeAttachment(filename, url) {
    const name = cleanAttachmentFilename(filename || '').toLowerCase();
    const href = (url || '').toLowerCase();

    if (/\.(png|jpe?g|gif|webp|bmp|svg|ico)(\b|$)/i.test(name)) return false;
    if (/[?&]view=(fimg|attimg|img)/i.test(href)) return false;

    const realAtt = isRealGmailAttachmentUrl(href);
    if (realAtt) {
      // Named image chips with att URLs still happen; keep only docs/PDF/BMD-ish.
      if (name && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) return false;
      if (!name) return true;
      if (name.includes('bmd')) return true;
      if (/\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z)$/i.test(name)) return true;
      if (/^\d{5,}/.test(name)) return true;
      // Generic "anexo" from probe / missing label: allow if URL is view=att.
      if (/^anexo/.test(name) && href.includes('view=att')) return true;
      return href.includes('view=att') && href.includes('attid=');
    }

    if (name.includes('bmd')) return true;
    if (name.endsWith('.pdf') || href.includes('.pdf') || href.includes('application%2fpdf')) return true;
    if (/\.(docx?|xlsx?|pptx?|zip|rar|7z)$/i.test(name)) return true;
    if (/^\d{5,}/.test(name) && /bmd|pdf/i.test(name)) return true;
    return false;
  }

  function absolutizeUrl(href) {
    if (!href) return '';
    try {
      if (href.startsWith('?')) {
        return new URL(`${getAccountPath()}${href}`, location.origin).toString();
      }
      return new URL(href, `${location.origin}${getAccountPath()}`).toString();
    } catch {
      return '';
    }
  }

  /** Identity = th + attid (filename must NOT inflate the count). */
  function attachmentKey(url, _filename) {
    try {
      const u = new URL(url, location.origin);
      const th = u.searchParams.get('th') || '';
      const attid = u.searchParams.get('attid') || '';
      if (th && attid) return `${th}|${attid}`;
      if (attid) return `attid:${attid}|${u.pathname}`;
      if (th) return `th:${th}|${u.searchParams.get('disp') || ''}|${(u.searchParams.get('realattid') || '')}`;
      // googleusercontent: path is usually unique per file.
      return `${u.origin}${u.pathname}`;
    } catch {
      return String(url || '');
    }
  }

  function normalizeFilenameKey(name) {
    return cleanAttachmentFilename(name)
      .toLowerCase()
      .replace(/[_\s]+/g, ' ')
      .replace(/\.pdf$/i, '')
      .trim();
  }

  function resolveRawDownloadCandidate(raw) {
    if (!raw || raw.startsWith('javascript:')) return { url: '', filename: '' };
    const parsed = parseGmailDownloadAttr(raw);
    if (parsed?.url) return { url: parsed.url, filename: parsed.filename || '' };
    if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return { url: raw, filename: '' };
    return { url: '', filename: '' };
  }

  function extractDownloadUrlFromEl(el) {
    if (!el) return '';
    for (const attr of ['download_url', 'data-download-url', 'href', 'data-url']) {
      const raw = el.getAttribute?.(attr) || '';
      const resolved = resolveRawDownloadCandidate(raw);
      if (resolved.url) return resolved.url;
    }

    const nested = el.querySelector?.(
      '[download_url], [data-download-url], a[href*="view=att"], a[href*="attid="], a[href*="disp=safe"], a[download]'
    );
    if (nested) {
      for (const attr of ['download_url', 'data-download-url', 'href', 'download']) {
        const raw = nested.getAttribute(attr) || '';
        const resolved = resolveRawDownloadCandidate(raw);
        if (resolved.url) return resolved.url;
      }
    }
    return '';
  }

  function threadIdFromUrl(url) {
    try {
      return new URL(url, location.origin).searchParams.get('th') || '';
    } catch {
      return '';
    }
  }

  function pushAttachment(bag, seen, url, filename, meta = {}) {
    const abs = toGmailDownloadUrl(url);
    if (!abs || !/^https?:/i.test(abs)) return false;
    if (!isRealGmailAttachmentUrl(abs) && !isBmdLikeAttachment(filename, abs)) return false;
    if (!isBmdLikeAttachment(filename, abs)) return false;

    const cleaned = cleanAttachmentFilename(filename);
    const key = attachmentKey(abs, cleaned);
    if (!key) return false;

    if (seen.has(key)) {
      // Same th|attid already queued: keep the better filename only.
      const existing = bag.find((x) => attachmentKey(x.url, x.filename) === key);
      if (existing && filenameQuality(cleaned) > filenameQuality(existing.filename)) {
        existing.filename = cleaned;
      }
      return false;
    }

    // Secondary dedupe: same thread + same normalized display name.
    const th = meta.threadId || threadIdFromUrl(abs) || '';
    const nameKey = normalizeFilenameKey(cleaned);
    if (th && nameKey && nameKey.length >= 6) {
      const nameSeenKey = `name:${th}|${nameKey}`;
      if (seen.has(nameSeenKey)) return false;
      seen.add(nameSeenKey);
    }

    seen.add(key);
    bag.push({
      url: abs,
      filename: cleaned || '',
      threadId: th,
      threadIndex: meta.threadIndex != null ? meta.threadIndex : -1,
    });
    return true;
  }

  /** Force authentic Gmail attachment download URL (disp=safe), absolute. */
  function toGmailDownloadUrl(href) {
    const parsed = parseGmailDownloadAttr(href);
    const candidate = parsed?.url || href;
    const abs = absolutizeUrl(candidate);
    if (!abs) return '';
    try {
      const u = new URL(abs);
      if (
        u.hostname.includes('mail.google.com') ||
        u.hostname.includes('googleusercontent.com')
      ) {
        // Drop preview/thumbnail display modes; always ask for the real file.
        const disp = (u.searchParams.get('disp') || '').toLowerCase();
        if (disp === 'inline' || disp === 'emb' || disp === 'thd' || disp === 'thumb') {
          u.searchParams.set('disp', 'safe');
        } else if (!disp) {
          u.searchParams.set('disp', 'safe');
        } else {
          u.searchParams.set('disp', 'safe');
        }
        if (u.searchParams.get('view') === 'att' || u.searchParams.has('attid')) {
          u.searchParams.set('view', 'att');
        }
      }
      return u.toString();
    } catch {
      return abs;
    }
  }

  /** Conversation pane (exclude inbox list when possible). */
  function getConversationRoot() {
    return (
      document.querySelector('div[role="main"] .nH.if') ||
      document.querySelector('.nH.if') ||
      document.querySelector('div.aeJ .nH.if') ||
      document.querySelector('[role="main"]') ||
      document
    );
  }

  /** Scrape download_url / att links currently in the DOM (list or conversation). */
  function collectAttachmentDownloadsFromDom(root = document, meta = {}) {
    /** @type {{url: string, filename: string, threadId?: string, threadIndex?: number}[]} */
    const found = [];
    const seen = new Set();
    const wantThread = meta.threadId || '';

    const consider = (url, filename) => {
      if (!url) return;
      if (wantThread) {
        const th = threadIdFromUrl(toGmailDownloadUrl(url) || url);
        // Skip attachments clearly belonging to another thread.
        if (th && th !== wantThread) return;
      }
      pushAttachment(found, seen, url, filename, meta);
    };

    root.querySelectorAll('[download_url], [data-download-url]').forEach((el) => {
      const raw = el.getAttribute('download_url') || el.getAttribute('data-download-url') || '';
      const parsed = parseGmailDownloadAttr(raw) || resolveRawDownloadCandidate(raw);
      if (!parsed?.url) return;
      consider(parsed.url, parsed.filename || filenameFromNode(el));
    });

    root
      .querySelectorAll(
        'a[href*="view=att"], a[href*="attid="], a[href*="disp=safe"], a[href*="googleusercontent.com/attachment"], a[download]'
      )
      .forEach((a) => {
        const href = a.getAttribute('href') || '';
        const resolved = resolveRawDownloadCandidate(href);
        if (!resolved.url) return;
        consider(resolved.url, a.getAttribute('download') || filenameFromNode(a));
      });

    root
      .querySelectorAll(
        '.aZo, .aQH, .aQy, .aZp, .aZi, .brc, .aQw, span.aV3, span.a3I, span.aKS, div[data-tooltip*="Download" i], div[aria-label*="Download" i], div[aria-label*="Baixar" i]'
      )
      .forEach((card) => {
        const url = extractDownloadUrlFromEl(card) || extractDownloadUrlFromEl(card.closest('a'));
        const name =
          filenameFromNode(card.querySelector?.('.aV3, span.a3I, span.aKS, [download_url], span[download]')) ||
          filenameFromNode(card);
        if (url) consider(url, name);
      });

    found.sort((a, b) => {
      const score = (x) => {
        const n = (x.filename || '').toLowerCase();
        if (n.includes('bmd')) return 0;
        if (n.endsWith('.pdf')) return 1;
        return 2;
      };
      return score(a) - score(b);
    });

    return found;
  }

  function collectAttachmentDownloadsFromOpenMessage(threadId = '') {
    const root = threadId ? getConversationRoot() : document;
    return collectAttachmentDownloadsFromDom(root, threadId ? { threadId } : {});
  }

  /** Attachments in open conversation that belong to this thread (th=). */
  function collectAttachmentsForOpenThread(threadId) {
    if (!threadId) return collectAttachmentDownloadsFromOpenMessage();
    const root = getConversationRoot();
    const all = collectAttachmentDownloadsFromDom(root, { threadId });
    const matched = all.filter((a) => {
      const th = a.threadId || threadIdFromUrl(a.url);
      return !th || th === threadId;
    });
    // Prefer strict th= matches when any exist (avoids stale other-thread chips).
    const strict = matched.filter((a) => (a.threadId || threadIdFromUrl(a.url)) === threadId);
    return strict.length > 0 ? strict : matched;
  }

  /** True only for truncated-chip expand labels (Mais… / More…), not attachment names. */
  function isMaisExpandLabel(text) {
    const t = String(text || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (!t || t.length > 24) return false;
    // Exact-ish: "mais", "mais...", "mais…", "more (3)" — never "view attachment" / file names.
    return /^(mais|more)(\s*[.…]+)?$/.test(t) || /^(mais|more)\s*\(\d+\)$/.test(t);
  }

  /** Href that would open a Gmail thread from the list. */
  function isThreadNavigatingHref(href) {
    const h = String(href || '');
    if (!h || h === '#' || h.startsWith('javascript:')) return false;
    return /#(?:search\/[^/]+|inbox|all|sent|starred|label\/[^/]+)\/[a-zA-Z0-9_-]{10,}(?:\/|$)/.test(
      h
    );
  }

  /**
   * Click Mais… without letting the event activate the list row (opens first/that email).
   */
  function clickExpandChipSafe(el) {
    if (!el || el.nodeType !== 1) return;
    const stopBubble = (e) => {
      e.stopPropagation();
    };
    // Stop at the chip so tr.zA never sees the click (Gmail opens the thread on row click).
    el.addEventListener('mousedown', stopBubble, true);
    el.addEventListener('mouseup', stopBubble, true);
    el.addEventListener('click', stopBubble, true);
    try {
      el.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window })
      );
      el.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window })
      );
      el.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
      );
    } catch {
      try {
        el.click();
      } catch {
        /* ignore */
      }
    } finally {
      el.removeEventListener('mousedown', stopBubble, true);
      el.removeEventListener('mouseup', stopBubble, true);
      el.removeEventListener('click', stopBubble, true);
    }
  }

  /**
   * Expand truncated list chips ("Mais…") only.
   * Never click attachment chips, "view attachment", or thread links (those open the email).
   */
  function clickExpandAttachmentUi(root = document, { listOnly = false } = {}) {
    const scope = root || document;
    const candidates = Array.from(
      scope.querySelectorAll(
        'span.brc, span.aV3, span.a3I, span.aKS, span[role="link"], div[role="button"], span, button'
      )
    );

    /** Prefer innermost nodes whose own text is Mais/More. */
    const nodes = candidates.filter((el) => {
      if (el.closest(`#${EXT.BAR_ID}`)) return false;
      const own =
        (el.getAttribute('aria-label') || '').trim() ||
        Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent || '')
          .join('')
          .trim() ||
        (el.childElementCount === 0 ? (el.textContent || '').trim() : '');
      if (!isMaisExpandLabel(own) && !isMaisExpandLabel(el.getAttribute('aria-label') || '')) {
        // Fallback: short textContent when leaf-like.
        if (el.childElementCount > 0) return false;
        if (!isMaisExpandLabel(el.textContent || '')) return false;
      }
      const link = el.closest('a[href]');
      if (link && isThreadNavigatingHref(link.getAttribute('href'))) return false;
      if (listOnly) {
        const row = el.closest(
          'tr.zA, div.zA[data-legacy-thread-id], div[role="row"][data-legacy-thread-id]'
        );
        if (!row) return false;
      }
      return true;
    });

    // Dedupe: skip ancestors of an already-selected chip.
    const chosen = [];
    for (const el of nodes) {
      if (chosen.some((c) => c.contains(el) || el.contains(c))) {
        if (chosen.some((c) => c.contains(el))) continue;
        // Prefer deeper node: replace ancestor.
        for (let i = chosen.length - 1; i >= 0; i -= 1) {
          if (el.contains(chosen[i])) chosen.splice(i, 1);
        }
      }
      chosen.push(el);
      if (chosen.length >= 48) break;
    }

    LOG('expand Mais chips:', chosen.length, listOnly ? '(list only)' : '');
    for (const el of chosen) {
      if (listOnly) clickExpandChipSafe(el);
      else {
        try {
          el.click();
        } catch {
          /* ignore */
        }
      }
    }
  }

  async function scrapeAttachmentsFast({ timeout = 2200, threadId = '' } = {}) {
    const root = threadId ? getConversationRoot() : document;
    clickExpandAttachmentUi(root);
    await waitFor(() => collectAttachmentsForOpenThread(threadId).length > 0, {
      timeout,
      interval: 60,
    });
    if (collectAttachmentsForOpenThread(threadId).length === 0) {
      clickExpandAttachmentUi(root);
      await waitFor(() => collectAttachmentsForOpenThread(threadId).length > 0, {
        timeout: 900,
        interval: 60,
      });
    }
    return collectAttachmentsForOpenThread(threadId);
  }

  function threadIdFromRow(row) {
    if (!row) return '';
    return normalizeThreadId(
      row.getAttribute('data-legacy-thread-id') ||
        row.getAttribute('data-thread-id') ||
        row.querySelector?.('[data-legacy-thread-id]')?.getAttribute('data-legacy-thread-id') ||
        ''
    );
  }

  function collectListRowElements() {
    const listRoot = getListRoot();
    const rows = Array.from(
      listRoot.querySelectorAll(
        'table.F tr.zA, div[gh="tl"] tr.zA, tr.zA, div.zA[data-legacy-thread-id], div[role="row"][data-legacy-thread-id]'
      )
    ).filter((row) => !row.closest(`#${EXT.BAR_ID}`));
    return rows;
  }

  /** Walk Gmail cv/pt payloads for attachment URLs + filenames. */
  function walkCollectAtts(node, out, depth = 0) {
    if (node == null || depth > 40) return;

    if (typeof node === 'string') {
      if (node.includes('view=att') || (node.includes('disp=safe') && node.includes('attid='))) {
        out.push({ url: node, filename: '' });
      } else {
        const parsed = parseGmailDownloadAttr(node);
        if (parsed?.url) out.push({ url: parsed.url, filename: parsed.filename || '' });
      }
      return;
    }

    if (Array.isArray(node)) {
      // Classic attachment row: [attid, name, mime, size, ..., relativeUrl]
      if (
        node.length >= 4 &&
        typeof node[0] === 'string' &&
        typeof node[1] === 'string' &&
        typeof node[2] === 'string' &&
        node[2].includes('/') &&
        (typeof node[3] === 'number' || (typeof node[3] === 'string' && /^\d+$/.test(node[3])))
      ) {
        const name = node[1];
        const urlPart = node.find(
          (x) =>
            typeof x === 'string' &&
            (x.includes('view=att') || x.includes('attid=') || (x.startsWith('?') && x.includes('ui=')))
        );
        if (urlPart && (/\.\w{2,5}$/i.test(name) || /bmd/i.test(name) || /pdf/i.test(node[2]))) {
          out.push({ url: urlPart, filename: name });
        }
      }
      for (const child of node) walkCollectAtts(child, out, depth + 1);
      return;
    }

    if (typeof node === 'object') {
      for (const child of Object.values(node)) walkCollectAtts(child, out, depth + 1);
    }
  }

  function parseAttachmentsFromResponseText(text, threadId) {
    /** @type {{url: string, filename: string}[]} */
    const bag = [];
    const seen = new Set();

    const push = (url, filename) => {
      if (!url) return;
      let abs = url;
      if (url.startsWith('?') || url.startsWith('/mail/')) {
        abs = absolutizeUrl(url.startsWith('?') ? `${getAccountPath()}${url}` : url);
      }
      pushAttachment(bag, seen, abs, filename || '', { threadId });
    };

    try {
      const start = text.indexOf('[');
      if (start >= 0) {
        const json = JSON.parse(text.slice(start));
        const collected = [];
        walkCollectAtts(json, collected);
        for (const item of collected) push(item.url, item.filename);
      }
    } catch {
      /* soft-fail; regex below */
    }

    for (const m of text.matchAll(
      /(?:https?:\/\/mail\.google\.com)?(?:\/mail\/u\/\d+\/?)?\?[^"'\\\s<>]*view=att[^"'\\\s<>]*/gi
    )) {
      push(m[0], '');
    }

    for (const m of text.matchAll(
      /(?:application\/pdf|application\/octet-stream)(?::\d+)?:([^:]+):(https?:\/\/[^"'\\\s]+)/gi
    )) {
      push(m[2], m[1]);
    }

    for (const m of text.matchAll(/download_url=(?:\\?"|["'])([^"'\\]+)(?:\\?"|["'])/gi)) {
      const parsed = parseGmailDownloadAttr(m[1].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&'));
      if (parsed?.url) push(parsed.url, parsed.filename);
    }

    // Last resort: attid tokens alone (validated later only via probe path when bag empty).
    // Do NOT push unvalidated probe URLs here; that inflated counts (misses still had URLs).
    return bag;
  }

  /**
   * Same-origin authenticated fetch of thread data. Does NOT change location.hash.
   */
  async function fetchThreadAttachmentsSilent(threadId, ik) {
    if (!threadId) return [];
    const base = `${location.origin}${getAccountPath()}`;
    const attempts = [
      (() => {
        const p = new URLSearchParams({
          ui: '2',
          view: 'cv',
          th: threadId,
          msgs: '',
          mb: '0',
          rt: '1',
          search: 'all',
        });
        if (ik) p.set('ik', ik);
        return `${base}?${p.toString()}`;
      })(),
      (() => {
        const p = new URLSearchParams({
          ui: '2',
          view: 'pt',
          search: 'all',
          th: threadId,
        });
        if (ik) p.set('ik', ik);
        return `${base}?${p.toString()}`;
      })(),
    ];

    for (const url of attempts) {
      try {
        const res = await fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
        if (!res.ok) continue;
        const text = await res.text();
        const ikFromBody = findIkInText(text);
        if (ikFromBody && !cachedGmailIk) cachedGmailIk = ikFromBody;
        const found = parseAttachmentsFromResponseText(text, threadId);
        if (found.length > 0) return found;
      } catch (err) {
        LOG('silent fetch attempt failed', threadId, err);
      }
    }
    return [];
  }

  /**
   * Discover attachments for all visible list threads WITHOUT opening any email
   * in the Gmail SPA (no location.hash thrashing / row clicks).
   */
  async function discoverAllAttachments(threadIds) {
    /** @type {{url: string, filename: string, threadId?: string, threadIndex?: number}[]} */
    const all = [];
    const seen = new Set();
    const startHash = location.hash || '';
    const totalEmails = threadIds.length;

    // Discovery phase only (never file progress here; total attachments still unknown).
    setBarStatus(`Procurando anexos nos e-mails… 0 de ${totalEmails}`);
    showToast(`Procurando anexos nos e-mails… 0 de ${totalEmails}`);

    // Do NOT click Mais/attachment chips on the list: any row click (or broad
    // "mais*" match like "Mais ações") opens the first/that email in Gmail.
    // Filenames still come from visible chips + silent cv/pt fetch + attid probe.
    LOG('list discovery: skip chip clicks (stay on search list)');

    /** @type {Map<string, {names: string[], chipHint: number}>} */
    const rowMeta = new Map();
    const rows = collectListRowElements();
    rows.forEach((row, i) => {
      const tid = threadIdFromRow(row) || threadIds[i] || '';
      const idx = tid ? threadIds.indexOf(tid) : i;
      const names = [];
      row.querySelectorAll('.brc, .aV3, span.a3I, span.aKS, [download_url], [data-download-url]').forEach((el) => {
        const t = (el.textContent || '').trim();
        if (/^mai/i.test(t) || /^more/i.test(t)) return;
        const name = filenameFromNode(el) || t;
        if (name && name.length < 140 && !/^mai/i.test(name)) names.push(name);
      });
      const hasMore = /mai\.\.\.|mais|more/i.test(row.textContent || '');
      if (tid) {
        rowMeta.set(tid, {
          names,
          chipHint: Math.max(names.length, names.length + (hasMore ? 3 : 0), 1),
        });
      }
      mergeAttachments(all, seen, collectAttachmentDownloadsFromDom(row, {
        threadId: tid,
        threadIndex: idx >= 0 ? idx : i,
      }));
    });
    mergeAttachments(all, seen, collectAttachmentDownloadsFromDom(getListRoot()));
    LOG('list-view attachments (provisional, not for Baixando UI):', all.length, 'hash:', location.hash);

    const ik = await resolveGmailIk();
    LOG('gmail ik:', ik ? `${ik.slice(0, 4)}…` : '(none)');

    let completed = 0;
    setBarStatus(`Procurando anexos nos e-mails… 0 de ${totalEmails}`);

    await mapPool(threadIds, 4, async (threadId, i) => {
      let found = await fetchThreadAttachmentsSilent(threadId, ik || cachedGmailIk);
      let added = mergeAttachments(all, seen, found, { threadId, threadIndex: i });

      const meta = rowMeta.get(threadId);
      const haveForThread = all.filter((a) => (a.threadId || threadIdFromUrl(a.url)) === threadId).length;
      // Only probe when silent/DOM found nothing. Never pad attid guesses on top of real finds.
      if (haveForThread === 0) {
        const need = meta ? Math.min(Math.max(meta.names.length, meta.chipHint || 1), 12) : 6;
        const probed = await probeAttIdsForThread(
          threadId,
          ik || cachedGmailIk,
          need,
          meta?.names || [],
          i
        );
        added += mergeAttachments(all, seen, probed, { threadId, threadIndex: i });
      } else if (meta?.names?.length) {
        // Upgrade blank/generic names from chip labels when attid order matches.
        upgradeFilenamesFromChipNames(
          all.filter((a) => (a.threadId || threadIdFromUrl(a.url)) === threadId),
          meta.names
        );
      }

      completed += 1;
      LOG(`silent ${completed}/${totalEmails}: +${added} (total ${all.length})`, threadId);
      setBarStatus(`Procurando anexos nos e-mails… ${completed} de ${totalEmails}`);
      if (completed === 1 || completed === totalEmails || completed % 2 === 0) {
        showToast(`Procurando anexos nos e-mails… ${completed} de ${totalEmails}`);
      }
      if ((location.hash || '') !== startHash) {
        LOG('hash changed during silent discovery (not by us):', location.hash);
      }
      return added;
    });

    for (const item of all) {
      const th = item.threadId || threadIdFromUrl(item.url);
      if (!th) continue;
      const idx = threadIds.indexOf(th);
      if (idx >= 0) item.threadIndex = idx;
    }

    setBarStatus('Coletando…');
    LOG(
      'discovery complete:',
      all.length,
      'attachments across',
      totalEmails,
      'emails; hash still',
      location.hash,
      'unchanged?',
      (location.hash || '') === startHash
    );
    const finalized = finalizeDiscoveredAttachments(all);
    LOG(
      'unique attachments for ZIP:',
      finalized.length,
      finalized.map((a) => a.filename || '(sem nome)')
    );
    return finalized;
  }

  function upgradeFilenamesFromChipNames(items, names) {
    if (!items?.length || !names?.length) return;
    const cleanedNames = names.map(cleanAttachmentFilename).filter(Boolean);
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const chip = cleanedNames[i] || '';
      if (!chip) continue;
      if (filenameQuality(chip) > filenameQuality(item.filename)) {
        item.filename = chip;
      }
    }
  }

  /** Final pass: dedupe by th|attid and by normalized filename within a thread. */
  function finalizeDiscoveredAttachments(items) {
    const byKey = new Map();
    for (const item of items) {
      const key = attachmentKey(item.url, item.filename);
      if (!key) continue;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, { ...item, filename: cleanAttachmentFilename(item.filename) });
        continue;
      }
      if (filenameQuality(item.filename) > filenameQuality(prev.filename)) {
        prev.filename = cleanAttachmentFilename(item.filename);
      }
      if (prev.threadIndex < 0 && item.threadIndex >= 0) prev.threadIndex = item.threadIndex;
    }

    const out = [];
    const nameSeen = new Set();
    for (const item of byKey.values()) {
      const th = item.threadId || threadIdFromUrl(item.url) || '';
      const nk = normalizeFilenameKey(item.filename);
      if (th && nk && nk.length >= 6) {
        const nameKey = `name:${th}|${nk}`;
        if (nameSeen.has(nameKey)) continue;
        nameSeen.add(nameKey);
      }
      out.push(item);
    }
    out.sort((a, b) => {
      const ti = (a.threadIndex ?? 0) - (b.threadIndex ?? 0);
      if (ti !== 0) return ti;
      return filenameQuality(b.filename) - filenameQuality(a.filename);
    });
    return out;
  }

  /** Probe attid=0.1..N only when DOM/cv found nothing. Validate each URL before keeping it. */
  async function probeAttIdsForThread(threadId, ik, chipCount, names, threadIndex) {
    const bag = [];
    const seen = new Set();
    const max = Math.min(Math.max(chipCount || 1, 1), 12);
    cachedGmailIk = ik || cachedGmailIk;
    let misses = 0;

    for (let i = 1; i <= max; i += 1) {
      const url = buildGmailAttUrl(threadId, `0.${i}`, ik);
      const ok = await validateAttachmentUrl(url);
      if (!ok) {
        misses += 1;
        // Stop after consecutive misses (attids are contiguous).
        if (misses >= 2 && bag.length > 0) break;
        if (misses >= 3 && bag.length === 0) break;
        continue;
      }
      misses = 0;
      let filename = cleanAttachmentFilename((names && names[i - 1]) || '');
      if (filename && !/\.\w{2,5}$/i.test(filename)) {
        filename = `${filename.replace(/\.\.\.$/, '')}.pdf`;
      }
      if (!filename) filename = `anexo-${i}.pdf`;
      pushAttachment(bag, seen, url, filename, { threadId, threadIndex });
    }
    LOG('probe urls kept', threadId.slice(0, 8), bag.length, 'of max', max);
    return bag;
  }

  /** Fail fast: real attachment should be PDF/doc bytes, not HTML error/preview. */
  async function validateAttachmentUrl(url) {
    const abs = toGmailDownloadUrl(url);
    if (!abs || !isRealGmailAttachmentUrl(abs)) return false;
    try {
      const res = await fetch(abs, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
        headers: { Range: 'bytes=0-3' },
      });
      if (!(res.ok || res.status === 206)) return false;
      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      if (ctype.includes('text/html')) return false;
      if (ctype.includes('image/') && !ctype.includes('pdf')) return false;
      // PDF magic "%PDF" when we got a body slice.
      try {
        const buf = await res.arrayBuffer();
        if (buf && buf.byteLength >= 4) {
          const sig = String.fromCharCode(...new Uint8Array(buf).slice(0, 4));
          if (sig === '%PDF') return true;
          // Non-PDF office/zip docs still OK if content-type says so.
          if (/application\/(pdf|octet-stream|zip|msword|vnd\.)/i.test(ctype)) return true;
          // Empty/HTML often starts with "<" or "{".
          if (sig.startsWith('<') || sig.startsWith('{')) return false;
        }
      } catch {
        /* headers alone */
      }
      if (/application\/(pdf|octet-stream|zip|msword|vnd\.)/i.test(ctype)) return true;
      // Gmail sometimes omits content-type on Range responses; treat 206 as likely ok.
      return res.status === 206 || res.ok;
    } catch {
      return false;
    }
  }

  async function downloadBmdsFromResults() {
    if (downloadBusy) return;

    setDownloadBusy(true);
    setBarStatus('Preparando…');
    showToast('Preparando download dos BMDs…');
    const startHash = location.hash || '';
    // Prefer list hash without any accidental thread suffix.
    const listHash = searchHashWithoutThread() || startHash;

    try {
      await waitFor(() => collectThreadIdsFromList().length > 0, { timeout: 2000, interval: 80 });
      const threadIds = collectThreadIdsFromList();
      LOG('download start — threads:', threadIds.length, 'hash:', startHash);

      // Discovery only: never show file progress until every thread is scanned.
      let items = [];
      if (threadIds.length === 0) {
        // Already inside a conversation pane (no list rows).
        setBarStatus('Coletando…');
        showToast('Coletando anexos…');
        clickExpandAttachmentUi(document, { listOnly: false });
        items = finalizeDiscoveredAttachments(await scrapeAttachmentsFast({ timeout: 2500 }));
      } else {
        items = await discoverAllAttachments(threadIds);
      }

      // Freeze queue after full discovery so progress total cannot jump mid-download.
      const downloadQueue = items.slice();
      const totalAttachments = downloadQueue.length;

      LOG(
        'download queue:',
        totalAttachments,
        'files →',
        downloadQueue.map((a) => `${a.threadIndex >= 0 ? a.threadIndex + 1 : '?'}:${a.filename || '(sem nome)'}`)
      );

      // Stay on search list: never leave a thread hash after discovery.
      const wantHash = listHash;
      if ((location.hash || '') !== wantHash) {
        LOG('restoring search list hash after discovery', location.hash, '→', wantHash);
        location.hash = wantHash;
        await sleep(80);
      }

      if (totalAttachments === 0) {
        setBarStatus('Nenhum anexo encontrado');
        showToast('Nenhum anexo encontrado');
        LOG('no attachments found after scan');
        return;
      }

      if (totalAttachments === 1) {
        setBarStatus('Baixando arquivos… 1 de 1');
        showToast('Baixando 1 arquivo via Gmail…');
        const result = await downloadItemsViaGoogle(downloadQueue, {
          onProgress: (done, total) => setBarStatus(`Baixando arquivos… ${done} de ${total}`),
        });
        const msg = `Baixados ${result.downloaded} de ${result.found} anexo(s).`;
        setBarStatus(msg);
        showToast(msg + ' Confira a pasta Downloads.');
        LOG(msg);
        return;
      }

      setBarStatus(`Baixando arquivos… 0 de ${totalAttachments}`);
      showToast(`Baixando ${totalAttachments} arquivos e gerando ZIP…`);

      const result = await downloadItemsAsZip(downloadQueue, {
        total: totalAttachments,
        onProgress: (phase, done, total) => {
          if (phase === 'zip') {
            setBarStatus('Gerando ZIP…');
            showToast('Gerando ZIP…');
            return;
          }
          const t = totalAttachments || total;
          setBarStatus(`Baixando arquivos… ${done} de ${t}`);
          if (done === 0 || done === t || done % 5 === 0) {
            showToast(`Baixando arquivos… ${done} de ${t}`);
          }
        },
      });

      if (!result.zipOk) {
        const reason = classifyDownloadError(result.error || 'nenhum arquivo salvo');
        const errMsg = `Falha ao baixar ZIP: ${reason}`;
        setBarStatus(`Falha no download: ${reason}`);
        showToast(errMsg);
        console.error('[Hagap BMDs]', errMsg, result);
        return;
      }

      const toastMsg = formatZipResultMessage(result);
      setBarStatus(
        result.failed > 0 || result.downloaded !== result.found
          ? `ZIP parcial: ${result.downloaded} de ${result.found}`
          : 'ZIP baixado'
      );
      showToast(`${toastMsg} Veja o popup de Downloads do Chrome.`);
      LOG(toastMsg, 'stats=', {
        discovered: result.found,
        addedToZip: result.downloaded,
        fetchFailed: result.fetchFailed,
        zipAddFailed: result.zipAddFailed,
        skippedInvalid: result.skippedInvalid,
        zipFileCount: result.zipFileCount,
      }, 'downloadIds=', result.downloadIds);
    } catch (err) {
      console.error('[Hagap BMDs] download failed', err);
      const reason = classifyDownloadError(err);
      setBarStatus(`Falha no download: ${reason}`);
      showToast(`Não foi possível baixar os anexos: ${reason}`);
    } finally {
      // If something opened a thread (#search/q/threadId), snap back to the list hash.
      const cleanList = searchHashWithoutThread();
      const cur = location.hash || '';
      if (cleanList && cur !== cleanList) {
        LOG('finally: restoring list hash', cur, '→', cleanList);
        location.hash = cleanList;
      } else if (listHash && cur !== listHash) {
        const body = cur.startsWith('#search/') ? cur.slice('#search/'.length) : '';
        const slash = body.lastIndexOf('/');
        const maybeThread = slash >= 0 ? body.slice(slash + 1) : '';
        if (/^[a-zA-Z0-9_-]{10,}$/.test(maybeThread) && !maybeThread.includes('%')) {
          LOG('finally: restoring start list hash', cur, '→', listHash);
          location.hash = listHash;
        }
      }
      setDownloadBusy(false);
      setActive(true);
      scheduleInject();
      if (shouldShowBmdsBar()) ensureBarVisible();
      else hideBarOnly();
      setTimeout(() => setBarStatus(''), 8000);
    }
  }

  /**
   * Trigger Gmail/Google native download using the page session (cookies).
   * Same path as clicking "Download" on an attachment in Gmail.
   */
  function triggerGmailNativeDownload(url, filename) {
    const abs = toGmailDownloadUrl(url);
    if (!abs) return false;

    // 1) Hidden iframe: Gmail serves Content-Disposition attachment with session cookies.
    try {
      const iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.tabIndex = -1;
      iframe.style.cssText =
        'position:fixed!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;left:-9999px!important;top:0!important;border:0!important;';
      iframe.src = abs;
      document.body.appendChild(iframe);
      setTimeout(() => {
        try {
          iframe.remove();
        } catch {
          /* ignore */
        }
      }, 20000);
    } catch (err) {
      LOG('iframe download failed', err);
    }

    // 2) Anchor click fallback (also uses page cookies / Google session).
    try {
      const a = document.createElement('a');
      a.href = abs;
      if (filename) a.setAttribute('download', filename);
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      a.remove();
    } catch (err) {
      LOG('anchor download failed', err);
      return false;
    }

    return true;
  }

  function requestDownload(item) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'DOWNLOAD_URL', url: item.url, filename: item.filename },
        (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false });
        }
      );
    });
  }

  /**
   * Download via Gmail/Google session (page cookies), same as clicking Download in Gmail.
   * chrome.downloads alone often queues then fails (no file on disk) without the page session.
   */
  async function downloadOneAttachment(item) {
    const url = toGmailDownloadUrl(item.url);
    const filename = item.filename || '';

    const nativeOk = triggerGmailNativeDownload(url, filename);
    if (nativeOk) {
      return { ok: true, method: 'gmail-native' };
    }

    const api = await requestDownload({ url, filename });
    if (api && api.ok) {
      return { ok: true, method: 'api' };
    }

    LOG('download failed', filename, api?.error);
    return { ok: false, method: 'failed', error: api?.error };
  }

  /** Stagger native Gmail downloads so Chrome accepts them (file count = attachments). */
  async function downloadItemsViaGoogle(items, { onProgress } = {}) {
    let done = 0;
    let okCount = 0;

    for (const item of items) {
      const res = await downloadOneAttachment(item);
      done += 1;
      if (res && res.ok) okCount += 1;
      if (onProgress) onProgress(done, items.length, okCount);
      await sleep(70);
    }

    return { found: items.length, downloaded: okCount };
  }

  function sanitizeZipFilename(name) {
    if (!name || typeof name !== 'string') return '';
    return cleanAttachmentFilename(name)
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
  }

  function uniqueZipEntryName(filename, threadIndex, used) {
    const raw = sanitizeZipFilename(filename) || 'anexo.pdf';
    const idx = threadIndex >= 0 ? String(threadIndex + 1).padStart(2, '0') : '00';
    const base = `${idx}_${raw}`;
    let candidate = base;
    let n = 2;
    while (used.has(candidate.toLowerCase())) {
      const m = base.match(/^(.*)(\.[^.]+)$/);
      candidate = m ? `${m[1]} (${n})${m[2]}` : `${base} (${n})`;
      n += 1;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  }

  function bmdsZipFilename() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `BMDs-${y}-${m}-${day}.zip`;
  }

  function classifyDownloadError(err) {
    const msg = String(err && err.message != null ? err.message : err || '').trim();
    if (!msg) return 'erro desconhecido';
    if (/quota|out of memory|oom|memory/i.test(msg)) {
      return `memória insuficiente (${msg})`;
    }
    if (/message port closed|message length|too large|maximum.*size|Oversized/i.test(msg)) {
      return `tamanho / limite de mensagem MV3 (${msg})`;
    }
    if (/permission|denied|user.?gesture/i.test(msg)) {
      return `permissão de download (${msg})`;
    }
    if (/offscreen/i.test(msg)) {
      return `documento offscreen (${msg})`;
    }
    if (/HTTP\s*[45]\d\d/i.test(msg)) {
      return `falha ao buscar anexo (${msg})`;
    }
    return msg;
  }

  async function fetchAttachmentBlob(url) {
    const abs = toGmailDownloadUrl(url);
    try {
      const res = await fetch(abs, { credentials: 'include', redirect: 'follow', cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.blob();
    } catch (pageErr) {
      LOG('page fetch failed, trying extension fetch', pageErr);
      const viaBg = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'FETCH_ATTACHMENT', url: abs }, (res) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(res);
        });
      });
      if (!viaBg || !viaBg.ok || !viaBg.bytes) {
        throw pageErr;
      }
      return new Blob([new Uint8Array(viaBg.bytes)], {
        type: viaBg.contentType || 'application/octet-stream',
      });
    }
  }

  async function fetchAttachmentBlobWithRetry(url, retries = FETCH_RETRIES) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await fetchAttachmentBlob(url);
      } catch (err) {
        lastErr = err;
        if (attempt < retries) {
          await sleep(250 * (attempt + 1));
        }
      }
    }
    throw lastErr || new Error('falha ao buscar anexo');
  }

  function runtimeSend(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: 'sem resposta do background' });
      });
    });
  }

  function triggerBlobDownload(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      a.remove();
    } finally {
      setTimeout(() => {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          /* ignore */
        }
      }, 120000);
    }
  }

  async function blobToBase64(blob) {
    const buf = await blob.arrayBuffer();
    return uint8ToBase64(new Uint8Array(buf));
  }

  /**
   * @param {Uint8Array} bytes
   */
  function uint8ToBase64(bytes) {
    const chunk = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  /**
   * Ship one attachment into the offscreen JSZip session.
   * Small files: one message. Large files: 2MB base64 chunks (never one giant sendMessage).
   */
  async function addBlobToZipSession(sessionId, entryName, blob) {
    if (!blob || !blob.size) {
      return { ok: false, error: 'arquivo vazio' };
    }

    if (blob.size <= SINGLE_MESSAGE_MAX_BYTES) {
      const base64 = await blobToBase64(blob);
      return runtimeSend({
        type: 'ZIP_BUILD_ADD',
        sessionId,
        entryName,
        base64,
      });
    }

    const begin = await runtimeSend({
      type: 'ZIP_BUILD_FILE_BEGIN',
      sessionId,
      entryName,
      totalBytes: blob.size,
    });
    if (!begin || !begin.ok) {
      return {
        ok: false,
        error: (begin && begin.error) || 'falha ao iniciar transferência do arquivo',
      };
    }

    try {
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK_BYTES) {
        const slice = bytes.subarray(offset, Math.min(offset + TRANSFER_CHUNK_BYTES, bytes.length));
        const chunkRes = await runtimeSend({
          type: 'ZIP_BUILD_FILE_CHUNK',
          sessionId,
          base64: uint8ToBase64(slice),
        });
        if (!chunkRes || !chunkRes.ok) {
          throw new Error((chunkRes && chunkRes.error) || `falha no chunk @${offset}`);
        }
      }
      return runtimeSend({ type: 'ZIP_BUILD_FILE_FINISH', sessionId });
    } catch (err) {
      await runtimeSend({ type: 'ZIP_BUILD_FILE_ABORT', sessionId });
      const msg = String(err && err.message ? err.message : err);
      return { ok: false, error: msg };
    }
  }

  function formatZipResultMessage(result) {
    const downloaded = result.downloaded || 0;
    const found = result.found || 0;
    const failed = result.failed || 0;
    const zipLabel = result.zipName ? ` (${result.zipName})` : '';
    if (failed <= 0 && downloaded === found) {
      return `ZIP baixado: ${downloaded} de ${found}${zipLabel}.`;
    }
    const reasons = [];
    if (result.fetchFailed > 0) reasons.push(`${result.fetchFailed} busca`);
    if (result.zipAddFailed > 0) reasons.push(`${result.zipAddFailed} add ZIP`);
    if (result.skippedInvalid > 0) reasons.push(`${result.skippedInvalid} inválido`);
    const reasonBit = reasons.length ? `: ${reasons.join(', ')}` : '';
    const failWord = failed === 1 ? 'falhou' : 'falharam';
    return `ZIP baixado: ${downloaded} de ${found} (${failed} ${failWord}${reasonBit})${zipLabel}.`;
  }

  function logZipAttachmentIssue(kind, item, extra = {}) {
    const url = String(item && item.url ? item.url : '');
    console.error('[Hagap BMDs]', kind, {
      threadId: (item && item.threadId) || threadIdFromUrl(url) || '',
      threadIndex: item && item.threadIndex,
      filename: (item && item.filename) || '',
      url: url.slice(0, 160),
      ...extra,
    });
  }

  /**
   * Fetch attachments with limited concurrency, stream each into offscreen JSZip,
   * then generate ONE ZIP and download once via chrome.downloads.
   * Content never holds the full archive; at most FETCH_CONCURRENCY blobs live here.
   * Success only counts after offscreen confirms the file was added.
   * @param {'fetch'|'zip'} phase via onProgress
   * @param {number} [total] frozen discovery total (do not use a growing length)
   */
  async function downloadItemsAsZip(items, { onProgress, total } = {}) {
    const queue = Array.isArray(items) ? items.slice() : [];
    const frozenTotal = typeof total === 'number' && total >= 0 ? total : queue.length;
    const usedNames = new Set();
    let addedToZip = 0;
    let fetchFailed = 0;
    let zipAddFailed = 0;
    let skippedInvalid = 0;
    let processed = 0;

    const sessionId = `zip_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const zipName = bmdsZipFilename();

    const emptyResult = (extra = {}) => ({
      found: frozenTotal,
      downloaded: 0,
      failed: fetchFailed + zipAddFailed + skippedInvalid,
      fetchFailed,
      zipAddFailed,
      skippedInvalid,
      zipName: '',
      zipOk: false,
      zipFileCount: 0,
      downloadIds: [],
      ...extra,
    });

    const begin = await runtimeSend({ type: 'ZIP_BUILD_BEGIN', sessionId });
    if (!begin || !begin.ok) {
      return emptyResult({
        error: (begin && begin.error) || 'falha ao iniciar sessão ZIP',
      });
    }

    try {
      for (let i = 0; i < queue.length; i += FETCH_CONCURRENCY) {
        const batch = queue.slice(i, i + FETCH_CONCURRENCY);
        // Fetch concurrently; add to offscreen ZIP sequentially so memory stays bounded
        // and FINISH cannot race a pending ADD.
        const fetched = await Promise.all(
          batch.map(async (item, batchIdx) => {
            const index = i + batchIdx;
            try {
              const blob = await fetchAttachmentBlobWithRetry(item.url);
              return { item, index, blob, error: null };
            } catch (err) {
              return { item, index, blob: null, error: err };
            }
          })
        );

        for (const row of fetched) {
          processed += 1;
          if (row.error || !row.blob) {
            fetchFailed += 1;
            logZipAttachmentIssue('zip fetch failed', row.item, {
              error: String(row.error && row.error.message ? row.error.message : row.error || 'sem blob'),
            });
            LOG('zip fetch failed', row.item.filename || row.item.url, row.error);
            if (onProgress) onProgress('fetch', processed, frozenTotal);
            continue;
          }

          const { item, index, blob } = row;
          const ctype = (blob.type || '').toLowerCase();
          if (ctype.includes('text/html') || ctype.includes('image/')) {
            skippedInvalid += 1;
            logZipAttachmentIssue('zip skip invalid blob', item, {
              contentType: ctype,
              error: `conteudo nao-documento (${ctype || 'desconhecido'})`,
            });
            LOG('skip non-document blob', item.filename || item.url, ctype);
            if (onProgress) onProgress('fetch', processed, frozenTotal);
            continue;
          }

          // Distinct th|attid already survived discovery; keep every discovered file.
          // Filename collisions are uniquified (never overwrite ZIP entries).
          const entry = uniqueZipEntryName(item.filename, item.threadIndex ?? index, usedNames);
          const added = await addBlobToZipSession(sessionId, entry, blob);
          // Drop local blob ASAP; offscreen JSZip owns the bytes now.
          row.blob = null;

          if (!added || !added.ok) {
            zipAddFailed += 1;
            logZipAttachmentIssue('zip add failed', item, {
              entryName: entry,
              error: (added && added.error) || 'offscreen nao confirmou add',
            });
            LOG('zip add failed', entry, added && added.error);
            if (onProgress) onProgress('fetch', processed, frozenTotal);
            continue;
          }

          // Only count success after offscreen confirms the entry.
          addedToZip += 1;
          const offscreenCount = Number(added.fileCount) || 0;
          if (offscreenCount > 0 && offscreenCount !== addedToZip) {
            console.error('[Hagap BMDs] addedToZip vs offscreen fileCount', {
              addedToZip,
              offscreenCount,
              entry: added.entryName || entry,
            });
          }
          LOG('zip +', added.entryName || entry, `(${added.bytes || '?'} bytes)`, `${addedToZip}/${frozenTotal}`);
          if (onProgress) onProgress('fetch', processed, frozenTotal);
        }
      }

      const failed = fetchFailed + zipAddFailed + skippedInvalid;

      if (addedToZip === 0) {
        await runtimeSend({ type: 'ZIP_BUILD_ABORT', sessionId });
        return emptyResult({
          failed,
          error:
            failed > 0
              ? `${failed} anexo(s) falharam ao buscar/adicionar`
              : 'nenhum arquivo válido para o ZIP',
        });
      }

      if (onProgress) onProgress('zip', addedToZip, frozenTotal);
      LOG('generating single ZIP', zipName, `${addedToZip} files confirmed`);

      const finished = await runtimeSend({
        type: 'ZIP_BUILD_FINISH',
        sessionId,
        filename: zipName,
      });

      if (!finished || !finished.ok) {
        return {
          found: frozenTotal,
          downloaded: addedToZip,
          failed,
          fetchFailed,
          zipAddFailed,
          skippedInvalid,
          zipName,
          zipOk: false,
          zipFileCount: Number(finished && finished.fileCount) || 0,
          error: (finished && finished.error) || 'falha ao baixar ZIP',
          downloadIds: [],
        };
      }

      const zipFileCount = Number(finished.fileCount) || 0;
      if (zipFileCount > 0 && zipFileCount !== addedToZip) {
        console.error('[Hagap BMDs] ZIP entry count mismatch', {
          addedToZip,
          zipFileCount,
          discovered: frozenTotal,
          fetchFailed,
          zipAddFailed,
          skippedInvalid,
        });
        // Trust offscreen real entry count for user-facing "downloaded".
        if (zipFileCount < addedToZip) {
          zipAddFailed += addedToZip - zipFileCount;
          addedToZip = zipFileCount;
        }
      }

      const downloadIds = finished.id != null ? [finished.id] : [];
      LOG(
        'chrome.downloads ZIP ok',
        zipName,
        finished.id,
        finished.state,
        `${finished.bytes || '?'} bytes`,
        `entries=${zipFileCount || addedToZip}`
      );

      return {
        found: frozenTotal,
        downloaded: addedToZip,
        failed: fetchFailed + zipAddFailed + skippedInvalid,
        fetchFailed,
        zipAddFailed,
        skippedInvalid,
        zipName,
        zipOk: true,
        zipFileCount: zipFileCount || addedToZip,
        error: '',
        downloadIds,
        downloadId: downloadIds[0],
      };
    } catch (err) {
      await runtimeSend({ type: 'ZIP_BUILD_ABORT', sessionId });
      throw err;
    }
  }

  function mergeAttachments(target, seen, items, meta = {}) {
    let added = 0;
    for (const item of items) {
      if (
        pushAttachment(target, seen, item.url, item.filename, {
          threadId: meta.threadId || item.threadId || '',
          threadIndex: meta.threadIndex != null ? meta.threadIndex : item.threadIndex,
        })
      ) {
        added += 1;
      }
    }
    return added;
  }

  function syncBarVisibilityFromContext() {
    if (downloadBusy) {
      if (shouldShowBmdsBar()) ensureBarVisible();
      else hideBarOnly();
      scheduleInject();
      return;
    }

    if (isLeavingBmdsContext()) {
      leaveBmdsContextImmediate();
      return;
    }

    if (shouldShowBmdsBar()) {
      setActive(true);
      scheduleInject();
      ensureBarVisible();
      const tab = document.getElementById(EXT.TAB_ID);
      if (tab) {
        tab.classList.add('is-active');
        tab.setAttribute('aria-selected', 'true');
      }
      return;
    }

    if (active || readSessionActive()) {
      leaveBmdsContextImmediate();
    } else {
      hideBarOnly();
      ensureBmdsTab();
    }
  }

  function watchHashForNativeTabs() {
    // Hide toolbar synchronously on #inbox / non-BMDs hash; keep BMDs tab.
    if (isLeavingBmdsContext()) {
      leaveBmdsContextImmediate();
      return;
    }
    syncBarVisibilityFromContext();
  }

  function onNativeTabClick(e) {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest(`#${EXT.TAB_ID}`) || t.closest(`#${EXT.BAR_ID}`) || t.closest(`#${EXT.MODAL_ID}`)) return;

    // Left-nav "Caixa de entrada" / labels: hide immediately on click (before hash settles).
    const inboxLike = t.closest(
      'a[href*="#inbox"], a[href*="#label/"], a[href*="#category/"], a[href*="#sent"], a[href*="#starred"], a[href*="#all"]'
    );
    if (inboxLike && !downloadBusy) {
      leaveBmdsContextImmediate();
      return;
    }

    const tablist = findCategoryTablist();
    if (!tablist) return;
    if (tablist.contains(t) || t.closest('[role="tablist"]') === tablist) {
      const maybeTab = t.closest('[role="tab"], a, div');
      if (maybeTab && maybeTab.id !== EXT.TAB_ID && tablist.contains(maybeTab)) {
        leaveBmdsContextImmediate();
      }
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    let touched = false;
    for (const [k, v] of Object.entries(changes)) {
      if (k in DEFAULTS) {
        settings[k] = v.newValue;
        touched = true;
      }
    }
    if (!touched) return;

    syncBarUI();
    syncBarVisibilityFromContext();

    if (skipNextStorageFilter) {
      skipNextStorageFilter = false;
      return;
    }

    if (active && changes.destinatario && isBmdsSearchHash()) runFilter();
  });

  async function init() {
    await loadSettings();

    if (readSessionActive() || queryMentionsConfiguredDestinatario() || isBmdsSearchHash()) {
      setActive(true);
    }

    injectTab();
    syncBarVisibilityFromContext();
    // Category tabs may mount after first paint; always keep BMDs tab scheduled.
    ensureBmdsTab();

    const observer = new MutationObserver(() => {
      if (isLeavingBmdsContext()) {
        // Hide toolbar, but still reinject BMDs tab if Gmail remounted the row.
        if (downloadBusy) hideBarOnly();
        else leaveBmdsContextImmediate();
        return;
      }
      scheduleInject();
      if (shouldShowBmdsBar()) ensureBarVisible();
      else hideBarOnly();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    window.addEventListener('hashchange', () => {
      watchHashForNativeTabs();
      // Always try tab (and bar when active); scheduleInject no-ops bar on leave.
      scheduleInject();
    });
    document.addEventListener('click', onNativeTabClick, true);

    // Search box edits (manual query) also drive bar visibility.
    document.addEventListener(
      'change',
      (e) => {
        const t = e.target;
        if (!(t instanceof HTMLInputElement)) return;
        if (t.name === 'q' || t.closest('form[role="search"]')) {
          setTimeout(syncBarVisibilityFromContext, 50);
        }
      },
      true
    );

    const themeObs = new MutationObserver(() => syncThemeClass());
    themeObs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-color-scheme', 'class', 'style'],
    });

    setInterval(syncThemeClass, 5000);
    setInterval(() => {
      if (!isBmdsTabInCategoryBar()) ensureBmdsTab();
      if (shouldShowBmdsBar() !== (active && document.getElementById(EXT.BAR_ID)?.classList.contains('is-visible'))) {
        syncBarVisibilityFromContext();
      }
    }, 1500);

    // Always reinject tab (and bar when BMDs is active).
    scheduleInject();
    if (active || shouldShowBmdsBar()) ensureBarVisible();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
