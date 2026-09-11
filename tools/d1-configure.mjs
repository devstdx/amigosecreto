#!/usr/bin/env node
/**
 * ============================================================================
 *  Fija el `database_id` y el nombre de la base D1 en LAS DOS configs
 * ============================================================================
 *  Hay que hacerlo en los dos sitios porque:
 *    · wrangler.jsonc → lo usa el deploy de Workers (`npx wrangler deploy`)
 *    · wrangler.toml  → lo usa Cloudflare Pages (`wrangler pages deploy`)
 *
 *  Uso:
 *    node tools/d1-configure.mjs <database_id> [database_name]
 *    npm run db:configure -- 1a2b3c4d-5e6f-7890-abcd-ef1234567890
 *
 *  El `database_id` lo imprime `npx wrangler d1 create amigosecreto` o lo copias
 *  del dashboard (Workers & Pages → D1 → tu base → "Database ID").
 * ============================================================================
 */

import { readFileSync, writeFileSync } from "node:fs";

const [rawId, rawName = "amigosecreto"] = process.argv.slice(2);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!rawId || !UUID.test(rawId)) {
  console.error("✗ Falta el database_id (UUID) o tiene un formato raro.");
  console.error("  Uso: node tools/d1-configure.mjs <database_id> [database_name]");
  console.error("  Ejemplo: node tools/d1-configure.mjs 1a2b3c4d-5e6f-7890-abcd-ef1234567890");
  process.exit(2);
}

if (rawId === "00000000-0000-0000-0000-000000000000") {
  console.error("✗ Ese es el UUID de relleno: usa el de TU base de datos.");
  process.exit(2);
}

const targets = [
  { file: "wrangler.jsonc", id: /"database_id":\s*"[^"]*"/, name: /"database_name":\s*"[^"]*"/ },
  { file: "wrangler.toml", id: /database_id = "[^"]*"/, name: /database_name = "[^"]*"/ },
];

let changed = 0;
for (const target of targets) {
  let text;
  try {
    text = readFileSync(target.file, "utf8");
  } catch {
    console.error(`✗ No encuentro ${target.file}`);
    process.exit(1);
  }

  const before = text;
  /* Cada archivo tiene su formato: TOML (`clave = "valor"`) o JSONC (`"clave": "valor"`). */
  const isToml = target.file.endsWith(".toml");
  const idLine = isToml ? `database_id = "${rawId}"` : `"database_id": "${rawId}"`;
  const nameLine = isToml ? `database_name = "${rawName}"` : `"database_name": "${rawName}"`;
  text = before.replace(target.id, idLine).replace(target.name, nameLine);

  if (text === before) {
    console.error(`✗ En ${target.file} no he encontrado database_id/database_name (¿ya está puesto?).`);
    process.exit(1);
  }
  writeFileSync(target.file, text);
  changed += 1;
  console.log(`✓ ${target.file} → database_name="${rawName}" · database_id="${rawId}"`);
}

console.log(`\n${changed} archivos actualizados. Siguiente paso:`);
console.log("   npm run db:remote      # crea las tablas en la base de producción");
console.log("   npm run deploy         # o simplemente vuelve a lanzar el build (push / dashboard)");
