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
public/
  index.html      Vista del jugador (nombre + emoji → espera → revelación)
  admin.html      Panel del anfitrión (login, lista en vivo, sortear, matriz)
  app.js          Lógica del jugador  (vanilla JS, sin dependencias)
  admin.js        Lógica del panel    (vanilla JS, sin dependencias)
  style.css       Estilos blanco y negro, compatibles con móviles antiguos
  _routes.json    Pages Functions solo en /api/*  (ahorra invocaciones)
  _headers        Cabeceras de seguridad + CSP en los estáticos
  _redirects      /admin → /admin.html

functions/
  api/[[path]].ts BACKEND COMPLETO: router + dominio + Upstash REST + sesiones
                  + panel de administración. Sin dependencias npm (fetch + Web
                  Crypto), sin nodejs_compat ⇒ arranque mínimo.

tools/
  mock-upstash.mjs  Mock del REST de Upstash para probar sin credenciales
```

**Almacenamiento** (Upstash Redis, plan gratuito: 500K comandos/mes):

```
room:<id>:state      string  LOBBY | DRAWN
room:<id>:round      string  nº de ronda
room:<id>:drawnAt    string  epoch ms del último sorteo
room:<id>:players    hash    id_jugador -> {n,e,ip,ua,at,ls,v}   (JSON diminuto)
room:<id>:assign     hash    id_jugador -> id_objetivo  ← SOLO servidor
```

---

## 🚀 Despliegue en producción (Cloudflare Pages)

```bash
# 1) Base de datos gratis (2 min): https://console.upstash.com → Create Database
#    Copia UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN.

# 2) Variables locales y dependencias
cp .dev.vars.example .dev.vars
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → ADMIN_SECRET
npm install

# 3) Prueba local con el runtime real de Cloudflare
npm run mock  &            # (opcional) mock de Upstash si aún no tienes base
npm run dev                # http://localhost:8788  ·  /admin

# 4) Autenticarse y crear el proyecto (el login abre el navegador)
npx wrangler login
npx wrangler pages project create amigo-secreto --production-branch main

# 5) Secretos de producción (o en el dashboard: Settings → Environment variables)
npx wrangler pages secret put UPSTASH_REDIS_REST_URL   --project-name amigo-secreto
npx wrangler pages secret put UPSTASH_REDIS_REST_TOKEN --project-name amigo-secreto
npx wrangler pages secret put ADMIN_PASSWORD           --project-name amigo-secreto
npx wrangler pages secret put ADMIN_SECRET             --project-name amigo-secreto

# 6) ¡A producción!
npm run deploy             # → https://amigo-secreto.pages.dev  y  /admin
```

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `UPSTASH_REDIS_REST_URL` | sí | URL REST de Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | sí | Token REST de Upstash |
| `ADMIN_PASSWORD` | sí | Contraseña del panel `/admin` |
| `ADMIN_SECRET` | sí | Firma las cookies (HMAC-SHA256) y los pseudónimos |
| `ROOM_ID` | no | Id de la sala (por defecto `main`) |
| `ROOM_TTL_DAYS` | no | Días de inactividad antes de expirar (por defecto 30) |
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
- **Coste controlado**: el latido escribe como máximo cada 5 s (aunque el
  cliente pulse cada 2 s) y el estado se lee en **una sola petición HTTP** con
  pipeline (4 órdenes). Con 10 personas unas 3 h se consumen ~60-180 mil
  comandos de los 500 mil gratuitos al mes.
- **`_routes.json` limita las Functions a `/api/*`**: los estáticos no gastan
  invocaciones y se sirven del CDN.

---

## 🧪 Verificación y pruebas

> ⚠️ Las suites comparten la **sala única**, así que deben ejecutarse **en serie**
> (nunca dos a la vez): los scripts `npm` ya lo hacen con `&&`.

```bash
npm run mock &          # terminal 1: mock de Upstash con contador de comandos
npm run dev &           # terminal 2: runtime real de Cloudflare (workerd)

npm run verify          # typecheck + ids HTML/JS + 29 pruebas funcionales + 62 adversariales
npm run test:load       # carga: 12 personas, latencias y coste real de Upstash
npm run test:failures   # fallos: upstream colgado/caído, falta de configuración
npm run test            # solo las dos baterías de API (29 + 62)
```

| Suite | Qué cubre |
| --- | --- |
| `tools/smoke-test.sh` (29) | Camino feliz de punta a punta: altas, IP, dispositivo, presencia, sorteo, reparto, sesión persistente, emojis, reinicio, matriz válida y derangement a escala |
| `tools/edge-test.sh` (62) | Semántica HTTP (HEAD/OPTIONS/405/404), cuerpos inválidos y de 1 MB, saneado de nombres y XSS, emojis no permitidos, prioridad de `CF-Connecting-IP`, sorteo con 0/1/2 personas, altas posteriores al sorteo, sesiones invalidadas, expulsión, cookies manipuladas/caducadas, límite de intentos, aforo de 60, cabeceras de seguridad y CSP |
| `tools/load-test.mjs` | 12 personas en paralelo durante N segundos: peticiones, errores, p50/p95/p99, auditoría del reparto y **comandos facturables** de Upstash (midiendo el delta) |
| `tools/failure-test.sh` | Upstash que acepta y **nunca responde** (⇒ 503 en ~5 s por timeout), puerto cerrado (⇒ 503 inmediato), **sin variables de entorno** (⇒ 500 con mensaje claro) y el ajuste `TICK_MS` por entorno |
| `tools/check-ids.mjs` | Cada `el("id")` del JS existe en su HTML (detecta erratas sin navegador) |

**Resultado de la última verificación (runtime real de Cloudflare):**

```
typecheck (tsc --noEmit)            ✓ sin errores
check:ids                           ✓ 15 + 23 ids presentes
smoke-test                          ✓ 29 correctas · 0 fallidas
edge-test                           ✓ 62 correctas · 0 fallidas
load-test (12 personas)             ✓ 141 peticiones · 0 errores · p50 19 ms · p95 31 ms
                                    ✓ 12/12 objetivos · 0 auto-asignaciones · matriz válida
failure-test                        ✓ 9 correctas · 0 fallidas (503 en 5 s, 500 claro sin config)
```

### Coste real de Upstash (medido, no estimado)

Upstash factura **por comando**. Medido con 12 personas latiendo cada 2 s:

| Ajuste | Sensación | ~Comandos / persona·hora | Sesiones de 3 h al mes (plan gratis de 500.000) |
| --- | --- | --- | --- |
| `TICK_MS=2000` (por defecto) | instantáneo | ~5.800 | ~3 |
| `TICK_MS=4000` | rápido | ~4.100 | ~4,5 |
| `TICK_MS=6000` + `HEARTBEAT_MS=15000` | aceptable | ~2.400 | ~7 |

Los intervalos se cambian **sin tocar código** (variables de entorno del proyecto,
o `--binding TICK_MS=4000` en local). Para nuestro grupo (una sesión de vez en
cuando) el plan gratuito sobra; si empezáis a usarlo cada semana, sube `TICK_MS`.

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
| `No se pudo conectar con el almacén de datos` (**503**) | Upstash caído, URL/token erróneos, o **sin saldo** en el plan | Revisa las credenciales REST y el consumo del mes; la app se recupera sola al volver la conexión |
| La respuesta tarda ~5 s y luego 503 | Upstash acepta pero no responde | Es el **timeout de seguridad**: el invitado nunca se queda colgado; revisa el estado del proveedor |
| `Falta la configuración de Upstash…` (**500**) | Variables no definidas en el proyecto | `npx wrangler pages secret put …` o Settings → Environment variables (Production **y** Preview) |
| `El servidor no tiene configurados ADMIN_PASSWORD y ADMIN_SECRET` (**500**) | Faltan secretos del panel | Defínelos y vuelve a desplegar (las páginas siguen sirviéndose) |
| Todo funciona pero el sorteo dice *faltan personas* | Nadie dentro o solo 1 | Hacen falta **2 o más** personas (nadie puede asignarse a sí mismo con 1) |
| El panel no entra y no da error | Cookie bloqueada (modo privado / WebView) | Abre en el navegador normal; la sesión del jugador ya tiene triple respaldo |
| Empiezan a aparecer 503 al final del mes | Se agotaron los 500.000 comandos gratis | Sube `TICK_MS`/`HEARTBEAT_MS` (ver tabla de coste) o pasa a pago por uso (0,20 $/100K) |
| La sala aparece vacía tras días | TTL de inactividad (30 días) | `ROOM_TTL_DAYS` o simplemente vuelve a entrar |
| Nombre de proyecto ocupado al desplegar | `amigo-secreto` ya existe | `--project-name otro-nombre` y actualiza `name` en `wrangler.toml` |

---

## 📌 Historial

- **v1.1.0 — auditoría de producción** (esta pasada):
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

