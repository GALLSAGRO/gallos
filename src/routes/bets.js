const express = require('express');
const router = express.Router();
const pool = require('../models/db');
const auth = require('../middleware/auth');

// -------------------------------------------------------
// HELPER: emitir pool actualizado via socket
// -------------------------------------------------------
async function emitPoolUpdate(req, roomId, eventMatchId, userId = null) {
  try {
    const poolQ = await pool.query(
      `SELECT gallo,
              COALESCE(SUM(puntos_total), 0) AS total,
              COALESCE(SUM(puntos_matched), 0) AS matched
       FROM apuestas
       WHERE event_match_id = $1
       GROUP BY gallo`,
      [eventMatchId]
    );

    const roomQ = await pool.query('SELECT slug FROM rooms WHERE id = $1', [roomId]);
    const sockets = req.app.get('sockets');

    if (!sockets || !roomQ.rows[0]) return;

    const payload = { pool: poolQ.rows };

    if (userId) {
      const meQ = await pool.query('SELECT puntos FROM usuarios WHERE id = $1', [userId]);
      if (meQ.rows[0]) payload.me = { puntos: meQ.rows[0].puntos };
    }

    if (typeof sockets.emitBetPlaced === 'function') {
      sockets.emitBetPlaced(roomQ.rows[0].slug, payload);
    }
  } catch (err) {
    console.error('emitPoolUpdate error:', err);
  }
}

// -------------------------------------------------------
// HELPER: procesar apuesta con cruce automático
// -------------------------------------------------------
async function processMatchingBet({ roomId, eventMatchId, eventId, userId, gallo, puntos }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verificar saldo
    const userQ = await client.query(
      `SELECT puntos FROM usuarios WHERE id = $1 FOR UPDATE`,
      [userId]
    );

    if (!userQ.rows[0] || Number(userQ.rows[0].puntos) < puntos) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Saldo insuficiente' };
    }

    // Verificar que la pelea acepta apuestas
    const matchQ = await client.query(
      `SELECT id, estado
       FROM event_matches
       WHERE id = $1 AND event_id = $2
       FOR UPDATE`,
      [eventMatchId, eventId]
    );

    if (!matchQ.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Pelea no encontrada' };
    }

    if (!['lista', 'apostando'].includes(matchQ.rows[0].estado)) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Apuestas cerradas para esta pelea' };
    }

    // Poner estado 'apostando' si estaba en 'lista'
    if (matchQ.rows[0].estado === 'lista') {
      await client.query(
        `UPDATE event_matches
         SET estado = 'apostando', betting_opened_at = NOW()
         WHERE id = $1`,
        [eventMatchId]
      );
    }

    // Descontar puntos al usuario
    await client.query(
      `UPDATE usuarios
       SET puntos = puntos - $1
       WHERE id = $2`,
      [puntos, userId]
    );

    // Insertar apuesta — gallo válido: 'R' o 'V'
    const betIns = await client.query(
      `INSERT INTO apuestas
        (user_id, room_id, event_id, event_match_id, gallo, puntos_total, puntos_matched, estado)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 'pendiente')
       RETURNING *`,
      [userId, roomId, eventId, eventMatchId, gallo, puntos]
    );

    const bet = betIns.rows[0];
    const opposite = gallo === 'R' ? 'V' : 'R';

    // Cruzar con apuestas del lado contrario
    const oppBets = await client.query(
      `SELECT * FROM apuestas
       WHERE event_match_id = $1 AND gallo = $2 AND estado = 'pendiente'
       ORDER BY created_at ASC
       FOR UPDATE`,
      [eventMatchId, opposite]
    );

    let remaining = puntos;

    for (const ob of oppBets.rows) {
      if (remaining <= 0) break;

      const available = Number(ob.puntos_total) - Number(ob.puntos_matched);
      if (available <= 0) continue;

      const matched = Math.min(remaining, available);

      await client.query(
        `INSERT INTO matches
          (room_id, event_id, event_match_id, apuesta_a_id, apuesta_b_id,
           user_a_id, user_b_id, puntos, comision_pct)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 10.00)`,
        [
          roomId,
          eventId,
          eventMatchId,
          gallo === 'R' ? bet.id : ob.id,
          gallo === 'V' ? bet.id : ob.id,
          gallo === 'R' ? userId : ob.user_id,
          gallo === 'V' ? userId : ob.user_id,
          matched
        ]
      );

      await client.query(
        `UPDATE apuestas
         SET puntos_matched = puntos_matched + $1
         WHERE id IN ($2, $3)`,
        [matched, bet.id, ob.id]
      );

      if (Number(ob.puntos_matched) + matched >= Number(ob.puntos_total)) {
        await client.query(
          `UPDATE apuestas SET estado = 'matcheada' WHERE id = $1`,
          [ob.id]
        );
      }

      remaining -= matched;
    }

    if (remaining === 0) {
      await client.query(
        `UPDATE apuestas SET estado = 'matcheada' WHERE id = $1`,
        [bet.id]
      );
    }

    const updatedBet = await client.query(
      `SELECT * FROM apuestas WHERE id = $1`,
      [bet.id]
    );

    await client.query('COMMIT');

    return { ok: true, bet: updatedBet.rows[0], unmatched: remaining };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('processMatchingBet error:', err);
    return { ok: false, error: 'Error procesando apuesta' };
  } finally {
    client.release();
  }
}

// -------------------------------------------------------
// POST /api/bets
// -------------------------------------------------------
router.post('/', auth, async (req, res) => {
  try {
    const roomId = Number(req.body.room_id);
    const eventId = Number(req.body.event_id);
    const eventMatchId = Number(req.body.event_match_id);
    const gallo = String(req.body.gallo || '').trim().toUpperCase();
    const puntos = parseInt(req.body.puntos, 10);

    if (!roomId || !eventId || !eventMatchId || !['R', 'V'].includes(gallo) || !puntos || puntos <= 0) {
      return res.status(400).json({ error: 'Datos inválidos. gallo debe ser R o V' });
    }

    const result = await processMatchingBet({
      roomId,
      eventMatchId,
      eventId,
      userId: req.user.id,
      gallo,
      puntos
    });

    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    await emitPoolUpdate(req, roomId, eventMatchId, req.user.id);

    res.json({ ok: true, bet: result.bet, unmatched: result.unmatched });
  } catch (err) {
    console.error('POST /api/bets error:', err);
    res.status(500).json({ error: 'Error al registrar apuesta' });
  }
});

// -------------------------------------------------------
// GET /api/bets/my
// Mis apuestas
// -------------------------------------------------------
router.get('/my', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.gallo, a.puntos_total, a.puntos_matched, a.estado, a.created_at,
              em.numero_pelea, em.resultado, em.equipo_rojo_id, em.equipo_verde_id,
              tr.nombre AS nombre_equipo_rojo,
              tv.nombre AS nombre_equipo_verde,
              r.nombre AS sala
       FROM apuestas a
       JOIN event_matches em ON em.id = a.event_match_id
       JOIN rooms r ON r.id = a.room_id
       LEFT JOIN event_teams tr ON tr.id = em.equipo_rojo_id
       LEFT JOIN event_teams tv ON tv.id = em.equipo_verde_id
       WHERE a.user_id = $1
       ORDER BY a.created_at DESC`,
      [req.user.id]
    );

    res.json(rows);
  } catch (err) {
    console.error('GET /api/bets/my error:', err);
    res.status(500).json({ error: 'Error al obtener apuestas' });
  }
});

// -------------------------------------------------------
// GET /api/bets/match/:eventMatchId
// Pool de apuestas de una pelea
// -------------------------------------------------------
router.get('/match/:eventMatchId', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT gallo,
              COALESCE(SUM(puntos_total), 0) AS total,
              COALESCE(SUM(puntos_matched), 0) AS matched
       FROM apuestas
       WHERE event_match_id = $1
       GROUP BY gallo`,
      [Number(req.params.eventMatchId)]
    );

    res.json(rows);
  } catch (err) {
    console.error('GET /api/bets/match/:eventMatchId error:', err);
    res.status(500).json({ error: 'Error al obtener el pool de apuestas' });
  }
});

module.exports = { router, processMatchingBet };