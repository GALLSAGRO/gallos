const router = require('express').Router();
const pool = require('../models/db');
const auth = require('../middleware/auth');

router.post('/', auth, async (req, res) => {
  const { amount, destination } = req.body;
  const amt = parseInt(amount, 10);
  if (!amt || amt <= 0 || !destination)
    return res.status(400).json({ error: 'Monto y destino requeridos' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userQ = await client.query(
      'SELECT puntos FROM usuarios WHERE id=$1 FOR UPDATE', [req.user.id]
    );
    if (!userQ.rows[0] || userQ.rows[0].puntos < amt) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }
    await client.query('UPDATE usuarios SET puntos = puntos - $1 WHERE id=$2', [amt, req.user.id]);
    const q = await client.query(
      `INSERT INTO withdrawal_requests (user_id, amount, status, destination)
       VALUES ($1,$2,'pending',$3) RETURNING *`,
      [req.user.id, amt, destination]
    );
    await client.query('COMMIT');
    res.json({ ok: true, request: q.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Error procesando retiro' });
  } finally {
    client.release();
  }
});

router.get('/my', auth, async (req, res) => {
  const q = await pool.query(
    'SELECT * FROM withdrawal_requests WHERE user_id=$1 ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json(q.rows);
});

module.exports = router;