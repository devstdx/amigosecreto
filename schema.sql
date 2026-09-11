-- ============================================================================
--  Amigo Secreto — esquema D1 (SQLite) de la SALA ÚNICA
-- ============================================================================
--  Aplicar en local:   npx wrangler d1 execute amigosecreto --local  --file=schema.sql
--  Aplicar en remoto:  npx wrangler d1 execute amigosecreto --remote --file=schema.sql
--
--  Diseño (3 tablas, cero JOINs en el camino caliente):
--   · room_state  : 1 fila (id = 'main') con el estado del sorteo y la ronda.
--   · players     : 1 fila por persona. El latido es un UPDATE de 1 fila
--                   (sin read-modify-write ⇒ sin carreras al entrar varios a la vez).
--   · assignments : 1 fila por persona (giver -> target). SOLO servidor.
--
--  D1 factura por FILA leída/escrita: un latido cuesta 1 + N lecturas y, como
--  mucho, 1 escritura cada 5 s. Toda la sala se lee en UN solo `batch`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS room_state (
  id         TEXT    PRIMARY KEY,              -- 'main'
  state      TEXT    NOT NULL DEFAULT 'LOBBY', -- LOBBY | DRAWN
  round      INTEGER NOT NULL DEFAULT 1,
  drawn_at   INTEGER,                          -- epoch ms del último sorteo
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  room_id   TEXT    NOT NULL,
  player_id TEXT    NOT NULL,                  -- UUID v4 (token bearer, nunca se expone)
  name      TEXT    NOT NULL,
  emoji     TEXT    NOT NULL DEFAULT '🙂',
  ip        TEXT    NOT NULL DEFAULT '—',
  ua        TEXT    NOT NULL DEFAULT '',
  joined_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  visible   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (room_id, player_id)
);

-- SIN índice en last_seen a propósito: D1 cuenta +1 fila escrita por cada
-- índice afectado, así que un índice sobre `last_seen` DUPLICA el coste de cada
-- latido (medido: 2.046 → ~1.000 escrituras por persona·hora). La purga de
-- inactivos solo escanea las ≤60 filas de la sala, no necesita índice.
-- (Si algún día hay que purgar por last_seen a gran escala, se añade entonces.)

CREATE TABLE IF NOT EXISTS assignments (
  room_id    TEXT    NOT NULL,
  giver_id   TEXT    NOT NULL,
  target_id  TEXT    NOT NULL,
  round      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, giver_id)
);

-- Índice para la auditoría (matriz) y para resolver el objetivo por JOIN.
CREATE INDEX IF NOT EXISTS idx_assignments_target ON assignments (room_id, target_id);
