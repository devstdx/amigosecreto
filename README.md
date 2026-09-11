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

## 🧪 Pruebas

```bash
npm run mock &                                  # terminal 1: mock de Upstash
npm run dev &                                   # terminal 2: runtime de Cloudflare
npm test                                        # 29 comprobaciones end-to-end
```

`tools/smoke-test.sh` verifica: configuración, altas, IP y dispositivo reales,
presencia (en pantalla / inactivo / desconectado), login del panel, sorteo,
**0 auto-asignaciones**, reparto por persona, persistencia de sesión,
emojis (panel y jugador), reinicio de ronda y el derangement a escala.

**Checklist manual en el móvil** (tras desplegar):

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
| `Falta la configuración de Upstash…` (500) | Variables no definidas en el proyecto | `npx wrangler pages secret put …` o Settings → Environment variables (Production **y** Preview) |
| `No se pudo conectar con el almacén de datos` (503) | URL/token de Upstash incorrectos o base borrada | Revisa las credenciales REST en la consola de Upstash |
| `El servidor no tiene configurados ADMIN_PASSWORD y ADMIN_SECRET` | Faltan secretos del panel | Defínelos y vuelve a desplegar |
| El panel no entra y no da error | Cookie bloqueada (modo privado / WebView) | Abre en el navegador normal; la sesión del jugador ya tiene triple respaldo |
| La sala aparece vacía tras días | TTL de inactividad (30 días) | `ROOM_TTL_DAYS` o simplemente vuelve a entrar |
| Nombre de proyecto ocupado al desplegar | `amigo-secreto` ya existe | `--project-name otro-nombre` y actualiza `name` en `wrangler.toml` |

---

## 📌 Historial

- **v1.0.0** — Reescritura monolítica para Cloudflare Pages: sala única, sesión
  persistente (cookie + localStorage), panel de administración (IP, dispositivo,
  presencia, emojis, sorteo y auditoría), salida de Next.js/Tailwind/React
  (cero build, cero dependencias en runtime) y backend en una sola Pages
  Function con Upstash REST. La versión mult-isala anterior queda en el
  historial de git.

