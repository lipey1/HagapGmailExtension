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
  daysBlock: document.getElementById('daysBlock'),
  periodBlock: document.getElementById('periodBlock'),
  save: document.getElementById('save'),
  status: document.getElementById('status'),
};

function syncModeUI() {
  const mode = els.filterMode.value;
  els.daysBlock.hidden = mode !== 'days';
  els.periodBlock.hidden = mode !== 'period';
}

chrome.storage.sync.get(DEFAULTS, (data) => {
  els.destinatario.value = data.destinatario || '';
  els.filterMode.value = data.filterMode || 'days';
  els.daysValue.value = data.daysValue || '7';
  els.periodValue.value = data.periodValue || 'week';
  syncModeUI();
});

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
      els.status.textContent = 'Configurações salvas. Recarregue o Gmail se a aba já estiver aberta.';
      setTimeout(() => {
        els.status.textContent = '';
      }, 3500);
    }
  );
});
