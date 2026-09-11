/**
 * ============================================================================
 *  Amigo Secreto — BACKEND MONOLÍTICO (Cloudflare Workers)
 * ============================================================================
 *
 *  Un único archivo con TODO el servidor:
 *    · Router de /api/*
 *    · Dominio de la sala ÚNICA (estado, jugadores, sorteo, rondas)
 *    · Capa de datos sobre Cloudflare **D1** (SQLite): 1 `batch` = 1 ida y vuelta
 *      y **atómico** (el sorteo no puede quedar a medias)
 *    · Sesiones de jugador (cookie 1 año + localStorage/header de respaldo)
 *    · Panel de administración (login con HMAC, IP, UA, emoji, activo/inactivo)
 *
 *  Decisiones de ingeniería (por qué así):
 *   1. Sin dependencias npm en runtime (solo D1 + Web Crypto) ⇒ bundle mínimo,
 *      cold start mínimo y nada que pueda romper al empaquetar.
 *   2. Sin `nodejs_compat` (D1 es API nativa) ⇒ menos coste.
 *   3. El id del jugador es un token bearer (UUID v4, 122 bits) y NUNCA se
 *      expone públicamente: hacia fuera se usa un seudónimo `pid` derivado
 *      con FNV-1a y un secreto (estable, no reversible).
 *   4. La matriz `jugador -> objetivo` vive SOLO aquí; el jugador consulta
 *      únicamente su propia fila.
 *   5. Sorteo por derangement (Fisher–Yates + shift circular) ⇒ NADIE se
 *      asigna a sí mismo, siempre, para cualquier n >= 2.
 *
 *  Configuración:
 *    DB              · binding de D1 (wrangler.jsonc → d1_databases.binding = "DB")
 *    ADMIN_PASSWORD  · secret: contraseña del panel /admin
 *    ADMIN_SECRET    · secret: firma las cookies (HMAC) y los pseudónimos
 *    ROOM_ID         · (opcional) id de la sala, por defecto "main"
 *    ROOM_TTL_HOURS  · (opcional) horas para purgar a quien no vuelve, por defecto 12
 *    TICK_MS / ADMIN_TICK_MS / HEARTBEAT_MS · (opcionales) ajustes de frecuencia
 *    DEBUG_USAGE     · (opcional, solo pruebas) expone /api/admin/usage
 * ============================================================================
 */

interface Env {
  /** Base de datos D1 (wrangler.jsonc → d1_databases.binding = "DB"). */
  DB: D1Database;
  ADMIN_PASSWORD?: string;
  ADMIN_SECRET?: string;
  ROOM_ID?: string;
  /** Horas de inactividad antes de purgar a quien no volvió (por defecto 12). */
  ROOM_TTL_HOURS?: string;
  /** Solo para pruebas locales: expone /api/admin/usage (filas leídas/escritas). */
  DEBUG_USAGE?: string;
  /** Ajustes finos de coste (ms). Opcionales: tienen valores por defecto. */
  TICK_MS?: string;
  ADMIN_TICK_MS?: string;
  HEARTBEAT_MS?: string;
  /**
   * Binding de los assets estáticos (wrangler.jsonc → assets.binding).
   * Solo se usa como respaldo si el Worker recibe una ruta que no es /api/*.
   */
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
}

interface ApiContext {
  request: Request;
  env: Env;
  params: { path?: string | string[] };
  waitUntil: (promise: Promise<unknown>) => void;
  next: () => Promise<Response>;
}

/* ============================== CONSTANTES ============================== */

const DEFAULT_ROOM_ID = "main";

/** Limpieza: 12 h por defecto (más que cualquier fiesta, menos que "el mes
 *  que viene"). Antes eran 30 días: los que entraban y se iban se quedaban
 *  en la lista como "desconectados" y parecían fantasmas/bots. */
const DEFAULT_TTL_HOURS = 12;

/** Personas mínimas para poder sortear (con 2 ya es un derangement válido). */
const MIN_PLAYERS = 2;
/** Tope defensivo: evita que alguien llene el hash de jugadores. */
const MAX_PLAYERS = 60;

const SESSION_MAX_AGE = 60 * 60 * 24 * 365; // sesión de jugador: 1 año
const ADMIN_MAX_AGE = 60 * 60 * 24 * 30; // sesión de admin: 30 días

/** Presencia: se calcula al leer, sin cron (el latido se escribe cada 10 s). */
const STALE_MS = 60_000; // visto hace >= 60 s ⇒ DESCONECTADO (inactivo = sin foco)
/** El servidor solo escribe el latido cada 10 s aunque el cliente pulse cada 2 s.
 *  D1 factura por fila escrita: el doble de intervalo ⇒ la mitad de escrituras.
 *  Como la ventana de presencia es de 60 s (STALE_MS), nadie pasa a "inactivo"
 *  mientras esté en pantalla. */
const WRITE_EVERY_MS = 10_000;

const PUBLIC_TICK_MS = 2000;
const ADMIN_TICK_MS = 3000;

const MIN_PLAYERS_MESSAGE = `Se necesitan al menos ${MIN_PLAYERS} personas para sortear.`;

/** Rueda de emojis (misma lista para jugador y admin: única fuente de verdad). */
const EMOJIS = [
  "🙂", "😎", "🤠", "🥳", "🤓", "😺", "🐶", "🐼",
  "🦊", "🐸", "🐙", "🦄", "🐝", "🌵", "🌟", "🍕",
  "🍩", "⚽", "🎸", "🚀", "👻", "💀", "🤖", "🎩",
];

/* ============================== ERRORES ============================== */

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

class UpstreamError extends Error {
  constructor(message = "No se pudo conectar con el almacén de datos.") {
    super(message);
    this.name = "UpstreamError";
  }
}

/* ============================== HELPERS HTTP ============================== */

const BASE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...BASE_HEADERS, ...headers },
  });
}

function fail(status: number, message: string, headers: Record<string, string> = {}): Response {
  return json({ ok: false, message }, status, headers);
}

/** IP real del visitante. `CF-Connecting-IP` lo fija Cloudflare (no falsificable). */
function clientIp(request: Request): string {
  const direct = request.headers.get("CF-Connecting-IP");
  if (direct && direct.trim()) return direct.trim();
  const forwarded = request.headers.get("X-Forwarded-For");
  if (forwarded && forwarded.trim()) return forwarded.split(",")[0].trim();
  return "—";
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const parts = header.split(";");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

function buildCookie(
  name: string,
  value: string,
  opts: { maxAge: number; httpOnly?: boolean; sameSite?: "Lax" | "Strict"; secure?: boolean }
): string {
  let out = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${opts.maxAge}; SameSite=${
    opts.sameSite ?? "Lax"
  }`;
  if (opts.httpOnly !== false) out += "; HttpOnly";
  if (opts.secure) out += "; Secure";
  return out;
}

function isSecureRequest(request: Request): boolean {
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return true;
  }
}

/* ============================== CRIPTOGRAFÍA ============================== */

const textEncoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(input));
  return toHex(digest);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(message));
  return toHex(signature);
}

/** Comparación en tiempo constante (no filtra la contraseña por medición). */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  if (da.length !== db.length) return false;
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da.charCodeAt(i) ^ db.charCodeAt(i);
  return diff === 0;
}

/** Entero uniforme en [0, max) con rechazo (sin sesgo de módulo). */
function unbiasedInt(max: number): number {
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  let value = 0;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0];
  } while (value >= limit);
  return value % max;
}

/** Barajado Fisher–Yates con entropía criptográfica (sin mutar la entrada). */
function fisherYatesShuffle<T>(input: readonly T[]): T[] {
  const items = input.slice();
  for (let i = items.length - 1; i > 0; i--) {
    const j = unbiasedInt(i + 1);
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  return items;
}

/**
 * Asignación de Amigo Secreto por SHIFT CIRCULAR sobre una permutación
 * aleatoria. Propiedad garantizada: para todo i, out[s[i]] !== s[i], es
 * decir, **nadie se asigna a sí mismo**, para cualquier n >= 2.
 * Complejidad O(n), sin reintentos ni posibles fallos.
 */
export function buildAssignments(ids: readonly string[]): Record<string, string> {
  const count = ids.length;
  if (count < 2) {
    throw new RangeError("Se necesitan al menos 2 participantes para sortear.");
  }
  const shuffled = fisherYatesShuffle(ids);
  const assignment: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    assignment[shuffled[i]] = shuffled[(i + 1) % count];
  }
  return assignment;
}

/** Pseudónimo público y estable de un jugador (FNV-1a doble ⇒ 16 hex chars). */
function pseudonym(secret: string, id: string): string {
  const input = `${secret}:${id}`;
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (code + i), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ============================== NORMALIZACIÓN ============================== */

/**
 * Nombre visible: quita caracteres de control y de marcado, colapsa espacios y
 * limita a 20 caracteres (contando los emojis como uno solo).
 */
function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F<>"'`&\\/]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return Array.from(cleaned).slice(0, 20).join("");
}

function describeDevice(userAgent: string): string {
  const ua = userAgent || "";
  let os = "Otro";
  if (/iPhone|iPod/.test(ua)) os = "iPhone";
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua))) os = "iPad";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Macintosh|Mac OS X/.test(ua)) os = "Mac";
  else if (/Linux/.test(ua)) os = "Linux";

  let browser = "";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
  else if (/SamsungBrowser/.test(ua)) browser = "Samsung";
  else if (/CriOS/.test(ua)) browser = "Chrome iOS";
  else if (/FxiOS/.test(ua)) browser = "Firefox iOS";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";
  else if (/Firefox\//.test(ua)) browser = "Firefox";

  const inApp = /FBAN|FBAV|FB_IAB|Instagram|Line\/|WhatsApp|Twitter/i.test(ua)
    ? " · in-app"
    : "";
  return browser ? `${os} · ${browser}${inApp}` : `${os}${inApp}`;
}

/* ============================== CLIENTE D1 (SQL) ============================== */
/**
 * Cloudflare D1 (SQLite gestionado) sustituye al REST de Upstash:
 *   · `db.batch([...])` ejecuta TODAS las sentencias en una sola ida y vuelta y
 *     de forma **atómica** ⇒ el sorteo no puede quedar a medias.
 *   · El latido es un UPDATE de una única fila (sin leer-modificar-escribir) ⇒
 *     no hay carreras cuando entran varias personas a la vez.
 *   · D1 factura por **fila leída/escrita**, no por comando.
 */
function db(env: Env): D1Database {
  const database = env.DB;
  if (!database) {
    throw new ConfigError(
      'Falta el binding de D1. Añade en wrangler.jsonc: "d1_databases": [{ "binding": "DB", "database_name": "amigosecreto", "database_id": "…" }]'
    );
  }
  return database;
}

/** Errores de D1 que merecen un reintento (transitorios). */
const TRANSIENT_D1 = /D1_ERROR|internal error|network|timed? ?out|overloaded|storage|too many/i;

/**
 * Ejecuta una operación contra D1 con UN reintento si el fallo parece
 * transitorio (práctica recomendada por Cloudflare) y, si persiste, lo traduce
 * a un 503 con mensaje claro en lugar de una traza.
 */
async function query<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[d1] intento ${attempt + 1} falló:`, message);
      if (attempt === 0 && TRANSIENT_D1.test(message)) {
        await sleep(120);
        continue;
      }
      throw new UpstreamError();
    }
  }
  console.error("[d1] error persistente:", lastError);
  throw new UpstreamError();
}

/* --------------------- consumo (solo con DEBUG_USAGE=1) --------------------- */
const usage = { queries: 0, rowsRead: 0, rowsWritten: 0, durationMs: 0 };

function trackUsage(env: Env, results: D1Result<unknown>[]): void {
  if (env.DEBUG_USAGE !== "1") return;
  for (const result of results) {
    usage.queries += 1;
    usage.rowsRead += Number(result.meta?.rows_read ?? 0);
    usage.rowsWritten += Number(result.meta?.rows_written ?? 0);
    usage.durationMs += Number(result.meta?.duration ?? 0);
  }
}

/**
 * Único punto de acceso a la base: todo va por `batch`, así que siempre hay
 * UNA ida y vuelta, atomicidad por lote y contabilidad de consumo en un sitio.
 */
async function runBatch(env: Env, statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
  if (statements.length === 0) return [];
  const results = await query(() => db(env).batch(statements));
  trackUsage(env, results);
  return results;
}

/** Fila de `players` tal y como la devuelve D1. */
interface PlayerRow {
  player_id: string;
  name: string;
  emoji: string;
  ip: string;
  ua: string;
  joined_at: number;
  last_seen: number;
  visible: number;
}

/* Los valores de SQLite llegan ya tipados: no hace falta deserializar JSON. */

/* ============================== CLAVES / SALA ============================== */

function roomId(env: Env): string {
  return (env.ROOM_ID || DEFAULT_ROOM_ID).trim() || DEFAULT_ROOM_ID;
}

/**
 * D1 no tiene TTL: en cada alta se purga a quien no se le ve desde hace
 * ROOM_TTL_HOURS horas (por defecto 12; normalmente 0 filas ⇒ 0 escrituras).
 */
function purgeBefore(env: Env, now: number): number {
  const hours = Number(env.ROOM_TTL_HOURS ?? DEFAULT_TTL_HOURS);
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_TTL_HOURS;
  return now - Math.round(safeHours * 60 * 60 * 1000);
}

/**
 * Intervalos ajustables por entorno para controlar el coste de Upstash sin
 * recompilar: TICK_MS, ADMIN_TICK_MS y HEARTBEAT_MS (con acotado defensivo).
 */
function intervalMs(env: Env, key: "TICK_MS" | "ADMIN_TICK_MS" | "HEARTBEAT_MS", fallback: number, min: number, max: number): number {
  const raw = Number(env[key]);
  if (!Number.isFinite(raw) || raw < min) return fallback;
  return Math.min(max, Math.round(raw));
}

/** Frecuencia del latido del jugador (por defecto 2 s). */
const tickIntervalMs = (env: Env) => intervalMs(env, "TICK_MS", PUBLIC_TICK_MS, 1000, 15000);
/** Frecuencia de refresco del panel (por defecto 3 s). */
const adminTickIntervalMs = (env: Env) => intervalMs(env, "ADMIN_TICK_MS", ADMIN_TICK_MS, 1000, 15000);
/** Cada cuánto se escribe realmente el latido en Redis (por defecto 5 s). */
const writeIntervalMs = (env: Env) => intervalMs(env, "HEARTBEAT_MS", WRITE_EVERY_MS, 2000, 60000);

/* ============================== MODELO ============================== */

/* Los registros viven en tablas: `PlayerRow` (arriba) es su forma en la base. */

interface Player {
  id: string;
  pid: string;
  name: string;
  emoji: string;
  ip: string;
  ua: string;
  device: string;
  joinedAt: number;
  lastSeen: number;
  visible: boolean;
}

type Presence = "online" | "idle" | "offline";

type RoomState = "LOBBY" | "DRAWN";

interface Room {
  exists: boolean;
  state: RoomState;
  round: number;
  drawnAt: number;
  players: Player[];
}

function statusOf(player: Player, now: number): Presence {
  const age = now - player.lastSeen;
  if (age >= STALE_MS) return "offline";
  return player.visible ? "online" : "idle";
}

/* ============================== LECTURA DE SALA ============================== */

/**
 * Lee toda la sala en UNA sola llamada (`batch` = 1 ida y vuelta):
 *   1 fila de `room_state` + N filas de `players` (+ el recuento de asignaciones
 *   solo cuando lo pide el panel). D1 factura por fila leída.
 */
async function readRoom(
  env: Env,
  options: { assignedCount?: boolean } = {}
): Promise<{ room: Room; assigned: number | null }> {
  const database = db(env);
  const id = roomId(env);

  const statements: D1PreparedStatement[] = [
    database.prepare("SELECT state, round, drawn_at FROM room_state WHERE id = ?").bind(id),
    database
      .prepare(
        "SELECT player_id, name, emoji, ip, ua, joined_at, last_seen, visible FROM players WHERE room_id = ? ORDER BY joined_at, name"
      )
      .bind(id),
  ];
  if (options.assignedCount) {
    statements.push(
      database.prepare("SELECT COUNT(*) AS total FROM assignments WHERE room_id = ?").bind(id)
    );
  }

  const results = await runBatch(env, statements);

  const stateRow = (results[0]?.results?.[0] ?? null) as {
    state?: string;
    round?: number;
    drawn_at?: number | null;
  } | null;
  const rows = (results[1]?.results ?? []) as PlayerRow[];
  const assignedCount = options.assignedCount
    ? Number((results[2]?.results?.[0] as { total?: number } | undefined)?.total ?? 0)
    : null;

  const secret = env.ADMIN_SECRET || "amigo-secreto";
  const players: Player[] = rows.map((row) => ({
    id: row.player_id,
    pid: pseudonym(secret, row.player_id),
    name: row.name,
    emoji: row.emoji || EMOJIS[0],
    ip: row.ip || "",
    ua: row.ua || "",
    device: describeDevice(row.ua || ""),
    joinedAt: Number(row.joined_at) || 0,
    lastSeen: Number(row.last_seen) || 0,
    visible: Number(row.visible) === 1,
  }));

  const room: Room = {
    exists: stateRow !== null,
    state: stateRow && stateRow.state === "DRAWN" ? "DRAWN" : "LOBBY",
    round: stateRow && stateRow.round ? Number(stateRow.round) : 1,
    drawnAt: stateRow && stateRow.drawn_at ? Number(stateRow.drawn_at) : 0,
    players,
  };

  return { room, assigned: assignedCount };
}

/** Proyección pública: SIN ids reales (solo pseudónimos), sin IP ni UA.
 *  No incluye la ronda (dato solo del panel) para no leer claves de más. */
function publicSnapshot(room: Room, now: number, meId: string | null) {
  const me = meId ? room.players.find((player) => player.id === meId) ?? null : null;
  return {
    ok: true,
    state: room.state,
    total: room.players.length,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    players: room.players.map((player) => ({
      p: player.pid,
      n: player.name,
      e: player.emoji,
      s: statusOf(player, now),
      me: player.id === meId,
    })),
    me: me ? { p: me.pid, n: me.name, e: me.emoji } : null,
  };
}

/** Proyección para el panel: incluye IP, dispositivo y marcas de tiempo. */
function adminSnapshot(room: Room, now: number, assignedCount: number | null) {
  return {
    ok: true,
    state: room.state,
    round: room.round,
    drawnAt: room.drawnAt,
    total: room.players.length,
    assigned: assignedCount,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    players: room.players.map((player) => ({
      p: player.pid,
      n: player.name,
      e: player.emoji,
      ip: player.ip || "—",
      device: player.device,
      s: statusOf(player, now),
      at: player.joinedAt,
      ls: player.lastSeen,
      age: Math.max(0, now - player.lastSeen),
      visible: player.visible,
    })),
  };
}

/* ============================== SESIONES ============================== */

const PLAYER_COOKIE = "as_player";
const ADMIN_COOKIE = "as_admin";
const PLAYER_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
/** Pseudónimo público de un jugador (FNV-1a doble ⇒ 16 caracteres hex). */
const PID_PATTERN = /^[0-9a-f]{8,32}$/;

/**
 * Identifica al jugador por tres vías (en orden de preferencia):
 *   1. `id` en el cuerpo (POST)      2. cabecera X-Player-Id
 *   3. cookie httpOnly de 1 año      4. query `?p=`
 * Así la sesión sobrevive incluso en navegadores in-app sin cookies.
 */
function resolvePlayerId(
  request: Request,
  body: Record<string, unknown> | null
): string | null {
  const candidates: Array<unknown> = [];
  if (body) candidates.push(body.id);
  candidates.push(request.headers.get("X-Player-Id"));
  candidates.push(readCookie(request, PLAYER_COOKIE));
  try {
    candidates.push(new URL(request.url).searchParams.get("p"));
  } catch {
    // URL no parseable: se ignora
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && PLAYER_ID_PATTERN.test(candidate)) return candidate;
  }
  return null;
}

function playerCookieHeader(request: Request, id: string): string {
  return buildCookie(PLAYER_COOKIE, id, {
    maxAge: SESSION_MAX_AGE,
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(request),
  });
}

async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const secret = env.ADMIN_SECRET;
  if (!secret) return false;
  const raw = readCookie(request, ADMIN_COOKIE);
  if (!raw) return false;
  const dot = raw.indexOf(".");
  if (dot <= 0) return false;
  const expires = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  const expiresAt = Number(expires);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = await hmacHex(secret, expires);
  return safeEqual(signature, expected);
}

/** Límite blando de intentos de login por isolate (defensa en profundidad). */
const loginAttempts = new Map<string, { count: number; firstAt: number }>();
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 6;

function loginBlocked(ip: string): boolean {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function registerLoginFailure(ip: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

/* ============================== UTILIDADES DE PETICIÓN ============================== */

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function parseEmoji(raw: unknown): string | null {
  return typeof raw === "string" && EMOJIS.indexOf(raw) >= 0 ? raw : null;
}

/* ============================== HANDLERS ============================== */

/** GET /api/config — configuración pública (una sola fuente de verdad). */
function handleConfig(env: Env): Response {
  return json({
    ok: true,
    emojis: EMOJIS,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    tickMs: tickIntervalMs(env),
    adminTickMs: adminTickIntervalMs(env),
    staleMs: STALE_MS,
  });
}

/**
 * GET /api/state — lectura sin latido (diagnóstico / primer render).
 * POST /api/tick — el latido + snapshot que usa el cliente cada 2 s.
 */
async function handleState(
  request: Request,
  env: Env,
  body: Record<string, unknown> | null,
  heartbeat: boolean
): Promise<Response> {
  const meId = resolvePlayerId(request, body);
  const now = Date.now();
  const { room } = await readRoom(env);
  const me = meId ? room.players.find((player) => player.id === meId) ?? null : null;

  if (heartbeat && me) {
    const wantedVisible = body && body.v !== undefined ? Boolean(body.v) : true;
    const wantedEmoji = body ? parseEmoji(body.e) : null;
    const emojiChanged = wantedEmoji !== null && wantedEmoji !== me.emoji;
    const needsWrite =
      emojiChanged ||
      me.visible !== wantedVisible ||
      now - me.lastSeen > writeIntervalMs(env);

    if (needsWrite) {
      const nextEmoji = wantedEmoji ?? me.emoji;
      /* Un único UPDATE de una fila: sin leer-modificar-escribir (no hay
         carreras con otras altas) y sin tocar el resto de la sala. */
      await runBatch(env, [
        db(env)
          .prepare(
            "UPDATE players SET last_seen = ?, visible = ?, emoji = ? WHERE room_id = ? AND player_id = ?"
          )
          .bind(now, wantedVisible ? 1 : 0, nextEmoji, roomId(env), me.id),
      ]);
      me.lastSeen = now;
      me.visible = wantedVisible;
      me.emoji = nextEmoji;
    }
  }

  return json(publicSnapshot(room, now, me ? me.id : null));
}

/**
 * POST /api/join — registra (o actualiza) al jugador.
 * Guarda nombre, emoji, IP real (CF-Connecting-IP) y dispositivo, y fija la
 * cookie de sesión de 1 año para que al volver NO haya que reescribir el nombre.
 */
async function handleJoin(
  request: Request,
  env: Env,
  body: Record<string, unknown> | null
): Promise<Response> {
  const payload = body ?? {};
  const name = sanitizeName(payload.n !== undefined ? payload.n : payload.name);
  if (!name) {
    return fail(400, "Escribe un nombre válido (de 1 a 20 caracteres).");
  }

  const ip = clientIp(request);
  const userAgent = request.headers.get("User-Agent") || "";
  const { room } = await readRoom(env);

  const requestedId = resolvePlayerId(request, payload);
  const previous = requestedId
    ? room.players.find((player) => player.id === requestedId) ?? null
    : null;

  if (!previous && room.players.length >= MAX_PLAYERS) {
    return fail(409, `La sala está llena (${MAX_PLAYERS} personas máximo).`);
  }

  const now = Date.now();
  const id = previous ? previous.id : crypto.randomUUID();
  const emoji = parseEmoji(payload.e) ?? (previous ? previous.emoji : EMOJIS[0]);
  const roomCode = roomId(env);
  const joinedAt = previous ? previous.joinedAt : now;
  const finalIp = ip !== "—" ? ip : previous ? previous.ip : "—";
  const finalUa = userAgent || (previous ? previous.ua : "");

  /* Un solo `batch` atómico:
     1. asegura la fila de la sala (0 escrituras si ya existe),
     2. alta o actualización de la persona (UPSERT por clave compuesta),
     3. purga de quien no aparece desde hace ROOM_TTL_HOURS (normalmente 0 filas). */
  await runBatch(env, [
    db(env)
      .prepare(
        "INSERT INTO room_state (id, state, round, updated_at) VALUES (?, 'LOBBY', 1, ?) ON CONFLICT(id) DO NOTHING"
      )
      .bind(roomCode, now),
    db(env)
      .prepare(
        `INSERT INTO players (room_id, player_id, name, emoji, ip, ua, joined_at, last_seen, visible)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(room_id, player_id) DO UPDATE SET
           name = excluded.name,
           emoji = excluded.emoji,
           ip = excluded.ip,
           ua = excluded.ua,
           last_seen = excluded.last_seen,
           visible = 1`
      )
      .bind(roomCode, id, name, emoji, finalIp, finalUa, joinedAt, now),
    db(env)
      .prepare("DELETE FROM players WHERE room_id = ? AND last_seen < ?")
      .bind(roomCode, purgeBefore(env, now)),
  ]);

  return json(
    {
      ok: true,
      me: { id, n: name, e: emoji },
      state: room.state,
      total: previous ? room.players.length : room.players.length + 1,
      config: { emojis: EMOJIS, minPlayers: MIN_PLAYERS, tickMs: tickIntervalMs(env) },
    },
    200,
    { "Set-Cookie": playerCookieHeader(request, id) }
  );
}

/**
 * GET /api/target — devuelve ÚNICAMENTE el amigo secreto de quien pregunta.
 * Se llama al iniciar el gesto de "mantener pulsado" (anti shoulder-surfing).
 * UNA consulta con JOIN: no se lee ninguna otra fila de la sala.
 */
async function handleTarget(request: Request, env: Env): Promise<Response> {
  const meId = resolvePlayerId(request, null);
  if (!meId) {
    return fail(401, "No encontramos tu sesión. Vuelve a entrar con tu nombre.");
  }

  const results = await runBatch(env, [
    db(env)
      .prepare(
        `SELECT t.name AS name, t.emoji AS emoji
           FROM assignments a
           JOIN players t ON t.room_id = a.room_id AND t.player_id = a.target_id
          WHERE a.room_id = ? AND a.giver_id = ? AND a.giver_id <> a.target_id`
      )
      .bind(roomId(env), meId),
  ]);

  const row = (results[0]?.results?.[0] ?? null) as { name?: string; emoji?: string } | null;
  if (!row || !row.name) {
    /* Sin asignación (entró después del sorteo) o el objetivo ya no está:
       el `AND giver_id <> target_id` garantiza que jamás servimos un auto-regalo. */
    return fail(
      409,
      "Todavía no tienes amigo secreto asignado. Si acabas de entrar, pídele al anfitrión que vuelva a sortear."
    );
  }

  return json({ ok: true, targetName: row.name, targetEmoji: row.emoji || EMOJIS[0] });
}

/* ============================== ADMIN ============================== */

/** POST /api/admin/login — contraseña ⇒ cookie firmada (HMAC-SHA256) 30 días. */
async function handleAdminLogin(
  request: Request,
  env: Env,
  body: Record<string, unknown> | null
): Promise<Response> {
  const ip = clientIp(request);
  if (loginBlocked(ip)) {
    return fail(429, "Demasiados intentos fallidos. Espera unos minutos.");
  }

  const expected = env.ADMIN_PASSWORD || "";
  const secret = env.ADMIN_SECRET || "";
  if (!expected || !secret) {
    return fail(
      500,
      "El servidor no tiene configurados ADMIN_PASSWORD y ADMIN_SECRET (revisa las variables de entorno)."
    );
  }

  const provided = body && typeof body.password === "string" ? body.password : "";
  const ok = await safeEqual(provided, expected);
  if (!ok) {
    registerLoginFailure(ip);
    await sleep(400); // frena la fuerza bruta
    return fail(401, "Contraseña incorrecta.");
  }

  const expiresAt = Date.now() + ADMIN_MAX_AGE * 1000;
  const signature = await hmacHex(secret, String(expiresAt));
  const cookie = buildCookie(ADMIN_COOKIE, `${expiresAt}.${signature}`, {
    maxAge: ADMIN_MAX_AGE,
    httpOnly: true,
    sameSite: "Strict",
    secure: isSecureRequest(request),
  });

  loginAttempts.delete(ip);
  return json({ ok: true }, 200, { "Set-Cookie": cookie });
}

/** POST /api/admin/logout — borra la cookie del panel. */
function handleAdminLogout(request: Request): Response {
  return json({ ok: true }, 200, {
    "Set-Cookie": buildCookie(ADMIN_COOKIE, "", {
      maxAge: 0,
      httpOnly: true,
      sameSite: "Strict",
      secure: isSecureRequest(request),
    }),
  });
}

/** GET /api/admin/state — listado completo con IP, dispositivo y presencia. */
async function handleAdminState(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("X-Admin-Probe") !== null) {
    return json({ ok: true, admin: await isAdmin(request, env) });
  }
  const { room, assigned } = await readRoom(env, { assignedCount: true });
  return json(adminSnapshot(room, Date.now(), assigned));
}

/** POST /api/admin/draw — sortea a TODOS (derangement: nadie consigo mismo). */
async function handleAdminDraw(
  request: Request,
  env: Env,
  body: Record<string, unknown> | null
): Promise<Response> {
  const force = Boolean(body && body.force);
  const { room } = await readRoom(env);

  if (room.players.length < MIN_PLAYERS) {
    return fail(409, MIN_PLAYERS_MESSAGE);
  }
  if (room.state === "DRAWN" && !force) {
    return fail(409, "La sala ya fue sorteada. Confirma para volver a sortear.");
  }

  const ids = room.players.map((player) => player.id);
  const assignment = buildAssignments(ids);
  const now = Date.now();
  const round = room.round + 1;
  const roomCode = roomId(env);

  /* Un único `batch` ATÓMICO: borrar la matriz anterior, insertar la nueva y
     marcar la sala como sorteada. Si algo fallara, no se aplica nada: nunca
     queda una sala "a medio sortear". */
  const values: Array<string | number> = [];
  const placeholders: string[] = [];
  for (const giver of ids) {
    placeholders.push("(?, ?, ?, ?, ?)");
    values.push(roomCode, giver, assignment[giver], round, now);
  }

  await runBatch(env, [
    db(env).prepare("DELETE FROM assignments WHERE room_id = ?").bind(roomCode),
    db(env)
      .prepare(
        `INSERT INTO assignments (room_id, giver_id, target_id, round, created_at) VALUES ${placeholders.join(", ")}`
      )
      .bind(...values),
    db(env)
      .prepare(
        "UPDATE room_state SET state = 'DRAWN', drawn_at = ?, round = ?, updated_at = ? WHERE id = ?"
      )
      .bind(now, round, now, roomCode),
  ]);

  return json({ ok: true, total: ids.length, round });
}

/** POST /api/admin/reset — vuelve al lobby (nueva ronda). */
async function handleAdminReset(env: Env, body: Record<string, unknown> | null): Promise<Response> {
  const keepPlayers = body ? body.keepPlayers !== false : true;
  const roomCode = roomId(env);
  const statements: D1PreparedStatement[] = [
    db(env).prepare("DELETE FROM assignments WHERE room_id = ?").bind(roomCode),
    db(env)
      .prepare("UPDATE room_state SET state = 'LOBBY', drawn_at = NULL, updated_at = ? WHERE id = ?")
      .bind(Date.now(), roomCode),
  ];
  if (!keepPlayers) {
    statements.push(db(env).prepare("DELETE FROM players WHERE room_id = ?").bind(roomCode));
  }
  await runBatch(env, statements);
  return json({ ok: true, keepPlayers });
}

/** POST /api/admin/player — cambia el emoji (◀ ▶) o expulsa a alguien. */
async function handleAdminPlayer(env: Env, body: Record<string, unknown> | null): Promise<Response> {
  const payload = body ?? {};
  const pid = typeof payload.p === "string" ? payload.p : "";
  const action = typeof payload.action === "string" ? payload.action : "";
  /* Validar la entrada ANTES de tocar el almacén: una acción inválida no debe
     consumir comandos de Redis ni devolver un 404 confuso. */
  if (!pid) return fail(400, "Falta el identificador de la persona.");
  if (action !== "kick" && action !== "emoji_next" && action !== "emoji_prev") {
    return fail(400, "Acción no reconocida. Usa: kick, emoji_next o emoji_prev.");
  }
  if (!PID_PATTERN.test(pid)) return fail(400, "Identificador de persona no válido.");

  const { room } = await readRoom(env);
  const player = room.players.find((candidate) => candidate.pid === pid);
  if (!player) return fail(404, "Esa persona ya no está en la sala.");

  const roomCode = roomId(env);

  if (action === "kick") {
    /* Se borra también su fila en la matriz y las de quien la apuntaba: dejar
       referencias colgando produciría un 409 incomprensible al sortear. */
    await runBatch(env, [
      db(env)
        .prepare("DELETE FROM players WHERE room_id = ? AND player_id = ?")
        .bind(roomCode, player.id),
      db(env)
        .prepare("DELETE FROM assignments WHERE room_id = ? AND giver_id = ?")
        .bind(roomCode, player.id),
      db(env)
        .prepare("DELETE FROM assignments WHERE room_id = ? AND target_id = ?")
        .bind(roomCode, player.id),
    ]);
    return json({ ok: true, kicked: pid });
  }

  const index = EMOJIS.indexOf(player.emoji);
  const step = action === "emoji_next" ? 1 : -1;
  const nextIndex = (index < 0 ? 0 : index + step + EMOJIS.length) % EMOJIS.length;
  const emoji = EMOJIS[nextIndex];

  await runBatch(env, [
    db(env)
      .prepare("UPDATE players SET emoji = ? WHERE room_id = ? AND player_id = ?")
      .bind(emoji, roomCode, player.id),
  ]);
  return json({ ok: true, emoji });
}

/**
 * POST /api/admin/purge — quita de la sala a quien ya no está (ausentes).
 * `seconds` marca desde cuándo se considera ausente (por defecto 600 = 10 min;
 * mínimo 1 y máximo 30 días). Borra también sus filas de la matriz para no
 * dejar referencias colgando: si la sala estaba sorteada, el panel avisa de que
 * hay que volver a sortear (ya lo hace con el contador de asignados).
 */
async function handleAdminPurge(env: Env, body: Record<string, unknown> | null): Promise<Response> {
  const raw = Number(body ? body.seconds : 600);
  const seconds =
    Number.isFinite(raw) && raw >= 1 ? Math.min(Math.round(raw), 60 * 60 * 24 * 30) : 600;
  const cutoff = Date.now() - seconds * 1000;
  const roomCode = roomId(env);

  const results = await runBatch(env, [
    db(env)
      .prepare(
        "DELETE FROM assignments WHERE room_id = ? AND giver_id IN (SELECT player_id FROM players WHERE room_id = ? AND last_seen < ?)"
      )
      .bind(roomCode, roomCode, cutoff),
    db(env)
      .prepare(
        "DELETE FROM assignments WHERE room_id = ? AND target_id IN (SELECT player_id FROM players WHERE room_id = ? AND last_seen < ?)"
      )
      .bind(roomCode, roomCode, cutoff),
    db(env)
      .prepare("DELETE FROM players WHERE room_id = ? AND last_seen < ?")
      .bind(roomCode, cutoff),
  ]);

  const purged = Number(results[2]?.meta?.rows_written ?? 0);
  return json({ ok: true, purged, seconds });
}

/**
 * GET /api/admin/usage — consumo de D1 desde que arrancó este isolate.
 * Solo se activa con DEBUG_USAGE=1 (en producción no se define): permite que la
 * prueba de carga mida FILAS leídas/escritas reales en vez de estimarlas.
 */
function handleAdminUsage(env: Env): Response {
  return json({
    ok: true,
    enabled: env.DEBUG_USAGE === "1",
    queries: usage.queries,
    rowsRead: usage.rowsRead,
    rowsWritten: usage.rowsWritten,
    durationMs: Math.round(usage.durationMs),
  });
}

/**
 * GET /api/admin/matrix — auditoría del sorteo: pares dador → receptor.
 * UNA consulta con dos JOIN: verifica que NADIE se asignó a sí mismo.
 */
async function handleAdminMatrix(env: Env): Promise<Response> {
  const results = await runBatch(env, [
    db(env)
      .prepare(
        `SELECT a.giver_id AS giver_id,
                a.target_id AS target_id,
                p.name AS giver_name,
                t.name AS target_name
           FROM assignments a
           LEFT JOIN players p ON p.room_id = a.room_id AND p.player_id = a.giver_id
           LEFT JOIN players t ON t.room_id = a.room_id AND t.player_id = a.target_id
          WHERE a.room_id = ?`
      )
      .bind(roomId(env)),
  ]);

  const rows = (results[0]?.results ?? []) as Array<{
    giver_id: string;
    target_id: string;
    giver_name: string | null;
    target_name: string | null;
  }>;

  let selfAssigned = 0;
  const pairs = rows.map((row) => {
    const self = row.giver_id === row.target_id;
    if (self) selfAssigned += 1;
    return {
      from: row.giver_name ?? "(desconocido)",
      to: row.target_name ?? "(desconocido)",
      self,
    };
  });

  return json({
    ok: true,
    total: pairs.length,
    selfAssigned,
    valid: pairs.length > 0 && selfAssigned === 0,
    pairs,
  });
}

/* ============================== ROUTER ============================== */

function routePath(context: ApiContext): string {
  const raw = context.params ? context.params.path : undefined;
  if (Array.isArray(raw)) return raw.filter(Boolean).join("/").toLowerCase();
  if (typeof raw === "string") return raw.replace(/^\/+|\/+$/g, "").toLowerCase();
  try {
    const pathname = new URL(context.request.url).pathname;
    return pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "").toLowerCase();
  } catch {
    return "";
  }
}

function methodNotAllowed(allowed: string[]): Response {
  return fail(405, `Método no permitido. Usa: ${allowed.join(", ")}.`, { Allow: allowed.join(", ") });
}

/**
 * Traduce cualquier excepción a una respuesta HTTP con mensaje en español.
 * Se usa en DOS sitios a propósito (ver `onRequest`): es la red de seguridad
 * contra el clásico error de `return promiseSinAwait` dentro de un try/catch.
 */
function errorResponse(error: unknown): Response {
  if (error instanceof ConfigError) return fail(500, error.message);
  if (error instanceof UpstreamError) {
    return fail(503, "No se pudo conectar con el almacén de datos. Reintenta en unos segundos.");
  }
  if (error instanceof RangeError) return fail(409, error.message);
  console.error("[api] error no controlado:", error);
  return fail(500, "Error interno del servidor.");
}

export async function onRequest(context: ApiContext): Promise<Response> {
  let response: Response;
  try {
    /* `await` deliberado: si algún handler async se devolviera sin esperar
       desde el router, su rechazo se captura AQUÍ (no en el try interno). */
    response = await routeRequest(context);
  } catch (error) {
    response = errorResponse(error);
  }

  /* HTTP/1.1 exige respuesta SIN cuerpo para HEAD (monitores de disponibilidad,
     preflight de algunos WebViews). */
  if (context.request.method.toUpperCase() === "HEAD") {
    return new Response(null, { status: response.status, headers: response.headers });
  }
  return response;
}

async function routeRequest(context: ApiContext): Promise<Response> {
  const { request, env } = context;
  const method = request.method.toUpperCase();
  /* HEAD se atiende como GET en todas las rutas de lectura. */
  const isRead = method === "GET" || method === "HEAD";

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { Allow: "GET, HEAD, POST, OPTIONS" } });
  }

  const path = routePath(context);

  try {
    /* ------------------------------ públicas ------------------------------ */

    if (path === "" || path === "index") {
      if (!isRead) return methodNotAllowed(["GET", "HEAD"]);
      return json({
        ok: true,
        app: "amigo-secreto",
        room: roomId(env),
        endpoints: [
          "GET  /api/config",
          "POST /api/join   { n, e }",
          "POST /api/tick   { v, e? }",
          "GET  /api/state",
          "GET  /api/target",
          "POST /api/admin/login  { password }",
          "GET  /api/admin/state",
          "POST /api/admin/draw   { force? }",
          "POST /api/admin/reset  { keepPlayers? }",
          "POST /api/admin/player { p, action }",
          "POST /api/admin/purge  { seconds? }",
          "GET  /api/admin/matrix",
        ],
      });
    }

    if (path === "config") {
      if (!isRead) return methodNotAllowed(["GET", "HEAD"]);
      return handleConfig(env);
    }

    if (path === "join") {
      if (method !== "POST") return methodNotAllowed(["POST"]);
      return handleJoin(request, env, await readJsonBody(request));
    }

    if (path === "tick") {
      if (method !== "POST") return methodNotAllowed(["POST"]);
      return handleState(request, env, await readJsonBody(request), true);
    }

    if (path === "state") {
      if (isRead) return handleState(request, env, null, false);
      if (method === "POST") return handleState(request, env, await readJsonBody(request), true);
      return methodNotAllowed(["GET", "HEAD", "POST"]);
    }

    if (path === "target") {
      if (!isRead) return methodNotAllowed(["GET", "HEAD"]);
      return handleTarget(request, env);
    }

    /* ------------------------------- admin ------------------------------- */

    if (path === "admin/login") {
      if (method !== "POST") return methodNotAllowed(["POST"]);
      return handleAdminLogin(request, env, await readJsonBody(request));
    }

    if (path.startsWith("admin/")) {
      if (path === "admin/logout" && method === "POST") return handleAdminLogout(request);

      if (!(await isAdmin(request, env))) {
        return fail(401, "Sesión de administrador no válida. Vuelve a iniciar sesión.");
      }

      if (path === "admin/state") {
        if (!isRead) return methodNotAllowed(["GET", "HEAD"]);
        return handleAdminState(request, env);
      }
      if (path === "admin/draw") {
        if (method !== "POST") return methodNotAllowed(["POST"]);
        return handleAdminDraw(request, env, await readJsonBody(request));
      }
      if (path === "admin/reset") {
        if (method !== "POST") return methodNotAllowed(["POST"]);
        return handleAdminReset(env, await readJsonBody(request));
      }
      if (path === "admin/player") {
        if (method !== "POST") return methodNotAllowed(["POST"]);
        return handleAdminPlayer(env, await readJsonBody(request));
      }
      if (path === "admin/purge") {
        if (method !== "POST") return methodNotAllowed(["POST"]);
        return handleAdminPurge(env, await readJsonBody(request));
      }
      if (path === "admin/usage") {
        if (!isRead) return methodNotAllowed(["GET", "HEAD"]);
        return handleAdminUsage(env);
      }
      if (path === "admin/matrix") {
        if (!isRead) return methodNotAllowed(["GET", "HEAD"]);
        return handleAdminMatrix(env);
      }
    }

    return fail(404, `Ruta no encontrada: /api/${path}`);
  } catch (error) {
    return errorResponse(error);
  }
}

/* ============================================================================
 *  ADAPTADOR PARA CLOUDFLARE WORKERS — `export default { fetch }`
 * ============================================================================
 *  El mismo archivo sirve para dos destinos sin duplicar lógica:
 *    · Workers (principal): `main` en wrangler.jsonc usa este export.
 *    · Pages (respaldo): `functions/api/[[path]].ts` reexporta `onRequest`.
 *
 *  Diferencias que absorbe este adaptador:
 *    · En Workers no hay routing por ficheros: los segmentos se sacan de la URL
 *      y se le pasan al router como `params.path` (que ya soportaba ambas formas).
 *    · Si `run_worker_first` enviara al Worker una ruta que no es de la API, se
 *      delega en los assets estáticos (binding ASSETS).
 * ========================================================================== */
const API_PREFIX = "/api";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: { waitUntil: (promise: Promise<unknown>) => void }
  ): Promise<Response> {
    const url = new URL(request.url);
    const isApi = url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`);

    if (!isApi && env.ASSETS) {
      /* Los estáticos los sirve el CDN; esto es solo una red de seguridad. */
      return env.ASSETS.fetch(request);
    }

    const segments = url.pathname
      .slice(API_PREFIX.length)
      .split("/")
      .filter((segment) => segment.length > 0);

    return onRequest({
      request,
      env,
      params: { path: segments },
      waitUntil: ctx.waitUntil,
      next: async () =>
        env.ASSETS ? env.ASSETS.fetch(request) : new Response(null, { status: 404 }),
    });
  },
};


