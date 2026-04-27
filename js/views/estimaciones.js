import { h, modal, toast } from '../util/dom.js';
import { renderShell } from './shell.js';
import { rread, createEstimacion, cerrarEstimacion, reabrirEstimacion } from '../services/db.js';
import { state } from '../state/store.js';
import { navigate } from '../state/router.js';
import { money, dateMx, num0, pct } from '../util/format.js';
import { calcGeneradorTotal } from '../services/plantillas.js';

export async function renderEstimaciones({ params }) {
  const obraId = params.id;
  renderShell(crumbs(obraId), h('div', { class: 'empty' }, 'Cargando estimaciones…'));

  const obra = await rread(`obras/${obraId}`);
  if (!obra) { renderShell(crumbs(obraId), h('div', { class: 'empty' }, 'Obra no encontrada.')); return; }
  const m = obra.meta || {};
  const ests = obra.estimaciones || {};
  const conceptos = obra.catalogo?.conceptos || {};
  const generadores = obra.generadores || {};
  const avances = obra.avances || {};

  const ids = Object.keys(ests).sort((a, b) => (ests[a].numero || 0) - (ests[b].numero || 0));
  const totalsByEst = computeMontosByEstimacion(ests, conceptos, generadores, avances);

  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Estimaciones'),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn primary', onClick: () => newEstimDialog(obraId, ests) }, '+ Nueva estimación')
  ]);

  const body = ids.length === 0
    ? h('div', { class: 'empty' }, [h('div', { class: 'ico' }, '📋'), 'Aún no hay estimaciones.'])
    : h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', {}, '#'), h('th', {}, 'Período'), h('th', {}, 'Estado'),
        h('th', {}, '# Generadores'), h('th', { class: 'num' }, 'Subtotal'),
        h('th', { class: 'num' }, 'IVA'), h('th', { class: 'num' }, 'Importe'),
        h('th', {}, '')
      ])]),
      h('tbody', {}, ids.map(id => {
        const e = ests[id];
        const monto = totalsByEst[id] || { subtotal: 0, iva: 0, importe: 0, numGen: 0 };
        return h('tr', { onClick: () => navigate(`/obras/${obraId}/estimaciones/${id}`), style: { cursor: 'pointer' } }, [
          h('td', {}, h('b', {}, '#' + e.numero)),
          h('td', {}, [
            e.periodoIni ? dateMx(e.periodoIni) : '—',
            ' – ',
            e.periodoFin ? dateMx(e.periodoFin) : '—'
          ]),
          h('td', {}, e.estado === 'cerrada'
            ? h('span', { class: 'tag ok' }, '🔒 Cerrada')
            : h('span', { class: 'tag warn' }, '✎ Borrador')),
          h('td', {}, num0(monto.numGen)),
          h('td', { class: 'num' }, money(monto.subtotal)),
          h('td', { class: 'num muted' }, money(monto.iva)),
          h('td', { class: 'num' }, h('b', {}, money(monto.importe))),
          h('td', { onClick: e2 => e2.stopPropagation() }, h('div', { class: 'row' }, [
            e.estado === 'borrador'
              ? h('button', { class: 'btn sm', onClick: () => cerrarConfirm(obraId, id, e.numero) }, '🔒 Cerrar')
              : (state.user.role === 'admin'
                ? h('button', { class: 'btn sm ghost', onClick: () => reabrirConfirm(obraId, id, e.numero) }, 'Reabrir')
                : null)
          ]))
        ]);
      }))
    ]);

  renderShell(crumbs(obraId, m.nombre), h('div', {}, [head, body]));
}

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Estimaciones' }
  ];
}

export function computeMontosByEstimacion(ests, conceptos, generadores, avances) {
  const out = {};
  for (const eid of Object.keys(ests)) {
    out[eid] = { subtotal: 0, iva: 0, importe: 0, numGen: 0 };
  }
  // Generadores → suma por estimación
  for (const g of Object.values(generadores)) {
    if (!out[g.estimacionId]) continue;
    out[g.estimacionId].numGen++;
    const c = conceptos[g.conceptoId];
    if (!c) continue;
    const cant = calcGeneradorTotal(c, g);
    out[g.estimacionId].subtotal += cant * (c.precio_unitario || 0);
  }
  // Avances directos (sin generador) — se suman si existen
  for (const [cid, byEstim] of Object.entries(avances || {})) {
    const c = conceptos[cid];
    if (!c) continue;
    for (const [eid, cant] of Object.entries(byEstim || {})) {
      if (!out[eid]) continue;
      // Si ya hay generadores para este concepto+estim, no duplicar (avances se usa solo cuando no hay gen)
      const hasGen = Object.values(generadores).some(g => g.conceptoId === cid && g.estimacionId === eid);
      if (hasGen) continue;
      out[eid].subtotal += Number(cant) * (c.precio_unitario || 0);
    }
  }
  // IVA por obra (lo tomamos del meta cuando se llama; aquí dejamos 0.16 por defecto y la vista
  // que tenga el meta lo recalcula). Para simplificar guardamos subtotal y dejamos IVA=0.16:
  for (const eid of Object.keys(out)) {
    out[eid].iva = out[eid].subtotal * 0.16;
    out[eid].importe = out[eid].subtotal + out[eid].iva;
  }
  return out;
}

async function newEstimDialog(obraId, ests) {
  const next = Math.max(0, ...Object.values(ests).map(e => e.numero || 0)) + 1;
  const periodoIni = h('input', { type: 'date' });
  const periodoFin = h('input', { type: 'date' });
  const fechaCorte = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });

  await modal({
    title: `Nueva estimación #${next}`,
    body: h('div', {}, [
      h('div', { class: 'grid-2' }, [
        h('div', { class: 'field' }, [h('label', {}, 'Período inicio'), periodoIni]),
        h('div', { class: 'field' }, [h('label', {}, 'Período fin'), periodoFin])
      ]),
      h('div', { class: 'field', style: { marginTop: '10px' } }, [h('label', {}, 'Fecha de corte'), fechaCorte])
    ]),
    confirmLabel: 'Crear',
    onConfirm: async () => {
      try {
        const id = await createEstimacion(obraId, {
          periodoIni: periodoIni.value ? new Date(periodoIni.value).getTime() : null,
          periodoFin: periodoFin.value ? new Date(periodoFin.value).getTime() : null,
          fechaCorte: fechaCorte.value ? new Date(fechaCorte.value).getTime() : Date.now()
        });
        toast('Estimación creada', 'ok');
        navigate(`/obras/${obraId}/estimaciones/${id}`);
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function cerrarConfirm(obraId, estId, numero) {
  await modal({
    title: `Cerrar estimación #${numero}`,
    body: h('div', {}, 'Una vez cerrada, no se podrán editar generadores ni cantidades de esta estimación. Solo el admin puede reabrirla.'),
    confirmLabel: 'Cerrar estimación',
    onConfirm: async () => {
      await cerrarEstimacion(obraId, estId, state.user.uid);
      toast('Estimación cerrada', 'ok');
      renderEstimaciones({ params: { id: obraId } });
      return true;
    }
  });
}

async function reabrirConfirm(obraId, estId, numero) {
  await modal({
    title: `Reabrir estimación #${numero}`, danger: true,
    body: h('div', {}, 'Esta acción permitirá editar nuevamente la estimación. Confirma solo si es necesario.'),
    confirmLabel: 'Reabrir',
    onConfirm: async () => {
      await reabrirEstimacion(obraId, estId);
      toast('Estimación reabierta', 'ok');
      renderEstimaciones({ params: { id: obraId } });
      return true;
    }
  });
}
