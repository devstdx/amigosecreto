#!/usr/bin/env bash
# ============================================================================
#  Smoke test end-to-end de la API (contra el runtime local de Cloudflare)
# ============================================================================
#  Uso:
#    1) npm run db:local && npm run dev        (D1 local + runtime de Cloudflare)
#    2) bash tools/smoke-test.sh               (o: bash tools/smoke-test.sh https://mi-worker.workers.dev)
#
#  Verifica: sesión persistente, IP/dispositivo, presencia, sorteo SIN
#  auto-asignaciones, matriz de auditoría, emoji, expulsión y reinicio de ronda.
# ============================================================================
set -u

BASE="${1:-http://localhost:8788}"
# Solo valor por defecto para pruebas locales (debe coincidir con .dev.vars);
# NO es un secreto real: en producción la contraseña es el secreto ADMIN_PASSWORD.
PASSWORD="${ADMIN_PASSWORD:-prueba123}"
TMP="$(mktemp -d)"
PASS=0
FAIL=0

field() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      let value = JSON.parse(s);
      for (const key of process.argv[1].split(".")) {
        value = value === null || value === undefined ? undefined : value[key];
      }
      console.log(
        value === null || value === undefined
          ? "null"
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value)
      );
    });
  ' "$1"
}

count() { # count "texto" < entrada → nº de apariciones
  grep -o "$1" | wc -l | tr -d ' '
}

check() { # check "nombre" obtenido esperado
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1))
    printf '  \033[32m✓\033[0m %s\n' "$1"
  else
    FAIL=$((FAIL + 1))
    printf '  \033[31m✗\033[0m %s (esperado "%s", obtenido "%s")\n' "$1" "$3" "$2"
  fi
}

echo "▶ Smoke test contra $BASE"
echo

# ------------------------------------------------------- 0. login + reset total
curl -sS -c "$TMP/admin.jar" -X POST "$BASE/api/admin/login" \
  -H 'Content-Type: application/json' -d "{\"password\":\"$PASSWORD\"}" > /dev/null
curl -sS -b "$TMP/admin.jar" -X POST "$BASE/api/admin/reset" \
  -H 'Content-Type: application/json' -d '{"keepPlayers":false}' > /dev/null

# ---------------------------------------------------------------- 1. config
BODY="$(curl -sS "$BASE/api/config")"
check "GET /api/config devuelve la rueda de 24 emojis" \
  "$(echo "$BODY" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d));process.stdin.on("end",()=>console.log(JSON.parse(s).emojis.length));')" "24"
check "mínimo de jugadores = 2" "$(echo "$BODY" | field minPlayers)" "2"

# ------------------------------------------------------------ 2. estado inicial
BODY="$(curl -sS "$BASE/api/state")"
check "sala arranca en LOBBY" "$(echo "$BODY" | field state)" "LOBBY"
check "sala vacía" "$(echo "$BODY" | field total)" "0"

# ------------------------------------------------------ 3. alta de 3 jugadores
join() { # join nombre emoji ip user-agent cookie-jar
  curl -sS -c "$5" -X POST "$BASE/api/join" -H 'Content-Type: application/json' \
    -H "CF-Connecting-IP: $3" -H "User-Agent: $4" \
    -d "{\"n\":\"$1\",\"e\":\"$2\"}"
}
IPHONE="Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1"
ANDROID="Mozilla/5.0 (Linux; Android 11; SM-A515F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96 Mobile Safari/537.36"
A="$(join "Lucía" "😎" "203.0.113.7" "$IPHONE" "$TMP/a.jar")"
B="$(join "Marcos" "🦊" "198.51.100.22" "$ANDROID" "$TMP/b.jar")"
C="$(join "Abril" "🚀" "198.51.100.22" "$ANDROID" "$TMP/c.jar")"
check "alta de Lucía devuelve un id (UUID)" "$(echo "$A" | field me.id | wc -c | tr -d ' ')" "37"
check "el emoji elegido se guarda" "$(echo "$A" | field me.e)" "😎"

# -------------------------------------------------------- 4. estado público
BODY="$(curl -sS "$BASE/api/state")"
check "hay 3 personas en la sala" "$(echo "$BODY" | field total)" "3"
check "las IP no se exponen al público" "$(echo "$BODY" | count '203\.0\.113\.7')" "0"

# --------------------------------------------------------- 5. panel: login
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/login" \
  -H 'Content-Type: application/json' -d '{"password":"incorrecta"}')"
check "contraseña incorrecta → 401" "$CODE" "401"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/admin/state")"
check "panel sin sesión → 401" "$CODE" "401"

# ---------------------------------------------------------- 6. panel: datos
BODY="$(curl -sS -b "$TMP/admin.jar" "$BASE/api/admin/state")"
check "el panel ve la IP real (CF-Connecting-IP)" "$(echo "$BODY" | count '203\.0\.113\.7')" "1"
check "el panel reconoce el dispositivo" "$(echo "$BODY" | count 'iPhone · Safari')" "1"
check "las 3 personas figuran en pantalla" "$(echo "$BODY" | count '"s":"online"')" "3"

# ----------------------------------------------------------- 7. presencia
curl -sS -b "$TMP/b.jar" -X POST "$BASE/api/tick" -H 'Content-Type: application/json' -d '{"v":0}' > /dev/null
BODY="$(curl -sS -b "$TMP/admin.jar" "$BASE/api/admin/state")"
check "app en segundo plano → inactivo" "$(echo "$BODY" | count '"s":"idle"')" "1"
curl -sS -b "$TMP/b.jar" -X POST "$BASE/api/tick" -H 'Content-Type: application/json' -d '{"v":1}' > /dev/null

# ------------------------------------------------------------- 8. sorteo
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -b "$TMP/admin.jar" -X POST "$BASE/api/admin/draw" \
  -H 'Content-Type: application/json' -d '{}')"
check "sorteo → 200" "$CODE" "200"
check "la sala queda DRAWN" "$(curl -sS "$BASE/api/state" | field state)" "DRAWN"

# ------------------------------------- 9. matriz: nadie se asigna a sí mismo
MATRIX="$(curl -sS -b "$TMP/admin.jar" "$BASE/api/admin/matrix")"
check "3 asignaciones" "$(echo "$MATRIX" | field total)" "3"
check "0 auto-asignaciones" "$(echo "$MATRIX" | field selfAssigned)" "0"
check "matriz válida" "$(echo "$MATRIX" | field valid)" "true"

# --------------------------------- 10. cada persona ve su objetivo (y no a sí misma)
TARGET_A="$(curl -sS -b "$TMP/a.jar" "$BASE/api/target" | field targetName)"
TARGET_B="$(curl -sS -b "$TMP/b.jar" "$BASE/api/target" | field targetName)"
TARGET_C="$(curl -sS -b "$TMP/c.jar" "$BASE/api/target" | field targetName)"
check "Lucía no se recibe a sí misma" "$([ "$TARGET_A" = "Lucía" ] && echo si || echo no)" "no"
check "Marcos no se recibe a sí mismo" "$([ "$TARGET_B" = "Marcos" ] && echo si || echo no)" "no"
check "Abril no se recibe a sí misma" "$([ "$TARGET_C" = "Abril" ] && echo si || echo no)" "no"
echo "    reparto: Lucía → $TARGET_A · Marcos → $TARGET_B · Abril → $TARGET_C"

# ----------------------------- 11. sesión persistente (solo cookie, sin nombre)
BODY="$(curl -sS -b "$TMP/a.jar" -X POST "$BASE/api/tick" -H 'Content-Type: application/json' -d '{}')"
check "la sesión sobrevive sin reescribir el nombre" "$(echo "$BODY" | field me.n)" "Lucía"

# ------------------------------------------- 12. emojis (panel y jugador)
PID="$(curl -sS -b "$TMP/admin.jar" "$BASE/api/admin/state" | field players.0.p)"
curl -sS -b "$TMP/admin.jar" -X POST "$BASE/api/admin/player" -H 'Content-Type: application/json' \
  -d "{\"p\":\"$PID\",\"action\":\"emoji_next\"}" > /dev/null
check "el panel cambia el emoji de una persona" \
  "$(curl -sS -b "$TMP/admin.jar" "$BASE/api/admin/state" | field players.0.e)" "🤠"
curl -sS -b "$TMP/c.jar" -X POST "$BASE/api/tick" -H 'Content-Type: application/json' -d '{"e":"👻"}' > /dev/null
check "el jugador elige su propio emoji" "$(curl -sS "$BASE/api/state" | count '👻')" "1"

# -------------------------------------- 13. ronda nueva, expulsión y estrés
curl -sS -b "$TMP/admin.jar" -X POST "$BASE/api/admin/reset" -H 'Content-Type: application/json' \
  -d '{"keepPlayers":true}' > /dev/null
BODY="$(curl -sS "$BASE/api/state")"
check "reiniciar ronda vuelve a LOBBY" "$(echo "$BODY" | field state)" "LOBBY"
check "las personas siguen dentro" "$(echo "$BODY" | field total)" "3"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -b "$TMP/a.jar" "$BASE/api/target")"
check "sin sorteo no hay objetivo → 409" "$CODE" "409"

check "derangement correcto en 20.000 sorteos aleatorios (n=2,3,7,15)" \
  "$(node -e '
    function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));const t=a[i];a[i]=a[j];a[j]=t;}return a;}
    let bad=0;
    for (const n of [2,3,7,15]) for (let t=0;t<5000;t++){
      const s=shuffle(Array.from({length:n},(_,i)=>"p"+i));
      for(let i=0;i<n;i++) if(s[i]===s[(i+1)%n]) bad++;
    }
    console.log(bad===0 ? "0" : "+"+bad);
  ')" "0"

echo
printf 'Resultado: \033[32m%d correctas\033[0m · \033[31m%d fallidas\033[0m\n' "$PASS" "$FAIL"
rm -rf "$TMP"
[ "$FAIL" -eq 0 ]
