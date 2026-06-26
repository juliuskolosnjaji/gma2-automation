'use strict';

const stateOrder = [
  'LAUNCHING',
  'WAITING_FOR_TELNET',
  'LOGGING_IN',
  'LOADING_SHOW',
  'RUNNING_MACRO',
  'CLOSING',
  'READY'
];

const stateLabels = {
  IDLE: 'Bereit',
  LAUNCHING: 'Startet',
  WAITING_FOR_TELNET: 'Wartet',
  LOGGING_IN: 'Login',
  LOADING_SHOW: 'Lädt',
  RUNNING_MACRO: 'Macro',
  CLOSING: 'Schließt',
  READY: 'Fertig',
  ERROR: 'Fehler'
};

let selectedShow = null;
let lastKnownShows = [];

const els = {
  connectionStatus: document.getElementById('connectionStatus'),
  idlePanel: document.getElementById('idlePanel'),
  progressPanel: document.getElementById('progressPanel'),
  showGrid: document.getElementById('showGrid'),
  reloadButton: document.getElementById('reloadButton'),
  progressTitle: document.getElementById('progressTitle'),
  progressMessage: document.getElementById('progressMessage'),
  eventLog: document.getElementById('eventLog'),
  confirmButton: document.getElementById('confirmButton'),
  resetButton: document.getElementById('resetButton'),
  confirmDialog: document.getElementById('confirmDialog'),
  confirmTitle: document.getElementById('confirmTitle'),
  confirmText: document.getElementById('confirmText'),
  startConfirmedButton: document.getElementById('startConfirmedButton'),
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

function showConfirm(showName) {
  selectedShow = showName;
  els.confirmTitle.textContent = `${showName} starten?`;
  els.confirmText.textContent = `gMA2 onPC wird gestartet, das Showfile geladen, das Macro ausgeführt, danach geschlossen und erst nach Prüfung für grandMA3 freigegeben.`;
  if (typeof els.confirmDialog.showModal === 'function') {
    els.confirmDialog.showModal();
  } else if (window.confirm(`${showName} starten?`)) {
    runShow(showName);
  }
}

async function runShow(showName) {
  selectedShow = null;
  if (els.confirmDialog.open) els.confirmDialog.close();
  renderBusyScreen({ state: 'LAUNCHING', show: showName, message: `Starte Setup für ${showName}…` });
  try {
    await api(`/run/${encodeURIComponent(showName)}`, { method: 'POST' });
    await pollStatus();
  } catch (err) {
    renderError(err.message || String(err));
  }
}

function renderShows(shows) {
  lastKnownShows = shows;
  els.showGrid.innerHTML = '';

  if (!shows.length) {
    const empty = document.createElement('p');
    empty.className = 'large-message';
    empty.textContent = 'Keine Shows in config.json gefunden.';
    els.showGrid.appendChild(empty);
    return;
  }

  shows.forEach(show => {
    const name = typeof show === 'string' ? show : show.name;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'show-button';
    button.textContent = name;
    button.addEventListener('click', () => showConfirm(name));
    els.showGrid.appendChild(button);
  });
}

function updateStepList(state) {
  const activeIndex = stateOrder.indexOf(state);
  document.querySelectorAll('#steps li').forEach(li => {
    const itemState = li.dataset.state;
    const itemIndex = stateOrder.indexOf(itemState);
    li.classList.remove('active', 'done', 'error');

    if (state === 'ERROR') {
      if (itemIndex >= 0 && itemIndex <= stateOrder.indexOf('CLOSING')) li.classList.add('error');
      return;
    }

    if (state === 'READY') {
      li.classList.add('done');
      return;
    }

    if (itemIndex < activeIndex) li.classList.add('done');
    if (itemIndex === activeIndex) li.classList.add('active');
  });
}

function setConnection(statusClass, text) {
  els.connectionStatus.className = `status-pill ${statusClass || ''}`.trim();
  els.connectionStatus.textContent = text;
}

function renderEventLog(status) {
  const events = Array.isArray(status.recentEvents) ? status.recentEvents : [];
  els.eventLog.innerHTML = '';

  if (!events.length) {
    const empty = document.createElement('p');
    empty.className = 'event-log-empty';
    empty.textContent = 'Noch keine Schritte protokolliert.';
    els.eventLog.appendChild(empty);
    return;
  }

  events.forEach(event => {
    const row = document.createElement('div');
    row.className = 'event-log-row';

    const time = document.createElement('span');
    time.className = 'event-log-time';
    time.textContent = event.ts ? new Date(event.ts).toLocaleTimeString() : '—';

    const message = document.createElement('span');
    message.className = 'event-log-message';
    message.textContent = event.message || '';

    row.append(time, message);
    els.eventLog.appendChild(row);
  });
}

function renderIdle(status) {
  els.idlePanel.classList.remove('hidden');
  els.progressPanel.classList.add('hidden');
  setConnection('ok', stateLabels[status.state] || 'Bereit');
}

function renderBusyScreen(status) {
  els.idlePanel.classList.add('hidden');
  els.progressPanel.classList.remove('hidden');
  els.confirmButton.classList.add('hidden');
  els.resetButton.classList.add('hidden');

  const showText = status.show ? ` — ${status.show}` : '';
  els.progressTitle.textContent = status.state === 'READY' ? `Fertig${showText}` : `Setup läuft${showText}`;
  els.progressMessage.textContent = status.message || 'Bitte warten.';
  setConnection(status.state === 'READY' ? 'ok' : 'busy', stateLabels[status.state] || status.state);
  updateStepList(status.state);
  renderEventLog(status);

  if (status.state === 'READY') {
    els.confirmButton.classList.remove('hidden');
    els.progressMessage.textContent = 'Fertig — gMA2 onPC ist geschlossen und greift nicht mehr auf die Nodes zu. Jetzt grandMA3 starten. Danach unten bestätigen.';
  }
}

function renderError(statusOrMessage) {
  const status = typeof statusOrMessage === 'object' && statusOrMessage
    ? statusOrMessage
    : { message: statusOrMessage, recentEvents: [] };
  const message = status.lastError || status.message;
  els.idlePanel.classList.add('hidden');
  els.progressPanel.classList.remove('hidden');
  els.confirmButton.classList.add('hidden');
  els.resetButton.classList.remove('hidden');
  els.progressTitle.textContent = 'Fehler';
  els.progressMessage.textContent = message || 'Unbekannter Fehler.';
  setConnection('error', 'Fehler');
  updateStepList('ERROR');
  renderEventLog(status);
}

function renderStatus(status) {
  const shows = (status.shows || []).map(name => ({ name }));
  if (JSON.stringify(shows) !== JSON.stringify(lastKnownShows)) renderShows(shows);

  els.lastUpdate.textContent = status.updatedAt ? `Letztes Update: ${new Date(status.updatedAt).toLocaleString()}` : '—';

  if (status.state === 'IDLE') return renderIdle(status);
  if (status.state === 'ERROR') return renderError(status);
  return renderBusyScreen(status);
}

async function pollStatus() {
  try {
    const status = await api('/status');
    renderStatus(status);
  } catch (err) {
    setConnection('error', 'Offline');
    els.lastUpdate.textContent = err.message || String(err);
  }
}

async function reloadConfig() {
  try {
    await api('/reload-config', { method: 'POST' });
    await pollStatus();
  } catch (err) {
    renderError(err.message || String(err));
  }
}

async function resetToIdle() {
  try {
    await api('/confirm-gma3', { method: 'POST' });
    await pollStatus();
  } catch (err) {
    renderError(err.message || String(err));
  }
}

els.startConfirmedButton.addEventListener('click', () => {
  if (selectedShow) runShow(selectedShow);
});

els.reloadButton.addEventListener('click', reloadConfig);
els.confirmButton.addEventListener('click', resetToIdle);
els.resetButton.addEventListener('click', resetToIdle);

pollStatus();
setInterval(pollStatus, 2000);
