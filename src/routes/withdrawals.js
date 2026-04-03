const router = require('express').Router();
const pool = require('../models/db');

// -------------------------------------------------------
// POST /api/withdrawals
// Solicitar retiro — descuenta puntos inmediatamente
// -------------------------------------------------------
router.post('/', async (req, res) => {
  const { amount, destination } = req.body;
  const amt = parseInt(amount, 10);

  if (!amt || amt <= 0 || !destination || !String(destination).trim()) {
    return res.status(400).json({ error: 'Monto y destino requeridos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userQ = await client.query(
      `SELECT puntos FROM usuarios WHERE id = $1 FOR UPDATE`,
      [req.user.id]
    );

    if (!userQ.rows[0] || Number(userQ.rows[0].puntos) < amt) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    await client.query(
      `UPDATE usuarios SET puntos = puntos - $1 WHERE id = $2`,
      [amt, req.user.id]
    );

    const { rows } = await client.query(
      `INSERT INTO withdrawal_requests (user_id, amount, status, destination)
       VALUES ($1, $2, 'pending', $3)
       RETURNING *`,
      [req.user.id, amt, String(destination).trim()]
    );

    await client.query('COMMIT');
    res.json({ ok: true, request: rows[0] });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/withdrawals error:', e);
    res.status(500).json({ error: 'Error procesando retiro' });
  } finally {
    client.release();
  }
});

// -------------------------------------------------------
// GET /api/withdrawals/my
// Historial de retiros del usuario autenticado
// -------------------------------------------------------
router.get('/my', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, amount, status, destination, created_at, updated_at
       FROM withdrawal_requests
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/withdrawals/my error:', err);
    res.status(500).json({ error: 'Error al obtener retiros' });
  }
});

module.exports = router;