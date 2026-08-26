// Detalle de estimación del subcontratista. Captura cantidad ejecutada por el sub
// para cada concepto y calcula el importe a pagarle según los precios adjudicados.

import { h, modal, toast, buzonBadge } from '../util/dom.js';
import { renderShell } from './shell.js';
import { rread, loadObra, buildConceptosLookup, setSubEstimacionAvance, setSubEstimacionConIva, setPagoSub,
         cerrarSubEstimacion, reabrirSubEstimacion, setSubEstimacionRetenciones,
         getObraLinks, listBuzonItems, pushBuzonItem, updateBuzonItem } from '../services/db.js';
import { state } from '../state/store.js';
import { navigate, dispatch } from '../state/router.js';
import { money, num, dateMx, pct } from '../util/format.js';

export async function renderSubEstimacion({ params }) {
  const { id: obraId, subid: subId, eid } = params;
  renderShell(crumbs(obraId, '...', subId, '...', eid), h('div', { class: 'empty' }, 'Cargando…'));

  const obra = await loadObra(obraId);
  const sub = obra?.subcontratos?.[subId];
  const est = sub?.estimaciones?.[eid];
  if (!obra || !sub || !est) {
    renderShell([{ label: 'Obras', to: '/' }], h('div', { class: 'empty' }, 'Estimación del sub no encontrada.'));
    return;
  }
  const m = obra.meta || {};
  const meta = sub.meta || {};
  const conceptosAll = buildConceptosLookup(obra);
  const conceptosSub = sub.conceptos || [];
  const ganador = sub.licitantes?.[meta.licitanteAdjudicadoId];
  if (!ganador) {
    renderShell(crumbs(obraId, m.nombre, subId, meta.nombre, eid), h('div', { class: 'empty' }, 'Subcontrato no adjudicado.'));
    return;
  }
  const ivaPct = Number(m.ivaPct ?? 0.16);
  const editable = est.estado === 'borrador';
  // Modo de IVA de ESTA estimación al sub: con IVA (16%) o sin IVA (importe neto,
  // el sub no factura). Default: con IVA (comportamiento histórico).
  let estConIva = est.conIva !== false;

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
  // Etiquetas dinámicas según el modo de IVA de la estimación
  const ivaLabelNode = h('label', {}, '');
  const importeLabelNode = h('label', {}, '');
  function refreshIvaLabels() {
    ivaLabelNode.textContent = estConIva ? `IVA (${pct(ivaPct)})` : 'IVA (no aplica)';
    importeLabelNode.textContent = estConIva ? 'Importe (c/IVA)' : 'Importe (neto)';
  }

  // Retenciones (fondo de garantía / vicios ocultos). Se descuentan del pago de
  // ESTA estimación y se liberan después. Las de modo 'pct' se recalculan contra
  // el subtotal vivo; las 'fijo' se quedan en el monto capturado.
  // RTDB puede devolver el array como objeto si hubo huecos; normalizamos.
  let retenciones = Array.isArray(est.retenciones)
    ? est.retenciones.filter(Boolean).map(r => ({ ...r }))
    : (est.retenciones && typeof est.retenciones === 'object' ? Object.values(est.retenciones).filter(Boolean).map(r => ({ ...r })) : []);
  // Agregar/quitar retenciones solo mientras la estimación es borrador. LIBERAR
  // sí se permite después de cerrarla: la liberación ocurre meses más tarde,
  // cuando ya se cerró y hasta se pagó la estimación.
  const editableRet = editable || state.user?.role === 'admin';
  const retencionesCard = h('div', {});
  const summaryNeto = h('span', { class: 'mono', style: { fontSize: '20px', fontWeight: 700, color: 'var(--accent)' } }, '$0.00');
  const netoWrap = h('div', { class: 'field hidden', style: { marginTop: '10px' } }, [
    h('label', {}, 'Neto a entregarle al sub (importe − retenciones)'),
    summaryNeto
  ]);

  function montoRetencion(r, subtotal) {
    return r.modo === 'pct' ? subtotal * (Number(r.pct) || 0) : (Number(r.monto) || 0);
  }
  function totalRetenido(subtotal) {
    return retenciones.reduce((s, r) => s + montoRetencion(r, subtotal), 0);
  }

  // Tabla editable
  const totalsRow = h('tr', { style: { fontWeight: 600, background: 'var(--bg-2)' } });
  function recompute() {
    let subtotal = 0;
    for (const cs of conceptosSub) {
      const cant = Number(localAvances[cs.conceptoId]) || 0;
      const p = Number(ganador.precios?.[cs.conceptoId]) || 0;
      subtotal += cant * p;
    }
    const iva = estConIva ? subtotal * ivaPct : 0;
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
    summaryNeto.textContent = money(importe - totalRetenido(subtotal));
    netoWrap.classList.toggle('hidden', retenciones.length === 0);
    renderRetenciones(subtotal);
  }

  function subtotalActual() {
    let s = 0;
    for (const cs of conceptosSub) {
      s += (Number(localAvances[cs.conceptoId]) || 0) * (Number(ganador.precios?.[cs.conceptoId]) || 0);
    }
    return s;
  }

  function renderRetenciones(subtotal) {
    retencionesCard.innerHTML = '';
    const filas = retenciones.map((r, i) => {
      const monto = montoRetencion(r, subtotal);
      const liberada = !!r.liberadaAt;
      return h('div', { class: 'row', style: { padding: '6px 0', borderTop: i ? '1px solid var(--border)' : 'none', fontSize: '12px' } }, [
        h('div', { style: { flex: 1, minWidth: 0 } }, [
          h('div', {}, [
            h('b', {}, r.etiqueta || 'Retención'),
            r.modo === 'pct' && h('span', { class: 'muted', style: { marginLeft: '6px' } }, `${pct(Number(r.pct) || 0)} del subtotal`),
            liberada && h('span', { class: 'tag ok', style: { marginLeft: '6px' } }, `✓ liberada ${dateMx(r.liberadaAt)}`)
          ])
        ]),
        h('span', { class: 'mono', style: { color: liberada ? 'var(--ok)' : 'var(--warn)' } }, '−' + money(monto)),
        !liberada && h('button', {
          class: 'btn sm ghost', style: { marginLeft: '8px' },
          title: 'Registrar la liberación de esta retención y enviarla al contador',
          onClick: () => liberarRetencionDialog(i)
        }, '💸 Liberar'),
        !liberada && editableRet && h('button', {
          class: 'btn sm danger ghost', title: 'Quitar la retención',
          onClick: async () => { retenciones.splice(i, 1); await guardarRetenciones(); }
        }, '✕')
      ]);
    });
    const subtotalRet = totalRetenido(subtotal);
    retencionesCard.appendChild(h('div', { class: 'row', style: { marginBottom: '6px' } }, [
      h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Retenciones (se descuentan del pago y se liberan después)'),
      h('div', { style: { flex: 1 } }),
      subtotalRet > 0 && h('span', { class: 'mono warn', style: { fontSize: '12px' } }, 'Total −' + money(subtotalRet)),
      editableRet && h('button', { class: 'btn sm', style: { marginLeft: '8px' }, onClick: agregarRetencionDialog }, '+ Retención')
    ]));
    if (filas.length) retencionesCard.appendChild(h('div', {}, filas));
    else retencionesCard.appendChild(h('div', { class: 'muted', style: { fontSize: '11px' } }, 'Sin retenciones. Agrega un fondo de garantía si vas a retener parte del pago.'));
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

  // Estado del buzón para este pago al sub. Si hay varios items históricos
  // (p.ej. uno rechazado + uno re-enviado), el ACTIVO (pendiente/aprobado/
  // huerfano) prevalece sobre el rechazado.
  let buzonItems = {};
  try { buzonItems = await listBuzonItems(); } catch {}
  const matching = Object.values(buzonItems).filter(it =>
    it?.tipo === 'estimacion_subcontratista' &&
    it?.obraId === obraId && it?.subcontratoId === subId && it?.subEstimacionId === eid
  );
  const activo = matching.find(it => it.estado !== 'rechazado' && it.estado !== 'cerrado');
  const buzonItem = activo || matching.sort((a, b) => (b.creadoAt || 0) - (a.creadoAt || 0))[0] || null;
  const buzonEstado = buzonItem?.estado || null;

  const bloqueado = buzonEstado === 'aprobado' || buzonEstado === 'cobrado' || buzonEstado === 'pagado';
  const editPagoBtn = h('button', { class: 'btn sm ghost', onClick: () => editPagoSubDialog() },
    bloqueado ? '🔒 Ver pago'
    : (est.pagoSub ? '✎ Editar pago' : '+ Registrar pago')
  );

  const badge = buzonBadge(buzonEstado, buzonItem);

  // Toggle Con/Sin IVA de la estimación (solo si es editable). Sin IVA = el
  // importe es neto (el sub no factura).
  const btnConIva = h('button', { class: 'btn sm', type: 'button' }, `Con IVA (${pct(ivaPct)})`);
  const btnSinIva = h('button', { class: 'btn sm', type: 'button' }, 'Sin IVA');
  function refreshIvaToggle() {
    btnConIva.className = 'btn sm' + (estConIva ? ' primary' : ' ghost');
    btnSinIva.className = 'btn sm' + (!estConIva ? ' primary' : ' ghost');
  }
  async function setIvaMode(v) {
    if (estConIva === v) return;
    estConIva = v;
    refreshIvaToggle(); refreshIvaLabels(); recompute();
    try { await setSubEstimacionConIva(obraId, subId, eid, v); }
    catch (err) { toast('Error: ' + err.message, 'danger'); }
  }
  btnConIva.addEventListener('click', () => setIvaMode(true));
  btnSinIva.addEventListener('click', () => setIvaMode(false));
  refreshIvaToggle(); refreshIvaLabels();

  const ivaModeRow = h('div', { class: 'row', style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--border)', alignItems: 'center', gap: '10px' } }, [
    h('span', { class: 'muted', style: { fontSize: '12px' } }, 'IVA de la estimación:'),
    editable
      ? h('div', { class: 'row', style: { gap: '6px' } }, [btnConIva, btnSinIva])
      : h('span', { class: 'tag ' + (estConIva ? 'muted' : 'warn') }, estConIva ? `Con IVA (${pct(ivaPct)})` : 'Sin IVA (neto)'),
    h('span', { class: 'muted', style: { fontSize: '11px' } }, estConIva ? '' : '· El sub no factura; el importe es lo neto a pagarle.')
  ]);

  const summary = h('div', { class: 'card' }, [
    h('div', { class: 'grid-3' }, [
      kvRow('Subcontratista', ganador.nombre),
      kvRow('Período', `${dateMx(est.periodoIni)} – ${dateMx(est.periodoFin)}`),
      kvRow('Fecha de corte', dateMx(est.fechaCorte))
    ]),
    ivaModeRow,
    h('div', { class: 'grid-3', style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--border)' } }, [
      kvBig('Subtotal a pagar', summarySub),
      h('div', { class: 'field' }, [ivaLabelNode, h('div', {}, summaryIva)]),
      h('div', { class: 'field' }, [importeLabelNode, h('div', {}, summaryImp)])
    ]),
    h('div', { style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--border)' } }, retencionesCard),
    netoWrap,
    h('div', { class: 'row', style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--border)' } }, [
      h('div', {}, [
        h('span', { class: 'muted' }, 'Pago al sub: '),
        est.pagoSub
          ? h('b', {}, [money(est.pagoSub.importe), ' · ', dateMx(est.pagoSub.fecha)])
          : h('span', { class: 'muted' }, 'Sin registrar'),
        badge
      ]),
      h('div', { style: { flex: 1 } }),
      // El pago se puede registrar/enviar aunque la estimación esté CERRADA: se
      // cierra para dejar los números finales y luego se paga al sub. Solo se
      // bloquea (a solo lectura) si el contador ya lo aprobó en bitácora.
      editPagoBtn
    ])
  ]);

  // Insertar el totalsRow como tfoot de la tabla principal
  table.appendChild(h('tfoot', {}, totalsRow));
  recompute();

  renderShell(crumbs(obraId, m.nombre, subId, subNombre, eid, est.numero), h('div', {}, [
    head, summary, h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } }, table)
  ]));

  async function guardarRetenciones() {
    try {
      await setSubEstimacionRetenciones(obraId, subId, eid, retenciones);
      est.retenciones = retenciones;
      recompute();
    } catch (err) { toast('Error: ' + err.message, 'danger'); }
  }

  async function agregarRetencionDialog() {
    const etq = h('input', { value: 'Fondo de garantía (vicios ocultos)' });
    const rPct = h('input', { type: 'radio', name: 'ret-modo', checked: true });
    const rFijo = h('input', { type: 'radio', name: 'ret-modo' });
    const pctIn = h('input', { type: 'number', step: '0.01', min: '0', max: '100', value: '5' });
    const montoIn = h('input', { type: 'number', step: '0.01', value: '', disabled: true });
    const prev = h('div', { style: { fontSize: '12px', marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border)' } });
    const sub = subtotalActual();
    const iva = estConIva ? sub * ivaPct : 0;
    function refresh() {
      pctIn.disabled = !rPct.checked; montoIn.disabled = !rFijo.checked;
      const monto = rPct.checked ? sub * ((Number(pctIn.value) || 0) / 100) : (Number(montoIn.value) || 0);
      const yaRetenido = totalRetenido(sub);
      prev.innerHTML = '';
      prev.appendChild(h('div', {}, ['Se retendrían ', h('b', { class: 'mono warn' }, money(monto)), ' del subtotal de ', h('b', { class: 'mono' }, money(sub)), '.']));
      prev.appendChild(h('div', { class: 'muted', style: { marginTop: '4px' } }, [
        'Neto a pagarle al sub: ', h('b', { class: 'mono' }, money(sub + iva - yaRetenido - monto))
      ]));
    }
    [rPct, rFijo].forEach(r => r.addEventListener('change', refresh));
    pctIn.addEventListener('input', refresh); montoIn.addEventListener('input', refresh);
    refresh();

    const ok = await modal({
      title: 'Agregar retención',
      body: h('div', {}, [
        h('p', { class: 'muted', style: { fontSize: '12px', marginTop: 0 } }, 'Se descuenta del pago de esta estimación y queda pendiente de liberar. Al registrar el pago, el buzón recibe el gasto por el neto y la retención por separado, para que el contador la lleve como fondo pendiente.'),
        h('div', { class: 'field' }, [h('label', {}, 'Concepto de la retención'), etq]),
        h('div', { style: { marginTop: '10px' } }, [
          h('label', { class: 'row' }, [rPct, h('span', {}, '% del subtotal')]),
          h('div', { class: 'field', style: { marginTop: '6px' } }, [h('label', {}, 'Porcentaje (%)'), pctIn]),
          h('label', { class: 'row', style: { marginTop: '8px' } }, [rFijo, h('span', {}, 'Monto fijo')]),
          h('div', { class: 'field', style: { marginTop: '6px' } }, [h('label', {}, 'Monto'), montoIn])
        ]),
        prev
      ]),
      confirmLabel: 'Agregar',
      onConfirm: () => {
        if (!etq.value.trim()) { toast('Ponle un concepto a la retención', 'warn'); return false; }
        const monto = rPct.checked ? sub * ((Number(pctIn.value) || 0) / 100) : (Number(montoIn.value) || 0);
        if (!(monto > 0)) { toast('La retención debe ser mayor a cero', 'warn'); return false; }
        return true;
      }
    });
    if (!ok) return;
    retenciones.push(rPct.checked
      ? { etiqueta: etq.value.trim(), modo: 'pct', pct: (Number(pctIn.value) || 0) / 100, creadaAt: Date.now() }
      : { etiqueta: etq.value.trim(), modo: 'fijo', monto: Number(montoIn.value) || 0, creadaAt: Date.now() });
    await guardarRetenciones();
  }

  // Liberar = el dinero retenido sale ahora. Se marca en la retención y se manda
  // al buzón como movimiento aparte, para que el contador registre ESE gasto.
  async function liberarRetencionDialog(idx) {
    const r = retenciones[idx];
    if (!r) return;
    const sub = subtotalActual();
    const monto = montoRetencion(r, sub);
    const montoIn = h('input', { type: 'number', step: '0.01', value: monto.toFixed(2) });
    const fechaIn = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const ok = await modal({
      title: 'Liberar retención',
      body: h('div', {}, [
        h('p', { class: 'muted', style: { fontSize: '12px', marginTop: 0 } }, [
          'Se le libera a ', h('b', {}, ganador.nombre), ' la retención "', h('b', {}, r.etiqueta || 'Retención'), '" de la estimación #', String(est.numero), '. Se enviará al buzón como gasto, porque este sí es dinero que sale ahora.'
        ]),
        h('div', { class: 'grid-2' }, [
          h('div', { class: 'field' }, [h('label', {}, 'Monto a liberar'), montoIn]),
          h('div', { class: 'field' }, [h('label', {}, 'Fecha'), fechaIn])
        ]),
        montoIn.value !== monto.toFixed(2) ? null : h('p', { class: 'muted', style: { fontSize: '11px', marginTop: '8px' } }, `Retenido originalmente: ${money(monto)}. Si liberas menos, la diferencia queda como descuento definitivo.`)
      ]),
      confirmLabel: 'Liberar y enviar al contador',
      onConfirm: () => {
        const v = Number(montoIn.value);
        if (!(v > 0)) { toast('Captura el monto a liberar', 'warn'); return false; }
        return true;
      }
    });
    if (!ok) return;
    const liberadaMonto = Number(montoIn.value) || 0;
    const liberadaAt = fechaIn.value ? new Date(fechaIn.value).getTime() : Date.now();
    try {
      retenciones[idx] = { ...r, liberadaAt, liberadaMonto, montoRetenido: monto };
      await setSubEstimacionRetenciones(obraId, subId, eid, retenciones);
      await enviarRetencionAlBuzon(obraId, subId, eid, sub, est, ganador, retenciones[idx], idx, 'liberacion');
      est.retenciones = retenciones;
      toast('Retención liberada y enviada al buzón', 'ok');
      recompute();
    } catch (err) { toast('Error: ' + err.message, 'danger'); }
  }

  async function cerrarConfirm() {
    await modal({
      title: 'Cerrar estimación del sub',
      body: h('div', {}, 'Una vez cerrada, no se podrán modificar los avances. El pago al sub sí se puede registrar y enviar al contador después de cerrar.'),
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
    // Si el gasto ya fue aprobado por el contador, NO se puede editar desde
    // estimaciones — esto evita inconsistencia con el movimiento contable.
    if (bloqueado && buzonItem) {
      const estadoLabel = { aprobado: 'aprobado', cobrado: 'pagado', pagado: 'pagado' }[buzonEstado] || buzonEstado;
      const fechaApr = buzonItem.aprobadoAt ? new Date(buzonItem.aprobadoAt).toLocaleString('es-MX') : 'fecha desconocida';
      await modal({
        title: `Pago a ${ganador.nombre} (${estadoLabel})`,
        body: h('div', {}, [
          h('div', { class: 'card', style: { background: 'rgba(93,211,158,0.08)', borderColor: 'var(--ok)', padding: '12px', marginTop: 0 } }, [
            h('div', { class: 'tag ok', style: { marginBottom: '8px' } }, `🔒 ${estadoLabel.charAt(0).toUpperCase() + estadoLabel.slice(1)} por el contador`),
            h('div', { style: { fontSize: '13px', marginBottom: '8px' } }, `Aprobado el ${fechaApr}.`),
            h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Para hacer cualquier cambio en este pago, debe gestionarse del lado de la app contadora (SOGRUB Bitácora). Desde aquí no se puede editar para evitar que los datos queden desincronizados con el gasto ya registrado.')
          ]),
          h('div', { class: 'grid-2', style: { marginTop: '14px' } }, [
            h('div', { class: 'field' }, [h('label', {}, 'Subtotal'), h('div', { class: 'mono' }, money(buzonItem.monto?.subtotal || 0))]),
            h('div', { class: 'field' }, [h('label', {}, 'IVA'), h('div', { class: 'mono' }, money(buzonItem.monto?.iva || 0))])
          ]),
          h('div', { class: 'grid-2', style: { marginTop: '8px' } }, [
            h('div', { class: 'field' }, [h('label', {}, 'Importe'), h('div', { class: 'mono', style: { color: 'var(--accent)', fontWeight: 600 } }, money(buzonItem.monto?.importe || 0))]),
            h('div', { class: 'field' }, [h('label', {}, 'Fecha del pago'), h('div', {}, buzonItem.fecha ? dateMx(buzonItem.fecha) : '—')])
          ]),
          buzonItem.movId && h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '12px' } }, [
            'ID del movimiento contable: ', h('code', {}, buzonItem.movId)
          ])
        ]),
        confirmLabel: 'Cerrar', cancelLabel: '',
        onConfirm: () => true
      });
      return;
    }

    // Calcular sugerido a partir de los avances actuales y precios adjudicados
    let subtotalCalc = 0;
    for (const cs of conceptosSub) {
      const cant = Number(localAvances[cs.conceptoId]) || 0;
      const puSub = Number(ganador.precios?.[cs.conceptoId]) || 0;
      subtotalCalc += cant * puSub;
    }
    const ivaCalc = subtotalCalc * ivaPct;
    const importeCalc = subtotalCalc + ivaCalc;

    const cur = est.pagoSub || { subtotal: 0, iva: 0, importe: 0, fecha: Date.now(), conIva: estConIva };
    // Default del pago: sigue el modo de IVA de la estimación (con/sin IVA)
    let conIva = cur.conIva !== false;

    const radioConIva = h('input', { type: 'radio', name: 'pago-iva', value: 'con', checked: conIva });
    const radioSinIva = h('input', { type: 'radio', name: 'pago-iva', value: 'sin', checked: !conIva });
    const subtotalIn = h('input', { type: 'number', step: '0.01', value: cur.subtotal || '' });
    const ivaIn = h('input', { type: 'number', step: '0.01', value: cur.iva || '' });
    const importeIn = h('input', { type: 'number', step: '0.01', value: cur.importe || '' });
    const fechaIn = h('input', { type: 'date', value: cur.fecha ? new Date(cur.fecha).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10) });
    const trasladarBtn = h('button', { type: 'button', class: 'btn ghost sm' }, '↧ Trasladar montos calculados');
    const ivaLabel = h('label', {}, 'IVA (auto)');
    const importeLabel = h('label', {}, 'Importe');

    function aplicarModoIva() {
      if (conIva) {
        ivaIn.disabled = false;
        ivaIn.style.opacity = '1';
        ivaLabel.textContent = `IVA (${pct(ivaPct)}, auto)`;
        importeLabel.textContent = 'Importe (c/IVA)';
        // Re-sync del IVA según el subtotal actual
        const s = Number(subtotalIn.value) || 0;
        if (s > 0) {
          ivaIn.value = (s * ivaPct).toFixed(2);
          importeIn.value = (s * (1 + ivaPct)).toFixed(2);
        }
      } else {
        ivaIn.disabled = true;
        ivaIn.style.opacity = '0.5';
        ivaIn.value = '0.00';
        ivaLabel.textContent = 'IVA (no aplica)';
        importeLabel.textContent = 'Importe (= Subtotal)';
        importeIn.value = subtotalIn.value || '';
      }
    }

    function syncFromSub() {
      const s = Number(subtotalIn.value) || 0;
      if (conIva) {
        ivaIn.value = (s * ivaPct).toFixed(2);
        importeIn.value = (s * (1 + ivaPct)).toFixed(2);
      } else {
        ivaIn.value = '0.00';
        importeIn.value = s.toFixed(2);
      }
    }
    function syncFromImp() {
      const i = Number(importeIn.value) || 0;
      if (conIva) {
        const s = i / (1 + ivaPct);
        subtotalIn.value = s.toFixed(2);
        ivaIn.value = (s * ivaPct).toFixed(2);
      } else {
        // Sin IVA: importe = subtotal
        subtotalIn.value = i.toFixed(2);
        ivaIn.value = '0.00';
      }
    }

    radioConIva.addEventListener('change', () => { conIva = true; aplicarModoIva(); });
    radioSinIva.addEventListener('change', () => { conIva = false; aplicarModoIva(); });
    subtotalIn.addEventListener('input', syncFromSub);
    importeIn.addEventListener('input', syncFromImp);
    trasladarBtn.addEventListener('click', () => {
      if (conIva) {
        subtotalIn.value = subtotalCalc.toFixed(2);
        ivaIn.value = ivaCalc.toFixed(2);
        importeIn.value = importeCalc.toFixed(2);
      } else {
        subtotalIn.value = subtotalCalc.toFixed(2);
        ivaIn.value = '0.00';
        importeIn.value = subtotalCalc.toFixed(2);
      }
    });
    // Las retenciones se descuentan del importe capturado (que es el BRUTO de la
    // estimación). Se muestra el neto para que quede claro qué se le entrega.
    const retencionPreview = h('div', { style: { marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--border)', fontSize: '12px' } });
    function refreshRetencionPreview() {
      const pendientes = retenciones.filter(r => !r.liberadaAt);
      retencionPreview.innerHTML = '';
      if (!pendientes.length) return;
      const subCalc = subtotalActual();
      const bruto = conIva ? (Number(importeIn.value) || 0) : (Number(subtotalIn.value) || 0);
      const totalRet = pendientes.reduce((s, r) => s + montoRetencion(r, subCalc), 0);
      retencionPreview.appendChild(h('div', { class: 'muted', style: { marginBottom: '4px' } }, 'Retenciones de esta estimación:'));
      for (const r of pendientes) {
        retencionPreview.appendChild(h('div', { class: 'row' }, [
          h('span', {}, r.etiqueta || 'Retención'),
          h('div', { style: { flex: 1 } }),
          h('span', { class: 'mono warn' }, '−' + money(montoRetencion(r, subCalc)))
        ]));
      }
      retencionPreview.appendChild(h('div', { class: 'row', style: { marginTop: '6px', paddingTop: '6px', borderTop: '1px solid var(--border)', fontWeight: 600 } }, [
        h('span', {}, 'Neto que se le entrega'),
        h('div', { style: { flex: 1 } }),
        h('span', { class: 'mono', style: { color: 'var(--accent)' } }, money(bruto - totalRet))
      ]));
      retencionPreview.appendChild(h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '6px' } },
        'El importe de arriba es el bruto de la estimación. Al contador le llega el gasto por el neto, y la retención por separado como fondo pendiente de liberar.'));
    }
    subtotalIn.addEventListener('input', refreshRetencionPreview);
    importeIn.addEventListener('input', refreshRetencionPreview);
    trasladarBtn.addEventListener('click', refreshRetencionPreview);
    radioConIva.addEventListener('change', refreshRetencionPreview);
    radioSinIva.addEventListener('change', refreshRetencionPreview);

    aplicarModoIva();   // estado inicial
    refreshRetencionPreview();

    await modal({
      title: 'Pago al subcontratista',
      body: h('div', {}, [
        h('p', { class: 'muted', style: { marginTop: 0, fontSize: '12px' } }, [
          `Registra el pago hecho a ${ganador.nombre} por la estimación #${est.numero}. Al guardar se enviará al buzón del contador para que registre el gasto en bitácora.`
        ]),
        h('div', { class: 'card', style: { padding: '10px', marginTop: 0 } }, [
          h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '6px' } }, '¿El pago incluye IVA?'),
          h('div', { class: 'row', style: { gap: '14px' } }, [
            h('label', { class: 'row', style: { cursor: 'pointer' } }, [radioConIva, h('span', {}, `Con IVA (${pct(ivaPct)})`)]),
            h('label', { class: 'row', style: { cursor: 'pointer' } }, [radioSinIva, h('span', {}, 'Sin IVA')])
          ]),
          h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '8px' } }, [
            'Sugerido (calculado): subtotal ', h('b', { class: 'mono' }, money(subtotalCalc)),
            ' · IVA ', h('b', { class: 'mono' }, money(ivaCalc)),
            ' · importe ', h('b', { class: 'mono' }, money(importeCalc))
          ]),
          h('div', { style: { marginTop: '8px' } }, trasladarBtn)
        ]),
        h('div', { class: 'grid-2', style: { marginTop: '14px' } }, [
          h('div', { class: 'field' }, [h('label', {}, 'Subtotal'), subtotalIn]),
          h('div', { class: 'field' }, [ivaLabel, ivaIn])
        ]),
        h('div', { class: 'grid-2', style: { marginTop: '10px' } }, [
          h('div', { class: 'field' }, [importeLabel, importeIn]),
          h('div', { class: 'field' }, [h('label', {}, 'Fecha'), fechaIn])
        ]),
        retencionPreview
      ]),
      confirmLabel: 'Guardar y enviar al contador',
      onConfirm: async () => {
        try {
          const subtotal = Number(subtotalIn.value) || 0;
          const ivaVal = conIva ? (Number(ivaIn.value) || 0) : 0;
          const importe = conIva ? (Number(importeIn.value) || subtotal + ivaVal) : subtotal;
          const pago = { subtotal, iva: ivaVal, importe, conIva, fecha: fechaIn.value ? new Date(fechaIn.value).getTime() : Date.now() };

          // Desglose por concepto OPUS: cada concepto del sub con cantidad > 0
          // en esta estimación contribuye con cantidad × P.U. del adjudicado.
          // Si el subtotal capturado difiere del subtotal calculado (porque el
          // ingeniero ajustó manualmente), escalamos proporcionalmente para
          // que la suma del desglose cuadre con el subtotal real del pago.
          const desgloseRaw = [];
          let subtotalCalcReal = 0;
          for (const cs of conceptosSub) {
            const cant = Number(localAvances[cs.conceptoId]) || 0;
            if (cant <= 0) continue;
            const puSub = Number(ganador.precios?.[cs.conceptoId]) || 0;
            const cat = conceptosAll[cs.conceptoId];
            if (!cat) continue;
            const importeRaw = cant * puSub;
            subtotalCalcReal += importeRaw;
            desgloseRaw.push({ clave: cat.clave || '', descripcion: cat.descripcion || '', cantidad: cant, precioUnitario: puSub, importeRaw });
          }
          const factor = (subtotalCalcReal > 0 && subtotal > 0) ? (subtotal / subtotalCalcReal) : 1;
          const desglose = desgloseRaw.map(d => ({
            clave: d.clave,
            descripcion: d.descripcion,
            cantidad: d.cantidad,
            precioUnitario: d.precioUnitario,
            importe: Number((d.importeRaw * factor).toFixed(2))
          }));

          // Las retenciones se descuentan del pago: el gasto que ve el contador
          // es el NETO que salió de caja, y cada retención va aparte al buzón
          // como fondo pendiente (no es gasto hasta que se libere).
          const subCalc = subtotalActual();
          const retenidas = retenciones.filter(r => !r.liberadaAt).map((r, i) => ({
            idx: i, etiqueta: r.etiqueta || 'Retención', modo: r.modo || 'fijo',
            pct: r.modo === 'pct' ? (Number(r.pct) || 0) : null,
            monto: Math.round(montoRetencion(r, subCalc) * 100) / 100
          }));
          const retencionTotal = retenidas.reduce((s, r) => s + r.monto, 0);
          pago.importeBruto = Math.round(importe * 100) / 100;
          pago.retencionTotal = Math.round(retencionTotal * 100) / 100;
          pago.retenciones = retenidas;
          pago.importe = Math.round((importe - retencionTotal) * 100) / 100;

          await setPagoSub(obraId, subId, eid, pago);
          await sincronizarPagoSubConBuzon(obraId, subId, eid, sub, est, ganador, pago, desglose);
          for (const r of retenciones) {
            if (r.liberadaAt) continue;
            await enviarRetencionAlBuzon(obraId, subId, eid, subCalc, est, ganador, r, retenciones.indexOf(r), 'retencion');
          }
          toast(retencionTotal > 0
            ? 'Pago neto y retención enviados al buzón del contador'
            : 'Pago guardado y enviado al buzón del contador', 'ok');
          dispatch();
          return true;
        } catch (err) {
          console.error(err);
          toast('Error: ' + err.message, 'danger');
          return false;
        }
      }
    });
  }
}

// Manda una retención al buzón como movimiento APARTE del pago.
//   movimiento 'retencion'   → informativo: el dinero NO salió, queda como fondo
//                              pendiente de liberar (no es gasto todavía).
//   movimiento 'liberacion'  → ahora sí sale el dinero: es gasto.
// Van con `refKey` para que el contador pueda parear la liberación con su
// retención original y no las cuente dos veces.
async function enviarRetencionAlBuzon(obraId, subId, eid, subtotalEst, est, ganador, ret, idx, movimiento) {
  const [links, obraMeta, sub] = await Promise.all([
    getObraLinks(),
    rread(`obras/${obraId}/meta`),
    rread(`obras/${obraId}/subcontratos/${subId}/meta`)
  ]);
  const proyectoId = links?.[obraId] || null;
  const subNombre = sub?.nombre || '';
  const proveedorNombre = ganador?.nombre || '';
  const refKey = `${obraId}:${subId}:${eid}:ret${idx}`;
  const esLiberacion = movimiento === 'liberacion';
  const monto = esLiberacion
    ? (Number(ret.liberadaMonto) || 0)
    : (ret.modo === 'pct' ? subtotalEst * (Number(ret.pct) || 0) : (Number(ret.monto) || 0));

  const items = await listBuzonItems();
  const existing = Object.entries(items).find(([, it]) =>
    it?.tipo === 'retencion_subcontratista' && it?.refKey === refKey && it?.movimiento === movimiento &&
    (it?.estado === 'pendiente' || it?.estado === 'huerfano')
  );

  const payload = {
    tipo: 'retencion_subcontratista',
    movimiento,                        // 'retencion' | 'liberacion'
    esGasto: esLiberacion,             // solo la liberación mueve efectivo
    origenApp: 'estimaciones',
    obraId, obraNombre: obraMeta?.nombre || '', proyectoId,
    subcontratoId: subId, subcontratoNombre: subNombre,
    subEstimacionId: eid, subEstimacionNumero: est.numero,
    proveedorNombre,
    refKey,
    etiqueta: ret.etiqueta || 'Retención',
    modo: ret.modo || 'fijo',
    pct: ret.modo === 'pct' ? (Number(ret.pct) || 0) : null,
    monto: Math.round(monto * 100) / 100,
    fecha: esLiberacion ? (ret.liberadaAt || Date.now()) : (est.fechaCorte || Date.now()),
    descripcion: esLiberacion
      ? `Liberación de ${ret.etiqueta || 'retención'} a ${proveedorNombre} — "${subNombre}", estimación #${est.numero}`
      : `Retención de ${ret.etiqueta || 'garantía'} a ${proveedorNombre} — "${subNombre}", estimación #${est.numero} (no es gasto: el dinero no salió)`,
    estado: 'pendiente',
    creadoPor: state.user?.uid || ''
  };

  if (existing) await updateBuzonItem(existing[0], { ...payload, actualizadoAt: Date.now() });
  else await pushBuzonItem(payload);
}

// Sincroniza con /shared/buzon: crea o actualiza item tipo='estimacion_subcontratista'
// para que el contador apruebe y se vuelva un gasto en bitácora.
// `desglose` es opcional: array de { clave, descripcion, cantidad, precioUnitario, importe }
// que el contador puede mapear automáticamente a `desglose_presupuesto` si la bitácora
// tiene el catálogo OPUS importado en el proyecto pareado.
async function sincronizarPagoSubConBuzon(obraId, subId, eid, sub, est, ganador, pago, desglose) {
  const [links, obraMeta] = await Promise.all([
    getObraLinks(),
    rread(`obras/${obraId}/meta`)
  ]);
  const proyectoId = links?.[obraId] || null;
  const obraNombre = obraMeta?.nombre || '';

  const items = await listBuzonItems();
  const existing = Object.entries(items).find(([_, it]) =>
    it?.tipo === 'estimacion_subcontratista' &&
    it?.obraId === obraId &&
    it?.subcontratoId === subId &&
    it?.subEstimacionId === eid &&
    (it?.estado === 'pendiente' || it?.estado === 'huerfano')
  );

  const subNombre = sub.meta?.nombre || '';
  const proveedorNombre = ganador?.nombre || '';

  const payload = {
    tipo: 'estimacion_subcontratista',
    origenApp: 'estimaciones',
    obraId,
    obraNombre,
    proyectoId,
    subcontratoId: subId,
    subcontratoNombre: subNombre,
    subEstimacionId: eid,
    subEstimacionNumero: est.numero,
    proveedorNombre,
    proveedorEmail: ganador?.email || '',
    proveedorTelefono: ganador?.telefono || '',
    monto: pago,
    fecha: pago.fecha,
    // Si hubo retención, el gasto es el NETO que salió de caja. El bruto y el
    // detalle van en `monto` para que el contador entienda la diferencia.
    descripcion: `Pago a ${proveedorNombre} — Subcontrato "${subNombre}", estimación #${est.numero}`
      + (Number(pago.retencionTotal) > 0 ? ` — neto tras retener ${money(pago.retencionTotal)}` : '')
      + (proyectoId ? '' : ' (obra sin vincular)'),
    retencionTotal: Number(pago.retencionTotal) || 0,
    importeBruto: Number(pago.importeBruto) || Number(pago.importe) || 0,
    desglose: Array.isArray(desglose) ? desglose : null,
    estado: 'pendiente',
    creadoPor: state.user?.uid || ''
  };

  if (existing) {
    const [itemId] = existing;
    await updateBuzonItem(itemId, {
      ...payload,
      actualizadoAt: Date.now(),
      huerfanoAt: null,
      huerfanoPor: null,
      descripcionHuerfano: null,
      movId: null,
      destinoRefPath: null
    });
  } else {
    await pushBuzonItem(payload);
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
