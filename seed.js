// Crea usuarios de arranque. Se ejecuta una sola vez con: node seed.js
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const db = require('./db');

const insert = db.prepare(`
  INSERT INTO users (id, username, password_hash, role, display_name)
  VALUES (?, ?, ?, ?, ?)
`);

const exists = db.prepare('SELECT 1 FROM users WHERE username = ?');

const seedUsers = [
  { username: 'admin',   password: 'admin123',   role: 'admin',  display_name: 'Atención' },
  { username: 'maria',   password: 'cliente123', role: 'client', display_name: 'María G.' },
  { username: 'julian',  password: 'cliente123', role: 'client', display_name: 'Julián R.' },
  { username: 'lucia',   password: 'cliente123', role: 'client', display_name: 'Lucía P.' },
];

for (const u of seedUsers) {
  if (exists.get(u.username)) {
    console.log(`- Ya existe: ${u.username} (se omite)`);
    continue;
  }
  const hash = bcrypt.hashSync(u.password, 10);
  insert.run(randomUUID(), u.username, hash, u.role, u.display_name);
  console.log(`✓ Creado: ${u.username} / ${u.password} (${u.role})`);
}

console.log('\nListo. Guardá estas credenciales de prueba, después las cambiás.');
