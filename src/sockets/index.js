const jwt = require('jsonwebtoken');
const pool = require('../models/db');

module.exports = function setupSockets(io) {

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (token) {
      try { socket.user = jwt.verify(token, process.env.JWT_SECRET); }
      catch { socket.user = null; }
    }
    next();
  });

  io.on('connection', (socket) => {
    socket.on('join-room', async ({ roomSlug }) => {
      socket.join(`room:${roomSlug}`);

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

      const histQ = await pool.query(
        `SELECT p.* FROM peleas p
         JOIN rooms r ON r.id = p.room_id
         WHERE r.slug=$1
         ORDER BY p.created_at DESC`,
        [roomSlug]
      );
      socket.emit('historial', histQ.rows);
    });
  });

  return {
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
    }
  };
};