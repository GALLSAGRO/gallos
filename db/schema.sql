-- Limpiar tablas si existen
DROP TABLE IF EXISTS matches, apuestas, withdrawal_requests, peleas, rooms, usuarios CASCADE;

-- Tabla de salas/palenques
CREATE TABLE rooms (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(50) UNIQUE NOT NULL,
  nombre VARCHAR(100) NOT NULL,
  facebook_live_url TEXT,
  activos BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Usuarios (saldo GLOBAL)
CREATE TABLE usuarios (
  id SERIAL PRIMARY KEY,
  nombre_completo VARCHAR(100) NOT NULL,
  numero_celular VARCHAR(15) UNIQUE NOT NULL,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  puntos INTEGER DEFAULT 1000,
  is_admin BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Peleas por sala
CREATE TABLE peleas (
  id SERIAL PRIMARY KEY,
  room_id INTEGER REFERENCES rooms(id),
  gallo_a VARCHAR(80) NOT NULL,
  gallo_b VARCHAR(80) NOT NULL,
  estado VARCHAR(20) DEFAULT 'proxima', -- proxima, apostando, en_vivo, terminada
  ganador VARCHAR(10),
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Apuestas por sala
CREATE TABLE apuestas (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES usuarios(id),
  room_id INTEGER REFERENCES rooms(id),
  pelea_id INTEGER REFERENCES peleas(id),
  gallo VARCHAR(10) NOT NULL,
  puntos_total INTEGER NOT NULL,
  puntos_matched INTEGER DEFAULT 0,
  estado VARCHAR(20) DEFAULT 'pendiente',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Matches cruzados por sala
CREATE TABLE matches (
  id SERIAL PRIMARY KEY,
  room_id INTEGER REFERENCES rooms(id),
  pelea_id INTEGER REFERENCES peleas(id),
  apuesta_a_id INTEGER REFERENCES apuestas(id),
  apuesta_b_id INTEGER REFERENCES apuestas(id),
  puntos INTEGER NOT NULL,
  comision_pct NUMERIC(5,2) DEFAULT 10.00,
  comision_monto INTEGER DEFAULT 0,
  ganancia_bruta INTEGER DEFAULT 0,
  ganancia_neta INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Solicitudes de retiro
CREATE TABLE withdrawal_requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES usuarios(id),
  room_id INTEGER REFERENCES rooms(id),
  amount INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'pending', -- pending, approved, rejected, paid
  destination TEXT,
  admin_note TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Datos de prueba
INSERT INTO rooms (slug, nombre, facebook_live_url) VALUES
('palenque-norte', 'Palenque Norte', 'https://www.facebook.com/plugins/video.php?href=https://facebook.com/tu_pagina_norte/live'),
('palenque-sur', 'Palenque Sur', 'https://www.facebook.com/plugins/video.php?href=https://facebook.com/tu_pagina_sur/live');

INSERT INTO usuarios (nombre_completo, numero_celular, username, email, password_hash, is_admin) VALUES
('Admin Principal', '5512345678', 'admin', 'admin@gallos.com', '$2b$12$...', TRUE);