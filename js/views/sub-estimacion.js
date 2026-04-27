// Detalle de estimación del subcontratista. Captura cantidad ejecutada por el sub
// para cada concepto y calcula el importe a pagarle según los precios adjudicados.

import { h, modal, toast } from '../util/dom.js';
import { renderShell } from './shell.js';
import { rread, setSubEstimacionAvance, setPagoSub, cerrarSubEstimacion, reabrirSubEstimacion } from '../services/db.js';
import { state } from '../state/store.js';
import { navigate, dispatch } from '../state/router.js';
import { money, num, dateMx, pct } from '../util/format.js';

export async function renderSubEstimacion({ params }) {
  const { id: obraId, subid: subId, eid } = params;
  renderShell(crumbs(obraId, '...', subId, '...', eid), h('div', { class: 'empty' }, 'Cargando…'));

  const obra = await rread(`obras/${obraId}`);
  const sub = obra?.subcontratos?.[subId];
  const est = sub?.estimaciones?.[eid];
  if (!obra || !sub || !est) {
    renderShell([{ label: 'Obras', to: '/' }], h('div', { class: 'empty' }, 'Estimación del sub no encontrada.'));
    return;
  }
  const m = obra.meta || {};
  const meta = sub.meta || {};
  const conceptosAll = obra.catalogo?.conceptos || {};
  const conceptosSub = sub.conceptos || [];
  const ganador = sub.licitantes?.[meta.licitanteAdjudicadoId];
  if (!ganador) {
    renderShell(crumbs(obraId, m.nombre, subId, meta.nombre, eid), h('div', { class: 'empty' }, 'Subcontrato no adjudicado.'));
    return;
  }
  const ivaPct = Number(m.ivaPct ?? 0.16);
  const editable = est.estado === 'borrador';

  // Calcular acumulados de TODAS las estimaciones cerradas + esta
  const ests = sub.estimaciones || {};
  const ejecAcumPorConcepto = {};
  for (const [oid, oest] of Object.entries(ests)) {
    if (oid === eid) continue;
    for (const [cid, cant] of Object.entries(oest.avances || {})) {
      ejecAcumPorConcepto[cid] = (ejecAcumPorConcepto[cid] || 0) + (Number(cant) || 0);
    }
  }

  // Estado local
  const localAvances = {};
  for (const cs of conceptosSub) {
    localAvances[cs.conceptoId] = Number(est.avances?.[cs.conceptoId]) || 0;
  }

  // Header
  const head = h('div', { class: 'row' }, [
    h('h1', { style: { margin: 0 } }, `Estimación del sub #${est.numero}`),
    h('span', {}, est.estado === 'cerrada' ? h('span', { class: 'tag ok' }, '🔒 Cerrada') : h('span', { class: 'tag warn' }, '✎ Borrador')),
    h('div', { style: { flex: 1 } }),
    editable && h('button', { class: 'btn', onClick: () => cerrarConfirm() }, '🔒 Cerrar'),
    !editable && state.user.role === 'admin' && h('button', { class: 'btn ghost', onClick: () => reabrirConfirm() }, 'Reabrir')
  ]);

  const subNombre = meta.nombre || '';

  // Elementos del resumen (declarados antes que recompute para evitar hoisting issues)
  const summarySub = h('span', { class: 'mono', style: { fontSize: '20px', fontWeight: 600 } }, '$0.00');
  const summaryIva = h('span', { class: 'mono muted' }, '$0.00');
  const summaryImp = h('span', { class: 'mono', style: { fontSize: '24px', fontWeight: 700, color: 'var(--accent)' } }, '$0.00');

  // Tabla editable
  const totalsRow = h('tr', { style: { fontWeight: 600, background: 'var(--bg-2)' } });
  function recompute() {
    let subtotal = 0;
    for (const cs of conceptosSub) {
      const cant = Number(localAvances[cs.conceptoId]) || 0;
      const p = Number(ganador.precios?.[cs.conceptoId]) || 0;
      subtotal += cant * p;
    }
    const iva = subtotal * ivaPct;
    const importe = subtotal + iva;
    totalsRow.innerHTML = '';
    totalsRow.appendChild(h('td', { colSpan: 5 }, 'TOTAL'));
    totalsRow.appendChild(h('td', { class: 'num' }, money(subtotal)));
    totalsRow.appendChild(h('td', { class: 'num muted' }, money(iva)));
    totalsRow.appendChild(h('td', { class: 'num' }, h('b', {}, money(importe))));
    totalsRow.appendChild(h('td', {}, ''));
    // Actualizar resumen
    summarySub.textContent = money(subtotal);
    summaryIva.textContent = money(iva);
    summaryImp.textContent = money(importe);
  }

  const tbody = h('tbody', {}, conceptosSub.map(cs => {
    const cat = conceptosAll[cs.conceptoId];
    if (!cat) return null;
    const puSub = Number(ganador.precios?.[cs.conceptoId]) || 0;
    const cantSubContrato = Number(cs.cantidadSub) || 0;
    const acumPrev = ejecAcumPorConcepto[cs.conceptoId] || 0;

    const inp = h('input', {
      type: 'number', step: 'any',
      value: localAvances[cs.conceptoId] || '',
      disabled: !editable,
      style: { width: '100%', minWidth: '100px', textAlign: 'right' }
    });
    const importeCell = h('td', { class: 'num' });
    const overrunCell = h('td', {});

    function updateRow() {
      const cant = Number(inp.value) || 0;
      localAvances[cs.conceptoId] = cant;
      const importe = cant * puSub;
      importeCell.textContent = money(importe);
      const totalEjec = acumPrev + cant;
      overrunCell.innerHTML = '';
      if (cantSubContrato && totalEjec > cantSubContrato) {
        overrunCell.appendChild(h('span', { class: 'tag warn' }, `⚠ +${num(totalEjec - cantSubContrato, 2)}`));
      }
      recompute();
    }
    updateRow();

    inp.addEventListener('change', async () => {
      updateRow();
      try { await setSubEstimacionAvance(obraId, subId, eid, cs.conceptoId, Number(inp.value) || 0); }
      catch (err) { toast('Error: ' + err.message, 'danger'); }
    });

    const overrun = (acumPrev + Number(inp.value || 0)) > cantSubContrato;
    return h('tr', { class: overrun ? 'row-overrun' : '' }, [
      h('td', { class: 'mono muted' }, cat.clave),
      h('td', {}, [h('div', { class: 'desc' }, cat.descripcion)]),
      h('td', { class: 'muted' }, cat.unidad),
      h('td', { class: 'num muted' }, num(cantSubContrato, 2)),
      h('td', { class: 'num muted' }, num(acumPrev, 2)),
      h('td', {}, inp),
      h('td', { class: 'num muted' }, money(puSub)),
      importeCell,
      overrunCell
    ]);
  }).filter(Boolean));

  const table = h('table', { class: 'tbl' }, [
    h('thead', {}, [h('tr', {}, [
      h('th', {}, 'Clave'), h('th', {}, 'Descripción'), h('th', {}, 'U.'),
      h('th', { class: 'num' }, 'Cant. contratada (sub)'),
      h('th', { class: 'num' }, 'Acum. previo'),
      h('th', { class: 'num' }, 'Esta estim.'),
      h('th', { class: 'num' }, 'P.U. sub'),
      h('th', { class: 'num' }, 'Importe'),
      h('th', {}, '')
    ])]),
    tbody
  ]);

  const editPagoBtn = h('button', { class: 'btn sm ghost', onClick: () => editPagoSubDialog() }, est.pagoSub ? '✎ Editar pago' : '+ Registrar pago');

  const summary = h('div', { class: 'card' }, [
    h('div', { class: 'grid-3' }, [
      kvRow('Subcontratista', ganador.nombre),
      kvRow('Período', `${dateMx(est.periodoIni)} – ${dateMx(est.periodoFin)}`),
      kvRow('Fecha de corte', dateMx(est.fechaCorte))
    ]),
    h('div', { class: 'grid-3', style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--border)' } }, [
      kvBig('Subtotal a pagar', summarySub),
      kvBig('IVA (' + pct(ivaPct) + ')', summaryIva),
      kvBig('Importe (c/IVA)', summaryImp, true)
    ]),
    h('div', { class: 'row', style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--border)' } }, [
      h('div', {}, [
        h('span', { class: 'muted' }, 'Pago al sub: '),
        est.pagoSub
          ? h('b', {}, [money(est.pagoSub.importe), ' · ', dateMx(est.pagoSub.fecha)])
          : h('span', { class: 'muted' }, 'Sin registrar')
      ]),
      h('div', { style: { flex: 1 } }),
      editable && editPagoBtn
    ])
  ]);

  // Insertar el totalsRow como tfoot de la tabla principal
  table.appendChild(h('tfoot', {}, totalsRow));
  recompute();

  renderShell(crumbs(obraId, m.nombre, subId, subNombre, eid, est.numero), h('div', {}, [
    head, summary, h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } }, table)
  ]));

  async function cerrarConfirm() {
    await modal({
      title: 'Cerrar estimación del sub',
      body: h('div', {}, 'Una vez cerrada, no se podrán modificar avances ni el pago al sub.'),
      confirmLabel: 'Cerrar',
      onConfirm: async () => { await cerrarSubEstimacion(obraId, subId, eid, state.user.uid); toast('Cerrada', 'ok'); dispatch(); return true; }
    });
  }
  async function reabrirConfirm() {
    await modal({
      title: 'Reabrir estimación', danger: true,
      body: h('div', {}, 'Permitirá editar nuevamente.'),
      confirmLabel: 'Reabrir',
      onConfirm: async () => { await reabrirSubEstimacion(obraId, subId, eid); toast('Reabierta', 'ok'); dispatch(); return true; }
    });
  }
  async function editPagoSubDialog() {
    const cur = est.pagoSub || { subtotal: 0, iva: 0, importe: 0, fecha: Date.now() };
    const subtotalIn = h('input', { type: 'number', step: '0.01', value: cur.subtotal || '' });
    const ivaIn = h('input', { type: 'number', step: '0.01', value: cur.iva || '' });
    const importeIn = h('input', { type: 'number', step: '0.01', value: cur.importe || '' });
    const fechaIn = h('input', { type: 'date', value: cur.fecha ? new Date(cur.fecha).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10) });
    function syncFromSub() { const s = Number(subtotalIn.value) || 0; ivaIn.value = (s * ivaPct).toFixed(2); importeIn.value = (s * (1 + ivaPct)).toFixed(2); }
    function syncFromImp() { const i = Number(importeIn.value) || 0; const s = i / (1 + ivaPct); subtotalIn.value = s.toFixed(2); ivaIn.value = (s * ivaPct).toFixed(2); }
    subtotalIn.addEventListener('input', syncFromSub);
    importeIn.addEventListener('input', syncFromImp);

    await modal({
      title: 'Pago al subcontratista',
      body: h('div', {}, [
        h('p', { class: 'muted', style: { marginTop: 0, fontSize: '12px' } }, `Registra el pago hecho a ${ganador.nombre} por la estimación #${est.numero}.`),
        h('div', { class: 'grid-2' }, [
          h('div', { class: 'field' }, [h('label', {}, 'Subtotal'), subtotalIn]),
          h('div', { class: 'field' }, [h('label', {}, 'IVA (auto)'), ivaIn])
        ]),
        h('div', { class: 'grid-2', style: { marginTop: '10px' } }, [
          h('div', { class: 'field' }, [h('label', {}, 'Importe (c/IVA)'), importeIn]),
          h('div', { class: 'field' }, [h('label', {}, 'Fecha'), fechaIn])
        ])
      ]),
      confirmLabel: 'Guardar',
      onConfirm: async () => {
        try {
          await setPagoSub(obraId, subId, eid, {
            subtotal: Number(subtotalIn.value) || 0,
            iva: Number(ivaIn.value) || 0,
            importe: Number(importeIn.value) || 0,
            fecha: fechaIn.value ? new Date(fechaIn.value).getTime() : Date.now()
          });
          toast('Pago registrado', 'ok');
          dispatch();
          return true;
        } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
      }
    });
  }
}

function kvRow(label, val) { return h('div', { class: 'field' }, [h('label', {}, label), h('div', {}, val || '—')]); }
function kvBig(label, valNode, big) {
  return h('div', { class: 'field' }, [h('label', {}, label), h('div', {}, valNode)]);
}

function crumbs(obraId, nombre, subId, subNombre, eid, num) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Subcontratos', to: `/obras/${obraId}/subcontratos` },
    { label: subNombre || (subId || '').slice(0, 6), to: `/obras/${obraId}/subcontratos/${subId}/estimaciones` },
    { label: num != null ? `Estim. sub #${num}` : (eid || '').slice(0, 6) }
  ];
}
