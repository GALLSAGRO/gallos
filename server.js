require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      is_admin: user.is_admin
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

async function adminOnly(req, res, next) {
  const q = await pool.query('SELECT is_admin FROM usuarios WHERE id=$1', [req.user.id]);
  if (!q.rows[0]?.is_admin) return res.status(403).json({ error: 'Solo admin' });
  req.admin = true;
  next();
}

async function ensureUserHasBalance(userId, amount) {
  const q = await pool.query('SELECT puntos FROM usuarios WHERE id=$1', [userId]);
  if (!q.rows[0]) return false;
  return q.rows[0].puntos >= amount;
}

async function getOpenMatchForOppositeSide(roomId, peleaId, gallo) {
  const opposite = gallo === 'A' ? 'B' : 'A';
  const q = await pool.query(
    `SELECT * FROM apuestas
     WHERE room_id=$1 AND pelea_id=$2 AND gallo=$3 AND estado='pendiente'
     ORDER BY created_at ASC`,
    [roomId, peleaId, opposite]
  );
  return q.rows;
}

async function processMatchingBet({ roomId, peleaId, userId, gallo, puntos }) {
  await pool.query('BEGIN');
  try {
    const userCheck = await pool.query('SELECT puntos FROM usuarios WHERE id=$1 FOR UPDATE', [userId]);
    if (!userCheck.rows[0] || userCheck.rows[0].puntos < puntos) {
      await pool.query('ROLLBACK');
      return { ok: false, error: 'Saldo insuficiente' };
    }

    await pool.query('UPDATE usuarios SET puntos = puntos - $1 WHERE id=$2', [puntos, userId]);

    const betIns = await pool.query(
      `INSERT INTO apuestas (user_id, room_id, pelea_id, gallo, puntos_total, puntos_matched, estado)
       VALUES ($1,$2,$3,$4,$5,0,'pendiente')
       RETURNING *`,
      [userId, roomId, peleaId, gallo, puntos]
    );
    const bet = betIns.rows[0];

    let remaining = puntos;
    const oppositeBets = await getOpenMatchForOppositeSide(roomId, peleaId, gallo);

    for (const ob of oppositeBets) {
      if (remaining <= 0) break;
      const available = ob.puntos_total - ob.puntos_matched;
      if (available <= 0) continue;

      const matched = Math.min(remaining, available);

      await pool.query(
        `INSERT INTO matches (room_id, pelea_id, apuesta_a_id, apuesta_b_id, puntos, comision_pct, comision_monto, ganancia_bruta, ganancia_neta)
         VALUES ($1,$2,$3,$4,$5,10,0,0,0)`,
        [
          roomId,
          peleaId,
          gallo === 'A' ? bet.id : ob.id,
          gallo === 'B' ? bet.id : ob.id,
          matched
        ]
      );

      await pool.query(
        `UPDATE apuestas SET puntos_matched = puntos_matched + $1
         WHERE id IN ($2,$3)`,
        [matched, bet.id, ob.id]
      );

      remaining -= matched;
    }

    await pool.query('COMMIT');
    return { ok: true, bet };
  } catch (e) {
    await pool.query('ROLLBACK');
    return { ok: false, error: 'Error procesando apuesta' };
  }
}

async function closeBetsAndReturnUnmatched(peleaId) {
  const q = await pool.query(
    `SELECT id, user_id, puntos_total, puntos_matched
     FROM apuestas
     WHERE pelea_id=$1 AND estado='pendiente'`,
    [peleaId]
  );

  for (const row of q.rows) {
    const unmatched = row.puntos_total - row.puntos_matched;
    if (unmatched > 0) {
      await pool.query('UPDATE usuarios SET puntos = puntos + $1 WHERE id=$2', [unmatched, row.user_id]);
    }
    await pool.query("UPDATE apuestas SET estado='cerrada' WHERE id=$1", [row.id]);
  }

  await pool.query("UPDATE peleas SET estado='en_vivo', started_at=NOW() WHERE id=$1", [peleaId]);
}

async function settleFight(peleaId, ganador) {
  const matches = await pool.query(
    `SELECT m.*, aa.user_id AS user_a, ab.user_id AS user_b
     FROM matches m
     JOIN apuestas aa ON aa.id = m.apuesta_a_id
     JOIN apuestas ab ON ab.id = m.apuesta_b_id
     WHERE m.pelea_id=$1`,
    [peleaId]
  );

  for (const m of matches.rows) {
    const winnerUserId = ganador === 'A' ? m.user_a : m.user_b;
    const loserUserId = ganador === 'A' ? m.user_b : m.user_a;

    const stake = Number(m.puntos);
    const commission = Math.floor(stake * 0.10);
    const netProfit = stake - commission;
    const payout = stake + netProfit;

    await pool.query('UPDATE usuarios SET puntos = puntos + $1 WHERE id=$2', [payout, winnerUserId]);

    await pool.query(
      `UPDATE matches
       SET comision_monto=$1, ganancia_bruta=$2, ganancia_neta=$3
       WHERE id=$4`,
      [commission, stake, netProfit, m.id]
    );
  }

  await pool.query(
    `UPDATE peleas SET estado='terminada', ganador=$1, ended_at=NOW()
     WHERE id=$2`,
    [ganador, peleaId]
  );
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/rooms', async (req, res) => {
  const q = await pool.query('SELECT * FROM rooms ORDER BY id ASC');
  res.json(q.rows);
});

app.get('/api/rooms/:slug/fights', async (req, res) => {
  const q = await pool.query(
    `SELECT p.*
     FROM peleas p
     JOIN rooms r ON r.id = p.room_id
     WHERE r.slug=$1
     ORDER BY p.created_at DESC`,
    [req.params.slug]
  );
  res.json(q.rows);
});

app.post('/auth/register', async (req, res) => {
  try {
    const { nombre_completo, numero_celular, username, email, password } = req.body;
    if (!nombre_completo || !numero_celular || !username || !email || !password) {
      return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }

    const checks = await Promise.all([
      pool.query('SELECT 1 FROM usuarios WHERE numero_celular=$1', [numero_celular]),
      pool.query('SELECT 1 FROM usuarios WHERE username=$1', [username]),
      pool.query('SELECT 1 FROM usuarios WHERE email=$1', [email])
    ]);

    if (checks[0].rows.length) return res.status(409).json({ error: 'Número ya registrado' });
    if (checks[1].rows.length) return res.status(409).json({ error: 'Username ya existe' });
    if (checks[2].rows.length) return res.status(409).json({ error: 'Email ya registrado' });

    const hash = await bcrypt.hash(password, 12);
    const q = await pool.query(
      `INSERT INTO usuarios (nombre_completo, numero_celular, username, email, password_hash)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, nombre_completo, numero_celular, username, email, puntos, is_admin`,
      [nombre_completo, numero_celular, username, email, hash]
    );

    const user = q.rows[0];
    const token = signToken(user);
    res.json({ ok: true, token, user });
  } catch (e) {
    res.status(500).json({ error: 'Error de registro' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    const q = await pool.query(
      `SELECT * FROM usuarios
       WHERE numero_celular=$1 OR username=$1 OR email=$1
       LIMIT 1`,
      [identifier]
    );

    const user = q.rows[0];
    if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });

    const token = signToken(user);
    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        nombre_completo: user.nombre_completo,
        username: user.username,
        email: user.email,
        puntos: user.puntos,
        is_admin: user.is_admin
      }
    });
  } catch {
    res.status(500).json({ error: 'Error de login' });
  }
});

app.get('/api/me', auth, async (req, res) => {
  const q = await pool.query(
    `SELECT id, nombre_completo, numero_celular, username, email, puntos, is_admin
     FROM usuarios
     WHERE id=$1`,
    [req.user.id]
  );
  res.json(q.rows[0]);
});

app.post('/api/bets', auth, async (req, res) => {
  const { room_id, pelea_id, gallo, puntos } = req.body;
  const amount = parseInt(puntos, 10);
  if (!room_id || !pelea_id || !['A', 'B'].includes(gallo) || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Datos inválidos' });
  }

  const fightQ = await pool.query('SELECT estado FROM peleas WHERE id=$1 AND room_id=$2', [pelea_id, room_id]);
  if (!fightQ.rows[0]) return res.status(404).json({ error: 'Pelea no encontrada' });
  if (fightQ.rows[0].estado !== 'apostando') return res.status(400).json({ error: 'Apuestas cerradas' });

  const result = await processMatchingBet({
    roomId: room_id,
    peleaId: pelea_id,
    userId: req.user.id,
    gallo,
    puntos: amount
  });

  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true, bet: result.bet });
});

app.get('/api/bets/my', auth, async (req, res) => {
  const q = await pool.query(
    `SELECT * FROM apuestas
     WHERE user_id=$1
     ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json(q.rows);
});

app.post('/api/withdrawals', auth, async (req, res) => {
  const { amount, destination } = req.body;
  const amt = parseInt(amount, 10);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Monto inválido' });

  const userQ = await pool.query('SELECT puntos FROM usuarios WHERE id=$1', [req.user.id]);
  const points = userQ.rows[0]?.puntos ?? 0;
  if (points < amt) return res.status(400).json({ error: 'Saldo insuficiente' });

  const q = await pool.query(
    `INSERT INTO withdrawal_requests (user_id, amount, status, destination)
     VALUES ($1,$2,'pending',$3)
     RETURNING *`,
    [req.user.id, amt, destination || null]
  );
  res.json({ ok: true, request: q.rows[0] });
});

app.get('/api/withdrawals/my', auth, async (req, res) => {
  const q = await pool.query(
    `SELECT * FROM withdrawal_requests
     WHERE user_id=$1
     ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json(q.rows);
});

app.get('/api/admin/withdrawals', auth, adminOnly, async (req, res) => {
  const q = await pool.query(
    `SELECT w.*, u.username, u.nombre_completo
     FROM withdrawal_requests w
     JOIN usuarios u ON u.id = w.user_id
     ORDER BY w.created_at DESC`
  );
  res.json(q.rows);
});

app.post('/api/admin/withdrawals/:id/approve', auth, adminOnly, async (req, res) => {
  const id = req.params.id;
  const q = await pool.query('SELECT * FROM withdrawal_requests WHERE id=$1 AND status=$2', [id, 'pending']);
  if (!q.rows[0]) return res.status(404).json({ error: 'Solicitud no encontrada' });

  await pool.query('BEGIN');
  try {
    const reqw = q.rows[0];
    await pool.query('UPDATE usuarios SET puntos = puntos - $1 WHERE id=$2', [reqw.amount, reqw.user_id]);
    await pool.query(
      `UPDATE withdrawal_requests
       SET status='approved', updated_at=NOW()
       WHERE id=$1`,
      [id]
    );
    await pool.query('COMMIT');
    res.json({ ok: true });
  } catch {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: 'Error aprobando retiro' });
  }
});

app.post('/api/admin/withdrawals/:id/reject', auth, adminOnly, async (req, res) => {
  const id = req.params.id;
  await pool.query(
    `UPDATE withdrawal_requests
     SET status='rejected', admin_note=$2, updated_at=NOW()
     WHERE id=$1`,
    [id, req.body.note || null]
  );
  res.json({ ok: true });
});

app.post('/api/admin/fights', auth, adminOnly, async (req, res) => {
  const { room_id, gallo_a, gallo_b } = req.body;
  if (!room_id || !gallo_a || !gallo_b) return res.status(400).json({ error: 'Datos inválidos' });

  const q = await pool.query(
    `INSERT INTO peleas (room_id, gallo_a, gallo_b, estado)
     VALUES ($1,$2,$3,'apostando')
     RETURNING *`,
    [room_id, gallo_a, gallo_b]
  );
  res.json({ ok: true, fight: q.rows[0] });
});

app.post('/api/admin/fights/:id/close-bets', auth, adminOnly, async (req, res) => {
  const fightId = req.params.id;
  await closeBetsAndReturnUnmatched(fightId);
  io.emit('fight-updated', { fightId, estado: 'en_vivo' });
  res.json({ ok: true });
});

app.post('/api/admin/fights/:id/winner', auth, adminOnly, async (req, res) => {
  const fightId = req.params.id;
  const { ganador } = req.body;
  if (!['A', 'B'].includes(ganador)) return res.status(400).json({ error: 'Ganador inválido' });

  await settleFight(fightId, ganador);
  io.emit('fight-result', { fightId, ganador });
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomSlug }) => {
    socket.join(`room:${roomSlug}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});