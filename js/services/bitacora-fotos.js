// ============================================================================
// Bitácora de Obra — fotos en Firebase Storage (bucket compartido sogrub-suite,
// mismo mecanismo que appsogrub usa para facturas). Ruta:
//   bitacora-obra/{obraId}/{notaId}/{i}.jpg
// La nota guarda solo [{url, path}] en RTDB (no el binario). Evidencia legal
// centralizada, sin OAuth de Drive ni base64 inflando la DB.
// ============================================================================

import { getStorage, ref as sref, uploadBytes, getDownloadURL, deleteObject }
  from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js';
import { app } from './firebase.js';

const storage = getStorage(app);

// Comprime una imagen a JPEG (máx 1280px, calidad decreciente hasta <1.4 MB).
// Portado del HTML original, pero devuelve Blob (para subir a Storage).
export function comprimir(file) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1280; let w = img.width, h = img.height;
      if (w > MAX || h > MAX) { const r = Math.min(MAX / w, MAX / h); w = Math.round(w * r); h = Math.round(h * r); }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      const tryQ = (q) => c.toBlob((blob) => {
        if (blob && (blob.size > 1400000) && q > 0.35) return tryQ(q - 0.1);
        URL.revokeObjectURL(img.src); res(blob);
      }, 'image/jpeg', q);
      tryQ(0.72);
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); res(null); };
    img.src = URL.createObjectURL(file);
  });
}

export async function subirFoto(obraId, notaId, i, blob) {
  const path = `bitacora-obra/${obraId}/${notaId}/${i}.jpg`;
  const r = sref(storage, path);
  await uploadBytes(r, blob, { contentType: 'image/jpeg' });
  const url = await getDownloadURL(r);
  return { url, path };
}

export async function borrarFoto(path) {
  if (!path) return;
  try { await deleteObject(sref(storage, path)); } catch (e) { /* ya no existe / permiso: ignorar */ }
}
