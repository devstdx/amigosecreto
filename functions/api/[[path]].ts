/**
 * ============================================================================
 *  SHIM PARA CLOUDFLARE PAGES (opcional)
 * ============================================================================
 *  Toda la lógica vive en `src/worker.ts` (una sola copia, cero duplicación).
 *  Este archivo existe solo para poder desplegar TAMBIÉN en Pages si algún
 *  día conviene:
 *
 *     npx wrangler pages deploy public --config wrangler.pages.toml
 *
 *  El destino principal es Workers (`wrangler deploy`), que usa `main` y el
 *  export por defecto del Worker.
 * ============================================================================
 */

export { onRequest, default } from "../../src/worker";
