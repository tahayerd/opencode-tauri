# OpenCode Desktop (Tauri Port)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/Tauri-v2-orange.svg)](https://tauri.app/)
[![Platform](https://img.shields.io/badge/Platform-Linux%20(WebKitGTK)-green.svg)]()

An ultra-lightweight, high-performance Linux desktop client for [OpenCode](https://github.com/sst/opencode), powered by **Tauri 2 (WebKitGTK)** instead of Electron.

This port preserves 100% of the upstream SolidJS renderer interface while replacing Electron's ultra heavyweight Chromium/Node runtime (~4,000 lines of TypeScript) with a native **Rust / Tauri IPC** bridge lol.

---

## ⚡ Highlights & Architecture

- **Minimal Resource Footprint:** Uses system WebKitGTK instead of bundled Chromium, reducing idle memory usage by up to ~10x.
- **Shared CLI Background Service (Sidecar):** Instead of running an isolated embedded Node server, the desktop client connects to the system's `opencode service`. Terminal sessions and the desktop client seamlessly share the same agent process.
- **Lightweight Draft Store:** Implements an atomic file-backed key/value and blob store with SHA-256 content-addressed garbage collection, eliminating SQLite dependencies.
- **Wayland & X11 Native:** Tested and optimized for modern compositors (`niri`, `hyprland`, `sway`, GNOME, KDE), including automatic stability fallbacks for WebKitGTK DMABUF rendering.
- **100% Upstream Renderer Compatibility:** Bridges the stock OpenCode desktop renderer directly via `api-shim.js` with zero upstream code fork.

---

## 📌 Prerequisite

The desktop client communicates with the official **OpenCode CLI** background service. Ensure the CLI is installed and accessible on your system before launching the app:

```bash
curl -fsSL https://opencode.ai/install | bash
```

*(Verify that `opencode` is in your `PATH` or located at `~/.opencode/bin/opencode`).*

---

## 🚀 Quick Start (Universal AppImage)

For most Linux distributions, download the pre-built **AppImage** from the [Releases](https://github.com/tahayerd/opencode-tauri/releases/latest) page and run:

```bash
# Make it executable
chmod +x OpenCode_*.AppImage

# Launch the app
./OpenCode_*.AppImage
```

---

## 🛠️ Building from Source

To compile the application locally:

### 1. Install System Build Dependencies

- **Arch Linux / Manjaro:**
  ```bash
  sudo pacman -S --needed base-devel curl wget openssl gtk3 webkit2gtk-4.1 libayatana-appindicator librsvg
  ```

- **Ubuntu / Debian / Pop!_OS:**
  ```bash
  sudo apt update
  sudo apt install -y build-essential curl wget file libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
  ```

- **Fedora / RHEL:**
  ```bash
  sudo dnf install -y gcc gcc-c++ make openssl-devel gtk3-devel webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel
  ```

### 2. Set Up Rust & Tauri CLI

```bash
# Install Rust (if not installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# Install Tauri 2 CLI
cargo install tauri-cli --version "^2.0" --locked
```

### 3. Build

From the repository root directory:

```bash
# Development mode:
cargo tauri dev

# Production build:
cargo tauri build
```

Generated outputs:
- **Standalone Binary:** `src-tauri/target/release/opencode-desktop`
- **Portable AppImage:** `src-tauri/target/release/bundle/appimage/`

*(Note: The pre-bundled `dist/` directory contains the production renderer assets and `api-shim.js`. If you wish to rebuild the renderer from upstream sources, build `packages/desktop` in the `sst/opencode@dev` repository and copy the output to `dist/`).*

---

## 🖥️ Desktop Integration (Launcher & Icon)

To add OpenCode to your desktop application menu:

```bash
# Copy binary to system path (optional)
sudo cp src-tauri/target/release/opencode-desktop /usr/local/bin/

# Install .desktop launcher
mkdir -p ~/.local/share/applications
cp src-tauri/opencode-desktop.desktop ~/.local/share/applications/

# Install application icon
mkdir -p ~/.local/share/icons/hicolor/128x128/apps
cp src-tauri/icons/128x128.png ~/.local/share/icons/hicolor/128x128/apps/ai.opencode.desktop.png

# Update desktop database
update-desktop-database ~/.local/share/applications/ 2>/dev/null || true
```

---

## 🔧 Troubleshooting

### 1. "opencode CLI not found"
- Verify that the CLI is installed and runnable (`opencode --version`).
- If located in a custom directory, launch with:
  ```bash
  OPENCODE_CLI_PATH=/custom/path/to/opencode opencode-desktop
  ```

### 2. Blank or White Window on Wayland
- WebKitGTK's DMABUF renderer can encounter issues on specific GPU drivers. The application automatically applies `WEBKIT_DISABLE_DMABUF_RENDERER=1`.
- If issues persist, try running with:
  ```bash
  WEBKIT_DISABLE_COMPOSITING_MODE=1 opencode-desktop
  ```

### 3. File Picker Does Not Open
- Ensure `xdg-desktop-portal` or `zenity` is installed in your desktop environment:
  - Arch: `sudo pacman -S xdg-desktop-portal zenity`
  - Ubuntu/Debian: `sudo apt install xdg-desktop-portal zenity`

---

## 📄 License

This port is distributed under the [MIT License](LICENSE).
For the upstream project and licenses, visit the official [OpenCode GitHub Repository](https://github.com/sst/opencode).
