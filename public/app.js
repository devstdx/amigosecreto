/* ============================================================================
   Amigo Secreto — lógica del jugador (sin frameworks, sin build)
   ----------------------------------------------------------------------------
   · Sesión que NO se pierde: id en localStorage + cookie httpOnly de 1 año.
     Al volver al móvil se entra DIRECTO a la pantalla de espera (sin formulario).
   · Latido cada 2 s (15 s si la pestaña está oculta) con reintento progresivo.
   · Revelación con "mantener pulsado" 1,2 s (anti shoulder-surfing).
   ============================================================================ */
(function () {
  "use strict";

  var KEY_ID = "as_id";
  var KEY_NAME = "as_name";
  var KEY_EMOJI = "as_emoji";
  var HOLD_MS = 1200;
  var RING_LENGTH = 590.6; /* 2·π·94 */
  var FALLBACK_EMOJIS = [
    "🙂", "😎", "🤠", "🥳", "🤓", "😺", "🐶", "🐼",
    "🦊", "🐸", "🐙", "🦄", "🐝", "🌵", "🌟", "🍕",
    "🍩", "⚽", "🎸", "🚀", "👻", "💀", "🤖", "🎩"
  ];

  var memory = {};
  var state = {
    id: null,
    name: "",
    emoji: "🙂",
    emojis: FALLBACK_EMOJIS,
    view: "name",
    tickMs: 2000,
    timer: null,
    inFlight: false,
    failures: 0,
    targetName: null,
    targetState: "idle"
  };

  /* ------------------------------ utilidades ------------------------------ */

  function el(id) {
    return document.getElementById(id);
  }

  function store(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
    } catch (error) {
      if (value === undefined) return memory[key] || null;
      memory[key] = value;
    }
    return value;
  }

  function removeStore(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      /* ignorar */
    }
    delete memory[key];
  }

  function buzz(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (error) {
      /* dispositivo sin vibración */
    }
  }

  function isVisible() {
    return document.visibilityState !== "hidden";
  }

  function showAlert(id, message) {
    var node = el(id);
    if (!node) return;
    if (!message) {
      node.className = "alert hidden";
      node.textContent = "";
      return;
    }
    node.className = "alert";
    node.textContent = message;
  }

  /* ------------------------------ API ------------------------------ */

  function api(path, options) {
    options = options || {};
    var headers = { Accept: "application/json" };
    if (options.body) headers["Content-Type"] = "application/json";
    if (state.id) headers["X-Player-Id"] = state.id;

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

  /* ------------------------------ vistas ------------------------------ */

  function showView(view) {
    state.view = view;
    ["name", "wait", "reveal"].forEach(function (candidate) {
      var node = el("view-" + candidate);
      if (node) node.className = candidate === view ? "" : "hidden";
    });
  }

  function setEmoji(emoji) {
    state.emoji = emoji;
    store(KEY_EMOJI, emoji);
    if (el("emoji-show")) el("emoji-show").textContent = emoji;
    if (el("wait-emoji")) el("wait-emoji").textContent = emoji;
  }

  function rotateEmoji(step) {
    var list = state.emojis;
    var index = list.indexOf(state.emoji);
    if (index < 0) index = 0;
    setEmoji(list[(index + step + list.length) % list.length]);
    if (state.id && state.view === "wait") {
      api("/api/tick", { method: "POST", body: { v: 1, e: state.emoji } }).catch(function () {});
    }
  }

  /* ------------------------------ pintado ------------------------------ */

  function renderWait(snapshot) {
    var players = snapshot.players || [];
    el("wait-name").textContent = snapshot.me ? snapshot.me.n : state.name;
    el("wait-emoji").textContent = snapshot.me ? snapshot.me.e : state.emoji;
    el("wait-count").textContent =
      players.length +
      (players.length === 1 ? " persona dentro" : " personas dentro") +
      " · hacen falta " +
      snapshot.minPlayers +
      " para sortear";

    var list = el("wait-list");
    while (list.firstChild) list.removeChild(list.firstChild);

    players.forEach(function (player) {
      var row = document.createElement("li");
      var dot = document.createElement("span");
      dot.className = "dot " + (player.s || "offline");
      var emoji = document.createElement("span");
      emoji.className = "emoji";
      emoji.style.margin = "0 8px";
      emoji.textContent = player.e || "🙂";
      var who = document.createElement("span");
      who.className = "who";
      who.textContent = player.n + (player.me ? " (tú)" : "");
      var mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent =
        player.s === "online" ? "en pantalla" : player.s === "idle" ? "inactivo" : "fuera";
      row.appendChild(dot);
      row.appendChild(emoji);
      row.appendChild(who);
      row.appendChild(mark);
      list.appendChild(row);
    });
  }

  /* --------------------------- latido / polling --------------------------- */

  function scheduleTick(delay) {
    if (state.timer) window.clearTimeout(state.timer);
    state.timer = window.setTimeout(tick, typeof delay === "number" ? delay : state.tickMs);
  }

  function tick() {
    if (state.inFlight) {
      scheduleTick(state.tickMs);
      return;
    }
    state.inFlight = true;

    api("/api/tick", {
      method: "POST",
      body: { v: isVisible() ? 1 : 0, e: state.emoji, id: state.id }
    })
      .then(function (snapshot) {
        state.inFlight = false;
        state.failures = 0;
        showAlert("wait-error", "");

        if (!snapshot.me) {
          /* La sesión ya no existe (expulsado o sala reiniciada). */
          state.id = null;
          removeStore(KEY_ID);
          showAlert("name-error", "Tu sesión ya no está activa en la sala. Vuelve a entrar con tu nombre.");
          showView("name");
          return;
        }

        state.name = snapshot.me.n;
        store(KEY_NAME, state.name);
        setEmoji(snapshot.me.e || state.emoji);

        if (snapshot.state === "DRAWN") {
          if (state.view !== "reveal") {
            showView("reveal");
            buzz([40, 60, 120]);
          }
          return; /* sin polling: el nombre se pide solo al mantener pulsado */
        }

        if (state.view !== "wait") showView("wait");
        renderWait(snapshot);
        scheduleTick(isVisible() ? state.tickMs : 15000);
      })
      .catch(function (error) {
        state.inFlight = false;
        state.failures += 1;
        if (state.view === "wait") {
          showAlert(
            "wait-error",
            error && error.message ? error.message : "Sin conexión. Reintentando…"
          );
        }
        var backoff = Math.min(10000, state.tickMs * Math.pow(2, Math.min(state.failures, 3)));
        scheduleTick(backoff);
      });
  }

  function onVisibilityChange() {
    if (!state.id || state.view !== "wait") return;
    tick();
  }

  /* ------------------------------- unirse ------------------------------- */

  function join() {
    var input = el("name-input");
    var name = (input.value || "").replace(/\s+/g, " ").trim();
    if (!name) {
      showAlert("name-error", "Escribe tu nombre para entrar.");
      input.focus();
      return;
    }
    el("join-btn").disabled = true;
    showAlert("name-error", "");

    api("/api/join", {
      method: "POST",
      body: { n: name.slice(0, 20), e: state.emoji, id: state.id }
    })
      .then(function (response) {
        el("join-btn").disabled = false;
        state.id = response.me.id;
        state.name = response.me.n;
        setEmoji(response.me.e);
        store(KEY_ID, state.id);
        store(KEY_NAME, state.name);
        if (response.config && response.config.emojis) state.emojis = response.config.emojis;
        if (response.state === "DRAWN") {
          showView("reveal");
          return;
        }
        showView("wait");
        tick();
      })
      .catch(function (error) {
        el("join-btn").disabled = false;
        showAlert(
          "name-error",
          error && error.message ? error.message : "No se pudo entrar. Reintenta."
        );
      });
  }

  /* ------------------------------ revelación ------------------------------ */

  function loadTarget() {
    if (state.targetState === "loading" || state.targetState === "ready") return;
    state.targetState = "loading";
    api("/api/target")
      .then(function (body) {
        state.targetState = "ready";
        state.targetName = body.targetName + (body.targetEmoji ? "  " + body.targetEmoji : "");
        paintReveal(0);
      })
      .catch(function (error) {
        state.targetState = "error";
        el("reveal-hint").textContent =
          error && error.message ? error.message : "No se pudo cargar tu amigo secreto.";
      });
  }

  function paintReveal(progress) {
    var p = Math.max(0, Math.min(1, progress));
    var nameEl = el("target-name");
    var ring = el("ring-progress");
    if (state.targetName) {
      nameEl.textContent = state.targetName;
      nameEl.style.opacity = String(0.15 + p * 0.85);
      var blur = (1 - p) * 16;
      nameEl.style.filter = "blur(" + blur.toFixed(2) + "px)";
      nameEl.style.webkitFilter = "blur(" + blur.toFixed(2) + "px)";
    } else {
      nameEl.textContent = "";
    }
    if (ring) ring.setAttribute("stroke-dashoffset", String(RING_LENGTH * (1 - p)));
  }

  function hideReveal() {
    el("target-name").textContent = "";
    el("pad-knob").textContent = "🎁";
    el("reveal-hint").textContent = "Mantén pulsado 1,2 s para verlo. Se oculta al soltar.";
    paintReveal(0);
  }

  var holding = false;
  var rafId = null;
  var startedAt = 0;
  var celebrated = false;

  function holdLoop() {
    if (!holding) return;
    var progress = (Date.now() - startedAt) / HOLD_MS;
    paintReveal(progress);
    if (progress >= 1 && !celebrated) {
      celebrated = true;
      el("pad-knob").textContent = "🤫";
      el("reveal-hint").textContent = "¡Sujétalo para verlo! Al soltar se vuelve a ocultar.";
      buzz([70, 40, 120]);
    }
    rafId = window.requestAnimationFrame(holdLoop);
  }

  function beginHold(event) {
    if (event && event.cancelable) event.preventDefault();
    if (holding) return;
    holding = true;
    celebrated = false;
    startedAt = Date.now();
    loadTarget();
    if (rafId) window.cancelAnimationFrame(rafId);
    rafId = window.requestAnimationFrame(holdLoop);
  }

  function endHold() {
    if (!holding) return;
    holding = false;
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    hideReveal();
  }

  function bindPad() {
    var pad = el("pad");
    if (!pad) return;
    pad.setAttribute("role", "button");
    pad.setAttribute("tabindex", "0");
    pad.setAttribute("aria-label", "Mantén pulsado para revelar a tu amigo secreto");

    /* Pointer Events en navegadores modernos; touch/mouse en los antiguos
       (iOS < 13 y WebViews viejas no exponen window.PointerEvent). */
    if (window.PointerEvent) {
      pad.addEventListener("pointerdown", beginHold, false);
      pad.addEventListener("pointerup", endHold, false);
      pad.addEventListener("pointercancel", endHold, false);
      pad.addEventListener("pointerleave", endHold, false);
    } else if ("ontouchstart" in window) {
      pad.addEventListener("touchstart", beginHold, false);
      pad.addEventListener("touchend", endHold, false);
      pad.addEventListener("touchcancel", endHold, false);
    } else {
      pad.addEventListener("mousedown", beginHold, false);
      window.addEventListener("mouseup", endHold, false);
    }
    pad.addEventListener("contextmenu", function (event) {
      event.preventDefault();
    });
    pad.addEventListener("keydown", function (event) {
      if (event.key === " " || event.key === "Enter") beginHold(event);
    });
    pad.addEventListener("keyup", endHold, false);
    hideReveal();
  }

  /* ------------------------------ arranque ------------------------------ */

  function loadConfig(done) {
    api("/api/config")
      .then(function (config) {
        if (config && config.emojis && config.emojis.length) state.emojis = config.emojis;
        if (config && config.tickMs) state.tickMs = config.tickMs;
        done();
      })
      .catch(function () {
        done();
      });
  }

  function boot() {
    state.id = store(KEY_ID) || null;
    setEmoji(store(KEY_EMOJI) || FALLBACK_EMOJIS[0]);
    if (el("name-input")) el("name-input").value = store(KEY_NAME) || "";

    el("emoji-prev").onclick = function () {
      rotateEmoji(-1);
    };
    el("emoji-next").onclick = function () {
      rotateEmoji(1);
    };
    el("join-btn").onclick = join;
    el("name-input").onkeydown = function (event) {
      if (event.key === "Enter") join();
    };
    el("edit-btn").onclick = function () {
      if (state.timer) window.clearTimeout(state.timer);
      showAlert("wait-error", "");
      showView("name");
      el("name-input").focus();
    };
    document.addEventListener("visibilitychange", onVisibilityChange, false);
    bindPad();

    loadConfig(function () {
      if (state.id) {
        showView("wait");
        tick();
      } else {
        showView("name");
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, false);
  } else {
    boot();
  }
})();
