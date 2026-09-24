# gartic.online backend

Gartic.io companion chat backend: short-lived HMAC sessions, room-scoped Socket.IO channels, PostgreSQL persistence, anonymous users, and a minimal browser connector.

## Local setup

```bash
cp .env.example .env
npm install
npm run typecheck
npm run dev
```

Without `DATABASE_URL`, development uses an in-memory store. Railway production must provide PostgreSQL `DATABASE_URL` and a random `SESSION_SECRET` (at least 32 bytes).

Apply `sql/001_initial.sql` to the Railway PostgreSQL service before enabling production traffic.

## Security model

The userscript is intentionally not trusted and contains no database/API secret. It collects public Gartic room/player signals, sends them to `/v1/session/anonymous`, then uses a short-lived HMAC session token for the Socket.IO connection. The backend owns room authorization, message validation, rate limits, persistence, and visibility decisions.

The connector reads the passive page state first (`window.CACHE_DATA`, `__NEXT_DATA__`, URL/DOM), then listens to the Gartic WebSocket `5` join packet as an authoritative live signal. When the live signal arrives, it emits `identity:confirm`; the backend compares room, public Gartic id, and nickname against the signed session identity and disconnects on mismatch.

## Railway variables

- `DATABASE_URL`: Railway PostgreSQL connection string
- `SESSION_SECRET`: random 32+ byte secret
- `PUBLIC_ORIGIN`: comma-separated allowed web origins
- `PORT`: Railway supplies this automatically
