require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Rutas ──────────────────────────────────────────────────────────────────
app.use('/auth',            require('./src/routes/auth'));
app.use('/api/rooms',       require('./src/routes/rooms'));
app.use('/api/bets',        require('./src/routes/bets').router);
app.use('/api/withdrawals', require('./src/routes/withdrawals'));
app.use('/api/admin',       require('./src/routes/admin'));

app.get('/api/me', require('./src/middleware/auth'), async (req, res) => {
  const pool = require('./src/models/db');
  const q = await pool.query(
    'SELECT id, nombre_completo, username, email, puntos, is_admin FROM usuarios WHERE id=$1',
    [req.user.id]
  );
  res.json(q.rows[0]);
});

app.get('/health', (_, res) => res.json({ ok: true }));

// ── Sockets ────────────────────────────────────────────────────────────────
const sockets = require('./src/sockets/index')(io);
app.set('sockets', sockets);

// ── Server ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Servidor corriendo en puerto ${PORT}`));