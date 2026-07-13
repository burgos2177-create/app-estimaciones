// Prueba de invariantes de la bitácora (núcleo puro, sin Firebase).
//   node js/services/bitacora.test.mjs
import { mAsentar, mCrearAsentada, mAnular, nextFolioFrom } from './bitacora-core.js';

let fail = 0;
const ok  = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FALLA: ') + msg); if (!cond) fail++; };
const throws = (fn, msg) => { let t = false; try { fn(); } catch { t = true; } ok(t, msg); };
const NOW = '2026-07-11T10:00:00.000Z';

// Todo folio emitido (folio ≥ 1), incluidas las anuladas: una nota anulada
// conserva su folio como constancia, así que sigue ocupando su lugar en la
// numeración consecutiva. La invariante es "1..N sin huecos ni repetidos".
const foliosAsentados = (notas) => Object.values(notas).filter(n => (n.folio || 0) >= 1)
  .map(n => n.folio).sort((a, b) => a - b);

console.log('1) Folio consecutivo sin huecos tras una secuencia real');
{
  const notas = {};
  // apertura (NOTA 001)
  mCrearAsentada(notas, { id: 'ap', cls: 'APERTURA', asunto: 'apertura' }, NOW);
  // tres borradores → asentar en orden mezclado
  notas.b1 = { id: 'b1', folio: 0, estado: 'borrador', asunto: 'a' };
  notas.b2 = { id: 'b2', folio: 0, estado: 'borrador', asunto: 'b' };
  notas.b3 = { id: 'b3', folio: 0, estado: 'borrador', asunto: 'c' };
  mAsentar(notas, 'b2', NOW);   // folio 2
  mAsentar(notas, 'b1', NOW);   // folio 3
  // anular b2 → crea nota de anulación
  mAnular(notas, 'b2', 'error de captura', { id: 'an', cls: 'AVANCE', asunto: 'anula' }, NOW);  // folio 4
  mAsentar(notas, 'b3', NOW);   // folio 5
  // cierre
  mCrearAsentada(notas, { id: 'ci', cls: 'CIERRE', asunto: 'cierre' }, NOW);  // folio 6

  const folios = foliosAsentados(notas);
  ok(JSON.stringify(folios) === JSON.stringify([1, 2, 3, 4, 5, 6]), 'folios asentados = [1..6] sin huecos → ' + JSON.stringify(folios));
  ok(new Set(folios).size === folios.length, 'sin folios duplicados');
  ok(notas.b2.estado === 'anulada' && notas.b2.anuladaPor === 4, 'la anulada conserva folio 2 y referencia a la 4');
  ok(notas.an.ref === 2, 'la nota de anulación referencia a la 2');
}

console.log('2) Nota asentada = inmutable');
{
  const notas = {};
  notas.x = { id: 'x', folio: 0, estado: 'borrador', asunto: 'x' };
  mAsentar(notas, 'x', NOW);                 // folio 1, asentada
  const snapshot = JSON.stringify(notas.x);
  throws(() => mAsentar(notas, 'x', NOW), 're-asentar una asentada lanza (no muta)');
  ok(JSON.stringify(notas.x) === snapshot, 'la nota asentada no cambió tras el intento');
}

console.log('3) Anular exige que el objetivo esté asentado');
{
  const notas = { d: { id: 'd', folio: 0, estado: 'borrador' } };
  throws(() => mAnular(notas, 'd', 'x', { id: 'z' }, NOW), 'no se puede anular un borrador');
  throws(() => mAnular(notas, 'noexiste', 'x', { id: 'z' }, NOW), 'no se puede anular una nota inexistente');
}

console.log('4) nextFolioFrom ignora borradores (folio 0)');
{
  const notas = { a: { folio: 3, estado: 'asentada' }, b: { folio: 0, estado: 'borrador' } };
  ok(nextFolioFrom(notas) === 4, 'siguiente folio = 4');
}

console.log(fail ? `\n✗ ${fail} aserción(es) fallaron` : '\n✓ Todas las invariantes se cumplen');
process.exit(fail ? 1 : 0);
