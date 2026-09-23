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
const webpush = require('web-push');
const rateLimit = require('express-rate-limit');

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

// ---------- notificaciones push (Web Push / VAPID) ----------
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:soporte@example.com';
const pushEnabled = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushEnabled) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.log('Aviso: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY no configuradas — las notificaciones push están desactivadas.');
}

function sendPushToUser(userId, payload) {
  if (!pushEnabled) return;
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  const json = JSON.stringify(payload);
  for (const sub of subs) {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    };
    webpush.sendNotification(pushSubscription, json).catch((err) => {
      // Si la suscripción ya no es válida (desinstaló la app, cambió de navegador, etc.), la borramos.
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      } else {
        console.error('Error enviando push:', err.statusCode || err.message);
      }
    });
  }
}

function sendPushToAllAdmins(payload) {
  const admins = db.prepare(`SELECT id FROM users WHERE role = 'admin'`).all();
  for (const a of admins) sendPushToUser(a.id, payload);
}

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

// ---------- CORS: solo se permiten los orígenes de la propia app ----------
// Por defecto solo permite el dominio de Render de esta app. Si algún día se usa
// un dominio propio además, agregalo separado por coma en la variable de entorno.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://mensajeria-app-9iqw.onrender.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    // sin "origin" (apps nativas, curl, llamadas del propio servidor) → se permite
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Origen no permitido'));
  }
};

const app = express();
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Nota: /uploads YA NO se sirve como carpeta pública. Cada archivo se sirve a través
// de /api/uploads/:filename, que verifica que quien lo pide tenga permiso de verlo
// (ver más abajo, junto al resto de endpoints de archivos).

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: allowedOrigins } });

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
// Límite de intentos: si alguien prueba muchas combinaciones de usuario/clave
// seguidas desde la misma IP, lo frenamos un rato en vez de dejarlo seguir probando.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10,                  // 10 intentos como máximo en ese lapso
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de ingreso. Probá de nuevo en unos minutos.' }
});

app.post('/api/login', loginLimiter, (req, res) => {
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
      file_url: `/api/uploads/${req.file.filename}`,
      file_name: req.file.originalname,
      file_mime: req.file.mimetype
    });
  });
});

// Sirve un archivo adjunto SOLO si quien lo pide tiene permiso de verlo:
// el admin puede ver cualquiera; un cliente solo los de su propia conversación.
app.get('/api/uploads/:filename', authMiddleware, (req, res) => {
  const { filename } = req.params;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(filename)) {
    return res.status(400).json({ error: 'Nombre de archivo inválido' });
  }

  const message = db.prepare(`
    SELECT conversation_user_id, file_mime FROM messages WHERE file_url = ?
  `).get(`/api/uploads/${filename}`);
  if (!message) return res.status(404).json({ error: 'Archivo no encontrado' });

  if (req.user.role === 'client' && message.conversation_user_id !== req.user.id) {
    return res.status(403).json({ error: 'No tenés permiso para ver este archivo' });
  }

  const fullPath = path.join(UPLOADS_DIR, filename);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(UPLOADS_DIR))) {
    return res.status(400).json({ error: 'Ruta inválida' });
  }
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Archivo no encontrado' });

  res.type(message.file_mime || 'application/octet-stream');
  res.sendFile(resolved);
});

// ---------- notificaciones push: clave pública y suscripción ----------
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY, enabled: pushEnabled });
});

app.post('/api/push/subscribe', authMiddleware, (req, res) => {
  const sub = req.body || {};
  if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'Suscripción inválida' });
  }
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
  `).run(req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', authMiddleware, (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  res.json({ ok: true });
});

// ---------- datos del usuario logueado ----------
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, role: req.user.role, display_name: req.user.display_name });
});

// ---------- gestión de usuarios (solo admin) ----------
app.get('/api/users', authMiddleware, requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT id, username, role, display_name, created_at FROM users
    ORDER BY role DESC, display_name ASC
  `).all();
  res.json(users);
});

app.post('/api/users', authMiddleware, requireAdmin, (req, res) => {
  const { username, password, display_name, role } = req.body || {};
  if (!username || !password || !display_name || !role) {
    return res.status(400).json({ error: 'Completá todos los campos' });
  }
  if (!['client', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Rol inválido' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'La clave debe tener al menos 6 caracteres' });
  }
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Ese nombre de usuario ya existe' });

  const id = randomUUID();
  db.prepare(`
    INSERT INTO users (id, username, password_hash, role, display_name) VALUES (?, ?, ?, ?, ?)
  `).run(id, username, bcrypt.hashSync(password, 10), role, display_name);

  res.json({ id, username, role, display_name });
});

app.patch('/api/users/:id', authMiddleware, requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const { display_name, password } = req.body || {};
  if (display_name) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name, req.params.id);
  }
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'La clave debe tener al menos 6 caracteres' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.params.id);
  }
  res.json({ ok: true });
});

app.delete('/api/users/:id', authMiddleware, requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'No podés eliminar tu propia cuenta' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  if (user.role === 'admin') {
    const adminCount = db.prepare(`SELECT COUNT(*) as n FROM users WHERE role = 'admin'`).get().n;
    if (adminCount <= 1) return res.status(400).json({ error: 'No podés eliminar el único administrador' });
  }

  const deleteUserAndData = db.transaction((userId) => {
    db.prepare('DELETE FROM messages WHERE conversation_user_id = ?').run(userId);
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });
  deleteUserAndData(req.params.id);

  res.json({ ok: true });
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

    // ---- notificación push al destinatario ----
    const notifBody = cleanText || (hasAttachment ? '📎 Te mandaron un archivo' : '');
    if (role === 'client') {
      const client = db.prepare('SELECT display_name FROM users WHERE id = ?').get(id);
      sendPushToAllAdmins({
        title: client ? client.display_name : 'Nuevo mensaje',
        body: notifBody,
        url: '/admin.html',
        tag: `conv-${convId}`
      });
    } else {
      sendPushToUser(convId, {
        title: 'Atención',
        body: notifBody,
        url: '/index.html',
        tag: `conv-${convId}`
      });
    }
  });
});

// Maneja errores sin exponer rutas internas del servidor ni stack traces al cliente.
app.use((err, req, res, next) => {
  if (err && err.message === 'Origen no permitido') {
    return res.status(403).json({ error: 'Origen no permitido' });
  }
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
