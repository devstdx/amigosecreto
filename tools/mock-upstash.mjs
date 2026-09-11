#!/usr/bin/env node
/**
 * ============================================================================
 *  Mock del REST de Upstash Redis — SOLO PARA DESARROLLO Y PRUEBAS
 * ============================================================================
 *
 *  Levanta un servidor HTTP que habla el mismo protocolo que Upstash:
 *    POST /             cuerpo: ["GET","clave"]         → {"result": ...}
 *    POST /             cuerpo: [["GET","a"],["HSET",…]] → [{"result":…}, …]
 *
 *  Permite probar TODO el backend (sala, sesiones, sorteo, admin) en local sin
 *  crear una base real. No se despliega: solo suben `public/` y `functions/`.
 *
 *  Uso:
 *    node tools/mock-upstash.mjs                 # escucha en 127.0.0.1:9999
 *    MOCK_PORT=9999 node tools/mock-upstash.mjs
 *
 *  Luego, en .dev.vars:
 *    UPSTASH_REDIS_REST_URL="http://127.0.0.1:9999"
 *    UPSTASH_REDIS_REST_TOKEN="mock-token"
 */

import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT || 9999);
const HOST = process.env.MOCK_HOST || "127.0.0.1";

/** @type {Map<string, { type: "string"|"hash", value: string|Map<string,string>, expiresAt?: number }>} */
const store = new Map();

function getEntry(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry;
}

function getHash(key) {
  const entry = getEntry(key);
  return entry && entry.type === "hash" ? entry : undefined;
}

function applyExpire(entry, args) {
  const indexEx = args.findIndex((arg) => String(arg).toUpperCase() === "EX");
  if (indexEx >= 0 && args[indexEx + 1] !== undefined) {
    entry.expiresAt = Date.now() + Number(args[indexEx + 1]) * 1000;
  }
}

function upsertHash(key) {
  let entry = getHash(key);
  if (!entry) {
    entry = { type: "hash", value: new Map() };
    store.set(key, entry);
  }
  return entry;
}

/** Ejecuta una orden y devuelve el valor de `result` (igual que Upstash). */
function run(command) {
  const args = command.map((arg) => (typeof arg === "number" ? arg : String(arg)));
  const name = String(args[0] || "").toUpperCase();
  const key = args[1] !== undefined ? String(args[1]) : "";

  switch (name) {
    case "PING":
      return "PONG";

    case "GET": {
      const entry = getEntry(key);
      if (!entry || entry.type !== "string") return null;
      return entry.value;
    }

    case "SET": {
      const entry = { type: "string", value: args[2] !== undefined ? String(args[2]) : "" };
      applyExpire(entry, args.slice(3));
      store.set(key, entry);
      return "OK";
    }

    case "DEL": {
      let removed = 0;
      for (const target of args.slice(1)) {
        if (store.delete(String(target))) removed += 1;
      }
      return removed;
    }

    case "INCR": {
      const entry = getEntry(key);
      const next = (entry && entry.type === "string" ? Number(entry.value) || 0 : 0) + 1;
      store.set(key, { type: "string", value: String(next), expiresAt: entry ? entry.expiresAt : undefined });
      return next;
    }

    case "EXPIRE": {
      const entry = getEntry(key);
      if (!entry) return 0;
      const seconds = Number(args[2]);
      if (!Number.isFinite(seconds)) return 0;
      if (seconds <= 0) {
        store.delete(key);
        return 1;
      }
      entry.expiresAt = Date.now() + seconds * 1000;
      return 1;
    }

    case "TTL": {
      const entry = getEntry(key);
      if (!entry) return -2;
      if (!entry.expiresAt) return -1;
      return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
    }

    case "HSET": {
      const entry = upsertHash(key);
      let added = 0;
      for (let i = 2; i + 1 < args.length; i += 2) {
        const field = String(args[i]);
        if (!entry.value.has(field)) added += 1;
        entry.value.set(field, String(args[i + 1]));
      }
      return added;
    }

    case "HGET": {
      const entry = getHash(key);
      if (!entry) return null;
      const field = String(args[2]);
      return entry.value.has(field) ? entry.value.get(field) : null;
    }

    case "HGETALL": {
      const entry = getHash(key);
      const out = {};
      if (entry) {
        for (const [field, value] of entry.value.entries()) out[field] = value;
      }
      return out;
    }

    case "HKEYS": {
      const entry = getHash(key);
      return entry ? Array.from(entry.value.keys()) : [];
    }

    case "HVALS": {
      const entry = getHash(key);
      return entry ? Array.from(entry.value.values()) : [];
    }

    case "HLEN": {
      const entry = getHash(key);
      return entry ? entry.value.size : 0;
    }

    case "HDEL": {
      const entry = getHash(key);
      if (!entry) return 0;
      let removed = 0;
      for (const field of args.slice(2).map(String)) {
        if (entry.value.delete(field)) removed += 1;
      }
      return removed;
    }

    default:
      throw new Error(`ERR comando no soportado por el mock: ${name}`);
  }
}

const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const send = (status, payload) => {
      const text = JSON.stringify(payload);
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(text),
      });
      response.end(text);
    };

    let parsed;
    try {
      parsed = JSON.parse(body || "[]");
    } catch {
      send(400, { error: "ERR el cuerpo no es JSON válido" });
      return;
    }

    try {
      const isPipeline = Array.isArray(parsed) && Array.isArray(parsed[0]);
      if (isPipeline) {
        const results = parsed.map((command) => ({ result: run(command) }));
        console.log(
          `[mock] pipeline(${parsed.length}): ${parsed.map((command) => command[0]).join(", ")}`
        );
        send(200, results);
        return;
      }
      console.log(`[mock] ${Array.isArray(parsed) ? String(parsed[0]) : "?"}`);
      send(200, { result: run(parsed) });
    } catch (error) {
      console.error("[mock] error:", error.message);
      send(400, { error: error.message });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[mock] Upstash REST mock listo en http://${HOST}:${PORT}`);
});
