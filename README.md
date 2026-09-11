# 🎁 Amigo Secreto — sala única + panel de administración

Aplicación **monolítica** para un grupo pequeño (familia, amigos, oficina):
**una sola sala**, sin códigos ni QR que rotan. Cada persona entra una vez con su
nombre y su emoji, y su sesión **se conserva durante un año** aunque cierre el
navegador o apague el móvil. El anfitrión sortea desde un **panel privado** con
IP, dispositivo y estado (en pantalla / inactivo / desconectado) de cada persona.

Diseño **blanco y negro**, móvil primero, sin frameworks en el cliente:
funciona en cualquier WebView (iOS 10+ / Android 5+) y la primera pintura llega
en menos de un segundo, incluso en 3G.

---

## 🧱 Arquitectura (cero build, cero frameworks)

```
src/
  worker.ts       BACKEND COMPLETO (1 archivo): router + dominio + capa de datos
                  D1 (SQL) + sesiones + panel admin + adaptador
                  `export default { fetch }` de Workers. Sin dependencias npm
                  (D1 + Web Crypto), sin nodejs_compat ⇒ 31,6 KiB (9,1 KiB gzip).

schema.sql        Esquema de D1 (3 tablas). Idempotente: se puede reaplicar sin
                  miedo en local y en remoto.

public/           Assets servidos por el CDN (el Worker NO se invoca para ellos)
  index.html      Vista del jugador (nombre + emoji → espera → revelación)
  admin.html      Panel del anfitrión (login, lista en vivo, sortear, matriz)
  app.js          Lógica del jugador  (vanilla JS, sin dependencias)
  admin.js        Lógica del panel    (vanilla JS, sin dependencias)
  style.css       Estilos blanco y negro, compatibles con móviles antiguos
  _headers        Cabeceras de seguridad + CSP (soportadas en Workers assets)
  _redirects      /admin y /anfitrion (extensionless)

functions/
  api/[[path]].ts Shim de 3 líneas para desplegar TAMBIÉN en Pages (respaldo).
                  Toda la lógica vive en src/worker.ts: cero duplicación.

wrangler.toml     Config OFICIAL de **Pages** (nombre estándar: `wrangler pages`
                  no admite --config con rutas propias) → pages_build_output_dir
                  + binding D1 "DB"
wrangler.jsonc    Config alternativa de **Workers** (conviven sin conflicto):
                  main + assets + run_worker_first + binding D1

tools/            4 baterías de prueba automatizadas (ver más abajo)
```

**Almacenamiento: Cloudflare D1 (SQLite)** — sin cuentas ni credenciales extra:

| Tabla | Contenido |
|---|---|
| `room_state` | 1 fila (`id='main'`): `state` LOBBY/DRAWN, `round`, `drawn_at` |
| `players` | 1 fila por persona: nombre, emoji, IP, UA, entrada, último latido, visibilidad |
| `assignments` | 1 fila por persona: `giver_id → target_id` (**SOLO servidor**) |

Reglas de diseño: todo se lee en **un solo `batch`** (1 ida y vuelta); el latido es
un **UPDATE de una fila** (sin carreras al entrar varios a la vez); el sorteo es un
**`batch` atómico** (borrar + insertar + cambiar estado: nunca queda a medias).

---

## 🚀 Despliegue en producción (Cloudflare **Pages** + **D1**)

```bash
# 1) Dependencias y variables locales (la base de datos no necesita credenciales)
cp .dev.vars.example .dev.vars
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → ADMIN_SECRET
npm install

# 2) Base de datos LOCAL (SQLite simulado) y prueba con el runtime real
npm run db:local           # aplica schema.sql a la D1 local
npm run dev                # wrangler pages dev public → http://localhost:8788 · /admin

# 3) Autenticarse (abre el navegador), crear la base y el proyecto
npx wrangler login
npm run db:create          # imprime el database_id → pégalo en wrangler.toml Y wrangler.jsonc
npm run db:remote          # aplica schema.sql en la D1 de producción
npx wrangler pages project create amigosecreto --production-branch main

# 4) Secretos de producción (solo dos)
npx wrangler pages secret put ADMIN_PASSWORD --project-name amigosecreto
npx wrangler pages secret put ADMIN_SECRET   --project-name amigosecreto
# (o de golpe:  npx wrangler pages secret bulk secrets.json --project-name amigosecreto)

# 5) ¡A producción!
npm run deploy             # wrangler pages deploy public
#    → https://amigosecreto.pages.dev   ·   /admin
```

Verificado en local antes de subir (mismo bundle que producción):

```bash
npm run verify                                     # 29 + 67 comprobaciones
BASE=https://amigosecreto.pages.dev ADMIN_PASSWORD=… npm test
```

> ℹ️ Si al probar `https://<proyecto>.pages.dev/api/state` responde
> `Falta el binding de D1…`, añade el binding a mano en el dashboard:
> **Workers & Pages → tu proyecto → Settings → Functions → D1 database bindings**
> → *Production*: variable `DB`, base `amigosecreto` (repite en *Preview* si la
> quieres) y vuelve a desplegar. El config ya lo declara, así que solo hace falta
> si la subida directa no lo aplicara.

**Alternativa: Cloudflare Workers** (la misma app, un solo comando). Su config
convive en `wrangler.jsonc`, así que no hay que tocar nada:

```bash
npm run dev:workers        # local en :8788
npm run deploy:workers     # wrangler deploy → https://amigosecreto.<sub>.workers.dev
npx wrangler secret put ADMIN_PASSWORD     # (y ADMIN_SECRET)
```

**CI/CD opcional**: dashboard → *Settings → Builds* → conecta el repo
`devstdx/amigosecreto` (deploy automático en cada push a `main`; los secretos
viven en Cloudflare, nunca en el repo). **Rollback**: dashboard → *Deployments →
Rollback*.

| Configuración | Obligatoria | Descripción |
| --- | --- | --- |
| `DB` (binding D1) | sí | Ya declarado en `wrangler.jsonc` → `d1_databases` |
| `ADMIN_PASSWORD` | sí (secret) | Contraseña del panel `/admin` |
| `ADMIN_SECRET` | sí (secret) | Firma las cookies (HMAC-SHA256) y los pseudónimos |
| `ROOM_ID` | no | Id de la sala (por defecto `main`) |
| `ROOM_TTL_DAYS` | no | Días tras los que se purga a quien no vuelve (30) |
| `TICK_MS` / `ADMIN_TICK_MS` / `HEARTBEAT_MS` | no | Frecuencias (afectan a las filas escritas) |
| `DEBUG_USAGE` | no | Solo pruebas: expone `/api/admin/usage` |


---

## 🔌 API

| Método | Ruta | Auth | Descripción |
| --- | --- | --- | --- |
| `GET` | `/api/config` | pública | Emojis, mínimo de jugadores e intervalos |
| `POST` | `/api/join` | pública | `{ n, e }` → registra y fija la cookie de sesión (1 año) |
| `POST` | `/api/tick` | sesión | `{ v, e }` → latido + estado de la sala (polling cada 2 s) |
| `GET` | `/api/state` | pública | Estado sin latido (diagnóstico) |
| `GET` | `/api/target` | sesión | **Solo** el nombre/emoji de tu amigo secreto |
| `POST` | `/api/admin/login` | — | `{ password }` → cookie firmada (30 días) |
| `POST` | `/api/admin/logout` | — | Cierra la sesión del panel |
| `GET` | `/api/admin/state` | admin | Lista completa (IP, dispositivo, presencia, tiempos) |
| `POST` | `/api/admin/draw` | admin | Sortea a todos (`{ force }` permite repetir) |
| `POST` | `/api/admin/reset` | admin | `{ keepPlayers }` → vuelve al lobby |
| `POST` | `/api/admin/player` | admin | `{ p, action: emoji_next \| emoji_prev \| kick }` |
| `GET` | `/api/admin/matrix` | admin | Auditoría del sorteo (pares + auto-asignaciones) |

---

## 🔐 Seguridad y decisiones de diseño

- **Nadie se asigna a sí mismo, por construcción.** El sorteo baraja los ids con
  Fisher–Yates (entropía del sistema, sin sesgo de módulo) y aplica un **shift
  circular**: `asignado[i] = barajado[(i + 1) mod n]`. Es un *derangement*
  perfecto para cualquier `n ≥ 2`, en `O(n)`, sin reintentos ni fallos posibles.
  El panel incluye **«Ver matriz»** para auditarlo en vivo (0 auto-asignaciones);
  el smoke test lo comprueba con 20.000 sorteos.
- **La matriz no sale nunca del servidor**: cada persona solo puede consultar su
  propia fila y solo cuando toca el botón de revelar.
- **Sesión que no se pierde**: id (UUID v4, 122 bits) en cookie `HttpOnly`
  `SameSite=Lax` de 1 año, más copia en `localStorage` y cabecera `X-Player-Id`
  como respaldo (navegadores in-app que bloquean cookies).
- **El id real nunca se expone**: hacia fuera se usa un pseudónimo FNV-1a de 16
  hex chars derivado de un secreto (estable y no reversible).
- **IP real**: `CF-Connecting-IP` (Cloudflare lo fija y no es falsificable);
  en local cae a `X-Forwarded-For`.
- **Panel protegido**: contraseña comparada en tiempo constante (HMAC-SHA256),
  cookie firmada con HMAC, `SameSite=Strict`, retardo de 400 ms y límite de
  intentos por IP.
- **Render seguro**: todo el texto se pinta con `textContent` (nunca
  `innerHTML`) y el nombre se sanea en el servidor (sin `<`, `>`, `"`, `/`, …,
  máximo 20 caracteres contando emojis). CSP estricta en las páginas.
- **Presencia sin cron**: el estado se calcula al leer (`online` < 15 s y
  visible, `idle` sin foco, `offline` ≥ 60 s).
- **Coste controlado**: el latido escribe como máximo cada 10 s (aunque el
  cliente pulse cada 2 s) y toda lectura es **un solo `batch`**. Medido: ~48.700
  lecturas y ~1.060 escrituras por persona·hora ⇒ una sesión de 3 h con 12
  personas usa el **35 %** y el **38 %** del cupo diario gratuito de D1.
- **`assets.run_worker_first: ["/api/*"]`** (antes `_routes.json`, que era de
  Pages): solo la API invoca al Worker; los estáticos los sirve el CDN sin coste
  de invocación.

---

## 🧪 Verificación y pruebas

> ⚠️ Las suites comparten la **sala única**, así que deben ejecutarse **en serie**
> (nunca dos a la vez): los scripts `npm` ya lo hacen con `&&`.

```bash
npm run db:local        # aplica schema.sql a la D1 local (SQLite simulado)
npm run dev &           # runtime real de Cloudflare (workerd) en :8788

npm run verify          # typecheck + ids HTML/JS + 29 pruebas funcionales + 67 adversariales
npm run test:load       # carga: 12 personas, latencias y consumo real de D1
npm run test:failures   # fallos: sin binding D1, sin secretos, esquema ausente
npm run test            # solo las dos baterías de API (29 + 67)
```

| Suite | Qué cubre |
| --- | --- |
| `tools/smoke-test.sh` (29) | Camino feliz de punta a punta: altas, IP, dispositivo, presencia, sorteo, reparto, sesión persistente, emojis, reinicio, matriz válida y derangement a escala |
| `tools/edge-test.sh` (67) | Semántica HTTP (HEAD/OPTIONS/405/404), cuerpos inválidos y de 1 MB, saneado de nombres y XSS, emojis no permitidos, prioridad de `CF-Connecting-IP`, sorteo con 0/1/2 personas, altas posteriores al sorteo, sesiones invalidadas, expulsión, cookies manipuladas/caducadas, límite de intentos, aforo de 60, configs de Pages y Workers con su binding D1, cabeceras de seguridad y CSP |
| `tools/load-test.mjs` | 12 personas en paralelo durante N segundos: peticiones, errores, p50/p95/p99, auditoría del reparto y **filas leídas/escritas reales de D1** (midiendo el delta con `/api/admin/usage`) |
| `tools/failure-test.sh` (12) | Sin binding D1 (⇒ 500 con el mensaje exacto, sin trazas), sin `ADMIN_PASSWORD`/`ADMIN_SECRET` (⇒ 500 y las páginas siguen vivas), **esquema ausente** (⇒ 503 controlado sin filtrar errores de SQLite) y recuperación al restaurarlo |
| `tools/check-ids.mjs` | Cada `el("id")` del JS existe en su HTML (detecta erratas sin navegador) |

**Resultado de la última verificación (runtime real de Cloudflare, destino Pages):**

```
typecheck (tsc --noEmit)            ✓ sin errores
check:ids                           ✓ 16 + 23 ids presentes
smoke-test                          ✓ 29 correctas · 0 fallidas
edge-test                           ✓ 67 correctas · 0 fallidas
load-test (12 personas)             ✓ 389 peticiones · 0 errores · draw válido · 12/12 objetivos
                                    ✓ 0 auto-asignaciones · matriz válida
failure-test                        ✓ 12 correctas · 0 fallidas
wrangler pages functions build      ✓ compila el mismo monolito para Pages
wrangler deploy --dry-run (Workers) ✓ 31,62 KiB (9,08 KiB gzip) · env.DB + env.ASSETS
```

### Consumo real de D1 (medido, no estimado)

D1 factura **por fila leída y por fila escrita** (5.000.000 lecturas y 100.000
escrituras al día en el plan gratuito). Medido con 12 personas latiendo cada 2 s:

| Métrica | Medido | % del cupo diario de una sesión de 3 h |
| --- | --- | --- |
| Lecturas por persona·hora | ~48.700 | — |
| Escrituras por persona·hora | ~1.060 | — |
| Sesión de 3 h (12 personas) | ~1,75 M lecturas · ~38.000 escrituras | **35 %** lecturas · **38 %** escrituras |

Optimización aplicada con esta medición en la mano: se quitó el índice sobre
`last_seen` (D1 suma +1 fila escrita por cada índice afectado, así que **duplicaba**
el coste de cada latido) y el latido se escribe cada 10 s en vez de cada 5 s
⇒ **escrituras 145 → 75 en la misma prueba (−48 %)**, sin afectar a la precisión de
la presencia (la ventana de "en pantalla" sigue en 15 s).

Los intervalos se ajustan **sin tocar código**: `TICK_MS`, `ADMIN_TICK_MS` y
`HEARTBEAT_MS` en `.dev.vars` (local) o `npx wrangler secret put`/dashboard
(producción).

### Checklist manual en el móvil (tras desplegar)

1. Abrir la URL, poner nombre y emoji → apareces en `/admin` con tu IP real.
2. Bloquear la pantalla → a los ~20 s el panel muestra *inactivo*.
3. Cerrar del todo el navegador y reabrir → entras **directo** a la espera.
4. Pulsar **Sortear a todos** → cada móvil vibra y muestra su tarjeta.
5. **Ver matriz** → 0 auto-asignaciones y reparto completo.
6. Añadir a alguien después del sorteo → el panel avisa y ofrece volver a sortear.


---

## 🧯 Solución de problemas

| Síntoma | Causa probable | Solución |
| --- | --- | --- |
| `Falta el binding de D1…` (**500**) | El `wrangler.jsonc` no tiene `d1_databases` o el binding no se llama `DB` | Añade el bloque `d1_databases` (te lo imprime `npm run db:create`) |
| `No se pudo conectar con el almacén de datos` (**503**) | Tablas ausentes o error persistente de D1 (tras 1 reintento automático) | `npm run db:remote` para (re)aplicar `schema.sql`; revisa los logs con `npx wrangler tail` |
| `El servidor no tiene configurados ADMIN_PASSWORD y ADMIN_SECRET` (**500**) | Faltan los secretos del panel | `npx wrangler secret put ADMIN_PASSWORD` y `ADMIN_SECRET` (las páginas siguen sirviéndose) |
| Todo funciona pero el sorteo dice *faltan personas* | Nadie dentro o solo 1 | Hacen falta **2 o más** personas (nadie puede asignarse a sí mismo con 1) |
| El panel no entra y no da error | Cookie bloqueada (modo privado / WebView) | Abre en el navegador normal; la sesión del jugador ya tiene triple respaldo |
| Se acerca al cupo diario de D1 | Muchas personas × muchas horas en el mismo día | Sube `HEARTBEAT_MS` (por defecto 10 s) y/o `TICK_MS`; el cupo se reinicia a diario |
| Jugadores de hace meses siguen en la lista | Sin TTL: se purgan solo si alguien vuelve a entrar | `ROOM_TTL_DAYS` (30 por defecto) o el botón **Reiniciar ronda → expulsar a todos** |
| `A worker with the name "amigosecreto" already exists` | Ya tienes ese Worker | Cambia `name` en `wrangler.jsonc` (o despliega con `--name otro`) |

---

## 📌 Historial

- **v1.4.0 — destino Pages oficial + revelado persistente**:
  - **UX**: al completar los 1,2 s el nombre **se queda a la vista** al soltar
    (antes se ocultaba) y aparece un botón *«Ocultar el nombre»*. Si el gesto se
    suelta antes de tiempo, se sigue ocultando (protección anti-miradas intacta).
  - Pages pasa a ser el destino oficial: su config vive en `wrangler.toml`
    (nombre estándar, porque `wrangler pages` **no admite** `--config` con rutas
    personalizadas) y la de Workers se queda en `wrangler.jsonc`. **Ambas
    conviven**: `npm run deploy` (Pages) y `npm run deploy:workers` (Workers).
  - Verificado sobre Pages con D1: **29 + 67 + 12** comprobaciones en verde.
- **v1.3.0 — almacenamiento en Cloudflare D1 (adiós a las cuentas externas)**:
  - `schema.sql` (3 tablas + claves compuestas) aplicado en local y en remoto con
    `wrangler d1 execute`; **sin credenciales**: la base es un binding.
  - Capa de datos reescrita sobre `db.batch`: **1 ida y vuelta** por lectura y
    **sorteo atómico** (borrar + insertar + cambiar estado, todo o nada).
  - El latido pasó a ser un `UPDATE` de una fila (sin carreras al entrar varios).
  - La matriz de auditoría y el objetivo propio salen en **una consulta con JOIN**.
  - Sin TTL de Redis: se purga a quien no vuelve (`ROOM_TTL_DAYS`) al entrar otro.
  - **Consumo medido** (12 personas × 3 h): 35 % de las lecturas y 38 % de las
    escrituras del cupo diario gratuito, tras quitar el índice de `last_seen`
    (−48 % de escrituras) y latir cada 10 s.
  - Verificación en el destino Workers: **29 + 65 + 12** comprobaciones en verde y
    `--dry-run` de 31,62 KiB con `env.DB` + `env.ASSETS`.
  - Se elimina el mock de Upstash (D1 se simula en local con SQLite).
- **v1.2.0 — migración a Cloudflare Workers y publicación en GitHub**:
  - `src/worker.ts` es ahora el backend único (mismo monolito + adaptador
    `export default { fetch }`); `functions/api/[[path]].ts` queda como shim de
    respaldo para Pages (cero duplicación, verificado que compila).
  - `wrangler.jsonc`: `main` + `assets.directory: ./public` +
    `assets.run_worker_first: ["/api/*"]` (sustituye a `_routes.json`, que era
    exclusivo de Pages y ya no se sirve).
  - `wrangler.toml` → `wrangler.pages.toml` (solo se usa con `--config`).
  - `_headers` añade protección de indexación para los previews `*.workers.dev`.
  - Scripts: `npm run dev` (`wrangler dev`), `npm run deploy` (`wrangler deploy`),
    `secrets`, `deploy:pages`. Preflight verificado: 31,88 KiB / 9,14 KiB gzip.
  - Baterías adaptadas a Workers (`wrangler dev --var`) · **63** casos adversariales.
  - Publicado en https://github.com/devstdx/amigosecreto
- **v1.1.0 — auditoría de producción**:
  - **Corregido un fallo grave**: los handlers async se devolvían **sin `await`**
    dentro del `try` del router, así que sus excepciones *no* llegaban al
    `catch` y Cloudflare respondía **500** en vez de `503`/`409`. Se arregló con
    `errorResponse()` + doble red de seguridad (try/catch en `onRequest`).
  - **Timeout de 5 s al upstream**: si Upstash se cuelga, la petición del
    invitado ya no espera indefinidamente (503 en 5 s) y el front reintenta.
  - **`HEAD` tratado como `GET`** (sin cuerpo): los monitores de disponibilidad
    ya no marcan el sitio como caído con un 405.
  - **Coste de Upstash reducido a la mitad** (−44 % medido): lectura pública de
    2 comandos en lugar de 4, un solo comando por latido (sin refrescar el TTL)
    e intervalos ajustables por entorno (`TICK_MS`, `ADMIN_TICK_MS`,
    `HEARTBEAT_MS`).
  - **Validación de entrada antes de tocar la base** en el panel (un `action`
    inválido devuelve 400 inmediato, sin gastar comandos ni devolver 404).
  - **Baterías nuevas**: 62 casos adversariales, carga con medición de coste,
    9 casos de fallo controlado y comprobación estática de ids HTML/JS.
- **v1.0.0** — Reescritura monolítica para Cloudflare Pages: sala única, sesión
  persistente (cookie + localStorage), panel de administración (IP, dispositivo,
  presencia, emojis, sorteo y auditoría), salida de Next.js/Tailwind/React
  (cero build, cero dependencias en runtime) y backend en una sola Pages
  Function con Upstash REST. La versión multi-sala anterior queda en el
  historial de git.

