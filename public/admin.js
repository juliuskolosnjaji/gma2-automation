'use strict';

let lastStatus = null;

const els = {
  connectionStatus: document.getElementById('connectionStatus'),
  reloadButton: document.getElementById('reloadButton'),
  saveButton: document.getElementById('saveButton'),
  addButton: document.getElementById('addButton'),
  showList: document.getElementById('showList'),
  showTemplate: document.getElementById('showTemplate'),
  runWarning: document.getElementById('runWarning'),
  lastUpdate: document.getElementById('lastUpdate')
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options
  });

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();

  if (!response.ok) {
    const message = typeof data === 'object' && data.error ? data.error : String(data);
    throw new Error(message || `HTTP ${response.status}`);
  }

  return data;
}

function setConnection(statusClass, text) {
  els.connectionStatus.className = `status-pill ${statusClass || ''}`.trim();
  els.connectionStatus.textContent = text;
}

function updateToolbarState() {
  const busy = Boolean(lastStatus && lastStatus.busy);
  els.saveButton.disabled = busy;
  els.runWarning.textContent = busy
    ? 'Aktuell läuft ein Setup. Speichern ist bis zum Ende des Laufs gesperrt.'
    : 'Speichern ist möglich. Änderungen gelten für den nächsten Start.';
}

function updateCardTitle(card) {
  const name = card.querySelector('.field-name').value.trim();
  card.querySelector('.show-editor-title').textContent = name || 'Neue Show';
}

function createShowCard(show = {}) {
  const node = els.showTemplate.content.firstElementChild.cloneNode(true);

  node.querySelector('.field-name').value = show.name || '';
  node.querySelector('.field-loadshow').value = show.loadShowName || '';
  node.querySelector('.field-file').value = show.file || '';
  node.querySelector('.field-macro').value = show.macro || '';

  node.querySelector('.field-name').addEventListener('input', () => updateCardTitle(node));
  node.querySelector('.delete-button').addEventListener('click', () => {
    node.remove();
  });

  updateCardTitle(node);
  return node;
}

function renderShows(shows) {
  els.showList.innerHTML = '';
  shows.forEach(show => {
    els.showList.appendChild(createShowCard(show));
  });
}

function collectShows() {
  return Array.from(els.showList.querySelectorAll('.show-editor')).map(card => ({
    name: card.querySelector('.field-name').value.trim(),
    loadShowName: card.querySelector('.field-loadshow').value.trim(),
    file: card.querySelector('.field-file').value.trim(),
    macro: card.querySelector('.field-macro').value.trim()
  }));
}

async function loadStatus() {
  try {
    lastStatus = await api('/status');
    setConnection(lastStatus.busy ? 'busy' : 'ok', lastStatus.state || 'OK');
    els.lastUpdate.textContent = lastStatus.updatedAt
      ? `Status: ${lastStatus.state} | Letztes Update: ${new Date(lastStatus.updatedAt).toLocaleString()}`
      : `Status: ${lastStatus.state}`;
    updateToolbarState();
  } catch (err) {
    setConnection('error', 'Offline');
    els.lastUpdate.textContent = err.message || String(err);
  }
}

async function loadConfig() {
  try {
    const data = await api('/config');
    renderShows(data.shows || []);
    await loadStatus();
  } catch (err) {
    setConnection('error', 'Fehler');
    els.lastUpdate.textContent = err.message || String(err);
  }
}

async function saveConfig() {
  try {
    const payload = { shows: collectShows() };
    await api('/save-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    await loadConfig();
  } catch (err) {
    setConnection('error', 'Fehler');
    els.lastUpdate.textContent = err.message || String(err);
  }
}

els.reloadButton.addEventListener('click', loadConfig);
els.saveButton.addEventListener('click', saveConfig);
els.addButton.addEventListener('click', () => {
  els.showList.appendChild(createShowCard());
});

loadConfig();
setInterval(loadStatus, 2000);
