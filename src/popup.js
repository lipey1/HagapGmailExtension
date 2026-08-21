const DEFAULTS = {
  destinatario: '',
  filterMode: 'days',
  daysValue: '7',
  periodValue: 'week',
  customStart: '',
  customEnd: '',
};

const els = {
  destinatario: document.getElementById('destinatario'),
  filterMode: document.getElementById('filterMode'),
  daysValue: document.getElementById('daysValue'),
  periodValue: document.getElementById('periodValue'),
  daysRow: document.getElementById('daysRow'),
  periodRow: document.getElementById('periodRow'),
  save: document.getElementById('save'),
  status: document.getElementById('status'),
  openOptions: document.getElementById('openOptions'),
};

function syncModeUI() {
  const mode = els.filterMode.value;
  els.daysRow.hidden = mode !== 'days';
  els.periodRow.hidden = mode !== 'period';
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (data) => {
    els.destinatario.value = data.destinatario || '';
    els.filterMode.value = data.filterMode || 'days';
    els.daysValue.value = data.daysValue || '7';
    els.periodValue.value = data.periodValue || 'week';
    syncModeUI();
  });
}

els.filterMode.addEventListener('change', syncModeUI);

els.save.addEventListener('click', () => {
  const destinatario = els.destinatario.value.trim();
  if (destinatario && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destinatario)) {
    els.status.textContent = 'Informe um e-mail válido.';
    return;
  }
  chrome.storage.sync.set(
    {
      destinatario,
      filterMode: els.filterMode.value,
      daysValue: els.daysValue.value,
      periodValue: els.periodValue.value,
    },
    () => {
      els.status.textContent = 'Salvo.';
      setTimeout(() => {
        els.status.textContent = '';
      }, 1600);
    }
  );
});

els.openOptions.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

load();
