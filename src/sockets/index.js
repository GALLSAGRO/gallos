const jwt  = require('jsonwebtoken');
const pool = require('../models/db');

module.exports = function setupSockets(io) {

  // -------------------------------------------------------
  // QUERIES HELPERS
  // -------------------------------------------------------
  async function getRoomBySlug(roomSlug) {
    const { rows } = await pool.query(
      `SELECT id, slug, nombre, facebook_live_url, activos, created_at
       FROM rooms WHERE slug = $1`,
      [roomSlug]
    );
    return rows[0] || null;
  }

  async function getActiveEvent(roomId) {
    const { rows } = await pool.query(
      `SELECT id, nombre, fecha_evento, estado, numero_pelea_actual, total_peleas, started_at
       FROM events WHERE room_id = $1 AND estado = 'activo' LIMIT 1`,
      [roomId]
    );
    return rows[0] || null;
  }

  async function getEventMatches(eventId) {
    const { rows } = await pool.query(
      `SELECT id, numero_pelea, orden, gallo_rojo, gallo_verde,
              estado, resultado, puntos_rojo, puntos_verde
       FROM event_matches WHERE event_id = $1 ORDER BY orden ASC`,
      [eventId]
    );
    return rows;
  }

  async function getEventScores(eventId) {
    const { rows } = await pool.query(
      `SELECT side, team_name, puntos, ganadas, empatadas, perdidas
       FROM v_event_team_scores WHERE event_id = $1`,
      [eventId]
    );
    return rows;
  }

  async function getMatchPool(eventMatchId) {
    if (!eventMatchId) return [];
    const { rows } = await pool.query(
      `SELECT gallo,
              COALESCE(SUM(puntos_total), 0)   AS total,
              COALESCE(SUM(puntos_matched), 0) AS matched
       FROM apuestas WHERE event_match_id = $1 GROUP BY gallo`,
      [eventMatchId]
    );
    return rows;
  }

  async function getHistorial(eventId) {
    if (!eventId) return [];
    const { rows } = await pool.query(
      `SELECT id, numero_pelea, gallo_rojo, gallo_verde,
              resultado, puntos_rojo, puntos_verde, finished_at
       FROM event_matches
       WHERE event_id = $1 AND estado = 'terminada'
       ORDER BY orden DESC LIMIT 20`,
      [eventId]
    );
    return rows;
  }

  async function buildRoomState(roomSlug) {
    const room = await getRoomBySlug(roomSlug);
    if (!room) return null;

    const activeEvent = await getActiveEvent(room.id);
    let matches  = [];
    let scores   = [];
    let current  = null;
    let historial = [];
    let pool_apuestas = [];

    if (activeEvent) {
      matches   = await getEventMatches(activeEvent.id);
      scores    = await getEventScores(activeEvent.id);
      historial = await getHistorial(activeEvent.id);
      current   = matches.find(m => ['lista', 'apostando', 'en_vivo'].includes(m.estado)) || null;
      if (current) {
        pool_apuestas = await getMatchPool(current.id);
      }
    }

    return { room, activeEvent, current, matches, scores, historial, pool: pool_apuestas };
  }

  // -------------------------------------------------------
  // AUTH MIDDLEWARE SOCKET
  // -------------------------------------------------------
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (token) {
      try { socket.user = jwt.verify(token, process.env.JWT_SECRET); }
      catch { socket.user = null; }
    } else {
      socket.user = null;
    }
    next();
  });

  // -------------------------------------------------------
  // CONEXIÓN
  // -------------------------------------------------------
  io.on('connection', (socket) => {
    const username = socket.user?.username || 'Anon';
    const userId   = socket.user?.id || null;

    if (userId) socket.join(`user:${userId}`);

    // ---------------------------------------------------
    // join-room
    // ---------------------------------------------------
    socket.on('join-room', async (payload) => {
      try {
        const roomSlug = typeof payload === 'string'
          ? payload
          : String(payload?.roomSlug || '').trim();
        if (!roomSlug) return;

        if (socket.roomSlug && socket.roomSlug !== roomSlug) {
          socket.leave(`room:${socket.roomSlug}`);
        }

        socket.roomSlug = roomSlug;
        socket.join(`room:${roomSlug}`);

        const state = await buildRoomState(roomSlug);
        if (!state) {
          socket.leave(`room:${roomSlug}`);
          socket.roomSlug = null;
          socket.emit('room-closed', { message: 'La sala no existe o no está disponible' });
          return;
        }

        io.to(`room:${roomSlug}`).emit('chat-message', {
          system: true,
          message: `${username} entró a la sala`
        });

        socket.emit('room-state', {
          room:        state.room,
          activeEvent: state.activeEvent,
          current:     state.current,
          matches:     state.matches,
          scores:      state.scores,
          historial:   state.historial,
          pool:        state.pool
        });

      } catch (err) {
        console.error('Socket join-room error:', err);
        socket.emit('chat-message', { system: true, message: 'Error al entrar a la sala' });
      }
    });

    // ---------------------------------------------------
    // leave-room
    // ---------------------------------------------------
    socket.on('leave-room', (payload) => {
      try {
        const roomSlug = typeof payload === 'string'
          ? payload
          : String(payload?.roomSlug || socket.roomSlug || '').trim();
        if (!roomSlug) return;

        socket.leave(`room:${roomSlug}`);
        io.to(`room:${roomSlug}`).emit('chat-message', {
          system: true,
          message: `${username} salió de la sala`
        });
        if (socket.roomSlug === roomSlug) socket.roomSlug = null;
      } catch (err) {
        console.error('Socket leave-room error:', err);
      }
    });

    // ---------------------------------------------------
    // chat-message
    // ---------------------------------------------------
    socket.on('chat-message', ({ roomSlug, message, username: uname }) => {
      try {
        if (!roomSlug || !message) return;
        const clean = String(message).trim().slice(0, 200);
        if (!clean) return;
        io.to(`room:${roomSlug}`).emit('chat-message', {
          username: socket.user?.username || uname || 'Anon',
          message:  clean
        });
      } catch (err) {
        console.error('Socket chat-message error:', err);
      }
    });

    // ---------------------------------------------------
    // disconnect
    // ---------------------------------------------------
    socket.on('disconnect', () => {
      try {
        if (!socket.roomSlug) return;
        io.to(`room:${socket.roomSlug}`).emit('chat-message', {
          system: true,
          message: `${username} se desconectó`
        });
      } catch (err) {
        console.error('Socket disconnect error:', err);
      }
    });
  });

  // -------------------------------------------------------
  // MÉTODOS PÚBLICOS — llamados desde las rutas
  // -------------------------------------------------------
  return {
    io,

    // Refresco completo del estado de la sala
    async emitRoomStateBySlug(roomSlug) {
      try {
        const state = await buildRoomState(roomSlug);
        if (!state) return;
        io.to(`room:${roomSlug}`).emit('room-state', {
          room:        state.room,
          activeEvent: state.activeEvent,
          current:     state.current,
          matches:     state.matches,
          scores:      state.scores,
          historial:   state.historial,
          pool:        state.pool
        });
      } catch (err) { console.error('emitRoomStateBySlug error:', err); }
    },

    // Emitir resultado de una pelea + marcador actualizado
    async emitMatchResult(roomSlug, { event_id, match_id, resultado, puntos_rojo, puntos_verde, numero_pelea, siguiente, scores }) {
      try {
        io.to(`room:${roomSlug}`).emit('event:match_result', {
          event_id, match_id, resultado,
          puntos_rojo, puntos_verde,
          numero_pelea, siguiente, scores
        });
      } catch (err) { console.error('emitMatchResult error:', err); }
    },

    // Emitir inicio de evento
    async emitEventStarted(roomSlug, eventData) {
      try {
        const state = await buildRoomState(roomSlug);
        io.to(`room:${roomSlug}`).emit('event:started', {
          ...eventData,
          matches: state?.matches  || [],
          scores:  state?.scores   || [],
          current: state?.current  || null
        });
      } catch (err) { console.error('emitEventStarted error:', err); }
    },

    // Emitir cierre de evento
    emitEventFinished(roomSlug, eventData) {
      try {
        io.to(`room:${roomSlug}`).emit('event:finished', eventData);
      } catch (err) { console.error('emitEventFinished error:', err); }
    },

    // Emitir pool de apuestas actualizado
    emitBetPlaced(roomSlug, data) {
      try {
        io.to(`room:${roomSlug}`).emit('bet-placed', data);
      } catch (err) { console.error('emitBetPlaced error:', err); }
    },

    // Historial de peleas terminadas
    async emitHistoryBySlug(roomSlug) {
      try {
        const room = await getRoomBySlug(roomSlug);
        if (!room) return;
        const event = await getActiveEvent(room.id);
        if (!event) return;
        const historial = await getHistorial(event.id);
        io.to(`room:${roomSlug}`).emit('historial', { peleas: historial });
      } catch (err) { console.error('emitHistoryBySlug error:', err); }
    },

    // Pool de apuestas por room_id (para compatibilidad con admin.js)
    async emitPoolByRoomId(roomId) {
      try {
        const roomQ = await pool.query('SELECT slug FROM rooms WHERE id = $1', [roomId]);
        const slug = roomQ.rows[0]?.slug;
        if (!slug) return;
        const event = await getActiveEvent(roomId);
        if (!event) return;
        const matches = await getEventMatches(event.id);
        const current = matches.find(m => ['lista', 'apostando', 'en_vivo'].includes(m.estado));
        if (!current) return;
        const poolData = await getMatchPool(current.id);
        io.to(`room:${slug}`).emit('bet-placed', { pool: poolData });
      } catch (err) { console.error('emitPoolByRoomId error:', err); }
    },

    // Refresco general (alias para compatibilidad con admin.js)
    async emitRoomRefresh(roomSlug) {
      try {
        const state = await buildRoomState(roomSlug);
        if (!state) return;
        io.to(`room:${roomSlug}`).emit('room-state', {
          room:        state.room,
          activeEvent: state.activeEvent,
          current:     state.current,
          matches:     state.matches,
          scores:      state.scores,
          historial:   state.historial,
          pool:        state.pool
        });
      } catch (err) { console.error('emitRoomRefresh error:', err); }
    },

    // Chat del sistema
    emitChat(roomSlug, message) {
      try {
        io.to(`room:${roomSlug}`).emit('chat-message', { system: true, message });
      } catch (err) { console.error('emitChat error:', err); }
    }
  };
};