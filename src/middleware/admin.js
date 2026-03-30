const pool = require('../models/db');

async function adminOnly(req, res, next) {
  const q = await pool.query('SELECT is_admin FROM usuarios WHERE id=$1', [req.user.id]);
  if (!q.rows[0]?.is_admin) return res.status(403).json({ error: 'Acceso denegado' });
  req.admin = true;
  next();
}

module.exports = adminOnly;