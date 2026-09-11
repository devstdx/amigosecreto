/**
 * ============================================================================
 *  Amigo Secreto — BACKEND MONOLÍTICO (Cloudflare Workers)
 * ============================================================================
 *
 *  Un único archivo con TODO el servidor:
 *    · Router de /api/*
 *    · Dominio de la sala ÚNICA (estado, jugadores, sorteo, rondas)
 *    · Cliente HTTP mínimo del REST de Upstash (1 petición = pipeline)
 *    · Sesiones de jugador (cookie 1 año + localStorage/header de respaldo)
 *    · Panel de administración (login con HMAC, IP, UA, emoji, activo/inactivo)
 *
 *  Decisiones de ingeniería (por qué así):
 *   1. Sin dependencias npm en runtime (solo `fetch` + Web Crypto) ⇒ bundle
 *      mínimo, cold start mínimo y nada que pueda romper al empaquetar.
 *   2. Sin `nodejs_compat` (no se usa ningún módulo de Node) ⇒ menos coste.
 *   3. El id del jugador es un token bearer (UUID v4, 122 bits) y NUNCA se
 *      expone públicamente: hacia fuera se usa un seudónimo `pid` derivado
 *      con FNV-1a y un secreto (estable, no reversible).
 *   4. La matriz `jugador -> objetivo` vive SOLO aquí; el jugador consulta
 *      únicamente su propia fila.
 *   5. Sorteo por derangement (Fisher–Yates + shift circular) ⇒ NADIE se
 *      asigna a sí mismo, siempre, para cualquier n >= 2.
 *
 *  Variables de entorno (secrets de Pages):
 *    UPSTASH_REDIS_REST_URL    · URL REST de la base Upstash
 *    UPSTASH_REDIS_REST_TOKEN  · token REST de Upstash
 *    ADMIN_PASSWORD            · contraseña del panel /admin
 *    ADMIN_SECRET              · secreto para firmar cookies y pseudónimos
 *    ROOM_ID                   · (opcional) id de la sala, por defecto "main"
 *    ROOM_TTL_DAYS             · (opcional) días de vida del estado, por defecto 30
 * ============================================================================
 */

interface Env {
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
  ADMIN_PASSWORD?: string;
  ADMIN_SECRET?: string;
  ROOM_ID?: string;
  ROOM_TTL_DAYS?: string;
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

/** Una orden del protocolo Redis en formato REST: ["HSET", clave, campo, valor] */
type Cmd = (string | number)[];

/** Corte de seguridad: si el upstream no responde en 5 s se degrada a 503. */
const UPSTREAM_TIMEOUT_MS = 5000;

/* ============================== CONSTANTES ============================== */

const DEFAULT_ROOM_ID = "main";
const DEFAULT_TTL_DAYS = 30;

/** Personas mínimas para poder sortear (con 2 ya es un derangement válido). */
const MIN_PLAYERS = 2;
/** Tope defensivo: evita que alguien llene el hash de jugadores. */
const MAX_PLAYERS = 60;

const SESSION_MAX_AGE = 60 * 60 * 24 * 365; // sesión de jugador: 1 año
const ADMIN_MAX_AGE = 60 * 60 * 24 * 30; // sesión de admin: 30 días

/** Latidos: el estado se recalcula en cada lectura, sin cron. */
const ONLINE_MS = 15_000; // visto hace < 15 s y visible  ⇒ EN PANTALLA
const STALE_MS = 60_000; // visto hace >= 60 s           ⇒ DESCONECTADO
/** El servidor solo escribe el latido cada 5 s aunque el cliente pulse cada 2 s. */
const WRITE_EVERY_MS = 5_000;

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

/* ========================= CLIENTE UPSTASH (REST) ========================= */
/**
 * El REST de Upstash acepta un array de órdenes en el cuerpo y las ejecuta en
 * forma de pipeline, devolviendo un array de resultados en el mismo orden.
 * Una sola petición HTTP ⇒ 1 RTT para leer todo el estado de la sala.
 */
async function redis(env: Env, commands: Cmd[]): Promise<unknown[]> {
  const url = (env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
  const token = env.UPSTASH_REDIS_REST_TOKEN || "";
  if (!url || !token) {
    throw new ConfigError(
      "Falta la configuración de Upstash (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)."
    );
  }
  if (commands.length === 0) return [];

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
      /* Si Upstash se cuelga, abortamos: mejor un 503 en 5 s que una pantalla
         de "cargando" infinita en el móvil del invitado. */
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (cause) {
    console.error("[upstash] fetch falló o expiró:", cause);
    throw new UpstreamError();
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "<sin cuerpo>";
    }
    console.error("[upstash] HTTP", response.status, detail.slice(0, 300));
    throw new UpstreamError();
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    console.error("[upstash] respuesta no JSON:", cause);
    throw new UpstreamError();
  }

  const list: unknown[] = Array.isArray(payload) ? payload : [payload];
  return list.map((entry) => {
    if (entry && typeof entry === "object" && "error" in (entry as Record<string, unknown>)) {
      const message = String((entry as Record<string, unknown>).error);
      console.error("[upstash] error de comando:", message);
      throw new UpstreamError();
    }
    if (entry && typeof entry === "object" && "result" in (entry as Record<string, unknown>)) {
      const result = (entry as Record<string, unknown>).result;
      return result === undefined ? null : result;
    }
    return entry;
  });
}

/** Decodifica un valor que puede venir como string JSON o ya como objeto. */
function decodeJson<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw as T;
  return null;
}

/**
 * Normaliza HGETALL: Upstash puede devolver un objeto {campo: valor} o un
 * array plano [campo, valor, campo, valor] (formato RESP2). Ambos se aceptan.
 */
function entriesOf(raw: unknown): Array<[string, unknown]> {
  if (Array.isArray(raw)) {
    const out: Array<[string, unknown]> = [];
    for (let i = 0; i + 1 < raw.length; i += 2) out.push([String(raw[i]), raw[i + 1]]);
    return out;
  }
  if (raw && typeof raw === "object") {
    return Object.keys(raw as Record<string, unknown>).map((key) => [
      key,
      (raw as Record<string, unknown>)[key],
    ]);
  }
  return [];
}

/* ============================== CLAVES ============================== */

function roomId(env: Env): string {
  return (env.ROOM_ID || DEFAULT_ROOM_ID).trim() || DEFAULT_ROOM_ID;
}

const keyState = (env: Env) => `room:${roomId(env)}:state`;
const keyPlayers = (env: Env) => `room:${roomId(env)}:players`;
const keyAssign = (env: Env) => `room:${roomId(env)}:assign`;
const keyRound = (env: Env) => `room:${roomId(env)}:round`;
const keyDrawnAt = (env: Env) => `room:${roomId(env)}:drawnAt`;

function ttlSeconds(env: Env): number {
  const days = Number(env.ROOM_TTL_DAYS || DEFAULT_TTL_DAYS);
  const safeDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_TTL_DAYS;
  return Math.round(safeDays * 24 * 60 * 60);
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

/** Registro persistido: claves cortas para que el JSON sea diminuto. */
interface StoredPlayer {
  n: string; // nombre
  e: string; // emoji
  ip: string;
  ua: string;
  at: number; // joinedAt (ms)
  ls: number; // lastSeen (ms)
  v: boolean | 0 | 1; // visible (admitimos boolean por robustez al deserializar)
}

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
 * Lee la sala completa en UNA sola petición HTTP.
 *  · modo público (2 comandos): estado + jugadores. Es lo que necesitan el
 *    latido, el alta y los ajustes del panel.
 *  · modo completo (4 comandos): añade ronda y fecha del sorteo (sorteo/panel).
 * Upstash factura POR COMANDO, así que el modo público recorta el coste del
 * polling a la mitad sin perder ninguna funcionalidad del jugador.
 * `extra` permite añadir órdenes al mismo pipeline (p. ej. HLEN en el panel).
 */
async function readRoom(
  env: Env,
  full = true,
  extra: Cmd[] = []
): Promise<{ room: Room; extra: unknown[] }> {
  const base: Cmd[] = full
    ? [
        ["GET", keyState(env)],
        ["GET", keyRound(env)],
        ["GET", keyDrawnAt(env)],
        ["HGETALL", keyPlayers(env)],
      ]
    : [
        ["GET", keyState(env)],
        ["HGETALL", keyPlayers(env)],
      ];

  const results = await redis(env, [...base, ...extra]);

  const rawState = results[0];
  const rawRound = full ? results[1] : null;
  const rawDrawnAt = full ? results[2] : null;
  const rawPlayers = results[full ? 3 : 1];

  const players: Player[] = [];

  for (const [id, raw] of entriesOf(rawPlayers)) {
    const stored = decodeJson<StoredPlayer>(raw);
    if (!stored || typeof stored.n !== "string") continue;
    players.push({
      id,
      pid: "",
      name: stored.n,
      emoji: typeof stored.e === "string" && stored.e ? stored.e : EMOJIS[0],
      ip: typeof stored.ip === "string" ? stored.ip : "",
      ua: typeof stored.ua === "string" ? stored.ua : "",
      device: describeDevice(typeof stored.ua === "string" ? stored.ua : ""),
      joinedAt: Number(stored.at) || 0,
      lastSeen: Number(stored.ls) || 0,
      visible: stored.v === 1 || stored.v === true,
    });
  }

  players.sort((a, b) => a.joinedAt - b.joinedAt || a.name.localeCompare(b.name, "es"));

  const secret = env.ADMIN_SECRET || "amigo-secreto";
  for (const player of players) player.pid = pseudonym(secret, player.id);

  const room: Room = {
    exists: typeof rawState === "string" && rawState.length > 0,
    state: rawState === "DRAWN" ? "DRAWN" : "LOBBY",
    round: Number(rawRound) || 1,
    drawnAt: Number(rawDrawnAt) || 0,
    players,
  };

  return { room, extra: results.slice(base.length) };
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
    onlineMs: ONLINE_MS,
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
  const { room } = await readRoom(env, false);
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
      const stored: StoredPlayer = {
        n: me.name,
        e: wantedEmoji ?? me.emoji,
        ip: me.ip,
        ua: me.ua,
        at: me.joinedAt,
        ls: now,
        v: wantedVisible ? 1 : 0,
      };
      /* Un solo comando por latido: el TTL (30 días) se renueva en el alta y en
         el sorteo, no hace falta gastar dos EXPIRE cada 5 segundos. */
      await redis(env, [["HSET", keyPlayers(env), me.id, JSON.stringify(stored)]]);
      me.lastSeen = now;
      me.visible = wantedVisible;
      me.emoji = stored.e;
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
  const { room } = await readRoom(env, false);

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
  const ttl = ttlSeconds(env);

  const stored: StoredPlayer = {
    n: name,
    e: emoji,
    ip: ip !== "—" ? ip : previous ? previous.ip : "—",
    ua: userAgent || (previous ? previous.ua : ""),
    at: previous ? previous.joinedAt : now,
    ls: now,
    v: 1,
  };

  const commands: Cmd[] = [
    ["HSET", keyPlayers(env), id, JSON.stringify(stored)],
    ["EXPIRE", keyPlayers(env), ttl],
    ["EXPIRE", keyState(env), ttl],
  ];
  if (!room.exists) {
    commands.push(["SET", keyState(env), "LOBBY", "EX", ttl]);
    commands.push(["SET", keyRound(env), "1", "EX", ttl]);
  }
  await redis(env, commands);

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
 * Una sola petición HTTP con 2 órdenes: la fila propia + el censo de nombres.
 */
async function handleTarget(request: Request, env: Env): Promise<Response> {
  const meId = resolvePlayerId(request, null);
  if (!meId) {
    return fail(401, "No encontramos tu sesión. Vuelve a entrar con tu nombre.");
  }

  const [rawTargetId, rawPlayers] = await redis(env, [
    ["HGET", keyAssign(env), meId],
    ["HGETALL", keyPlayers(env)],
  ]);

  const targetId = typeof rawTargetId === "string" ? rawTargetId : null;
  if (!targetId) {
    return fail(
      409,
      "Todavía no tienes amigo secreto asignado. Si acabas de entrar, pídele al anfitrión que vuelva a sortear."
    );
  }
  if (targetId === meId) {
    // Defensa en profundidad: nunca debería ocurrir (el sorteo es un derangement).
    return fail(500, "Asignación inválida: avisa al anfitrión para volver a sortear.");
  }

  for (const [id, raw] of entriesOf(rawPlayers)) {
    if (id !== targetId) continue;
    const stored = decodeJson<StoredPlayer>(raw);
    if (!stored) break;
    return json({ ok: true, targetName: stored.n, targetEmoji: stored.e || EMOJIS[0] });
  }

  return fail(409, "Tu amigo secreto ya no está en la sala. Pide un nuevo sorteo.");
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
  const { room, extra } = await readRoom(env, true, [["HLEN", keyAssign(env)]]);
  const assignedRaw = extra[0];
  const assigned = typeof assignedRaw === "number" ? assignedRaw : Number(assignedRaw) || 0;
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
  const pairs: Array<string> = [];
  for (const giver of Object.keys(assignment)) {
    pairs.push(giver, assignment[giver]);
  }

  const ttl = ttlSeconds(env);
  await redis(env, [
    ["DEL", keyAssign(env)],
    ["HSET", keyAssign(env), ...pairs],
    ["EXPIRE", keyAssign(env), ttl],
    ["SET", keyState(env), "DRAWN", "EX", ttl],
    ["SET", keyDrawnAt(env), String(Date.now()), "EX", ttl],
    ["SET", keyRound(env), String(room.round + 1), "EX", ttl],
    ["EXPIRE", keyPlayers(env), ttl],
  ]);

  return json({ ok: true, total: ids.length, round: room.round + 1 });
}

/** POST /api/admin/reset — vuelve al lobby (nueva ronda). */
async function handleAdminReset(env: Env, body: Record<string, unknown> | null): Promise<Response> {
  const keepPlayers = body ? body.keepPlayers !== false : true;
  const ttl = ttlSeconds(env);
  const commands: Cmd[] = [
    ["DEL", keyAssign(env)],
    ["DEL", keyDrawnAt(env)],
    ["SET", keyState(env), "LOBBY", "EX", ttl],
  ];
  if (!keepPlayers) commands.push(["DEL", keyPlayers(env)]);
  await redis(env, commands);
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

  const { room } = await readRoom(env, false);
  const player = room.players.find((candidate) => candidate.pid === pid);
  if (!player) return fail(404, "Esa persona ya no está en la sala.");

  if (action === "kick") {
    await redis(env, [
      ["HDEL", keyPlayers(env), player.id],
      ["HDEL", keyAssign(env), player.id],
    ]);
    return json({ ok: true, kicked: pid });
  }

  const index = EMOJIS.indexOf(player.emoji);
  const step = action === "emoji_next" ? 1 : -1;
  const nextIndex = (index < 0 ? 0 : index + step + EMOJIS.length) % EMOJIS.length;
  const emoji = EMOJIS[nextIndex];
  const ttl = ttlSeconds(env);

  const stored: StoredPlayer = {
    n: player.name,
    e: emoji,
    ip: player.ip,
    ua: player.ua,
    at: player.joinedAt,
    ls: player.lastSeen,
    v: player.visible ? 1 : 0,
  };
  await redis(env, [
    ["HSET", keyPlayers(env), player.id, JSON.stringify(stored)],
    ["EXPIRE", keyPlayers(env), ttl],
  ]);
  return json({ ok: true, emoji });
}

/**
 * GET /api/admin/matrix — auditoría del sorteo: pares dador → receptor.
 * Verifica que NADIE se asignó a sí mismo y ayuda a resolver incidencias.
 */
async function handleAdminMatrix(env: Env): Promise<Response> {
  const [rawAssign, rawPlayers] = await redis(env, [
    ["HGETALL", keyAssign(env)],
    ["HGETALL", keyPlayers(env)],
  ]);

  const names = new Map<string, string>();
  for (const [id, raw] of entriesOf(rawPlayers)) {
    const stored = decodeJson<StoredPlayer>(raw);
    names.set(id, stored ? stored.n : "(desconocido)");
  }

  const pairs: Array<{ from: string; to: string; self: boolean }> = [];
  let selfAssigned = 0;
  for (const [giverId, rawTargetId] of entriesOf(rawAssign)) {
    const targetId = String(rawTargetId);
    const self = giverId === targetId;
    if (self) selfAssigned += 1;
    pairs.push({
      from: names.get(giverId) ?? "(desconocido)",
      to: names.get(targetId) ?? "(desconocido)",
      self,
    });
  }

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


