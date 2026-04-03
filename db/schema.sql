-- =========================================================
-- GALLUSBET / SCHEMA NUEVO COMPLETO
-- Reemplazo total para ambiente de pruebas
-- PostgreSQL
-- =========================================================

-- ---------------------------------------------------------
-- LIMPIAR TODO
-- ---------------------------------------------------------
DROP VIEW IF EXISTS v_event_bet_cut CASCADE;
DROP VIEW IF EXISTS v_event_team_scores CASCADE;

DROP TABLE IF EXISTS event_reports CASCADE;
DROP TABLE IF EXISTS event_action_logs CASCADE;
DROP TABLE IF EXISTS room_operators CASCADE;
DROP TABLE IF EXISTS wallet_adjustments CASCADE;
DROP TABLE IF EXISTS matches CASCADE;
DROP TABLE IF EXISTS apuestas CASCADE;
DROP TABLE IF EXISTS peleas CASCADE;
DROP TABLE IF EXISTS event_matches CASCADE;
DROP TABLE IF EXISTS event_teams CASCADE;
DROP TABLE IF EXISTS events CASCADE;
DROP TABLE IF EXISTS withdrawal_requests CASCADE;
DROP TABLE IF EXISTS rooms CASCADE;
DROP TABLE IF EXISTS usuarios CASCADE;

DROP TYPE IF EXISTS event_status CASCADE;
DROP TYPE IF EXISTS match_status CASCADE;
DROP TYPE IF EXISTS match_result CASCADE;
DROP TYPE IF EXISTS wallet_adjustment_type CASCADE;
DROP TYPE IF EXISTS withdrawal_status CASCADE;
DROP TYPE IF EXISTS user_role CASCADE;

-- ---------------------------------------------------------
-- TIPOS
-- ---------------------------------------------------------
CREATE TYPE user_role AS ENUM ('user', 'admin', 'operator');

CREATE TYPE event_status AS ENUM (
  'programado',
  'activo',
  'finalizado',
  'cancelado'
);

CREATE TYPE match_status AS ENUM (
  'pendiente',
  'lista',
  'apostando',
  'en_vivo',
  'terminada',
  'saltada',
  'cancelada'
);

CREATE TYPE match_result AS ENUM (
  'rojo',
  'verde',
  'tablas',
  'sin_resultado'
);

CREATE TYPE wallet_adjustment_type AS ENUM (
  'suma',
  'resta'
);

CREATE TYPE withdrawal_status AS ENUM (
  'pending',
  'approved',
  'rejected',
  'paid'
);

-- ---------------------------------------------------------
-- SALAS / PALENQUES
-- ---------------------------------------------------------
CREATE TABLE rooms (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(60) UNIQUE NOT NULL,
  nombre VARCHAR(120) NOT NULL,
  facebook_live_url TEXT,
  activos BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------
-- USUARIOS
-- saldo global
-- ---------------------------------------------------------
CREATE TABLE usuarios (
  id SERIAL PRIMARY KEY,
  nombre_completo VARCHAR(120) NOT NULL,
  numero_celular VARCHAR(20) UNIQUE NOT NULL,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(120) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  puntos INTEGER NOT NULL DEFAULT 1000 CHECK (puntos >= 0),
  role user_role NOT NULL DEFAULT 'user',
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_usuarios_username ON usuarios(username);
CREATE INDEX idx_usuarios_role ON usuarios(role);

-- ---------------------------------------------------------
-- EVENTOS POR SALA
-- una sala puede tener muchos eventos
-- solo uno activo por sala
-- ---------------------------------------------------------
CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  nombre VARCHAR(150) NOT NULL,
  fecha_evento DATE NOT NULL,
  estado event_status NOT NULL DEFAULT 'programado',
  numero_pelea_actual INTEGER NOT NULL DEFAULT 0,
  total_peleas INTEGER NOT NULL DEFAULT 0,
  notas TEXT,
  started_at TIMESTAMP,
  finished_at TIMESTAMP,
  created_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_events_one_active_per_room
ON events(room_id)
WHERE estado = 'activo';

CREATE INDEX idx_events_room_id ON events(room_id);
CREATE INDEX idx_events_estado ON events(estado);

-- ---------------------------------------------------------
-- EQUIPOS DEL EVENTO
-- lado R y V
-- ---------------------------------------------------------
CREATE TABLE event_teams (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  side CHAR(1) NOT NULL CHECK (side IN ('R', 'V')),
  nombre VARCHAR(120) NOT NULL,
  capitan VARCHAR(120),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, side)
);

CREATE INDEX idx_event_teams_event_id ON event_teams(event_id);

-- ---------------------------------------------------------
-- PELEAS PROGRAMADAS DEL EVENTO
-- aqui se sube toda la cartelera del evento
-- ---------------------------------------------------------
CREATE TABLE event_matches (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  numero_pelea INTEGER NOT NULL,
  orden INTEGER NOT NULL,
  equipo_rojo_id INTEGER REFERENCES event_teams(id) ON DELETE SET NULL,
  equipo_verde_id INTEGER REFERENCES event_teams(id) ON DELETE SET NULL,
  gallo_rojo VARCHAR(120) NOT NULL,
  gallo_verde VARCHAR(120) NOT NULL,
  estado match_status NOT NULL DEFAULT 'pendiente',
  resultado match_result NOT NULL DEFAULT 'sin_resultado',
  winner_side CHAR(1) CHECK (winner_side IN ('R', 'V')),
  puntos_rojo INTEGER NOT NULL DEFAULT 0,
  puntos_verde INTEGER NOT NULL DEFAULT 0,
  betting_opened_at TIMESTAMP,
  betting_closed_at TIMESTAMP,
  started_at TIMESTAMP,
  finished_at TIMESTAMP,
  skipped_reason TEXT,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, numero_pelea),
  UNIQUE (event_id, orden)
);

CREATE INDEX idx_event_matches_event_id ON event_matches(event_id);
CREATE INDEX idx_event_matches_estado ON event_matches(estado);
CREATE INDEX idx_event_matches_orden ON event_matches(event_id, orden);

-- ---------------------------------------------------------
-- TABLA DE COMPATIBILIDAD TEMPORAL
-- puedes seguir usando "peleas" si alguna parte vieja del backend
-- aun la referencia, pero ahora apunta a peleas programadas/evento
-- ---------------------------------------------------------
CREATE TABLE peleas (
  id SERIAL PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  event_match_id INTEGER REFERENCES event_matches(id) ON DELETE CASCADE,
  gallo_a VARCHAR(120) NOT NULL,
  gallo_b VARCHAR(120) NOT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'proxima',
  ganador VARCHAR(10),
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_peleas_room_id ON peleas(room_id);
CREATE INDEX idx_peleas_event_id ON peleas(event_id);

-- ---------------------------------------------------------
-- APUESTAS
-- apuesta del usuario sobre una pelea del evento
-- ---------------------------------------------------------
CREATE TABLE apuestas (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  pelea_id INTEGER REFERENCES peleas(id) ON DELETE CASCADE,
  event_match_id INTEGER REFERENCES event_matches(id) ON DELETE CASCADE,
  gallo VARCHAR(10) NOT NULL CHECK (gallo IN ('A', 'B', 'R', 'V')),
  puntos_total INTEGER NOT NULL CHECK (puntos_total > 0),
  puntos_matched INTEGER NOT NULL DEFAULT 0 CHECK (puntos_matched >= 0),
  estado VARCHAR(30) NOT NULL DEFAULT 'pendiente',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_apuestas_user_id ON apuestas(user_id);
CREATE INDEX idx_apuestas_room_id ON apuestas(room_id);
CREATE INDEX idx_apuestas_event_id ON apuestas(event_id);
CREATE INDEX idx_apuestas_pelea_id ON apuestas(pelea_id);
CREATE INDEX idx_apuestas_event_match_id ON apuestas(event_match_id);
CREATE INDEX idx_apuestas_estado ON apuestas(estado);

-- ---------------------------------------------------------
-- CRUCES DE APUESTAS
-- ---------------------------------------------------------
CREATE TABLE matches (
  id SERIAL PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  pelea_id INTEGER REFERENCES peleas(id) ON DELETE CASCADE,
  event_match_id INTEGER REFERENCES event_matches(id) ON DELETE CASCADE,
  apuesta_a_id INTEGER REFERENCES apuestas(id) ON DELETE CASCADE,
  apuesta_b_id INTEGER REFERENCES apuestas(id) ON DELETE CASCADE,
  user_a_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  user_b_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  puntos INTEGER NOT NULL CHECK (puntos > 0),
  comision_pct NUMERIC(5,2) NOT NULL DEFAULT 10.00,
  comision_monto INTEGER NOT NULL DEFAULT 0,
  ganancia_bruta INTEGER NOT NULL DEFAULT 0,
  ganancia_neta INTEGER NOT NULL DEFAULT 0,
  resultado match_result NOT NULL DEFAULT 'sin_resultado',
  winner_user_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  loser_user_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  settled BOOLEAN NOT NULL DEFAULT FALSE,
  settled_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_matches_room_id ON matches(room_id);
CREATE INDEX idx_matches_event_id ON matches(event_id);
CREATE INDEX idx_matches_pelea_id ON matches(pelea_id);
CREATE INDEX idx_matches_event_match_id ON matches(event_match_id);
CREATE INDEX idx_matches_settled ON matches(settled);

-- ---------------------------------------------------------
-- SOLICITUDES DE RETIRO
-- ---------------------------------------------------------
CREATE TABLE withdrawal_requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status withdrawal_status NOT NULL DEFAULT 'pending',
  destination TEXT,
  admin_note TEXT,
  approved_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_withdrawal_requests_user_id ON withdrawal_requests(user_id);
CREATE INDEX idx_withdrawal_requests_status ON withdrawal_requests(status);

-- ---------------------------------------------------------
-- OPERADORES / AVISADORES POR SALA
-- pueden operar la pelea sin ser admin total
-- ---------------------------------------------------------
CREATE TABLE room_operators (
  id SERIAL PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, user_id)
);

CREATE INDEX idx_room_operators_room_id ON room_operators(room_id);
CREATE INDEX idx_room_operators_user_id ON room_operators(user_id);

-- ---------------------------------------------------------
-- AJUSTES MANUALES DE SALDO
-- sumar o quitar puntos
-- ---------------------------------------------------------
CREATE TABLE wallet_adjustments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  admin_user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  adjustment_type wallet_adjustment_type NOT NULL,
  puntos INTEGER NOT NULL CHECK (puntos > 0),
  motivo TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wallet_adjustments_user_id ON wallet_adjustments(user_id);

-- ---------------------------------------------------------
-- BITACORA DEL EVENTO
-- ---------------------------------------------------------
CREATE TABLE event_action_logs (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  match_id INTEGER REFERENCES event_matches(id) ON DELETE CASCADE,
  room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  action_type VARCHAR(50) NOT NULL,
  payload JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_event_action_logs_event_id ON event_action_logs(event_id);
CREATE INDEX idx_event_action_logs_match_id ON event_action_logs(match_id);
CREATE INDEX idx_event_action_logs_room_id ON event_action_logs(room_id);

-- ---------------------------------------------------------
-- REPORTE / CORTE FINAL DEL EVENTO
-- ---------------------------------------------------------
CREATE TABLE event_reports (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  total_apostado INTEGER NOT NULL DEFAULT 0,
  total_cruzado INTEGER NOT NULL DEFAULT 0,
  total_no_cruzado INTEGER NOT NULL DEFAULT 0,
  total_comision INTEGER NOT NULL DEFAULT 0,
  utilidad_neta INTEGER NOT NULL DEFAULT 0,
  total_peleas INTEGER NOT NULL DEFAULT 0,
  total_peleas_terminadas INTEGER NOT NULL DEFAULT 0,
  total_peleas_saltadas INTEGER NOT NULL DEFAULT 0,
  generado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  generated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------
-- VISTAS
-- ---------------------------------------------------------
CREATE VIEW v_event_team_scores AS
SELECT
  e.id AS event_id,
  et.id AS team_id,
  et.side,
  et.nombre AS team_name,
  COALESCE(SUM(
    CASE
      WHEN et.side = 'R' THEN em.puntos_rojo
      WHEN et.side = 'V' THEN em.puntos_verde
      ELSE 0
    END
  ), 0) AS puntos,
  COALESCE(SUM(
    CASE
      WHEN et.side = 'R' AND em.resultado = 'rojo' THEN 1
      WHEN et.side = 'V' AND em.resultado = 'verde' THEN 1
      ELSE 0
    END
  ), 0) AS ganadas,
  COALESCE(SUM(
    CASE
      WHEN em.resultado = 'tablas' THEN 1
      ELSE 0
    END
  ), 0) AS empatadas,
  COALESCE(SUM(
    CASE
      WHEN et.side = 'R' AND em.resultado = 'verde' THEN 1
      WHEN et.side = 'V' AND em.resultado = 'rojo' THEN 1
      ELSE 0
    END
  ), 0) AS perdidas
FROM events e
JOIN event_teams et ON et.event_id = e.id
LEFT JOIN event_matches em ON em.event_id = e.id
GROUP BY e.id, et.id, et.side, et.nombre;

CREATE VIEW v_event_bet_cut AS
SELECT
  m.id AS match_cross_id,
  m.event_id,
  m.event_match_id,
  em.numero_pelea,
  em.gallo_rojo,
  em.gallo_verde,
  ua.username AS usuario_a,
  ub.username AS usuario_b,
  m.puntos,
  m.resultado,
  m.comision_monto,
  m.ganancia_bruta,
  m.ganancia_neta,
  m.settled,
  m.settled_at
FROM matches m
LEFT JOIN event_matches em ON em.id = m.event_match_id
LEFT JOIN usuarios ua ON ua.id = m.user_a_id
LEFT JOIN usuarios ub ON ub.id = m.user_b_id;

-- ---------------------------------------------------------
-- DATOS DE PRUEBA
-- ---------------------------------------------------------
INSERT INTO rooms (slug, nombre, facebook_live_url) VALUES
('palenque-norte', 'Palenque Norte', 'https://www.facebook.com/plugins/video.php?href=https://facebook.com/tu_pagina_norte/live'),
('palenque-sur', 'Palenque Sur', 'https://www.facebook.com/plugins/video.php?href=https://facebook.com/tu_pagina_sur/live');

INSERT INTO usuarios (
  nombre_completo,
  numero_celular,
  username,
  email,
  password_hash,
  puntos,
  role,
  is_admin
) VALUES
('Admin Principal', '5512345678', 'admin', 'admin@gallos.com', '123', 5000, 'admin', TRUE),
('Operador Norte', '5511111111', 'operador1', 'operador1@gallos.com', '123', 3000, 'operator', FALSE),
('Usuario Demo', '5522222222', 'demo', 'demo@gallos.com', '123', 2000, 'user', FALSE);

-- operador asignado a sala
INSERT INTO room_operators (room_id, user_id, activo)
SELECT r.id, u.id, TRUE
FROM rooms r, usuarios u
WHERE r.slug = 'palenque-norte'
  AND u.username = 'operador1';

-- evento demo
INSERT INTO events (
  room_id,
  nombre,
  fecha_evento,
  estado,
  numero_pelea_actual,
  total_peleas,
  notas,
  created_by,
  started_at
)
SELECT
  r.id,
  'Derby de Prueba Norte',
  CURRENT_DATE,
  'activo',
  1,
  5,
  'Evento demo para pruebas internas',
  u.id,
  NOW()
FROM rooms r
JOIN usuarios u ON u.username = 'admin'
WHERE r.slug = 'palenque-norte';

-- equipos del evento demo
INSERT INTO event_teams (event_id, side, nombre, capitan)
SELECT e.id, 'R', 'Barca Roja', 'Capitan Rojo'
FROM events e
WHERE e.nombre = 'Derby de Prueba Norte';

INSERT INTO event_teams (event_id, side, nombre, capitan)
SELECT e.id, 'V', 'Vagos Verdes', 'Capitan Verde'
FROM events e
WHERE e.nombre = 'Derby de Prueba Norte';

-- cartelera demo
INSERT INTO event_matches (
  event_id,
  numero_pelea,
  orden,
  equipo_rojo_id,
  equipo_verde_id,
  gallo_rojo,
  gallo_verde,
  estado
)
SELECT
  e.id,
  x.numero_pelea,
  x.orden,
  tr.id,
  tv.id,
  x.gallo_rojo,
  x.gallo_verde,
  x.estado::match_status
FROM events e
JOIN event_teams tr ON tr.event_id = e.id AND tr.side = 'R'
JOIN event_teams tv ON tv.event_id = e.id AND tv.side = 'V'
JOIN (
  VALUES
    (1, 1, 'Rayo Rojo', 'Rama Verde', 'lista'),
    (2, 2, 'Tornado Rojo', 'Relampago Verde', 'pendiente'),
    (3, 3, 'Furia Roja', 'Sombra Verde', 'pendiente'),
    (4, 4, 'Centella Roja', 'Huracan Verde', 'pendiente'),
    (5, 5, 'Bravo Rojo', 'Titan Verde', 'pendiente')
) AS x(numero_pelea, orden, gallo_rojo, gallo_verde, estado)
ON TRUE
WHERE e.nombre = 'Derby de Prueba Norte';

-- compatibilidad temporal: crear una pelea activa ligada a la numero 1
INSERT INTO peleas (
  room_id,
  event_id,
  event_match_id,
  gallo_a,
  gallo_b,
  estado,
  started_at
)
SELECT
  r.id,
  e.id,
  em.id,
  em.gallo_rojo,
  em.gallo_verde,
  'apostando',
  NOW()
FROM rooms r
JOIN events e ON e.room_id = r.id
JOIN event_matches em ON em.event_id = e.id
WHERE r.slug = 'palenque-norte'
  AND e.nombre = 'Derby de Prueba Norte'
  AND em.numero_pelea = 1;