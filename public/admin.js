/* ============================================================================
   Amigo Secreto — panel del anfitrión
   ----------------------------------------------------------------------------
   · Login con contraseña (cookie httpOnly firmada con HMAC, 30 días).
   · Lista en vivo: emoji (◀ ▶), nombre, IP, dispositivo, entrada, último latido
     y presencia (EN PANTALLA / INACTIVO / DESCONECTADO).
   · Botón SORTEAR para todos (nadie se asigna a sí mismo) y auditoría (matriz).
   · Render por diferencias: sin parpadeo, actualización cada 3 s.
   ============================================================================ */
(function () {
  "use strict";

  var POLL_MS = 3000;
  var state = {
    ready: false,
    timer: null,
    inFlight: false,
    snapshot: null,
    rows: {},
    busy: false
  };

  function el(id) {
    return document.getElementById(id);
  }

  function api(path, options) {
    options = options || {};
    var headers = { Accept: "application/json" };
    if (options.body) headers["Content-Type"] = "application/json";
    if (options.probe) headers["X-Admin-Probe"] = "1";

    var settings = {
      method: options.method || "GET",
      headers: headers,
      cache: "no-store",
      credentials: "same-origin"
    };
    if (options.body) settings.body = JSON.stringify(options.body);

    return fetch(path, settings).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (body) {
          if (!response.ok) {
            var error = new Error(body && body.message ? body.message : "Error " + response.status);
            error.status = response.status;
            throw error;
          }
          return body;
        });
    });
  }

  function alertBox(id, message, ok) {
    var node = el(id);
    if (!node) return;
    if (!message) {
      node.className = "alert hidden";
      node.textContent = "";
      return;
    }
    node.className = ok ? "alert ok" : "alert";
    node.textContent = message;
  }

  function two(value) {
    return (value < 10 ? "0" : "") + value;
  }

  function clockTime(ms) {
    if (!ms) return "—";
    var date = new Date(ms);
    return two(date.getHours()) + ":" + two(date.getMinutes());
  }

  function humanAge(ms) {
    if (ms < 4000) return "ahora mismo";
    var seconds = Math.round(ms / 1000);
    if (seconds < 60) return "hace " + seconds + " s";
    return "hace " + Math.round(seconds / 60) + " min";
  }

  function statusLabel(status) {
    if (status === "online") return "en pantalla";
    if (status === "idle") return "inactivo";
    return "desconectado";
  }

  /* ------------------------------ vistas ------------------------------ */

  function showPanel(logged) {
    el("view-login").className = logged ? "hidden" : "";
    el("view-panel").className = logged ? "" : "hidden";
    if (logged) el("share-url").textContent = window.location.origin + "/";
  }

  function showLoginError(message) {
    alertBox("login-error", message);
  }

  /* ------------------------------ login ------------------------------ */

  function login() {
    var password = el("pw").value;
    if (!password) {
      showLoginError("Escribe la contraseña.");
      return;
    }
    el("login-btn").disabled = true;
    showLoginError("");

    api("/api/admin/login", { method: "POST", body: { password: password } })
      .then(function () {
        el("login-btn").disabled = false;
        el("pw").value = "";
        state.ready = true;
        showPanel(true);
        refresh();
        scheduleNext();
      })
      .catch(function (error) {
        el("login-btn").disabled = false;
        showLoginError(error && error.message ? error.message : "No se pudo iniciar sesión.");
      });
  }

  function logout() {
    api("/api/admin/logout", { method: "POST" })
      .catch(function () {})
      .then(function () {
        state.ready = false;
        if (state.timer) window.clearTimeout(state.timer);
        showPanel(false);
      });
  }

  /* ------------------------------ pintado ------------------------------ */

  function buildRow(player) {
    var row = document.createElement("li");
    row.style.display = "block";
    row.style.padding = "12px 2px";

    var head = document.createElement("div");
    head.className = "who-grid";

    var prev = document.createElement("button");
    prev.type = "button";
    prev.className = "emoji-btn";
    prev.textContent = "◀";

    var emoji = document.createElement("span");
    emoji.className = "emoji-now";

    var next = document.createElement("button");
    next.type = "button";
    next.className = "emoji-btn";
    next.textContent = "▶";

    var dot = document.createElement("span");
    dot.className = "dot";
    dot.style.margin = "0 8px 0 12px";

    var who = document.createElement("span");
    who.className = "who";
    who.style.marginLeft = "0";

    var kick = document.createElement("button");
    kick.type = "button";
    kick.className = "btn danger";
    kick.style.marginTop = "0";
    kick.style.width = "auto";
    kick.textContent = "Expulsar";

    head.appendChild(prev);
    head.appendChild(emoji);
    head.appendChild(next);
    head.appendChild(dot);
    head.appendChild(who);
    head.appendChild(kick);

    var details = document.createElement("p");
    details.className = "stat";
    details.style.margin = "6px 0 0";

    row.appendChild(head);
    row.appendChild(details);

    prev.onclick = function () {
      cycleEmoji(player.p, "emoji_prev");
    };
    next.onclick = function () {
      cycleEmoji(player.p, "emoji_next");
    };
    kick.onclick = function () {
      if (!window.confirm("¿Expulsar a " + player.n + "? Si ya sorteaste, vuelve a sortear.")) return;
      kickPlayer(player.p, player.n);
    };

    row._emoji = emoji;
    row._dot = dot;
    row._who = who;
    row._details = details;
    row._prev = prev;
    row._next = next;
    row._kick = kick;
    return row;
  }

  function updateRow(row, player) {
    row._emoji.textContent = player.e || "🙂";
    row._dot.className = "dot " + (player.s || "offline");
    row._who.textContent = player.n;
    row._details.textContent =
      "IP " +
      player.ip +
      " · " +
      player.device +
      " · entró " +
      clockTime(player.at) +
      " · " +
      humanAge(player.age) +
      " · " +
      statusLabel(player.s);
    row._prev.onclick = function () {
      cycleEmoji(player.p, "emoji_prev");
    };
    row._next.onclick = function () {
      cycleEmoji(player.p, "emoji_next");
    };
    row._kick.onclick = function () {
      if (!window.confirm("¿Expulsar a " + player.n + "? Si ya sorteaste, vuelve a sortear.")) return;
      kickPlayer(player.p, player.n);
    };
  }

  function renderPlayers(players) {
    var list = el("players");
    var seen = {};

    players.forEach(function (player) {
      var row = state.rows[player.p];
      if (!row) {
        row = buildRow(player);
        state.rows[player.p] = row;
        list.appendChild(row);
      }
      updateRow(row, player);
      seen[player.p] = true;
    });

    Object.keys(state.rows).forEach(function (pid) {
      if (seen[pid]) return;
      list.removeChild(state.rows[pid]);
      delete state.rows[pid];
    });

    el("empty-note").className = players.length ? "muted hidden" : "muted";
  }

  function render(snapshot) {
    state.snapshot = snapshot;
    var drawn = snapshot.state === "DRAWN";
    var enough = snapshot.total >= snapshot.minPlayers;
    var assigned = typeof snapshot.assigned === "number" ? snapshot.assigned : 0;
    var missing = Math.max(0, snapshot.total - assigned);

    el("state-badge").className = drawn ? "badge on" : "badge";
    el("state-badge").textContent = drawn ? "sorteado" : "en lobby";
    el("stat-total").textContent = String(snapshot.total);
    el("stat-assigned").textContent = String(assigned);
    el("stat-min").textContent = String(snapshot.minPlayers);
    el("stat-round").textContent = String(snapshot.round);
    el("clock").textContent = new Date().toLocaleTimeString();

    var drawBtn = el("draw-btn");
    drawBtn.disabled = !enough || state.busy;
    drawBtn.textContent = drawn ? "Volver a sortear" : "Sortear a todos";

    if (!enough) {
      el("draw-note").textContent =
        "Faltan " + (snapshot.minPlayers - snapshot.total) + " persona(s) para poder sortear.";
    } else if (drawn && missing > 0) {
      el("draw-note").textContent =
        missing + " persona(s) entraron después del sorteo y no tienen amigo asignado: vuelve a sortear.";
    } else if (drawn) {
      el("draw-note").textContent =
        "Todos tienen amigo secreto y nadie se asignó a sí mismo. Compruébalo en la matriz.";
    } else {
      el("draw-note").textContent = "Listo para sortear: nadie se asignará a sí mismo.";
    }

    renderPlayers(snapshot.players || []);
  }

  /* ------------------------------ refresco ------------------------------ */

  function scheduleNext() {
    if (state.timer) window.clearTimeout(state.timer);
    state.timer = window.setTimeout(function () {
      if (state.ready) refresh();
    }, POLL_MS);
  }

  function refresh() {
    if (!state.ready || state.inFlight) {
      scheduleNext();
      return;
    }
    state.inFlight = true;
    api("/api/admin/state")
      .then(function (snapshot) {
        state.inFlight = false;
        render(snapshot);
        scheduleNext();
      })
      .catch(function (error) {
        state.inFlight = false;
        if (error && error.status === 401) {
          state.ready = false;
          showPanel(false);
          showLoginError("La sesión del panel caducó. Vuelve a entrar.");
          return;
        }
        scheduleNext();
      });
  }

  /* ------------------------------ acciones ------------------------------ */

  function draw() {
    if (state.busy) return;
    var drawn = state.snapshot && state.snapshot.state === "DRAWN";
    if (drawn && !window.confirm("Ya hay un sorteo hecho. ¿Sortear de nuevo a todos?")) return;

    state.busy = true;
    alertBox("draw-error", "");
    el("draw-btn").disabled = true;

    api("/api/admin/draw", { method: "POST", body: { force: true } })
      .then(function (result) {
        state.busy = false;
        alertBox(
          "draw-error",
          "✅ Sorteo hecho para " + result.total + " personas (ronda " + result.round + ").",
          true
        );
        refresh();
      })
      .catch(function (error) {
        state.busy = false;
        alertBox("draw-error", error && error.message ? error.message : "No se pudo sortear.");
        refresh();
      });
  }

  function resetRound() {
    if (!window.confirm("¿Reiniciar la ronda? Se borran los amigos asignados y todos vuelven al lobby.")) return;
    api("/api/admin/reset", { method: "POST", body: { keepPlayers: true } })
      .then(function () {
        state.rows = {};
        el("players").innerHTML = "";
        el("matrix-card").className = "card hidden";
        alertBox("draw-error", "Ronda reiniciada. Todos siguen dentro.", true);
        refresh();
      })
      .catch(function (error) {
        alertBox("draw-error", error && error.message ? error.message : "No se pudo reiniciar.");
      });
  }

  function cycleEmoji(pid, action) {
    api("/api/admin/player", { method: "POST", body: { p: pid, action: action } })
      .then(function () {
        refresh();
      })
      .catch(function (error) {
        alertBox("draw-error", error && error.message ? error.message : "No se pudo cambiar el emoji.");
      });
  }

  function kickPlayer(pid, name) {
    api("/api/admin/player", { method: "POST", body: { p: pid, action: "kick" } })
      .then(function () {
        alertBox("draw-error", name + " salió de la sala.", true);
        refresh();
      })
      .catch(function (error) {
        alertBox("draw-error", error && error.message ? error.message : "No se pudo expulsar.");
      });
  }

  function copyLink() {
    var url = window.location.origin + "/";
    var done = function () {
      alertBox("draw-error", "Enlace copiado: " + url, true);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () {
        window.prompt("Copia el enlace:", url);
      });
      return;
    }
    window.prompt("Copia el enlace:", url);
    done();
  }

  function showMatrix() {
    api("/api/admin/matrix")
      .then(function (matrix) {
        var lines = matrix.pairs
          .map(function (pair) {
            return (pair.self ? "⚠️ " : "• ") + pair.from + "  →  " + pair.to;
          })
          .join("\n");
        el("matrix-summary").textContent =
          matrix.total +
          " asignaciones · auto-asignaciones: " +
          matrix.selfAssigned +
          " · " +
          (matrix.valid ? "VÁLIDO ✓" : "REVISAR ✗");
        el("matrix-list").textContent = lines || "Todavía no hay sorteo.";
        el("matrix-card").className = "card";
      })
      .catch(function (error) {
        alertBox("draw-error", error && error.message ? error.message : "No se pudo ver la matriz.");
      });
  }

  /* ------------------------------ arranque ------------------------------ */

  function bind() {
    el("login-btn").onclick = login;
    el("pw").onkeydown = function (event) {
      if (event.key === "Enter") login();
    };
    el("draw-btn").onclick = draw;
    el("reset-btn").onclick = resetRound;
    el("matrix-btn").onclick = showMatrix;
    el("matrix-close").onclick = function () {
      el("matrix-card").className = "card hidden";
    };
    el("copy-btn").onclick = copyLink;
    el("logout-btn").onclick = logout;
    document.addEventListener(
      "visibilitychange",
      function () {
        if (document.visibilityState === "visible" && state.ready) refresh();
      },
      false
    );
  }

  function boot() {
    bind();
    /* Sondea si la cookie del panel sigue siendo válida (cabecera de prueba). */
    api("/api/admin/state", { probe: true })
      .then(function (probe) {
        if (probe && probe.admin) {
          state.ready = true;
          showPanel(true);
          refresh();
          scheduleNext();
        } else {
          showPanel(false);
        }
      })
      .catch(function () {
        showPanel(false);
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, false);
  } else {
    boot();
  }
})();
