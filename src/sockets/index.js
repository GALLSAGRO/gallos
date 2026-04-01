const jwt  = require('jsonwebtoken');
const pool = require('../models/db');

module.exports = function setupSockets(io) {

  /* ── Auth middleware ── */
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (token) {
      try { socket.user = jwt.verify(token, process.env.JWT_SECRET); }
      catch { socket.user = null; }
    }
    next();
  });

  io.on('connection', (socket) => {
    const username = socket.user?.username || 'Anon';
    const userId   = socket.user?.id;

    /* Unirse a room personal para balance-update */
    if (userId) socket.join(`user:${userId}`);

    /* ── join-room ── */
    socket.on('join-room', async ({ roomSlug }) => {
      socket.roomSlug = roomSlug;
      socket.join(`room:${roomSlug}`);

      /* Anunciar entrada en el chat */
      io.to(`room:${roomSlug}`).emit('chat-message', {
        system: true,
        message: `${username} entró a la sala`
      });

      /* Estado actual de la pelea (tu lógica original intacta) */
      const q = await pool.query(
        `SELECT p.* FROM peleas p
         JOIN rooms r ON r.id = p.room_id
         WHERE r.slug=$1 AND p.estado IN ('apostando','en_vivo')
         ORDER BY p.created_at DESC LIMIT 1`,
        [roomSlug]
      );

      if (q.rows[0]) {
        const fight = q.rows[0];
        const poolQ = await pool.query(
          `SELECT gallo, SUM(puntos_total) AS total, SUM(puntos_matched) AS matched
           FROM apuestas WHERE pelea_id=$1 GROUP BY gallo`,
          [fight.id]
        );
        socket.emit('room-state', { fight, pool: poolQ.rows });
      }

      /* Historial */
      const histQ = await pool.query(
        `SELECT p.* FROM peleas p
         JOIN rooms r ON r.id = p.room_id
         WHERE r.slug=$1
         ORDER BY p.created_at DESC`,
        [roomSlug]
      );
      socket.emit('historial', histQ.rows);
    });

    /* ── leave-room ── */
    socket.on('leave-room', ({ roomSlug }) => {
      socket.leave(`room:${roomSlug}`);
      io.to(`room:${roomSlug}`).emit('chat-message', {
        system: true,
        message: `${username} salió de la sala`
      });
    });

    /* ── chat-message ── */
    socket.on('chat-message', ({ roomSlug, message, username: uname }) => {
      if (!roomSlug || !message) return;
      const clean = message.toString().trim().slice(0, 200);
      if (!clean) return;
      io.to(`room:${roomSlug}`).emit('chat-message', {
        username: uname || username,
        message:  clean
      });
    });

    /* ── disconnect ── */
    socket.on('disconnect', () => {
      if (socket.roomSlug) {
        io.to(`room:${socket.roomSlug}`).emit('chat-message', {
          system: true,
          message: `${username} se desconectó`
        });
      }
    });
  });

  /* ── Helpers originales + nuevos ── */
  return {
    io,

    emitFightCreated(roomSlug, fight) {
      io.to(`room:${roomSlug}`).emit('fight-created', fight);
    },
    emitFightUpdated(roomSlug, data) {
      io.to(`room:${roomSlug}`).emit('fight-updated', data);
    },
    emitFightResult(roomSlug, data) {
      io.to(`room:${roomSlug}`).emit('fight-result', data);
    },
    emitBetPlaced(roomSlug, data) {
      io.to(`room:${roomSlug}`).emit('bet-placed', data);
    },
    emitHistorial(roomSlug, peleas) {
      io.to(`room:${roomSlug}`).emit('historial', peleas);
    },
    emitChat(roomSlug, message) {
      io.to(`room:${roomSlug}`).emit('chat-message', { system: true, message });
    }
  };
};