#!/usr/bin/env bash
# ============================================================================
#  Pruebas de FALLO controlado (degradación elegante en producción)
# ============================================================================
#  Uso:  bash tools/failure-test.sh
#
#  Simula los tres modos de fallo que se ven en producción:
#    1. Upstash inalcanzable      → 503 rápido (sin colgar al invitado)
#    2. Upstash que acepta y nunca responde (cuelgue) → 503 en ~5 s por timeout
#    3. Variables de entorno ausentes → 500 con mensaje claro (no una traza)
#  Y verifica el ajuste de coste TICK_MS por entorno.
#
#  No toca la instancia de desarrollo del 8788 ni el mock del 9999.
# ============================================================================
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRANGLER="$ROOT/node_modules/.bin/wrangler"
BLACKHOLE_PORT=9998
PORT_BLACKHOLES=8790
PORT_NOCONFIG=8791
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
  stop_port "$PORT_BLACKHOLES"
  stop_port "$PORT_NOCONFIG"
  [ -n "${BLACKHOLE_PID:-}" ] && kill "$BLACKHOLE_PID" 2>/dev/null
  if [ -f "$ROOT/.dev.vars.parked" ]; then mv "$ROOT/.dev.vars.parked" "$ROOT/.dev.vars"; fi
  sleep 1
}
trap cleanup EXIT

wait_ready() { # wait_ready <puerto> <log> [segundos]
  local port="$1" log="$2" limit="${3:-40}" waited=0
  while [ "$waited" -lt "$limit" ]; do
    if grep -q 'Ready on http' "$log" 2>/dev/null; then return 0; fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

echo "▶ Pruebas de fallo controlado"

# ------------------------------------------------- 1. upstream que nunca responde
node -e '
  const net = require("net");
  net.createServer((socket) => { /* acepta y nunca responde */ socket.on("error", () => {}); })
     .listen('"$BLACKHOLE_PORT"', "127.0.0.1", () => console.log("[blackhole] listo"));
' > /tmp/blackhole.log 2>&1 &
BLACKHOLE_PID=$!
sleep 1

( cd "$ROOT" && WRANGLER_SEND_METRICS=false nohup "$WRANGLER" pages dev public --port "$PORT_BLACKHOLES" \
    --binding UPSTASH_REDIS_REST_URL="http://127.0.0.1:$BLACKHOLE_PORT" \
    --binding UPSTASH_REDIS_REST_TOKEN=irrelevante \
    --binding ADMIN_PASSWORD=prueba123 \
    --binding ADMIN_SECRET=secreto-de-prueba \
    --binding TICK_MS=5000 > /tmp/wrangler-blackhole.log 2>&1 & )

if wait_ready "$PORT_BLACKHOLES" /tmp/wrangler-blackhole.log 45; then
  echo "  (instancia con upstream colgado lista en :$PORT_BLACKHOLES)"
  RESULT="$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 20 "http://127.0.0.1:$PORT_BLACKHOLES/api/state")"
  TIME="${RESULT##* }"
  check "upstream colgado → 503 (no cuelga al usuario)" "${RESULT%% *}" "503"
  check "responde por timeout (entre 4 y 8 s), no espera indefinidamente" \
    "$(node -e 'const t=Number(process.argv[1]);console.log(t>=4&&t<=8?"en-rango":"fuera ("+t+"s)")' "$TIME")" "en-rango"
  check "el ajuste TICK_MS por entorno llega al cliente" \
    "$(curl -s "http://127.0.0.1:$PORT_BLACKHOLES/api/config" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tickMs))')" \
    "5000"
else
  check "instancia con upstream colgado arranca" "no-arranco" "arranca"
fi
stop_port "$PORT_BLACKHOLES"

# ------------------------------------------------------- 2. Upstash inalcanzable
( cd "$ROOT" && WRANGLER_SEND_METRICS=false nohup "$WRANGLER" pages dev public --port "$PORT_NOCONFIG" \
    --binding UPSTASH_REDIS_REST_URL="http://127.0.0.1:9" \
    --binding UPSTASH_REDIS_REST_TOKEN=irrelevante \
    --binding ADMIN_PASSWORD=prueba123 \
    --binding ADMIN_SECRET=secreto-de-prueba > /tmp/wrangler-dead.log 2>&1 & )
if wait_ready "$PORT_NOCONFIG" /tmp/wrangler-dead.log 45; then
  RESULT="$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 10 "http://127.0.0.1:$PORT_NOCONFIG/api/state")"
  check "puerto cerrado → 503 inmediato" "${RESULT%% *}" "503"
  check "es rápido (menos de 3 s)" \
    "$(node -e 'const t=Number(process.argv[1]);console.log(t<3?"rapido":"lento ("+t+"s)")' "${RESULT##* }")" "rapido"
else
  check "instancia con puerto cerrado arranca" "no-arranco" "arranca"
fi
stop_port "$PORT_NOCONFIG"

# ------------------------------------------------- 3. sin variables de entorno
if [ -f "$ROOT/.dev.vars" ]; then mv "$ROOT/.dev.vars" "$ROOT/.dev.vars.parked"; fi
( cd "$ROOT" && WRANGLER_SEND_METRICS=false nohup "$WRANGLER" pages dev public --port "$PORT_NOCONFIG" > /tmp/wrangler-noconfig.log 2>&1 & )
if wait_ready "$PORT_NOCONFIG" /tmp/wrangler-noconfig.log 45; then
  check "sin Upstash configurado → 500 (no 503 ni traza)" \
    "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_NOCONFIG/api/state")" "500"
  check "el mensaje explica qué falta" \
    "$(curl -s "http://127.0.0.1:$PORT_NOCONFIG/api/state" | grep -ci 'UPSTASH_REDIS_REST_URL')" "1"
  check "sin ADMIN_PASSWORD/SECRET, el login del panel avisa → 500" \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT_NOCONFIG/api/admin/login" \
        -H 'Content-Type: application/json' -d '{"password":"x"}')" "500"
  check "las páginas estáticas siguen sirviéndose aunque falte la base" \
    "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_NOCONFIG/")" "200"
else
  check "instancia sin configuración arranca" "no-arranco" "arranca"
fi
stop_port "$PORT_NOCONFIG"

if [ -f "$ROOT/.dev.vars.parked" ]; then mv "$ROOT/.dev.vars.parked" "$ROOT/.dev.vars"; fi

echo
printf '\033[1mResultado de fallos: \033[32m%d correctas\033[0m · \033[31m%d fallidas\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
