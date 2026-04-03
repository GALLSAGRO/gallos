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
// GET /api/event-matches/:eventId
// Cartelera completa del evento con marcador acumulado
// -------------------------------------------------------
router.get('/:eventId', requireAdminOrOperator, async (req, res) => {
  const { eventId } = req.params;
  try {
    const matchesRes = await pool.query(
      `SELECT id, numero_pelea, orden, gallo_rojo, gallo_verde,
              estado, resultado, puntos_rojo, puntos_verde,
              started_at, finished_at, skipped_reason, notes
       FROM event_matches
       WHERE event_id = $1
       ORDER BY orden ASC`,
      [eventId]
    );

    const scoresRes = await pool.query(
      `SELECT side, team_name, puntos, ganadas, empatadas, perdidas
       FROM v_event_team_scores WHERE event_id = $1`,
      [eventId]
    );

    const eventRes = await pool.query(
      `SELECT id, nombre, estado, numero_pelea_actual, total_peleas FROM events WHERE id = $1`,
      [eventId]
    );

    res.json({
      event:   eventRes.rows[0] || null,
      matches: matchesRes.rows,
      scores:  scoresRes.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener cartelera' });
  }
});

// -------------------------------------------------------
// POST /api/event-matches/:eventId
// Agregar pelea a la cartelera
// Body: { gallo_rojo, gallo_verde, numero_pelea?, notas? }
// -------------------------------------------------------
router.post('/:eventId', requireAdminOrOperator, async (req, res) => {
  const { eventId } = req.params;
  const { gallo_rojo, gallo_verde, numero_pelea, notas } = req.body;

  if (!gallo_rojo || !gallo_verde) {
    return res.status(400).json({ error: 'gallo_rojo y gallo_verde son requeridos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verificar que el evento existe y no está finalizado
    const evQ = await client.query(
      `SELECT id, estado, total_peleas FROM events WHERE id = $1 FOR UPDATE`,
      [eventId]
    );
    const event = evQ.rows[0];
    if (!event) throw new Error('Evento no encontrado');
    if (event.estado === 'finalizado' || event.estado === 'cancelado') {
      throw new Error('No se pueden agregar peleas a un evento cerrado');
    }

    // Obtener equipos del evento
    const teamsQ = await client.query(
      `SELECT id, side FROM event_teams WHERE event_id = $1`,
      [eventId]
    );
    const teamRojo  = teamsQ.rows.find(t => t.side === 'R');
    const teamVerde = teamsQ.rows.find(t => t.side === 'V');

    // Calcular orden (siguiente disponible)
    const ordenQ = await client.query(
      `SELECT COALESCE(MAX(orden), 0) + 1 AS siguiente FROM event_matches WHERE event_id = $1`,
      [eventId]
    );
    const orden = ordenQ.rows[0].siguiente;

    // numero_pelea: usar el enviado o el mismo que el orden
    const numPelea = numero_pelea || orden;

    const { rows } = await client.query(
      `INSERT INTO event_matches
         (event_id, numero_pelea, orden, equipo_rojo_id, equipo_verde_id,
          gallo_rojo, gallo_verde, estado, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendiente', $8)
       RETURNING *`,
      [eventId, numPelea, orden,
       teamRojo?.id || null, teamVerde?.id || null,
       gallo_rojo, gallo_verde, notas || null]
    );

    // Actualizar total_peleas en el evento
    await client.query(
      `UPDATE events SET total_peleas = total_peleas + 1 WHERE id = $1`,
      [eventId]
    );

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || 'Error al agregar pelea' });
  } finally {
    client.release();
  }
});

// -------------------------------------------------------
// POST /api/event-matches/:matchId/result
// Declarar resultado de una pelea
// Body: { resultado: 'rojo' | 'verde' | 'tablas' }
// -------------------------------------------------------
router.post('/:matchId/result', requireAdminOrOperator, async (req, res) => {
  const { matchId } = req.params;
  const { resultado } = req.body;
  const io = req.app.get('io');

  if (!['rojo', 'verde', 'tablas'].includes(resultado)) {
    return res.status(400).json({ error: 'resultado debe ser rojo, verde o tablas' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Traer la pelea actual con lock
    const matchQ = await client.query(
      `SELECT em.*, e.room_id, e.numero_pelea_actual, e.total_peleas, e.estado AS event_estado
       FROM event_matches em
       JOIN events e ON e.id = em.event_id
       WHERE em.id = $1 FOR UPDATE`,
      [matchId]
    );
    const match = matchQ.rows[0];
    if (!match) throw new Error('Pelea no encontrada');
    if (match.estado === 'terminada' || match.estado === 'saltada') {
      throw new Error('Esta pelea ya tiene resultado');
    }
    if (match.event_estado !== 'activo') {
      throw new Error('El evento no está activo');
    }

    // Calcular puntos según resultado
    let puntos_rojo  = 0;
    let puntos_verde = 0;
    let winner_side  = null;

    if (resultado === 'rojo')   { puntos_rojo = 3; puntos_verde = 0; winner_side = 'R'; }
    if (resultado === 'verde')  { puntos_rojo = 0; puntos_verde = 3; winner_side = 'V'; }
    if (resultado === 'tablas') { puntos_rojo = 1; puntos_verde = 1; winner_side = null; }

    // Actualizar la pelea
    await client.query(
      `UPDATE event_matches
       SET estado      = 'terminada',
           resultado   = $2,
           winner_side = $3,
           puntos_rojo  = $4,
           puntos_verde = $5,
           finished_at  = NOW()
       WHERE id = $1`,
      [matchId, resultado, winner_side, puntos_rojo, puntos_verde]
    );

    // Registrar en bitácora
    await client.query(
      `INSERT INTO event_action_logs (event_id, match_id, room_id, user_id, action_type, payload)
       VALUES ($1, $2, $3, $4, 'resultado_declarado', $5)`,
      [match.event_id, matchId, match.room_id, req.user.id,
       JSON.stringify({ resultado, puntos_rojo, puntos_verde })]
    );

    // Avanzar contador del evento
    const nuevoNumero = match.numero_pelea_actual + 1;
    await client.query(
      `UPDATE events SET numero_pelea_actual = $1 WHERE id = $2`,
      [nuevoNumero, match.event_id]
    );

    // Activar siguiente pelea (siguiente orden después del actual)
    const siguienteQ = await client.query(
      `UPDATE event_matches SET estado = 'lista'
       WHERE event_id = $1
         AND orden = (SELECT MIN(orden) FROM event_matches
                      WHERE event_id = $1 AND estado = 'pendiente')
       RETURNING *`,
      [match.event_id]
    );
    const siguientePelea = siguienteQ.rows[0] || null;

    await client.query('COMMIT');

    // Leer marcador actualizado
    const scoresRes = await pool.query(
      `SELECT side, team_name, puntos, ganadas, empatadas, perdidas
       FROM v_event_team_scores WHERE event_id = $1`,
      [match.event_id]
    );

    // Emitir socket a todos en la sala
    io.to(`room_${match.room_id}`).emit('event:match_result', {
      event_id:       match.event_id,
      match_id:       Number(matchId),
      resultado,
      puntos_rojo,
      puntos_verde,
      numero_pelea:   match.numero_pelea,
      siguiente:      siguientePelea,
      scores:         scoresRes.rows
    });

    res.json({
      ok: true,
      resultado,
      puntos_rojo,
      puntos_verde,
      siguiente: siguientePelea,
      scores:    scoresRes.rows
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || 'Error al declarar resultado' });
  } finally {
    client.release();
  }
});

// -------------------------------------------------------
// POST /api/event-matches/:matchId/skip
// Saltar una pelea (sin resultado)
// Body: { motivo? }
// -------------------------------------------------------
router.post('/:matchId/skip', requireAdminOrOperator, async (req, res) => {
  const { matchId } = req.params;
  const { motivo } = req.body;
  const io = req.app.get('io');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const matchQ = await client.query(
      `SELECT em.*, e.room_id, e.estado AS event_estado
       FROM event_matches em
       JOIN events e ON e.id = em.event_id
       WHERE em.id = $1 FOR UPDATE`,
      [matchId]
    );
    const match = matchQ.rows[0];
    if (!match) throw new Error('Pelea no encontrada');
    if (match.estado === 'terminada') throw new Error('La pelea ya terminó, no se puede saltar');
    if (match.event_estado !== 'activo') throw new Error('El evento no está activo');

    await client.query(
      `UPDATE event_matches
       SET estado = 'saltada', skipped_reason = $2, finished_at = NOW()
       WHERE id = $1`,
      [matchId, motivo || null]
    );

    // Avanzar contador
    await client.query(
      `UPDATE events SET numero_pelea_actual = numero_pelea_actual + 1 WHERE id = $1`,
      [match.event_id]
    );

    // Activar siguiente
    const siguienteQ = await client.query(
      `UPDATE event_matches SET estado = 'lista'
       WHERE event_id = $1
         AND orden = (SELECT MIN(orden) FROM event_matches
                      WHERE event_id = $1 AND estado = 'pendiente')
       RETURNING *`,
      [match.event_id]
    );
    const siguientePelea = siguienteQ.rows[0] || null;

    await client.query(
      `INSERT INTO event_action_logs (event_id, match_id, room_id, user_id, action_type, payload)
       VALUES ($1, $2, $3, $4, 'pelea_saltada', $5)`,
      [match.event_id, matchId, match.room_id, req.user.id,
       JSON.stringify({ motivo: motivo || null })]
    );

    await client.query('COMMIT');

    io.to(`room_${match.room_id}`).emit('event:match_skipped', {
      event_id:  match.event_id,
      match_id:  Number(matchId),
      siguiente: siguientePelea
    });

    res.json({ ok: true, siguiente: siguientePelea });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || 'Error al saltar pelea' });
  } finally {
    client.release();
  }
});

// -------------------------------------------------------
// DELETE /api/event-matches/:matchId
// Eliminar pelea de la cartelera (solo si evento está programado)
// -------------------------------------------------------
router.delete('/:matchId', requireAdminOrOperator, async (req, res) => {
  const { matchId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const matchQ = await client.query(
      `SELECT em.event_id, e.estado AS event_estado
       FROM event_matches em
       JOIN events e ON e.id = em.event_id
       WHERE em.id = $1 FOR UPDATE`,
      [matchId]
    );
    const match = matchQ.rows[0];
    if (!match) throw new Error('Pelea no encontrada');
    if (match.event_estado !== 'programado') {
      throw new Error('Solo se pueden eliminar peleas de eventos aún no iniciados');
    }

    await client.query(`DELETE FROM event_matches WHERE id = $1`, [matchId]);

    // Recalcular total_peleas
    await client.query(
      `UPDATE events SET total_peleas = (
         SELECT COUNT(*) FROM event_matches WHERE event_id = $1
       ) WHERE id = $1`,
      [match.event_id]
    );

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || 'Error al eliminar pelea' });
  } finally {
    client.release();
  }
});

module.exports = router;