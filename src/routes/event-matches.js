const router = require('express').Router();
const pool   = require('../models/db');
const admin  = require('../middleware/admin');

// GET /api/event-matches/:eventId
router.get('/:eventId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT em.id, em.numero_pelea, em.orden, em.gallo_rojo, em.gallo_verde,
              em.estado, em.resultado, em.puntos_rojo, em.puntos_verde,
              em.equipo_rojo_id, em.equipo_verde_id, em.finished_at,
              tr.nombre AS nombre_equipo_rojo,
              tv.nombre AS nombre_equipo_verde
       FROM event_matches em
       LEFT JOIN event_teams tr ON tr.id = em.equipo_rojo_id
       LEFT JOIN event_teams tv ON tv.id = em.equipo_verde_id
       WHERE em.event_id = $1
       ORDER BY em.orden ASC`,
      [Number(req.params.eventId)]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/event-matches/:eventId', e);
    res.status(500).json({ error: 'Error al obtener peleas' });
  }
});

// POST /api/event-matches/:eventId — agregar pelea a cartelera
router.post('/:eventId', admin, async (req, res) => {
  const event_id = Number(req.params.eventId);
  const { equipo_rojo_id, equipo_verde_id, notes } = req.body;

  if (!equipo_rojo_id || !equipo_verde_id) {
    return res.status(400).json({ error: 'equipo_rojo_id y equipo_verde_id son obligatorios' });
  }
  if (Number(equipo_rojo_id) === Number(equipo_verde_id)) {
    return res.status(400).json({ error: 'Los equipos no pueden ser iguales' });
  }

  try {
    const ordenQ = await pool.query(
      `SELECT COALESCE(MAX(orden),0)+1 AS next_orden
       FROM event_matches WHERE event_id=$1`,
      [event_id]
    );
    const orden        = ordenQ.rows[0].next_orden;
    const numero_pelea = orden;

    const { rows } = await pool.query(
       `INSERT INTO event_matches
          (event_id, numero_pelea, orden, 
            equipo_rojo_id, equipo_verde_id, estado, notes)
        VALUES ($1,$2,$3,$4,$5,'pendiente',$6)`,
        [event_id, numero_pelea, orden,
         equipo_rojo_id, equipo_verde_id,
         notes || null]
    );

    await pool.query(
      `UPDATE events SET total_peleas = (
         SELECT COUNT(*) FROM event_matches
         WHERE event_id=$1 AND estado != 'cancelada'
       ) WHERE id=$1`,
      [event_id]
    );

    res.json(rows[0]);
  } catch (e) {
    console.error('POST /api/event-matches/:eventId', e);
    res.status(500).json({ error: 'Error al agregar pelea' });
  }
});

// POST /api/event-matches/:matchId/result — declarar resultado
router.post('/:matchId/result', admin, async (req, res) => {
  const matchId   = Number(req.params.matchId);
  const resultado = String(req.body.resultado || '').toLowerCase();

  if (!['rojo', 'verde', 'tablas'].includes(resultado)) {
    return res.status(400).json({ error: 'resultado debe ser rojo, verde o tablas' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const matchQ = await client.query(
      `SELECT em.*,
              e.room_id, e.estado AS ev_estado,
              e.numero_pelea_actual
       FROM event_matches em
       JOIN events e ON e.id = em.event_id
       WHERE em.id=$1 FOR UPDATE`,
      [matchId]
    );
    const match = matchQ.rows[0];
    if (!match) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pelea no encontrada' });
    }
    if (match.ev_estado !== 'activo') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'El evento no esta activo' });
    }
    if (match.estado === 'terminada') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Esta pelea ya tiene resultado' });
    }

    // Puntos segun resultado
    const pts = { rojo: 0, verde: 0 };
    if (resultado === 'rojo')   { pts.rojo = 3; pts.verde = 0; }
    if (resultado === 'verde')  { pts.rojo = 0; pts.verde = 3; }
    if (resultado === 'tablas') { pts.rojo = 1; pts.verde = 1; }

    // Actualizar pelea
    await client.query(
      `UPDATE event_matches
       SET estado='terminada', resultado=$1,
           puntos_rojo=$2, puntos_verde=$3, finished_at=NOW()
       WHERE id=$4`,
      [resultado, pts.rojo, pts.verde, matchId]
    );

    // Sumar puntos al equipo ganador — puntos van al EQUIPO no al color
    if (resultado === 'rojo' && match.equipo_rojo_id) {
      await client.query(
        `UPDATE event_teams
         SET puntos=puntos+3, ganadas=ganadas+1
         WHERE id=$1`,
        [match.equipo_rojo_id]
      );
      if (match.equipo_verde_id) {
        await client.query(
          `UPDATE event_teams SET perdidas=perdidas+1 WHERE id=$1`,
          [match.equipo_verde_id]
        );
      }
    } else if (resultado === 'verde' && match.equipo_verde_id) {
      await client.query(
        `UPDATE event_teams
         SET puntos=puntos+3, ganadas=ganadas+1
         WHERE id=$1`,
        [match.equipo_verde_id]
      );
      if (match.equipo_rojo_id) {
        await client.query(
          `UPDATE event_teams SET perdidas=perdidas+1 WHERE id=$1`,
          [match.equipo_rojo_id]
        );
      }
    } else if (resultado === 'tablas') {
      if (match.equipo_rojo_id) {
        await client.query(
          `UPDATE event_teams
           SET puntos=puntos+1, empatadas=empatadas+1
           WHERE id=$1`,
          [match.equipo_rojo_id]
        );
      }
      if (match.equipo_verde_id) {
        await client.query(
          `UPDATE event_teams
           SET puntos=puntos+1, empatadas=empatadas+1
           WHERE id=$1`,
          [match.equipo_verde_id]
        );
      }
    }

    // Activar siguiente pelea pendiente
    const nextQ = await client.query(
      `SELECT id FROM event_matches
       WHERE event_id=$1 AND estado='pendiente'
       ORDER BY orden ASC LIMIT 1`,
      [match.event_id]
    );
    let siguiente = null;
    if (nextQ.rows[0]) {
      await client.query(
        `UPDATE event_matches SET estado='lista' WHERE id=$1`,
        [nextQ.rows[0].id]
      );
      siguiente = nextQ.rows[0].id;
    }

    // Avanzar contador
    await client.query(
      `UPDATE events SET numero_pelea_actual=numero_pelea_actual+1 WHERE id=$1`,
      [match.event_id]
    );

    await client.query('COMMIT');

    // Emitir socket
    const sockets = req.app.get('sockets');
    const roomQ   = await pool.query('SELECT slug FROM rooms WHERE id=$1', [match.room_id]);
    if (sockets && roomQ.rows[0]) {
      sockets.emitMatchResult(roomQ.rows[0].slug, {
        event_id:     match.event_id,
        match_id:     matchId,
        resultado,
        puntos_rojo:  pts.rojo,
        puntos_verde: pts.verde,
        numero_pelea: match.numero_pelea,
        siguiente
      });
    }

    res.json({ ok: true, resultado, puntos_rojo: pts.rojo, puntos_verde: pts.verde, siguiente });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/event-matches/:matchId/result', e);
    res.status(500).json({ error: 'Error al declarar resultado' });
  } finally {
    client.release();
  }
});

// POST /api/event-matches/:matchId/skip — poner en espera (recuperable)
router.post('/:matchId/skip', admin, async (req, res) => {
  const matchId = Number(req.params.matchId);
  try {
    const matchQ = await pool.query(
      `SELECT em.*, e.room_id FROM event_matches em
       JOIN events e ON e.id = em.event_id
       WHERE em.id=$1`,
      [matchId]
    );
    if (!matchQ.rows[0]) return res.status(404).json({ error: 'Pelea no encontrada' });
    if (matchQ.rows[0].estado === 'terminada') {
      return res.status(400).json({ error: 'No puedes saltar una pelea ya terminada' });
    }

    // Poner en espera — NO es estado final, se puede recuperar
    await pool.query(
      `UPDATE event_matches SET estado='en_espera' WHERE id=$1`, [matchId]
    );

    // Activar siguiente pendiente
    const next = await pool.query(
      `SELECT id FROM event_matches
       WHERE event_id=$1 AND estado='pendiente'
       ORDER BY orden ASC LIMIT 1`,
      [matchQ.rows[0].event_id]
    );
    if (next.rows[0]) {
      await pool.query(
        `UPDATE event_matches SET estado='lista' WHERE id=$1`, [next.rows[0].id]
      );
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/event-matches/:matchId/skip', e);
    res.status(500).json({ error: 'Error al saltar pelea' });
  }
});

// POST /api/event-matches/:matchId/reactivate — recuperar pelea en espera
router.post('/:matchId/reactivate', admin, async (req, res) => {
  const matchId = Number(req.params.matchId);
  try {
    const matchQ = await pool.query(
      `SELECT * FROM event_matches WHERE id=$1`, [matchId]
    );
    if (!matchQ.rows[0]) return res.status(404).json({ error: 'Pelea no encontrada' });
    if (matchQ.rows[0].estado !== 'en_espera') {
      return res.status(400).json({ error: 'Solo puedes reactivar peleas en espera' });
    }

    // Verificar si hay pelea activa actualmente
    const current = await pool.query(
      `SELECT id FROM event_matches
       WHERE event_id=$1 AND estado IN ('lista','apostando','en_vivo')
       LIMIT 1`,
      [matchQ.rows[0].event_id]
    );

    if (current.rows[0]) {
      // Ya hay una pelea activa — poner esta como pendiente para que juegue despues
      await pool.query(
        `UPDATE event_matches SET estado='pendiente' WHERE id=$1`, [matchId]
      );
      return res.json({ ok: true, mensaje: 'Pelea puesta como pendiente, jugara despues de la actual' });
    }

    // No hay pelea activa — activar esta directamente
    await pool.query(
      `UPDATE event_matches SET estado='lista' WHERE id=$1`, [matchId]
    );
    res.json({ ok: true, mensaje: 'Pelea reactivada como siguiente' });
  } catch (e) {
    console.error('POST /api/event-matches/:matchId/reactivate', e);
    res.status(500).json({ error: 'Error al reactivar pelea' });
  }
});

// DELETE /api/event-matches/:matchId
router.delete('/:matchId', admin, async (req, res) => {
  const matchId = Number(req.params.matchId);
  try {
    const { rows } = await pool.query(
      `DELETE FROM event_matches
       WHERE id=$1 AND estado='pendiente'
       RETURNING id`,
      [matchId]
    );
    if (!rows.length) {
      return res.status(400).json({ error: 'Solo puedes eliminar peleas pendientes' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error al eliminar pelea' });
  }
});

module.exports = router;