'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOG_PATH = path.join(ROOT, 'service.log');
const PUBLIC_DIR = path.join(ROOT, 'public');

const STATES = Object.freeze({
  IDLE: 'IDLE',
  LAUNCHING: 'LAUNCHING',
  WAITING_FOR_TELNET: 'WAITING_FOR_TELNET',
  LOGGING_IN: 'LOGGING_IN',
  LOADING_SHOW: 'LOADING_SHOW',
  RUNNING_MACRO: 'RUNNING_MACRO',
  CLOSING: 'CLOSING',
  READY: 'READY',
  ERROR: 'ERROR'
});

let config = loadConfig();
let gmaProcess = null;
let currentRun = null;
let readyIdleTimer = null;
const MAX_RECENT_EVENTS = 20;

const status = {
  state: STATES.IDLE,
  message: 'Idle',
  show: null,
  lastError: null,
  startedAt: null,
  updatedAt: new Date().toISOString(),
  recentEvents: []
};

function appendRecentEvent(message) {
  status.recentEvents = [
    ...status.recentEvents,
    {
      ts: new Date().toISOString(),
      message
    }
  ].slice(-MAX_RECENT_EVENTS);
}

function log(level, message, extra = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...extra
  });
  fs.appendFileSync(LOG_PATH, line + '\n', 'utf8');
  // Keep console logging useful when run from a terminal.
  console.log(line);
}

function validateConfig(parsed) {
  if (!parsed.gma2 || !parsed.service || !Array.isArray(parsed.shows)) {
    throw new Error('config.json must contain gma2, service and shows[]');
  }
  if (!parsed.gma2.executable) throw new Error('gma2.executable is required');
  if (!parsed.service.port) throw new Error('service.port is required');

  parsed.service.host = parsed.service.host || '127.0.0.1';
  parsed.gma2.telnetHost = parsed.gma2.telnetHost || '127.0.0.1';
  parsed.gma2.telnetPort = parsed.gma2.telnetPort || 30000;
  parsed.gma2.startupTimeoutMs = parsed.gma2.startupTimeoutMs || parsed.gma2.startupWaitMs || 30000;
  parsed.gma2.showLoadWaitMs = parsed.gma2.showLoadWaitMs || 12000;
  parsed.gma2.macroWaitMs = parsed.gma2.macroWaitMs || 5000;
  parsed.gma2.shutdownWaitMs = parsed.gma2.shutdownWaitMs || 3000;
  parsed.gma2.shutdownVerifyTimeoutMs = parsed.gma2.shutdownVerifyTimeoutMs || 12000;
  parsed.gma2.postShutdownNetworkQuietMs = parsed.gma2.postShutdownNetworkQuietMs || 2000;
  parsed.gma2.postPortOpenWaitMs = parsed.gma2.postPortOpenWaitMs || 0;
  parsed.gma2.postConnectWaitMs = parsed.gma2.postConnectWaitMs || 0;
  parsed.gma2.commandDelayMs = parsed.gma2.commandDelayMs || 350;
  parsed.gma2.closeOnFinish = parsed.gma2.closeOnFinish !== false;
  parsed.gma2.loginAfterLoadShow = parsed.gma2.loginAfterLoadShow === true;
  parsed.gma2.preferShowDirectory = parsed.gma2.preferShowDirectory === true;
  parsed.gma2.verifyTelnetClosedBeforeReady = parsed.gma2.closeOnFinish && parsed.gma2.verifyTelnetClosedBeforeReady !== false;
  parsed.gma2.rejectIfTelnetAlreadyOpen = parsed.gma2.rejectIfTelnetAlreadyOpen !== false;
  parsed.gma2.forceKillAllMatchingProcessesOnClose = parsed.gma2.forceKillAllMatchingProcessesOnClose !== false;
  parsed.gma2.loginCommand = parsed.gma2.loginCommand ?? 'Login "{user}" "{password}"';
  parsed.gma2.loadShowCommand = parsed.gma2.loadShowCommand ?? 'LoadShow "{show}" /nosave /noconfirm';
  parsed.gma2.macroCommand = parsed.gma2.macroCommand ?? 'Macro "{macro}"';

  for (const show of parsed.shows) {
    if (!show.name || (!show.macro && show.macroNumber == null)) {
      throw new Error('Every show needs at least name and macro or macroNumber');
    }
    if (!show.loadShowName && !show.file) {
      throw new Error(`Show "${show.name}" needs file or loadShowName`);
    }
  }

  const normalizedNames = new Set();
  for (const show of parsed.shows) {
    const key = show.name.trim().toLowerCase();
    if (normalizedNames.has(key)) {
      throw new Error(`Duplicate show name in config.json: "${show.name}"`);
    }
    normalizedNames.add(key);
  }

  return parsed;
}

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return validateConfig(JSON.parse(raw));
}

function adminConfig() {
  return {
    showDirectory: config.gma2.showDirectory || '',
    preferShowDirectory: config.gma2.preferShowDirectory === true,
    shows: config.shows.map(show => ({
      name: show.name,
      file: show.file || '',
      loadShowName: show.loadShowName || '',
      macro: show.macro || '',
      macroNumber: show.macroNumber ?? ''
    }))
  };
}

function saveConfig(nextConfig) {
  const validated = validateConfig(nextConfig);
  const body = JSON.stringify(validated, null, 2) + '\n';
  fs.writeFileSync(CONFIG_PATH, body, 'utf8');
  config = validated;
  return validated;
}

function listShowFiles() {
  const showDirectory = String(config.gma2.showDirectory || '').trim();
  if (!showDirectory) {
    throw new Error('gma2.showDirectory is not configured');
  }

  let entries;
  try {
    entries = fs.readdirSync(showDirectory, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Cannot read showDirectory: ${showDirectory}`);
  }

  return entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.show'))
    .map(entry => {
      const file = entry.name;
      const loadShowName = path.basename(file, '.show');
      return {
        name: loadShowName,
        file,
        loadShowName,
        macro: '',
        macroNumber: '36'
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file, undefined, { sensitivity: 'base' }));
}

function getAvailableShows() {
  if (!config.gma2.preferShowDirectory && Array.isArray(config.shows) && config.shows.length > 0) {
    return config.shows;
  }
  const showFiles = listShowFiles();
  if (showFiles.length > 0) {
    return showFiles;
  }
  return config.shows;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readRequestBody(req);
  try {
    return JSON.parse(raw || '{}');
  } catch (err) {
    throw new Error('Invalid JSON body');
  }
}

function buildConfigWithUpdatedShows(input) {
  const shows = input && input.shows;
  if (!Array.isArray(shows)) throw new Error('shows must be an array');

  const cleanedShows = shows.map((show, index) => {
    const name = String(show.name || '').trim();
    const file = String(show.file || '').trim();
    const loadShowName = String(show.loadShowName || '').trim();
    const macro = String(show.macro || '').trim();
    const macroNumber = show.macroNumber == null || show.macroNumber === ''
      ? null
      : String(show.macroNumber).trim();

    if (!name) throw new Error(`Show ${index + 1}: name is required`);
    if (!macro && !macroNumber) throw new Error(`Show "${name}": macro or macroNumber is required`);
    if (!loadShowName && !file) {
      throw new Error(`Show "${name}": loadShowName or file is required`);
    }

    const cleaned = { name };
    if (macro) cleaned.macro = macro;
    if (macroNumber) cleaned.macroNumber = macroNumber;
    if (file) cleaned.file = file;
    if (loadShowName) cleaned.loadShowName = loadShowName;
    return cleaned;
  });

  return {
    ...config,
    gma2: {
      ...config.gma2,
      preferShowDirectory: input && input.preferShowDirectory === true
    },
    shows: cleanedShows
  };
}

function setStatus(state, message, patch = {}) {
  status.state = state;
  status.message = message;
  status.updatedAt = new Date().toISOString();
  Object.assign(status, patch);
  appendRecentEvent(message);
  log('info', message, { state, show: status.show });
}

function publicStatus() {
  return {
    ...status,
    busy: ![STATES.IDLE, STATES.READY, STATES.ERROR].includes(status.state),
    shows: getAvailableShows().map(s => s.name)
  };
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function sendText(res, code, text) {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(text);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.ico') return 'image/x-icon';
  return 'application/octet-stream';
}

function sendStatic(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendJson(res, 404, { ok: false, error: 'Not found' });
  }

  res.writeHead(200, {
    'Content-Type': contentTypeFor(filePath),
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(filePath).pipe(res);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTcpReachable(host, port, timeoutMs = 900) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finish = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitForTcpClosed(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const reachable = await isTcpReachable(host, port);
    if (!reachable) return;
    await sleep(500);
  }

  throw new Error(`Telnet at ${host}:${port} is still reachable after shutdown; gMA2 may still be running or another gMA2 instance is open`);
}

function waitForTcp(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host, port });
      let settled = false;

      socket.setTimeout(1200);

      socket.once('connect', () => {
        settled = true;
        socket.destroy();
        resolve();
      });

      const retry = () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for telnet at ${host}:${port}`));
        } else {
          setTimeout(attempt, 500);
        }
      };

      socket.once('timeout', retry);
      socket.once('error', retry);
    };

    attempt();
  });
}

class TelnetClient {
  constructor(host, port, commandDelayMs) {
    this.host = host;
    this.port = port;
    this.commandDelayMs = commandDelayMs;
    this.socket = null;
    this.buffer = '';
  }

  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Telnet connect timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      socket.on('data', data => {
        this.buffer += data.toString('utf8');
      });

      socket.once('close', hadError => {
        log('telnet', 'socket closed', { hadError });
      });

      socket.once('connect', () => {
        clearTimeout(timer);
        log('telnet', 'socket connected', { host: this.host, port: this.port });
        resolve();
      });

      socket.once('error', err => {
        clearTimeout(timer);
        log('telnet', 'socket error', { error: err.message || String(err) });
        reject(err);
      });
    });
  }

  async send(command, waitMs = this.commandDelayMs) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Telnet socket is not connected');
    }
    log('telnet', 'send command', { command: redactCommand(command) });
    this.socket.write(command + '\r\n');
    await sleep(waitMs);
    const response = this.buffer;
    this.buffer = '';
    if (response.trim()) {
      log('telnet', 'response', { response: response.slice(-2000) });
    }
    return response;
  }

  close() {
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
  }
}

function redactCommand(command) {
  if (/^login\s+/i.test(command)) return command.replace(/("[^"]*"\s*)"[^"]*"/, '$1"***"');
  return command;
}

function renderTemplate(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
}

function resolveLoadShowName(show) {
  if (show.loadShowName) return show.loadShowName;
  if (show.file) return String(show.file).replace(/\.show$/i, '');
  return show.name;
}

function resolveMacroValues(show) {
  const macro = show.macro ? String(show.macro).trim() : '';
  const macroNumber = show.macroNumber == null ? '' : String(show.macroNumber).trim();
  return {
    macro,
    macroNumber,
    macroRef: macroNumber || macro
  };
}

function buildLoginCommand() {
  return renderTemplate(config.gma2.loginCommand, {
    user: config.gma2.telnetUser || '',
    password: config.gma2.telnetPassword || ''
  });
}

function findShow(showNameFromUrl) {
  const wanted = decodeURIComponent(showNameFromUrl).trim().toLowerCase();
  return getAvailableShows().find(show => show.name.toLowerCase() === wanted);
}

function launchGma2() {
  const exe = config.gma2.executable;
  const cwd = path.dirname(exe);

  if (!fs.existsSync(exe)) {
    throw new Error(`gMA2 executable not found: ${exe}`);
  }

  gmaProcess = spawn(exe, [], {
    cwd,
    detached: false,
    stdio: 'ignore',
    windowsHide: false
  });

  gmaProcess.once('exit', (code, signal) => {
    log('info', 'gMA2 process exited', { pid: gmaProcess?.pid, code, signal });
    gmaProcess = null;
  });

  log('info', 'gMA2 launched', { pid: gmaProcess.pid, exe });
}

function killGma2ProcessTree() {
  return new Promise(resolve => {
    if (!gmaProcess || !gmaProcess.pid) return resolve();

    const pid = String(gmaProcess.pid);
    log('info', 'Killing gMA2 process tree', { pid });
    execFile('taskkill.exe', ['/PID', pid, '/T', '/F'], { windowsHide: true }, (err, stdout, stderr) => {
      if (err) log('warn', 'taskkill returned an error', { error: err.message, stdout, stderr });
      gmaProcess = null;
      resolve();
    });
  });
}

function killAllMatchingGma2Processes() {
  return new Promise(resolve => {
    if (!config.gma2.forceKillAllMatchingProcessesOnClose) return resolve();

    const imageName = config.gma2.processImageName || path.basename(config.gma2.executable);
    if (!imageName || !imageName.toLowerCase().endsWith('.exe')) return resolve();

    log('info', 'Killing all matching gMA2 processes by image name', { imageName });
    execFile('taskkill.exe', ['/IM', imageName, '/T', '/F'], { windowsHide: true }, (err, stdout, stderr) => {
      // taskkill returns an error when no matching process exists. That is fine here.
      if (err) log('info', 'taskkill /IM finished', { error: err.message, stdout, stderr });
      resolve();
    });
  });
}

async function closeAndVerifyGma2() {
  await killGma2ProcessTree();
  await killAllMatchingGma2Processes();
  await sleep(config.gma2.shutdownWaitMs);

  if (config.gma2.verifyTelnetClosedBeforeReady) {
    log('info', 'Verifying gMA2 Telnet is closed before READY');
    await waitForTcpClosed(
      config.gma2.telnetHost,
      config.gma2.telnetPort,
      config.gma2.shutdownVerifyTimeoutMs
    );
  }

  if (config.gma2.postShutdownNetworkQuietMs > 0) {
    log('info', 'Waiting extra network quiet time after gMA2 shutdown', {
      ms: config.gma2.postShutdownNetworkQuietMs
    });
    await sleep(config.gma2.postShutdownNetworkQuietMs);
  }
}

function mergeFailureMessages(primaryErr, shutdownErr) {
  const primary = primaryErr?.message || String(primaryErr);
  if (!shutdownErr) return primary;
  const shutdown = shutdownErr?.message || String(shutdownErr);
  return `${primary} Shutdown verification also failed: ${shutdown}`;
}

async function connectTelnetWithOptionalDelay() {
  if (config.gma2.postPortOpenWaitMs > 0) {
    log('info', 'Waiting after Telnet port becomes reachable before connect', {
      ms: config.gma2.postPortOpenWaitMs
    });
    await sleep(config.gma2.postPortOpenWaitMs);
  }

  const telnet = new TelnetClient(config.gma2.telnetHost, config.gma2.telnetPort, config.gma2.commandDelayMs);
  await telnet.connect();

  if (config.gma2.postConnectWaitMs > 0) {
    log('info', 'Waiting after Telnet connect before first command', {
      ms: config.gma2.postConnectWaitMs
    });
    await sleep(config.gma2.postConnectWaitMs);
  }

  return telnet;
}

function isTelnetConnected(telnet) {
  return Boolean(telnet && telnet.socket && !telnet.socket.destroyed);
}

async function sendLoginIfConfigured(telnet, reason) {
  if (!config.gma2.loginCommand) return telnet;

  const login = buildLoginCommand();
  log('info', 'Sending gMA2 login command', { reason });
  await telnet.send(login);
  log('info', 'gMA2 login command finished', { reason });
  return telnet;
}

async function reconnectTelnetIfNeeded(telnet, reason) {
  if (isTelnetConnected(telnet)) return { telnet, reconnected: false };

  log('warn', 'Telnet socket is no longer connected, reconnecting', { reason });
  if (telnet) telnet.close();
  return {
    telnet: await connectTelnetWithOptionalDelay(),
    reconnected: true
  };
}

async function runAutomation(show, options = {}) {
  if (currentRun) {
    throw new Error('Automation already running');
  }

  const closeOnFinish = options.closeOnFinish ?? config.gma2.closeOnFinish;

  currentRun = { show: show.name, startedAt: new Date().toISOString() };
  status.startedAt = currentRun.startedAt;
  status.show = show.name;
  status.lastError = null;
  status.recentEvents = [];
  clearTimeout(readyIdleTimer);

  let telnet = null;

  try {
    if (config.gma2.rejectIfTelnetAlreadyOpen) {
      const alreadyOpen = await isTcpReachable(config.gma2.telnetHost, config.gma2.telnetPort);
      if (alreadyOpen) {
        throw new Error(`gMA2 Telnet is already reachable at ${config.gma2.telnetHost}:${config.gma2.telnetPort}. Close existing gMA2 onPC before starting automation.`);
      }
    }

    setStatus(STATES.LAUNCHING, `Launching gMA2 onPC for ${show.name}`);
    launchGma2();

    setStatus(STATES.WAITING_FOR_TELNET, 'Waiting for gMA2 Telnet to become reachable');
    await waitForTcp(config.gma2.telnetHost, config.gma2.telnetPort, config.gma2.startupTimeoutMs);

    telnet = await connectTelnetWithOptionalDelay();

    if (config.gma2.loginCommand) {
      setStatus(STATES.LOGGING_IN, 'Logging in to gMA2 Telnet');
      ({ telnet } = await reconnectTelnetIfNeeded(telnet, 'before login'));
      await sendLoginIfConfigured(telnet, 'before login');
    }

    setStatus(STATES.LOADING_SHOW, `Loading showfile ${show.name}`);
    const loadShowName = resolveLoadShowName(show);
    const loadCommand = renderTemplate(config.gma2.loadShowCommand, {
      show: loadShowName,
      file: show.file || '',
      name: show.name
    });
    {
      const reconnectResult = await reconnectTelnetIfNeeded(telnet, 'before loadshow');
      telnet = reconnectResult.telnet;
      if (reconnectResult.reconnected) {
        await sendLoginIfConfigured(telnet, 'after reconnect before loadshow');
      }
    }
    log('info', 'Sending LoadShow command', { loadShowName });
    await telnet.send(loadCommand);
    log('info', 'LoadShow command finished', { loadShowName });
    await sleep(show.showLoadWaitMs || config.gma2.showLoadWaitMs);

    if (config.gma2.loginAfterLoadShow && config.gma2.loginCommand) {
      ({ telnet } = await reconnectTelnetIfNeeded(telnet, 'after loadshow before second login'));
      await sendLoginIfConfigured(telnet, 'after loadshow before second login');
    }

    const macroValues = resolveMacroValues(show);
    setStatus(STATES.RUNNING_MACRO, `Running macro for ${show.name}`);
    const macroCommand = renderTemplate(config.gma2.macroCommand, {
      macro: macroValues.macro,
      macroNumber: macroValues.macroNumber,
      macroRef: macroValues.macroRef,
      show: loadShowName,
      name: show.name
    });
    {
      const reconnectResult = await reconnectTelnetIfNeeded(telnet, 'before macro');
      telnet = reconnectResult.telnet;
      if (reconnectResult.reconnected) {
        await sendLoginIfConfigured(telnet, 'after reconnect before macro');
      }
    }
    log('info', 'Sending Macro command', { macro: macroValues.macro, macroNumber: macroValues.macroNumber });
    await telnet.send(macroCommand);
    log('info', 'Macro command finished', { macro: macroValues.macro, macroNumber: macroValues.macroNumber });
    await sleep(show.macroWaitMs || config.gma2.macroWaitMs);

    telnet.close();
    if (closeOnFinish) {
      setStatus(STATES.CLOSING, 'Closing gMA2 onPC and releasing MA-Net');
      await closeAndVerifyGma2();
      setStatus(STATES.READY, 'Ready — gMA2 is closed, start grandMA3', { lastError: null });
    } else {
      setStatus(STATES.READY, 'Ready — macro finished, gMA2 remains open', { lastError: null });
    }

    if (config.service.autoReturnToIdleMs > 0) {
      readyIdleTimer = setTimeout(() => {
        setStatus(STATES.IDLE, 'Idle', { show: null });
      }, config.service.autoReturnToIdleMs);
    }
  } catch (err) {
    const errorMessage = err && err.stack ? err.stack : String(err);
    log('error', 'Automation failed', { error: errorMessage, show: show.name });

    if (telnet) telnet.close();
    let shutdownError = null;
    try {
      await closeAndVerifyGma2();
    } catch (closeErr) {
      shutdownError = closeErr;
      log('error', 'Failed to verify gMA2 shutdown after automation error', {
        error: closeErr.stack || String(closeErr)
      });
    }

    setStatus(STATES.ERROR, 'Error — gMA2 was closed for safety', {
      lastError: mergeFailureMessages(err, shutdownError)
    });
  } finally {
    currentRun = null;
  }
}

function htmlConsole() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>gMA2 Telnet Test</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; }
    input { width: 70%; padding: .5rem; }
    button { padding: .55rem 1rem; }
    pre { background: #111; color: #eee; padding: 1rem; min-height: 18rem; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>gMA2 Telnet Test</h1>
  <p>This sends one raw command per request to ${config.gma2.telnetHost}:${config.gma2.telnetPort}.</p>
  <input id="cmd" placeholder='Login "Administrator" ""'> <button onclick="send()">Send</button>
  <pre id="out"></pre>
  <script>
    async function send() {
      const cmd = document.getElementById('cmd').value;
      const res = await fetch('/telnet-send', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({cmd}) });
      const text = await res.text();
      document.getElementById('out').textContent += '> ' + cmd + '\n' + text + '\n';
    }
  </script>
</body>
</html>`;
}

async function sendSingleTelnetCommand(command) {
  const client = new TelnetClient(config.gma2.telnetHost, config.gma2.telnetPort, config.gma2.commandDelayMs);
  try {
    await client.connect();
    const response = await client.send(command, 750);
    return response || '(no response)';
  } finally {
    client.close();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/ui' || url.pathname === '/ui/')) {
      return sendStatic(res, path.join(PUBLIC_DIR, 'index.html'));
    }

    if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
      return sendStatic(res, path.join(PUBLIC_DIR, 'admin.html'));
    }

    if (req.method === 'GET' && url.pathname.startsWith('/ui/')) {
      const relativePath = decodeURIComponent(url.pathname.slice('/ui/'.length));
      const filePath = path.resolve(PUBLIC_DIR, relativePath);
      if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
        return sendJson(res, 403, { ok: false, error: 'Forbidden' });
      }
      return sendStatic(res, filePath);
    }

    if (req.method === 'GET' && url.pathname.startsWith('/admin/')) {
      const relativePath = decodeURIComponent(url.pathname.slice('/admin/'.length));
      const filePath = path.resolve(PUBLIC_DIR, relativePath);
      if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
        return sendJson(res, 403, { ok: false, error: 'Forbidden' });
      }
      return sendStatic(res, filePath);
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      return sendJson(res, 200, publicStatus());
    }

    if (req.method === 'GET' && url.pathname === '/config') {
      return sendJson(res, 200, adminConfig());
    }

    if (req.method === 'GET' && url.pathname === '/shows') {
      return sendJson(res, 200, getAvailableShows().map(show => ({ name: show.name })));
    }

    if (req.method === 'GET' && url.pathname === '/show-files') {
      return sendJson(res, 200, {
        showDirectory: config.gma2.showDirectory || '',
        shows: listShowFiles()
      });
    }

    if (req.method === 'POST' && url.pathname.startsWith('/run/')) {
      if (currentRun) return sendJson(res, 409, { ok: false, error: 'Automation already running', status: publicStatus() });

      const showName = url.pathname.slice('/run/'.length);
      const show = findShow(showName);
      if (!show) return sendJson(res, 404, { ok: false, error: `Unknown show: ${decodeURIComponent(showName)}` });

      const parsed = await readJsonBody(req).catch(() => ({}));
      const options = {
        closeOnFinish: typeof parsed.closeOnFinish === 'boolean' ? parsed.closeOnFinish : undefined
      };

      runAutomation(show, options).catch(err => log('error', 'Uncaught automation error', { error: err.stack || String(err) }));
      return sendJson(res, 202, { ok: true, status: publicStatus() });
    }

    if (req.method === 'POST' && (url.pathname === '/confirm-gma3' || url.pathname === '/reset')) {
      if (currentRun) return sendJson(res, 409, { ok: false, error: 'Cannot reset while automation is running' });
      clearTimeout(readyIdleTimer);
      setStatus(STATES.IDLE, 'Idle', { show: null, lastError: null, startedAt: null, recentEvents: [] });
      return sendJson(res, 200, { ok: true, status: publicStatus() });
    }

    if (req.method === 'POST' && url.pathname === '/reload-config') {
      if (currentRun) return sendJson(res, 409, { ok: false, error: 'Cannot reload config while automation is running' });
      config = loadConfig();
      log('info', 'Config reloaded');
      return sendJson(res, 200, { ok: true, shows: getAvailableShows().map(s => s.name) });
    }

    if (req.method === 'POST' && url.pathname === '/save-config') {
      if (currentRun) return sendJson(res, 409, { ok: false, error: 'Cannot save config while automation is running' });
      const parsed = await readJsonBody(req);
      const nextConfig = buildConfigWithUpdatedShows(parsed);
      saveConfig(nextConfig);
      log('info', 'Config saved from admin UI', { shows: nextConfig.shows.map(show => show.name) });
      return sendJson(res, 200, { ok: true, shows: getAvailableShows().map(show => show.name) });
    }

    if (req.method === 'GET' && url.pathname === '/telnet-test') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(htmlConsole());
    }

    if (req.method === 'POST' && url.pathname === '/telnet-send') {
      try {
        const parsed = await readJsonBody(req);
        if (!parsed.cmd) return sendText(res, 400, 'Missing cmd');
        const response = await sendSingleTelnetCommand(parsed.cmd);
        return sendText(res, 200, response);
      } catch (err) {
        return sendText(res, 500, err.message || String(err));
      }
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    log('error', 'HTTP handler error', { error: err.stack || String(err) });
    return sendJson(res, 500, { ok: false, error: err.message || String(err) });
  }
});

server.listen(config.service.port, config.service.host, () => {
  log('info', 'gMA2 automation service started', {
    host: config.service.host,
    port: config.service.port,
    shows: config.shows.map(show => show.name)
  });
  console.log(`gMA2 automation listening on http://${config.service.host}:${config.service.port}`);
});

async function handleProcessShutdown(signal) {
  log('info', `${signal} received, shutting down`);
  try {
    await closeAndVerifyGma2();
  } catch (err) {
    log('error', 'Failed to verify gMA2 shutdown during process exit', {
      signal,
      error: err.stack || String(err)
    });
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => {
  handleProcessShutdown('SIGINT');
});

process.on('SIGTERM', () => {
  handleProcessShutdown('SIGTERM');
});

process.on('uncaughtException', err => {
  log('error', 'uncaughtException', { error: err.stack || String(err) });
});

process.on('unhandledRejection', err => {
  log('error', 'unhandledRejection', { error: err && err.stack ? err.stack : String(err) });
});
