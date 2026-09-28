import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const port = Number(process.env.PORT || 10000);
const databaseUrl = process.env.DATABASE_URL;
const deviceToken = process.env.DEVICE_TOKEN;
const dashboardToken = process.env.DASHBOARD_TOKEN;
if (!databaseUrl || !deviceToken || !dashboardToken) {
  throw new Error("DATABASE_URL, DEVICE_TOKEN and DASHBOARD_TOKEN are required");
}

const pool = new Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 10000 });
await pool.query(`CREATE TABLE IF NOT EXISTS daily_counts (
  device text NOT NULL,
  day char(8) NOT NULL,
  count integer NOT NULL CHECK (count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device, day)
)`);

function equalsSecret(actual, expected) {
  if (typeof actual !== "string" || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function reply(response, status, value) {
  const body = value === null ? "" : JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function validDate(day) {
  if (typeof day !== "string" || !/^20\d{6}$/.test(day)) return false;
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(4, 6));
  const d = Number(day.slice(6, 8));
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() + 1 === m && parsed.getUTCDate() === d;
}

function validSnapshot(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (typeof body.device !== "string" || !/^[a-zA-Z0-9:_-]{1,128}$/.test(body.device)) return false;
  if (!Array.isArray(body.days) || body.days.length > 31) return false;
  const seen = new Set();
  for (const item of body.days) {
    if (!item || typeof item !== "object" || !validDate(item.date) || seen.has(item.date)) return false;
    if (!Number.isSafeInteger(item.count) || item.count < 0 || item.count > 1_000_000) return false;
    seen.add(item.date);
  }
  return true;
}

async function readSmallJson(request) {
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 4096) throw new Error("payload_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function saveSnapshot(body) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const day of body.days) {
      await client.query(
        `INSERT INTO daily_counts (device, day, count, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (device, day) DO UPDATE SET count = EXCLUDED.count, updated_at = EXCLUDED.updated_at`,
        [body.device, day.date, day.count],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getSummary() {
  const shanghaiNow = new Date(Date.now() + 8 * 3600_000);
  const today = shanghaiNow.toISOString().slice(0, 10);
  const start = new Date(shanghaiNow.getTime() - 29 * 86400_000).toISOString().slice(0, 10);
  const [days, totals] = await Promise.all([
    pool.query("SELECT day, SUM(count)::bigint AS count FROM daily_counts WHERE day >= $1 GROUP BY day ORDER BY day", [start.replaceAll("-", "")]),
    pool.query("SELECT COALESCE(SUM(count), 0)::bigint AS all_time, MAX(updated_at) AS last_sync FROM daily_counts"),
  ]);
  const counts = new Map(days.rows.map((row) => [row.day, Number(row.count)]));
  const timeline = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(shanghaiNow.getTime() - (29 - index) * 86400_000).toISOString().slice(0, 10);
    return { date, count: counts.get(date.replaceAll("-", "")) ?? 0 };
  });
  return {
    today: counts.get(today.replaceAll("-", "")) ?? 0,
    last_7_days: timeline.slice(-7).reduce((sum, day) => sum + day.count, 0),
    last_30_days: timeline.reduce((sum, day) => sum + day.count, 0),
    all_time: Number(totals.rows[0]?.all_time ?? 0),
    last_sync: totals.rows[0]?.last_sync?.toISOString() ?? null,
    timeline,
  };
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  try {
    if (request.method === "GET" && path === "/health") {
      await pool.query("SELECT 1");
      return reply(response, 200, { status: "ok" });
    }
    if (request.method === "POST" && path === "/api/device/snapshot") {
      if (!equalsSecret(request.headers["x-mama-cloud-token"], deviceToken)) return reply(response, 401, { error: "unauthorized" });
      let body;
      try { body = await readSmallJson(request); }
      catch (error) { return reply(response, error.message === "payload_too_large" ? 413 : 400, { error: "invalid_body" }); }
      if (!validSnapshot(body)) return reply(response, 400, { error: "invalid_snapshot" });
      await saveSnapshot(body);
      return reply(response, 204, null);
    }
    if (request.method === "GET" && path === "/api/summary") {
      if (!equalsSecret(request.headers["x-mama-dashboard-token"], dashboardToken)) return reply(response, 401, { error: "unauthorized" });
      return reply(response, 200, await getSummary());
    }
    return reply(response, 404, { error: "not_found" });
  } catch (error) {
    console.error("Request failed", error);
    return reply(response, 503, { error: "storage_unavailable" });
  }
});

server.listen(port, "0.0.0.0", () => console.log(`Mama sync listening on ${port}`));

async function shutdown() {
  server.close();
  await pool.end();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

