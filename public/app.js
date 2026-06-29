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

const stateMessages = {
  LAUNCHING: 'onPC startet',
  WAITING_FOR_TELNET: 'Verbindung',
  LOGGING_IN: 'Login',
  LOADING_SHOW: 'Show laden',
  RUNNING_MACRO: 'Macro starten',
  CLOSING: 'onPC schließen',
  READY: 'Fertig'
};

let selectedShow = null;
let selectedCloseOnFinish = true;
let lastKnownShows = [];
let currentConfig = null;

const els = {
  connectionStatus: document.getElementById('connectionStatus'),
  idlePanel: document.getElementById('idlePanel'),
  progressPanel: document.getElementById('progressPanel'),
  showGrid: document.getElementById('showGrid'),
  showSourceHint: document.getElementById('showSourceHint'),
  reloadButton: document.getElementById('reloadButton'),
  pathSettingsButton: document.getElementById('pathSettingsButton'),
  pathSettingsForm: document.getElementById('pathSettingsForm'),
  executableInput: document.getElementById('executableInput'),
  showDirectoryInput: document.getElementById('showDirectoryInput'),
  cancelPathButton: document.getElementById('cancelPathButton'),
  progressTitle: document.getElementById('progressTitle'),
  progressMessage: document.getElementById('progressMessage'),
  eventLog: document.getElementById('eventLog'),
  confirmButton: document.getElementById('confirmButton'),
  resetButton: document.getElementById('resetButton'),
  confirmDialog: document.getElementById('confirmDialog'),
  confirmTitle: document.getElementById('confirmTitle'),
  confirmText: document.getElementById('confirmText'),
  startKeepOpenButton: document.getElementById('startKeepOpenButton'),
  startConfirmedButton: document.getElementById('startConfirmedButton'),
  lastUpdate: document.getElementById('lastUpdate'),
  executableExplorerBtn: document.getElementById('executableExplorerBtn'),
  showDirectoryExplorerBtn: document.getElementById('showDirectoryExplorerBtn')
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
  els.confirmText.textContent = `Macro ${currentConfig && currentConfig.macroNumber ? currentConfig.macroNumber : '36'}`;
  if (typeof els.confirmDialog.showModal === 'function') {
    els.confirmDialog.showModal();
  } else if (window.confirm(`${showName} starten?`)) {
    runShow(showName);
  }
}

async function runShow(showName) {
  selectedShow = null;
  if (els.confirmDialog.open) els.confirmDialog.close();
  renderBusyScreen({ state: 'LAUNCHING', show: showName, message: stateMessages.LAUNCHING });
  try {
    await api(`/run/${encodeURIComponent(showName)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ closeOnFinish: selectedCloseOnFinish })
    });
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
    empty.textContent = 'Keine Shows gefunden.';
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

async function loadShowSourceHint() {
  try {
    const data = await api('/config');
    currentConfig = data;
    els.executableInput.value = data.executable || '';
    els.showDirectoryInput.value = data.showDirectory || '';
    if (data.showDirectory) {
      els.showSourceHint.textContent = `Macro ${data.macroNumber || '36'}`;
      return;
    }

    els.showSourceHint.textContent = 'Setup fehlt.';
  } catch (err) {
    els.showSourceHint.textContent = 'Offline.';
  }
}

function showPathSettings() {
  els.pathSettingsForm.classList.remove('hidden');
  els.executableInput.focus();
  els.executableInput.select();
}

function hidePathSettings() {
  els.pathSettingsForm.classList.add('hidden');
  if (currentConfig) {
    els.executableInput.value = currentConfig.executable || '';
    els.showDirectoryInput.value = currentConfig.showDirectory || '';
  }
}

async function saveShowDirectory(event) {
  event.preventDefault();

  try {
    const nextExecutable = els.executableInput.value.trim();
    const nextShowDirectory = els.showDirectoryInput.value.trim();
    await api('/save-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        executable: nextExecutable,
        showDirectory: nextShowDirectory,
        macroNumber: currentConfig && currentConfig.macroNumber ? currentConfig.macroNumber : '36'
      })
    });
    await loadShowSourceHint();
    await pollStatus();
    els.pathSettingsForm.classList.add('hidden');
  } catch (err) {
    renderError(err.message || String(err));
  }
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

  els.progressTitle.textContent = status.show || 'Setup';
  els.progressMessage.textContent = stateMessages[status.state] || status.message || 'Bitte warten';
  setConnection(status.state === 'READY' ? 'ok' : 'busy', stateLabels[status.state] || status.state);
  updateStepList(status.state);
  renderEventLog(status);

  if (status.state === 'READY') {
    els.confirmButton.classList.remove('hidden');
    els.progressMessage.textContent = 'grandMA3 starten';
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
    await loadShowSourceHint();
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

// File explorer functions
async function selectExecutable() {
  try {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.exe';
    
    return new Promise((resolve) => {
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
          // Get the directory path from the file path
          const fullPath = file.path || file.name;
          const path = fullPath.includes('\\') ? fullPath : file.name;
          resolve(path);
        } else {
          resolve(null);
        }
      };
      input.click();
    });
  } catch (err) {
    console.error('File selection error:', err);
    return null;
  }
}

async function selectDirectory() {
  try {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    
    return new Promise((resolve) => {
      input.onchange = (e) => {
        const files = e.target.files;
        if (files && files.length > 0) {
          // Get the directory path from the first file
          const firstFile = files[0];
          const fullPath = firstFile.webkitRelativePath || firstFile.name;
          const directoryPath = fullPath.split('/')[0];
          resolve(directoryPath);
        } else {
          resolve(null);
        }
      };
      input.click();
    });
  } catch (err) {
    console.error('Directory selection error:', err);
    return null;
  }
}

els.startConfirmedButton.addEventListener('click', () => {
  selectedCloseOnFinish = true;
  if (selectedShow) runShow(selectedShow);
});

els.startKeepOpenButton.addEventListener('click', () => {
  selectedCloseOnFinish = false;
  if (selectedShow) runShow(selectedShow);
});

els.reloadButton.addEventListener('click', reloadConfig);
els.pathSettingsButton.addEventListener('click', showPathSettings);
els.pathSettingsForm.addEventListener('submit', saveShowDirectory);
els.cancelPathButton.addEventListener('click', hidePathSettings);
els.confirmButton.addEventListener('click', resetToIdle);
els.resetButton.addEventListener('click', resetToIdle);

// File explorer event listeners
els.executableExplorerBtn.addEventListener('click', async () => {
  const selectedPath = await selectExecutable();
  if (selectedPath) {
    els.executableInput.value = selectedPath;
  }
});

els.showDirectoryExplorerBtn.addEventListener('click', async () => {
  const selectedPath = await selectDirectory();
  if (selectedPath) {
    els.showDirectoryInput.value = selectedPath;
  }
});

pollStatus();
loadShowSourceHint();
setInterval(pollStatus, 2000);

// Dark mode functionality
const darkModeToggle = document.getElementById('darkModeToggle');
const body = document.body;

// Check for saved theme preference or default to light mode
const currentTheme = localStorage.getItem('theme') || 'light';
if (currentTheme === 'dark') {
  body.classList.add('dark-mode');
  darkModeToggle.querySelector('.dark-mode-icon').textContent = '☀️';
}

// Toggle dark mode
darkModeToggle.addEventListener('click', () => {
  body.classList.toggle('dark-mode');
  const isDarkMode = body.classList.contains('dark-mode');
  
  // Update icon
  darkModeToggle.querySelector('.dark-mode-icon').textContent = isDarkMode ? '☀️' : '🌙';
  
  // Save preference to localStorage
  localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
});
