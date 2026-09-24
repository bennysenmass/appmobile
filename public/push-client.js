// Pide permiso de notificaciones y suscribe este dispositivo a las notificaciones push.
// Se llama una vez que el usuario ya inició sesión (necesita el token para avisarle al servidor).
async function setupPushNotifications(token) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return; // navegador viejo o sin soporte, seguimos sin notificaciones push
  }

  // En iPhone, el Web Push solo funciona si la app ya está instalada en la pantalla de inicio
  // (iOS 16.4+). Pedir permiso desde una pestaña normal de Safari no serviría de nada.
  const ua = window.navigator.userAgent.toLowerCase();
  const isIos = /iphone|ipad|ipod/.test(ua);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isIos && !isStandalone) return;

  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
    }
    if (Notification.permission !== 'granted') return;

    const keyRes = await fetch('/api/push/vapid-public-key');
    const { publicKey, enabled } = await keyRes.json();
    if (!enabled || !publicKey) return;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
    }

    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(sub)
    });
  } catch (err) {
    console.log('No se pudo activar notificaciones push:', err.message);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// Suena y vibra desde la propia app cuando llega un mensaje con la app abierta en primer plano.
// (Las notificaciones del sistema no suenan en ese caso porque el celular entiende que ya la estás mirando.)
let _chimeAudio = null;
function playNotificationChime() {
  try {
    if (document.visibilityState !== 'visible') return; // en segundo plano, ya se ocupa la notificación del sistema
    if (!_chimeAudio) _chimeAudio = new Audio('/chime.wav');
    _chimeAudio.currentTime = 0;
    _chimeAudio.play().catch(() => {}); // si el navegador bloquea el autoplay, no rompemos nada
  } catch {}
  try {
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  } catch {}
}

// ================================================================
// Avisos propios (reemplazan a alert / confirm / prompt del navegador)
// Requieren el CSS de .toast-host / .app-modal-overlay ya presente en cada página.
// ================================================================

function _getToastHost() {
  let host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  return host;
}

// showToast(mensaje, tipo) — tipo: 'info' (default), 'success', 'error'
function showToast(message, type = 'info') {
  const host = _getToastHost();
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 3200);
}

function _buildAppModal({ title, bodyHtml, buttons }) {
  const overlay = document.createElement('div');
  overlay.className = 'app-modal-overlay';
  overlay.innerHTML = `
    <div class="app-modal-card">
      <div class="app-modal-title">${title}</div>
      <div class="app-modal-body">${bodyHtml}</div>
      <div class="app-modal-actions"></div>
    </div>
  `;
  const actions = overlay.querySelector('.app-modal-actions');
  buttons.forEach(b => {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    btn.className = 'app-modal-btn ' + (b.variant || '');
    btn.addEventListener('click', b.onClick);
    actions.appendChild(btn);
  });
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  return overlay;
}

function _closeAppModal(overlay) {
  overlay.classList.remove('show');
  setTimeout(() => overlay.remove(), 200);
}

// showConfirm({title, message, confirmLabel, danger}) → Promise<boolean>
function showConfirm({ title = 'Confirmar', message = '', confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = _buildAppModal({
      title,
      bodyHtml: `<p>${message}</p>`,
      buttons: [
        { label: cancelLabel, variant: 'secondary', onClick: () => { _closeAppModal(overlay); resolve(false); } },
        { label: confirmLabel, variant: danger ? 'danger' : 'primary', onClick: () => { _closeAppModal(overlay); resolve(true); } }
      ]
    });
  });
}

// showPromptPassword({title, message, confirmLabel}) → Promise<string|null>
// Pide una clave nueva con un campo de contraseña (no texto plano en pantalla).
function showPromptPassword({ title = 'Nueva clave', message = 'Ingresá la nueva clave (mínimo 6 caracteres).', confirmLabel = 'Guardar' } = {}) {
  return new Promise((resolve) => {
    const overlay = _buildAppModal({
      title,
      bodyHtml: `
        <p>${message}</p>
        <input type="password" id="_promptInput" class="app-modal-input" placeholder="Nueva clave">
        <p class="app-modal-err" id="_promptErr"></p>
      `,
      buttons: [
        { label: 'Cancelar', variant: 'secondary', onClick: () => { _closeAppModal(overlay); resolve(null); } },
        { label: confirmLabel, variant: 'primary', onClick: () => {
          const val = overlay.querySelector('#_promptInput').value;
          if (val.length < 6) {
            overlay.querySelector('#_promptErr').textContent = 'Mínimo 6 caracteres.';
            return;
          }
          _closeAppModal(overlay);
          resolve(val);
        } }
      ]
    });
    const input = overlay.querySelector('#_promptInput');
    input.focus();
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') overlay.querySelector('.app-modal-btn.primary').click(); });
  });
}
