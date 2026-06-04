import { app, BrowserWindow, ipcMain, clipboard, Tray, Menu, screen, nativeImage } from 'electron';
import * as path from 'path';
import * as http from 'http';
import { Server } from 'socket.io';
import * as os from 'os';
import * as fs from 'fs';
import * as CryptoJS from 'crypto-js';
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

// State
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let io: Server | null = null;
let lastClipboardText = clipboard.readText() || '';
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

const iconPath = path.join(__dirname, 'icon.png');
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
    createWindow();
    createTray();
    startSocketServer();
    startClipboardPolling();
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
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
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
  if (!fs.existsSync(iconPath)) {
    console.log('Tray icon not found. Add icon.png to enable system tray.');
    return;
  }
  try {
    const image = nativeImage.createFromPath(iconPath);

    if (image.isEmpty()) {
      console.error('Failed to load tray icon: image is empty at', iconPath);
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
    console.log('📱 Connected:', socket.id);
    win?.webContents.send('device-connected', socket.id);

    // Immediately read fresh system clipboard and sync it to the newly connected device
    const freshText = clipboard.readText() || '';
    if (freshText) {
      lastClipboardText = freshText;
      const encrypted = CryptoJS.AES.encrypt(freshText, syncKey).toString();
      socket.emit('clipboard-received', encrypted);
      console.log('⚡ Initial sync sent to new connection');
    }

    socket.on('sync-key', (key: string, ack?: (result: { ok: boolean; keyId?: string }) => void) => {
      const incoming = typeof key === 'string' ? key : '';
      if (incoming.length > 0) {
        syncKey = incoming;
        const keyId = CryptoJS.MD5(syncKey).toString().slice(0, 8);
        console.log(`🔑 Sync key updated from phone session (id=${keyId})`);
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
        const bytes = CryptoJS.AES.decrypt(encryptedData, syncKey);
        const data = bytes.toString(CryptoJS.enc.Utf8);

        if (data && data !== lastClipboardText) {
          lastClipboardText = data;
          clipboard.writeText(data);
          win?.webContents.send('clipboard-received', data);
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

        const buffer = Buffer.from(fileData.data ?? '', 'base64');
        fs.writeFileSync(filePath, buffer);

        console.log(`📂 File saved: ${filePath}`);
        win?.webContents.send('file-saved', { name: path.basename(filePath), path: filePath });
        ack?.({ ok: true, name: path.basename(filePath) });
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

    socket.on('disconnect', () => {
      win?.webContents.send('device-disconnected', socket.id);
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
        const encrypted = CryptoJS.AES.encrypt(text, syncKey).toString();
        io?.emit('clipboard-received', encrypted);
        win?.webContents.send('clipboard-received', text);
        ghostBus.emit('broadcast', text);
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
  const encrypted = CryptoJS.AES.encrypt(text, syncKey).toString();
  io?.emit('clipboard-received', encrypted);
  ghostBus.emit('broadcast', text);
  console.log('📢 Manual sync: Broad-casted clipboard to phone(s)');
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
    win?.webContents.send('file-send-status', { ok: true, name: fileData.name });
  } else if (fileData.data) {
    io.emit('file-to-phone', { name: fileData.name, type: fileData.type, data: fileData.data });
    if (!hasSocketClients) {
      const ghostPayload = { type: 'file', name: fileData.name, data: fileData.data };
      ghostBus.emit('broadcast', JSON.stringify(ghostPayload));
    }
    win?.webContents.send('file-send-status', { ok: true, name: fileData.name });
  }
});

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
