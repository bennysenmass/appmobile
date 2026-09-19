# Mensajería — Backend real

Backend con login (cliente y admin), chat en tiempo real y base de datos.
Ya está probado y funcionando.

## Qué incluye

- `server.js` — servidor (login + mensajería en tiempo real)
- `db.js` — base de datos SQLite (se crea sola en un archivo `data.sqlite`)
- `seed.js` — crea los usuarios de prueba
- `public/index.html` — página del **cliente**
- `public/admin.html` — página del **admin**

## Usuarios de prueba (creados por `seed.js`)

| Usuario | Clave | Rol |
|---|---|---|
| admin | admin123 | admin |
| maria | cliente123 | cliente |
| julian | cliente123 | cliente |
| lucia | cliente123 | cliente |

**Cambiá estas claves antes de usarlo con datos reales.**

## Probarlo en tu computadora

Necesitás tener [Node.js](https://nodejs.org) instalado (versión 18 o más nueva).

```bash
cd mensajeria-backend
npm install
npm run seed      # crea los usuarios de prueba (una sola vez)
npm start
```

Abrí en el navegador:
- Cliente: `http://localhost:3000/index.html`
- Admin: `http://localhost:3000/admin.html`

Podés abrir las dos páginas en pestañas distintas y probar a chatear entre ellas.

## Desplegarlo online (paso a paso, con Render — tiene plan gratuito)

1. Creá una cuenta en [render.com](https://render.com) (podés entrar con GitHub).
2. Subí esta carpeta a un repositorio de GitHub (si no sabés cómo, avisame y te guío).
3. En Render: **New +** → **Web Service** → elegí tu repositorio.
4. Configuración:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. En la sección **Environment Variables**, agregá:
   - `JWT_SECRET` = un texto largo y aleatorio (esto firma las sesiones — no lo compartas)
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` = copiá los valores del archivo `.env.example` (son las claves que hacen funcionar las notificaciones push)
6. Creá el servicio. Cuando termine de desplegar te da una URL tipo `https://tu-app.onrender.com`.
7. Entrá una sola vez a esa URL + `/index.html`, y ejecutá el seed **desde la consola de Render** (pestaña "Shell"):
   ```bash
   npm run seed
   ```
8. Ya está online:
   - Cliente: `https://tu-app.onrender.com/index.html`
   - Admin: `https://tu-app.onrender.com/admin.html`

### Nota sobre el plan gratuito de Render

El plan free "duerme" el servidor tras un rato sin uso, y tarda unos segundos en
despertar con el primer mensaje. Para una app en producción real conviene pasar
a un plan pago cuando ya tengas usuarios reales.

## Notificaciones push

Cuando el cliente o el admin entran a su cuenta, el navegador les pide permiso para
mandar notificaciones. Si lo aceptan, van a recibir un aviso (con sonido e ícono en la
barra de notificaciones) apenas llega un mensaje nuevo — aunque tengan la app cerrada
o el celular bloqueado.

- **Android (Chrome, Samsung Internet, etc.):** funciona apenas se acepta el permiso,
  no hace falta instalar la app.
- **iPhone (Safari):** Apple solo permite las notificaciones push si la app está
  instalada en la pantalla de inicio (ver la sección de instalación más abajo) y con
  iOS 16.4 o más nuevo. Desde una pestaña normal de Safari no van a funcionar.

Si en algún momento se pierden o cambian las claves VAPID, simplemente generá unas
nuevas con `npx web-push generate-vapid-keys` y actualizá las variables de entorno.

## Qué falta para que sea una app de verdad (próximos pasos)

- [x] Convertir esto en app instalable en el celular (PWA)
- [x] Notificaciones push reales (que avisen aunque la app esté cerrada)
- [ ] Pantalla de admin para crear/gestionar usuarios (hoy se hace con `seed.js`)
- [x] Menú de opciones rápidas del cliente ("quiero cargar", etc.) + plantillas admin
- [x] Subir imágenes/comprobantes en el chat
- [ ] Base de datos permanente (hoy se resetea en cada redeploy en el plan gratuito)
