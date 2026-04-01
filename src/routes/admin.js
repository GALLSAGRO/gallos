const router = require('express').Router();
const pool = require('../models/db');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/admin');


router.post('/rooms', auth, adminOnly, async (req, res) => {
  const { slug, nombre, facebook_live_url } = req.body;
  if (!slug || !nombre) return res.status(400).json({ error: 'slug y nombre requeridos' });
  const q = await pool.query(
    'INSERT INTO rooms (slug, nombre, facebook_live_url, activo) VALUES ($1,$2,$3,true) RETURNING *',
    [slug, nombre, facebook_live_url || null]
  );
  res.json({ ok: true, room: q.rows[0] });
});


router.put('/rooms/:id', auth, adminOnly, async (req, res) => {
  const { nombre, facebook_live_url, activo } = req.body;
  const q = await pool.query(
    `UPDATE rooms SET nombre=$1, facebook_live_url=$2, activo=$3 WHERE id=$4 RETURNING *`,
    [nombre, facebook_live_url, activo, req.params.id]
  );
  if (!q.rows[0]) return res.status(404).json({ error: 'Sala no encontrada' });
  res.json({ ok: true, room: q.rows[0] });
});


router.post('/fights', auth, adminOnly, async (req, res) => {
  const { room_id, gallo_a, gallo_b } = req.body;
  if (!room_id || !gallo_a || !gallo_b) return res.status(400).json({ error: 'Datos invalidos' });

  const active = await pool.query(
    "SELECT id FROM peleas WHERE room_id=$1 AND estado IN ('apostando','en_vivo')",
    [room_id]
  );
  if (active.rows.length) return res.status(409).json({ error: 'Ya hay una pelea activa en esta sala' });

  const q = await pool.query(
    "INSERT INTO peleas (room_id, gallo_a, gallo_b, estado) VALUES ($1,$2,$3,'apostando') RETURNING *",
    [room_id, gallo_a, gallo_b]
  );
  const fight = q.rows[0];

  const roomQ = await pool.query('SELECT slug FROM rooms WHERE id=$1', [room_id]);
  const sockets = req.app.get('sockets');
  if (sockets && roomQ.rows[0]) {
    const slug = roomQ.rows[0].slug;
    sockets.emitFightCreated(slug, fight);
    sockets.emitChat(slug, `⚔️ Nueva pelea: ${gallo_a} vs ${gallo_b} — ¡Apuestas abiertas!`);
    const historial = await pool.query(
      'SELECT * FROM peleas WHERE room_id=$1 ORDER BY created_at DESC', [room_id]
    );
    sockets.emitHistorial(slug, historial.rows);
  }

  res.json({ ok: true, fight });
});


router.post('/fights/:id/close-bets', auth, adminOnly, async (req, res) => {
  const fightId = req.params.id;
  const pending = await pool.query(
    "SELECT id, user_id, puntos_total, puntos_matched FROM apuestas WHERE pelea_id=$1 AND estado='pendiente'",
    [fightId]
  );

  for (const row of pending.rows) {
    const unmatched = row.puntos_total - row.puntos_matched;
    if (unmatched > 0) {
      await pool.query('UPDATE usuarios SET puntos = puntos + $1 WHERE id=$2', [unmatched, row.user_id]);
    }
    await pool.query("UPDATE apuestas SET estado='cerrada' WHERE id=$1", [row.id]);
  }

  await pool.query("UPDATE peleas SET estado='en_vivo', started_at=NOW() WHERE id=$1", [fightId]);

  const roomQ = await pool.query(
    'SELECT r.slug FROM rooms r JOIN peleas p ON p.room_id = r.id WHERE p.id=$1', [fightId]
  );
  const sockets = req.app.get('sockets');
  if (sockets && roomQ.rows[0]) {
    const slug = roomQ.rows[0].slug;
    sockets.emitFightUpdated(slug, { fightId, estado: 'en_vivo' });
    sockets.emitChat(slug, '🔒 Apuestas cerradas — ¡Que empiece la pelea!');
  }

  res.json({ ok: true, refunded: pending.rows.length });
});


router.post('/fights/:id/winner', auth, adminOnly, async (req, res) => {
  const fightId = req.params.id;
  const { ganador } = req.body;
  if (!['A', 'B'].includes(ganador)) return res.status(400).json({ error: 'Ganador invalido' });

  const fightQ = await pool.query('SELECT estado, room_id FROM peleas WHERE id=$1', [fightId]);
  if (!fightQ.rows[0]) return res.status(404).json({ error: 'Pelea no encontrada' });
  if (fightQ.rows[0].estado !== 'en_vivo') return res.status(400).json({ error: 'La pelea no esta en vivo' });

  const matches = await pool.query(
    `SELECT m.*, aa.user_id AS user_a, ab.user_id AS user_b
     FROM matches m
     JOIN apuestas aa ON aa.id = m.apuesta_a_id
     JOIN apuestas ab ON ab.id = m.apuesta_b_id
     WHERE m.pelea_id=$1`,
    [fightId]
  );

  for (const m of matches.rows) {
    const winnerUserId = ganador === 'A' ? m.user_a : m.user_b;
    const stake        = Number(m.puntos);
    const commission   = Math.floor(stake * 0.10);
    const netProfit    = stake - commission;
    const payout       = stake + netProfit;

    await pool.query('UPDATE usuarios SET puntos = puntos + $1 WHERE id=$2', [payout, winnerUserId]);
    await pool.query(
      'UPDATE matches SET comision_monto=$1, ganancia_bruta=$2, ganancia_neta=$3 WHERE id=$4',
      [commission, stake * 2, netProfit, m.id]
    );
  }

  await pool.query(
    "UPDATE peleas SET estado='terminada', ganador=$1, ended_at=NOW() WHERE id=$2",
    [ganador, fightId]
  );

  const roomQ = await pool.query(
    'SELECT r.slug FROM rooms r JOIN peleas p ON p.room_id = r.id WHERE p.id=$1', [fightId]
  );
  const fightData = await pool.query('SELECT * FROM peleas WHERE id=$1', [fightId]);
  const sockets = req.app.get('sockets');

  if (sockets && roomQ.rows[0]) {
    const slug = roomQ.rows[0].slug;

    sockets.emitFightResult(slug, { fight: fightData.rows[0] });

    const historial = await pool.query(
      'SELECT * FROM peleas WHERE room_id=$1 ORDER BY created_at DESC',
      [fightQ.rows[0].room_id]
    );
    sockets.emitHistorial(slug, historial.rows);

    /* ── Mensaje de resultado en el chat ── */
    const galloGanador = ganador === 'A' ? fightData.rows[0].gallo_a : fightData.rows[0].gallo_b;
    sockets.emitChat(slug, `🐓 ¡${galloGanador} GANA! Puntos repartidos a los ganadores`);

    /* ── balance-update individual a cada usuario afectado ── */
    const userIds = [...new Set(matches.rows.flatMap(m => [m.user_a, m.user_b]))];
    for (const uid of userIds) {
      const uq = await pool.query('SELECT puntos FROM usuarios WHERE id=$1', [uid]);
      if (uq.rows[0]) {
        sockets.io.to(`user:${uid}`).emit('balance-update', { puntos: uq.rows[0].puntos });
      }
    }
  }

  res.json({ ok: true, matchesSettled: matches.rows.length });
});


router.get('/withdrawals', auth, adminOnly, async (req, res) => {
  const q = await pool.query(
    `SELECT w.*, u.username, u.nombre_completo, u.numero_celular
     FROM withdrawal_requests w
     JOIN usuarios u ON u.id = w.user_id
     ORDER BY w.created_at DESC`
  );
  res.json(q.rows);
});


router.post('/withdrawals/:id/approve', auth, adminOnly, async (req, res) => {
  const id = req.params.id;
  const q  = await pool.query(
    'SELECT * FROM withdrawal_requests WHERE id=$1 AND status=$2', [id, 'pending']
  );
  if (!q.rows[0]) return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });
  await pool.query("UPDATE withdrawal_requests SET status='approved', updated_at=NOW() WHERE id=$1", [id]);
  res.json({ ok: true });
});


router.post('/withdrawals/:id/reject', auth, adminOnly, async (req, res) => {
  const id = req.params.id;
  const q  = await pool.query(
    'SELECT * FROM withdrawal_requests WHERE id=$1 AND status=$2', [id, 'pending']
  );
  if (!q.rows[0]) return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });
  await pool.query('UPDATE usuarios SET puntos = puntos + $1 WHERE id=$2', [q.rows[0].amount, q.rows[0].user_id]);
  await pool.query(
    "UPDATE withdrawal_requests SET status='rejected', admin_note=$2, updated_at=NOW() WHERE id=$1",
    [id, req.body.note || null]
  );
  res.json({ ok: true });
});


router.post('/add-points', auth, adminOnly, async (req, res) => {
  const { username, puntos } = req.body;
  const amt = parseInt(puntos, 10);
  if (!username || !amt || amt <= 0) return res.status(400).json({ error: 'Datos invalidos' });
  const q = await pool.query(
    'UPDATE usuarios SET puntos = puntos + $1 WHERE username=$2 RETURNING id, username, puntos',
    [amt, username]
  );
  if (!q.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ ok: true, user: q.rows[0] });
});


router.get('/users', auth, adminOnly, async (req, res) => {
  const q = await pool.query(
    'SELECT id, nombre_completo, username, email, numero_celular, puntos, is_admin, created_at FROM usuarios ORDER BY created_at DESC'
  );
  res.json(q.rows);
});


module.exports = router;