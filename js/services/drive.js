// Integración con Google Drive vía OAuth 2.0.
//
// Usa Google Identity Services (GIS) para obtener un access token y la API REST
// de Google Drive v3 para gestionar archivos. El scope `drive.file` solo expone
// archivos que esta app crea — no toca el resto del Drive del usuario.
//
// Setup (hacer UNA vez por proyecto):
//  1. Google Cloud Console → habilitar Google Drive API
//  2. OAuth Consent Screen (External, scope drive.file)
//  3. Crear OAuth Client ID Web → agregar http://localhost:8080 como origen
//  4. Pegar el Client ID en js/config/firebase-config.js → googleConfig.clientId

import { googleConfig } from '../config/firebase-config.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const APP_ROOT = 'Estimaciones SGR';      // carpeta raíz dentro del Drive
const TOKEN_KEY = 'drive_token_v1';

let accessToken = null;
let tokenExpires = 0;
let tokenClient = null;
let initialized = false;
let initPromise = null;

// === Carga perezosa de scripts ===
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.async = true; s.defer = true;
    s.dataset.src = src;
    s.onload = resolve; s.onerror = () => reject(new Error('No se pudo cargar ' + src));
    document.head.appendChild(s);
  });
}

export async function initDrive() {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await Promise.all([
      loadScript('https://accounts.google.com/gsi/client'),
      loadScript('https://apis.google.com/js/api.js')
    ]);
    await new Promise((res, rej) => window.gapi.load('client', { callback: res, onerror: rej }));
    await window.gapi.client.init({});
    await window.gapi.client.load('https://www.googleapis.com/discovery/v1/apis/drive/v3/rest');

    // Restaurar token vigente si existe
    try {
      const cached = JSON.parse(localStorage.getItem(TOKEN_KEY) || '{}');
      if (cached.token && cached.expires > Date.now() + 60_000) {
        accessToken = cached.token;
        tokenExpires = cached.expires;
        window.gapi.client.setToken({ access_token: accessToken });
      }
    } catch {}
    initialized = true;
  })();
  return initPromise;
}

export function isConfigured() {
  return !!(googleConfig?.clientId);
}

export function isSignedIn() {
  return !!accessToken && tokenExpires > Date.now() + 30_000;
}

export async function signIn() {
  if (!isConfigured()) {
    throw new Error('Google Drive no configurado. Pon clientId en firebase-config.js');
  }
  await initDrive();
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: googleConfig.clientId,
        scope: SCOPE,
        callback: (resp) => {
          if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
          accessToken = resp.access_token;
          tokenExpires = Date.now() + ((resp.expires_in || 3600) * 1000);
          window.gapi.client.setToken({ access_token: accessToken });
          localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: accessToken, expires: tokenExpires }));
          resolve(resp);
        },
        error_callback: (err) => reject(new Error(err?.message || 'OAuth cancelado'))
      });
    }
    tokenClient.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
  });
}

export function signOut() {
  if (accessToken && window.google?.accounts?.oauth2) {
    try { window.google.accounts.oauth2.revoke(accessToken, () => {}); } catch {}
  }
  accessToken = null;
  tokenExpires = 0;
  if (window.gapi?.client) window.gapi.client.setToken(null);
  localStorage.removeItem(TOKEN_KEY);
}

// === Folder helpers ===
async function findOrCreateFolder(name, parentId = 'root') {
  await ensureToken();
  const safeName = String(name).replace(/'/g, "\\'");
  const q = `name='${safeName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const list = await window.gapi.client.drive.files.list({ q, fields: 'files(id,name)', pageSize: 5 });
  if (list.result.files && list.result.files.length > 0) return list.result.files[0].id;

  const create = await window.gapi.client.drive.files.create({
    resource: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id'
  });
  return create.result.id;
}

// Asegura que existe la cadena de carpetas: AppRoot / {parts...}. Devuelve id de la última.
export async function ensureFolderPath(parts) {
  await ensureToken();
  let parent = await findOrCreateFolder(APP_ROOT, 'root');
  for (const p of parts.filter(Boolean)) parent = await findOrCreateFolder(String(p), parent);
  return parent;
}

// === Upload ===
export async function uploadFile(file, parentId, filename) {
  await ensureToken();
  const metadata = { name: filename, parents: [parentId] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', file);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,thumbnailLink,webViewLink,webContentLink,createdTime', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken },
    body: form
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Drive upload falló (${r.status}): ${t.slice(0, 200)}`);
  }
  return await r.json();
}

export async function deleteFile(fileId) {
  await ensureToken();
  await window.gapi.client.drive.files.delete({ fileId });
}

// Devuelve un Blob URL para mostrar imágenes en el navegador.
// Necesario porque thumbnailLink/webContentLink requieren auth y no funcionan en <img>.
const blobCache = new Map();
export async function getImageObjectUrl(fileId) {
  if (blobCache.has(fileId)) return blobCache.get(fileId);
  await ensureToken();
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  if (!r.ok) throw new Error('No se pudo descargar imagen: ' + r.status);
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  blobCache.set(fileId, url);
  return url;
}

export function clearImageCache(fileId) {
  if (fileId) {
    const url = blobCache.get(fileId);
    if (url) URL.revokeObjectURL(url);
    blobCache.delete(fileId);
  } else {
    for (const url of blobCache.values()) URL.revokeObjectURL(url);
    blobCache.clear();
  }
}

async function ensureToken() {
  if (!accessToken || tokenExpires <= Date.now() + 30_000) {
    throw new Error('Sesión de Drive no iniciada o expirada. Conecta Google Drive primero.');
  }
}

// Helper para sanear nombre de archivo
export function safeFilename(s) {
  return String(s || 'archivo').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 120);
}
