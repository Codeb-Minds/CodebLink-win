# Codeb Link: Windows Desktop Client

Official Website and Downloads: [link.codebminds.com](https://link.codebminds.com)

Codeb Link is a lightweight, high-performance, and secure cross-device clipboard and file synchronization client for Windows. Built using Electron, React, and TypeScript, it enables seamless real-time communication between multiple PCs and Android devices over your Local Area Network (LAN), all without relying on external cloud servers.

---

## Key Features

* **Real-time Clipboard Sync:** Instantly syncs copied text across paired devices.
* **Local File Streaming:** Streams files directly between devices over HTTP using high-speed LAN connections.
* **P2P Discovery:** Automatically discovers other Windows PCs on the same network using UDP broadcasts.
* **Cryptographic Pairing and Security:** Encrypts clipboard payloads locally using AES-256 to prevent network sniffing, utilizing secure pairing signatures verified against client timestamps.
* **Ghost Vault (Background Sync):** Supports background polling for mobile devices, enabling clipboards to sync even when the mobile OS pauses active socket connections.
* **System Tray Integration:** Runs silently in the background, minimizes to tray, and displays connection status.
* **Auto-Updates:** Integrated with electron-updater for seamless generic release delivery.

---

## Architecture and Tech Stack

* **Main Process (Electron + Node.js):**
  * **Socket.io Server:** Establishes bidirectional connections on port 4321.
  * **HTTP Server:** Handles file streaming (/api/dl/:token) and fallback long-polling.
  * **UDP Client/Server:** Broadcasts and listens for peers on port 43222.
  * **Crypto:** Local AES encryption/decryption using crypto-js.
* **Renderer Process (React + Vite + TypeScript):**
  * Modern UI for pairing devices, viewing discovery logs, adjusting settings, and status monitoring.

---

## Networking Protocols and API Endpoints

The Windows client hosts a local server on port 4321 and listens for UDP packets on port 43222.

### 1. HTTP API (Port 4321)

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/clipboard` | `POST` | Accepts clipboard updates from Android devices (encrypted). |
| `/api/clipboard/poll` | `GET` | Long-polling endpoint for background Android devices. Holds connection up to 25s. |
| `/api/ghost/receipt` | `POST` | Received file transfer acknowledgment from background clients. |
| `/api/dl/:token` | `GET` | Secure single-use token endpoint to stream files from the local Downloads folder. |

### 2. Socket.io Protocol (Port 4321)
Used for real-time bidirectional messaging between authenticated clients (PC-to-PC and Active Android).
* **`identify`**: Initiates handshake, providing `machineId` and a cryptographically signed timestamp payload.
* **`request-pairing`**: Sends a pairing request using a 6-digit numeric pairing code.
* **`clipboard-update`**: Broadcasts encrypted clipboard updates to authenticated clients.
* **`file-received`**: Informs the remote peer about a incoming file stream or base64 payload.

### 3. UDP Peer Discovery (Port 43222)
Periodically broadcasts host presence:
* Broadcast Interval: 10000ms (10 seconds)
* Packet payload format: `codeblink:discover:<machineId>:<hostname>:<serverPort>`

---

## Pairing and Handshake Protocol

To prevent unauthorized devices from intercepting or pushing clipboard contents:
1. **Initiation:** The client generates a unique `secretKey` and a short-lived `pairingCode`.
2. **Acceptance:** Upon matching the pairing code in the UI, the remote host saves the `secretKey`.
3. **Verification:** Subsequent handshakes require the client to emit an `identify` event containing a `signature` (a timestamp encrypted using the shared `secretKey`). The host decrypts and validates that the timestamp falls within a 24-hour drift window before allowing socket communication.

---

## Getting Started

### Prerequisites
* **Node.js** (v18 or higher recommended)
* **npm** (v9 or higher)

### Setup and Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run in Development Mode:
   ```bash
   npm run dev
   ```
   *This launches the Vite Dev Server and concurrently starts the Electron main process.*

3. Format and Linting:
   ```bash
   npm run lint
   ```

---

## Building and Packaging

To generate a production-ready installer executable (.exe):

```bash
npm run dist
```
* The packager compiles both the Electron main process and Vite renderer assets, generating a single-click installer inside the /release directory using electron-builder.

---

## Configuration
The app persists its state and pairing information locally:
* **Path:** `%APPDATA%/codeb-link-win/config.json`
* **Format:**
  ```json
  {
    "machineId": "unique-uuid-here",
    "pairedDevices": [
      {
        "machineId": "peer-uuid",
        "hostname": "PEER-HOSTNAME",
        "secretKey": "aes-shared-secret-key",
        "lastKnownIp": "192.168.1.50"
      }
    ]
  }
  ```

---

## License
This project is licensed under the MIT License with branding restrictions. You are free to use, modify, share, and contribute, but you may not republish the application under the Codeb Link or Codeb Minds name. See the LICENSE file for details.
