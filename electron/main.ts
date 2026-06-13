import { app, BrowserWindow, ipcMain, clipboard, Tray, Menu, screen, nativeImage } from 'electron';
import * as path from 'path';
import * as http from 'http';
import { Server } from 'socket.io';
import * as os from 'os';
import * as fs from 'fs';
import * as CryptoJS from 'crypto-js';
import * as crypto from 'crypto';
import * as dgram from 'dgram';
import { autoUpdater } from 'electron-updater';

type FilePayload = {
  name: string;
  type?: string;
  data?: string;  // base64 (legacy / small files)
  path?: string;  // local file path (large files)
  url?: string;   // download URL (sent to phone)
};

import { EventEmitter } from 'events';
const ghostBus = new EventEmitter();

// State
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let io: Server | null = null;
let lastClipboardText = clipboard.readText() || '';
let isQuitting = false;
let syncKey = 'CodebLink-Default-Key';
const pollListeners = new Set<(text: string) => void>();

// Config and pairing persistence
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

function sendPairingState() {
  win?.webContents.send('pairing-state-updated', {
    machineId: config.machineId,
    pairedDevices: config.pairedDevices
  });
}

// 📦 GHOST VAULT: Holds the last message for 60s for phones "between" polls
let ghostVault: { content: string; timestamp: number } | null = null;

// 📁 PENDING DOWNLOADS: token → file path, expires after 10 minutes
const pendingDownloads = new Map<string, { filePath: string; expires: number }>();

// 🖥️ Windows-to-Windows Connection State
let clientSocket: any = null;
let clientSocketSecretKey = '';
let clientSocketMachineId = '';
let clientSocketHostname = '';
let currentPairingIp = '';
let clientConnected = false;
let connectedHostInfo: { hostname: string; ip: string } | null = null;
const discoveredPcs = new Map<string, { hostname: string; ip: string; port: number; machineId: string; lastSeen: number }>();
let udpSocket: dgram.Socket | null = null;
let udpBroadcastInterval: NodeJS.Timeout | null = null;
const UDP_PORT = 43222;
let activePairingSocket: any = null;

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

// ─── showMainWindow ───────────────────────────────────────────────────────
function showMainWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }

  if (win.isMinimized()) win.restore();
  win.show();
  win.moveTop();
  win.focus();
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
      win.maximize();
      win.show();
    }
  });

  win.on('close', (event: any) => {
    if (!isQuitting) {
      event.preventDefault();
      win?.hide();
    }
  });

  win.on('closed', () => { win = null; });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
    if (process.env.NODE_ENV !== 'production') {
      win.webContents.openDevTools();
    }
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
    const image = nativeImage.createFromPath(trayIconPath);

    if (image.isEmpty()) {
      console.error('Failed to load tray icon: image is empty at', trayIconPath);
      return;
    }

    // Windows system tray icon — 16×16 renders cleanly in the notification area
    const trayImage = image.resize({ width: 16, height: 16 });
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

    // Double-click → open window
    tray.on('double-click', () => {
      showMainWindow();
    });

    // Right-click → context menu
    tray.on('right-click', () => {
      tray!.popUpContextMenu(contextMenu);
    });

  } catch (e) {
    console.warn('Tray failed:', e);
  }
}

let ghostLastSeen = 0;
let lastReportedMode: 'socket' | 'ghost' | 'none' = 'none';

function updateOverallStatus() {
  const isSocketConnected = io ? io.sockets.sockets.size > 0 : false;
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
  }
}

// Periodically check pulse
setInterval(updateOverallStatus, 5000);

// ─── Socket.io Server ───────────────────────────────────────────────────
function startSocketServer() {
  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    // ── POST /api/clipboard  (Android → PC) ──────────────────────────────
    if (req.method === 'POST' && req.url === '/api/clipboard') {
      ghostLastSeen = Date.now();
      updateOverallStatus();
      let body = '';
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        try {
          const { data } = JSON.parse(body);
          const bytes = CryptoJS.AES.decrypt(data, syncKey);
          const text = bytes.toString(CryptoJS.enc.Utf8);
          if (text && text !== lastClipboardText) {
            lastClipboardText = text;
            clipboard.writeText(text);
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
          res.writeHead(204); // No content — tell phone to re-poll immediately
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
      // Consume the token immediately — any concurrent or subsequent request for
      // the same token gets a 404, preventing duplicate downloads.
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

      // ── Everything else: let socket.io handle ────────────────────────────
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
    win?.webContents.send('device-connected', socket.id);

    // Initial clipboard sync for Android (default key)
    // For PCs, a fresh sync is sent after successful identify or pairing acceptance.
    const freshText = clipboard.readText() || '';
    if (freshText) {
      lastClipboardText = freshText;
      const encrypted = CryptoJS.AES.encrypt(freshText, syncKey).toString();
      socket.emit('clipboard-received', encrypted);
    }

    // Identify handler (for Windows-to-Windows connection)
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
                const currentText = clipboard.readText() || '';
                if (currentText) {
                  const encrypted = CryptoJS.AES.encrypt(currentText, paired.secretKey).toString();
                  socket.emit('clipboard-received', encrypted);
                }
                
                return;
              } else {
                console.warn(`[Handshake] Verification conditions failed: machineId match = ${payload.machineId === machineId}, timeDiff within 24h = ${timeDiff < 86400000}`);
              }
            } else {
              console.warn(`[Handshake] Decrypted signature string is empty. Key might be wrong or corrupt.`);
            }
          } catch (e) {
            console.error('[Handshake] Verification exception:', e);
          }
        } else {
          console.warn(`[Handshake] Client is paired but sent no signature.`);
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

    socket.on('sync-key', (key: string, ack?: (result: { ok: boolean; keyId?: string }) => void) => {
      const incoming = typeof key === 'string' ? key : '';
      if (incoming.length > 0) {
        syncKey = incoming;
        const keyId = CryptoJS.MD5(syncKey).toString().slice(0, 8);
        console.log(`🔑 Sync key updated from phone session (id=${keyId})`);
        win?.webContents.send('sync-key-updated', syncKey);
        ack?.({ ok: true, keyId });
        // After key sync, send the latest clipboard snapshot immediately
        const current = clipboard.readText() || '';
        if (current) {
          const encrypted = CryptoJS.AES.encrypt(current, syncKey).toString();
          socket.emit('clipboard-received', encrypted);
        }
      } else {
        ack?.({ ok: false });
      }
    });

    socket.on('clipboard-update', (encryptedData: string) => {
      try {
        const decryptKey = socket.data.secretKey || syncKey;
        const bytes = CryptoJS.AES.decrypt(encryptedData, decryptKey);
        const data = bytes.toString(CryptoJS.enc.Utf8);

        if (data && data !== lastClipboardText) {
          lastClipboardText = data;
          clipboard.writeText(data);
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
      console.log(`[Unpair] Received unpaired-by-peer from remote client: ${data.machineId}`);
      config.pairedDevices = config.pairedDevices.filter(d => d.machineId !== data.machineId);
      saveConfig();
      sendDiscoveredPcs();
      sendPairingState();
    });

    socket.on('disconnect', () => {
      if (activePairingSocket === socket) {
        activePairingSocket = null;
        win?.webContents.send('hide-pairing-popup');
      }
      win?.webContents.send('device-disconnected', socket.id);
      
      if (socket.data && socket.data.isAuthenticated) {
        win?.webContents.send('client-connection-status', { connected: false });
      }
    });
  });

  server.listen(4321, '0.0.0.0', () => {
    console.log(`✅ Server ready on 4321`);
  });
}

// ─── Clipboard Polling ──────────────────────────────────────────────────
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

      const text = clipboard.readText() || '';
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
  return clipboard.readText() || '';
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

// Windows-to-Windows IPC handlers
ipcMain.on('connect-to-pc', (_event: any, { ip, machineId }: { ip: string; machineId: string }) => {
  if (!ip) return;
  connectToRemotePc(ip, machineId || '');
});

ipcMain.on('disconnect-from-pc', () => {
  disconnectFromRemotePc();
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
    win?.webContents.send('client-connection-status', {
      connected: true,
      ip: clientIp,
      hostname: hostname
    });
    
    const currentText = clipboard.readText() || '';
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
        socket.disconnect();
      }
    }
  }
  
  sendDiscoveredPcs();
  sendPairingState();
});

// ─── Windows Client & Discovery Functions ────────────────────────────────
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
          const currentText = clipboard.readText() || '';
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
        const currentText = clipboard.readText() || '';
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
          clipboard.writeText(data);
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
        if (data.app === 'codeblink' && data.ip) {
          const localIp = getLocalIp();
          if (data.ip === localIp) return; // Skip ourselves

          discoveredPcs.set(data.ip, {
            hostname: data.hostname || 'Unknown PC',
            ip: data.ip,
            port: data.port || 4321,
            machineId: data.machineId || '',
            lastSeen: Date.now()
          });
          sendDiscoveredPcs();
        }
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
    return {
      hostname: p.hostname,
      ip: p.ip,
      port: p.port,
      machineId: p.machineId,
      isPaired
    };
  });
  win?.webContents.send('discovered-pcs', list);
}

// Clean up dead nodes periodically
setInterval(() => {
  let changed = false;
  const now = Date.now();
  for (const [ip, pc] of discoveredPcs.entries()) {
    if (now - pc.lastSeen > 10000) {
      discoveredPcs.delete(ip);
      changed = true;
    }
  }
  if (changed) {
    sendDiscoveredPcs();
  }
}, 5000);

// ─── Helpers ─────────────────────────────────────────────────────────────
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

  // Sort: 192.168 non-virtual first, then 10. non-virtual, then other non-virtual, then virtual
  ips.sort((a, b) => {
    if (a.isVirtual !== b.isVirtual) return a.isVirtual ? 1 : -1;
    if (a.is192 !== b.is192) return a.is192 ? -1 : 1;
    if (a.is10 !== b.is10) return a.is10 ? -1 : 1;
    return 0;
  });

  return ips.length > 0 ? ips[0].address : '127.0.0.1';
}

function sanitizeFileName(name: string): string {
  // Remove Windows-illegal characters and path traversal attempts
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '_').slice(0, 255);
}

function resolveUniqueFilePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${counter})${ext}`);
    counter++;
  }
  return candidate;
}

// ─── Auto Updater ─────────────────────────────────────────────────────────────
const isDev = !app.isPackaged;

function setupAutoUpdater() {
  // In dev mode skip update checks entirely
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

// Allow renderer to trigger install-and-restart
ipcMain.on('updater:install', () => {
  autoUpdater.quitAndInstall(false, true);
});

// Allow renderer to manually trigger a check
ipcMain.handle('updater:check', () => {
  if (isDev) return { status: 'dev' };
  autoUpdater.checkForUpdates();
  return { status: 'checking' };
});

ipcMain.handle('app:getInfo', () => {
  return {
    version: app.getVersion(),
    lastUpdated: config.lastUpdated ?? null,
    platform: process.platform,
  };
});

