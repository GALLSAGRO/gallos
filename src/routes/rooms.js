const express = require('express');
const router = express.Router();
const pool = require('../models/db');

// -------------------------------------------------------
// GET /api/rooms
// Usuarios ven solo activas, admin ve todas
// -------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const q = req.user.is_admin || req.user.role === 'admin'
      ? await pool.query(
          `SELECT id, slug, nombre, facebook_live_url, activos, created_at
           FROM rooms ORDER BY created_at DESC`
        )
      : await pool.query(
          `SELECT id, slug, nombre, facebook_live_url, activos, created_at
           FROM rooms WHERE activos = TRUE ORDER BY created_at DESC`
        );
    res.json(q.rows);
  } catch (err) {
    console.error('GET /api/rooms error:', err);
    res.status(500).json({ error: 'Error al obtener salas' });
  }
});

// -------------------------------------------------------
// GET /api/rooms/:slug
// Detalle de sala + evento activo + cartelera + marcador
// -------------------------------------------------------
router.get('/:slug', async (req, res) => {
  try {
    const roomQ = await pool.query(
      `SELECT id, slug, nombre, facebook_live_url, activos, created_at
       FROM rooms WHERE slug = $1`,
      [req.params.slug]
    );
    const room = roomQ.rows[0];
    if (!room) return res.status(404).json({ error: 'Sala no encontrada' });

    const isAdmin = req.user.is_admin || req.user.role === 'admin' || req.user.role === 'operator';
    if (!isAdmin && !room.activos) {
      return res.status(403).json({ error: 'Sala no disponible' });
    }

    // Evento activo de esta sala
    const eventQ = await pool.query(
      `SELECT id, nombre, fecha_evento, estado, numero_pelea_actual, total_peleas, started_at
       FROM events
       WHERE room_id = $1 AND estado = 'activo'
       LIMIT 1`,
      [room.id]
    );
    const activeEvent = eventQ.rows[0] || null;

    let matches  = [];
    let scores   = [];
    let current  = null;

    if (activeEvent) {
      // Cartelera del evento activo
      const matchesQ = await pool.query(
        `SELECT id, numero_pelea, orden, gallo_rojo, gallo_verde,
                estado, resultado, puntos_rojo, puntos_verde
         FROM event_matches
         WHERE event_id = $1
         ORDER BY orden ASC`,
        [activeEvent.id]
      );
      matches = matchesQ.rows;

      // Pelea actual (estado 'lista' o 'apostando' o 'en_vivo')
      current = matches.find(m => ['lista', 'apostando', 'en_vivo'].includes(m.estado)) || null;

      // Marcador acumulado
      const scoresQ = await pool.query(
        `SELECT side, team_name, puntos, ganadas, empatadas, perdidas
         FROM v_event_team_scores WHERE event_id = $1`,
        [activeEvent.id]
      );
      scores = scoresQ.rows;
    }

    // Historial reciente de peleas terminadas del evento activo (o últimas 20 globales)
    const historialQ = activeEvent
      ? await pool.query(
          `SELECT id, numero_pelea, gallo_rojo, gallo_verde, resultado, puntos_rojo, puntos_verde, finished_at
           FROM event_matches
           WHERE event_id = $1 AND estado = 'terminada'
           ORDER BY orden DESC LIMIT 20`,
          [activeEvent.id]
        )
      : await pool.query(
          `SELECT em.id, em.numero_pelea, em.gallo_rojo, em.gallo_verde,
                  em.resultado, em.puntos_rojo, em.puntos_verde, em.finished_at
           FROM event_matches em
           JOIN events e ON e.room_id = $1
           WHERE em.estado = 'terminada'
           ORDER BY em.finished_at DESC LIMIT 20`,
          [room.id]
        );

    res.json({
      room,
      activeEvent,
      current,
      matches,
      scores,
      historial: historialQ.rows
    });
  } catch (err) {
    console.error('GET /api/rooms/:slug error:', err);
    res.status(500).json({ error: 'Error al obtener la sala' });
  }
});

module.exports = router;