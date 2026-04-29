// Migración del catálogo OPUS de su ubicación legacy en estimaciones
// (`legacy/estimaciones/obras/{obraId}/catalogo`) al nodo compartido
// (`/shared/catalogos/{obraId}`) que también consume la bitácora.
//
// Decisiones de diseño en project_integration_vision.md y validadas con datos
// reales (Ocaso Obra Gris, 513 PUs, 208 claves repetidas) en abril 2026:
//
//  · Identidad estable de un concepto = (tipo, path completo, clave) — la misma
//    clave puede aparecer en múltiples partidas (Torre 1/Torre 2) como conceptos
//    distintos, y en ~0.5% de casos hasta con PU distinto.
//  · `conceptoKey = {clave}_{hash6(stableKey)}` para PUs (clave puede ser vacía).
//  · `conceptoKey = agr_{slug(descripcion)}_{hash6(stableKey)}` para agrupadores.
//  · Hash determinístico (FNV-1a 32-bit truncado) → re-import del mismo XLS
//    produce los mismos keys, los desgloses históricos siguen apuntando bien.
//  · La función NO borra legacy. Solo escribe en /shared y deja `migratedAt`
//    + `migrationKeyMap` en legacy para futuras migraciones de generadores y
//    desgloses históricos en bitácora.

import { rread, rupdate, appPath } from './db.js';
import { state } from '../state/store.js';

export async function migrateCatalogoToShared(obraId) {
  if (!obraId) throw new Error('obraId requerido');

  // Pre-flight: legacy debe existir, shared NO debe existir.
  const [legacy, sharedActual] = await Promise.all([
    rread(`obras/${obraId}/catalogo`),
    rread(`/shared/catalogos/${obraId}`)
  ]);

  if (!legacy?.conceptos) throw new Error('La obra no tiene catálogo importado en legacy.');
  if (sharedActual) throw new Error('Esta obra ya tiene catálogo en /shared/catalogos. Migración abortada para evitar pisar datos.');

  const legacyConceptos = legacy.conceptos;
  const legacyEntries = Object.entries(legacyConceptos);

  // Calcular conceptoKey por cada concepto. Detectar colisiones (mismo stableKey
  // en dos filas del XLS = caso muy raro, lo desambiguamos con sufijo _2, _3…).
  const keyMap = {};                  // legacyId → conceptoKey
  const collisionLog = [];            // [{stableKey, ids, resolvedKeys}]
  const usedKeys = new Map();         // baseKey → count
  const conceptosNuevos = {};         // conceptoKey → concepto

  for (const [legacyId, c] of legacyEntries) {
    const baseKey = computeConceptoKey(c);
    const prevCount = usedKeys.get(baseKey) || 0;
    const finalKey = prevCount === 0 ? baseKey : `${baseKey}_${prevCount + 1}`;
    usedKeys.set(baseKey, prevCount + 1);

    if (prevCount > 0) {
      const existing = collisionLog.find(e => e.baseKey === baseKey);
      if (existing) existing.resolvedKeys.push(finalKey);
      else collisionLog.push({ baseKey, baseStableKey: computeStableKey(c), resolvedKeys: [baseKey, finalKey] });
    }

    keyMap[legacyId] = finalKey;
    conceptosNuevos[finalKey] = sanitizeConcepto(c);
  }

  // Totales para meta
  const totalPUs = Object.values(conceptosNuevos)
    .filter(c => c.tipo === 'precio_unitario')
    .reduce((s, c) => s + (c.total || 0), 0);
  const totalRaices = Object.values(conceptosNuevos)
    .filter(c => c.tipo === 'agrupador' && (c.nivel === 0))
    .reduce((s, c) => s + (c.total || 0), 0);

  const now = Date.now();
  const sharedCatalogo = {
    meta: {
      sourceFileName: legacy.sourceFileName || null,
      importedAt: legacy.importedAt || null,
      version: 1,
      hash: null,                              // se llenará en re-imports futuros
      totalPUs,
      totalRaices,
      conceptosCount: legacyEntries.length,
      migratedFromLegacyAt: now,
      migratedByUid: state?.user?.uid || null
    },
    conceptos: conceptosNuevos
  };

  // Escritura atómica en multi-path: shared + flags en legacy. Si falla cualquiera,
  // no se aplica nada.
  const updates = {
    [`shared/catalogos/${obraId}`]: sharedCatalogo,
    [appPath(`obras/${obraId}/catalogo/migratedAt`)]: now,
    [appPath(`obras/${obraId}/catalogo/migrationKeyMap`)]: keyMap
  };
  await rupdate('/', updates);

  return {
    ok: true,
    obraId,
    conceptosCount: legacyEntries.length,
    pusCount: legacyEntries.filter(([, c]) => c.tipo === 'precio_unitario').length,
    agrupadoresCount: legacyEntries.filter(([, c]) => c.tipo === 'agrupador').length,
    collisions: collisionLog,
    keyMap,
    sharedPath: `/shared/catalogos/${obraId}`
  };
}

// Identidad estable: replica la fórmula que usa `reconcileCatalogo` en db.js.
// Cualquier cambio aquí debe sincronizarse allí.
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
  // PU (incluye los pocos sin clave: ej "_a3f2c1")
  const claveCleaned = sanitizeKeySegment(c.clave || '');
  return `${claveCleaned}_${h}`;
}

// FNV-1a 32-bit, devuelve hex de 6 chars.
function hash6(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(-6);
}

// Slug ASCII para descripciones de agrupadores. Limita longitud para keys razonables.
function slug(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'sn';
}

// RTDB no acepta `.`, `#`, `$`, `[`, `]`, `/` en keys. Las claves OPUS suelen ser
// alfanuméricas con guiones, pero por seguridad sanitizamos.
function sanitizeKeySegment(s) {
  return String(s).replace(/[.#$[\]/]/g, '_');
}

// Snapshot del concepto con solo los campos canónicos. Evita cargar `id` u otros
// campos efímeros que el parser pudo haber dejado.
function sanitizeConcepto(c) {
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

// Helper para vista admin: resumen del estado de migración de una obra.
// Devuelve uno de: 'sin-catalogo' | 'legacy' | 'migrado' | 'shared-only'.
export async function getCatalogoMigrationStatus(obraId) {
  const [legacy, shared] = await Promise.all([
    rread(`obras/${obraId}/catalogo`),
    rread(`/shared/catalogos/${obraId}`)
  ]);
  const hasLegacy = !!legacy?.conceptos;
  const hasShared = !!shared?.conceptos;
  const migratedAt = legacy?.migratedAt || null;

  if (!hasLegacy && !hasShared) return { status: 'sin-catalogo', count: 0 };
  if (hasLegacy && !hasShared) return {
    status: 'legacy', count: Object.keys(legacy.conceptos).length, migratedAt
  };
  if (!hasLegacy && hasShared) return {
    status: 'shared-only', count: Object.keys(shared.conceptos).length
  };
  return {
    status: 'migrado',
    count: Object.keys(shared.conceptos).length,
    legacyCount: Object.keys(legacy.conceptos).length,
    migratedAt
  };
}
