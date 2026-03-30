const router = require('express').Router();
const pool = require('../models/db');

router.get('/', async (req, res) => {
  const q = await pool.query('SELECT * FROM rooms WHERE activo=TRUE ORDER BY id ASC');
  res.json(q.rows);
});

router.get('/:slug', async (req, res) => {
  const roomQ = await pool.query('SELECT * FROM rooms WHERE slug=$1', [req.params.slug]);
  if (!roomQ.rows[0]) return res.status(404).json({ error: 'Sala no encontrada' });

  const fightQ = await pool.query(
    `SELECT * FROM peleas
     WHERE room_id=$1 AND estado IN ('apostando','en_vivo')
     ORDER BY created_at DESC LIMIT 1`,
    [roomQ.rows[0].id]
  );

  res.json({ room: roomQ.rows[0], activeFight: fightQ.rows[0] || null });
});

router.get('/:slug/fights', async (req, res) => {
  const q = await pool.query(
    `SELECT p.* FROM peleas p
     JOIN rooms r ON r.id = p.room_id
     WHERE r.slug=$1
     ORDER BY p.created_at DESC`,
    [req.params.slug]
  );
  res.json(q.rows);
});

module.exports = router;