# Connect a Phone Device as a Server

This guide explains both meanings that people usually intend:

1. **Phone as a client** — the recommended setup. MARI BASE runs on a computer,
   container, or VPS; an Android companion or browser connects to its URL.
2. **Phone as the actual server** — an Android device runs the Node 22 + Fastify
   backend in Termux and accepts connections from browsers/companion apps.

The MARI BASE Android APK is a **client**, not a server. Its WebView cannot host
the Fastify backend. To use a phone itself as a server you need a Linux-like
runtime such as Termux and the source checkout.

The in-product version of this guide is at
[`/guide/#phone-as-server`](../public/guide/index.html). The Studio also has a
**Workspace → Connect** page with copyable commands and a live readiness check.

---

## 1. Choose the connection mode

| Mode | Server runs on | Client URL | Best for |
| :--- | :--- | :--- | :--- |
| Phone as client | Computer / Docker / VPS | `https://api.example.com` | Normal development and production |
| Android emulator | Your computer | `http://10.0.2.2:4100` | Android emulator loopback |
| Same-device phone server | Termux on the same phone | `http://127.0.0.1:4100` | Offline demos |
| LAN phone server | Termux on an Android phone | `http://<phone-LAN-IP>:4100` | Trusted local Wi-Fi lab |
| Remote phone server | Termux + HTTPS tunnel/reverse proxy | `https://your-domain.example` | Advanced; needs TLS, power, and monitoring |

> For production, run MARI BASE on a real host with PostgreSQL 16+ and HTTPS. A
> phone with embedded PGlite is a local evaluation appliance: it is
> single-process, has a dynamic IP, and Android may suspend background work.

---

## 2. Phone as a client (recommended)

1. Start MARI BASE on your computer or server:
   ```bash
   npm ci
   cp .env.example .env
   npm run dev
   ```
   The default bind is `HOST=0.0.0.0` and `PORT=4100`.
2. On a second device, find the server's LAN address, for example
   `192.168.1.25`. From another device on the same Wi-Fi use
   `http://192.168.1.25:4100`. This cleartext HTTP exception is only for a
   trusted local network.
3. For access across the internet, put the API behind HTTPS with a valid
   certificate and use `https://api.example.com`.
4. Open `/mobile/` in a phone browser, or install the Android companion and
   enter the server origin **without** `/dashboard` or `/mobile`.
5. Tap **Test connection**. The client checks both `/ready` and `/v1/platform`
   before opening the Studio.
6. Sign in or register the first operator. In development the first account
   becomes Superadmin; in production supply `PLATFORM_BOOTSTRAP_TOKEN`.

### Android emulator note

An Android emulator's `127.0.0.1` is the emulator itself, not the host computer.
Use `http://10.0.2.2:4100` for a server running on the host. The Android
companion has an **Emulator (10.0.2.2:4100)** preset.

---

## 3. Phone as the actual server (Android + Termux)

### Prerequisites

- Android 8+ device, preferably 4 GB RAM or more, kept charged.
- Termux from F-Droid or the official Termux GitHub release; do not use the
  discontinued Play Store build.
- Node.js **22 or newer**. Node's official installation docs point Android
  users to Termux and `pkg install nodejs`; Android support is experimental
  [2](https://nodejs.org/en/download/package-manager/all).
- Git, npm dependencies, and a Wi-Fi network where peer-to-peer connections are
  allowed.
- A checkout of this repository that contains `scripts/phone-server.sh`.

### Step 1 — install the runtime

In Termux:

```bash
pkg update && pkg upgrade -y
pkg install -y git nodejs-lts tmux curl
node --version   # must print v22.x or newer
npm --version
```

If `nodejs-lts` is older than 22 on your mirror, install `nodejs`, switch
mirrors with `termux-change-repo`, or run a Linux distribution with Node 22 via
PRoot. Do not continue with an older Node: this repository declares
`engines.node >= 22`.

### Step 2 — get and install the platform

```bash
git clone <your-MARI-BASE-repository-url> maary-base
cd maary-base
npm ci
```

If you are using the upstream repository directly:

```bash
git clone https://github.com/Emmanuel001afk/MAARY-BASE.git maary-base
cd maary-base
npm ci
```

Use the branch or fork that contains the phone-server script and the new
Studio guide for your deployment.

### Step 3 — start the phone server

The helper script creates `.env` from `.env.example` if needed, forces the
server to listen on all interfaces, selects the zero-dependency PGlite database,
enables automatic migrations, prints the LAN address, and starts the API:

```bash
npm run start:phone
```

Equivalent manual start:

```bash
cp -n .env.example .env
HOST=0.0.0.0 \
PORT=4100 \
DATABASE_URL=pglite://./data/postgres \
AUTO_MIGRATE=true \
npm run dev
```

`HOST=0.0.0.0` is essential. `127.0.0.1` only accepts connections generated on
the phone itself. Keep the Termux session open; use `tmux` and
`termux-wake-lock` for longer sessions.

### Step 4 — verify the server

In a second Termux session, or from another device on the same Wi-Fi:

```bash
curl -f http://127.0.0.1:4100/ready
curl -f http://127.0.0.1:4100/v1/platform
ip -4 addr show wlan0 | grep inet
```

A ready response must contain `"status":"ready"`. Open
`http://127.0.0.1:4100/guide/` on the phone to see the same instructions in the
platform UI. Open `http://127.0.0.1:4100/` for the Management Studio.

### Step 5 — connect clients

#### Browser or companion on the same phone

- Browser: `http://127.0.0.1:4100/`
- Android companion: `http://127.0.0.1:4100` (the **Phone server (4100)** preset)
- Mobile web client: `http://127.0.0.1:4100/mobile/`

`127.0.0.1` means “this device.” It is not the address a different phone should
use.

#### Another device on the same Wi-Fi

1. Find the phone's LAN IP, e.g. `192.168.1.42`, using
   `ip -4 addr show wlan0`.
2. Use `http://192.168.1.42:4100` as the server URL.
3. In the native Android companion, tick **Allow cleartext HTTP for local / LAN
   development**. Use this only on a trusted network. The browser client allows
   private LAN addresses over HTTP for development.
4. Verify `http://192.168.1.42:4100/ready` from the other device before opening
   the Studio.

Some routers enable **AP/client isolation**, especially guest networks. In that
case LAN clients cannot reach each other even though both have internet. Use a
normal trusted Wi-Fi, a phone hotspot, or an HTTPS tunnel.

#### Remote access over the internet

Do not expose `http://<phone-ip>:4100` with a raw router port-forward. Put a
trusted HTTPS reverse proxy or tunnel in front of it:

```text
Internet client
    ↓ HTTPS (valid certificate)
Tunnel / reverse proxy
    ↓ HTTP to 127.0.0.1:4100 on the phone
Termux → Fastify / MARI BASE
```

Set a restrictive `CORS_ORIGIN`, replace every development secret in `.env`,
and set `TRUST_PROXY=true` only when the proxy is trusted. For production, use
a managed host and external PostgreSQL rather than a phone.

### Step 6 — keep the process alive

- Android Settings → Apps → Termux → Battery → **Unrestricted**.
- Keep the Termux notification and keep the device charging.
- Run `termux-wake-lock`; release with `termux-wake-unlock` when done.
- Use `tmux new -s maary` and start `npm run start:phone` inside it.
- For auto-start after reboot, use Termux:Boot. Android may still stop child
  processes on Android 12+; wake locks and battery exemptions reduce but do not
  eliminate this risk.

---

## 4. Security and data rules

- Replace `JWT_SECRET`, `ENCRYPTION_KEY`, `PLATFORM_BOOTSTRAP_TOKEN`, and the
  development database password before allowing other users.
- Use HTTPS for any non-loopback or internet connection. Cleartext HTTP is only
  for localhost, emulator, or a trusted LAN.
- `service_role` keys bypass RLS. Never place one in a browser or mobile app.
- PGlite is for evaluation/tests and single-process use. Use PostgreSQL 16+ with
  `DATABASE_URL=postgres://...` for concurrent production workloads.
- Back up `data/`, `storage/`, and `.env`; a lost or wiped phone loses embedded
  PGlite data and local object bytes.
- A phone's LAN IP can change after reboot or Wi-Fi roaming. Prefer DNS or an
  HTTPS tunnel rather than hard-coding the IP.

---

## 5. Troubleshooting

| Symptom | Check / fix |
| :--- | :--- |
| `node --version` is below 22 | Install `nodejs` / current `nodejs-lts`, change repo mirror, or use PRoot with Node 22. |
| `npm ci` fails | Update Termux packages, free storage, check network, and retry. Native modules need Android-compatible builds. |
| `EADDRINUSE` | Another service owns port 4100. Stop it or start with `PORT=4200 npm run start:phone`. |
| `/ready` returns 503 | Inspect the server log; verify `data/` and `storage/` are writable and rerun `npm run db:migrate`. |
| Works on the phone but not another device | Confirm `HOST=0.0.0.0`, same Wi-Fi/subnet, correct phone IP, no VPN, no guest-network isolation. |
| Companion says HTTPS required | Use an HTTPS URL for remote access, or tick the cleartext checkbox only for a trusted LAN URL. |
| Browser reports CORS errors | Set `CORS_ORIGIN` to the exact browser origins, or `*` only in an isolated development environment. |
| TLS error in the Android app | Install a valid, trusted certificate. Self-signed certificates are rejected by design. |
| Server stops when the screen turns off | Disable battery optimization, acquire a wake lock, keep Termux in the foreground, and keep the phone charged. |
| Requests are slow | PGlite is single-process and phones have limited I/O. Use external PostgreSQL and a real server. |
| “Platform not verified” in companion | The app requires `/ready` **and** `/v1/platform`; check both endpoints and their response status. |

---

## 6. Related files

- [`scripts/phone-server.sh`](../scripts/phone-server.sh) — Termux-friendly launcher.
- [`public/guide/index.html`](../public/guide/index.html) — public visual platform/phone guide.
- [`public/dashboard/js/pages.js`](../public/dashboard/js/pages.js) — Studio **Connect** and **Structure map** pages.
- [`public/mobile/index.html`](../public/mobile/index.html) — mobile web connection screen.
- [`android/app/src/main/java/com/marrybase/platform/MainActivity.java`](../android/app/src/main/java/com/marrybase/platform/MainActivity.java) — native companion verification screen.
