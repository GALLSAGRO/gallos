const router = require('express').Router();
const pool   = require('../models/db');
const auth   = require('../middleware/auth');

// Usuarios ven solo salas activas, admin ve todas
router.get('/', auth, async (req, res) => {
  const q = req.user.is_admin
    ? await pool.query('SELECT * FROM rooms ORDER BY created_at DESC')
    : await pool.query('SELECT * FROM rooms WHERE activo=true ORDER BY created_at DESC');
  res.json(q.rows);
});

router.get('/:slug', auth, async (req, res) => {
  const roomQ = await pool.query('SELECT * FROM rooms WHERE slug=$1', [req.params.slug]);
  if (!roomQ.rows[0]) return res.status(404).json({ error: 'Sala no encontrada' });

  const fightQ = await pool.query(
    "SELECT * FROM peleas WHERE room_id=$1 AND estado IN ('apostando','en_vivo') ORDER BY created_at DESC LIMIT 1",
    [roomQ.rows[0].id]
  );

  res.json({ room: roomQ.rows[0], activeFight: fightQ.rows[0] || null });
});

module.exports = router;