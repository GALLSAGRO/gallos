const express = require('express');
const router = express.Router();
const pool = require('../models/db');

// -------------------------------------------------------
// GET /api/rooms
// Usuarios ven solo activas, admin ve todas
// -------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const isAdmin = req.user.is_admin || req.user.role === 'admin';

    const q = isAdmin
      ? await pool.query(
          `SELECT id, slug, nombre, facebook_live_url, activos, created_at
           FROM rooms
           ORDER BY created_at DESC`
        )
      : await pool.query(
          `SELECT id, slug, nombre, facebook_live_url, activos, created_at
           FROM rooms
           WHERE activos = TRUE
           ORDER BY created_at DESC`
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
       FROM rooms
       WHERE slug = $1`,
      [req.params.slug]
    );

    const room = roomQ.rows[0];
    if (!room) return res.status(404).json({ error: 'Sala no encontrada' });

    const isAdmin =
      req.user.is_admin ||
      req.user.role === 'admin' ||
      req.user.role === 'operator';

    if (!isAdmin && !room.activos) {
      return res.status(403).json({ error: 'Sala no disponible' });
    }

    const eventQ = await pool.query(
      `SELECT id, nombre, fecha_evento, estado, numero_pelea_actual, total_peleas, started_at, notas
       FROM events
       WHERE room_id = $1 AND estado = 'activo'
       LIMIT 1`,
      [room.id]
    );

    const activeEvent = eventQ.rows[0] || null;

    let matches = [];
    let scores = [];
    let current = null;

    if (activeEvent) {
      const matchesQ = await pool.query(
        `SELECT em.id, em.numero_pelea, em.orden,
                em.estado, em.resultado, em.puntos_rojo, em.puntos_verde,
                em.equipo_rojo_id, em.equipo_verde_id, em.finished_at, em.notes,
                tr.nombre AS nombre_equipo_rojo,
                tv.nombre AS nombre_equipo_verde
         FROM event_matches em
         LEFT JOIN event_teams tr ON tr.id = em.equipo_rojo_id
         LEFT JOIN event_teams tv ON tv.id = em.equipo_verde_id
         WHERE em.event_id = $1
         ORDER BY em.orden ASC`,
        [activeEvent.id]
      );

      matches = matchesQ.rows;
      current = matches.find(m => ['lista', 'apostando', 'en_vivo'].includes(m.estado)) || null;

      const scoresQ = await pool.query(
        `SELECT side, team_name, puntos, ganadas, empatadas, perdidas
         FROM v_event_team_scores
         WHERE event_id = $1`,
        [activeEvent.id]
      );

      scores = scoresQ.rows;
    }

    const historialQ = activeEvent
      ? await pool.query(
          `SELECT em.id, em.numero_pelea,
                  em.resultado, em.puntos_rojo, em.puntos_verde, em.finished_at,
                  em.equipo_rojo_id, em.equipo_verde_id,
                  tr.nombre AS nombre_equipo_rojo,
                  tv.nombre AS nombre_equipo_verde
           FROM event_matches em
           LEFT JOIN event_teams tr ON tr.id = em.equipo_rojo_id
           LEFT JOIN event_teams tv ON tv.id = em.equipo_verde_id
           WHERE em.event_id = $1 AND em.estado = 'terminada'
           ORDER BY em.orden DESC
           LIMIT 20`,
          [activeEvent.id]
        )
      : await pool.query(
          `SELECT em.id, em.numero_pelea,
                  em.resultado, em.puntos_rojo, em.puntos_verde, em.finished_at,
                  em.equipo_rojo_id, em.equipo_verde_id,
                  tr.nombre AS nombre_equipo_rojo,
                  tv.nombre AS nombre_equipo_verde
           FROM event_matches em
           JOIN events e ON e.id = em.event_id
           LEFT JOIN event_teams tr ON tr.id = em.equipo_rojo_id
           LEFT JOIN event_teams tv ON tv.id = em.equipo_verde_id
           WHERE e.room_id = $1 AND em.estado = 'terminada'
           ORDER BY em.finished_at DESC
           LIMIT 20`,
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