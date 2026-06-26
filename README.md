# gMA2 onPC Node Automation

Small local HTTP automation service for loading a grandMA2 onPC showfile, running a node/universe setup macro, closing gMA2 onPC, and then handing off to a grandMA3 console.

## Why Scheduled Task instead of Windows Service?

grandMA2 onPC is a GUI application. Real Windows Services run in Session 0 and often cannot launch or control GUI applications reliably. This project therefore uses a hidden Scheduled Task at user logon. The Elo Touch PC should auto-login into the operator user, start Pandora's Box fullscreen, and start this local Node.js service hidden in the background.

## Requirements

- Windows on the Elo Touch PC
- Node.js LTS installed
- grandMA2 onPC installed
- Telnet enabled inside grandMA2: `Setup -> Console -> Global Settings -> Telnet`
- The onPC user used for Telnet must exist in the loaded showfile

## Files

```text
gma2-automation/
├── config.json
├── service.js
├── test-console.js
├── install.bat
├── uninstall.bat
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── service.log
└── README.md
```

## Configure

Edit `config.json`:

```json
{
  "gma2": {
    "executable": "C:\\Program Files\\MA Lighting Technologies\\grandMA2 onPC\\grandMA2 onPC.exe",
    "telnetHost": "127.0.0.1",
    "telnetPort": 30000,
    "telnetUser": "Administrator",
    "telnetPassword": "",
    "startupTimeoutMs": 30000,
    "showLoadWaitMs": 12000,
    "macroWaitMs": 5000,
    "postPortOpenWaitMs": 0,
    "postConnectWaitMs": 0,
    "loginCommand": "Login \"{user}\" \"{password}\"",
    "loadShowCommand": "LoadShow \"{show}\" /nosave /noconfirm",
    "macroCommand": "Macro \"{macro}\""
  },
  "service": {
    "host": "127.0.0.1",
    "port": 3737
  },
  "shows": [
    {
      "name": "Hamlet",
      "file": "Showfile_Hamlet.show",
      "loadShowName": "Showfile_Hamlet",
      "macro": "VK Einrichtung (Hamlet)"
    }
  ]
}
```

`loadShowName` should normally be the gMA2 show name without `.show`, because the grandMA2 command line syntax uses show names such as `LoadShow "Macbeth"`.


### Handoff safety: gMA2 must be gone before grandMA3 starts

The service only reports `READY` after it has closed grandMA2 onPC and verified that the Telnet port is no longer reachable. This is intentional: the grandMA3 should not be powered on or connected while gMA2 onPC can still access the MA-Net nodes.

Relevant safety options in `config.json`:

```json
{
  "shutdownWaitMs": 3000,
  "shutdownVerifyTimeoutMs": 12000,
  "postShutdownNetworkQuietMs": 2000,
  "verifyTelnetClosedBeforeReady": true,
  "rejectIfTelnetAlreadyOpen": true,
  "forceKillAllMatchingProcessesOnClose": true,
  "processImageName": "grandMA2 onPC.exe"
}
```

What these options do:

- `rejectIfTelnetAlreadyOpen`: refuses to start if another gMA2/onPC Telnet endpoint is already open before automation starts.
- `forceKillAllMatchingProcessesOnClose`: also kills matching `grandMA2 onPC.exe` processes, not only the process ID started by this service.
- `verifyTelnetClosedBeforeReady`: checks that port `30000` is closed before showing `READY`.
- `postShutdownNetworkQuietMs`: extra delay after shutdown before telling the operator to start grandMA3.
- `postPortOpenWaitMs`: waits after port `30000` becomes reachable before the first real Telnet connect attempt.
- `postConnectWaitMs`: waits after Telnet connect before sending `Login`. Useful if gMA2 opens port `30000` before it is fully ready.

If the log shows that the Telnet socket connects but drops during `Login` or `LoadShow`, try these timing values first:

```json
{
  "postPortOpenWaitMs": 5000,
  "postConnectWaitMs": 3000,
  "commandDelayMs": 1500
}
```

If the Telnet port is still open after shutdown, the service shows `ERROR` instead of `READY`. In that case, do not start grandMA3 until gMA2 onPC is manually closed or the PC is rebooted.

Important for the technician on site:

- `READY` is the only safe handoff state.
- `ERROR` means the service attempted to close gMA2 onPC for safety, but handoff was not confirmed.
- If `ERROR` mentions shutdown or Telnet verification, treat the PC as unsafe for grandMA3 until gMA2 onPC is visibly closed and port `30000` is no longer reachable.

## First on-site test

1. Start grandMA2 onPC manually.
2. Enable Telnet in gMA2 Global Settings.
3. Open a terminal in this folder.
4. Run:

```bat
node test-console.js
```

Try these commands manually:

```text
Login "Administrator" ""
LoadShow "Showfile_Hamlet" /nosave /noconfirm
Macro "VK Einrichtung (Hamlet)"
```

If `Macro "..."` does not execute on your version/show, try the variant below and then update `macroCommand` in `config.json`:

```text
Go Macro "VK Einrichtung (Hamlet)"
```

## Run service manually

```bat
node service.js
```

Open the status endpoint:

```text
http://127.0.0.1:3737/status
```

Open the touchscreen UI:

```text
http://127.0.0.1:3737/ui
```

The UI automatically reads the show list from `config.json`, creates one large touchscreen button per show, starts the automation via `/run/<show>`, polls `/status` every 2 seconds, and shows the progress state.

Open the local admin UI:

```text
http://127.0.0.1:3737/admin
```

This page is meant for a technician. It edits the `shows[]` list in `config.json` without opening the JSON file manually. The first version is intentionally limited to:

- touch button name
- `loadShowName`
- optional `.show` filename
- macro name

Global gMA2/service settings are still edited directly in `config.json`.

## Install autostart

Run `install.bat` as Administrator. It creates a hidden scheduled task at user login.

The installer stores the full path to `node.exe` inside the helper script. This avoids a common Windows problem where the task starts at logon but cannot find Node.js because the user `PATH` is different from the installer shell.

To remove it, run `uninstall.bat`.

## HTTP API

### List shows

```http
GET http://127.0.0.1:3737/shows
```

### Read editable admin config

```http
GET http://127.0.0.1:3737/config
```

### Status

```http
GET http://127.0.0.1:3737/status
```

Example response:

```json
{
  "state": "READY",
  "message": "Ready — gMA2 is closed, start grandMA3",
  "show": "Hamlet",
  "lastError": null,
  "busy": false,
  "shows": ["Hamlet", "Faust"]
}
```

### Run show setup

```http
POST http://127.0.0.1:3737/run/Hamlet
```

For show names with spaces or special characters, URL-encode the name.

### Confirm/reset after gMA3 was started

```http
POST http://127.0.0.1:3737/confirm-gma3
```

### Reload config after editing `config.json`

```http
POST http://127.0.0.1:3737/reload-config
```

### Save show list from admin UI

```http
POST http://127.0.0.1:3737/save-config
Content-Type: application/json
```

### Browser Telnet test page

```http
GET http://127.0.0.1:3737/telnet-test
```


## Touch UI / Pandora's Box variant B

The service includes a local web UI:

```text
http://127.0.0.1:3737/ui
```

This page is intended for the Elo Touch PC. It does not need fixed Pandora's Box buttons for every show. It reads the show names from `config.json` and generates the buttons automatically.

Recommended flow:

1. Start the Node service automatically via `install.bat`.
2. In Pandora's Box / Widget Designer, show or open the local URL below fullscreen:

```text
http://127.0.0.1:3737/ui
```

3. The operator presses the show button on the web UI.
4. The UI shows the current state and progress.
5. When it says `Fertig — gMA2 onPC ist geschlossen und greift nicht mehr auf die Nodes zu`, the operator starts grandMA3.
6. The operator presses `grandMA3 gestartet / zurück zur Auswahl`.

After editing `config.json`, press `Config neu laden` in the UI or call:

```http
POST http://127.0.0.1:3737/reload-config
```

If your Pandora's Box setup cannot embed/show a web page, use a normal browser in kiosk/fullscreen mode on the Elo Touch PC and keep Pandora's Box out of this specific show-selection page.

## Pandora's Box integration with manual PB buttons

If you do not use `/ui`, you can still use HTTP output actions:

```text
POST http://127.0.0.1:3737/run/Hamlet
GET  http://127.0.0.1:3737/status
POST http://127.0.0.1:3737/confirm-gma3
```

Poll `/status` every 2 seconds and map states to UI text:

```text
IDLE                 Waiting for show selection
LAUNCHING            Launching gMA2 onPC...
WAITING_FOR_TELNET   Waiting for gMA2 Telnet...
LOGGING_IN           Logging into gMA2...
LOADING_SHOW         Loading showfile...
RUNNING_MACRO        Running universe macro...
CLOSING              Closing gMA2 onPC...
READY                gMA2 closed and verified — start grandMA3
ERROR                Error — call technician
```

## Safety notes

- Keep the grandMA3 console powered off or disconnected from the MA-Net session until the service reports `READY`. `READY` means gMA2 onPC was killed and Telnet was verified closed.
- On any error, the service force-kills the gMA2 process tree with `taskkill /PID <pid> /T /F`, kills matching `grandMA2 onPC.exe` processes if enabled, and then tries to verify that Telnet is closed.
- `service.log` contains JSON lines with state changes and Telnet responses.
- Telnet is local-only in this config. Avoid exposing port 30000 to the venue network unless absolutely necessary.
- Show names in `config.json` must be unique, because the HTTP API and UI resolve them case-insensitively.
