# Mama Counter sync API

Small HTTPS-facing receiver for ESP32 daily count snapshots. Render terminates TLS; this process listens on `0.0.0.0:$PORT`.

Required environment: `DATABASE_URL`, `DEVICE_TOKEN`, `DASHBOARD_TOKEN`.

- `POST /api/device/snapshot` — `X-Mama-Cloud-Token`, body `{ "device": "uuid", "days": [{ "date": "YYYYMMDD", "count": 1 }] }`. The daily value is absolute; retries are idempotent.
- `GET /api/summary` — `X-Mama-Dashboard-Token`, returns a 30-day timeline and totals.
- `GET /health` — health check.

The table is created idempotently on startup. The free Render PostgreSQL tier expires after 30 days; this deployment is for a time-limited trial, not durable production storage.

