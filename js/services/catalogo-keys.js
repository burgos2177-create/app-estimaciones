// Funciones puras para derivar conceptoKey estables. Usadas por la migración
// inicial (catalogo-migration.js), por re-imports a /shared (db.js
// reconcileCatalogo) y por el aprobador del buzón en bitácora.
//
// Decisión: `conceptoKey = {clave}_{hash6(stableKey)}` para PUs, y
// `agr_{slug(descripcion)}_{hash6(stableKey)}` para agrupadores.
//   · stableKey = (tipo, path completo, clave) — replica la fórmula histórica
//     que usa reconcileCatalogo legacy en db.js. Cualquier cambio aquí debe
//     mantenerla en sincronía.
//   · El hash es determinístico (FNV-1a 32-bit truncado a 6 hex), así el mismo
//     concepto siempre produce el mismo key, sin importar qué app lo derive.

export function computeStableKey(c) {
  const pathStr = (c.path || []).map(p => `${p?.clave || ''}|${p?.descripcion || ''}`).join('>>');
  return `${c.tipo || ''}::${pathStr}::${c.clave || ''}`;
}

export function computeConceptoKey(c) {
  const stable = computeStableKey(c);
  const h = hash6(stable);
  if (c.tipo === 'agrupador') {
    return `agr_${slug(c.descripcion || '')}_${h}`;
  }
  return `${sanitizeKeySegment(c.clave || '')}_${h}`;
}

// FNV-1a 32-bit, devuelve hex de 6 chars.
export function hash6(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(-6);
}

// Slug ASCII para descripciones de agrupadores. Limita longitud.
export function slug(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'sn';
}

// RTDB rechaza `.`, `#`, `$`, `[`, `]`, `/` en keys.
export function sanitizeKeySegment(s) {
  return String(s).replace(/[.#$[\]/]/g, '_');
}

// Snapshot canónico del concepto (campos del XLS + flags estimaciones-only).
export function sanitizeConcepto(c) {
  return {
    tipo: c.tipo,
    clave: c.clave || '',
    descripcion: c.descripcion || '',
    unidad: c.unidad || '',
    cantidad: Number(c.cantidad) || 0,
    precio_unitario: Number(c.precio_unitario) || 0,
    total: Number(c.total) || 0,
    nivel: Number(c.nivel) || 0,
    path: c.path || [],
    agrupadores: c.agrupadores || [],
    orden: Number(c.orden) || 0,
    plantillaTipo: c.plantillaTipo || null,
    plantillaConfig: c.plantillaConfig || null,
    archivado: !!c.archivado
  };
}
