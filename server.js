require('dotenv').config();

const express = require('express');
const http    = require('http');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { Server } = require('socket.io');

const auth = require('./src/middleware/auth');
const pool = require('./src/models/db');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const sockets = require('./src/sockets/index')(io);
app.set('io', io);
app.set('sockets', sockets);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------
// Servir HTMLs sin extensión desde /public
// -------------------------------------------------------
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((req, res, next) => {
  if (!req.path.includes('.') && req.path !== '/') {
    const filePath = path.join(__dirname, 'public', `${req.path}.html`);
    if (fs.existsSync(filePath)) return res.sendFile(filePath);
  }
  next();
});

// -------------------------------------------------------
// RUTAS
// -------------------------------------------------------
app.use('/auth',              require('./src/routes/auth'));
app.use('/api/rooms',   auth, require('./src/routes/rooms'));
app.use('/api/bets',    auth, require('./src/routes/bets').router);
app.use('/api/withdrawals', auth, require('./src/routes/withdrawals'));
app.use('/api/admin',   auth, require('./src/routes/admin'));

// Nuevas rutas de eventos
app.use('/api/events',        auth, require('./src/routes/events'));
app.use('/api/event-matches', auth, require('./src/routes/event-matches'));

// -------------------------------------------------------
// /api/me
// -------------------------------------------------------
app.get('/api/me', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre_completo, numero_celular, username, email,
              puntos, role, is_admin, created_at
       FROM usuarios WHERE id = $1`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Error en /api/me:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// -------------------------------------------------------
// /health
// -------------------------------------------------------
app.get('/health', async (_, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    console.error('Error en /health:', err);
    res.status(500).json({ ok: false, error: 'DB no disponible' });
  }
});

// -------------------------------------------------------
// Error handlers
// -------------------------------------------------------
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));
process.on('uncaughtException',  (err) => console.error('Uncaught Exception:', err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Servidor corriendo en puerto ${PORT}`));