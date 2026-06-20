import { app, BrowserWindow, ipcMain, clipboard, Tray, Menu, screen } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import * as dgram from 'dgram';
import * as http from 'http';
import { Server } from 'socket.io';
import * as os from 'os';
import * as fs from 'fs';
import * as CryptoJS from 'crypto-js';
import { execSync, spawnSync } from 'child_process';
import * as crypto from 'crypto';

type FilePayload = {
  name: string;
  type?: string;
  data?: string;  // base64 (legacy / small files)
  path?: string;  // local file path (large files)
  url?: string;   // download URL (sent to phone)
};

import { EventEmitter } from 'events';
const ghostBus = new EventEmitter();

interface PairedDevice {
  machineId: string;
  hostname: string;
  secretKey: string;
  lastKnownIp: string;
}

interface AppConfig {
  machineId: string;
  pairedDevices: PairedDevice[];
  lastUpdated?: string;
}

let config: AppConfig = {
  machineId: '',
  pairedDevices: []
};
let configPath: string;

// 🖥️ PC-to-PC Connection State
let clientSocket: any = null;
let clientSocketSecretKey = '';
let clientSocketMachineId = '';
let clientSocketHostname = '';
let currentPairingIp = '';
let clientConnected = false;
let connectedHostInfo: { hostname: string; ip: string } | null = null;
const discoveredPcs = new Map<string, { hostname: string; ip: string; port: number; machineId: string; lastSeen: number; device?: 'windows' | 'linux' | 'android' }>();
let udpSocket: dgram.Socket | null = null;
let udpBroadcastInterval: NodeJS.Timeout | null = null;
const UDP_PORT = 43222;
let activePairingSocket: any = null;
let pendingPairingTarget: { ip: string; machineId: string; hostname: string } | null = null;

// State
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let io: Server | null = null;
let lastClipboardText = readBestClipboardText();
let isQuitting = false;
let syncKey = 'CodebLink-Default-Key';
const pollListeners = new Set<(text: string) => void>();

// 📦 GHOST VAULT: Holds the last message for 60s for phones "between" polls
let ghostVault: { content: string; timestamp: number } | null = null;

// 📁 PENDING DOWNLOADS: token → file path, expires after 10 minutes
const pendingDownloads = new Map<string, { filePath: string; expires: number }>();

// Internal bus: when clipboard changes, tell all long-polling background clients
ghostBus.on('broadcast', (text: string) => {
  // Only fill the vault for plain clipboard text — file payloads are one-shot
  // (they carry a single-use download token) and must NOT be vaulted, otherwise
  // a re-poll after the live listener fires would deliver the same token again
  // and trigger a duplicate download.
  const isFileBroadcast = text.startsWith('{"type":"file"');
  if (!isFileBroadcast) {
    ghostVault = { content: text, timestamp: Date.now() };
  }

  for (const listener of pollListeners) {
    listener(text);
  }
});

const trayIconPath = path.join(__dirname, 'icon.png');
const windowIconPath = path.join(__dirname, 'icon.ico');
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];

// ─── showMainWindow (workspace-shift trick) ──────────────────────────────
function showMainWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }

  const wasVisible = win.isVisible();

  // If visible on another workspace, hide first so it re-appears on the
  // CURRENT workspace
  if (wasVisible) {
    win.hide();
  }

  if (win.isMinimized()) {
    win.restore();
  }

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.show();
  win.moveTop();
  win.focus();

  // Unpin after it's safely shown on the current workspace
  setTimeout(() => {
    if (win && !win.isDestroyed()) {
      win.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true });
    }
  }, 300);
}


// ─── Single Instance Lock ────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(() => {
    loadConfig();
    createWindow();
    setupAutoUpdater();
    createTray();
    startSocketServer();
    startClipboardPolling();
    startUdpDiscovery();
  });
}

function loadConfig() {
  try {
    configPath = path.join(app.getPath('userData'), 'config.json');
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(data);
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }

  if (!config.machineId) {
    config.machineId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    saveConfig();
  }
  if (!config.pairedDevices) {
    config.pairedDevices = [];
    saveConfig();
  }
}

function saveConfig() {
  try {
    if (configPath) {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    }
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}

function setupAutoUpdater() {
  const isDev = !app.isPackaged || !!VITE_DEV_SERVER_URL;
  if (isDev) return;

  autoUpdater.autoDownload = true;   // download silently in background
  autoUpdater.autoInstallOnAppQuit = true; // install on next quit

  const send = (channel: string, data: any) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  };

  autoUpdater.on('checking-for-update', () => {
    send('updater:status', { status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    send('updater:status', { status: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    send('updater:status', { status: 'uptodate' });
  });

  autoUpdater.on('download-progress', (progress) => {
    send('updater:status', {
      status: 'downloading',
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    config.lastUpdated = new Date().toISOString();
    saveConfig();
    send('updater:status', { status: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    send('updater:status', { status: 'error', message: err.message });
  });

  // Check immediately on launch, then every 2 hours
  autoUpdater.checkForUpdates();
  setInterval(() => autoUpdater.checkForUpdates(), 2 * 60 * 60 * 1000);
}

// ─── Window ──────────────────────────────────────────────────────────────
function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize || primaryDisplay.size;

  win = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height,
    icon: fs.existsSync(windowIconPath) ? windowIconPath : undefined,
    show: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  Menu.setApplicationMenu(null);
  win.removeMenu();

  win.once('ready-to-show', () => {
    if (win) {
      if (process.platform === 'linux' && fs.existsSync(trayIconPath)) {
        const { nativeImage } = require('electron');
        win.setIcon(nativeImage.createFromPath(trayIconPath));
      }
      win.maximize();
      win.show();
    }
  });

  win.on('maximize', () => { if (win && !win.isDestroyed()) win.webContents.send('window:maximized', true); });
  win.on('unmaximize', () => { if (win && !win.isDestroyed()) win.webContents.send('window:maximized', false); });

  win.on('close', (event: any) => {
    if (!isQuitting) {
      event.preventDefault();
      win?.hide();
    }
  });

  win.on('closed', () => { win = null; });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    // __dirname is dist-electron/ inside the asar; dist/ is one level up at asar root
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// ─── Tray ────────────────────────────────────────────────────────────────
function createTray() {
  if (!fs.existsSync(trayIconPath)) {
    console.log('Tray icon not found. Add icon.png to enable system tray.');
    return;
  }
  try {
    const { nativeImage } = require('electron');
    const image = nativeImage.createFromPath(trayIconPath);

    if (image.isEmpty()) {
      console.error('Failed to load tray icon: image is empty at', trayIconPath);
      return;
    }

    // Windows system tray icon — 16×16 renders cleanly in the notification area
    const size = process.platform === 'win32' ? 16 : 22;
    const trayImage = image.resize({ width: size, height: size });
    tray = new Tray(trayImage);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Codeb Link',
        click: () => { showMainWindow(); }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          if (tray) { tray.destroy(); tray = null; }
          app.quit();
        }
      },
    ]);

    tray.setToolTip('Codeb Link');
    tray.setContextMenu(contextMenu);

    const closeTrayMenuSoon = () => {
      setTimeout(() => { if (tray) tray.closeContextMenu(); }, 0);
    };

    // Left click → open window on current workspace
    tray.on('click', (event: any) => {
      const button = event && event.button;
      if (button === 2 || button === 'right') return;
      showMainWindow();
      closeTrayMenuSoon();
    });

    // Double-click → open window (Windows-specific fallback)
    tray.on('double-click', () => {
      showMainWindow();
    });

    // Right click → show context menu
    tray.on('right-click', () => {
      tray!.popUpContextMenu(contextMenu);
    });

    // GNOME extensions may emit only mouse-up for secondary click
    tray.on('mouse-up', (event: any) => {
      const button = event && event.button;
      if (button === 2 || button === 'right') {
        tray!.popUpContextMenu(contextMenu);
      }
    });

  } catch (e) {
    console.warn('Tray failed:', e);
  }
}

let ghostLastSeen = 0;
let lastReportedMode: 'socket' | 'ghost' | 'none' = 'none';

function updateOverallStatus() {
  const hasPaired = config.pairedDevices && config.pairedDevices.length > 0;
  if (!hasPaired) {
    ghostLastSeen = 0;
    lastReportedMode = 'none';
    win?.webContents.send('overall-connection-status', {
      connected: false,
      mode: 'none'
    });
    win?.webContents.send('client-connection-status', { connected: false });
    return;
  }

  let isSocketConnected = false;
  if (io) {
    for (const [_, socket] of io.sockets.sockets) {
      if (socket.data && socket.data.isAuthenticated) {
        isSocketConnected = true;
        break;
      }
    }
  }
  const isGhostActive = (Date.now() - ghostLastSeen) < 40000;

  let currentMode: 'socket' | 'ghost' | 'none' = 'none';
  if (isSocketConnected) currentMode = 'socket';
  else if (isGhostActive) currentMode = 'ghost';

  if (currentMode !== lastReportedMode) {
    lastReportedMode = currentMode;
    win?.webContents.send('overall-connection-status', {
      connected: currentMode !== 'none',
      mode: currentMode
    });
    if (currentMode === 'none') {
      win?.webContents.send('client-connection-status', { connected: false });
    }
  }
}

// Periodically check pulse
setInterval(updateOverallStatus, 5000);

// ─── Socket.io Server ───────────────────────────────────────────────────
function startSocketServer() {
  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    // ── GET /api/ping ────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ app: 'codeblink', hostname: os.hostname(), machineId: config.machineId }));
      return;
    }

    // ── POST /api/clipboard  (Android → PC) ──────────────────────────────
    if (req.method === 'POST' && req.url === '/api/clipboard') {
      ghostLastSeen = Date.now();
      updateOverallStatus();
      let body = '';
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        try {
          const { data } = JSON.parse(body);

          let text = '';
          const senderIp = req.socket.remoteAddress?.replace('::ffff:', '') || '';

          // First try the device with the matching IP
          const matchedDevice = config.pairedDevices.find(d => d.lastKnownIp === senderIp);
          if (matchedDevice) {
            try {
              const bytes = CryptoJS.AES.decrypt(data, matchedDevice.secretKey);
              text = bytes.toString(CryptoJS.enc.Utf8);
            } catch (e) { }
          }

          // If that failed or no matching IP, try all other keys
          if (!text) {
            for (const device of config.pairedDevices) {
              if (device === matchedDevice) continue;
              try {
                const bytes = CryptoJS.AES.decrypt(data, device.secretKey);
                text = bytes.toString(CryptoJS.enc.Utf8);
                if (text) break;
              } catch (e) { }
            }
          }

          if (text && text !== lastClipboardText) {
            lastClipboardText = text;
            writeSystemClipboard(text);
            win?.webContents.send('clipboard-received', text);
            process.stdout.write(`\r📋 [BG Sync] Clipboard received from Android\n`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Failed' }));
        }
      });
      return;

      // ── POST /api/ghost/receipt  (Android → PC confirmation) ─────────────
    } else if (req.method === 'POST' && req.url === '/api/ghost/receipt') {
      let body = '';
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        try {
          const { file } = JSON.parse(body);
          process.stdout.write(`\r✅ [Ghost] Phone confirmed receipt of: ${file}\n`);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400);
          res.end();
        }
      });
      return;

      // ── GET /api/clipboard/poll  (PC → Android long-poll) ────────────────
    } else if (req.method === 'GET' && req.url === '/api/clipboard/poll') {
      res.setHeader('Content-Type', 'application/json');
      ghostLastSeen = Date.now();
      updateOverallStatus();

      const sendResponse = (content: string) => {
        let responseBody;
        if (content.startsWith('{"type":"file"')) {
          responseBody = content;
        } else {
          const encrypted = CryptoJS.AES.encrypt(content, syncKey).toString();
          responseBody = JSON.stringify({ data: encrypted });
        }
        res.writeHead(200);
        res.end(responseBody);
        process.stdout.write(`\r🚀 [Ghost] Dispatching update (Vault/Live) ✓\n`);
      };

      // 1. Instant Vault Check
      if (ghostVault && (Date.now() - ghostVault.timestamp < 60000)) {
        sendResponse(ghostVault.content);
        ghostVault = null;
        return;
      }

      process.stdout.write(`\r🛰️ [Ghost] Background device waiting...\n`);

      // Hold connection open until clipboard changes or 25s timeout
      const timeoutId = setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(204); // No content
          res.end();
        }
      }, 25000);

      const onClipChange = (content: string) => {
        clearTimeout(timeoutId);
        if (!res.writableEnded) {
          sendResponse(content);
        }
      };

      pollListeners.add(onClipChange);
      req.on('close', () => {
        clearTimeout(timeoutId);
        pollListeners.delete(onClipChange);
      });

      // ── GET /api/dl/:token  (Phone streams file from PC) ──────────────────
    } else if (req.method === 'GET' && req.url?.startsWith('/api/dl/')) {
      const token = req.url.slice('/api/dl/'.length).split('?')[0];
      const entry = pendingDownloads.get(token);
      if (!entry || Date.now() > entry.expires) {
        pendingDownloads.delete(token);
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      pendingDownloads.delete(token);
      try {
        const stat = fs.statSync(entry.filePath);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'Content-Disposition': 'attachment',
        });
        const stream = fs.createReadStream(entry.filePath);
        stream.pipe(res);
        stream.on('error', () => { if (!res.writableEnded) res.end(); });
      } catch (e) {
        res.writeHead(500);
        res.end();
      }
      return;

    } else if (!req.url?.startsWith('/socket.io')) {
      res.writeHead(404);
      res.end();
    }
  });

  io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    maxHttpBufferSize: 500 * 1024 * 1024,
    pingInterval: 10000,
    pingTimeout: 60000,
    connectTimeout: 30000,
    transports: ['polling', 'websocket'],
    allowEIO3: true,
  });

  io.on('connection', (socket: any) => {
    console.log('📱 Socket connected:', socket.id);

    // Android device announcing itself for discovery/pairing
    socket.on('announce-device', (data: { machineId: string; hostname: string; device: 'android' }) => {
      const { machineId, hostname, device } = data;
      if (!machineId || device !== 'android') return;

      const clientIp = socket.handshake.address.replace('::ffff:', '');
      console.log(`📲 Android device announced: ${hostname} @ ${clientIp} (ID: ${machineId})`);

      socket.data.machineId = machineId;
      socket.data.hostname = hostname;
      socket.data.device = 'android';

      // Add/update in discoveredPcs map
      discoveredPcs.set(clientIp, {
        hostname: hostname || 'Android Device',
        ip: clientIp,
        port: 4321,
        machineId,
        lastSeen: Date.now(),
        device: 'android'
      });
      sendDiscoveredPcs();

      // Check if already paired
      const paired = config.pairedDevices.find(d => d.machineId === machineId);
      if (paired) {
        // Auto-authenticate the paired socket
        socket.data.secretKey = paired.secretKey;
        socket.data.isAuthenticated = true;
        paired.lastKnownIp = clientIp;
        saveConfig();
        console.log(`📲 Android device auto-authenticated: ${hostname}`);
        win?.webContents.send('device-connected', socket.id);

        // Sync clipboard immediately
        const currentText = readBestClipboardText();
        if (currentText) {
          const encrypted = CryptoJS.AES.encrypt(currentText, paired.secretKey).toString();
          socket.emit('clipboard-received', encrypted);
        }
      } else if (pendingPairingTarget && pendingPairingTarget.machineId === machineId) {
        const target = pendingPairingTarget;
        pendingPairingTarget = null;

        // Generate pairing code + shared secret key
        const pairingCode = String(Math.floor(100000 + Math.random() * 900000));
        const secretKey = crypto.randomBytes(32).toString('hex');

        socket.data.pairingData = { machineId, hostname: target.hostname, pairingCode, secretKey };
        socket.data.device = 'android';
        activePairingSocket = socket;

        // Tell Android to show the pairing code
        socket.emit('initiate-pairing', {
          pairingCode,
          secretKey,
          pcHostname: os.hostname(),
          pcMachineId: config.machineId
        });

        // Show UI pairing popup
        win?.webContents.send('show-pairing-popup', {
          pairingCode,
          remoteHostname: target.hostname,
          remoteIp: clientIp,
          isInitiator: true
        });
        console.log(`[Android] Initiated pairing with ${target.hostname} after auto-connection — code: ${pairingCode}`);
      }
    });

    // Identify handler (for PC-to-PC connection)
    socket.on('identify', (data: { machineId: string; hostname: string; signature?: string }) => {
      const { machineId, hostname, signature } = data;
      if (!machineId) {
        socket.disconnect();
        return;
      }

      socket.data.machineId = machineId;
      socket.data.hostname = hostname;

      console.log(`[Handshake] Received identify from ${hostname} (ID: ${machineId})`);

      const paired = config.pairedDevices.find(d => d.machineId === machineId);
      if (paired) {
        if (signature) {
          try {
            console.log(`[Handshake] Client is paired. Decrypting signature...`);
            const bytes = CryptoJS.AES.decrypt(signature, paired.secretKey);
            const decryptedStr = bytes.toString(CryptoJS.enc.Utf8);
            if (decryptedStr) {
              const payload = JSON.parse(decryptedStr);
              const timeDiff = Math.abs(Date.now() - payload.timestamp);
              console.log(`[Handshake] Decrypted signature successfully. Payload machineId: ${payload.machineId}, timestamp diff: ${timeDiff}ms`);

              // Verify machineId matches and allow up to 24 hours of clock drift/skew
              if (payload.machineId === machineId && timeDiff < 86400000) {
                console.log(`[Handshake] Client signature verified successfully.`);

                socket.data.secretKey = paired.secretKey;
                socket.data.isAuthenticated = true;

                const clientIp = socket.handshake.address.replace('::ffff:', '');
                if (paired.lastKnownIp !== clientIp) {
                  paired.lastKnownIp = clientIp;
                  saveConfig();
                }

                socket.emit('identify-ack', { status: 'paired' });

                win?.webContents.send('client-connection-status', {
                  connected: true,
                  ip: clientIp,
                  hostname: hostname
                });

                // Sync clipboard immediately
                const currentText = readBestClipboardText();
                if (currentText) {
                  const encrypted = CryptoJS.AES.encrypt(currentText, paired.secretKey).toString();
                  socket.emit('clipboard-received', encrypted);
                }

                return;
              } else {
                console.warn(`[Handshake] Verification conditions failed`);
              }
            }
          } catch (e) {
            console.error('[Handshake] Verification exception:', e);
          }
        }

        console.warn(`[Handshake] Authentication failed. Disconnecting ${hostname}`);
        socket.emit('identify-ack', { status: 'unauthorized' });
        socket.disconnect();
      } else {
        console.log(`[Handshake] Client is not paired. Sending unpaired status.`);
        socket.emit('identify-ack', { status: 'unpaired' });
      }
    });

    // Request pairing handler
    socket.on('request-pairing', (data: { machineId: string; hostname: string; pairingCode: string; secretKey: string }) => {
      const { machineId, hostname, pairingCode, secretKey } = data;
      if (!machineId || !pairingCode || !secretKey) {
        socket.disconnect();
        return;
      }

      // Check if Windows was the initiator for this socket (Android is accepting back)
      if (activePairingSocket === socket &&
        socket.data.pairingData &&
        socket.data.pairingData.pairingCode === pairingCode) {
        console.log(`[Pairing] Android accepted Windows-initiated pairing from ${hostname}. Auto-completing.`);
        const clientIp = socket.handshake.address.replace('::ffff:', '');

        const newEntry = { machineId, hostname, secretKey, lastKnownIp: clientIp };
        const existingIndex = config.pairedDevices.findIndex(d => d.machineId === machineId);
        if (existingIndex > -1) {
          config.pairedDevices[existingIndex] = newEntry;
        } else {
          config.pairedDevices.push(newEntry);
        }
        saveConfig();

        socket.data.secretKey = secretKey;
        socket.data.isAuthenticated = true;
        win?.webContents.send('device-connected', socket.id);
        socket.emit('pairing-response', {
          status: 'accepted',
          machineId: config.machineId,
          hostname: os.hostname()
        });

        // Dismiss pairing popup
        win?.webContents.send('hide-pairing-popup');

        // Sync clipboard immediately
        const currentText = readBestClipboardText() || '';
        if (currentText) {
          const encrypted = CryptoJS.AES.encrypt(currentText, secretKey).toString();
          socket.emit('clipboard-received', encrypted);
        }

        activePairingSocket = null;
        sendDiscoveredPcs();
        sendPairingState();
        return;
      }

      // Standard flow: a remote device (PC or Android) is initiating pairing unprompted
      socket.data.pairingData = data;
      activePairingSocket = socket;

      const clientIp = socket.handshake.address.replace('::ffff:', '');
      win?.webContents.send('show-pairing-popup', {
        pairingCode,
        remoteHostname: hostname,
        remoteIp: clientIp,
        isInitiator: false
      });
    });

    // Android user cancelled pairing from their device
    socket.on('request-pairing-reject', () => {
      if (activePairingSocket === socket) {
        activePairingSocket = null;
        win?.webContents.send('hide-pairing-popup');
        console.log(`[Pairing] Android cancelled pairing`);
      }
    });

    socket.on('sync-key', (key: string, ack?: (result: { ok: boolean; keyId?: string }) => void) => {
      const incoming = typeof key === 'string' ? key : '';
      if (incoming.length > 0) {
        syncKey = incoming;
        const keyId = CryptoJS.MD5(syncKey).toString().slice(0, 8);
        console.log(`🔑 Sync key updated from phone session (id=${keyId})`);
        ack?.({ ok: true, keyId });
        const current = readBestClipboardText();
        if (current) {
          const encrypted = CryptoJS.AES.encrypt(current, syncKey).toString();
          socket.emit('clipboard-received', encrypted);
        }
      } else {
        ack?.({ ok: false });
      }
    });

    socket.on('clipboard-update', (encryptedData: string) => {
      if (!socket.data.isAuthenticated || !socket.data.secretKey) {
        console.warn(`[Security] Ignored clipboard-update from unauthenticated socket: ${socket.id}`);
        return;
      }
      try {
        const bytes = CryptoJS.AES.decrypt(encryptedData, socket.data.secretKey);
        const data = bytes.toString(CryptoJS.enc.Utf8);

        if (data && data !== lastClipboardText) {
          lastClipboardText = data;
          writeSystemClipboard(data);
          win?.webContents.send('clipboard-received', data);

          // Relay to client socket if connected
          if (clientSocket && clientConnected) {
            const clientEncrypted = CryptoJS.AES.encrypt(data, clientSocketSecretKey).toString();
            clientSocket.emit('clipboard-update', clientEncrypted);
          }
        }
      } catch (e) {
        console.error('Decrypt failed');
      }
    });

    socket.on('file-received', (fileData: FilePayload, ack?: (result: { ok: boolean; name?: string; error?: string }) => void) => {
      if (!socket.data.isAuthenticated) {
        console.warn(`[Security] Ignored file-received from unauthenticated socket: ${socket.id}`);
        ack?.({ ok: false, error: 'Unauthorized' });
        return;
      }
      try {
        const downloadsPath = path.join(os.homedir(), 'Downloads');
        if (!fs.existsSync(downloadsPath)) fs.mkdirSync(downloadsPath, { recursive: true });
        const safeName = sanitizeFileName(fileData.name || `shared_${Date.now()}`);
        const filePath = resolveUniqueFilePath(downloadsPath, safeName);

        if (fileData.url) {
          console.log(`Downloading file from URL: ${fileData.url}`);
          http.get(fileData.url, (res) => {
            if (res.statusCode === 200) {
              const fileStream = fs.createWriteStream(filePath);
              res.pipe(fileStream);
              fileStream.on('finish', () => {
                fileStream.close();
                console.log(`📂 File saved: ${filePath}`);
                win?.webContents.send('file-saved', { name: path.basename(filePath), path: filePath });
                ack?.({ ok: true, name: path.basename(filePath) });
                socket.emit('file-delivered-phone', { name: fileData.name, ok: true });
              });
            } else {
              console.error('Download failed, status code:', res.statusCode);
              ack?.({ ok: false, error: `HTTP ${res.statusCode}` });
              socket.emit('file-delivered-phone', { name: fileData.name, ok: false, error: `HTTP ${res.statusCode}` });
            }
          }).on('error', (err) => {
            console.error('Download error:', err);
            ack?.({ ok: false, error: err.message });
            socket.emit('file-delivered-phone', { name: fileData.name, ok: false, error: err.message });
          });
        } else if (fileData.data) {
          const buffer = Buffer.from(fileData.data, 'base64');
          fs.writeFileSync(filePath, buffer);
          console.log(`📂 File saved: ${filePath}`);
          win?.webContents.send('file-saved', { name: path.basename(filePath), path: filePath });
          ack?.({ ok: true, name: path.basename(filePath) });
        } else {
          ack?.({ ok: false, error: 'No file data or URL' });
        }
      } catch (e) {
        console.error('File save failed:', e);
        ack?.({ ok: false, error: e instanceof Error ? e.message : 'File save failed' });
      }
    });

    socket.on('file-delivered-phone', (info: { name?: string; ok?: boolean; error?: string }) => {
      win?.webContents.send('file-delivered-phone', info || {});
    });

    socket.on('phone-log', (line: string) => {
      process.stdout.write(`\r📱 [Phone] ${line}\n`);
    });

    socket.on('unpaired-by-peer', (data: { machineId: string }) => {
      const targetId = socket.data?.machineId || data.machineId;
      console.log(`[Unpair] Received unpaired-by-peer from remote client: targetId=${targetId}`);
      config.pairedDevices = config.pairedDevices.filter(d => d.machineId !== targetId);
      saveConfig();
      sendDiscoveredPcs();
      sendPairingState();
      socket.disconnect();
      updateOverallStatus();
    });

    socket.on('client-disconnect', (data: { machineId: string }) => {
      console.log(`[Disconnect] Received client-disconnect from remote client: ${data.machineId}`);
      ghostLastSeen = 0;
      updateOverallStatus();
    });

    socket.on('disconnect', () => {
      if (activePairingSocket === socket) {
        activePairingSocket = null;
        win?.webContents.send('hide-pairing-popup');
      }
      if (socket.data && socket.data.isAuthenticated) {
        win?.webContents.send('device-disconnected', socket.id);
        win?.webContents.send('client-connection-status', { connected: false });
      }
      sendDiscoveredPcs();
      updateOverallStatus();
    });
  });

  server.listen(4321, '0.0.0.0', () => {
    console.log(`✅ Server ready on 4321`);
  });
}

// ─── Clipboard Polling ──────────────────────────────────────────────────
function startClipboardPolling() {
  setInterval(() => {
    try {
      const broadcastClipboard = (text: string) => {
        lastClipboardText = text;
        broadcastToSocketClients(text);
        win?.webContents.send('clipboard-received', text);
        ghostBus.emit('broadcast', text);

        // Relay to client socket if connected
        if (clientSocket && clientConnected) {
          const clientEncrypted = CryptoJS.AES.encrypt(text, clientSocketSecretKey).toString();
          clientSocket.emit('clipboard-update', clientEncrypted);
        }
      };

      const text = readBestClipboardText();
      if (text && text !== lastClipboardText) {
        broadcastClipboard(text);
      }
    } catch (e) {
      console.warn('Polling glitch (ignoring):', e);
    }
  }, 1000);
}

function broadcastToSocketClients(text: string) {
  if (!io) return;
  const sockets = Array.from(io.sockets.sockets.values()) as any[];
  for (const socket of sockets) {
    const key = socket.data?.secretKey || syncKey;
    const encrypted = CryptoJS.AES.encrypt(text, key).toString();
    socket.emit('clipboard-received', encrypted);
  }
}

// ─── IPC ─────────────────────────────────────────────────────────────────
ipcMain.handle('get-local-ip', () => getLocalIp());

ipcMain.handle('read-local-clipboard', () => {
  return readBestClipboardText() || '';
});

ipcMain.on('set-sync-key', (_event: any, key: string) => {
  syncKey = key || 'CodebLink-Default-Key';
});

ipcMain.on('send-clipboard', (_event: any, text: string) => {
  if (!text) return;
  lastClipboardText = text;
  clipboard.writeText(text);
  broadcastToSocketClients(text);
  ghostBus.emit('broadcast', text);

  // Relay to client socket if connected
  if (clientSocket && clientConnected) {
    const clientEncrypted = CryptoJS.AES.encrypt(text, clientSocketSecretKey).toString();
    clientSocket.emit('clipboard-update', clientEncrypted);
  }
  console.log('📢 Manual sync: Broad-casted clipboard to phone(s) and remote PC');
});

ipcMain.on('send-file-to-phone', (_event: any, fileData: FilePayload) => {
  if (!io) return;

  const hasSocketClients = io.sockets.sockets.size > 0;

  if (fileData.path) {
    const token = crypto.randomBytes(16).toString('hex');
    pendingDownloads.set(token, { filePath: fileData.path, expires: Date.now() + 10 * 60 * 1000 });
    const localIp = getLocalIp();
    const url = `http://${localIp}:4321/api/dl/${token}`;
    io.emit('file-to-phone', { name: fileData.name, type: fileData.type, url });
    if (!hasSocketClients) {
      ghostBus.emit('broadcast', JSON.stringify({ type: 'file', name: fileData.name, mimeType: fileData.type, url }));
    }

    // Relay file to remote PC if connected
    if (clientSocket && clientConnected) {
      clientSocket.emit('file-received', { name: fileData.name, type: fileData.type, url });
    }

    win?.webContents.send('file-send-status', { ok: true, name: fileData.name });
  } else if (fileData.data) {
    io.emit('file-to-phone', { name: fileData.name, type: fileData.type, data: fileData.data });
    if (!hasSocketClients) {
      const ghostPayload = { type: 'file', name: fileData.name, data: fileData.data };
      ghostBus.emit('broadcast', JSON.stringify(ghostPayload));
    }

    // Relay file to remote PC if connected
    if (clientSocket && clientConnected) {
      clientSocket.emit('file-received', { name: fileData.name, type: fileData.type, data: fileData.data });
    }

    win?.webContents.send('file-send-status', { ok: true, name: fileData.name });
  }
});

// ─── PC-to-PC Client & Discovery Functions ────────────────────────────────
function connectToRemotePc(ip: string, targetMachineId: string) {
  try {
    disconnectFromRemotePc();

    currentPairingIp = ip;

    const ioClient = require('socket.io-client');

    console.log(`Connecting to remote PC at http://${ip}:4321 ...`);
    clientSocket = ioClient(`http://${ip}:4321`, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 2000
    });

    clientSocket.on('connect', () => {
      console.log('Connected to remote PC, validating credentials...');

      const paired = config.pairedDevices.find(d => d.machineId === targetMachineId);
      if (paired) {
        console.log(`Authenticating with signature for: ${paired.hostname}`);
        const payload = JSON.stringify({ timestamp: Date.now(), machineId: config.machineId });
        const signature = CryptoJS.AES.encrypt(payload, paired.secretKey).toString();

        clientSocket.emit('identify', {
          machineId: config.machineId,
          hostname: os.hostname(),
          signature
        });
      } else {
        console.log('Sending unpaired identify request...');
        clientSocket.emit('identify', {
          machineId: config.machineId,
          hostname: os.hostname()
        });
      }
    });

    clientSocket.on('identify-ack', (ack: { status: string }) => {
      if (ack.status === 'paired') {
        const paired = config.pairedDevices.find(d => d.machineId === targetMachineId);
        if (paired) {
          clientSocketSecretKey = paired.secretKey;
          clientSocketMachineId = paired.machineId;
          clientSocketHostname = paired.hostname;
          clientConnected = true;
          connectedHostInfo = { hostname: paired.hostname, ip };

          win?.webContents.send('client-connection-status', {
            connected: true,
            ip,
            hostname: paired.hostname
          });

          // Send current local clipboard to the host immediately
          const currentText = readBestClipboardText() || '';
          if (currentText) {
            const encrypted = CryptoJS.AES.encrypt(currentText, clientSocketSecretKey).toString();
            clientSocket.emit('clipboard-update', encrypted);
          }
        }
      } else if (ack.status === 'unpaired') {
        const wasPaired = config.pairedDevices.some(d => d.machineId === targetMachineId);
        if (wasPaired) {
          console.log(`[Unpair] Server reported unpaired status. Removing ${targetMachineId} from our config.`);
          config.pairedDevices = config.pairedDevices.filter(d => d.machineId !== targetMachineId);
          saveConfig();
          sendDiscoveredPcs();
          sendPairingState();
        }

        const pairingCode = Math.floor(100000 + Math.random() * 900000).toString();
        const secretKey = crypto.randomBytes(32).toString('hex');

        clientSocketSecretKey = secretKey;

        win?.webContents.send('show-pairing-popup', {
          pairingCode,
          remoteHostname: 'Remote PC',
          remoteIp: ip,
          isInitiator: true
        });

        clientSocket.emit('request-pairing', {
          machineId: config.machineId,
          hostname: os.hostname(),
          pairingCode,
          secretKey
        });
      } else {
        console.warn('Authentication rejected.');
        disconnectFromRemotePc();
        win?.webContents.send('client-connection-status', {
          connected: false,
          error: 'Connection rejected by host'
        });
      }
    });

    clientSocket.on('pairing-response', (res: { status: string; machineId: string; hostname: string }) => {
      if (res.status === 'accepted') {
        const newEntry = {
          machineId: res.machineId,
          hostname: res.hostname,
          secretKey: clientSocketSecretKey,
          lastKnownIp: currentPairingIp
        };
        const existingIndex = config.pairedDevices.findIndex(d => d.machineId === res.machineId);
        if (existingIndex > -1) {
          config.pairedDevices[existingIndex] = newEntry;
        } else {
          config.pairedDevices.push(newEntry);
        }
        saveConfig();

        clientSocketMachineId = res.machineId;
        clientSocketHostname = res.hostname;
        clientConnected = true;
        connectedHostInfo = { hostname: res.hostname, ip: currentPairingIp };

        win?.webContents.send('hide-pairing-popup');
        win?.webContents.send('client-connection-status', {
          connected: true,
          ip: currentPairingIp,
          hostname: res.hostname
        });
        sendDiscoveredPcs();
        sendPairingState();

        // Send current local clipboard to the host immediately
        const currentText = readBestClipboardText() || '';
        if (currentText) {
          const encrypted = CryptoJS.AES.encrypt(currentText, clientSocketSecretKey).toString();
          clientSocket.emit('clipboard-update', encrypted);
        }
      } else {
        win?.webContents.send('hide-pairing-popup');
        win?.webContents.send('client-connection-status', {
          connected: false,
          error: 'Pairing request rejected'
        });
        disconnectFromRemotePc();
      }
    });

    clientSocket.on('clipboard-received', (encryptedData: string) => {
      try {
        const bytes = CryptoJS.AES.decrypt(encryptedData, clientSocketSecretKey);
        const data = bytes.toString(CryptoJS.enc.Utf8);
        if (data && data !== lastClipboardText) {
          lastClipboardText = data;
          writeSystemClipboard(data);
          win?.webContents.send('clipboard-received', data);

          // Relay to our own server's clients (Android, etc.)
          broadcastToSocketClients(data);
          ghostBus.emit('broadcast', data);
        }
      } catch (e) {
        console.error('Failed to decrypt clipboard from remote PC:', e);
      }
    });

    clientSocket.on('file-to-phone', (fileData: any) => {
      try {
        const downloadsPath = path.join(os.homedir(), 'Downloads');
        if (!fs.existsSync(downloadsPath)) fs.mkdirSync(downloadsPath, { recursive: true });
        const safeName = sanitizeFileName(fileData.name || `shared_${Date.now()}`);
        const filePath = resolveUniqueFilePath(downloadsPath, safeName);

        if (fileData.url) {
          http.get(fileData.url, (res) => {
            if (res.statusCode === 200) {
              const fileStream = fs.createWriteStream(filePath);
              res.pipe(fileStream);
              fileStream.on('finish', () => {
                fileStream.close();
                console.log(`📂 File saved from remote PC: ${filePath}`);
                win?.webContents.send('file-saved', { name: path.basename(filePath), path: filePath });
                clientSocket.emit('file-delivered-phone', { name: fileData.name, ok: true });
              });
            } else {
              clientSocket.emit('file-delivered-phone', { name: fileData.name, ok: false, error: `HTTP ${res.statusCode}` });
            }
          }).on('error', (err) => {
            clientSocket.emit('file-delivered-phone', { name: fileData.name, ok: false, error: err.message });
          });
        } else if (fileData.data) {
          const buffer = Buffer.from(fileData.data, 'base64');
          fs.writeFileSync(filePath, buffer);
          console.log(`📂 File saved from remote PC: ${filePath}`);
          win?.webContents.send('file-saved', { name: path.basename(filePath), path: filePath });
          clientSocket.emit('file-delivered-phone', { name: fileData.name, ok: true });
        }
      } catch (e) {
        console.error('File download from remote PC failed:', e);
        clientSocket.emit('file-delivered-phone', { name: fileData.name, ok: false, error: e instanceof Error ? e.message : 'Save failed' });
      }
    });

    clientSocket.on('file-delivered-phone', (info: any) => {
      win?.webContents.send('file-delivered-phone', info);
    });

    clientSocket.on('unpaired-by-peer', (data: { machineId: string }) => {
      console.log(`[Unpair] Received unpaired-by-peer from remote host: ${data.machineId}`);
      config.pairedDevices = config.pairedDevices.filter(d => d.machineId !== data.machineId);
      saveConfig();
      sendDiscoveredPcs();
      sendPairingState();
      disconnectFromRemotePc();
    });

    clientSocket.on('disconnect', () => {
      console.log('Disconnected from remote PC.');
      disconnectFromRemotePc();
    });

    clientSocket.on('connect_error', (err: any) => {
      console.warn('Connection error to remote PC:', err);
      win?.webContents.send('client-connection-status', {
        connected: false,
        error: 'Connection failed: ' + err.message
      });
    });

  } catch (err: any) {
    console.error('Error in connectToRemotePc:', err);
    win?.webContents.send('client-connection-status', {
      connected: false,
      error: err.message
    });
  }
}

function disconnectFromRemotePc() {
  if (clientSocket) {
    clientSocket.disconnect();
    clientSocket = null;
  }
  clientConnected = false;
  connectedHostInfo = null;
  clientSocketSecretKey = '';
  clientSocketMachineId = '';
  clientSocketHostname = '';
  win?.webContents.send('client-connection-status', { connected: false });
}

function startUdpDiscovery() {
  try {
    udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    udpSocket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());

        // PC-format packet: { app: 'codeblink', ip, hostname, machineId, port }
        const isPcPacket = data.app === 'codeblink' && data.ip;
        // Android-format packet: { type: 'codeb-link-node', device: 'android', hostname, machineId, port }
        const isAndroidPacket = data.type === 'codeb-link-node' && data.device === 'android';

        if (!isPcPacket && !isAndroidPacket) return;

        // PC sends its own IP in the payload; Android doesn't — use rinfo.address
        const senderIp: string = isPcPacket ? data.ip : rinfo.address;
        const localIp = getLocalIp();
        if (senderIp === localIp) return; // Skip ourselves

        const existingEntry = discoveredPcs.get(senderIp);

        if (isAndroidPacket) {
          // Update last-seen timestamp but don't downgrade a socket-registered entry
          if (existingEntry) {
            existingEntry.lastSeen = Date.now();
            // Refresh hostname/machineId in case it changed
            if (data.hostname) existingEntry.hostname = data.hostname;
            sendDiscoveredPcs();
            return;
          }
          // First time we hear from this Android device via UDP — register it
          discoveredPcs.set(senderIp, {
            hostname: data.hostname || 'Android Device',
            ip: senderIp,
            port: data.port || 4321,
            machineId: data.machineId || '',
            lastSeen: Date.now(),
            device: 'android'
          });
          console.log(`📲 Android device discovered via UDP: ${data.hostname} @ ${senderIp}`);
          sendDiscoveredPcs();
          return;
        }

        // PC packet
        if (existingEntry && existingEntry.device === 'android') {
          existingEntry.lastSeen = Date.now();
          return;
        }

        discoveredPcs.set(senderIp, {
          hostname: data.hostname || 'Unknown PC',
          ip: senderIp,
          port: data.port || 4321,
          machineId: data.machineId || '',
          lastSeen: Date.now(),
          device: process.platform === 'win32' ? 'windows' : 'linux'
        });
        sendDiscoveredPcs();
      } catch (e) {
        // Ignore malformed packets
      }
    });

    udpSocket.on('error', (err) => {
      console.warn('UDP socket error:', err);
    });

    udpSocket.bind(UDP_PORT, () => {
      udpSocket?.setBroadcast(true);
      console.log(`📡 UDP Discovery listening on port ${UDP_PORT}`);
    });

    udpBroadcastInterval = setInterval(() => {
      try {
        const localIp = getLocalIp();
        if (localIp === '127.0.0.1') return;

        const payload = JSON.stringify({
          app: 'codeblink',
          hostname: os.hostname(),
          ip: localIp,
          port: 4321,
          machineId: config.machineId
        });

        const message = Buffer.from(payload);
        udpSocket?.send(message, 0, message.length, UDP_PORT, '255.255.255.255');
      } catch (e) {
        // Ignore broadcast errors
      }
    }, 3000);

  } catch (err) {
    console.error('Failed to start UDP discovery:', err);
  }
}

function sendDiscoveredPcs() {
  const list = Array.from(discoveredPcs.values()).map(p => {
    const isPaired = config.pairedDevices.some(d => d.machineId === p.machineId);
    let isConnected = false;
    if (p.device === 'android' && io) {
      const sockets = Array.from(io.sockets.sockets.values()) as any[];
      isConnected = sockets.some(s => s.data && s.data.machineId === p.machineId);
    }
    return {
      hostname: p.hostname,
      ip: p.ip,
      port: p.port,
      machineId: p.machineId,
      isPaired,
      isConnected,
      device: p.device || 'windows'
    };
  });
  win?.webContents.send('discovered-pcs', list);
}

function sendPairingState() {
  win?.webContents.send('pairing-state-updated', {
    machineId: config.machineId,
    pairedDevices: config.pairedDevices
  });
}

// Clean up dead nodes periodically
setInterval(() => {
  let changed = false;
  const now = Date.now();
  for (const [ip, pc] of discoveredPcs.entries()) {
    // Check if the device is currently connected via Socket.io
    let isSocketConnected = false;
    if (io) {
      const sockets = Array.from(io.sockets.sockets.values()) as any[];
      isSocketConnected = sockets.some(s => s.data && s.data.machineId === pc.machineId);
    }

    if (isSocketConnected) {
      pc.lastSeen = now; // Keep it alive
      continue;
    }

    if (now - pc.lastSeen > 10000) {
      discoveredPcs.delete(ip);
      changed = true;
    }
  }
  if (changed) {
    sendDiscoveredPcs();
  }
}, 5000);

// PC-to-PC / Android IPC handlers
ipcMain.on('connect-to-pc', (_event: any, { ip, machineId }: { ip: string; machineId: string }) => {
  if (!ip) return;

  const discoveredEntry = discoveredPcs.get(ip);
  if (discoveredEntry && discoveredEntry.device === 'android') {
    if (io) {
      const sockets = Array.from(io.sockets.sockets.values()) as any[];
      const androidSocket = sockets.find(s => s.data && s.data.machineId === machineId && s.data.device === 'android');
      if (androidSocket) {
        const paired = config.pairedDevices.find(d => d.machineId === machineId);
        if (paired) {
          console.log(`[Android] Already paired with ${discoveredEntry.hostname}. Ensuring auth.`);
          return;
        }
        // Generate pairing code + shared secret key
        const pairingCode = String(Math.floor(100000 + Math.random() * 900000));
        const secretKey = crypto.randomBytes(32).toString('hex');

        androidSocket.data.pairingData = { machineId, hostname: discoveredEntry.hostname, pairingCode, secretKey };
        androidSocket.data.device = 'android';
        activePairingSocket = androidSocket;

        // Tell Android to show the pairing code
        androidSocket.emit('initiate-pairing', {
          pairingCode,
          secretKey,
          pcHostname: os.hostname(),
          pcMachineId: config.machineId
        });

        // Show UI pairing popup
        win?.webContents.send('show-pairing-popup', {
          pairingCode,
          remoteHostname: discoveredEntry.hostname,
          remoteIp: ip,
          isInitiator: true
        });
        console.log(`[Android] Initiated pairing with ${discoveredEntry.hostname} — code: ${pairingCode}`);
        return;
      } else {
        // No socket connection exists yet — set pendingPairingTarget and send UDP unicast command to phone
        pendingPairingTarget = { ip, machineId, hostname: discoveredEntry.hostname };
        console.log(`[Android] Sending UDP connect request to ${ip} on port 43222`);
        const message = Buffer.from(JSON.stringify({
          type: 'codeb-link-action',
          action: 'connect-to-pc',
          serverIp: getLocalIp() || '127.0.0.1'
        }));
        udpSocket?.send(message, 0, message.length, UDP_PORT, ip);
        return;
      }
    }
  }

  // PC-to-PC connect as a client
  connectToRemotePc(ip, machineId || '');
});

ipcMain.on('disconnect-from-pc', () => {
  disconnectFromRemotePc();
});

ipcMain.on('disconnect-android', (_event, machineId: string) => {
  if (io) {
    const sockets = Array.from(io.sockets.sockets.values()) as any[];
    for (const socket of sockets) {
      if (socket.data && socket.data.machineId === machineId) {
        console.log(`[Disconnect] Manually disconnecting Android socket: ${machineId}`);
        socket.emit('force-disconnect');
        setTimeout(() => socket.disconnect(), 300);
      }
    }
  }
  ghostLastSeen = 0;
  updateOverallStatus();
  sendDiscoveredPcs();
});

ipcMain.on('request-discovered-pcs', () => {
  sendDiscoveredPcs();
});

ipcMain.on('get-pairing-state', () => {
  sendPairingState();
});

ipcMain.on('accept-pairing', () => {
  if (activePairingSocket && activePairingSocket.data.pairingData) {
    const { machineId, hostname, secretKey } = activePairingSocket.data.pairingData;
    const clientIp = activePairingSocket.handshake.address.replace('::ffff:', '');
    const deviceType = activePairingSocket.data.device || 'windows';

    const newEntry = { machineId, hostname, secretKey, lastKnownIp: clientIp };
    const existingIndex = config.pairedDevices.findIndex(d => d.machineId === machineId);
    if (existingIndex > -1) {
      config.pairedDevices[existingIndex] = newEntry;
    } else {
      config.pairedDevices.push(newEntry);
    }
    saveConfig();

    activePairingSocket.data.secretKey = secretKey;
    activePairingSocket.data.isAuthenticated = true;

    activePairingSocket.emit('pairing-response', {
      status: 'accepted',
      machineId: config.machineId,
      hostname: os.hostname()
    });

    win?.webContents.send('hide-pairing-popup');

    if (deviceType === 'android') {
      win?.webContents.send('device-connected', activePairingSocket.id);
    } else {
      win?.webContents.send('client-connection-status', {
        connected: true,
        ip: clientIp,
        hostname: hostname
      });
    }

    const currentText = readBestClipboardText() || '';
    if (currentText) {
      const encrypted = CryptoJS.AES.encrypt(currentText, secretKey).toString();
      activePairingSocket.emit('clipboard-received', encrypted);
    }

    activePairingSocket = null;
    sendDiscoveredPcs();
    sendPairingState();
  }
});

ipcMain.on('reject-pairing', () => {
  if (activePairingSocket) {
    activePairingSocket.emit('pairing-response', { status: 'rejected' });
    activePairingSocket.disconnect();
    activePairingSocket = null;
  }
  win?.webContents.send('hide-pairing-popup');
});

ipcMain.on('cancel-pairing', () => {
  disconnectFromRemotePc();
  win?.webContents.send('hide-pairing-popup');
});

ipcMain.on('unpair-device', (_event, machineId: string) => {
  config.pairedDevices = config.pairedDevices.filter(d => d.machineId !== machineId);
  saveConfig();

  if (clientSocket && clientSocketMachineId === machineId) {
    console.log(`[Unpair] Emitting unpaired-by-peer to remote host client connection`);
    clientSocket.emit('unpaired-by-peer', { machineId: config.machineId });
    disconnectFromRemotePc();
  }

  if (io) {
    const sockets = Array.from(io.sockets.sockets.values()) as any[];
    for (const socket of sockets) {
      if (socket.data && socket.data.machineId === machineId) {
        console.log(`[Unpair] Emitting unpaired-by-peer to remote client socket connection`);
        socket.emit('unpaired-by-peer', { machineId: config.machineId });
        setTimeout(() => socket.disconnect(), 300);
      }
    }
  }

  ghostLastSeen = 0;
  updateOverallStatus();
  sendDiscoveredPcs();
  sendPairingState();
});

function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  const ips: { address: string, isVirtual: boolean, is192: boolean, is10: boolean }[] = [];

  for (const name of Object.keys(interfaces)) {
    const isVirtual = name.toLowerCase().includes('veth') ||
      name.toLowerCase().includes('vmware') ||
      name.toLowerCase().includes('virtual') ||
      name.toLowerCase().includes('tailscale') ||
      name.toLowerCase().includes('zerotier') ||
      name.toLowerCase().includes('wsl');

    const net = interfaces[name];
    if (net) {
      for (const iface of net) {
        if (iface.family === 'IPv4' && !iface.internal) {
          ips.push({
            address: iface.address,
            isVirtual,
            is192: iface.address.startsWith('192.168.'),
            is10: iface.address.startsWith('10.')
          });
        }
      }
    }
  }

  ips.sort((a, b) => {
    if (a.isVirtual !== b.isVirtual) return a.isVirtual ? 1 : -1;
    if (a.is192 !== b.is192) return a.is192 ? -1 : 1;
    if (a.is10 !== b.is10) return a.is10 ? -1 : 1;
    return 0;
  });

  return ips.length > 0 ? ips[0].address : '127.0.0.1';
}

function tryReadCommand(command: string): string {
  try {
    const output = execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500,
      maxBuffer: 1024 * 1024,
    });
    return output.trim();
  } catch {
    return '';
  }
}

function writeSystemClipboard(text: string): void {
  clipboard.writeText(text);
  if (process.platform !== 'linux') return;
  const r = spawnSync('wl-copy', [], {
    input: text,
    encoding: 'utf8',
    timeout: 1000,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  if (r.status !== 0) {
    spawnSync('xclip', ['-selection', 'clipboard'], {
      input: text,
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  }
}

function readBestClipboardText(): string {
  if (process.platform === 'linux') {
    const wl = tryReadCommand('wl-paste -n');
    if (wl) return wl;

    const xclip = tryReadCommand('xclip -selection clipboard -o');
    if (xclip) return xclip;

    const xsel = tryReadCommand('xsel --clipboard --output');
    if (xsel) return xsel;
  }

  return clipboard.readText('clipboard').trim();
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned || `shared_${Date.now()}`;
}

function resolveUniqueFilePath(dir: string, fileName: string): string {
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  let n = 0;
  while (true) {
    const candidateName = n === 0 ? `${base}${ext}` : `${base} (${n})${ext}`;
    const candidatePath = path.join(dir, candidateName);
    if (!fs.existsSync(candidatePath)) return candidatePath;
    n += 1;
  }
}

// ─── App Lifecycle ────────────────────────────────────────────────────────
app.on('before-quit', () => {
  isQuitting = true;
  if (tray) tray.destroy();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Keep alive for tray
  }
});

app.on('activate', () => {
  if (win === null) createWindow();
});

// Allow renderer to control window states
ipcMain.on('window:minimize', () => {
  win?.minimize();
});

ipcMain.on('window:maximize', () => {
  if (win) {
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  }
});

ipcMain.on('window:close', () => {
  win?.close();
});

ipcMain.handle('window:isMaximized', () => {
  return win?.isMaximized() ?? false;
});

ipcMain.handle('app:getInfo', () => {
  return {
    version: app.getVersion(),
    lastUpdated: config.lastUpdated ?? null,
    platform: process.platform,
  };
});

// Allow renderer to trigger install-and-restart
ipcMain.on('updater:install', () => {
  isQuitting = true;
  autoUpdater.quitAndInstall(true, true);
});

// Allow renderer to manually trigger a check
ipcMain.handle('updater:check', () => {
  const isDev = !app.isPackaged || !!VITE_DEV_SERVER_URL;
  if (isDev) return { status: 'dev' };
  autoUpdater.checkForUpdates();
  return { status: 'checking' };
});
