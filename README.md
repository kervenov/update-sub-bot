# update-subscription-bot

Telegram bot + HTTP API that swaps a blocked Marzban host IP for a fresh one
from a reserve pool when the forward-VPS daemon reports a Turkmenistan block.

## Layout

```
update-subscription-bot/
├── reservedServers.json   ← reserve IP pool, two arrays: CDN[], forward[]
├── config.json            ← Marzban admin credentials (set via /setmarzban)
├── .env                   ← bot token, panel URL, API token, port, admin chat ids
└── src/
    ├── index.js           ← entry: starts bot + api
    ├── config.js          ← loads + validates .env
    ├── configStore.js     ← config.json read/write (Marzban creds)
    ├── storage.js         ← reservedServers.json read/write (atomic, serialised)
    ├── bot.js             ← telegraf commands
    ├── api.js             ← express /alert/blocked endpoint
    └── marzban.js         ← /api/admin/token + /api/hosts client
```

## What lives where

| File | Holds | How it's set |
| --- | --- | --- |
| `.env` | bot token, panel URL, API port + token, admin chat ids | edited by hand |
| `config.json` | Marzban admin **username + password** | `/setmarzban` command |
| `reservedServers.json` | reserve IP pools (CDN + forward) | `/addcdn` / `/addforward` |

## Setup

```powershell
cd "C:\Users\Windows 11 Pro\Desktop\update-subscription-bot"
npm install
# .env is already populated with the bot token, Marzban URL, and a random API token.
# Fill in TELEGRAM_ADMIN_CHAT_IDS (comma-separated chat ids) before starting.
npm start
```

## Telegram commands

| Command | Purpose |
| --- | --- |
| `/list` | Show both reserve pools |
| `/addcdn <ip>` | Append IP to CDN reserve |
| `/addforward <ip>` | Append IP to forward reserve |
| `/removecdn <ip>` | Remove IP from CDN reserve |
| `/removeforward <ip>` | Remove IP from forward reserve |
| `/setmarzban <user> <pass>` | Save Marzban admin credentials and verify them. The original message containing the password is auto-deleted. |
| `/marzban` | Show stored Marzban username + run a live login test |

Pools are FIFO — `popNextIp` takes the oldest, so add IPs in the order you
want them used.

## HTTP API (called by forward-VPS daemon)

Auth: `Authorization: Bearer <API_TOKEN>` on every request.

### `POST /alert/blocked`

```json
{
  "type": "forward",
  "currentIp": "1.2.3.4",
  "reason": "10s no TM traffic + 4 TM probes failed"
}
```

Behaviour:
1. Pop next IP from the matching reserve pool (`type` ∈ `CDN` | `forward`).
2. Look up the Marzban host whose `address == currentIp`.
3. PUT the updated `/api/hosts` payload with the new IP swapped in.
4. Notify admin chat ids on success / failure / empty pool.

If the swap fails for any reason, the popped IP is returned to the pool.

If Marzban credentials are not set, the swap call surfaces a clear error and
the alert response includes that message — the daemon should retry later.

### `GET /health`

Returns `{ ok: true }` (also requires the bearer token).

## Daemon contract (next milestone — to be built)

The forward-VPS daemon will:
1. Watch incoming TM-block-sourced traffic on the bridge.
2. If 0 TM traffic for 10 s → ping 4 TM verification endpoints (5 s each).
3. If all 4 fail → POST `/alert/blocked` with `type=forward`.

It will be installed on the forward VPS as a **separate** service that does
not modify `/root/portfwd_final.sh` or any of its iptables / sysctl rules.

## Still needed from the user

- The 4 TM probe endpoints (host:port) the daemon should ping
- Marzban admin username + password (entered via `/setmarzban`)
- Initial reserve IPs (entered via `/addforward` / `/addcdn`)
