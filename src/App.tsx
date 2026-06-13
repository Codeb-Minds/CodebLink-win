import { useEffect, useState, useCallback } from 'react';
import './index.css';
import logoPng from './icon.png';

function App() {
  const [ipAddress, setIpAddress] = useState('Loading...');
  const [isConnected, setIsConnected] = useState(false);
  const [clipboardText, setClipboardText] = useState('No text yet...');
  const [logs, setLogs] = useState<string[]>(['System initialized. Waiting for Android device...']);
  const [syncKey, setSyncKey] = useState('CodebLink-Default-Key');
  const [showKey, setShowKey] = useState(false);
  const [showTelemetry, setShowTelemetry] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Windows-to-Windows Connection State
  const [discoveredPcs, setDiscoveredPcs] = useState<{ hostname: string; ip: string; port: number; machineId: string; isPaired: boolean }[]>([]);
  const [clientConnected, setClientConnected] = useState(false);
  const [clientIp, setClientIp] = useState('');
  const [clientHostname, setClientHostname] = useState('');
  const [clientError, setClientError] = useState('');
  const [pairedDevices, setPairedDevices] = useState<{ machineId: string; hostname: string; lastKnownIp: string }[]>([]);
  const [localMachineId, setLocalMachineId] = useState('');
  
  // Auto-updater state
  const [updateState, setUpdateState] = useState<{
    status: 'checking' | 'available' | 'uptodate' | 'downloading' | 'downloaded' | 'error' | 'dev';
    version?: string;
    percent?: number;
    transferred?: number;
    total?: number;
    message?: string;
  } | null>(null);

  // App Info Modal State
  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [appInfo, setAppInfo] = useState<{
    version: string;
    lastUpdated: string | null;
    platform: string;
  } | null>(null);

  const [isMaximized, setIsMaximized] = useState(false);

  // Pairing Modal State
  const [pairingModal, setPairingModal] = useState<{
    pairingCode: string;
    remoteHostname: string;
    remoteIp: string;
    isInitiator: boolean;
  } | null>(null);

  const addLog = useCallback((message: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [`[${time}] ${message}`, ...prev].slice(0, 10));
  }, []);

  // Generate the magic connection string for the QR code
  const magicLink = `IP:${ipAddress}|KEY:${syncKey}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(magicLink)}`;

  useEffect(() => {
    // Global selection reset to prevent sync-engine stalls
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        setTimeout(() => {
          selection.removeAllRanges();
        }, 1000);
      }
    };

    document.addEventListener('selectionchange', handleSelectionChange);

    // Only run if we're in Electron
    if (window.ipcRenderer) {
      // Get IP
      window.ipcRenderer.invoke('get-local-ip').then((ip: string) => {
        setIpAddress(ip);
      });

      // Get App Info
      window.ipcRenderer.invoke('app:getInfo').then((info: any) => {
        setAppInfo(info);
      });

      // Get maximize status
      window.ipcRenderer.invoke('window:isMaximized').then((max: boolean) => {
        setIsMaximized(max);
      });

      window.ipcRenderer.on('window:maximized', (_event, max: boolean) => {
        setIsMaximized(max);
      });

      window.ipcRenderer.on('device-connected', (_event, id) => {
        setIsConnected(true);
        addLog(`Android device connected: ${id}`);
      });

      window.ipcRenderer.on('device-disconnected', (_event, id) => {
        setIsConnected(false);
        addLog(`Android device disconnected: ${id}`);
      });

      window.ipcRenderer.on('clipboard-received', (_event, text) => {
        setClipboardText(text);
        addLog('Received clipboard data');
      });

      window.ipcRenderer.on('file-saved', (_event, info) => {
        addLog(`📂 File saved to Downloads: ${info.name}`);
      });

      window.ipcRenderer.on('file-send-status', (_event, info) => {
        if (info?.ok) {
          addLog(`📤 File sent to devices: ${info.name}`);
        } else {
          addLog(`❌ File send failed: ${info?.error || 'Unknown error'}`);
        }
      });

      window.ipcRenderer.on('file-delivered-phone', (_event, info) => {
        if (info?.ok) {
          addLog(`✅ Remote device saved: ${info?.name || 'file'}`);
        } else {
          addLog(`⚠️ Remote device failed to save ${info?.name || 'file'}${info?.error ? ` (${info.error})` : ''}`);
        }
      });

      window.ipcRenderer.on('discovered-pcs', (_event, list) => {
        setDiscoveredPcs(list);
      });

      window.ipcRenderer.on('client-connection-status', (_event, data) => {
        const { connected, ip, hostname, error } = data;
        setClientConnected(connected);
        if (connected) {
          setClientIp(ip);
          setClientHostname(hostname || 'Remote PC');
          setClientError('');
          addLog(`🟢 Connected to remote PC: ${hostname || ip}`);
        } else {
          setClientIp('');
          setClientHostname('');
          if (error) {
            setClientError(error);
            addLog(`❌ Connection to remote PC failed: ${error}`);
          } else {
            addLog(`🔌 Disconnected from remote PC`);
          }
        }
      });

      window.ipcRenderer.on('sync-key-updated', (_event, newKey) => {
        setSyncKey(newKey);
        addLog(`🔑 Sync Key updated from external session: ${newKey}`);
      });

      window.ipcRenderer.on('show-pairing-popup', (_event, data) => {
        setPairingModal(data);
      });

      window.ipcRenderer.on('hide-pairing-popup', () => {
        setPairingModal(null);
      });

      window.ipcRenderer.on('pairing-state-updated', (_event, data) => {
        setLocalMachineId(data.machineId);
        setPairedDevices(data.pairedDevices);
      });

      window.ipcRenderer.on('updater:status', (_event, data) => {
        setUpdateState(data);
      });

      // Global drag/drop prevention to stop browser from "opening" the file
      const onGlobalDragOver = (e: DragEvent) => e.preventDefault();
      const onGlobalDrop = (e: DragEvent) => e.preventDefault();
      window.addEventListener('dragover', onGlobalDragOver);
      window.addEventListener('drop', onGlobalDrop);

      window.ipcRenderer.on('overall-connection-status', (_event, data) => {
        const { connected, mode } = data;

        if (connected && mode === 'ghost') {
          addLog('🛰️ Ghost Sync Active (Background Channel)');
        } else if (connected && mode === 'socket') {
          addLog('🟢 Live Socket Active (Foreground Channel)');
        } else if (!connected) {
          // Only show offline if client is also not connected
          if (!clientConnected) {
            addLog('❌ Android Device Offline');
          }
        }

        setIsConnected(connected);
      });

      // Request initial status
      window.ipcRenderer.send('request-discovered-pcs');
      window.ipcRenderer.send('get-pairing-state');

      // Cleanup
      return () => {
        document.removeEventListener('selectionchange', handleSelectionChange);
        window.ipcRenderer.removeAllListeners('overall-connection-status');
        window.ipcRenderer.removeAllListeners('device-connected');
        window.ipcRenderer.removeAllListeners('device-disconnected');
        window.ipcRenderer.removeAllListeners('clipboard-received');
        window.ipcRenderer.removeAllListeners('file-saved');
        window.ipcRenderer.removeAllListeners('file-send-status');
        window.ipcRenderer.removeAllListeners('file-delivered-phone');
        window.ipcRenderer.removeAllListeners('discovered-pcs');
        window.ipcRenderer.removeAllListeners('client-connection-status');
        window.ipcRenderer.removeAllListeners('sync-key-updated');
        window.ipcRenderer.removeAllListeners('show-pairing-popup');
        window.ipcRenderer.removeAllListeners('hide-pairing-popup');
        window.ipcRenderer.removeAllListeners('pairing-state-updated');
        window.ipcRenderer.removeAllListeners('updater:status');
        window.ipcRenderer.removeAllListeners('window:maximized');
        window.removeEventListener('dragover', onGlobalDragOver);
        window.removeEventListener('drop', onGlobalDrop);
      };
    }
  }, [addLog, clientConnected]);

  const syncLocalClipboard = async () => {
    try {
      const text = window.ipcRenderer
        ? await window.ipcRenderer.invoke('read-local-clipboard')
        : await navigator.clipboard.readText();
      if (!text || !String(text).trim()) {
        setClipboardText('');
        addLog('Clipboard is empty');
        return;
      }
      setClipboardText(text);
      if (window.ipcRenderer) {
        window.ipcRenderer.send('send-clipboard', text);
      }
      addLog('Local clipboard synced to devices');
    } catch (err) {
      addLog('Failed to read clipboard');
    }
  };

  const handleCheckUpdates = async () => {
    if (window.ipcRenderer) {
      setUpdateState({ status: 'checking' });
      const res = await window.ipcRenderer.invoke('updater:check');
      if (res?.status === 'dev') {
        setUpdateState({ status: 'dev' });
        addLog('Updates disabled in developer mode');
      }
    }
  };

  const handleSyncKeyChange = (newKey: string) => {
    setSyncKey(newKey);
    if (window.ipcRenderer) {
      window.ipcRenderer.send('set-sync-key', newKey);
    }
    addLog('Sync Key updated');
  };

  const connectToPc = (ip: string, machineId: string) => {
    if (window.ipcRenderer) {
      window.ipcRenderer.send('connect-to-pc', { ip, machineId });
      addLog(`⏳ Initiating connection to PC...`);
    }
  };

  const disconnectFromPc = () => {
    if (window.ipcRenderer) {
      window.ipcRenderer.send('disconnect-from-pc');
    }
  };

  const unpairDevice = (machineId: string) => {
    if (window.ipcRenderer) {
      window.ipcRenderer.send('unpair-device', machineId);
    }
  };

  const acceptPairing = () => {
    if (window.ipcRenderer) {
      window.ipcRenderer.send('accept-pairing');
    }
  };

  const rejectPairing = () => {
    if (window.ipcRenderer) {
      window.ipcRenderer.send('reject-pairing');
    }
  };

  const cancelPairing = () => {
    if (window.ipcRenderer) {
      window.ipcRenderer.send('cancel-pairing');
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    let file: File | null = null;
    if (e.dataTransfer.items) {
      for (let i = 0; i < e.dataTransfer.items.length; i++) {
        if (e.dataTransfer.items[i].kind === 'file') {
          file = e.dataTransfer.items[i].getAsFile();
          break;
        }
      }
    } else {
      file = e.dataTransfer.files?.[0];
    }

    if (!file) {
      addLog('⚠️ No file detected. Try dropping a local file from your disk.');
      return;
    }

    addLog(`📂 Drop detected: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

    // In Electron, File objects from drag-and-drop expose a .path property.
    // We send only the path to the main process so it can stream the file
    // directly via HTTP — avoids loading the whole file into memory as base64.
    const filePath = (file as any).path as string | undefined;
    if (!filePath) {
      addLog(`❌ Could not get file path (only local files can be sent)`);
      return;
    }

    if (window.ipcRenderer) {
      window.ipcRenderer.send('send-file-to-phone', {
        name: file.name,
        type: file.type || 'application/octet-stream',
        path: filePath,
      });
      addLog(`⏳ Transferring ${file.name} to Android...`);
    } else {
      addLog('❌ IPC Bridge not found. Are you in Electron?');
    }
  };

  const renderUpdateBadge = () => {
    if (!updateState) return null;
    const { status, version, percent, message } = updateState;

    if (status === 'available') {
      return (
        <span style={{
          fontSize: '0.7rem',
          fontWeight: 600,
          padding: '4px 10px',
          borderRadius: '9999px',
          background: '#dbeafe',
          color: '#1e3a8a',
          marginRight: '10px'
        }}>
          v{version} available
        </span>
      );
    }

    if (status === 'downloading') {
      return (
        <span style={{
          fontSize: '0.7rem',
          fontWeight: 600,
          padding: '4px 10px',
          borderRadius: '9999px',
          background: 'rgba(255,255,255,0.1)',
          color: 'var(--fg-color)',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          marginRight: '10px'
        }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 2s linear infinite' }}>
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <polyline points="19 12 12 19 5 12"></polyline>
          </svg>
          Downloading {percent}%
        </span>
      );
    }

    if (status === 'downloaded') {
      return (
        <button
          onClick={() => window.ipcRenderer.send('updater:install')}
          style={{
            fontSize: '0.7rem',
            fontWeight: 700,
            padding: '5px 12px',
            borderRadius: '9999px',
            cursor: 'pointer',
            background: '#15803d',
            color: '#fff',
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            marginRight: '10px',
            transition: 'background 0.2s'
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = '#166534'}
          onMouseLeave={(e) => e.currentTarget.style.background = '#15803d'}
          title={`v${version} ready — click to restart and install`}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10"></polyline>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
          </svg>
          Restart to update
        </button>
      );
    }

    if (status === 'error') {
      return (
        <span
          style={{
            fontSize: '0.7rem',
            fontWeight: 600,
            padding: '4px 10px',
            borderRadius: '9999px',
            background: '#fee2e2',
            color: '#b91c1c',
            marginRight: '10px'
          }}
          title={message}
        >
          Update error
        </span>
      );
    }

    return null;
  };

  return (
    <div
      className="app-container"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
    >
      {/* Custom Title Bar */}
      <div 
        className="window-titlebar"
        style={{
          height: '30px',
          background: 'var(--bg-color)',
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          WebkitAppRegion: 'drag',
          userSelect: 'none',
          zIndex: 9999
        }}
      >
        <div 
          style={{ 
            display: 'flex', 
            WebkitAppRegion: 'no-drag' 
          }}
        >
          {/* Minimize Button */}
          <button
            onClick={() => window.ipcRenderer?.send('window:minimize')}
            className="titlebar-btn"
            style={{
              width: '45px',
              height: '30px',
              background: 'none',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.2s, color 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
              e.currentTarget.style.color = 'var(--fg-color)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'none';
              e.currentTarget.style.color = 'var(--muted)';
            }}
            title="Minimize"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>

          {/* Maximize / Restore Button */}
          <button
            onClick={() => window.ipcRenderer?.send('window:maximize')}
            className="titlebar-btn"
            style={{
              width: '45px',
              height: '30px',
              background: 'none',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.2s, color 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
              e.currentTarget.style.color = 'var(--fg-color)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'none';
              e.currentTarget.style.color = 'var(--muted)';
            }}
            title={isMaximized ? 'Restore' : 'Maximize'}
          >
            {isMaximized ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="8" y="4" width="12" height="12" rx="1.5"></rect>
                <path d="M4 8v10a2 2 0 0 0 2 2h10" style={{ fill: 'none' }}></path>
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              </svg>
            )}
          </button>

          {/* Close Button */}
          <button
            onClick={() => window.ipcRenderer?.send('window:close')}
            className="titlebar-btn close-btn"
            style={{
              width: '45px',
              height: '30px',
              background: 'none',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.2s, color 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#ef4444';
              e.currentTarget.style.color = '#ffffff';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'none';
              e.currentTarget.style.color = 'var(--muted)';
            }}
            title="Close"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>

      {/* Pairing Popup Modal */}
      {pairingModal && (
        <div className="modal-overlay">
          <div className="pairing-modal-content">
            <div className="pairing-modal-glow"></div>
            <span className="pairing-device-icon">💻</span>
            <h3>
              {pairingModal.isInitiator 
                ? `Pairing with ${pairingModal.remoteHostname}` 
                : `Pairing Request`}
            </h3>
            <p className="ip-text">IP Address: {pairingModal.remoteIp}</p>
            
            <div className="pairing-code-box">
              {pairingModal.pairingCode.split('').map((char, index) => (
                <span key={index} className="pairing-digit">{char}</span>
              ))}
            </div>
            
            <p className="instruction-text">
              {pairingModal.isInitiator 
                ? "Confirm this pairing code matches on the target PC."
                : `Verify this code matches on the requesting PC to authorize connection from ${pairingModal.remoteHostname}.`}
            </p>
            
            <div className="modal-actions">
              {pairingModal.isInitiator ? (
                <button className="btn btn-danger btn-cancel-modal" onClick={cancelPairing}>
                  Cancel
                </button>
              ) : (
                <>
                  <button className="btn btn-accept" onClick={acceptPairing}>
                    Accept
                  </button>
                  <button className="btn btn-reject btn-danger" onClick={rejectPairing}>
                    Reject
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* App Info Modal */}
      {infoModalOpen && (
        <div className="modal-overlay" onClick={() => setInfoModalOpen(false)}>
          <div className="pairing-modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '400px', padding: '2.5rem 2rem' }}>
            <div className="pairing-modal-glow"></div>
            
            {/* App Icon */}
            <div style={{
              width: '64px',
              height: '64px',
              borderRadius: '16px',
              background: '#16171a',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 20px rgba(0,0,0,0.5)',
              zIndex: 2,
              marginBottom: '8px'
            }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
              </svg>
            </div>

            <h3 style={{ fontSize: '1.4rem', fontWeight: 800, margin: 0, zIndex: 2 }}>Codeb Link</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--muted)', margin: 0, zIndex: 2 }}>
              Cross-device clipboard & file sync over LAN
            </p>

            <div style={{
              width: '100%',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border)',
              borderRadius: '12px',
              padding: '16px',
              textAlign: 'left',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              fontSize: '0.8rem',
              zIndex: 2
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--muted)' }}>Version</span>
                <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{appInfo?.version || '1.1.0'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--muted)' }}>Platform</span>
                <span style={{ textTransform: 'capitalize' }}>{appInfo?.platform || 'Windows'}</span>
              </div>
              {appInfo?.lastUpdated && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--muted)' }}>Last Updated</span>
                  <span>
                    {(() => {
                      try {
                        let date = new Date(appInfo.lastUpdated);
                        if (isNaN(date.getTime())) {
                          // Try manual parsing of MM/DD/YYYY or DD/MM/YYYY
                          const match = appInfo.lastUpdated.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
                          if (match) {
                            const p1 = parseInt(match[1], 10);
                            const p2 = parseInt(match[2], 10);
                            const year = parseInt(match[3], 10);
                            if (p1 <= 12) {
                              date = new Date(year, p1 - 1, p2);
                            } else {
                              date = new Date(year, p2 - 1, p1);
                            }
                          }
                        }
                        if (isNaN(date.getTime())) {
                          return appInfo.lastUpdated;
                        }
                        const day = date.getDate();
                        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
                        const month = months[date.getMonth()];
                        const year = date.getFullYear();
                        return `${day} ${month} ${year}`;
                      } catch (e) {
                        return appInfo.lastUpdated;
                      }
                    })()}
                  </span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--muted)' }}>Organisation</span>
                <span style={{ fontWeight: 600 }}>Codeb Minds</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--muted)' }}>Website</span>
                <a 
                  href="https://link.codebminds.com" 
                  target="_blank" 
                  rel="noreferrer" 
                  style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}
                  onMouseEnter={(e) => e.currentTarget.style.textDecoration = 'underline'}
                  onMouseLeave={(e) => e.currentTarget.style.textDecoration = 'none'}
                >
                  link.codebminds.com
                </a>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'var(--muted)' }}>Updates</span>
                <span style={{ fontWeight: 600 }}>
                  {updateState?.status === 'checking' && 'Checking...'}
                  {updateState?.status === 'available' && `v${updateState.version} available!`}
                  {updateState?.status === 'downloading' && `Downloading (${updateState.percent}%)`}
                  {updateState?.status === 'downloaded' && 'Ready to install'}
                  {updateState?.status === 'uptodate' && 'Up to date'}
                  {updateState?.status === 'error' && 'Check failed'}
                  {updateState?.status === 'dev' && 'Disabled (Dev Mode)'}
                  {!updateState && 'Idle'}
                </span>
              </div>
            </div>

            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '8px', zIndex: 2, marginTop: '4px' }}>
              <button
                className="btn"
                onClick={handleCheckUpdates}
                disabled={updateState?.status === 'checking' || updateState?.status === 'downloading'}
                style={{
                  width: '100%',
                  background: 'var(--accent)',
                  color: 'var(--accent-text)',
                  border: 'none',
                  opacity: (updateState?.status === 'checking' || updateState?.status === 'downloading') ? 0.6 : 1,
                  cursor: (updateState?.status === 'checking' || updateState?.status === 'downloading') ? 'not-allowed' : 'pointer'
                }}
                onMouseEnter={(e) => {
                  if (updateState?.status !== 'checking' && updateState?.status !== 'downloading') {
                    e.currentTarget.style.background = '#e5e5e5';
                  }
                }}
                onMouseLeave={(e) => {
                  if (updateState?.status !== 'checking' && updateState?.status !== 'downloading') {
                    e.currentTarget.style.background = 'var(--accent)';
                  }
                }}
              >
                {updateState?.status === 'checking' ? 'Checking for updates...' : 'Check for updates'}
              </button>

              <button 
                className="btn" 
                onClick={() => setInfoModalOpen(false)}
                style={{
                  width: '100%',
                  background: 'rgba(255, 255, 255, 0.05)',
                  color: 'var(--fg-color)',
                  border: '1px solid var(--border)'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Drag Overlay */}
      <div
        className={`global-drag-overlay ${isDragging ? 'visible' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="overlay-content">
          <div className="glow-ring">
            <svg className="upload-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <h3>Drop to Share</h3>
          <p>Drop your file anywhere to send it to connected devices</p>
        </div>
      </div>
      <header className="header">
        <div style={{ pointerEvents: 'none', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <img src={logoPng} alt="Codeb Link Logo" style={{ width: '22px', height: '22px', borderRadius: '4px' }} />
          <h1>Codeb Link</h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {renderUpdateBadge()}
          <div className="status-indicator">
            <div className={`dot ${!(isConnected || clientConnected) ? 'offline' : ''}`}></div>
            {(isConnected || clientConnected) ? 'ENCRYPTED TUNNEL ACTIVE' : 'DISCONNECTED'}
          </div>
          <button
            onClick={() => setInfoModalOpen(true)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '4px',
              marginLeft: '12px',
              transition: 'color 0.2s'
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = 'var(--fg-color)'}
            onMouseLeave={(e) => e.currentTarget.style.color = 'var(--muted)'}
            title="App Information"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
          </button>
        </div>
      </header>

      <div className="main-layout">
        <aside className="sidebar">
          <div className="card">
            <h2>Pair Device</h2>
            <div style={{
              background: '#fff',
              padding: '10px',
              borderRadius: '12px',
              display: 'flex',
              justifyContent: 'center',
              boxShadow: '0 0 15px rgba(0,0,0,0.5)',
              overflow: 'hidden'
            }}>
              <img
                src={qrUrl}
                alt="Connect QR"
                style={{ width: '140px', height: '140px', borderRadius: '4px' }}
              />
            </div>
            <p style={{ fontSize: '0.65rem', color: 'var(--muted)', textAlign: 'center', marginTop: '8px' }}>
              SCAN TO CONNECT INSTANTLY
            </p>
          </div>


          <div className="card">
            <h2>Local Node</h2>
            <div className="ip-info" style={{ color: ipAddress === 'Loading...' ? 'var(--muted)' : 'var(--fg-color)' }}>
              {ipAddress === 'Loading...' ? 'INITIALIZING...' : `${ipAddress}:4321`}
            </div>
          </div>

          <div className="card">
            <h2>Security Key</h2>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <input
                type={showKey ? 'text' : 'password'}
                value={syncKey}
                placeholder="Enter Secret Key"
                onChange={(e) => handleSyncKeyChange(e.target.value)}
                onMouseUp={() => {
                  setTimeout(() => {
                    window.getSelection()?.removeAllRanges();
                  }, 2000);
                }}
                style={{
                  paddingRight: '45px',
                  letterSpacing: showKey ? '0' : '4px',
                  fontFamily: showKey ? "'JetBrains Mono', monospace" : 'inherit',
                  userSelect: 'text',
                  WebkitUserSelect: 'text'
                }}
              />
              <button
                onClick={() => setShowKey(!showKey)}
                style={{
                  position: 'absolute',
                  right: '12px',
                  background: 'none',
                  border: 'none',
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'all 0.2s ease',
                  padding: '4px'
                }}
                onMouseEnter={(e) => e.currentTarget.style.color = 'var(--accent)'}
                onMouseLeave={(e) => e.currentTarget.style.color = 'var(--muted)'}
              >
                {showKey ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                    <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                    <path d="M6.61 6.61A13.52 13.52 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                    <line x1="2" x2="22" y1="2" y2="22" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
            <p style={{ fontSize: '0.6rem', color: 'var(--muted)', marginTop: '4px' }}>Must match Android device</p>
          </div>

          <div className="" style={{ marginTop: 'auto' }}>
            <p style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>&copy; {new Date().getFullYear()} CODEB MINDS</p>
          </div>
        </aside>

        <main className="content-area">
          <div className="card">
            <h2>Live Clipboard</h2>
            <div className="clipboard-box">
              {clipboardText || 'Awaiting synchronization...'}
            </div>
            <button className="btn" onClick={syncLocalClipboard}>
              Push to Devices
            </button>
          </div>

          <div className="card">
            <h2>Windows Node Link (PC-to-PC)</h2>
            <div className="windows-link-container">
              {clientConnected ? (
                <div className="connected-banner">
                  <div className="banner-info">
                    <span className="banner-icon">💻</span>
                    <div>
                      <div className="banner-title">CONNECTED TO REMOTE HOST</div>
                      <div className="banner-desc">{clientHostname} ({clientIp})</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button className="btn btn-sm btn-danger" onClick={disconnectFromPc}>
                      Disconnect
                    </button>
                    {pairedDevices.find(d => d.hostname === clientHostname)?.machineId && (
                      <button className="btn btn-sm btn-danger" onClick={() => {
                        unpairDevice(pairedDevices.find(d => d.hostname === clientHostname)!.machineId);
                      }}>
                        Unpair
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="discovery-section">
                  {clientError && <div className="error-banner">{clientError}</div>}

                  <div className="discovered-list-container">
                    <h3>DISCOVERED NEARBY WINDOWS PCs</h3>
                    {discoveredPcs.length === 0 ? (
                      <div className="no-nodes">
                        <div className="pulse-dot"></div>
                        Searching for nearby Windows PCs on WiFi...
                      </div>
                    ) : (
                      <div className="pc-list">
                        {discoveredPcs.map((pc) => (
                          <div className="pc-row" key={pc.ip}>
                            <div className="pc-info">
                              <span className="pc-icon">💻</span>
                              <div>
                                <div className="pc-name" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  {pc.hostname}
                                  {pc.isPaired && <span className="paired-badge">PAIRED</span>}
                                </div>
                                <div className="pc-ip">{pc.ip}</div>
                              </div>
                            </div>
                            <div className="pc-actions" style={{ display: 'flex', gap: '8px' }}>
                              <button className="btn btn-sm" onClick={() => connectToPc(pc.ip, pc.machineId)}>
                                {pc.isPaired ? "Connect" : "Pair & Connect"}
                              </button>
                              {pc.isPaired && (
                                <button className="btn btn-sm btn-danger" onClick={() => unpairDevice(pc.machineId)}>
                                  Unpair
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>



          <div className="card" style={{ flex: 1 }}>
            <h2>Universal File Share</h2>
            <div className="file-drop-area">
              <div className="icon">+</div>
              <p style={{ fontWeight: '700', fontSize: '0.9rem' }}>DROP ANY FILE TO SYNC</p>
              <p style={{ fontSize: '0.7rem', marginTop: '8px' }}>Supports PDF, APK, ZIP, Media & More</p>
            </div>
          </div>
        </main>

        <section className={`log-panel ${!showTelemetry ? 'collapsed' : ''}`}>
          <button
            className="telemetry-toggle"
            onClick={() => setShowTelemetry(!showTelemetry)}
            title={showTelemetry ? "Collapse Telemetry" : "Expand Telemetry"}
          >
            {showTelemetry ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            )}
          </button>
          <div className="log-header">SYSTEM TELEMETRY</div>
          <div className="logs-container">
            {logs.map((log, i) => (
              <div key={i} className="log-entry">{log}</div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

export default App;
