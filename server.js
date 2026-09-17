require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { randomUUID } = require('crypto');

const db = require('./db');

// Crea los usuarios de prueba automáticamente la primera vez que arranca el servidor
(function autoSeed() {
  const count = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  if (count === 0) {
    const insert = db.prepare(`INSERT INTO users (id, username, password_hash, role, display_name) VALUES (?, ?, ?, ?, ?)`);
    const seedUsers = [
      { username: 'admin',  password: 'admin123',   role: 'admin',  display_name: 'Atención' },
      { username: 'maria',  password: 'cliente123', role: 'client', display_name: 'María G.' },
      { username: 'julian', password: 'cliente123', role: 'client', display_name: 'Julián R.' },
      { username: 'lucia',  password: 'cliente123', role: 'client', display_name: 'Lucía P.' },
    ];
    for (const u of seedUsers) {
      insert.run(randomUUID(), u.username, bcrypt.hashSync(u.password, 10), u.role, u.display_name);
    }
    console.log('Usuarios de prueba creados automáticamente.');
  }
})();

const JWT_SECRET = process.env.JWT_SECRET || 'cambia-este-secreto-en-produccion';
const PORT = process.env.PORT || 3000;

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// Nota: en el plan gratuito de Render el disco no es permanente, así que estos
// archivos se pierden en cada redeploy. Está bien para probar; para producción
// real conviene mover esto a un almacenamiento externo (ej. Cloudinary).
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'
]);
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 10);
      cb(null, `${randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) return cb(new Error('Tipo de archivo no permitido'));
    cb(null, true);
  }
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---------- helpers ----------
function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, username: user.username, display_name: user.display_name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o vencido' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo para administradores' });
  next();
}

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Faltan usuario o clave' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Usuario o clave incorrectos' });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Usuario o clave incorrectos' });

  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role, display_name: user.display_name }
  });
});

// ---------- subir archivo adjunto ----------
app.post('/api/upload', authMiddleware, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
    res.json({
      file_url: `/uploads/${req.file.filename}`,
      file_name: req.file.originalname,
      file_mime: req.file.mimetype
    });
  });
});

// ---------- conversations (admin) ----------
app.get('/api/conversations', authMiddleware, requireAdmin, (req, res) => {
  const clients = db.prepare(`SELECT id, username, display_name FROM users WHERE role = 'client'`).all();
  const lastMsgStmt = db.prepare(`
    SELECT
      CASE WHEN TRIM(text) = '' AND file_name IS NOT NULL THEN '📎 ' || file_name ELSE text END AS text,
      created_at
    FROM messages
    WHERE conversation_user_id = ? ORDER BY id DESC LIMIT 1
  `);
  const unreadStmt = db.prepare(`
    SELECT COUNT(*) as n FROM messages
    WHERE conversation_user_id = ? AND sender_role = 'client' AND read_by_admin = 0
  `);

  const result = clients.map(c => ({
    ...c,
    last_message: lastMsgStmt.get(c.id) || null,
    unread: unreadStmt.get(c.id).n
  }));
  res.json(result);
});

// ---------- message history ----------
app.get('/api/messages/me', authMiddleware, (req, res) => {
  if (req.user.role !== 'client') return res.status(403).json({ error: 'Solo para clientes' });
  const rows = db.prepare(`
    SELECT sender_role, text, file_url, file_name, file_mime, created_at FROM messages
    WHERE conversation_user_id = ? ORDER BY id ASC
  `).all(req.user.id);
  res.json(rows);
});

app.get('/api/messages/:userId', authMiddleware, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT sender_role, text, file_url, file_name, file_mime, created_at FROM messages
    WHERE conversation_user_id = ? ORDER BY id ASC
  `).all(req.params.userId);
  db.prepare(`
    UPDATE messages SET read_by_admin = 1
    WHERE conversation_user_id = ? AND sender_role = 'client'
  `).run(req.params.userId);
  res.json(rows);
});

// ---------- socket.io realtime ----------
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('No autorizado'));
  }
});

io.on('connection', (socket) => {
  const { id, role } = socket.user;

  if (role === 'client') {
    socket.join(`user:${id}`);
  } else if (role === 'admin') {
    socket.join('admins');
  }

  socket.on('send_message', ({ text, conversationUserId, attachment }) => {
    const cleanText = (text || '').trim();
    const hasAttachment = attachment && attachment.file_url;
    if (!cleanText && !hasAttachment) return; // no mandamos mensajes vacíos sin texto ni archivo

    let convId;
    if (role === 'client') {
      convId = id; // el cliente solo puede escribir en su propia conversación
    } else {
      if (!conversationUserId) return; // el admin debe indicar a quién le habla
      convId = conversationUserId;
    }

    const insert = db.prepare(`
      INSERT INTO messages (conversation_user_id, sender_role, text, file_url, file_name, file_mime, read_by_admin)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const readByAdmin = role === 'admin' ? 1 : 0;
    const info = insert.run(
      convId, role, cleanText,
      hasAttachment ? attachment.file_url : null,
      hasAttachment ? attachment.file_name : null,
      hasAttachment ? attachment.file_mime : null,
      readByAdmin
    );

    const payload = {
      id: info.lastInsertRowid,
      conversation_user_id: convId,
      sender_role: role,
      text: cleanText,
      file_url: hasAttachment ? attachment.file_url : null,
      file_name: hasAttachment ? attachment.file_name : null,
      file_mime: hasAttachment ? attachment.file_mime : null,
      created_at: new Date().toISOString()
    };

    io.to(`user:${convId}`).emit('new_message', payload);
    io.to('admins').emit('new_message', payload);
  });
});

server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
