const pool = require('../models/db');

async function adminOnly(req, res, next) {
  try {
    const q = await pool.query(
      'SELECT is_admin, role FROM usuarios WHERE id = $1',
      [req.user.id]
    );

    const user = q.rows[0];

    if (!user || (!user.is_admin && user.role !== 'admin')) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    req.admin = true;
    req.user.is_admin = true;
    req.user.role = user.role;

    next();
  } catch (error) {
    console.error('Error en adminOnly:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = adminOnly;