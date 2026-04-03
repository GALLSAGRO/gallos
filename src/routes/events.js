const express = require('express');
const router = express.Router();
const pool = require('../models/db');

function requireAdminOrOperator(req, res, next) {
  const role = req.user?.role;
  if (role !== 'admin' && role !== 'operator' && !req.user?.is_admin) {
    return res.status(403).json({ error: 'Sin permisos' });
  }
  next();
}

// -------------------------------------------------------
// GET /api/events/rooms
// Lista salas activas para el selector del panel admin
// -------------------------------------------------------
router.get('/rooms', requireAdminOrOperator, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, slug, nombre FROM rooms WHERE activos = TRUE ORDER BY nombre`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener salas' });
  }
});

// -------------------------------------------------------
// GET /api/events?room_id=X
// Lista eventos de una sala
// -------------------------------------------------------
router.get('/', requireAdminOrOperator, async (req, res) => {
  const { room_id } = req.query;
  if (!room_id) return res.status(400).json({ error: 'room_id requerido' });

  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, fecha_evento, estado, numero_pelea_actual, total_peleas, started_at, finished_at
       FROM events
       WHERE room_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [room_id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener eventos' });
  }
});

// -------------------------------------------------------
// GET /api/events/:id
// Detalle completo del evento (equipos + cartelera + marcador)
// -------------------------------------------------------
router.get('/:id', requireAdminOrOperator, async (req, res) => {
  const { id } = req.params;
  try {
    const evRes = await pool.query(
      `SELECT e.*, r.nombre AS sala_nombre
       FROM events e
       JOIN rooms r ON r.id = e.room_id
       WHERE e.id = $1`,
      [id]
    );
    if (!evRes.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });

    const teamsRes = await pool.query(
      `SELECT id, side, nombre, capitan FROM event_teams WHERE event_id = $1 ORDER BY side`,
      [id]
    );

    const matchesRes = await pool.query(
      `SELECT id, numero_pelea, orden, gallo_rojo, gallo_verde,
              estado, resultado, puntos_rojo, puntos_verde,
              started_at, finished_at
       FROM event_matches
       WHERE event_id = $1
       ORDER BY orden ASC`,
      [id]
    );

    const scoresRes = await pool.query(
      `SELECT side, team_name, puntos, ganadas, empatadas, perdidas
       FROM v_event_team_scores
       WHERE event_id = $1`,
      [id]
    );

    res.json({
      event:   evRes.rows[0],
      teams:   teamsRes.rows,
      matches: matchesRes.rows,
      scores:  scoresRes.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener evento' });
  }
});

// -------------------------------------------------------
// POST /api/events
// Crear evento nuevo
// Body: { room_id, nombre, fecha_evento, total_peleas, notas,
//         equipo_rojo: { nombre, capitan },
//         equipo_verde: { nombre, capitan } }
// -------------------------------------------------------
router.post('/', requireAdminOrOperator, async (req, res) => {
  const { room_id, nombre, fecha_evento, total_peleas, notas, equipo_rojo, equipo_verde } = req.body;

  if (!room_id || !nombre || !fecha_evento) {
    return res.status(400).json({ error: 'room_id, nombre y fecha_evento son requeridos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const evRes = await client.query(
      `INSERT INTO events (room_id, nombre, fecha_evento, total_peleas, notas, estado, created_by)
       VALUES ($1, $2, $3, $4, $5, 'programado', $6)
       RETURNING *`,
      [room_id, nombre, fecha_evento, total_peleas || 0, notas || null, req.user.id]
    );
    const event = evRes.rows[0];

    if (equipo_rojo?.nombre) {
      await client.query(
        `INSERT INTO event_teams (event_id, side, nombre, capitan) VALUES ($1, 'R', $2, $3)`,
        [event.id, equipo_rojo.nombre, equipo_rojo.capitan || null]
      );
    }
    if (equipo_verde?.nombre) {
      await client.query(
        `INSERT INTO event_teams (event_id, side, nombre, capitan) VALUES ($1, 'V', $2, $3)`,
        [event.id, equipo_verde.nombre, equipo_verde.capitan || null]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(event);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al crear evento' });
  } finally {
    client.release();
  }
});

// -------------------------------------------------------
// POST /api/events/:id/start
// Iniciar evento programado → activo
// -------------------------------------------------------
router.post('/:id/start', requireAdminOrOperator, async (req, res) => {
  const { id } = req.params;
  const io = req.app.get('io');

  try {
    const { rows } = await pool.query(
      `UPDATE events
       SET estado = 'activo', started_at = NOW(), numero_pelea_actual = 1
       WHERE id = $1 AND estado = 'programado'
       RETURNING *`,
      [id]
    );
    if (!rows[0]) return res.status(400).json({ error: 'El evento no existe o ya está activo/finalizado' });

    const event = rows[0];

    // Primera pelea pasa a 'lista'
    await pool.query(
      `UPDATE event_matches SET estado = 'lista'
       WHERE event_id = $1 AND orden = 1 AND estado = 'pendiente'`,
      [id]
    );

    io.to(`room_${event.room_id}`).emit('event:started', {
      event_id: event.id,
      room_id:  event.room_id
    });

    res.json({ ok: true, event });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ya existe un evento activo en esta sala' });
    }
    res.status(500).json({ error: 'Error al iniciar evento' });
  }
});

// -------------------------------------------------------
// POST /api/events/:id/finish
// Cerrar evento activo → finalizado (NO toca la sala)
// -------------------------------------------------------
router.post('/:id/finish', requireAdminOrOperator, async (req, res) => {
  const { id } = req.params;
  const io = req.app.get('io');

  try {
    const { rows } = await pool.query(
      `UPDATE events
       SET estado = 'finalizado', finished_at = NOW()
       WHERE id = $1 AND estado = 'activo'
       RETURNING *`,
      [id]
    );
    if (!rows[0]) return res.status(400).json({ error: 'El evento no está activo' });

    const event = rows[0];

    // Cancelar peleas que no se jugaron
    await pool.query(
      `UPDATE event_matches SET estado = 'cancelada'
       WHERE event_id = $1 AND estado IN ('pendiente', 'lista')`,
      [id]
    );

    io.to(`room_${event.room_id}`).emit('event:finished', {
      event_id: event.id,
      room_id:  event.room_id
    });

    res.json({ ok: true, event });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al finalizar evento' });
  }
});

// -------------------------------------------------------
// PATCH /api/events/:id
// Editar evento (solo si está programado)
// -------------------------------------------------------
router.patch('/:id', requireAdminOrOperator, async (req, res) => {
  const { id } = req.params;
  const { nombre, notas, total_peleas } = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE events
       SET nombre      = COALESCE($1, nombre),
           notas       = COALESCE($2, notas),
           total_peleas = COALESCE($3, total_peleas)
       WHERE id = $4 AND estado = 'programado'
       RETURNING *`,
      [nombre || null, notas || null, total_peleas || null, id]
    );
    if (!rows[0]) return res.status(400).json({ error: 'Evento no encontrado o ya no es editable' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al editar evento' });
  }
});

module.exports = router;