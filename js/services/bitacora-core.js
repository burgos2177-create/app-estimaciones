// ============================================================================
// Bitácora de Obra — núcleo PURO (sin Firebase). Aquí viven las invariantes
// legales (folio consecutivo, inmutabilidad de asentadas, anulación). Se ejecuta
// dentro de la transacción RTDB (bitacora.js) y se prueba aislado (bitacora.test.mjs).
//
// Reglas (RLOPSRM arts. 94, 122–125, adaptado a obra privada):
//  - Folio consecutivo sin huecos, asignado SOLO al asentar.
//  - Fecha del sistema al asentar; nunca la aporta el usuario.
//  - Nota asentada = inmutable: no editar/borrar; corrección solo por anulación
//    + nota nueva con referencia y motivo.
//  - Cierre bloquea altas.
// ============================================================================

export const CLS = ['AVANCE','ORDEN','SOLICITUD','AUTORIZACIÓN','CERTIFICACIÓN','INCIDENCIA','SUSPENSIÓN','REANUDACIÓN','SEGURIDAD','CALIDAD','CLIMA','ENTREGA DOCS','OTRO'];

// Siguiente folio = (máximo folio existente) + 1. Los borradores tienen folio 0.
export function nextFolioFrom(notas) {
  let max = 0;
  for (const n of Object.values(notas || {})) { const f = (n && n.folio) || 0; if (f > max) max = f; }
  return max + 1;
}

export function esMutable(nota) { return !!nota && nota.estado === 'borrador'; }

// --- Mutadores puros sobre el objeto `notas` (clave = notaId). Lanzan si se
//     viola una invariante; dentro de runTransaction eso aborta sin escribir. ---

// Asienta un borrador: le asigna folio consecutivo + fecha del sistema.
export function mAsentar(notas, notaId, nowISO) {
  const n = notas[notaId];
  if (!n) throw new Error('Nota no encontrada');
  if (n.estado !== 'borrador') throw new Error('Una nota asentada es inmutable: no puede re-asentarse');
  n.folio = nextFolioFrom(notas);
  n.estado = 'asentada';
  n.fecha = nowISO;        // fecha del sistema (no antedatar/posfechar)
  n.asentadaEn = nowISO;
  return n.folio;
}

// Crea una nota YA asentada (apertura, cierre, o la nota de anulación).
export function mCrearAsentada(notas, nota, nowISO) {
  const folio = nextFolioFrom(notas);
  notas[nota.id] = { ...nota, folio, estado: 'asentada', fecha: nowISO, asentadaEn: nowISO };
  return folio;
}

// Anula una asentada: la marca 'anulada' y crea la nota de anulación (asentada)
// con referencia a la anulada. La anulada permanece como constancia.
export function mAnular(notas, targetId, motivo, notaNueva, nowISO) {
  const t = notas[targetId];
  if (!t) throw new Error('Nota a anular no encontrada');
  if (t.estado !== 'asentada') throw new Error('Solo una nota asentada puede anularse');
  const folio = nextFolioFrom(notas);
  t.estado = 'anulada';
  t.anuladaPor = folio;
  t.motivoAnulacion = motivo;
  notas[notaNueva.id] = { ...notaNueva, folio, ref: t.folio, estado: 'asentada', fecha: nowISO, asentadaEn: nowISO };
  return folio;
}
