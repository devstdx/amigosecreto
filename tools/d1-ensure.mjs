#!/usr/bin/env node
/**
 * ============================================================================
 *  D1 lista para desplegar SIN pasos manuales (pensado para el build de CI)
 * ============================================================================
 *  Hace, en orden y de forma idempotente:
 *    1. Si la config YA tiene un database_id real → no toca nada.
 *    2. Si sigue el UUID de relleno: busca la base `amigosecreto` en la cuenta
 *       (`wrangler d1 list`) y, si no existe, la crea (región D1_LOCATION|weur).
 *    3. Fija el database_id en wrangler.jsonc y wrangler.toml (reutiliza
 *       tools/d1-configure.mjs: una sola implementación).
 *    4. Aplica schema.sql en esa base (lleva IF NOT EXISTS ⇒ se puede repetir).
 *
 *  Uso:
 *    npm run db:ensure                 # local (requiere `wrangler login`)
 *    npm run db:ensure -- --check      # solo informa; no toca nada ni pide auth
 *    Build command del dashboard → `npm run db:ensure`   (el build ya está
 *    autenticado por Cloudflare, así que aquí no hace falta login)
 * ============================================================================
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCATION = process.env.D1_LOCATION || "weur";
const checkOnly = process.argv.includes("--check");

/* El binario local de wrangler, con `npx` como respaldo. */
const WRANGLER = existsSync("node_modules/.bin/wrangler")
  ? "node_modules/.bin/wrangler"
  : "npx";

function wrangler(args, { json = false } = {}) {
  const command = WRANGLER === "npx" ? ["wrangler", ...args] : args;
  const output = execFileSync(WRANGLER, command, {
    encoding: "utf8",
    stdio: json ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "pipe"],
  });
  return output;
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

/* ---------------------------- 1. estado del config ---------------------------- */
const jsonc = readFileSync("wrangler.jsonc", "utf8");
const currentId = (/"database_id":\s*"([^"]*)"/.exec(jsonc) || [])[1];
const currentName = (/"database_name":\s*"([^"]*)"/.exec(jsonc) || [])[1] || "amigosecreto";

if (!currentId) fail("No he encontrado d1_databases en wrangler.jsonc.");

const configured = UUID.test(currentId) && currentId !== PLACEHOLDER;

if (checkOnly) {
  console.log(`database_name : ${currentName}`);
  console.log(`database_id   : ${currentId}`);
  console.log(`estado        : ${configured ? "✓ configurado" : "✗ sigue el UUID de relleno"}`);
  process.exit(configured ? 0 : 1);
}

if (configured) {
  console.log(`✓ La config ya apunta a una base real (${currentId}).`);
} else {
  console.log(`ℹ La config trae el UUID de relleno: buscando/creando la base "${currentName}"…`);

  /* ------------------- 2. buscar la base (o crearla) en la cuenta ------------------- */
  let databases = [];
  try {
    databases = JSON.parse(wrangler(["d1", "list", "--json"], { json: true }) || "[]");
  } catch (error) {
    const detail = `${error?.stderr ?? ""}${error?.message ?? ""}`;
    if (/not authenticated|CLOUDFLARE_API_TOKEN|non-interactive/i.test(detail)) {
      fail(
        "No hay sesión de Cloudflare en este entorno.\n" +
          "  · En tu máquina:  npx wrangler login   y vuelve a intentarlo\n" +
          "  · En el build del dashboard no hace falta: Cloudflare ya lo autentica"
      );
    }
    fail(`No pude listar las bases D1: ${detail.split("\n").find((line) => line.trim()) ?? detail}`);
  }

  const existing = databases.find((database) => database.name === currentName);
  if (existing) {
    console.log(`✓ Ya existía la base "${currentName}" (${existing.uuid}).`);
  } else {
    console.log(`ℹ Creando la base "${currentName}" en la región ${LOCATION.toUpperCase()}…`);
    try {
      wrangler(["d1", "create", currentName, "--location", LOCATION]);
    } catch (error) {
      fail(`No pude crear la base: ${error?.stderr ?? error?.message ?? error}`);
    }
    databases = JSON.parse(wrangler(["d1", "list", "--json"], { json: true }) || "[]");
  }

  const database = databases.find((candidate) => candidate.name === currentName);
  if (!database?.uuid) fail(`No encuentro la base "${currentName}" después de crearla.`);

  /* ---------------------- 3. fijar el ID en las DOS configs ---------------------- */
  execFileSync("node", ["tools/d1-configure.mjs", database.uuid, currentName], {
    stdio: "inherit",
  });
}

/* ------------------------- 4. esquema (idempotente) ------------------------- */
console.log("\nℹ Aplicando schema.sql en la base remota…");
try {
  wrangler(["d1", "execute", currentName, "--remote", "--file=schema.sql"]);
} catch (error) {
  fail(
    `No pude aplicar el esquema: ${error?.stderr ?? error?.message ?? error}\n` +
      "  (si acabas de crear la base, espera unos segundos y reintenta)"
  );
}

console.log("\n✅ D1 lista: esquema aplicado y configs al día.");
console.log("   Siguiente: los secretos ADMIN_PASSWORD y ADMIN_SECRET, y desplegar.");
