import { h, modal, toast } from '../util/dom.js';
import { renderShell } from './shell.js';
import { rread, createSubcontrato, deleteSubcontrato } from '../services/db.js';
import { state } from '../state/store.js';
import { navigate } from '../state/router.js';
import { money, num0, dateMx } from '../util/format.js';

export async function renderSubcontratos({ params }) {
  const obraId = params.id;
  renderShell(crumbs(obraId), h('div', { class: 'empty' }, 'Cargando subcontratos…'));

  const obra = await rread(`obras/${obraId}`);
  if (!obra) { renderShell(crumbs(obraId), h('div', { class: 'empty' }, 'Obra no encontrada.')); return; }
  const m = obra.meta || {};
  const subs = obra.subcontratos || {};
  const conceptosAll = obra.catalogo?.conceptos || {};

  const ids = Object.keys(subs).sort((a, b) => (subs[a].meta?.createdAt || 0) - (subs[b].meta?.createdAt || 0));

  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Subcontratos'),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn primary', onClick: () => newSubcontratoDialog(obraId) }, '+ Nuevo subcontrato')
  ]);

  const body = ids.length === 0
    ? h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '📑'),
      h('div', {}, 'Aún no hay subcontratos.'),
      h('div', { class: 'muted', style: { marginTop: '6px', fontSize: '12px' } }, 'Crea uno para invitar licitantes a cotizar partes del catálogo.')
    ])
    : h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', {}, 'Nombre'),
        h('th', {}, 'Estado'),
        h('th', {}, '# Conceptos'),
        h('th', {}, '# Licitantes'),
        h('th', { class: 'num' }, 'Monto referencia (catálogo)'),
        h('th', { class: 'num' }, 'Mejor cotización'),
        h('th', {}, 'Creado'),
        h('th', {}, '')
      ])]),
      h('tbody', {}, ids.map(id => {
        const sub = subs[id];
        const meta = sub.meta || {};
        const conceptos = sub.conceptos || [];
        const licitantes = sub.licitantes || {};
        const numLic = Object.values(licitantes).filter(l => !l.archivado).length;
        const montoRef = conceptos.reduce((s, c) => {
          const cat = conceptosAll[c.conceptoId];
          return s + (Number(c.cantidadSub) || 0) * (cat?.precio_unitario || 0);
        }, 0);
        const mejorTotal = bestLicitanteTotal(conceptos, licitantes);
        return h('tr', { onClick: () => navigate(`/obras/${obraId}/subcontratos/${id}`), style: { cursor: 'pointer' } }, [
          h('td', {}, h('b', {}, meta.nombre || '—')),
          h('td', {}, estadoTag(meta.estado)),
          h('td', {}, num0(conceptos.length)),
          h('td', {}, num0(numLic)),
          h('td', { class: 'num' }, money(montoRef)),
          h('td', { class: 'num' }, mejorTotal != null ? money(mejorTotal) : h('span', { class: 'muted' }, '—')),
          h('td', { class: 'muted' }, meta.createdAt ? dateMx(meta.createdAt) : '—'),
          h('td', { onClick: e => e.stopPropagation() }, h('button', { class: 'btn sm danger ghost', onClick: () => deleteSubConfirm(obraId, id, meta.nombre) }, '✕'))
        ]);
      }))
    ]);

  renderShell(crumbs(obraId, m.nombre), h('div', {}, [head, body]));
}

function bestLicitanteTotal(conceptos, licitantes) {
  let best = null;
  for (const lic of Object.values(licitantes)) {
    if (lic.archivado) continue;
    const precios = lic.precios || {};
    let sum = 0, hasAny = false;
    for (const c of conceptos) {
      const p = Number(precios[c.conceptoId]);
      if (!Number.isFinite(p) || p <= 0) continue;
      sum += p * (Number(c.cantidadSub) || 0);
      hasAny = true;
    }
    if (hasAny && (best == null || sum < best)) best = sum;
  }
  return best;
}

function estadoTag(estado) {
  const e = estado || 'cotizando';
  if (e === 'cotizando') return h('span', { class: 'tag warn' }, 'Cotizando');
  if (e === 'adjudicado') return h('span', { class: 'tag ok' }, 'Adjudicado');
  if (e === 'ejecutando') return h('span', { class: 'tag ok' }, 'Ejecutando');
  if (e === 'cerrado') return h('span', { class: 'tag muted' }, 'Cerrado');
  return h('span', { class: 'tag muted' }, e);
}

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Subcontratos' }
  ];
}

async function newSubcontratoDialog(obraId) {
  const nombre = h('input', { placeholder: 'p.ej. Acero estructural', autofocus: true });
  const descripcion = h('textarea', { rows: 2, placeholder: 'Descripción / alcance general (opcional)', style: { width: '100%', resize: 'vertical' } });
  await modal({
    title: 'Nuevo subcontrato',
    body: h('div', {}, [
      h('div', { class: 'field' }, [h('label', {}, 'Nombre'), nombre]),
      h('div', { class: 'field', style: { marginTop: '10px' } }, [h('label', {}, 'Descripción'), descripcion])
    ]),
    confirmLabel: 'Crear',
    onConfirm: async () => {
      try {
        const id = await createSubcontrato(obraId, { nombre: nombre.value.trim() || 'Sin nombre', descripcion: descripcion.value });
        toast('Subcontrato creado', 'ok');
        navigate(`/obras/${obraId}/subcontratos/${id}`);
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function deleteSubConfirm(obraId, subId, nombre) {
  await modal({
    title: 'Borrar subcontrato', danger: true, confirmLabel: 'Borrar',
    body: h('div', {}, `Se borrará "${nombre || subId.slice(0, 6)}" con todos sus licitantes y cotizaciones.`),
    onConfirm: async () => {
      await deleteSubcontrato(obraId, subId);
      toast('Borrado', 'ok');
      renderSubcontratos({ params: { id: obraId } });
      return true;
    }
  });
}
