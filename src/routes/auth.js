const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../models/db');

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, is_admin: user.is_admin },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

router.post('/register', async (req, res) => {
  try {
    const { nombre_completo, numero_celular, username, email, password } = req.body;
    if (!nombre_completo || !numero_celular || !username || !email || !password)
      return res.status(400).json({ error: 'Todos los campos son obligatorios' });

    const [celQ, userQ, emailQ] = await Promise.all([
      pool.query('SELECT 1 FROM usuarios WHERE numero_celular=$1', [numero_celular]),
      pool.query('SELECT 1 FROM usuarios WHERE username=$1', [username]),
      pool.query('SELECT 1 FROM usuarios WHERE email=$1', [email])
    ]);

    if (celQ.rows.length)   return res.status(409).json({ error: 'Numero ya registrado' });
    if (userQ.rows.length)  return res.status(409).json({ error: 'Username ya existe' });
    if (emailQ.rows.length) return res.status(409).json({ error: 'Email ya registrado' });

    const hash = await bcrypt.hash(password, 12);
    const q = await pool.query(
      `INSERT INTO usuarios (nombre_completo, numero_celular, username, email, password_hash)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, nombre_completo, username, email, puntos, is_admin`,
      [nombre_completo, numero_celular, username, email, hash]
    );

    const user = q.rows[0];
    res.json({ ok: true, token: signToken(user), user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error de registro' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    const q = await pool.query(
      `SELECT * FROM usuarios WHERE numero_celular=$1 OR username=$1 OR email=$1 LIMIT 1`,
      [identifier]
    );
    const user = q.rows[0];
    if (!user) return res.status(401).json({ error: 'Credenciales invalidas' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales invalidas' });

    res.json({
      ok: true,
      token: signToken(user),
      user: {
        id: user.id,
        nombre_completo: user.nombre_completo,
        username: user.username,
        email: user.email,
        puntos: user.puntos,
        is_admin: user.is_admin
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error de login' });
  }
});

module.exports = router;