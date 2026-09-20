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
