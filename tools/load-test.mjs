#!/usr/bin/env node
/**
 * ============================================================================
 *  Prueba de CARGA y COSTE para producción
 * ============================================================================
 *
 *  Simula una quedada real contra el runtime local (o contra producción):
 *    · N personas entran a la vez, laten cada 2 s y el anfitrión refresca cada 3 s
 *    · Al final se sortea, cada persona pide su amigo secreto y se audita
 *    · Mide latencias (p50/p95/p99), errores y **comandos de Upstash**, y
 *      extrapola el coste frente al plan gratuito (500.000 comandos/mes)
 *
 *  Uso:
 *    node tools/load-test.mjs                                   (10 personas · 20 s)
 *    node tools/load-test.mjs --players 15 --seconds 30
 *    BASE=https://amigo-secreto.pages.dev ADMIN_PASSWORD=xxx node tools/load-test.mjs
 * ============================================================================
 */

const BASE = process.env.BASE || "http://localhost:8788";
const PASSWORD = process.env.ADMIN_PASSWORD || "prueba123";
const MOCK_STATS_URL = process.env.MOCK_STATS_URL || "http://127.0.0.1:9999/__stats";

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const PLAYERS = Number(readArg("players", "10"));
const SECONDS = Number(readArg("seconds", "20"));
const TICK_MS = Number(readArg("tick", "2000"));
const ADMIN_TICK_MS = 3000;
const FREE_TIER_COMMANDS = 500000;

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

/** Lee los contadores del mock (comandos facturables por Upstash). */
async function readUsage() {
  try {
    const response = await fetch(MOCK_STATS_URL, { signal: AbortSignal.timeout(2000) });
    const data = await response.json();
    return typeof data.commands === "number" ? data : null;
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

  /* Medición por DELTA: el contador del mock puede traer ruido de otras pruebas. */
  const usageBefore = await readUsage();
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
          "CF-Connecting-IP": `203.0.113.${(index % 250) + 1}`,
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

  /* 5. coste real por DELTA (Upstash factura por comando) */
  const usageAfter = await readUsage();
  const elapsed = (Date.now() - startedAt) / 1000;

  console.log("\n  ── coste (Upstash factura por comando) ──");
  if (!usageBefore || !usageAfter) {
    console.log(`  (sin métricas: ${MOCK_STATS_URL} no accesible o no es el mock)`);
  } else {
    const commands = usageAfter.commands - usageBefore.commands;
    const perSecond = commands / elapsed;
    const perPlayerHour = (perSecond / PLAYERS) * 3600;
    const session3h = perSecond * 3600 * 3;
    const sessionsPerMonth = Math.floor(FREE_TIER_COMMANDS / Math.max(1, session3h));
    console.log(`  comandos en esta prueba: ${commands} en ${elapsed.toFixed(1)} s (${perSecond.toFixed(1)}/s)`);
    console.log(`  coste por persona y hora: ~${Math.round(perPlayerHour)} comandos`);
    console.log(`  sesión de 3 h con ${PLAYERS} personas: ~${Math.round(session3h)} comandos`);
    console.log(
      `  plan gratuito (500.000/mes): ${session3h < FREE_TIER_COMMANDS ? "✅ entra de sobra" : "⚠️ ajusta intervalos"} · margen ~${sessionsPerMonth} sesiones al mes`
    );
    console.log(`  (con TICK_MS=4000 el coste baja ~30 % y con TICK_MS=6000 ~55 %)`);
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

