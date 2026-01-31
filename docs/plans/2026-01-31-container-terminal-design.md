# Container Terminal Design

Run terminal inside container for Windows hosts without WSL.

## Context

- Windows host machine (no WSL)
- Company policy may restrict software installation
- Need terminal to run entirely inside container
- Access via browser only

## Requirements

- Multi-window/splits (tabs, panes)
- Session persistence (reconnect without losing state)
- Already using Zellij
- Balance: functional but not over-complex

## Solution Options

### Option A: ttyd + Zellij (Recommended)

Lightweight web terminal serving Zellij over WebSocket.

```
Container                          Windows
┌─────────────────────┐            ┌──────────┐
│ ttyd ─▶ Zellij ─▶ sh│──WebSocket─▶│ Browser  │
│ :7681               │   (text)   │          │
└─────────────────────┘            └──────────┘
```

**Dockerfile:**
```dockerfile
RUN apk add --no-cache ttyd \
    && curl -L https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz \
    | tar xz -C /usr/local/bin

EXPOSE 7681
CMD ["ttyd", "-W", "-p", "7681", "zellij", "attach", "--create", "main"]
```

**ttyd flags:**
| Flag | Purpose |
|------|---------|
| `-W` | Enable write (bidirectional) |
| `-p 7681` | Listen port |
| `-c user:pass` | Optional: basic auth |
| `-t fontSize=16` | Optional: font size |

**Zellij config** (`~/.config/zellij/config.kdl`):
```kdl
keybinds {
    locked {
        bind "Ctrl g" { SwitchToMode "Normal"; }
    }
}
default_mode "locked"
```

Start locked to avoid browser shortcut conflicts. `Ctrl+g` unlocks.

**Access:** `http://localhost:7681`

### Option B: noVNC + GUI Terminal + Zellij

Full GUI terminal rendered inside container, streamed as images.

```
Container                                    Windows
┌────────────────────────────────────┐       ┌──────────┐
│ Xvfb ─▶ kitty ─▶ Zellij ─▶ sh      │       │          │
│   │                                │       │ Browser  │
│ x11vnc ─▶ noVNC :6080 ─────────────┼─image─▶│          │
└────────────────────────────────────┘       └──────────┘
```

**Dockerfile:**
```dockerfile
RUN apk add --no-cache \
    xvfb x11vnc novnc \
    kitty font-noto \
    supervisor

RUN curl -L https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz \
    | tar xz -C /usr/local/bin

EXPOSE 6080
COPY supervisord.conf /etc/supervisord.conf
CMD ["supervisord", "-c", "/etc/supervisord.conf"]
```

**supervisord.conf:**
```ini
[supervisord]
nodaemon=true

[program:xvfb]
command=Xvfb :99 -screen 0 1920x1080x24
autorestart=true

[program:x11vnc]
command=x11vnc -display :99 -forever -shared -nopw
autorestart=true

[program:novnc]
command=/usr/share/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 6080
autorestart=true

[program:terminal]
command=kitty -e zellij attach --create main
environment=DISPLAY=":99"
autorestart=true
```

**Access:** `http://localhost:6080/vnc.html`

## Comparison

| Aspect | Option A (ttyd) | Option B (noVNC) |
|--------|-----------------|------------------|
| Image size | ~8MB | ~200MB |
| Config complexity | 1 line CMD | supervisord + multi-process |
| Startup time | Fast | Slow |
| Copy/paste | Native (text selection) | Clipboard sync required |
| Keyboard shortcuts | Browser may capture some | Fully controllable |
| Font rendering | Browser-dependent | Container-controlled |
| Latency | Low (text) | Higher (images) |

## Recommendation

Start with **Option A** (ttyd + Zellij):
- Covers 90% of daily development needs
- Simple setup, small footprint
- Native copy/paste

Consider **Option B** only if:
- Browser shortcut conflicts become unbearable
- Need to run GUI programs
- Require precise font/rendering control

---

## Extended Scope: Web IDE Options

Beyond terminal-only solutions, full IDE options for container-based development:

### VS Code Family (Browser-based, Container-hosted)

| Option | Maintainer | License | Extension Market | Notes |
|--------|------------|---------|------------------|-------|
| **openvscode-server** | Gitpod | MIT | Open VSX | Currently using |
| **code-server** | Coder | MIT | Open VSX | Most popular |
| **VS Code Server (official)** | Microsoft | Proprietary | Official ✅ | Requires MS account |
| **Theia** | Eclipse Foundation | EPL-2.0 | Partial compat | More extensible |
| **Eclipse Che** | Red Hat | EPL-2.0 | - | Kubernetes-native, heavy |

### Other Options Evaluated

| Option | Type | Verdict |
|--------|------|---------|
| **Ace** | Editor component | Not a standalone IDE |
| **Lapce** | Native desktop | No web version |
| **JetBrains Fleet/Gateway** | Desktop client | Requires Windows install |
| **Cloud9** | Web IDE | AWS-hosted only (no self-host) |
| **Lapdev** | Cloud dev env | Lapce's cloud service |

### Non-Browser Alternatives

If Windows software installation is allowed:

| Option | Windows Requirement | Experience |
|--------|---------------------|------------|
| **VS Code Remote - Containers** | VS Code + Docker | Best native experience |
| **SSH + Neovim/Helix** | None (built-in terminal) | Terminal-based, steep learning |
| **X11 Forwarding** | X Server (VcXsrv) | Native Linux GUI in Windows |

## ttyd vs GoTTY Deep Comparison

| Aspect | ttyd | GoTTY |
|--------|------|-------|
| Stars | 10,849 | 19,377 |
| Last update | 2025-07-27 ✅ | 2024-08-01 |
| Language | C + libuv | Go |
| Rendering | WebGL2 (faster) | xterm.js/hterm |
| Special features | CJK/IME, Sixel, ZMODEM/trzsz | Random URL, tmux sharing |
| Security options | More granular | Simpler |

**Conclusion**: ttyd is more actively maintained with better terminal features.

## Debate Findings

See `.debates/2026-01-31-container-terminal.md` for full discussion.

Key insights:
1. No new mainstream alternatives to ttyd emerged in 2024-2026
2. Single-user scenario simplifies requirements (no SSO/audit needed)
3. "Reliable connection + minimal maintenance" > "feature coverage"
4. Browser shortcut conflicts can be mitigated with Zellij locked mode

---

## Option C: KasmVNC (Universal GUI Solution)

Run **any Linux GUI application** inside container, access via browser.

### Architecture
```
Container                                    Windows
┌────────────────────────────────────┐       ┌──────────┐
│  Any GUI App (Lapce, Zed, VS Code) │       │          │
│         │                          │       │ Browser  │
│    KasmVNC :6901 ──────────────────┼──────▶│          │
└────────────────────────────────────┘       └──────────┘
```

One port, all GUI apps visible in browser.

### vs Traditional VNC

| Aspect | noVNC | KasmVNC |
|--------|-------|---------|
| Protocol | Traditional VNC | WebSocket + H.264/WebP |
| Performance | Moderate | Better (lower latency) |
| Bandwidth | High | Lower (better compression) |
| Clipboard | Unstable | Improved sync |
| Audio | No | Yes |

### Supported Applications

Any Linux GUI app works:
- Lapce ✅
- Zed ✅
- VS Code (native) ✅
- IntelliJ / WebStorm ✅
- Firefox / Chrome ✅
- Any X11/Wayland app ✅

### Quick Start

```bash
# Full desktop
docker run -d -p 6901:6901 -e VNC_PW=password kasmweb/desktop:1.14.0

# Single app (VS Code)
docker run -d -p 6901:6901 kasmweb/vs-code:1.14.0

# Access: https://localhost:6901
```

### Custom Dockerfile (Lapce + Zed)

```dockerfile
FROM kasmweb/desktop:1.14.0

# Install Lapce
RUN curl -L https://github.com/lapce/lapce/releases/latest/download/Lapce-linux.tar.gz \
    | tar xz -C /usr/local/bin

# Install Zed
RUN curl -L https://zed.dev/api/releases/stable/latest/zed-linux-x86_64.tar.gz \
    | tar xz -C /opt && ln -s /opt/zed*/zed /usr/local/bin/zed

EXPOSE 6901
```

### Trade-offs

| Pros | Cons |
|------|------|
| Any Linux GUI app | Large image (500MB-1GB+) |
| Single port for everything | Still remote desktop experience |
| Better than noVNC | Clipboard sync still needed |
| Audio support | Heavier than Web IDE |

### When to Use

- Need multiple different GUI apps
- Want to try Lapce/Zed without Windows install
- Need JetBrains IDE without Gateway
- Want flexibility over optimization

---

## Solution Matrix

| Need | Recommended Solution |
|------|---------------------|
| Terminal only | **ttyd + Zellij** |
| VS Code experience | **openvscode-server** or **code-server** |
| Any Linux GUI app | **KasmVNC** |
| JetBrains IDE | **KasmVNC** or **Projector** |
| Minimal footprint | **ttyd** (~8MB) |
| Maximum flexibility | **KasmVNC** (any app) |

