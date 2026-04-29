import {
  ref, get, set, update, push, remove, onValue, off, child
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js';
import { db } from './firebase.js';
import { APP_BASE_PATH } from '../config/firebase-config.js';

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

// ref helper que respeta APP_BASE_PATH
function _ref(path) { return ref(db, _resolve(path)); }

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
export async function saveCatalogo(obraId, catalogo) {
  // catalogo = { sourceFileName, importedAt, conceptos: { id → concepto } }
  await set(_ref(`obras/${obraId}/catalogo`), catalogo);
}

export async function reconcileCatalogo(obraId, nuevosConceptos, sourceFileName) {
  // Reemplaza el catálogo respetando la jerarquía del XLS. Reglas:
  //  · TODOS los conceptos del XLS se conservan, sin dedupe agresivo. La misma clave puede
  //    aparecer en múltiples partidas (Torre 1, Torre 2, etc.) y son conceptos distintos.
  //  · Identidad estable de un concepto = (tipo, path completo, clave). Eso permite que al
  //    re-importar el mismo XLS, los generadores existentes sigan apuntando al mismo ID.
  //  · Si misma identidad aparece varias veces en el XLS (caso raro), cada repetición se
  //    inserta con su propio ID nuevo (no se pierde nada).
  //  · Conceptos viejos cuya identidad ya no existe pero tienen generadores/avances se
  //    conservan archivados.
  const prevConceptos = await rread(`obras/${obraId}/catalogo/conceptos`) || {};
  const generadores = await rread(`obras/${obraId}/generadores`) || {};
  const avances = await rread(`obras/${obraId}/avances`) || {};

  const stableKey = c => {
    const pathStr = (c.path || []).map(p => `${p?.clave || ''}|${p?.descripcion || ''}`).join('>>');
    return `${c.tipo || ''}::${pathStr}::${c.clave || ''}`;
  };

  // Snapshot por clave estable → datos del previo
  const prevByStable = new Map();
  for (const [id, c] of Object.entries(prevConceptos)) {
    const k = stableKey(c);
    if (!prevByStable.has(k)) {
      prevByStable.set(k, { id, plantillaTipo: c.plantillaTipo, plantillaConfig: c.plantillaConfig });
    }
  }

  // IDs referenciados por generadores/avances
  const referenciados = new Set();
  for (const g of Object.values(generadores)) if (g.conceptoId) referenciados.add(g.conceptoId);
  for (const cid of Object.keys(avances)) referenciados.add(cid);

  const merged = {};

  for (const c of nuevosConceptos) {
    const k = stableKey(c);
    const previo = prevByStable.get(k);
    let id = previo?.id || c.id;
    // Si por algún motivo varios nuevos colapsan al mismo ID (misma identidad), forzar nuevo
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

  // Conservar archivados los previos con referencias cuya identidad ya no existe
  const newKeys = new Set(nuevosConceptos.map(stableKey));
  for (const [id, c] of Object.entries(prevConceptos)) {
    if (newKeys.has(stableKey(c))) continue;
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
  await update(_ref(`obras/${obraId}/catalogo/conceptos/${conceptoId}`), {
    plantillaTipo, plantillaConfig
  });
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
