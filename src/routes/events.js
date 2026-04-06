const router = require('express').Router();
const pool = require('../models/db');
const admin = require('../middleware/admin');

// GET /api/events/rooms
router.get('/rooms', admin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, slug, nombre, activos
       FROM rooms
       ORDER BY nombre ASC`
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/events/rooms', e);
    res.status(500).json({ error: 'Error al obtener salas' });
  }
});

// GET /api/events?room_id=X
router.get('/', admin, async (req, res) => {
  const room_id = Number(req.query.room_id);
  if (!room_id) return res.status(400).json({ error: 'room_id requerido' });

  try {
    const { rows } = await pool.query(
      `SELECT id, room_id, nombre, fecha_evento, estado,
              numero_pelea_actual, total_peleas,
              notas, started_at, finished_at, created_at
       FROM events
       WHERE room_id = $1
       ORDER BY created_at DESC`,
      [room_id]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/events', e);
    res.status(500).json({ error: 'Error al obtener eventos' });
  }
});

// GET /api/events/:id
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);

  try {
    const evQ = await pool.query(
      `SELECT id, room_id, nombre, fecha_evento, estado,
              numero_pelea_actual, total_peleas,
              notas, started_at, finished_at
       FROM events
       WHERE id = $1`,
      [id]
    );

    if (!evQ.rows[0]) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    const matches = await pool.query(
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
      [id]
    );

    const teams = await pool.query(
      `SELECT id, nombre, side, capitan,
              puntos, ganadas, empatadas, perdidas
       FROM event_teams
       WHERE event_id = $1
       ORDER BY puntos DESC, ganadas DESC, nombre ASC`,
      [id]
    );

    res.json({
      event: evQ.rows[0],
      matches: matches.rows,
      teams: teams.rows
    });
  } catch (e) {
    console.error('GET /api/events/:id', e);
    res.status(500).json({ error: 'Error al obtener evento' });
  }
});

// POST /api/events
router.post('/', admin, async (req, res) => {
  const { room_id, nombre, fecha_evento, total_peleas, notas } = req.body;

  if (!room_id || !nombre || !fecha_evento) {
    return res.status(400).json({ error: 'room_id, nombre y fecha_evento son obligatorios' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO events
        (room_id, nombre, fecha_evento, total_peleas, notas, estado, numero_pelea_actual)
       VALUES ($1,$2,$3,$4,$5,'programado',0)
       RETURNING *`,
      [room_id, nombre, fecha_evento, total_peleas || 0, notas || null]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('POST /api/events', e);
    res.status(500).json({ error: 'Error al crear evento' });
  }
});

// POST /api/events/:id/teams
router.post('/:id/teams', admin, async (req, res) => {
  const event_id = Number(req.params.id);
  const { nombre, side, capitan } = req.body;

  if (!nombre) return res.status(400).json({ error: 'nombre es obligatorio' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO event_teams (event_id, nombre, side, capitan, puntos, ganadas, empatadas, perdidas)
       VALUES ($1,$2,$3,$4,0,0,0,0)
       RETURNING *`,
      [event_id, nombre.trim(), side || null, capitan || null]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('POST /api/events/:id/teams', e);
    res.status(500).json({ error: 'Error al registrar equipo' });
  }
});

// DELETE /api/events/:id/teams/:teamId
router.delete('/:id/teams/:teamId', admin, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM event_teams
       WHERE id = $1 AND event_id = $2`,
      [Number(req.params.teamId), Number(req.params.id)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/events/:id/teams/:teamId', e);
    res.status(500).json({ error: 'Error al eliminar equipo' });
  }
});

// POST /api/events/:id/start
router.post('/:id/start', admin, async (req, res) => {
  const id = Number(req.params.id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const evQ = await client.query(
      `UPDATE events
       SET estado = 'activo', numero_pelea_actual = 1, started_at = NOW()
       WHERE id = $1 AND estado = 'programado'
       RETURNING *`,
      [id]
    );

    if (!evQ.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Evento no encontrado o ya no esta en programado' });
    }

    await client.query(
      `UPDATE event_matches
       SET estado = 'lista'
       WHERE id = (
         SELECT id
         FROM event_matches
         WHERE event_id = $1 AND estado = 'pendiente'
         ORDER BY orden ASC
         LIMIT 1
       )`,
      [id]
    );

    await client.query('COMMIT');

    const sockets = req.app.get('sockets');
    const roomQ = await pool.query('SELECT slug FROM rooms WHERE id = $1', [evQ.rows[0].room_id]);

    if (sockets && roomQ.rows[0]) {
      sockets.emitEventStarted(roomQ.rows[0].slug, evQ.rows[0]);
    }

    res.json(evQ.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/events/:id/start', e);
    res.status(500).json({ error: 'Error al iniciar evento' });
  } finally {
    client.release();
  }
});

// POST /api/events/:id/finish
router.post('/:id/finish', admin, async (req, res) => {
  const id = Number(req.params.id);

  try {
    const evQ = await pool.query(
      `SELECT id, room_id
       FROM events
       WHERE id = $1`,
      [id]
    );

    if (!evQ.rows[0]) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    const { rows } = await pool.query(
      `UPDATE events
       SET estado = 'finalizado', finished_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    const sockets = req.app.get('sockets');
    const roomQ = await pool.query('SELECT slug FROM rooms WHERE id = $1', [evQ.rows[0].room_id]);

    if (sockets && roomQ.rows[0]) {
      sockets.emitEventFinished(roomQ.rows[0].slug, rows[0]);
    }

    res.json(rows[0]);
  } catch (e) {
    console.error('POST /api/events/:id/finish', e);
    res.status(500).json({ error: 'Error al finalizar evento' });
  }
});

module.exports = router;