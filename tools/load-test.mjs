#!/usr/bin/env node
/**
 * ============================================================================
 *  Prueba de CARGA y COSTE para producción
 * ============================================================================
 *
 *  Simula una quedada real contra el runtime local (o contra producción):
 *    · N personas entran a la vez, laten cada 2 s y el anfitrión refresca cada 3 s
 *    · Al final se sortea, cada persona pide su amigo secreto y se audita
 *    · Mide latencias (p50/p95/p99), errores y **filas leídas/escritas de D1**,
 *      y las compara con el cupo diario gratuito (5M lecturas / 100k escrituras)
 *
 *  Requiere DEBUG_USAGE=1 en .dev.vars (solo local) para leer /api/admin/usage.
 *
 *  Uso:
 *    node tools/load-test.mjs                                   (10 personas · 20 s)
 *    node tools/load-test.mjs --players 15 --seconds 30
 *    BASE=https://amigosecreto.tu-subdominio.workers.dev ADMIN_PASSWORD=xxx node tools/load-test.mjs
 * ============================================================================
 */

const BASE = process.env.BASE || "http://localhost:8788";
const PASSWORD = process.env.ADMIN_PASSWORD || "prueba123";
/** Endpoint admin que informa del consumo de D1 (activo con DEBUG_USAGE=1). */
const USAGE_PATH = "/api/admin/usage";
/** Plan gratuito de D1 (por día): filas leídas y escritas. */
const FREE_ROWS_READ = 5000000;
const FREE_ROWS_WRITTEN = 100000;

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const PLAYERS = Number(readArg("players", "10"));
const SECONDS = Number(readArg("seconds", "20"));
const TICK_MS = Number(readArg("tick", "2000"));
const ADMIN_TICK_MS = 3000;
/** En local simulamos IPs con CF-Connecting-IP; en producción Cloudflare la
 *  bloquea (403 "error code: 1000") porque es una cabecera que solo pone él. */
const IS_LOCAL = /localhost|127\.0\.0\.1/.test(BASE);

const latencies = [];
const statuses = new Map();
let failures = 0;

const stats = () => {
  if (!latencies.length) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
  return { p50: at(50), p95: at(95), p99: at(99), max: sorted[sorted.length - 1] };
};

async function call(path, options = {}) {
  const started = Date.now();
  try {
    const response = await fetch(`${BASE}${path}`, {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    latencies.push(Date.now() - started);
    statuses.set(response.status, (statuses.get(response.status) || 0) + 1);
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 120) };
    }
    if (!response.ok) failures += 1;
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    latencies.push(Date.now() - started);
    failures += 1;
    statuses.set("network", (statuses.get("network") || 0) + 1);
    return { ok: false, status: 0, data: { message: String(error.message || error) } };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Lee el consumo acumulado de D1 en este isolate (filas leídas/escritas). */
async function readUsage(headers) {
  try {
    const response = await fetch(`${BASE}${USAGE_PATH}`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data.rowsRead === "number" ? data : null;
  } catch {
    return null;
  }
}

async function login() {
  const response = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!response.ok) {
    const body = await response.text();
    console.error(`✗ No se pudo entrar al panel (${response.status}): ${body.slice(0, 160)}`);
    process.exit(2);
  }
  const cookie = /as_admin=[^;]+/.exec(response.headers.get("set-cookie") || "");
  return cookie ? { Cookie: cookie[0] } : {};
}

async function main() {
  console.log(`▶ Prueba de carga: ${PLAYERS} personas · ${SECONDS} s · latido cada ${TICK_MS} ms`);
  console.log(`  destino: ${BASE}\n`);

  /* 0. credenciales del anfitrión */
  const adminHeaders = await login();

  /* 1. sala limpia (prueba también el reinicio total) */
  const reset = await call("/api/admin/reset", {
    method: "POST",
    body: { keepPlayers: false },
    headers: adminHeaders,
  });
  console.log(`  limpieza de sala: ${reset.status}`);

  /* Medición por DELTA: los contadores son acumulados del isolate. */
  const usageBefore = await readUsage(adminHeaders);
  const startedAt = Date.now();

  /* 2. altas simultáneas (prueba de carrera en el alta) */
  const names = Array.from({ length: PLAYERS }, (_, i) => `Persona ${i + 1}`);
  const cookies = new Map();
  const joinResults = await Promise.all(
    names.map(async (name, index) => {
      const ua =
        index % 2
          ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1"
          : "Mozilla/5.0 (Linux; Android 13; Pixel 7) Chrome/120 Mobile Safari/537.36";
      const response = await fetch(`${BASE}/api/join`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(IS_LOCAL ? { "CF-Connecting-IP": `203.0.113.${(index % 250) + 1}` } : {}),
          "User-Agent": ua,
        },
        body: JSON.stringify({ n: name, e: "🙂" }),
      });
      latencies.push(0);
      statuses.set(response.status, (statuses.get(response.status) || 0) + 1);
      const match = /as_player=[^;]+/.exec(response.headers.get("set-cookie") || "");
      if (match) cookies.set(name, { Cookie: match[0] });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) failures += 1;
      return body;
    })
  );
  const afterJoin = await call("/api/state");
  console.log(
    `  altas simultáneas: ${joinResults.filter((body) => body.ok).length}/${PLAYERS} · en sala: ${afterJoin.data.total}\n`
  );

  /* 3. carga sostenida: cada persona late y el anfitrión refresca el panel */
  const endsAt = Date.now() + SECONDS * 1000;
  const workers = [];
  for (const cookie of cookies.values()) {
    workers.push(
      (async () => {
        while (Date.now() < endsAt) {
          await call("/api/tick", { method: "POST", body: { v: 1, e: "🙂" }, headers: cookie });
          await sleep(TICK_MS);
        }
      })()
    );
  }
  workers.push(
    (async () => {
      while (Date.now() < endsAt) {
        await call("/api/admin/state", { headers: adminHeaders });
        await sleep(ADMIN_TICK_MS);
      }
    })()
  );
  await Promise.all(workers);

  const during = stats();
  console.log("  ── durante la carga ──");
  console.log(`  peticiones medidas: ${latencies.length} · errores: ${failures}`);
  console.log(
    `  latencia p50 ${during.p50} ms · p95 ${during.p95} ms · p99 ${during.p99} ms · máx ${during.max} ms`
  );
  console.log(
    `  códigos: ${[...statuses.entries()].map(([code, count]) => `${code}×${count}`).join(" · ")}\n`
  );

  /* 4. sorteo, reparto y auditoría (el requisito crítico) */
  const draw = await call("/api/admin/draw", {
    method: "POST",
    body: { force: true },
    headers: adminHeaders,
  });
  const matrix = await call("/api/admin/matrix", { headers: adminHeaders });
  let selfAssigned = "?";
  let delivered = 0;
  const distinctTargets = new Set();
  for (const [name, cookie] of cookies) {
    const target = await call("/api/target", { headers: cookie });
    if (target.ok) {
      delivered += 1;
      distinctTargets.add(target.data.targetName);
    }
    if (target.ok && target.data.targetName === name) selfAssigned = "¡SÍ!";
  }
  console.log("  ── sorteo ──");
  if (!draw.ok) console.log(`  ⚠ el sorteo falló (${draw.status}): ${draw.data.message}`);
  console.log(
    `  sorteo: ${draw.status} · asignaciones: ${matrix.data.total} · auto-asignaciones: ${matrix.data.selfAssigned} · válida: ${matrix.data.valid}`
  );
  console.log(`  objetivos entregados: ${delivered}/${PLAYERS} · nombres distintos: ${distinctTargets.size}`);
  if (matrix.data.selfAssigned !== 0 || !matrix.data.valid) failures += 1;
  if (delivered !== PLAYERS) failures += 1;

  /* 5. consumo real de D1 por DELTA (factura por fila leída/escrita) */
  const usageAfter = await readUsage(adminHeaders);
  const elapsed = (Date.now() - startedAt) / 1000;

  console.log("\n  ── consumo de D1 (factura por fila leída/escrita) ──");
  if (!usageBefore || !usageAfter) {
    console.log("  (sin métricas: define DEBUG_USAGE=1 en .dev.vars y reinicia el Worker)");
  } else if (usageBefore.enabled === false || usageAfter.enabled === false) {
    console.log(
      "  (métricas de filas desactivadas en este destino: DEBUG_USAGE ≠ 1 ⇒ no se inventan cifras)"
    );
  } else {
    const rowsRead = usageAfter.rowsRead - usageBefore.rowsRead;
    const rowsWritten = usageAfter.rowsWritten - usageBefore.rowsWritten;
    const queries = usageAfter.queries - usageBefore.queries;
    const readPerPlayerHour = (rowsRead / elapsed / PLAYERS) * 3600;
    const writePerPlayerHour = (rowsWritten / elapsed / PLAYERS) * 3600;
    const session3hReads = (rowsRead / elapsed) * 3600 * 3;
    const session3hWrites = (rowsWritten / elapsed) * 3600 * 3;
    const readPct = (session3hReads / FREE_ROWS_READ) * 100;
    const writePct = (session3hWrites / FREE_ROWS_WRITTEN) * 100;
    console.log(
      `  esta prueba: ${queries} consultas · ${rowsRead} filas leídas · ${rowsWritten} filas escritas en ${elapsed.toFixed(1)} s`
    );
    console.log(
      `  por persona y hora: ~${Math.round(readPerPlayerHour)} lecturas · ~${Math.round(writePerPlayerHour)} escrituras`
    );
    console.log(
      `  sesión de 3 h con ${PLAYERS} personas: ~${Math.round(session3hReads)} lecturas · ~${Math.round(session3hWrites)} escrituras`
    );
    console.log(
      `  plan gratuito D1 por día: 5.000.000 lecturas y 100.000 escrituras ⇒ usa el ${readPct.toFixed(1)} % y el ${writePct.toFixed(1)} %`
    );
  }

  console.log("");
  if (failures === 0) {
    console.log("\x1b[32m✔ Carga superada sin errores\x1b[0m");
    process.exit(0);
  }
  console.log(`\x1b[31m✗ ${failures} errores durante la prueba\x1b[0m`);
  process.exit(1);
}

main().catch((error) => {
  console.error("✗ Fallo de la prueba:", error);
  process.exit(3);
});

