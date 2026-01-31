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
