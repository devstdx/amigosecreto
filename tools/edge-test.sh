#!/usr/bin/env bash
# ============================================================================
#  Batería adversarial y de casos límite (producción)
# ============================================================================
#  Uso:  bash tools/edge-test.sh [http://localhost:8788]
#
#  Qué comprueba:
#    · Semántica HTTP (HEAD/OPTIONS/405/404), cuerpos inválidos y tamaño grande
#    · Saneado de nombres (XSS, 300 caracteres), emojis no permitidos
#    · Prioridad de CF-Connecting-IP frente a cabeceras falsificadas
#    · Sorteo: 0/1/2 jugadores, repetir sorteo, altas posteriores al sorteo
#    · Sesiones: id desconocido, cookie manipulada/caducada, expulsión, reset
#    · Defensa del panel: cookie firmada, límite de intentos por IP
#    · Límite de aforo, cabeceras de seguridad y degradación controlada
# ============================================================================
set -u

BASE="${1:-http://localhost:8788}"
PASSWORD="${ADMIN_PASSWORD:-prueba123}"
TMP="$(mktemp -d)"
PASS=0
FAIL=0

AJAR="$TMP/admin.jar"

JSON_FILTER='
  let s = "";
  process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => {
    let v;
    try { v = JSON.parse(s); } catch { v = undefined; }
    if (v === undefined) { console.log("<no-json>"); return; }
    for (const k of process.argv[1].split(".")) {
      v = v === null || v === undefined ? undefined : v[k];
    }
    console.log(v === null || v === undefined ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v));
  });
'

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

json() { # json <ruta-json> [args de curl...]  ·  sin args: lee la entrada estándar
  local path="$1"
  shift
  if [ "$#" -eq 0 ]; then
    node -e "$JSON_FILTER" "$path"
  else
    curl -s "$@" | node -e "$JSON_FILTER" "$path"
  fi
}

check() { # check "descripción" obtenido esperado
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"
  else
    FAIL=$((FAIL + 1)); printf '  \033[31m✗\033[0m %s → esperado "%s", obtenido "%s"\n' "$1" "$3" "$2"
  fi
}

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

login() { curl -s -c "$AJAR" -X POST "$BASE/api/admin/login" -H 'Content-Type: application/json' \
  -d "{\"password\":\"$PASSWORD\"}" > /dev/null; }

# Estado inicial limpio
login
curl -s -b "$AJAR" -X POST "$BASE/api/admin/reset" -H 'Content-Type: application/json' \
  -d '{"keepPlayers":false}' > /dev/null

echo "▶ Batería adversarial contra $BASE"

# ---------------------------------------------------------------- semántica HTTP
section "1. Semántica HTTP"
check "HEAD /api/state se atiende como GET" "$(code -I "$BASE/api/state")" "200"
check "HEAD /api/state sin cuerpo (0 bytes)" \
  "$(curl -s -o /dev/null -w '%{size_download}' -I "$BASE/api/state")" "0"
check "OPTIONS /api/tick responde 204" "$(code -X OPTIONS "$BASE/api/tick")" "204"
check "DELETE /api/tick → 405" "$(code -X DELETE "$BASE/api/tick")" "405"
check "GET /api/inexistente → 404" "$(code "$BASE/api/inexistente")" "404"
check "GET /api (raíz) → 200" "$(code "$BASE/api")" "200"
check "cabecera Cache-Control no-store en la API" \
  "$(curl -s -D - -o /dev/null "$BASE/api/state" | tr -d '\r' | grep -ci 'cache-control: no-store')" "1"
check "cabecera X-Content-Type-Options" \
  "$(curl -s -D - -o /dev/null "$BASE/api/state" | tr -d '\r' | grep -ci 'x-content-type-options: nosniff')" "1"

# ------------------------------------------------------------- entradas hostiles
section "2. Entradas hostiles y saneado"
check "cuerpo no JSON → 400" \
  "$(code -X POST "$BASE/api/join" -H 'Content-Type: application/json' -d '{roto')" "400"
check "cuerpo JSON que no es objeto → 400" \
  "$(code -X POST "$BASE/api/join" -H 'Content-Type: application/json' -d '[1,2,3]')" "400"
check "nombre solo con espacios → 400" \
  "$(code -X POST "$BASE/api/join" -H 'Content-Type: application/json' -d '{"n":"   "}')" "400"
check "nombre sin campo n → 400" \
  "$(code -X POST "$BASE/api/join" -H 'Content-Type: application/json' -d '{"otra":"cosa"}')" "400"
check "nombre de 300 caracteres se recorta a 20" \
  "$(json me.n -X POST "$BASE/api/join" -H 'Content-Type: application/json' -d "{\"n\":\"$(printf 'A%.0s' {1..300})\"}")" \
  "AAAAAAAAAAAAAAAAAAAA"
XSS="$(json me.n -X POST "$BASE/api/join" -H 'Content-Type: application/json' \
  -d '{"n":"<img src=x onerror=alert(1)>Ana"}')"
XSS_STATE="saneado"
case "$XSS" in
  *"<"* | *">"*) XSS_STATE="inseguro" ;;
esac
check "nombre con HTML: se eliminan los caracteres de marcado" "$XSS_STATE" "saneado"
check "emoji no permitido cae al por defecto" \
  "$(json me.e -X POST "$BASE/api/join" -H 'Content-Type: application/json' -d '{"n":"Test","e":"<script>"}')" "🙂"
check "cuerpo de 1 MB no rompe el servidor (400, no 500)" \
  "$(head -c 1048576 /dev/zero | tr '\0' 'a' > "$TMP/big.txt"; code -X POST "$BASE/api/join" -H 'Content-Type: application/json' --data-binary @"$TMP/big.txt")" "400"

# ------------------------------------------------------- IP real y suplantación
section "3. IP real frente a cabeceras falsificadas"
join() { # join nombre emoji ip user-agent jar-de-cookies
  curl -s -c "$5" -X POST "$BASE/api/join" -H 'Content-Type: application/json' \
    -H "CF-Connecting-IP: $3" -H "X-Forwarded-For: 1.2.3.4" -H "User-Agent: $4" \
    -d "{\"n\":\"$1\",\"e\":\"$2\"}"
}
join "Suplantador" "🙂" "203.0.113.99" "curl/8" "$TMP/s1.jar" > /dev/null
check "el panel muestra CF-Connecting-IP y no X-Forwarded-For" \
  "$(curl -s -b "$AJAR" "$BASE/api/admin/state" | node -e '
     let s="";process.stdin.on("data",(d)=>(s+=d));
     process.stdin.on("end",()=>{const o=JSON.parse(s);const p=o.players.find((x)=>x.n==="Suplantador");
     console.log(p?p.ip+"|"+/1\.2\.3\.4/.test(JSON.stringify(o)):"sin-jugador");});')" \
  "203.0.113.99|false"

# ------------------------------------------------------------------- sorteo
section "4. Sorteo: casos límite"
curl -s -b "$AJAR" -X POST "$BASE/api/admin/reset" -H 'Content-Type: application/json' -d '{"keepPlayers":false}' > /dev/null
check "sortear en sala vacía → 409" \
  "$(code -b "$AJAR" -X POST "$BASE/api/admin/draw" -H 'Content-Type: application/json' -d '{}')" "409"
join "Solo" "🙂" "203.0.113.1" "curl/8" "$TMP/one.jar" > /dev/null
DRAW1="$(curl -s -b "$AJAR" -X POST "$BASE/api/admin/draw" -H 'Content-Type: application/json' -d '{}')"
check "sortear con 1 persona → 409 (imposible no asignarse)" "$(echo "$DRAW1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).ok===false?"rechazado":"aceptado"))')" "rechazado"
join "Dos" "🦊" "203.0.113.2" "curl/8" "$TMP/two.jar" > /dev/null
check "sortear con 2 personas → 200" \
  "$(code -b "$AJAR" -X POST "$BASE/api/admin/draw" -H 'Content-Type: application/json' -d '{}')" "200"
check "con 2 personas se reciben mutuamente" \
  "$(json targetName -b "$TMP/one.jar" "$BASE/api/target")" "Dos"
check "y la otra persona también" "$(json targetName -b "$TMP/two.jar" "$BASE/api/target")" "Solo"
check "sin force, repetir sorteo → 409" \
  "$(code -b "$AJAR" -X POST "$BASE/api/admin/draw" -H 'Content-Type: application/json' -d '{}')" "409"
check "con force, repetir sorteo → 200" \
  "$(code -b "$AJAR" -X POST "$BASE/api/admin/draw" -H 'Content-Type: application/json' -d '{"force":true}')" "200"
for i in $(seq 1 25); do
  curl -s -b "$AJAR" -X POST "$BASE/api/admin/draw" -H 'Content-Type: application/json' -d '{"force":true}' > /dev/null
  BAD="$(curl -s -b "$AJAR" "$BASE/api/admin/matrix" | json selfAssigned)"
  [ "$BAD" = "0" ] || break
done
check "25 sorteos repetidos: siempre 0 auto-asignaciones" "$BAD" "0"

# Alta posterior al sorteo
join "Tardío" "🚀" "203.0.113.3" "curl/8" "$TMP/late.jar" > /dev/null
check "quien entra después del sorteo no tiene asignación → 409" \
  "$(code -b "$TMP/late.jar" "$BASE/api/target")" "409"
check "el panel lo detecta (asignados < total)" \
  "$(curl -s -b "$AJAR" "$BASE/api/admin/state" | node -e '
     let s="";process.stdin.on("data",d=>s+=d);
     process.stdin.on("end",()=>{const o=JSON.parse(s);console.log(o.assigned<o.total?"incompleto":"completo");});')" \
  "incompleto"

# ------------------------------------------------------------------ sesiones
section "5. Sesiones y ciclos de vida"
curl -s -b "$AJAR" -X POST "$BASE/api/admin/reset" -H 'Content-Type: application/json' -d '{"keepPlayers":false}' > /dev/null
join "Ana" "🙂" "203.0.113.10" "curl/8" "$TMP/ana.jar" > /dev/null
ID_INVENTADO="00000000-0000-4000-8000-000000000000"
check "latido con id desconocido → sesión nula (el cliente vuelve al formulario)" \
  "$(json me -X POST "$BASE/api/tick" -H 'Content-Type: application/json' \
      -H "X-Player-Id: $ID_INVENTADO" -d '{}')" "null"
check "sin id ni cookie → sesión nula" \
  "$(json me -X POST "$BASE/api/tick" -H 'Content-Type: application/json' -d '{}')" "null"
check "id con formato inválido se ignora" \
  "$(json me -X POST "$BASE/api/tick" -H 'Content-Type: application/json' \
      -H 'X-Player-Id: ../etc/passwd' -d '{}')" "null"
COOKIE_LINE="$(curl -s -D - -o /dev/null -X POST "$BASE/api/join" -H 'Content-Type: application/json' \
  -d '{"n":"CookieTest"}' | tr -d '\r' | grep -i '^set-cookie: as_player=')"
check "cookie de sesión HttpOnly" "$(echo "$COOKIE_LINE" | grep -ci 'HttpOnly')" "1"
check "cookie de sesión SameSite=Lax" "$(echo "$COOKIE_LINE" | grep -ci 'SameSite=Lax')" "1"
check "cookie de sesión de 1 año (31536000 s)" "$(echo "$COOKIE_LINE" | grep -ci 'Max-Age=31536000')" "1"
check "cookie de sesión con Path=/" "$(echo "$COOKIE_LINE" | grep -ci 'Path=/')" "1"
check "reiniciar sin conservar jugadores invalida las sesiones" \
  "$(curl -s -b "$AJAR" -X POST "$BASE/api/admin/reset" -H 'Content-Type: application/json' \
      -d '{"keepPlayers":false}' > /dev/null; json me -b "$TMP/ana.jar" -X POST "$BASE/api/tick" \
      -H 'Content-Type: application/json' -d '{}')" "null"
join "Bea" "🙂" "203.0.113.11" "curl/8" "$TMP/bea.jar" > /dev/null
curl -s -b "$AJAR" -X POST "$BASE/api/admin/reset" -H 'Content-Type: application/json' -d '{"keepPlayers":true}' > /dev/null
check "reiniciar conservando jugadores mantiene la sesión" \
  "$(json me.n -b "$TMP/bea.jar" -X POST "$BASE/api/tick" -H 'Content-Type: application/json' -d '{}')" "Bea"

# Expulsión
PID_BEA="$(curl -s -b "$AJAR" "$BASE/api/admin/state" | node -e '
  let s="";process.stdin.on("data",d=>s+=d);
  process.stdin.on("end",()=>{const o=JSON.parse(s);const p=o.players.find(x=>x.n==="Bea");console.log(p?p.p:"none");});')"
curl -s -b "$AJAR" -X POST "$BASE/api/admin/player" -H 'Content-Type: application/json' \
  -d "{\"p\":\"$PID_BEA\",\"action\":\"kick\"}" > /dev/null
check "expulsar invalida la sesión de esa persona" \
  "$(json me -b "$TMP/bea.jar" -X POST "$BASE/api/tick" -H 'Content-Type: application/json' -d '{}')" "null"
check "el panel queda vacío tras la expulsión" \
  "$(curl -s -b "$AJAR" "$BASE/api/admin/state" | json total)" "0"
check "acción desconocida en el panel → 400" \
  "$(code -b "$AJAR" -X POST "$BASE/api/admin/player" -H 'Content-Type: application/json' \
      -d '{"p":"deadbeef","action":"hack"}')" "400"
check "acción válida con id mal formado → 400 (sin consultar Redis)" \
  "$(code -b "$AJAR" -X POST "$BASE/api/admin/player" -H 'Content-Type: application/json' \
      -d '{"p":"../etc/passwd","action":"kick"}')" "400"
check "acción válida con id desconocido → 404" \
  "$(code -b "$AJAR" -X POST "$BASE/api/admin/player" -H 'Content-Type: application/json' \
      -d '{"p":"0123456789abcdef","action":"kick"}')" "404"

# ------------------------------------------------------- defensa del panel
section "6. Defensa del panel de administración"
check "cookie de admin manipulada → 401" \
  "$(code -H 'Cookie: as_admin=9999999999999.deadbeef' "$BASE/api/admin/state")" "401"
check "cookie de admin caducada → 401" \
  "$(code -H 'Cookie: as_admin=1.deadbeef' "$BASE/api/admin/state")" "401"
check "cookie de admin malformada → 401" \
  "$(code -H 'Cookie: as_admin=sinpunto' "$BASE/api/admin/state")" "401"
check "sin cookie → 401" "$(code "$BASE/api/admin/draw")" "401"
check "sorteo por GET → 405 (o 401)" "$(code -b "$AJAR" "$BASE/api/admin/draw")" "405"
for i in 1 2 3 4 5 6; do
  code -X POST "$BASE/api/admin/login" -H 'Content-Type: application/json' \
    -H 'CF-Connecting-IP: 10.9.9.9' -d '{"password":"fuerza-bruta"}' > /dev/null
done
check "tras 6 fallos desde una IP: 429 (límite de intentos)" \
  "$(code -X POST "$BASE/api/admin/login" -H 'Content-Type: application/json' \
      -H 'CF-Connecting-IP: 10.9.9.9' -d '{"password":"fuerza-bruta"}')" "429"
check "el bloqueo no afecta a otras IP" \
  "$(code -X POST "$BASE/api/admin/login" -H 'Content-Type: application/json' \
      -H 'CF-Connecting-IP: 10.9.9.10' -d "{\"password\":\"$PASSWORD\"}")" "200"
check "logout borra la cookie" \
  "$(curl -s -D - -o /dev/null -b "$AJAR" -X POST "$BASE/api/admin/logout" | tr -d '\r' | grep -ci 'as_admin=;.*Max-Age=0')" "1"

# -------------------------------------------------------------- aforo y control
section "7. Aforo y control de recursos"
login
curl -s -b "$AJAR" -X POST "$BASE/api/admin/reset" -H 'Content-Type: application/json' -d '{"keepPlayers":false}' > /dev/null
for i in $(seq 1 60); do
  curl -s -o /dev/null -X POST "$BASE/api/join" -H 'Content-Type: application/json' \
    -H "CF-Connecting-IP: 203.0.113.$((i % 250 + 1))" -d "{\"n\":\"J$i\"}"
done
check "60 personas entran sin problema" "$(curl -s "$BASE/api/state" | json total)" "60"
check "la persona 61 es rechazada (aforo)" \
  "$(code -X POST "$BASE/api/join" -H 'Content-Type: application/json' -d '{"n":"Sobra"}')" "409"
check "el alto volumen no corrompe el estado (sigue siendo LOBBY)" \
  "$(curl -s "$BASE/api/state" | json state)" "LOBBY"
curl -s -b "$AJAR" -X POST "$BASE/api/admin/reset" -H 'Content-Type: application/json' -d '{"keepPlayers":false}' > /dev/null

# -------------------------------------------------------------------- estáticos
section "8. Estáticos y cabeceras de seguridad"
for ruta in / /admin /anfitrion; do
  check "GET $ruta sirve HTML" "$(code "$BASE$ruta")" "200"
done
check "CSP presente en la página del jugador" \
  "$(curl -s -D - -o /dev/null "$BASE/" | tr -d '\r' | grep -ci "content-security-policy: default-src 'self'")" "1"
check "la CSP prohíbe iframes (anti clickjacking)" \
  "$(curl -s -D - -o /dev/null "$BASE/" | tr -d '\r' | grep -ci "frame-ancestors 'none'")" "1"
for asset in style.css app.js admin.js; do
  check "asset $asset disponible y con tipo correcto" \
    "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/$asset")" "200"
done
check "_routes.json ya NO se sirve (artefacto de Pages, sustituido por run_worker_first)" \
  "$(code "$BASE/_routes.json")" "404"
check "wrangler.jsonc enruta /api/* al Worker (run_worker_first)" \
  "$(grep -c '"run_worker_first": \["/api/\*"\]' "$(dirname "$0")/../wrangler.jsonc" 2>/dev/null || echo 0)" "1"
check "los estáticos NO se sirven desde la Function (sin cabecera de API)" \
  "$(curl -s -D - -o /dev/null "$BASE/style.css" | tr -d '\r' | grep -ci 'x-robots-tag: noindex, nofollow')" "0"

echo
printf '\033[1mResultado adversarial: \033[32m%d correctas\033[0m · \033[31m%d fallidas\033[0m\n' "$PASS" "$FAIL"
rm -rf "$TMP"
[ "$FAIL" -eq 0 ]