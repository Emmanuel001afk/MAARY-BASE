# EMA browser agent

This is the real browser. It runs Chromium through Playwright on your own
machine (or your VPS) and streams live frames to the EMA web app.

## Run it

```bash
cd agent
npm install
EMA_AGENT_TOKEN=pick-a-long-random-string npm start
```

It listens on `ws://localhost:7788`.

In EMA → Settings, set:

- **Agent URL**: `ws://localhost:7788`
- **Agent token**: the same string you used above

## Options

| Env var             | Default          | Meaning                                  |
| ------------------- | ---------------- | ---------------------------------------- |
| `EMA_AGENT_PORT`    | `7788`           | Port to listen on                        |
| `EMA_AGENT_TOKEN`   | _(empty)_        | Shared token; required if set            |
| `EMA_AGENT_FPS`     | `3`              | Live screenshot frames per second        |
| `EMA_AGENT_PROFILE` | `./.ema-profile` | Persistent Chromium profile (keeps logins) |

The profile directory keeps cookies and sessions, so sites you log into stay
logged in between runs.

## Running on a VPS

Expose the port behind TLS (e.g. Caddy/nginx with a `wss://` reverse proxy) and
set the Agent URL to `wss://your-host/agent`. Always keep a token set.
