#!/usr/bin/env bash
# ============================================================================
#  Pruebas de FALLO controlado (degradación elegante) — versión D1
# ============================================================================
#  Uso:  bash tools/failure-test.sh
#
#  Con D1 ya no hay un proveedor externo que pueda caerse, así que se prueban
#  los fallos que SÍ pueden ocurrir en producción:
#    1. Falta el binding de D1        → 500 con mensaje que dice qué falta
#    2. Faltan ADMIN_PASSWORD/SECRET  → 500 claro (y las páginas siguen vivas)
#    3. Esquema ausente (tablas fuera) → 503 controlado, sin trazas al usuario
#
#  No toca la instancia de desarrollo del 8788 (usa puertos propios) y restaura
#  el esquema local al terminar.
# ============================================================================
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRANGLER="$ROOT/node_modules/.bin/wrangler"
PORT_NOBINDING=8790
PORT_NOSECRETS=8791
PASS=0
FAIL=0

check() {
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"
  else
    FAIL=$((FAIL + 1)); printf '  \033[31m✗\033[0m %s → esperado "%s", obtenido "%s"\n' "$1" "$3" "$2"
  fi
}

stop_port() { pkill -f -- "--port $1" 2>/dev/null || true; }

cleanup() {
  stop_port "$PORT_NOBINDING"
  stop_port "$PORT_NOSECRETS"
  if [ -f "$ROOT/.dev.vars.parked" ]; then mv "$ROOT/.dev.vars.parked" "$ROOT/.dev.vars"; fi
  rm -f "$ROOT/.tmp-nodb.jsonc"
  # Restaura el esquema local por si la prueba 3 lo dejó caído (idempotente).
  ( cd "$ROOT" && "$WRANGLER" d1 execute amigosecreto --local --file=schema.sql > /dev/null 2>&1 || true )
  sleep 1
}
trap cleanup EXIT

wait_ready() { # wait_ready <puerto> [segundos]  ·  sondea HTTP
  local port="$1" limit="${2:-60}" waited=0
  while [ "$waited" -lt "$limit" ]; do
    if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$port/"; then return 0; fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

echo "▶ Pruebas de fallo controlado (D1)"

# --------------------------------------------------- 1. sin binding de D1
cat > "$ROOT/.tmp-nodb.jsonc" <<'JSON'
{
  "name": "amigosecreto-nodb",
  "main": "src/worker.ts",
  "compatibility_date": "2026-09-01",
  "assets": { "directory": "./public", "run_worker_first": ["/api/*"] }
}
JSON
( cd "$ROOT" && WRANGLER_SEND_METRICS=false nohup "$WRANGLER" dev --config .tmp-nodb.jsonc --port "$PORT_NOBINDING" > /tmp/wrangler-nodb.log 2>&1 & )
if wait_ready "$PORT_NOBINDING" 60; then
  BODY="$(curl -s "http://127.0.0.1:$PORT_NOBINDING/api/state")"
  check "sin binding D1 → 500 (no una traza cruda)" \
    "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_NOBINDING/api/state")" "500"
  check "el mensaje dice exactamente qué falta" "$(echo "$BODY" | grep -ci 'binding de D1')" "1"
  check "no se filtran detalles internos" \
    "$(echo "$BODY" | grep -ci 'at async\|node_modules\|wrangler/')" "0"
  check "las páginas estáticas siguen sirviéndose" \
    "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_NOBINDING/")" "200"
else
  check "la instancia sin binding arranca" "no-arranco" "arranca"
fi
stop_port "$PORT_NOBINDING"

# -------------------------------------- 2. sin ADMIN_PASSWORD / ADMIN_SECRET
if [ -f "$ROOT/.dev.vars" ]; then mv "$ROOT/.dev.vars" "$ROOT/.dev.vars.parked"; fi
( cd "$ROOT" && WRANGLER_SEND_METRICS=false nohup "$WRANGLER" dev --port "$PORT_NOSECRETS" > /tmp/wrangler-nosecrets.log 2>&1 & )
if wait_ready "$PORT_NOSECRETS" 60; then
  check "sin secretos del panel → 500 (no 401 confuso)" \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT_NOSECRETS/api/admin/login" \
        -H 'Content-Type: application/json' -d '{"password":"x"}')" "500"
  check "el mensaje nombra las variables que faltan" \
    "$(curl -s -X POST "http://127.0.0.1:$PORT_NOSECRETS/api/admin/login" -H 'Content-Type: application/json' \
        -d '{"password":"x"}' | grep -ci 'ADMIN_PASSWORD')" "1"
  check "la app del jugador sigue viva (500 solo en el panel)" \
    "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_NOSECRETS/")" "200"
  check "el estado público aún responde (D1 está bien)" \
    "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_NOSECRETS/api/state")" "200"
else
  check "la instancia sin secretos arranca" "no-arranco" "arranca"
fi
stop_port "$PORT_NOSECRETS"
if [ -f "$ROOT/.dev.vars.parked" ]; then mv "$ROOT/.dev.vars.parked" "$ROOT/.dev.vars"; fi

# -------------------------------------------- 3. esquema ausente (tablas caídas)
( cd "$ROOT" && "$WRANGLER" d1 execute amigosecreto --local \
    --command 'DROP TABLE IF EXISTS assignments; DROP TABLE IF EXISTS players; DROP TABLE IF EXISTS room_state;' \
    > /dev/null 2>&1 )
RESULT="$(curl -s -w '\n%{http_code}' "http://127.0.0.1:8788/api/state")"
CODE="$(echo "$RESULT" | tail -1)"
BODY="$(echo "$RESULT" | sed '$d')"
check "esquema ausente → 503 controlado" "$CODE" "503"
check "con mensaje en español y sin trazas" \
  "$(echo "$BODY" | grep -ci 'almacén de datos')" "1"
check "el JSON no expone el error interno de SQLite" \
  "$(echo "$BODY" | grep -ci 'no such table\|SQLITE')" "0"
( cd "$ROOT" && "$WRANGLER" d1 execute amigosecreto --local --file=schema.sql > /dev/null 2>&1 )
check "el servicio se recupera al restaurar el esquema" \
  "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8788/api/state")" "200"

echo
printf '\033[1mResultado de fallos: \033[32m%d correctas\033[0m · \033[31m%d fallidas\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
