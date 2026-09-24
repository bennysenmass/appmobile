# Hoja de ruta — Seguridad y Escalabilidad

Plan para ir aplicando de a poco antes de que la app maneje uso y plata real.
Un análisis hecho el 20/09/2026, para ir tachando ítems día a día.

## 🔴 Seguridad (antes de manejar plata real)

- [x] **Límite de intentos de login** — máx. 10 intentos cada 15 min por IP (hecho 20/09)
- [x] **CORS restringido** al dominio propio de la app, en vez de abierto a cualquier sitio (hecho 20/09)
- [x] **Control de acceso a los archivos subidos** — hecho 22/09: solo el cliente dueño de la conversación o un admin pueden verlos, con token
- [ ] **Revocar sesiones activas** — hoy no hay forma de "desloguear a la fuerza" a alguien desde el panel
- [ ] **2FA para la cuenta admin** — es la cuenta más golosa para atacar, maneja todo
- [ ] **Registro de auditoría** — quién creó/borró usuarios, quién cambió qué clave y cuándo
- [x] **Security headers** (con `helmet`) — hecho 23/09. Pendiente afinar más adelante: mover los `<script>` embebidos de cada página a archivos externos para poder sacar el `'unsafe-inline'` del CSP y dejarlo con la protección completa contra XSS

## 🟡 Escalabilidad (importa si crece el uso)

- [ ] **Base de datos permanente** (migrar de SQLite a Postgres) — hoy se resetea en cada redeploy y no permite más de un servidor corriendo a la vez
- [ ] **Paginado del historial de mensajes** — hoy trae toda la conversación entera de una vez
- [ ] **Optimizar la consulta de la lista de conversaciones** — hoy hace varias consultas chicas en vez de una sola
- [ ] **Almacenamiento de archivos fuera del servidor** (ej. Cloudinary/S3) — para que no dependa del disco de un único servidor
- [ ] **Límite de velocidad de envío de mensajes** — evitar que alguien sature el servidor mandando miles de mensajes por segundo
- [ ] **Monitoreo y alertas** — enterarse si el servidor se cae, antes que un cliente se queje
- [ ] **Tests automáticos** — para no depender de probar todo a mano en cada cambio

## 🎨 UX / Diseño (análisis del 22/09)

**Rápidas, se notan mucho:**
- [x] **Reemplazar los `alert()` / `confirm()` / `prompt()` del navegador** por avisos propios (toast + modales) — hecho 23/09
- [ ] **Aviso propio antes de pedir permiso de notificaciones** — hoy salta el pedido del navegador sin contexto, mucha gente lo rechaza por reflejo
- [ ] **Buscador en la lista de conversaciones del admin** + mostrar hace cuánto fue el último mensaje
- [ ] **Colores de avatar distintos por cliente** en la lista del admin (hoy todos son el mismo verde, cuesta distinguir)
- [ ] **Cuadro de texto del cliente multilínea** (el del admin ya lo es, el del cliente no)

**Más impacto, más trabajo:**
- [ ] Tilde de mensaje leído/entregado
- [ ] Indicador de "está escribiendo..."
- [ ] Modo oscuro
- [ ] Visor ampliado de fotos (en vez de abrir en pestaña nueva)

**Pulido final:**
- [ ] Reemplazar emojis (📎📄➤) por íconos SVG reales
- [ ] Animación suave al enviar/recibir mensajes

## Notas

- Los dos primeros ítems de seguridad ya están hechos y desplegados.
- Variable de entorno nueva en Render: `ALLOWED_ORIGINS` (ver `.env.example`).
