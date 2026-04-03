const router = require('express').Router();
const pool = require('../models/db');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/admin');

router.use(auth, adminOnly);

// -------------------------------------------------------
// HELPERS
// -------------------------------------------------------
function getSockets(req) {
  try { return req.app.get('sockets') || null; }
  catch (e) { console.error('getSockets error:', e); return null; }
}

function emitSafe(fn) {
  try { fn(); } catch (e) { console.error('socket emit error:', e); }
}

async function emitRoomRefresh(req, roomIdOrSlug) {
  try {
    const sockets = getSockets(req);
    if (!sockets) return;

    let room = null;
    if (typeof roomIdOrSlug === 'number' || /^\d+$/.test(String(roomIdOrSlug))) {
      const q = await pool.query('SELECT id, slug FROM rooms WHERE id = $1 LIMIT 1', [Number(roomIdOrSlug)]);
      room = q.rows[0] || null;
    } else {
      const q = await pool.query('SELECT id, slug FROM rooms WHERE slug = $1 LIMIT 1', [String(roomIdOrSlug)]);
      room = q.rows[0] || null;
    }
    if (!room) return;

    emitSafe(() => { if (typeof sockets.emitRoomStateBySlug === 'function')  sockets.emitRoomStateBySlug(room.slug); });
    emitSafe(() => { if (typeof sockets.emitHistoryBySlug === 'function')    sockets.emitHistoryBySlug(room.slug); });
    emitSafe(() => { if (typeof sockets.emitPoolByRoomId === 'function')     sockets.emitPoolByRoomId(room.id); });
    emitSafe(() => { if (typeof sockets.emitRoomRefresh === 'function')      sockets.emitRoomRefresh(room.slug); });
  } catch (e) { console.error('emitRoomRefresh error:', e); }
}

// -------------------------------------------------------
// Liquidar ganador (winner_side: 'R' o 'V')
// Aplica a apuestas ligadas a event_match_id o pelea_id
// -------------------------------------------------------
async function settleFightResult(client, fightId, winnerSide) {
  const fightQ = await client.query(
    `SELECT id, room_id, gallo_a, gallo_b, estado FROM peleas WHERE id = $1 FOR UPDATE`,
    [fightId]
  );
  const fight = fightQ.rows[0];
  if (!fight) throw new Error('Pelea no encontrada');
  if (fight.estado === 'finalizada') throw new Error('La pelea ya fue liquidada');
  if (!['A', 'B'].includes(winnerSide)) throw new Error('Ganador inválido');

  const winnerGallo = winnerSide === 'A' ? fight.gallo_a : fight.gallo_b;
  const loserGallo  = winnerSide === 'A' ? fight.gallo_b : fight.gallo_a;

  const betsQ = await client.query(
    `SELECT id, user_id, gallo, puntos_total, puntos_matched, estado
     FROM apuestas WHERE pelea_id = $1 FOR UPDATE`,
    [fightId]
  );
  const bets = betsQ.rows;

  let totalWinnerMatched = 0;
  let totalLoserMatched  = 0;

  for (const bet of bets) {
    const matched = Number(bet.puntos_matched || 0);
    if (matched <= 0) continue;
    if (bet.gallo === winnerGallo) totalWinnerMatched += matched;
    if (bet.gallo === loserGallo)  totalLoserMatched  += matched;
  }

  const commissionPct        = 0.10;
  const totalCommission      = Number((totalLoserMatched * commissionPct).toFixed(2));
  const distributableLoserPool = Number((totalLoserMatched - totalCommission).toFixed(2));
  const updates = [];

  for (const bet of bets) {
    const total    = Number(bet.puntos_total   || 0);
    const matched  = Number(bet.puntos_matched || 0);
    const unmatched = Number((total - matched).toFixed(2));

    if (bet.gallo === winnerGallo) {
      let grossProfit = 0, netProfit = 0, commissionAmount = 0;
      let payout = unmatched;

      if (matched > 0 && totalWinnerMatched > 0) {
        grossProfit      = Number(((matched / totalWinnerMatched) * totalLoserMatched).toFixed(2));
        commissionAmount = Number((grossProfit * commissionPct).toFixed(2));
        netProfit        = Number((grossProfit - commissionAmount).toFixed(2));
        payout           = Number((unmatched + matched + netProfit).toFixed(2));
      }

      await client.query(
        `UPDATE usuarios SET puntos = puntos + $1 WHERE id = $2`,
        [payout, bet.user_id]
      );
      await client.query(
        `UPDATE apuestas SET estado = 'ganada' WHERE id = $1`,
        [bet.id]
      );
      updates.push({ betId: bet.id, userId: bet.user_id, status: 'ganada', payout });

    } else if (bet.gallo === loserGallo) {
      if (unmatched > 0) {
        await client.query(
          `UPDATE usuarios SET puntos = puntos + $1 WHERE id = $2`,
          [unmatched, bet.user_id]
        );
      }
      await client.query(
        `UPDATE apuestas SET estado = 'perdida' WHERE id = $1`,
        [bet.id]
      );
      updates.push({ betId: bet.id, userId: bet.user_id, status: 'perdida' });

    } else {
      // apuesta sin cruzar — devolver todo
      if (total > 0) {
        await client.query(
          `UPDATE usuarios SET puntos = puntos + $1 WHERE id = $2`,
          [total, bet.user_id]
        );
      }
      await client.query(
        `UPDATE apuestas SET estado = 'devuelta' WHERE id = $1`,
        [bet.id]
      );
      updates.push({ betId: bet.id, userId: bet.user_id, status: 'devuelta', payout: total });
    }
  }

  await client.query(
    `UPDATE peleas SET estado = 'finalizada', ganador = $2, ended_at = NOW() WHERE id = $1`,
    [fightId, winnerGallo]
  );

  return { fightId, roomId: fight.room_id, winner: winnerGallo, totalCommission, distributableLoserPool, updates };
}

// -------------------------------------------------------
// Declarar tablas
// -------------------------------------------------------
async function settleFightDraw(client, fightId) {
  const fightQ = await client.query(
    `SELECT id, room_id, gallo_a, gallo_b, estado FROM peleas WHERE id = $1 FOR UPDATE`,
    [fightId]
  );
  const fight = fightQ.rows[0];
  if (!fight) throw new Error('Pelea no encontrada');
  if (fight.estado === 'finalizada') throw new Error('La pelea ya fue liquidada');

  const betsQ = await client.query(
    `SELECT id, user_id, puntos_total FROM apuestas WHERE pelea_id = $1 FOR UPDATE`,
    [fightId]
  );
  for (const bet of betsQ.rows) {
    const refund = Number(bet.puntos_total || 0);
    if (refund > 0) {
      await client.query(`UPDATE usuarios SET puntos = puntos + $1 WHERE id = $2`, [refund, bet.user_id]);
    }
    await client.query(`UPDATE apuestas SET estado = 'tabla' WHERE id = $1`, [bet.id]);
  }

  await client.query(
    `UPDATE peleas SET estado = 'finalizada', ganador = 'TABLA', ended_at = NOW() WHERE id = $1`,
    [fightId]
  );
  return { fightId, roomId: fight.room_id, result: 'TABLA' };
}

// -------------------------------------------------------
// Cerrar apuestas y devolver no cruzadas
// -------------------------------------------------------
async function refundPendingAndClose(client, fightId) {
  const fightQ = await client.query(
    `SELECT id, room_id, gallo_a, gallo_b, estado FROM peleas WHERE id = $1 FOR UPDATE`,
    [fightId]
  );
  const fight = fightQ.rows[0];
  if (!fight) throw new Error('Pelea no encontrada');

  const betsQ = await client.query(
    `SELECT id, user_id, puntos_total, puntos_matched FROM apuestas WHERE pelea_id = $1 FOR UPDATE`,
    [fightId]
  );
  for (const bet of betsQ.rows) {
    const total    = Number(bet.puntos_total   || 0);
    const matched  = Number(bet.puntos_matched || 0);
    const pending  = Number((total - matched).toFixed(2));
    if (pending > 0) {
      await client.query(`UPDATE usuarios SET puntos = puntos + $1 WHERE id = $2`, [pending, bet.user_id]);
    }
    await client.query(
      `UPDATE apuestas SET estado = CASE WHEN puntos_matched > 0 THEN 'matcheada' ELSE 'cerrada' END WHERE id = $1`,
      [bet.id]
    );
  }

  await client.query(
    `UPDATE peleas SET estado = 'cerrada', ended_at = NOW() WHERE id = $1`,
    [fightId]
  );
  return { fightId, roomId: fight.room_id };
}

// =======================================================
// ROOMS
// =======================================================

router.get('/rooms', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, slug, facebook_live_url, activos, created_at
       FROM rooms ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error al obtener salas' }); }
});

router.post('/rooms', async (req, res) => {
  try {
    const { nombre, slug, facebook_live_url, activos } = req.body;
    if (!nombre || !slug) return res.status(400).json({ error: 'nombre y slug son obligatorios' });

    const { rows } = await pool.query(
      `INSERT INTO rooms (nombre, slug, facebook_live_url, activos)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [nombre, slug, facebook_live_url || null, activos === undefined ? true : !!activos]
    );
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error al crear sala' }); }
});

router.put('/rooms/:roomid', async (req, res) => {
  try {
    const roomId = Number(req.params.roomid);
    const { nombre, slug, facebook_live_url, activos } = req.body;

    const { rows } = await pool.query(
      `UPDATE rooms
       SET nombre = COALESCE($2, nombre),
           slug   = COALESCE($3, slug),
           facebook_live_url = COALESCE($4, facebook_live_url),
           activos = COALESCE($5, activos)
       WHERE id = $1 RETURNING *`,
      [roomId, nombre, slug, facebook_live_url, activos]
    );
    if (!rows.length) return res.status(404).json({ error: 'Sala no encontrada' });

    await emitRoomRefresh(req, roomId);
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error al actualizar sala' }); }
});

// =======================================================
// FIGHTS (peleas — sistema legacy, sigue funcionando)
// =======================================================

router.get('/rooms/:roomid/active-fight', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, room_id, gallo_a, gallo_b, estado, ganador, created_at
       FROM peleas WHERE room_id = $1 AND estado IN ('pendiente','abierta')
       ORDER BY created_at ASC LIMIT 1`,
      [Number(req.params.roomid)]
    );
    res.json(rows[0] || null);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error al obtener pelea activa' }); }
});

router.get('/rooms/:roomid/fights', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, room_id, gallo_a, gallo_b, estado, ganador, created_at
       FROM peleas WHERE room_id = $1 ORDER BY created_at ASC`,
      [Number(req.params.roomid)]
    );
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error al obtener peleas' }); }
});

router.post('/rooms/:roomid/fights', async (req, res) => {
  try {
    const roomId = Number(req.params.roomid);
    const { gallo_a, gallo_b } = req.body;
    if (!gallo_a || !gallo_b) return res.status(400).json({ error: 'gallo_a y gallo_b son obligatorios' });

    const { rows } = await pool.query(
      `INSERT INTO peleas (room_id, gallo_a, gallo_b, estado) VALUES ($1, $2, $3, 'pendiente') RETURNING *`,
      [roomId, gallo_a, gallo_b]
    );
    await emitRoomRefresh(req, roomId);
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error al crear pelea' }); }
});

router.post('/rooms/:roomid/open-bets/:peleaid', async (req, res) => {
  try {
    const roomId  = Number(req.params.roomid);
    const peleaId = Number(req.params.peleaid);
    const { rows } = await pool.query(
      `UPDATE peleas SET estado = 'abierta' WHERE id = $1 AND room_id = $2 RETURNING *`,
      [peleaId, roomId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pelea no encontrada' });
    await emitRoomRefresh(req, roomId);
    res.json({ ok: true, fight: rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error al abrir apuestas' }); }
});

router.post('/rooms/:roomid/close-bets/:peleaid', async (req, res) => {
  const client = await pool.connect();
  try {
    const roomId  = Number(req.params.roomid);
    const peleaId = Number(req.params.peleaid);
    await client.query('BEGIN');
    const result = await refundPendingAndClose(client, peleaId);
    await client.query('COMMIT');
    await emitRoomRefresh(req, roomId);
    res.json({ ok: true, result });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: e.message || 'Error al cerrar apuestas' });
  } finally { client.release(); }
});

router.post('/rooms/:roomid/winner/:peleaid', async (req, res) => {
  const client = await pool.connect();
  try {
    const roomId  = Number(req.params.roomid);
    const peleaId = Number(req.params.peleaid);
    const { ganador } = req.body;
    await client.query('BEGIN');
    const result = await settleFightResult(client, peleaId, ganador);
    await client.query('COMMIT');
    await emitRoomRefresh(req, roomId);
    res.json({ ok: true, result });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: e.message || 'Error al liquidar ganador' });
  } finally { client.release(); }
});

router.post('/rooms/:roomid/draw/:peleaid', async (req, res) => {
  const client = await pool.connect();
  try {
    const roomId  = Number(req.params.roomid);
    const peleaId = Number(req.params.peleaid);
    await client.query('BEGIN');
    const result = await settleFightDraw(client, peleaId);
    await client.query('COMMIT');
    await emitRoomRefresh(req, roomId);
    res.json({ ok: true, result });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: e.message || 'Error al declarar tabla' });
  } finally { client.release(); }
});

router.post('/rooms/:roomid/saltar-pelea/:peleaid', async (req, res) => {
  const client = await pool.connect();
  try {
    const roomId  = Number(req.params.roomid);
    const peleaId = Number(req.params.peleaid);
    await client.query('BEGIN');

    const fightQ = await client.query(
      `SELECT id, room_id, estado FROM peleas WHERE id = $1 AND room_id = $2 FOR UPDATE`,
      [peleaId, roomId]
    );
    const fight = fightQ.rows[0];
    if (!fight) throw new Error('Pelea no encontrada');
    if (fight.estado === 'finalizada') throw new Error('No puedes saltar una pelea finalizada');

    const betsQ = await client.query(
      `SELECT id, user_id, puntos_total, puntos_matched FROM apuestas WHERE pelea_id = $1 FOR UPDATE`,
      [peleaId]
    );
    for (const bet of betsQ.rows) {
      const total   = Number(bet.puntos_total   || 0);
      const matched = Number(bet.puntos_matched || 0);
      const refund  = Number((total - matched).toFixed(2));
      if (refund > 0) {
        await client.query(`UPDATE usuarios SET puntos = puntos + $1 WHERE id = $2`, [refund, bet.user_id]);
      }
      await client.query(
        `UPDATE apuestas SET estado = CASE WHEN puntos_matched > 0 THEN estado ELSE 'saltada' END WHERE id = $1`,
        [bet.id]
      );
    }

    await client.query(
      `UPDATE peleas SET estado = 'saltada', ended_at = NOW() WHERE id = $1`,
      [peleaId]
    );

    // Activar siguiente pelea pendiente
    const nextQ = await client.query(
      `SELECT id FROM peleas WHERE room_id = $1 AND estado = 'pendiente' ORDER BY created_at ASC LIMIT 1`,
      [roomId]
    );
    let nextFight = null;
    if (nextQ.rows.length) {
      const { rows } = await client.query(
        `UPDATE peleas SET estado = 'abierta' WHERE id = $1 RETURNING *`,
        [nextQ.rows[0].id]
      );
      nextFight = rows[0] || null;
    }

    await client.query('COMMIT');
    await emitRoomRefresh(req, roomId);
    res.json({ ok: true, skippedFightId: peleaId, nextFight });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: e.message || 'Error al saltar pelea' });
  } finally { client.release(); }
});

// =======================================================
// USERS / PUNTOS
// =======================================================

router.get('/users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, email, nombre_completo, numero_celular, puntos, role, is_admin, created_at
       FROM usuarios ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error al obtener usuarios' }); }
});

router.post('/users/:id/points', async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = Number(req.params.id);
    const amount = Number(req.body.amount || 0);
    const motivo = req.body.reason || req.body.motivo || null;

    if (!amount || Number.isNaN(amount)) return res.status(400).json({ error: 'amount inválido' });

    await client.query('BEGIN');

    const uQ = await client.query(
      `UPDATE usuarios SET puntos = puntos + $2 WHERE id = $1 RETURNING id, username, puntos`,
      [userId, amount]
    );
    if (!uQ.rows.length) throw new Error('Usuario no encontrado');

    // Registrar en wallet_adjustments (reemplaza puntos_logs)
    await client.query(
      `INSERT INTO wallet_adjustments (user_id, admin_user_id, adjustment_type, puntos, motivo)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, req.user.id, amount > 0 ? 'suma' : 'resta', Math.abs(amount), motivo]
    );

    await client.query('COMMIT');
    res.json({ ok: true, user: uQ.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: e.message || 'Error al ajustar puntos' });
  } finally { client.release(); }
});

// =======================================================
// WITHDRAWALS
// =======================================================

router.get('/withdrawals', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT w.id, w.user_id, w.amount, w.status, w.created_at,
              u.username, u.nombre_completo, u.numero_celular
       FROM withdrawal_requests w
       JOIN usuarios u ON u.id = w.user_id
       ORDER BY w.created_at DESC`
    );
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error al obtener retiros' }); }
});

router.post('/withdrawals/:id/approve', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE withdrawal_requests SET status = 'approved', approved_by = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [Number(req.params.id), req.user.id]
    );
    if (!rows.length) throw new Error('Retiro no encontrado o ya procesado');
    await client.query('COMMIT');
    res.json({ ok: true, withdrawal: rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: e.message || 'Error al aprobar retiro' });
  } finally { client.release(); }
});

router.post('/withdrawals/:id/reject', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wQ = await client.query(
      `SELECT id, user_id, amount, status FROM withdrawal_requests WHERE id = $1 FOR UPDATE`,
      [Number(req.params.id)]
    );
    const w = wQ.rows[0];
    if (!w) throw new Error('Retiro no encontrado');
    if (w.status !== 'pending') throw new Error('El retiro ya fue procesado');

    await client.query(`UPDATE usuarios SET puntos = puntos + $1 WHERE id = $2`, [w.amount, w.user_id]);
    await client.query(
      `UPDATE withdrawal_requests SET status = 'rejected', updated_at = NOW() WHERE id = $1`,
      [w.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: e.message || 'Error al rechazar retiro' });
  } finally { client.release(); }
});

module.exports = router;