import {
  ref, get, set, update, push, remove, onValue, off, child
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js';
import { db } from './firebase.js';
import { APP_BASE_PATH } from '../config/firebase-config.js';
import { computeStableKey, computeConceptoKey, sanitizeConcepto } from './catalogo-keys.js';

// Prefija toda path relativa con APP_BASE_PATH (e.g. "obras/X" → "legacy/estimaciones/obras/X").
// Para escapes que necesiten path absoluto en el RTDB compartido (p.ej. /shared/buzon),
// pasar el path comenzando con "/" y se interpretará como absoluto, sin prefijo.
function _resolve(path) {
  if (typeof path !== 'string') throw new Error('path debe ser string');
  if (path.startsWith('/')) return path.slice(1);    // absoluto
  return APP_BASE_PATH ? `${APP_BASE_PATH}/${path}` : path;
}

// Helper público: devuelve el path absoluto resuelto (para componer paths como
// `obras/${id}/algo` y luego usarlos con set(ref(db, ...)) directamente).
export function appPath(relPath) { return _resolve(relPath); }

// ref helper que respeta APP_BASE_PATH. Si el resolved queda vacío (path "/"
// para multi-path updates en root), devuelve la referencia root sin string vacío
// (Firebase v10 rechaza ref(db, "")).
function _ref(path) {
  const resolved = _resolve(path);
  return resolved ? ref(db, resolved) : ref(db);
}

export function rread(path) {
  return get(_ref(path)).then(s => s.exists() ? s.val() : null);
}
export function rset(path, val) { return set(_ref(path), val); }
export function rupdate(path, patch) { return update(_ref(path), patch); }
export function rpush(path, val) {
  const r = push(_ref(path));
  return set(r, val).then(() => r.key);
}
export function rremove(path) { return remove(_ref(path)); }
export function rwatch(path, cb) {
  const r = _ref(path);
  const handler = onValue(r, s => cb(s.exists() ? s.val() : null));
  return () => off(r, 'value', handler);
}

// === Obras ===
export async function listObrasForUser(user) {
  if (user.role === 'admin') {
    const all = await rread('obras');
    return all || {};
  }
  const map = await rread(`users/${user.uid}/obrasAsignadas`) || {};
  const ids = Object.keys(map);
  const out = {};
  await Promise.all(ids.map(async id => {
    const o = await rread(`obras/${id}`);
    if (o) out[id] = o;
  }));
  return out;
}

export async function createObra(meta, ownerUid) {
  const r = push(_ref('obras'));
  const obra = {
    meta: {
      nombre: meta.nombre || 'Sin nombre',
      ubicacion: meta.ubicacion || '',
      municipio: meta.municipio || '',
      programa: meta.programa || 'PRIVADO',
      contratoNo: meta.contratoNo || '',
      montoContratoCIVA: Number(meta.montoContratoCIVA) || 0,
      fechaInicio: meta.fechaInicio || null,
      fechaFin: meta.fechaFin || null,
      construye: meta.construye || '',
      cliente: meta.cliente || '',
      ivaPct: Number(meta.ivaPct ?? 0.16),
      anticipoPct: Number(meta.anticipoPct ?? 0),
      driveFolderId: '',
      ownerUid,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  };
  await set(r, obra);
  return r.key;
}

export async function updateObraMeta(obraId, patch) {
  patch.updatedAt = Date.now();
  await update(_ref(`obras/${obraId}/meta`), patch);
}

export async function deleteObra(obraId) {
  await remove(_ref(`obras/${obraId}`));
}

// === Catálogo OPUS ===
//
// Fuente de verdad: `/shared/catalogos/{obraId}` (compartido con bitácora).
// Compatibilidad: si una obra todavía no se migra, sigue viviendo en
// `obras/{obraId}/catalogo` (legacy). `loadObra` y los writers detectan dónde
// está la fuente y ajustan su comportamiento.

// Carga la obra completa con su catálogo resuelto. Si la obra está migrada,
// `obra.catalogo.conceptos` viene de /shared y `_source === 'shared'`. Si no,
// `_source === 'legacy'`.
export async function loadObra(obraId) {
  const [obra, shared] = await Promise.all([
    rread(`obras/${obraId}`),
    rread(`/shared/catalogos/${obraId}`)
  ]);
  if (!obra) return null;
  if (shared?.conceptos) {
    obra.catalogo = {
      sourceFileName: shared.meta?.sourceFileName ?? null,
      importedAt: shared.meta?.importedAt ?? null,
      migratedAt: obra.catalogo?.migratedAt ?? shared.meta?.migratedFromLegacyAt ?? null,
      migrationKeyMap: obra.catalogo?.migrationKeyMap ?? null,
      conceptos: shared.conceptos,
      _source: 'shared',
      _meta: shared.meta
    };
  } else if (obra.catalogo) {
    obra.catalogo._source = 'legacy';
  }
  return obra;
}

// Resuelve un conceptoId a su concepto en obra.catalogo.conceptos. Si el ID es
// legacy y el catálogo está en /shared, mapea via migrationKeyMap. Devuelve null
// si no se encuentra.
export function getConceptoById(obra, conceptoId) {
  const conceptos = obra?.catalogo?.conceptos;
  if (!conceptos || !conceptoId) return null;
  if (conceptos[conceptoId]) return conceptos[conceptoId];
  const map = obra?.catalogo?.migrationKeyMap;
  if (map && map[conceptoId] && conceptos[map[conceptoId]]) return conceptos[map[conceptoId]];
  return null;
}

// Devuelve la key efectiva del concepto en obra.catalogo.conceptos para un
// conceptoId que puede ser legacy o ya migrado. Para views que usan el ID como
// clave en sus propios maps (ejecMap, avances, etc.) sin re-leer RTDB.
export function resolveConceptoKeyLocal(obra, conceptoId) {
  const conceptos = obra?.catalogo?.conceptos;
  if (!conceptos || !conceptoId) return null;
  if (conceptos[conceptoId]) return conceptoId;
  const map = obra?.catalogo?.migrationKeyMap;
  if (map && map[conceptoId] && conceptos[map[conceptoId]]) return map[conceptoId];
  return null;
}

// Devuelve un lookup donde tanto conceptoKey como legacyId resuelven al concepto.
// Útil para views que pasan `conceptosAll` a varios helpers internos y hacen
// muchos lookups por ID (subcontrato, sub-estimación). Iterar ESTE objeto
// duplicaría conceptos — para iterar usar `obra.catalogo.conceptos` directo.
export function buildConceptosLookup(obra) {
  const conceptos = obra?.catalogo?.conceptos || {};
  const map = obra?.catalogo?.migrationKeyMap;
  if (!map) return conceptos;
  const lookup = { ...conceptos };
  for (const [legacyId, conceptoKey] of Object.entries(map)) {
    if (lookup[conceptoKey] && !(legacyId in lookup)) {
      lookup[legacyId] = lookup[conceptoKey];
    }
  }
  return lookup;
}

// Resuelve un conceptoId legacy → conceptoKey actual (para writers que necesitan
// la key correcta en /shared). Si no hay map o el ID no está mapeado, regresa el
// mismo ID (caso obra no migrada o concepto recién creado con key shared).
export async function resolveConceptoKey(obraId, conceptoId) {
  const map = await rread(`obras/${obraId}/catalogo/migrationKeyMap`);
  return map && map[conceptoId] ? map[conceptoId] : conceptoId;
}

export async function reconcileCatalogo(obraId, nuevosConceptos, sourceFileName) {
  // Decide dónde escribir: /shared si la obra está migrada O si no tiene
  // catálogo legacy aún (primera importación → directo a /shared).
  const [sharedMeta, legacyConceptos] = await Promise.all([
    rread(`/shared/catalogos/${obraId}/meta`),
    rread(`obras/${obraId}/catalogo/conceptos`)
  ]);
  if (sharedMeta || !legacyConceptos) {
    return reconcileCatalogoShared(obraId, nuevosConceptos, sourceFileName, sharedMeta);
  }
  return reconcileCatalogoLegacy(obraId, nuevosConceptos, sourceFileName);
}

// Re-import contra /shared. Reglas:
//  · conceptoKey determinístico desde (tipo, path, clave) — re-import idempotente.
//  · Si dos conceptos del XLS colapsan al mismo conceptoKey (mismas filas
//    idénticas), se desambigua con sufijo `_2`, `_3`…
//  · Plantillas (plantillaTipo/plantillaConfig) preservadas del shared previo
//    cuando el conceptoKey coincide.
//  · Conceptos shared previos cuya conceptoKey ya no aparece en el nuevo XLS
//    se archivan (archivado=true) si tienen generadores/avances apuntando.
//    Si nadie los referencia, se descartan.
async function reconcileCatalogoShared(obraId, nuevosConceptos, sourceFileName, sharedMeta) {
  const [prevConceptos, generadores, avances, keyMap] = await Promise.all([
    rread(`/shared/catalogos/${obraId}/conceptos`),
    rread(`obras/${obraId}/generadores`),
    rread(`obras/${obraId}/avances`),
    rread(`obras/${obraId}/catalogo/migrationKeyMap`)
  ]);
  const prev = prevConceptos || {};

  // IDs referenciados (puede haber legacyIds o conceptoKeys; resolvemos ambos)
  const referenciadasKeys = new Set();
  const resolveRef = id => (keyMap && keyMap[id]) ? keyMap[id] : id;
  for (const g of Object.values(generadores || {})) {
    if (g.conceptoId) referenciadasKeys.add(resolveRef(g.conceptoId));
  }
  for (const id of Object.keys(avances || {})) referenciadasKeys.add(resolveRef(id));

  const merged = {};
  const usedBaseCount = new Map();

  for (const c of nuevosConceptos) {
    const baseKey = computeConceptoKey(c);
    const count = usedBaseCount.get(baseKey) || 0;
    const finalKey = count === 0 ? baseKey : `${baseKey}_${count + 1}`;
    usedBaseCount.set(baseKey, count + 1);

    const previo = prev[finalKey];
    merged[finalKey] = {
      ...sanitizeConcepto(c),
      plantillaTipo: previo?.plantillaTipo ?? null,
      plantillaConfig: previo?.plantillaConfig ?? null,
      archivado: false
    };
  }

  // Conservar archivados los previos cuya identidad ya no existe pero tienen refs
  for (const [k, c] of Object.entries(prev)) {
    if (merged[k]) continue;
    if (referenciadasKeys.has(k)) {
      merged[k] = { ...c, archivado: true };
    }
  }

  const totalPUs = Object.values(merged)
    .filter(c => c.tipo === 'precio_unitario' && !c.archivado)
    .reduce((s, c) => s + (c.total || 0), 0);
  const totalRaices = Object.values(merged)
    .filter(c => c.tipo === 'agrupador' && c.nivel === 0 && !c.archivado)
    .reduce((s, c) => s + (c.total || 0), 0);

  const nuevaMeta = {
    sourceFileName,
    importedAt: Date.now(),
    version: (sharedMeta?.version || 0) + 1,
    hash: null,
    totalPUs,
    totalRaices,
    conceptosCount: Object.keys(merged).length,
    // Preservar metadata histórica de la migración inicial
    migratedFromLegacyAt: sharedMeta?.migratedFromLegacyAt || null,
    migratedByUid: sharedMeta?.migratedByUid || null
  };

  await set(_ref(`/shared/catalogos/${obraId}`), {
    meta: nuevaMeta,
    conceptos: merged
  });
  return merged;
}

// Re-import legacy (path antiguo, solo si la obra no está migrada).
// Comportamiento histórico, conservado por compatibilidad. Una obra creada
// post-A3 nunca llega aquí (siempre cae en reconcileCatalogoShared).
async function reconcileCatalogoLegacy(obraId, nuevosConceptos, sourceFileName) {
  const prevConceptos = await rread(`obras/${obraId}/catalogo/conceptos`) || {};
  const generadores = await rread(`obras/${obraId}/generadores`) || {};
  const avances = await rread(`obras/${obraId}/avances`) || {};

  const stableKeyOf = c => computeStableKey(c);

  const prevByStable = new Map();
  for (const [id, c] of Object.entries(prevConceptos)) {
    const k = stableKeyOf(c);
    if (!prevByStable.has(k)) {
      prevByStable.set(k, { id, plantillaTipo: c.plantillaTipo, plantillaConfig: c.plantillaConfig });
    }
  }
  const referenciados = new Set();
  for (const g of Object.values(generadores)) if (g.conceptoId) referenciados.add(g.conceptoId);
  for (const cid of Object.keys(avances)) referenciados.add(cid);

  const merged = {};
  for (const c of nuevosConceptos) {
    const k = stableKeyOf(c);
    const previo = prevByStable.get(k);
    let id = previo?.id || c.id;
    if (merged[id]) {
      id = c.id;
      let i = 0;
      while (merged[id]) id = `${c.id}_${++i}`;
    }
    merged[id] = {
      tipo: c.tipo,
      clave: c.clave,
      descripcion: c.descripcion,
      unidad: c.unidad,
      cantidad: c.cantidad,
      precio_unitario: c.precio_unitario,
      total: c.total,
      nivel: c.nivel,
      path: c.path,
      agrupadores: c.agrupadores,
      orden: c.orden,
      plantillaTipo: previo?.plantillaTipo || null,
      plantillaConfig: previo?.plantillaConfig || null,
      archivado: false
    };
  }
  const newKeys = new Set(nuevosConceptos.map(stableKeyOf));
  for (const [id, c] of Object.entries(prevConceptos)) {
    if (newKeys.has(stableKeyOf(c))) continue;
    if (referenciados.has(id)) {
      if (!merged[id]) merged[id] = { ...c, archivado: true };
    }
  }
  await set(_ref(`obras/${obraId}/catalogo`), {
    sourceFileName,
    importedAt: Date.now(),
    conceptos: merged
  });
  return merged;
}

export async function setPlantillaConcepto(obraId, conceptoId, plantillaTipo, plantillaConfig = null) {
  // Detecta dónde vive el catálogo. Si está en /shared, escribimos ahí (mapeando
  // legacyId si hace falta). Si solo hay legacy, mantenemos el comportamiento viejo.
  const sharedMeta = await rread(`/shared/catalogos/${obraId}/meta`);
  if (sharedMeta) {
    const key = await resolveConceptoKey(obraId, conceptoId);
    await update(_ref(`/shared/catalogos/${obraId}/conceptos/${key}`), {
      plantillaTipo, plantillaConfig
    });
  } else {
    await update(_ref(`obras/${obraId}/catalogo/conceptos/${conceptoId}`), {
      plantillaTipo, plantillaConfig
    });
  }
}

// === Estimaciones ===
export async function createEstimacion(obraId, data) {
  const all = await rread(`obras/${obraId}/estimaciones`) || {};
  const numero = Math.max(0, ...Object.values(all).map(e => e.numero || 0)) + 1;
  const r = push(_ref(`obras/${obraId}/estimaciones`));
  await set(r, {
    numero,
    fechaCorte: data.fechaCorte || Date.now(),
    periodoIni: data.periodoIni || null,
    periodoFin: data.periodoFin || null,
    estado: 'borrador',
    createdAt: Date.now()
  });
  return r.key;
}

export async function cerrarEstimacion(obraId, estimId, uid) {
  await update(_ref(`obras/${obraId}/estimaciones/${estimId}`), {
    estado: 'cerrada', cerradaAt: Date.now(), cerradaPor: uid
  });
}
export async function reabrirEstimacion(obraId, estimId) {
  await update(_ref(`obras/${obraId}/estimaciones/${estimId}`), {
    estado: 'borrador', cerradaAt: null, cerradaPor: null
  });
}

// === Generadores ===
export async function createGenerador(obraId, data) {
  const all = await rread(`obras/${obraId}/generadores`) || {};
  const inEstim = Object.values(all).filter(g => g.estimacionId === data.estimacionId);
  const numero = Math.max(0, ...inEstim.map(g => g.numero || 0)) + 1;
  const r = push(_ref(`obras/${obraId}/generadores`));
  await set(r, { numero, ...data, createdAt: Date.now(), updatedAt: Date.now() });
  return r.key;
}
export async function saveGenerador(obraId, gid, data) {
  await update(_ref(`obras/${obraId}/generadores/${gid}`), { ...data, updatedAt: Date.now() });
}
export async function setAvance(obraId, conceptoId, estimacionId, cantidad) {
  await set(_ref(`obras/${obraId}/avances/${conceptoId}/${estimacionId}`), Number(cantidad) || 0);
}

// === Cross-app: vínculos obra ↔ proyecto y lectura de bitácora ===
// Estos paths viven en /shared/* o /legacy/bitacora/* — no bajo APP_BASE_PATH.
// Por eso usamos paths absolutos (con "/" inicial) que el _resolve respeta.

export async function getObraLinks() {
  return (await rread('/shared/obraLinks')) || {};
}
export async function setObraLink(obraId, proyectoId) {
  if (!proyectoId) return rremove(`/shared/obraLinks/${obraId}`);
  return rset(`/shared/obraLinks/${obraId}`, proyectoId);
}
export async function getProyectosBitacora() {
  // Bitácora guarda proyectos como array (no objeto)
  const arr = await rread('/legacy/bitacora/sogrub_proyectos');
  if (!arr) return [];
  return Array.isArray(arr) ? arr : Object.values(arr);
}

// === Buzón cross-app ===
// /shared/buzon/{itemId}: { tipo, origenApp, obraId, proyectoId, ..., estado }
export async function pushBuzonItem(item) {
  return rpush('/shared/buzon', { ...item, creadoAt: Date.now() });
}
export async function listBuzonItems() {
  return (await rread('/shared/buzon')) || {};
}
export async function updateBuzonItem(itemId, patch) {
  return rupdate(`/shared/buzon/${itemId}`, patch);
}
export async function removeBuzonItem(itemId) {
  return rremove(`/shared/buzon/${itemId}`);
}

// === Adjuntos del generador (croquis y fotos) ===
export async function addGeneradorAttachment(obraId, gid, kind, attachment) {
  // kind: 'croquis' | 'fotos'
  const path = `obras/${obraId}/generadores/${gid}/${kind}`;
  const cur = await rread(path) || [];
  const list = Array.isArray(cur) ? cur : Object.values(cur);
  list.push(attachment);
  await set(_ref(path), list);
  return list;
}
export async function removeGeneradorAttachment(obraId, gid, kind, driveId) {
  const path = `obras/${obraId}/generadores/${gid}/${kind}`;
  const cur = await rread(path) || [];
  const list = (Array.isArray(cur) ? cur : Object.values(cur)).filter(a => a.driveId !== driveId);
  await set(_ref(path), list);
  return list;
}

export async function setPagoCliente(obraId, estimId, pago) {
  await set(_ref(`obras/${obraId}/estimaciones/${estimId}/pagoCliente`), pago);
}

// === Subcontratos ===
export async function createSubcontrato(obraId, data) {
  const r = push(_ref(`obras/${obraId}/subcontratos`));
  await set(r, {
    meta: {
      nombre: data.nombre || 'Subcontrato',
      descripcion: data.descripcion || '',
      estado: 'cotizando',
      licitanteAdjudicadoId: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    },
    conceptos: data.conceptos || [],
    licitantes: {}
  });
  return r.key;
}
export async function updateSubcontratoMeta(obraId, subId, patch) {
  patch.updatedAt = Date.now();
  await update(_ref(`obras/${obraId}/subcontratos/${subId}/meta`), patch);
}
export async function setSubcontratoConceptos(obraId, subId, conceptos) {
  await set(_ref(`obras/${obraId}/subcontratos/${subId}/conceptos`), conceptos);
  await update(_ref(`obras/${obraId}/subcontratos/${subId}/meta`), { updatedAt: Date.now() });
}
export async function deleteSubcontrato(obraId, subId) {
  await remove(_ref(`obras/${obraId}/subcontratos/${subId}`));
}

// === Licitantes ===
export async function addLicitante(obraId, subId, data) {
  const r = push(_ref(`obras/${obraId}/subcontratos/${subId}/licitantes`));
  await set(r, {
    nombre: data.nombre || 'Licitante',
    email: data.email || '',
    telefono: data.telefono || '',
    contacto: data.contacto || '',
    precios: data.precios || {},
    notas: data.notas || '',
    archivado: false,
    fechaCotizacion: data.fechaCotizacion || Date.now()
  });
  return r.key;
}
export async function updateLicitante(obraId, subId, licId, patch) {
  await update(_ref(`obras/${obraId}/subcontratos/${subId}/licitantes/${licId}`), patch);
}
export async function setLicitantePrecio(obraId, subId, licId, conceptoId, precio) {
  await set(_ref(`obras/${obraId}/subcontratos/${subId}/licitantes/${licId}/precios/${conceptoId}`), Number(precio) || 0);
}
export async function setLicitantePrecios(obraId, subId, licId, precios) {
  await set(_ref(`obras/${obraId}/subcontratos/${subId}/licitantes/${licId}/precios`), precios);
}
export async function deleteLicitante(obraId, subId, licId) {
  await remove(_ref(`obras/${obraId}/subcontratos/${subId}/licitantes/${licId}`));
}

// === Adjudicación + estimaciones del subcontratista ===
export async function adjudicarSubcontrato(obraId, subId, licId) {
  await update(_ref(`obras/${obraId}/subcontratos/${subId}/meta`), {
    estado: 'adjudicado',
    licitanteAdjudicadoId: licId,
    adjudicadoAt: Date.now(),
    updatedAt: Date.now()
  });
}
export async function desadjudicarSubcontrato(obraId, subId) {
  await update(_ref(`obras/${obraId}/subcontratos/${subId}/meta`), {
    estado: 'cotizando',
    licitanteAdjudicadoId: null,
    adjudicadoAt: null,
    updatedAt: Date.now()
  });
}

export async function createSubEstimacion(obraId, subId, data) {
  const all = await rread(`obras/${obraId}/subcontratos/${subId}/estimaciones`) || {};
  const numero = Math.max(0, ...Object.values(all).map(e => e.numero || 0)) + 1;
  const r = push(_ref(`obras/${obraId}/subcontratos/${subId}/estimaciones`));
  await set(r, {
    numero,
    fechaCorte: data.fechaCorte || Date.now(),
    periodoIni: data.periodoIni || null,
    periodoFin: data.periodoFin || null,
    estado: 'borrador',
    avances: {},                  // conceptoId → cantidad ejecutada por el sub
    pagoSub: null,
    createdAt: Date.now()
  });
  return r.key;
}
export async function setSubEstimacionAvance(obraId, subId, estId, conceptoId, cantidad) {
  await set(_ref(`obras/${obraId}/subcontratos/${subId}/estimaciones/${estId}/avances/${conceptoId}`), Number(cantidad) || 0);
}
export async function cerrarSubEstimacion(obraId, subId, estId, uid) {
  await update(_ref(`obras/${obraId}/subcontratos/${subId}/estimaciones/${estId}`), {
    estado: 'cerrada', cerradaAt: Date.now(), cerradaPor: uid
  });
}
export async function reabrirSubEstimacion(obraId, subId, estId) {
  await update(_ref(`obras/${obraId}/subcontratos/${subId}/estimaciones/${estId}`), {
    estado: 'borrador', cerradaAt: null, cerradaPor: null
  });
}
export async function setPagoSub(obraId, subId, estId, pago) {
  await set(_ref(`obras/${obraId}/subcontratos/${subId}/estimaciones/${estId}/pagoSub`), pago);
}
export async function deleteSubEstimacion(obraId, subId, estId) {
  await remove(_ref(`obras/${obraId}/subcontratos/${subId}/estimaciones/${estId}`));
}
