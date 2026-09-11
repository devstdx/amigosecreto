#!/usr/bin/env node
/**
 * Comprobación estática: cada `el("id")` que usa el JS debe existir en su HTML.
 * Evita erratas silenciosas (elementos nulos) sin necesidad de navegador.
 */
import { readFileSync } from "node:fs";

const PAIRS = [
  ["public/app.js", "public/index.html"],
  ["public/admin.js", "public/admin.html"],
];

const idsUsed = (js) => {
  const found = new Set();
  const regex = /el\("([a-zA-Z0-9_-]+)"\)/g;
  let match;
  while ((match = regex.exec(js))) found.add(match[1]);
  return [...found].sort();
};

const idsPresent = (html) => {
  const found = new Set();
  const regex = /id="([a-zA-Z0-9_-]+)"/g;
  let match;
  while ((match = regex.exec(html))) found.add(match[1]);
  return found;
};

let failures = 0;
for (const [jsPath, htmlPath] of PAIRS) {
  const used = idsUsed(readFileSync(jsPath, "utf8"));
  const present = idsPresent(readFileSync(htmlPath, "utf8"));
  const missing = used.filter((id) => !present.has(id));
  if (missing.length) {
    failures += 1;
    console.log(`✗ ${jsPath} → ${htmlPath}: faltan ids: ${missing.join(", ")}`);
  } else {
    console.log(`✓ ${jsPath} → ${htmlPath}: ${used.length} ids, todos presentes`);
  }
}

process.exit(failures ? 1 : 0);
