// F-1 / Concentrado — vista equivalente a la hoja F-1 del Excel original.
// Muestra todo el catálogo de PUs con: cantidad, P.U., total, una columna por estimación
// con la cantidad ejecutada en esa estim., total ejecutado, % avance, % concepto del PPTO,
// % ponderado, importe a cobrar acumulado, restante. Fila final: totales y % avance global.

import { h } from '../util/dom.js';
import { renderShell } from './shell.js';
import { rread } from '../services/db.js';
import { money, num, num0, pct } from '../util/format.js';
import { calcGeneradorTotal } from '../services/plantillas.js';
import { exportF1Pdf, exportF1Xlsx } from '../services/export.js';

export async function renderF1({ params }) {
  const obraId = params.id;
  renderShell(crumbs(obraId), h('div', { class: 'empty' }, 'Cargando F-1…'));

  const obra = await rread(`obras/${obraId}`);
  if (!obra) { renderShell(crumbs(obraId), h('div', { class: 'empty' }, 'Obra no encontrada.')); return; }
  const m = obra.meta || {};
  const conceptos = obra.catalogo?.conceptos || {};
  const estimaciones = obra.estimaciones || {};
  const generadores = obra.generadores || {};
  const avances = obra.avances || {};

  const conceptosArr = Object.entries(conceptos)
    .filter(([_, c]) => c.tipo === 'precio_unitario' && !c.archivado)
    .map(([id, c]) => ({ id, ...c }))
    .sort((a, b) => (a.orden || 0) - (b.orden || 0));

  const estimsArr = Object.entries(estimaciones)
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => (a.numero || 0) - (b.numero || 0));

  // Cantidad ejecutada por (concepto, estimación)
  const ejecMap = {};
  for (const c of conceptosArr) ejecMap[c.id] = {};
  for (const g of Object.values(generadores)) {
    if (!ejecMap[g.conceptoId]) continue;
    const concepto = conceptos[g.conceptoId];
    const cant = calcGeneradorTotal(concepto, g);
    ejecMap[g.conceptoId][g.estimacionId] = (ejecMap[g.conceptoId][g.estimacionId] || 0) + cant;
  }
  // Avances directos donde no hay generador
  for (const [cid, byEst] of Object.entries(avances)) {
    if (!ejecMap[cid]) continue;
    for (const [eid, cant] of Object.entries(byEst)) {
      if (ejecMap[cid][eid] != null) continue;
      ejecMap[cid][eid] = Number(cant) || 0;
    }
  }

  // Totales globales
  const totalPpto = conceptosArr.reduce((s, c) => s + (c.total || 0), 0);

  // Totales por estimación: cantidad y monto
  const totalsByEst = {};
  for (const e of estimsArr) totalsByEst[e.id] = { cant: 0, monto: 0 };

  // Filas
  let totalEjecutadoMonto = 0;
  let totalRestanteMonto = 0;
  let avancePonderadoGlobal = 0;

  const rows = conceptosArr.map(c => {
    const ejecPorEst = ejecMap[c.id] || {};
    const totalEjec = estimsArr.reduce((s, e) => s + (ejecPorEst[e.id] || 0), 0);
    const pctAvance = c.cantidad ? totalEjec / c.cantidad : 0;
    const pctConcepto = totalPpto ? (c.total || 0) / totalPpto : 0;
    const pctPonderado = pctAvance * pctConcepto;
    const aCobrar = totalEjec * (c.precio_unitario || 0);
    const restante = (c.total || 0) - aCobrar;

    totalEjecutadoMonto += aCobrar;
    totalRestanteMonto += restante;
    avancePonderadoGlobal += pctPonderado;

    for (const e of estimsArr) {
      const cant = ejecPorEst[e.id] || 0;
      totalsByEst[e.id].cant += cant; // (la suma cant cruda no es muy útil porque mezcla unidades — pero la dejamos)
      totalsByEst[e.id].monto += cant * (c.precio_unitario || 0);
    }

    const overrun = c.cantidad && totalEjec > c.cantidad;

    return h('tr', { class: overrun ? 'row-overrun' : '' }, [
      h('td', { class: 'mono muted' }, c.clave),
      h('td', {}, h('div', { class: 'desc', style: { maxWidth: '320px' } }, c.descripcion)),
      h('td', { class: 'muted' }, c.unidad || ''),
      h('td', { class: 'num' }, num(c.cantidad, 2)),
      h('td', { class: 'num muted' }, money(c.precio_unitario)),
      h('td', { class: 'num' }, money(c.total)),
      ...estimsArr.map(e => h('td', { class: 'num mono' }, ejecPorEst[e.id] ? num(ejecPorEst[e.id], 2) : h('span', { class: 'muted' }, '—'))),
      h('td', { class: 'num' }, h('b', {}, num(totalEjec, 2))),
      h('td', { class: 'num ' + (overrun ? 'warn' : '') }, pct(pctAvance)),
      h('td', { class: 'num muted' }, pct(pctConcepto)),
      h('td', { class: 'num' }, pct(pctPonderado)),
      h('td', { class: 'num' }, money(aCobrar)),
      h('td', { class: 'num ' + (restante < 0 ? 'warn' : '') }, money(restante))
    ]);
  });

  // Fila total
  const totalRow = h('tr', { style: { fontWeight: 600, background: 'var(--bg-2)', borderTop: '2px solid var(--border-strong)' } }, [
    h('td', { colSpan: 5 }, 'TOTAL'),
    h('td', { class: 'num' }, money(totalPpto)),
    ...estimsArr.map(e => h('td', { class: 'num' }, money(totalsByEst[e.id].monto))),
    h('td', {}, ''),
    h('td', { class: 'num' }, pct(avancePonderadoGlobal)),
    h('td', {}, ''),
    h('td', {}, ''),
    h('td', { class: 'num' }, money(totalEjecutadoMonto)),
    h('td', { class: 'num' }, money(totalRestanteMonto))
  ]);

  const tbl = h('table', { class: 'tbl', style: { fontSize: '12px' } }, [
    h('thead', {}, [h('tr', {}, [
      h('th', {}, 'Clave'),
      h('th', {}, 'Descripción'),
      h('th', {}, 'U.'),
      h('th', { class: 'num' }, 'Cant.'),
      h('th', { class: 'num' }, 'P.U.'),
      h('th', { class: 'num' }, 'Total'),
      ...estimsArr.map(e => h('th', { class: 'num' }, '#' + e.numero)),
      h('th', { class: 'num' }, 'Total Ejec.'),
      h('th', { class: 'num' }, '% Av.'),
      h('th', { class: 'num' }, '% PPTO'),
      h('th', { class: 'num' }, '% Pond.'),
      h('th', { class: 'num' }, 'A cobrar'),
      h('th', { class: 'num' }, 'Restante')
    ])]),
    h('tbody', {}, [...rows, totalRow])
  ]);

  const ivaPct = Number(m.ivaPct ?? 0.16);
  const subtotalContrato = (Number(m.montoContratoCIVA) || 0) / (1 + ivaPct);
  const restanteContrato = subtotalContrato - totalEjecutadoMonto;
  const desfase = subtotalContrato - totalPpto;
  const hayDesfase = subtotalContrato > 0 && Math.abs(desfase) > Math.max(1, subtotalContrato * 0.005);

  const summary = h('div', { class: 'card' }, [
    h('div', { class: 'grid-3' }, [
      kvBig('Avance ponderado', pct(avancePonderadoGlobal)),
      kvBig('Importe ejecutado', money(totalEjecutadoMonto)),
      kvBig('Restante vs catálogo', money(totalRestanteMonto))
    ]),
    h('div', { class: 'row', style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--border)', flexWrap: 'wrap', fontSize: '12px' } }, [
      h('div', {}, [h('span', { class: 'muted' }, 'Σ catálogo (sin IVA): '), h('b', { class: 'mono' }, money(totalPpto))]),
      h('div', {}, [h('span', { class: 'muted' }, ' · Contratado (sin IVA): '), h('b', { class: 'mono' }, money(subtotalContrato))]),
      h('div', {}, [h('span', { class: 'muted' }, ' · Restante vs contrato: '), h('b', { class: 'mono' }, money(restanteContrato))]),
      hayDesfase && h('span', { class: 'tag warn', title: 'El catálogo no suma lo mismo que el subtotal contratado. Asegúrate de haber importado el catálogo completo.' }, `⚠ Desfase ${money(Math.abs(desfase))} ${desfase > 0 ? '(catálogo incompleto)' : '(catálogo excede contrato)'}`)
    ])
  ]);

  renderShell(crumbs(obraId, m.nombre), h('div', {}, [
    h('div', { class: 'row' }, [
      h('h1', { style: { margin: 0 } }, 'F-1 / Concentrado'),
      h('div', { class: 'muted' }, m.nombre || ''),
      h('div', { style: { flex: 1 } }),
      h('button', { class: 'btn', onClick: () => exportF1Xlsx(obra) }, '⬇ XLSX'),
      h('button', { class: 'btn primary', onClick: () => exportF1Pdf(obra) }, '⬇ PDF')
    ]),
    summary,
    h('div', { class: 'card', style: { overflowX: 'auto' } }, tbl)
  ]));
}

function kvBig(label, val) {
  return h('div', { class: 'field' }, [
    h('label', {}, label),
    h('div', { class: 'mono', style: { fontSize: '20px', fontWeight: 600 } }, val)
  ]);
}

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'F-1' }
  ];
}
