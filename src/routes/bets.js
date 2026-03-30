const router = require('express').Router();
const pool = require('../models/db');
const auth = require('../middleware/auth');

async function processMatchingBet({ roomId, peleaId, userId, gallo, puntos }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userCheck = await client.query(
      'SELECT puntos FROM usuarios WHERE id=$1 FOR UPDATE', [userId]
    );
    if (!userCheck.rows[0] || userCheck.rows[0].puntos < puntos) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Saldo insuficiente' };
    }

    await client.query('UPDATE usuarios SET puntos = puntos - $1 WHERE id=$2', [puntos, userId]);

    const betIns = await client.query(
      `INSERT INTO apuestas (user_id, room_id, pelea_id, gallo, puntos_total, puntos_matched, estado)
       VALUES ($1,$2,$3,$4,$5,0,'pendiente') RETURNING *`,
      [userId, roomId, peleaId, gallo, puntos]
    );
    const bet = betIns.rows[0];
    const opposite = gallo === 'A' ? 'B' : 'A';

    const oppBets = await client.query(
      `SELECT * FROM apuestas
       WHERE room_id=$1 AND pelea_id=$2 AND gallo=$3 AND estado='pendiente'
       ORDER BY created_at ASC`,
      [roomId, peleaId, opposite]
    );

    let remaining = puntos;
    for (const ob of oppBets.rows) {
      if (remaining <= 0) break;
      const available = ob.puntos_total - ob.puntos_matched;
      if (available <= 0) continue;

      const matched = Math.min(remaining, available);

      await client.query(
        `INSERT INTO matches (room_id, pelea_id, apuesta_a_id, apuesta_b_id, puntos, comision_pct)
         VALUES ($1,$2,$3,$4,$5,10)`,
        [
          roomId, peleaId,
          gallo === 'A' ? bet.id : ob.id,
          gallo === 'B' ? bet.id : ob.id,
          matched
        ]
      );

      await client.query(
        `UPDATE apuestas SET puntos_matched = puntos_matched + $1 WHERE id IN ($2,$3)`,
        [matched, bet.id, ob.id]
      );

      const newMatchedOb = ob.puntos_matched + matched;
      if (newMatchedOb >= ob.puntos_total) {
        await client.query("UPDATE apuestas SET estado='matcheada' WHERE id=$1", [ob.id]);
      }

      remaining -= matched;
    }

    if (remaining === 0) {
      await client.query("UPDATE apuestas SET estado='matcheada' WHERE id=$1", [bet.id]);
    }

    await client.query('COMMIT');
    return { ok: true, bet, unmatched: remaining };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    return { ok: false, error: 'Error procesando apuesta' };
  } finally {
    client.release();
  }
}

router.post('/', auth, async (req, res) => {
  const { room_id, pelea_id, gallo, puntos } = req.body;
  const amount = parseInt(puntos, 10);
  if (!room_id || !pelea_id || !['A','B'].includes(gallo) || !amount || amount <= 0)
    return res.status(400).json({ error: 'Datos invalidos' });

  const fightQ = await pool.query(
    'SELECT estado FROM peleas WHERE id=$1 AND room_id=$2', [pelea_id, room_id]
  );
  if (!fightQ.rows[0]) return res.status(404).json({ error: 'Pelea no encontrada' });
  if (fightQ.rows[0].estado !== 'apostando') return res.status(400).json({ error: 'Apuestas cerradas' });

  const result = await processMatchingBet({
    roomId: room_id, peleaId: pelea_id,
    userId: req.user.id, gallo, puntos: amount
  });

  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true, bet: result.bet, unmatched: result.unmatched });
});

router.get('/my', auth, async (req, res) => {
  const q = await pool.query(
    `SELECT a.*, p.gallo_a, p.gallo_b, p.ganador, r.nombre AS sala
     FROM apuestas a
     JOIN peleas p ON p.id = a.pelea_id
     JOIN rooms r ON r.id = a.room_id
     WHERE a.user_id=$1
     ORDER BY a.created_at DESC`,
    [req.user.id]
  );
  res.json(q.rows);
});

router.get('/fight/:peleaId', auth, async (req, res) => {
  const q = await pool.query(
    `SELECT gallo, SUM(puntos_total) AS total, SUM(puntos_matched) AS matched
     FROM apuestas WHERE pelea_id=$1 GROUP BY gallo`,
    [req.params.peleaId]
  );
  res.json(q.rows);
});

module.exports = { router, processMatchingBet };