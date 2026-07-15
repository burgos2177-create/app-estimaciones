// ============================================================================
// Bitácora de Obra — adaptador de persistencia sobre Firebase RTDB.
// Namespaceado por obra en /legacy/estimaciones/obras/{obraId}/bitacora/
// (hereda las reglas de acceso de la obra: admin o ingeniero asignado). No
// colisiona con la Bitácora Financiera del contador (/legacy/bitacora/*).
//
// El folio consecutivo sin colisión se garantiza con runTransaction sobre el
// nodo de notas: folio y nota se escriben en la MISMA transacción, así dos
// residentes asentando a la vez no colisionan ni dejan huecos ni "queman" folio.
// ============================================================================

import { ref, runTransaction } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js';
import { db } from './firebase.js';
import { appPath, rread, rset, rremove, rupdate } from './db.js';
import { mAsentar, mCrearAsentada, mAnular, mAgregarFotos, nextFolioFrom } from './bitacora-core.js';

export { CLS, esMutable, nextFolioFrom } from './bitacora-core.js';

const _base = (obraId) => `obras/${obraId}/bitacora`;
function _notasRef(obraId) { return ref(db, appPath(`${_base(obraId)}/notas`)); }

// Lee la bitácora completa de una obra → { meta, notas[] ordenadas, notasObj }.
export async function loadBitacora(obraId) {
  const node = await rread(_base(obraId));
  const notasObj = (node && node.notas) || {};
  const notas = Object.values(notasObj).sort((a, b) =>
    ((a.folio || 0) - (b.folio || 0)) || ((a.creadaEn || 0) - (b.creadaEn || 0)));
  return { meta: (node && node.meta) || null, notas, notasObj };
}

export function guardarBorrador(obraId, nota) { return rset(`${_base(obraId)}/notas/${nota.id}`, nota); }
export function borrarNota(obraId, notaId)   { return rremove(`${_base(obraId)}/notas/${notaId}`); }
export function setBitacoraMeta(obraId, patch){ return rupdate(`${_base(obraId)}/meta`, patch); }

// Corre un mutador puro dentro de la transacción del nodo de notas. Si el mutador
// lanza (invariante violada / carrera), la transacción aborta sin escribir.
async function _tx(obraId, fn) {
  let out, err;
  await runTransaction(_notasRef(obraId), (notas) => {
    notas = notas || {};
    try { out = fn(notas); err = null; }
    catch (e) { err = e; return; }   // return undefined = abortar transacción
    return notas;
  });
  if (err) throw err;
  return out;
}

export function asentarNota(obraId, notaId) {
  const now = new Date().toISOString();
  return _tx(obraId, (notas) => mAsentar(notas, notaId, now));
}
export function crearNotaAsentada(obraId, nota) {
  const now = new Date().toISOString();
  return _tx(obraId, (notas) => mCrearAsentada(notas, nota, now));
}
export function anularNota(obraId, targetId, motivo, notaNueva) {
  const now = new Date().toISOString();
  return _tx(obraId, (notas) => mAnular(notas, targetId, motivo, notaNueva, now));
}
// Adjunta fotos (evidencia) a una nota ya guardada/asentada. Transaccional para
// no pisar fotos que otro residente adjunte a la vez.
export function agregarFotosNota(obraId, notaId, nuevasFotos) {
  return _tx(obraId, (notas) => mAgregarFotos(notas, notaId, nuevasFotos));
}
