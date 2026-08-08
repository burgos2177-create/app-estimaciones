// Órdenes de Cambio (aditivas/deductivas) — Fase 1.
// Congela el catálogo original como baseline y permite capturar OCs en BORRADOR
// para cotizar el impacto (aditivo/deductivo/neto y contrato vigente proyectado)
// SIN tocar el catálogo vigente. Aplicar la OC y el PDF son fases posteriores.

import { h, modal, toast } from '../util/dom.js';
import { renderShell } from './shell.js';
import { loadObra, ensureCatalogoBaseline, listOrdenesCambio, saveOrdenCambio, deleteOrdenCambio } from '../services/db.js';
import { money, num, dateMx } from '../util/format.js';
import { navigate } from '../state/router.js';

const TIPO_LABEL = { aditiva: 'Aditiva', deductiva: 'Deductiva', mixta: 'Mixta' };
const ESTADO_TAG = {
  borrador:  ['warn', '✎ Borrador'],
  aprobada:  ['ok', '✓ Aprobada'],
  aplicada:  ['ok', '✅ Aplicada'],
  rechazada: ['danger', '✕ Rechazada']
};

// Suma de PUs activos de un mapa de conceptos (mismo criterio que el catálogo).
function sumaPU(conceptosMap) {
  return Object.values(conceptosMap || {})
    .filter(c => c.tipo === 'precio_unitario' && !c.archivado)
    .reduce((s, c) => s + (Number(c.total) || (Number(c.cantidad) || 0) * (Number(c.precio_unitario) || 0)), 0);
}

// Impacto de una partida de la OC (aditivo/deductivo).
function itemImpacto(item, conceptosMap) {
  if (item.accion === 'agregar') {
    return { aditivo: (Number(item.cantidad) || 0) * (Number(item.pu) || 0), deductivo: 0 };
  }
  const c = conceptosMap[item.conceptoId];
  const pu = c ? (Number(c.precio_unitario) || 0) : 0;
  if (item.accion === 'quitar') {
    // 'cantidad' = cuánto se quita (parcial o total). Sin dato = concepto completo.
    const cant = (item.cantidad != null && item.cantidad !== '') ? Number(item.cantidad) : (c ? Number(c.cantidad) || 0 : 0);
    return { aditivo: 0, deductivo: cant * pu };
  }
  if (item.accion === 'modificar') {
    const antes = c ? (Number(c.cantidad) || 0) : 0;
    const delta = ((Number(item.despues) || 0) - antes) * pu;
    return delta >= 0 ? { aditivo: delta, deductivo: 0 } : { aditivo: 0, deductivo: -delta };
  }
  return { aditivo: 0, deductivo: 0 };
}

function ocTotales(oc, conceptosMap) {
  let aditivo = 0, deductivo = 0;
  for (const it of (oc.items || [])) {
    const im = itemImpacto(it, conceptosMap);
    aditivo += im.aditivo; deductivo += im.deductivo;
  }
  const neto = aditivo - deductivo;
  const tipo = aditivo > 0 && deductivo > 0 ? 'mixta' : (deductivo > 0 ? 'deductiva' : 'aditiva');
  return { aditivo, deductivo, neto, tipo };
}

export async function renderOrdenesCambio({ params }) {
  const obraId = params.id;
  renderShell(crumbs(obraId), h('div', { class: 'empty' }, 'Cargando órdenes de cambio…'));

  const obra = await loadObra(obraId);
  if (!obra) { renderShell(crumbs(obraId), h('div', { class: 'empty' }, 'Obra no encontrada.')); return; }
  const m = obra.meta || {};
  const conceptosMap = obra.catalogo?.conceptos || {};
  if (!Object.keys(conceptosMap).length) {
    renderShell(crumbs(obraId, m.nombre), h('div', { class: 'empty' }, 'La obra no tiene catálogo importado todavía.'));
    return;
  }

  // Congela el baseline (contrato original) la 1ª vez.
  const baseline = await ensureCatalogoBaseline(obraId);
  const ocs = await listOrdenesCambio(obraId);

  const contratoOriginal = sumaPU(baseline?.conceptos || conceptosMap);
  const contratoVigente = sumaPU(conceptosMap);
  let sumAditAplic = 0, sumDeductAplic = 0;
  for (const oc of Object.values(ocs)) {
    if (oc.estado === 'aplicada') { sumAditAplic += oc.montoAditivo || 0; sumDeductAplic += oc.montoDeductivo || 0; }
  }

  drawLista();

  // ===================== LISTA =====================
  function drawLista() {
    const ocsArr = Object.entries(ocs).map(([id, o]) => ({ id, ...o }))
      .sort((a, b) => (a.numero || 0) - (b.numero || 0));

    const resumen = h('div', { class: 'card' }, [
      h('h3', { style: { marginTop: 0 } }, 'Contrato'),
      h('div', { class: 'grid-4' }, [
        kvBig('Contrato original', money(contratoOriginal), ''),
        kvBig('Σ Aditivas (aplicadas)', '+' + money(sumAditAplic), sumAditAplic ? 'ok' : ''),
        kvBig('Σ Deductivas (aplicadas)', '−' + money(sumDeductAplic), sumDeductAplic ? 'warn' : ''),
        kvBig('Contrato vigente', money(contratoVigente), 'accent')
      ]),
      h('p', { class: 'muted', style: { fontSize: '11px', marginTop: '8px' } },
        'El baseline (contrato original) quedó congelado. Las OC en borrador NO cambian el contrato vigente ni afectan a las apps hermanas; solo cotizan el impacto. Aplicar una OC será el siguiente paso.')
    ]);

    const filas = ocsArr.map(oc => {
      const t = ocTotales(oc, conceptosMap);
      const [cls, lbl] = ESTADO_TAG[oc.estado] || ['muted', oc.estado || '—'];
      const editable = oc.estado === 'borrador';
      return h('tr', {}, [
        h('td', {}, h('b', {}, 'OC #' + (oc.numero || '?'))),
        h('td', {}, oc.fecha ? dateMx(oc.fecha) : '—'),
        h('td', {}, h('span', { class: 'tag muted' }, TIPO_LABEL[t.tipo] || '—')),
        h('td', {}, h('div', { class: 'desc' }, oc.descripcion || '—')),
        h('td', { class: 'num ok' }, t.aditivo ? '+' + money(t.aditivo) : '—'),
        h('td', { class: 'num warn' }, t.deductivo ? '−' + money(t.deductivo) : '—'),
        h('td', { class: 'num' }, h('b', { style: { color: t.neto >= 0 ? 'var(--ok)' : 'var(--warn)' } }, (t.neto >= 0 ? '+' : '−') + money(Math.abs(t.neto)))),
        h('td', {}, h('span', { class: 'tag ' + cls }, lbl)),
        h('td', { style: { whiteSpace: 'nowrap' } }, [
          h('button', { class: 'btn sm ghost', onClick: () => abrirEditor(oc) }, editable ? '✎ Editar' : '👁 Ver'),
          editable && h('button', { class: 'btn sm danger ghost', style: { marginLeft: '6px' }, onClick: () => borrarOC(oc) }, '🗑')
        ])
      ]);
    });

    const tabla = ocsArr.length === 0
      ? h('div', { class: 'empty' }, [h('div', { class: 'ico' }, '📝'), 'No hay órdenes de cambio. Crea la primera para cotizar una aditiva o deductiva.'])
      : h('table', { class: 'tbl' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, '#'), h('th', {}, 'Fecha'), h('th', {}, 'Tipo'), h('th', {}, 'Descripción'),
          h('th', { class: 'num' }, 'Aditivo'), h('th', { class: 'num' }, 'Deductivo'),
          h('th', { class: 'num' }, 'Neto'), h('th', {}, 'Estado'), h('th', {}, '')
        ])]),
        h('tbody', {}, filas)
      ]);

    renderShell(crumbs(obraId, m.nombre), h('div', {}, [
      h('div', { class: 'row' }, [
        h('h1', { style: { margin: 0 } }, 'Órdenes de Cambio'),
        h('div', { class: 'muted' }, m.nombre || ''),
        h('div', { style: { flex: 1 } }),
        h('button', { class: 'btn ghost', onClick: () => navigate('/obras/' + obraId + '/catalogo') }, '← Catálogo'),
        h('button', { class: 'btn primary', onClick: () => abrirEditor(null) }, '+ Nueva orden de cambio')
      ]),
      resumen,
      h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } }, tabla)
    ]));
  }

  async function borrarOC(oc) {
    const ok = await modal({
      title: 'Borrar orden de cambio', danger: true, confirmLabel: 'Borrar',
      body: h('div', {}, `Se borrará la OC #${oc.numero} (borrador). No afecta el catálogo.`)
    });
    if (!ok) return;
    try { await deleteOrdenCambio(obraId, oc.id); delete ocs[oc.id]; toast('OC borrada', 'ok'); drawLista(); }
    catch (err) { toast('Error: ' + err.message, 'danger'); }
  }

  // ===================== EDITOR =====================
  function abrirEditor(existente) {
    const readonly = existente && existente.estado !== 'borrador';
    const work = existente
      ? { id: existente.id, numero: existente.numero, descripcion: existente.descripcion || '', fecha: existente.fecha || Date.now(), items: JSON.parse(JSON.stringify(existente.items || [])) }
      : { descripcion: '', fecha: Date.now(), items: [] };

    const puConceptos = Object.entries(conceptosMap)
      .filter(([_, c]) => c.tipo === 'precio_unitario' && !c.archivado)
      .map(([id, c]) => ({ id, ...c }))
      .sort((a, b) => (a.orden || 0) - (b.orden || 0));

    const descIn = h('textarea', { rows: 2, disabled: readonly, style: { width: '100%', resize: 'vertical' }, value: work.descripcion, placeholder: 'Motivo del cambio de alcance (lo que pidió el cliente)…' });
    descIn.addEventListener('input', e => { work.descripcion = e.target.value; });
    const fechaIn = h('input', { type: 'date', disabled: readonly, value: new Date(work.fecha).toISOString().slice(0, 10) });
    fechaIn.addEventListener('input', e => { work.fecha = e.target.value ? new Date(e.target.value).getTime() : Date.now(); });

    const itemsBody = h('tbody', {});
    const sumAdit = h('span', { class: 'mono ok' }, money(0));
    const sumDeduct = h('span', { class: 'mono warn' }, money(0));
    const sumNeto = h('span', { class: 'mono', style: { fontWeight: 700 } }, money(0));
    const vigenteProy = h('span', { class: 'mono', style: { fontWeight: 700, color: 'var(--accent)' } }, money(contratoVigente));

    function recompute() {
      const t = ocTotales(work, conceptosMap);
      sumAdit.textContent = '+' + money(t.aditivo);
      sumDeduct.textContent = '−' + money(t.deductivo);
      sumNeto.textContent = (t.neto >= 0 ? '+' : '−') + money(Math.abs(t.neto));
      sumNeto.style.color = t.neto >= 0 ? 'var(--ok)' : 'var(--warn)';
      vigenteProy.textContent = money(contratoVigente + t.neto);
    }

    function renderItems() {
      itemsBody.innerHTML = '';
      if (!work.items.length) {
        itemsBody.appendChild(h('tr', {}, [h('td', { colSpan: 5, class: 'muted', style: { padding: '16px', textAlign: 'center' } }, 'Sin partidas. Agrega conceptos a agregar, modificar o quitar ↓')]));
      }
      work.items.forEach((it, idx) => itemsBody.appendChild(renderItemRow(it, idx)));
      recompute();
    }

    function renderItemRow(it, idx) {
      const im = itemImpacto(it, conceptosMap);
      let detalle;
      if (it.accion === 'agregar') {
        detalle = h('div', {}, [
          h('div', { class: 'mono muted', style: { fontSize: '11px' } }, it.clave || '(nuevo)'),
          h('div', { style: { fontSize: '13px' } }, it.descripcion || '—'),
          h('div', { class: 'muted', style: { fontSize: '11px' } }, `${num(it.cantidad, 2)} ${it.unidad || ''} × ${money(it.pu)}`)
        ]);
      } else {
        const c = conceptosMap[it.conceptoId];
        detalle = h('div', {}, [
          h('div', { class: 'mono muted', style: { fontSize: '11px' } }, c?.clave || '(concepto)'),
          h('div', { style: { fontSize: '13px' } }, c?.descripcion || '—'),
          it.accion === 'modificar'
            ? h('div', { class: 'muted', style: { fontSize: '11px' } }, `cant. ${num(c?.cantidad, 2)} → ${num(it.despues, 2)} ${c?.unidad || ''}`)
            : h('div', { class: 'muted', style: { fontSize: '11px' } }, `quitar ${num(it.cantidad != null ? it.cantidad : c?.cantidad, 2)} de ${num(c?.cantidad, 2)} ${c?.unidad || ''} × ${money(c?.precio_unitario)}`)
        ]);
      }
      const accionTag = { agregar: ['ok', '＋ Agregar'], modificar: ['muted', '✎ Modificar'], quitar: ['warn', '－ Quitar'] }[it.accion] || ['muted', it.accion];
      return h('tr', {}, [
        h('td', {}, h('span', { class: 'tag ' + accionTag[0] }, accionTag[1])),
        h('td', {}, detalle),
        h('td', { class: 'num ok' }, im.aditivo ? '+' + money(im.aditivo) : ''),
        h('td', { class: 'num warn' }, im.deductivo ? '−' + money(im.deductivo) : ''),
        h('td', {}, !readonly && h('button', { class: 'btn sm danger ghost', onClick: () => { work.items.splice(idx, 1); renderItems(); } }, '✕'))
      ]);
    }

    // --- diálogos para agregar cada tipo de partida ---
    async function addAgregar() {
      const clave = h('input', { placeholder: 'Clave (opcional)' });
      const desc = h('input', { placeholder: 'Descripción del concepto nuevo' });
      const unidad = h('input', { placeholder: 'Unidad (m2, m3, pza…)', style: { width: '120px' } });
      const cantidad = h('input', { type: 'number', step: 'any', placeholder: '0' });
      const pu = h('input', { type: 'number', step: '0.01', placeholder: '0.00' });
      const ok = await modal({
        title: 'Agregar concepto (aditiva)',
        body: h('div', {}, [
          h('div', { class: 'field' }, [h('label', {}, 'Descripción *'), desc]),
          h('div', { class: 'grid-2', style: { marginTop: '10px' } }, [
            h('div', { class: 'field' }, [h('label', {}, 'Clave'), clave]),
            h('div', { class: 'field' }, [h('label', {}, 'Unidad'), unidad])
          ]),
          h('div', { class: 'grid-2', style: { marginTop: '10px' } }, [
            h('div', { class: 'field' }, [h('label', {}, 'Cantidad'), cantidad]),
            h('div', { class: 'field' }, [h('label', {}, 'P.U.'), pu])
          ])
        ]),
        confirmLabel: 'Agregar', onConfirm: () => {
          if (!desc.value.trim()) { toast('La descripción es requerida', 'warn'); return false; }
          return true;
        }
      });
      if (!ok) return;
      work.items.push({ accion: 'agregar', clave: clave.value.trim(), descripcion: desc.value.trim(), unidad: unidad.value.trim(), cantidad: Number(cantidad.value) || 0, pu: Number(pu.value) || 0 });
      renderItems();
    }

    async function addSobreConcepto(accion) {
      if (!puConceptos.length) { toast('No hay conceptos en el catálogo', 'warn'); return; }
      const sel = h('select', { style: { width: '100%' } }, puConceptos.map(c => h('option', { value: c.id }, `${c.clave || ''} — ${(c.descripcion || '').slice(0, 70)}`)));
      // modificar → nueva cantidad absoluta; quitar → cantidad A QUITAR (default: la completa)
      const cantIn = h('input', { type: 'number', step: 'any', placeholder: accion === 'modificar' ? 'Nueva cantidad' : 'Cantidad a quitar' });
      const info = h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } });
      const impacto = h('div', { style: { fontSize: '12px', marginTop: '6px' } });
      function refreshInfo(resetCant) {
        const c = conceptosMap[sel.value];
        if (!c) { info.textContent = ''; impacto.textContent = ''; return; }
        info.textContent = `Actual: ${num(c.cantidad, 2)} ${c.unidad || ''} × ${money(c.precio_unitario)} = ${money(c.total)}`;
        if (accion === 'quitar' && resetCant) cantIn.value = Number(c.cantidad) || 0;   // default: quitar todo
        refreshImpacto();
      }
      function refreshImpacto() {
        const c = conceptosMap[sel.value]; if (!c) { impacto.textContent = ''; return; }
        const pu = Number(c.precio_unitario) || 0, actual = Number(c.cantidad) || 0, v = Number(cantIn.value);
        if (isNaN(v)) { impacto.textContent = ''; return; }
        if (accion === 'quitar') {
          impacto.innerHTML = '';
          impacto.appendChild(h('span', { class: 'warn' }, `Deductivo: −${money(v * pu)}`));
          if (v > actual) impacto.appendChild(h('span', { class: 'warn', style: { marginLeft: '8px' } }, `⚠ no puedes quitar más de ${num(actual, 2)}`));
          else impacto.appendChild(h('span', { class: 'muted', style: { marginLeft: '8px' } }, `queda ${num(actual - v, 2)} ${c.unidad || ''}`));
        } else {
          const delta = (v - actual) * pu;
          impacto.innerHTML = '';
          impacto.appendChild(delta >= 0
            ? h('span', { class: 'ok' }, `Aditivo: +${money(delta)}`)
            : h('span', { class: 'warn' }, `Deductivo: −${money(-delta)}`));
        }
      }
      sel.addEventListener('change', () => refreshInfo(true));
      cantIn.addEventListener('input', refreshImpacto);
      refreshInfo(true);
      const ok = await modal({
        title: accion === 'modificar' ? 'Modificar cantidad (aditiva/deductiva)' : 'Quitar cantidad (deductiva)',
        body: h('div', {}, [
          h('div', { class: 'field' }, [h('label', {}, 'Concepto del catálogo'), sel]),
          info,
          h('div', { class: 'field', style: { marginTop: '10px' } }, [h('label', {}, accion === 'modificar' ? 'Nueva cantidad (total)' : 'Cantidad a quitar'), cantIn]),
          impacto,
          accion === 'quitar' && h('p', { class: 'muted', style: { fontSize: '11px', marginTop: '8px' } }, 'Deja la cantidad completa para quitar el concepto entero, o pon menos para quitar solo una parte. Al aplicar la OC no se podrá quitar por debajo de lo ya ejecutado (validación en la fase de aplicación).')
        ]),
        confirmLabel: 'Agregar cambio',
        onConfirm: () => {
          if (cantIn.value === '' || isNaN(Number(cantIn.value))) { toast('Captura la cantidad', 'warn'); return false; }
          const c = conceptosMap[sel.value];
          if (accion === 'quitar' && Number(cantIn.value) > (Number(c?.cantidad) || 0)) { toast('No puedes quitar más de la cantidad contratada', 'warn'); return false; }
          return true;
        }
      });
      if (!ok) return;
      if (accion === 'modificar') work.items.push({ accion, conceptoId: sel.value, despues: Number(cantIn.value) || 0 });
      else work.items.push({ accion, conceptoId: sel.value, cantidad: Number(cantIn.value) || 0 });
      renderItems();
    }

    const editor = h('div', {}, [
      h('div', { class: 'row' }, [
        h('h1', { style: { margin: 0 } }, existente ? `OC #${work.numero || ''}` : 'Nueva orden de cambio'),
        readonly && h('span', { class: 'tag ok' }, ESTADO_TAG[existente.estado]?.[1] || ''),
        h('div', { style: { flex: 1 } }),
        h('button', { class: 'btn ghost', onClick: () => drawLista() }, '← Volver')
      ]),
      h('div', { class: 'card' }, [
        h('div', { class: 'grid-2' }, [
          h('div', { class: 'field' }, [h('label', {}, 'Descripción del cambio'), descIn]),
          h('div', { class: 'field' }, [h('label', {}, 'Fecha'), fechaIn])
        ])
      ]),
      h('div', { class: 'card' }, [
        h('div', { class: 'row', style: { marginBottom: '8px' } }, [
          h('h3', { style: { margin: 0 } }, 'Partidas del cambio'),
          h('div', { style: { flex: 1 } }),
          !readonly && h('button', { class: 'btn sm ok', onClick: addAgregar }, '＋ Agregar concepto'),
          !readonly && h('button', { class: 'btn sm', onClick: () => addSobreConcepto('modificar') }, '✎ Modificar cantidad'),
          !readonly && h('button', { class: 'btn sm warn', onClick: () => addSobreConcepto('quitar') }, '－ Quitar cantidad')
        ]),
        h('table', { class: 'tbl' }, [
          h('thead', {}, [h('tr', {}, [h('th', {}, 'Acción'), h('th', {}, 'Concepto'), h('th', { class: 'num' }, 'Aditivo'), h('th', { class: 'num' }, 'Deductivo'), h('th', {}, '')])]),
          itemsBody
        ])
      ]),
      h('div', { class: 'card' }, [
        h('div', { class: 'grid-4' }, [
          kvBig('Aditivo', sumAdit, ''), kvBig('Deductivo', sumDeduct, ''),
          kvBig('Neto', sumNeto, ''), kvBig('Contrato vigente proyectado', vigenteProy, '')
        ]),
        h('p', { class: 'muted', style: { fontSize: '11px', marginTop: '8px' } }, 'Cotización: así quedaría el contrato SI se aplica esta OC. En borrador no se toca nada.')
      ]),
      !readonly && h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, [
        h('button', { class: 'btn ghost', onClick: () => drawLista() }, 'Cancelar'),
        h('button', { class: 'btn primary', onClick: guardar }, '💾 Guardar borrador')
      ])
    ]);

    renderShell(crumbs(obraId, m.nombre), editor);
    renderItems();

    async function guardar() {
      const t = ocTotales(work, conceptosMap);
      const payload = {
        id: work.id, descripcion: work.descripcion || '', fecha: work.fecha,
        estado: 'borrador', tipo: t.tipo,
        items: work.items,
        montoAditivo: Math.round(t.aditivo * 100) / 100,
        montoDeductivo: Math.round(t.deductivo * 100) / 100,
        montoNeto: Math.round(t.neto * 100) / 100
      };
      try {
        const id = await saveOrdenCambio(obraId, payload);
        // refresca cache local para que la lista lo muestre sin re-fetch
        const all = await listOrdenesCambio(obraId);
        Object.keys(ocs).forEach(k => delete ocs[k]);
        Object.assign(ocs, all);
        toast('Borrador guardado', 'ok');
        drawLista();
      } catch (err) { toast('Error: ' + err.message, 'danger'); }
    }
  }
}

function kvBig(label, valNodeOrText, kind) {
  const color = kind === 'ok' ? 'var(--ok)' : kind === 'warn' ? 'var(--warn)' : kind === 'accent' ? 'var(--accent)' : '';
  const val = typeof valNodeOrText === 'string'
    ? h('div', { class: 'mono', style: { fontSize: '20px', fontWeight: 600, color } }, valNodeOrText)
    : h('div', { class: 'mono', style: { fontSize: '20px', fontWeight: 600 } }, valNodeOrText);
  return h('div', { class: 'field' }, [h('label', {}, label), val]);
}

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || (obraId || '').slice(0, 6), to: '/obras/' + obraId },
    { label: 'Catálogo', to: '/obras/' + obraId + '/catalogo' },
    { label: 'Órdenes de cambio' }
  ];
}
