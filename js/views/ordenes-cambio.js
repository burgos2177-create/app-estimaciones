// Órdenes de Cambio (aditivas/deductivas) — Fase 1.
// Congela el catálogo original como baseline y permite capturar OCs en BORRADOR
// para cotizar el impacto (aditivo/deductivo/neto y contrato vigente proyectado)
// SIN tocar el catálogo vigente. Aplicar la OC y el PDF son fases posteriores.

import { h, modal, toast } from '../util/dom.js';
import { renderShell } from './shell.js';
import { loadObra, ensureCatalogoBaseline, listOrdenesCambio, saveOrdenCambio, deleteOrdenCambio,
         setOrdenCambioEstado, aplicarOrdenCambio, setAvanceObra, publicarContratoVigente,
         getObraLinks, pushBuzonItem } from '../services/db.js';
import { money, num, dateMx } from '../util/format.js';
import { navigate } from '../state/router.js';
import { computeEjecutadoPorConcepto, computeAvanceObra, exportOrdenCambioPdf } from '../services/export.js';
import { computeContrato, computeAnticipo } from '../services/contrato.js';
import { computeConceptoKey } from '../services/catalogo-keys.js';
import { state } from '../state/store.js';

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

const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

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
  // Ejecutado acumulado por concepto (tope de deductivas: no bajar de lo ejecutado).
  const ejecutadoPorConcepto = computeEjecutadoPorConcepto(obra);
  // Aprobar/aplicar/rechazar tocan el contrato vigente → solo admin.
  const isAdmin = state.user?.role === 'admin';

  // Cascada OPUS de la obra (para descomponer el P.U. en rubros que lee bitácora).
  const integ = obra.integracion || null;
  const casc = integ ? {
    pct_ind_oficina: integ.pct_ind_oficina, pct_ind_campo: integ.pct_ind_campo,
    pct_financiamiento: integ.pct_financiamiento, pct_utilidad: integ.pct_utilidad,
    pct_cargos_adicionales: integ.pct_cargos_adicionales, pct_otro: integ.pct_otro,
    iva_pct: integ.iva_pct
  } : null;
  // Venta (sin IVA) por cada $1 de costo directo, para back-out de conceptos existentes.
  const ventaPorCD = casc ? computeContrato({ ...casc, costo_directo: 1 }).subtotal_venta : 1;
  const rubrosZero = { costoDirecto: 0, indOficina: 0, indCampo: 0, financiamiento: 0, utilidad: 0, cargos: 0, otro: 0, venta: 0 };
  function rubrosDeCD(cd) {
    if (!casc) return { ...rubrosZero, costoDirecto: cd, venta: cd };
    const c = computeContrato({ ...casc, costo_directo: cd });
    return { costoDirecto: c.costo_directo, indOficina: c.ind_oficina, indCampo: c.ind_campo, financiamiento: c.financiamiento, utilidad: c.utilidad, cargos: c.cargos_adicionales, otro: c.otro, venta: c.subtotal_venta };
  }
  function rubrosDeVenta(venta) { return rubrosDeCD(ventaPorCD ? venta / ventaPorCD : 0); }
  function sumRubros(a, b, signB) { const o = {}; for (const k in rubrosZero) o[k] = (a[k] || 0) + signB * (b[k] || 0); return o; }
  // Impacto por rubro de una partida (signo: aditivo +, deductivo −).
  function itemRubros(item) {
    if (item.accion === 'agregar') {
      const cd = (Number(item.costoDirectoUnit) || 0) * (Number(item.cantidad) || 0);
      return { ...rubrosDeCD(cd) };
    }
    const c = conceptosMap[item.conceptoId];
    const pu = c ? Number(c.precio_unitario) || 0 : 0;
    if (item.accion === 'quitar') {
      const cant = (item.cantidad != null && item.cantidad !== '') ? Number(item.cantidad) : (c ? Number(c.cantidad) || 0 : 0);
      const r = rubrosDeVenta(cant * pu); const o = {}; for (const k in rubrosZero) o[k] = -(r[k] || 0); return o;
    }
    if (item.accion === 'modificar') {
      const antes = c ? Number(c.cantidad) || 0 : 0;
      const deltaVenta = ((Number(item.despues) || 0) - antes) * pu;
      const r = rubrosDeVenta(Math.abs(deltaVenta)), s = deltaVenta >= 0 ? 1 : -1; const o = {}; for (const k in rubrosZero) o[k] = s * (r[k] || 0); return o;
    }
    return { ...rubrosZero };
  }
  function ocRubros(oc) { let acc = { ...rubrosZero }; for (const it of (oc.items || [])) acc = sumRubros(acc, itemRubros(it), 1); return acc; }

  const contratoOriginal = sumaPU(baseline?.conceptos || conceptosMap);
  const contratoVigente = sumaPU(conceptosMap);
  let sumAditAplic = 0, sumDeductAplic = 0;
  for (const oc of Object.values(ocs)) {
    if (oc.estado === 'aplicada') { sumAditAplic += oc.montoAditivo || 0; sumDeductAplic += oc.montoDeductivo || 0; }
  }

  // Mantén fresco el contrato consolidado que leen las apps hermanas, aunque la
  // obra todavía no tenga ninguna OC aplicada (así siempre hay nodo que leer).
  try {
    publicarContratoVigente(obraId, buildContratoPayload({
      contratoCIVA: Number(m.montoContratoCIVA) || contratoVigente * (1 + Number(m.ivaPct ?? 0.16)),
      catalogoVigenteSubtotal: contratoVigente
    }));
  } catch (err) { console.error('No se pudo publicar el contrato vigente', err); }

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
      h('div', { class: 'row', style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border)', fontSize: '12px', flexWrap: 'wrap' } }, [
        h('div', {}, [h('span', { class: 'muted' }, 'Contrato formal vigente (c/IVA): '), h('b', { class: 'mono' }, money(Number(m.montoContratoCIVA) || 0))]),
        h('span', { class: 'tag muted', title: 'Publicado en /shared/contratos para bitácora, compras y materiales' }, '↗ publicado a las apps hermanas')
      ]),
      h('p', { class: 'muted', style: { fontSize: '11px', marginTop: '8px' } },
        'El baseline (contrato original) quedó congelado. Las OC en borrador/aprobada NO cambian el contrato vigente ni afectan a las apps hermanas; solo cotizan el impacto. Al APLICAR una OC aprobada, sus cambios entran al catálogo vigente y se reflejan en las apps hermanas.'),
      !isAdmin && h('p', { class: 'muted', style: { fontSize: '11px' } }, 'Solo un administrador puede aprobar y aplicar órdenes de cambio.')
    ]);

    const filas = ocsArr.map(oc => {
      // Para OC no-borrador usa los montos congelados al momento de guardar: el
      // catálogo vigente ya pudo cambiar (p.ej. tras aplicarla) y recalcular en
      // vivo reportaría un impacto equivocado.
      const t = (oc.estado && oc.estado !== 'borrador' && oc.montoNeto != null)
        ? { aditivo: oc.montoAditivo || 0, deductivo: oc.montoDeductivo || 0, neto: oc.montoNeto || 0, tipo: oc.tipo || 'mixta' }
        : ocTotales(oc, conceptosMap);
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
          h('button', { class: 'btn sm ghost', style: { marginLeft: '6px' }, title: 'PDF para el cliente', onClick: () => { try { exportOrdenCambioPdf(obra, oc); } catch (e) { toast('Error: ' + e.message, 'danger'); } } }, '⤓ PDF'),
          ...stateBtns(oc),
          (editable || oc.estado === 'rechazada') && h('button', { class: 'btn sm danger ghost', style: { marginLeft: '6px' }, onClick: () => borrarOC(oc) }, '🗑')
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

  // ===================== CICLO DE VIDA (Fase 2) =====================
  // borrador → aprobada → aplicada. rechazada / vuelta a borrador para ajustar.
  async function aprobarOC(oc) {
    const ok = await modal({
      title: `Aprobar OC #${oc.numero}`, confirmLabel: 'Aprobar',
      body: h('div', {}, [
        h('p', {}, 'Marca esta orden como APROBADA por el cliente. Queda bloqueada para edición.'),
        h('p', { class: 'muted', style: { fontSize: '12px' } }, 'Aún NO modifica el catálogo. El siguiente paso, "Aplicar al catálogo", sí surte efecto en las apps hermanas.')
      ])
    });
    if (!ok) return;
    try {
      await setOrdenCambioEstado(obraId, oc.id, 'aprobada', { aprobadaAt: Date.now(), aprobadaPor: state.user?.uid || null });
      toast('OC aprobada', 'ok'); renderOrdenesCambio({ params });
    } catch (err) { toast('Error: ' + err.message, 'danger'); }
  }

  async function rechazarOC(oc) {
    const ok = await modal({ title: `Rechazar OC #${oc.numero}`, danger: true, confirmLabel: 'Rechazar', body: h('div', {}, 'El cliente no aprobó esta orden. Podrás volverla a borrador para ajustarla o borrarla.') });
    if (!ok) return;
    try { await setOrdenCambioEstado(obraId, oc.id, 'rechazada', { rechazadaAt: Date.now() }); toast('OC rechazada', 'ok'); renderOrdenesCambio({ params }); }
    catch (err) { toast('Error: ' + err.message, 'danger'); }
  }

  async function volverBorrador(oc) {
    try { await setOrdenCambioEstado(obraId, oc.id, 'borrador', { aprobadaAt: null, aprobadaPor: null, rechazadaAt: null }); toast('OC de vuelta a borrador', 'ok'); renderOrdenesCambio({ params }); }
    catch (err) { toast('Error: ' + err.message, 'danger'); }
  }

  // Arma la mutación del catálogo para una OC (conceptos nuevos + patches),
  // revalidando el ejecutado (no se puede dejar por debajo de lo ya ejecutado).
  // Cantidad ya comprometida con subcontratistas por concepto (app-compras).
  // Reducir por debajo de esto no se bloquea, pero sí se avisa: dejaría al
  // subcontrato con alcance que ya no existe en el catálogo.
  function comprometidoConSubs(conceptoId) {
    let total = 0; const nombres = [];
    for (const sub of Object.values(obra.subcontratos || {})) {
      if (sub.meta?.estado !== 'adjudicado') continue;
      for (const cs of (sub.conceptos || [])) {
        if (cs.conceptoId !== conceptoId) continue;
        const c = Number(cs.cantidadSub) || 0;
        if (c > 0) { total += c; nombres.push(sub.meta?.nombre || 'subcontrato'); }
      }
    }
    return { total, nombres };
  }

  function buildAplicacion(oc) {
    const conceptosNuevos = {}, conceptosPatch = {}, errores = [], avisos = [];
    const cambios = { agregados: 0, modificados: 0, quitados: 0, archivados: 0 };
    let ordenMax = 0;
    for (const c of Object.values(conceptosMap)) ordenMax = Math.max(ordenMax, Number(c.orden) || 0);
    let addN = 0;
    (oc.items || []).forEach((it, idx) => {
      if (it.accion === 'agregar') {
        const cd = Number(it.costoDirectoUnit) || 0;
        const pu = Number(it.pu) || rubrosDeCD(cd).venta;
        const cant = Number(it.cantidad) || 0;
        const concepto = {
          tipo: 'precio_unitario', clave: it.clave || '', descripcion: it.descripcion || '',
          unidad: it.unidad || '', cantidad: cant, precio_unitario: pu, total: cant * pu,
          nivel: 0, path: [], agrupadores: [], orden: ordenMax + 1 + addN,
          plantillaTipo: null, plantillaConfig: null, archivado: false,
          ocOrigen: oc.id, ocNumero: oc.numero || null, costoDirectoUnit: cd
        };
        let key = computeConceptoKey(concepto);
        while (conceptosMap[key] || conceptosNuevos[key]) key = `${key}_oc${oc.numero}_${idx}`;
        conceptosNuevos[key] = concepto;
        addN++; cambios.agregados++;
      } else {
        const c = conceptosMap[it.conceptoId];
        if (!c) { errores.push('Un concepto referenciado ya no existe en el catálogo.'); return; }
        const pu = Number(c.precio_unitario) || 0;
        const ejec = Number(ejecutadoPorConcepto[it.conceptoId]) || 0;
        const actual = Number(c.cantidad) || 0;
        let nueva;
        if (it.accion === 'quitar') {
          const quita = (it.cantidad != null && it.cantidad !== '') ? Number(it.cantidad) : actual;
          nueva = actual - quita;
        } else { nueva = Number(it.despues) || 0; }
        if (nueva < ejec - 1e-6) { errores.push(`${c.clave || c.descripcion}: quedaría en ${num(nueva, 2)}, por debajo de lo ejecutado (${num(ejec, 2)}).`); return; }
        const sub = comprometidoConSubs(it.conceptoId);
        if (sub.total > 0 && nueva < sub.total - 1e-6) {
          avisos.push(`${c.clave || c.descripcion}: quedaría en ${num(nueva, 2)} pero hay ${num(sub.total, 2)} ${c.unidad || ''} adjudicados a ${[...new Set(sub.nombres)].join(', ')}.`);
        }
        if (nueva <= 1e-6) { conceptosPatch[it.conceptoId] = { cantidad: 0, total: 0, archivado: true }; cambios.quitados++; cambios.archivados++; }
        else { conceptosPatch[it.conceptoId] = { cantidad: nueva, total: nueva * pu }; if (it.accion === 'quitar') cambios.quitados++; else cambios.modificados++; }
      }
    });
    return { conceptosNuevos, conceptosPatch, errores, avisos, cambios };
  }

  // Contrato consolidado que publicamos en /shared/contratos/{obraId} para que
  // bitácora, compras y materiales lean UNA sola verdad: cuál es el contrato en
  // pie, cuánto lo movieron las OC aplicadas y cómo se reparte por rubro.
  function buildContratoPayload({ ocAplicandose = null, contratoCIVA, catalogoVigenteSubtotal } = {}) {
    const todas = { ...ocs };
    if (ocAplicandose) todas[ocAplicandose.id] = { ...(todas[ocAplicandose.id] || {}), ...ocAplicandose, estado: 'aplicada' };

    const aplicadas = {};
    let aditAcum = 0, deductAcum = 0;
    const rub = { ...rubrosZero };
    for (const [id, oc] of Object.entries(todas)) {
      if (oc.estado !== 'aplicada') continue;
      const ad = Number(oc.montoAditivo) || 0, de = Number(oc.montoDeductivo) || 0;
      aditAcum += ad; deductAcum += de;
      const r = oc.impactoRubros || {};
      for (const k in rubrosZero) rub[k] = (rub[k] || 0) + (Number(r[k]) || 0);
      aplicadas[id] = {
        numero: oc.numero || 0, fecha: oc.fecha || null, descripcion: oc.descripcion || '',
        aplicadaAt: oc.aplicadaAt || null,
        montoAditivo: r2(ad), montoDeductivo: r2(de), montoNeto: r2(ad - de),
        impactoRubros: oc.impactoRubros || null
      };
    }
    const ivaPct = Number(m.ivaPct ?? 0.16);
    const netoAcum = aditAcum - deductAcum;
    const total = Number(contratoCIVA) || 0;
    const subtotal = total / (1 + ivaPct);
    for (const k in rub) rub[k] = r2(rub[k]);
    return {
      obraNombre: m.nombre || '', ivaPct,
      // Contrato FORMAL vigente (el que se firma y contra el que se mide el avance)
      contrato: { subtotal: r2(subtotal), iva: r2(total - subtotal), total: r2(total) },
      contratoOriginalCIVA: r2(total - netoAcum * (1 + ivaPct)),
      // Σ de precios unitarios del catálogo (puede diferir del contrato formal)
      catalogo: { originalSubtotal: r2(contratoOriginal), vigenteSubtotal: r2(catalogoVigenteSubtotal) },
      ordenesCambio: {
        count: Object.keys(aplicadas).length,
        aditivasAcum: r2(aditAcum), deductivasAcum: r2(deductAcum), netoAcum: r2(netoAcum),
        netoAcumCIVA: r2(netoAcum * (1 + ivaPct)),
        aplicadas
      },
      // Movimiento acumulado por rubro (con signo) — bitácora ajusta su presupuesto
      rubrosAcum: rub
    };
  }

  async function aplicarOC(oc) {
    const { conceptosNuevos, conceptosPatch, errores, avisos, cambios } = buildAplicacion(oc);
    if (errores.length) { toast(errores[0], 'danger'); return; }
    const t = ocTotales(oc, conceptosMap);
    const r = ocRubros(oc);
    const ivaPct = Number(m.ivaPct ?? 0.16);
    const contratoAntesCIVA = Number(m.montoContratoCIVA) || contratoVigente * (1 + ivaPct);

    // El contrato se DERIVA de la cascada OPUS con el nuevo costo directo. Así el
    // contrato, la integración y el % de avance quedan siempre en el mismo idioma.
    // Sin integración (obra vieja), se cae al cálculo por catálogo.
    // El anticipo NO se re-deriva: se congela el que ya se otorgó. Si la obra es
    // anterior a este campo, se toma una foto del contrato ANTES de esta OC.
    const anticipoCongelado = integ
      ? (integ.anticipo_monto != null
        ? Number(integ.anticipo_monto) || 0
        : computeAnticipo(computeContrato(integ), integ.anticipo_pct, integ.anticipo_base))
      : 0;
    const integracionInput = integ
      ? { ...integ, costo_directo: (Number(integ.costo_directo) || 0) + r.costoDirecto, anticipo_monto: anticipoCongelado }
      : null;
    const nuevoContrato = integracionInput
      ? computeContrato(integracionInput).monto_con_iva
      : contratoAntesCIVA + t.neto * (1 + ivaPct);

    const fmt = v => (v >= 0 ? '+' : '−') + money(Math.abs(v));
    const ok = await modal({
      title: `Aplicar OC #${oc.numero} al catálogo`, confirmLabel: 'Aplicar al catálogo',
      body: h('div', {}, [
        h('p', {}, 'Esto hace que el cambio de alcance SURTA EFECTO en toda la suite: el catálogo vigente, el contrato de la obra y lo que leen bitácora, compras y materiales.'),
        h('ul', { style: { fontSize: '13px', lineHeight: 1.7 } }, [
          cambios.agregados ? h('li', {}, `${cambios.agregados} concepto(s) nuevo(s) al catálogo`) : null,
          cambios.modificados ? h('li', {}, `${cambios.modificados} concepto(s) con cantidad modificada`) : null,
          cambios.quitados ? h('li', {}, `${cambios.quitados} concepto(s) reducido(s)${cambios.archivados ? ` — ${cambios.archivados} archivado(s)` : ''}`) : null
        ]),
        h('div', { class: 'row', style: { marginTop: '8px', gap: '18px', flexWrap: 'wrap' } }, [
          h('div', {}, [h('div', { class: 'muted', style: { fontSize: '11px' } }, 'Contrato vigente actual'), h('b', { class: 'mono' }, money(contratoAntesCIVA))]),
          h('div', {}, [h('div', { class: 'muted', style: { fontSize: '11px' } }, 'Contrato con la OC aplicada'), h('b', { class: 'mono', style: { color: 'var(--accent)' } }, money(nuevoContrato))])
        ]),
        avisos.length > 0 && h('div', { style: { marginTop: '10px' } }, [
          h('div', { class: 'tag warn' }, `⚠ ${avisos.length} concepto(s) quedarían por debajo de lo ya adjudicado a subcontratistas`),
          h('ul', { style: { fontSize: '11px', lineHeight: 1.6, color: 'var(--warn)', marginTop: '6px' } }, avisos.map(a => h('li', {}, a))),
          h('div', { class: 'muted', style: { fontSize: '11px' } }, 'Se puede aplicar, pero habrá que renegociar ese alcance con el subcontratista en app-compras.')
        ]),
        h('div', { style: { marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--border)', fontSize: '12px' } }, [
          h('div', { class: 'muted', style: { marginBottom: '4px' } }, 'Ajuste que recibirá bitácora en su presupuesto por rubro:'),
          h('div', { class: 'row', style: { gap: '14px', flexWrap: 'wrap' } }, [
            h('span', {}, ['Costo directo ', h('b', { class: 'mono' }, fmt(r.costoDirecto))]),
            h('span', {}, ['Indirectos ', h('b', { class: 'mono' }, fmt(r.indOficina + r.indCampo))]),
            h('span', {}, ['Utilidad ', h('b', { class: 'mono' }, fmt(r.utilidad))])
          ])
        ]),
        h('p', { class: 'muted', style: { fontSize: '11px', marginTop: '10px' } }, 'El contrato original queda congelado como baseline. Para deshacerlo hay que capturar una OC inversa.')
      ])
    });
    if (!ok) return;

    const aplicadaAt = Date.now();
    const ocAplicada = {
      id: oc.id, numero: oc.numero, fecha: oc.fecha, descripcion: oc.descripcion,
      montoAditivo: r2(t.aditivo), montoDeductivo: r2(t.deductivo), impactoRubros: oc.impactoRubros, aplicadaAt
    };
    const contrato = buildContratoPayload({
      ocAplicandose: ocAplicada,
      contratoCIVA: nuevoContrato,
      catalogoVigenteSubtotal: contratoVigente + t.neto
    });

    try {
      await aplicarOrdenCambio(obraId, oc.id, {
        conceptosNuevos, conceptosPatch, integracionInput, contrato,
        ocPatch: {
          estado: 'aplicada', aplicadaAt, aplicadaPor: state.user?.uid || null,
          contratoAntes: r2(contratoAntesCIVA), contratoDespues: r2(nuevoContrato)
        },
        metaPatch: { montoContratoCIVA: nuevoContrato }
      });
    } catch (err) { toast('Error al aplicar: ' + err.message, 'danger'); return; }

    // A partir de aquí la OC YA quedó aplicada. Lo que sigue son avisos a las
    // apps hermanas: si algo falla, se avisa pero no se deshace el cambio.
    try {
      const fresh = await loadObra(obraId);
      const av = computeAvanceObra(fresh);
      if (av) await setAvanceObra(obraId, av);          // el % de avance cambió de denominador
    } catch (err) { console.error('No se pudo republicar el avance', err); }

    try { await avisarContador(oc, t, r, contratoAntesCIVA, nuevoContrato); }
    catch (err) { toast('OC aplicada, pero no se pudo avisar al contador: ' + err.message, 'warn'); }

    toast('OC aplicada — catálogo, contrato y apps hermanas actualizados', 'ok');
    renderOrdenesCambio({ params });
  }

  // Deja la OC aplicada en el buzón para que el contador ajuste su presupuesto
  // por rubro. Mismo canal que usan los pagos de estimación.
  async function avisarContador(oc, t, r, antesCIVA, despuesCIVA) {
    const ivaPct = Number(m.ivaPct ?? 0.16);
    let proyectoId = null;
    try { proyectoId = (await getObraLinks())?.[obraId] || null; } catch {}
    await pushBuzonItem({
      tipo: 'orden_cambio',
      origenApp: 'estimaciones',
      obraId, obraNombre: m.nombre || '', proyectoId,
      ocId: oc.id, ocNumero: oc.numero || 0,
      descripcion: `Orden de cambio #${oc.numero} aplicada — ${oc.descripcion || 'cambio de alcance'}${proyectoId ? '' : ' — obra sin vincular a proyecto contable'}`,
      montoAditivo: r2(t.aditivo), montoDeductivo: r2(t.deductivo), montoNeto: r2(t.neto),
      iva: r2(t.neto * ivaPct), netoCIVA: r2(t.neto * (1 + ivaPct)), ivaPct,
      impactoRubros: oc.impactoRubros || null,
      contratoAntesCIVA: r2(antesCIVA), contratoDespuesCIVA: r2(despuesCIVA),
      fecha: oc.fecha || Date.now(),
      estado: 'pendiente',
      creadoPor: state.user?.uid || ''
    });
  }

  // Botones de transición de estado para una OC (solo admin).
  function stateBtns(oc) {
    if (!isAdmin) return [];
    const mk = (cls, txt, title, fn) => h('button', { class: 'btn sm ' + cls, style: { marginLeft: '6px' }, title, onClick: () => fn(oc) }, txt);
    if (oc.estado === 'borrador') return [mk('ok', '✓ Aprobar', 'Marcar como aprobada por el cliente', aprobarOC), mk('warn ghost', '✕ Rechazar', 'El cliente no la aprobó', rechazarOC)];
    if (oc.estado === 'aprobada') return [mk('primary', '✅ Aplicar', 'Aplicar al catálogo vigente', aplicarOC), mk('ghost', '↩ Borrador', 'Volver a borrador para ajustar', volverBorrador), mk('warn ghost', '✕ Rechazar', 'El cliente no la aprobó', rechazarOC)];
    if (oc.estado === 'rechazada') return [mk('ghost', '↩ Reabrir', 'Volver a borrador', volverBorrador)];
    return [];   // aplicada: sin transiciones
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
    const rubrosNode = h('div', { style: { fontSize: '12px', marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border)' } });

    function fmtDelta(v) { return (v >= 0 ? '+' : '−') + money(Math.abs(v)); }
    function recompute() {
      const t = ocTotales(work, conceptosMap);
      sumAdit.textContent = '+' + money(t.aditivo);
      sumDeduct.textContent = '−' + money(t.deductivo);
      sumNeto.textContent = (t.neto >= 0 ? '+' : '−') + money(Math.abs(t.neto));
      sumNeto.style.color = t.neto >= 0 ? 'var(--ok)' : 'var(--warn)';
      vigenteProy.textContent = money(contratoVigente + t.neto);
      // Impacto por rubro (lo que leerá bitácora para ajustar su presupuesto)
      const r = ocRubros(work);
      rubrosNode.innerHTML = '';
      rubrosNode.appendChild(h('div', { class: 'muted', style: { marginBottom: '4px' } }, 'Impacto por rubro (para bitácora):'));
      rubrosNode.appendChild(h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '14px' } }, [
        h('span', {}, ['Costo directo: ', h('b', { class: 'mono' }, fmtDelta(r.costoDirecto))]),
        h('span', {}, ['Indirectos: ', h('b', { class: 'mono' }, fmtDelta(r.indOficina + r.indCampo))]),
        r.financiamiento ? h('span', {}, ['Financiamiento: ', h('b', { class: 'mono' }, fmtDelta(r.financiamiento))]) : null,
        h('span', {}, ['Utilidad: ', h('b', { class: 'mono' }, fmtDelta(r.utilidad))]),
        h('span', {}, ['Venta: ', h('b', { class: 'mono', style: { color: 'var(--accent)' } }, fmtDelta(r.venta))])
      ]));
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
      return h('tr', {
        style: readonly ? {} : { cursor: 'pointer' },
        onClick: readonly ? null : () => editItem(idx)
      }, [
        h('td', {}, h('span', { class: 'tag ' + accionTag[0] }, accionTag[1])),
        h('td', {}, detalle),
        h('td', { class: 'num ok' }, im.aditivo ? '+' + money(im.aditivo) : ''),
        h('td', { class: 'num warn' }, im.deductivo ? '−' + money(im.deductivo) : ''),
        h('td', { style: { whiteSpace: 'nowrap' } }, !readonly && [
          h('button', { class: 'btn sm ghost', title: 'Ver / editar esta partida', onClick: (e) => { e.stopPropagation(); editItem(idx); } }, '✎'),
          h('button', { class: 'btn sm danger ghost', style: { marginLeft: '4px' }, title: 'Quitar esta partida del cambio', onClick: (e) => { e.stopPropagation(); work.items.splice(idx, 1); renderItems(); } }, '✕')
        ])
      ]);
    }

    // Abre el diálogo correcto pre-llenado para ver/editar una partida existente.
    function editItem(idx) {
      const it = work.items[idx];
      if (!it) return;
      if (it.accion === 'agregar') addAgregar(idx);
      else addSobreConcepto(it.accion, idx);
    }

    // --- diálogos para agregar/editar cada tipo de partida (editIdx = editar en sitio) ---
    async function addAgregar(editIdx) {
      const cur = (editIdx != null) ? work.items[editIdx] : null;
      const clave = h('input', { placeholder: 'Clave (opcional)', value: cur?.clave || '' });
      const desc = h('input', { placeholder: 'Descripción del concepto nuevo', value: cur?.descripcion || '' });
      const unidad = h('input', { placeholder: 'Unidad (m2, m3, pza…)', style: { width: '120px' }, value: cur?.unidad || '' });
      const cantidad = h('input', { type: 'number', step: 'any', placeholder: '0', value: cur?.cantidad ?? '' });
      // Se captura COSTO DIRECTO unitario (como en OPUS); la venta (P.U.) y el
      // desglose por rubro se derivan con la cascada del contrato.
      const cdIn = h('input', { type: 'number', step: '0.01', placeholder: '0.00', value: cur?.costoDirectoUnit ?? '' });
      const desglose = h('div', { style: { fontSize: '12px', marginTop: '4px', lineHeight: 1.6 } });
      function refreshDesglose() {
        const cd = Number(cdIn.value) || 0;
        if (!casc) { desglose.innerHTML = ''; desglose.appendChild(h('span', { class: 'warn' }, 'Sin integración OPUS en la obra: se usará el costo directo como venta (sin desglose de rubros).')); return; }
        const r = rubrosDeCD(cd);
        desglose.innerHTML = '';
        desglose.appendChild(h('div', { class: 'muted' }, [
          `Indirectos ${money(r.indOficina + r.indCampo)} · `,
          r.financiamiento ? `Financ. ${money(r.financiamiento)} · ` : '',
          `Utilidad ${money(r.utilidad)}`
        ]));
        desglose.appendChild(h('div', {}, ['P.U. de venta (derivado): ', h('b', { style: { color: 'var(--accent)' } }, money(r.venta))]));
      }
      cdIn.addEventListener('input', refreshDesglose); refreshDesglose();
      const ok = await modal({
        title: cur ? 'Editar concepto agregado' : 'Agregar concepto (aditiva)',
        body: h('div', {}, [
          h('div', { class: 'field' }, [h('label', {}, 'Descripción *'), desc]),
          h('div', { class: 'grid-2', style: { marginTop: '10px' } }, [
            h('div', { class: 'field' }, [h('label', {}, 'Clave'), clave]),
            h('div', { class: 'field' }, [h('label', {}, 'Unidad'), unidad])
          ]),
          h('div', { class: 'grid-2', style: { marginTop: '10px' } }, [
            h('div', { class: 'field' }, [h('label', {}, 'Cantidad'), cantidad]),
            h('div', { class: 'field' }, [h('label', {}, 'Costo directo unitario'), cdIn])
          ]),
          desglose
        ]),
        confirmLabel: cur ? 'Guardar' : 'Agregar', onConfirm: () => {
          if (!desc.value.trim()) { toast('La descripción es requerida', 'warn'); return false; }
          return true;
        }
      });
      if (!ok) return;
      const cdUnit = Number(cdIn.value) || 0;
      const item = { accion: 'agregar', clave: clave.value.trim(), descripcion: desc.value.trim(), unidad: unidad.value.trim(), cantidad: Number(cantidad.value) || 0, costoDirectoUnit: cdUnit, pu: rubrosDeCD(cdUnit).venta };
      if (editIdx != null) work.items[editIdx] = item; else work.items.push(item);
      renderItems();
    }

    async function addSobreConcepto(accion, editIdx) {
      if (!puConceptos.length) { toast('No hay conceptos en el catálogo', 'warn'); return; }
      const cur = (editIdx != null) ? work.items[editIdx] : null;
      const sel = h('select', { style: { width: '100%' } }, puConceptos.map(c => h('option', { value: c.id }, `${c.clave || ''} — ${(c.descripcion || '').slice(0, 70)}`)));
      if (cur?.conceptoId) sel.value = cur.conceptoId;
      // modificar → nueva cantidad absoluta; quitar → cantidad A QUITAR (default: la completa)
      const cantIn = h('input', { type: 'number', step: 'any', placeholder: accion === 'modificar' ? 'Nueva cantidad' : 'Cantidad a quitar', value: cur ? (accion === 'modificar' ? (cur.despues ?? '') : (cur.cantidad ?? '')) : '' });
      const info = h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } });
      const impacto = h('div', { style: { fontSize: '12px', marginTop: '6px' } });
      function refreshInfo(resetCant) {
        const c = conceptosMap[sel.value];
        if (!c) { info.textContent = ''; impacto.textContent = ''; return; }
        const ejec = Number(ejecutadoPorConcepto[sel.value]) || 0, u = c.unidad || '';
        info.innerHTML = '';
        info.appendChild(h('span', {}, `Contratado: ${num(c.cantidad, 2)} ${u} × ${money(c.precio_unitario)} = ${money(c.total)}`));
        info.appendChild(h('span', { style: { marginLeft: '10px' } }, ['· Ejecutado a la fecha: ', h('b', { class: ejec > 0 ? 'accent' : 'muted' }, `${num(ejec, 2)} ${u}`)]));
        if (accion === 'quitar' && resetCant) cantIn.value = Number(c.cantidad) || 0;   // default: quitar todo
        refreshImpacto();
      }
      function refreshImpacto() {
        const c = conceptosMap[sel.value]; if (!c) { impacto.textContent = ''; return; }
        const pu = Number(c.precio_unitario) || 0, actual = Number(c.cantidad) || 0;
        const ejec = Number(ejecutadoPorConcepto[sel.value]) || 0, u = c.unidad || '';
        const v = Number(cantIn.value);
        impacto.innerHTML = '';
        if (isNaN(v)) return;
        if (accion === 'quitar') {
          const maxQuitar = Math.max(0, actual - ejec);   // no bajar de lo ejecutado
          impacto.appendChild(h('span', { class: 'warn' }, `Deductivo: −${money(v * pu)}`));
          if (v > actual) impacto.appendChild(h('span', { class: 'warn', style: { marginLeft: '8px' } }, `⚠ excede lo contratado (${num(actual, 2)})`));
          else if (v > maxQuitar) impacto.appendChild(h('span', { class: 'warn', style: { marginLeft: '8px' } }, `⚠ dejaría por debajo de lo ejecutado (${num(ejec, 2)}); máx a quitar ${num(maxQuitar, 2)}`));
          else impacto.appendChild(h('span', { class: 'muted', style: { marginLeft: '8px' } }, `queda ${num(actual - v, 2)} ${u}`));
        } else {
          const delta = (v - actual) * pu;
          impacto.appendChild(delta >= 0
            ? h('span', { class: 'ok' }, `Aditivo: +${money(delta)}`)
            : h('span', { class: 'warn' }, `Deductivo: −${money(-delta)}`));
          if (v < ejec) impacto.appendChild(h('span', { class: 'warn', style: { marginLeft: '8px' } }, `⚠ por debajo de lo ejecutado (${num(ejec, 2)})`));
        }
      }
      sel.addEventListener('change', () => refreshInfo(true));
      cantIn.addEventListener('input', refreshImpacto);
      refreshInfo(cur ? false : true);   // al editar NO reinicies la cantidad capturada
      const ok = await modal({
        title: (cur ? 'Editar — ' : '') + (accion === 'modificar' ? 'Modificar cantidad (aditiva/deductiva)' : 'Quitar cantidad (deductiva)'),
        body: h('div', {}, [
          h('div', { class: 'field' }, [h('label', {}, 'Concepto del catálogo'), sel]),
          info,
          h('div', { class: 'field', style: { marginTop: '10px' } }, [h('label', {}, accion === 'modificar' ? 'Nueva cantidad (total)' : 'Cantidad a quitar'), cantIn]),
          impacto,
          accion === 'quitar' && h('p', { class: 'muted', style: { fontSize: '11px', marginTop: '8px' } }, 'Deja la cantidad completa para quitar el concepto entero, o pon menos para quitar solo una parte. No se puede quitar por debajo de lo ya ejecutado.')
        ]),
        confirmLabel: cur ? 'Guardar' : 'Agregar cambio',
        onConfirm: () => {
          if (cantIn.value === '' || isNaN(Number(cantIn.value))) { toast('Captura la cantidad', 'warn'); return false; }
          const c = conceptosMap[sel.value]; const v = Number(cantIn.value);
          const actual = Number(c?.cantidad) || 0, ejec = Number(ejecutadoPorConcepto[sel.value]) || 0;
          if (accion === 'quitar') {
            if (v > actual) { toast('No puedes quitar más de lo contratado', 'warn'); return false; }
            if (v > actual - ejec) { toast(`Dejaría por debajo de lo ejecutado (${num(ejec, 2)}). Máx a quitar: ${num(actual - ejec, 2)}`, 'warn'); return false; }
          } else if (v < ejec) {
            toast(`La nueva cantidad no puede ser menor a lo ejecutado (${num(ejec, 2)})`, 'warn'); return false;
          }
          return true;
        }
      });
      if (!ok) return;
      const item = accion === 'modificar'
        ? { accion, conceptoId: sel.value, despues: Number(cantIn.value) || 0 }
        : { accion, conceptoId: sel.value, cantidad: Number(cantIn.value) || 0 };
      if (editIdx != null) work.items[editIdx] = item; else work.items.push(item);
      renderItems();
    }

    const editor = h('div', {}, [
      h('div', { class: 'row' }, [
        h('h1', { style: { margin: 0 } }, existente ? `OC #${work.numero || ''}` : 'Nueva orden de cambio'),
        readonly && h('span', { class: 'tag ok' }, ESTADO_TAG[existente.estado]?.[1] || ''),
        h('div', { style: { flex: 1 } }),
        readonly && existente.estado === 'aprobada' && isAdmin && h('button', { class: 'btn primary', title: 'Aplicar esta OC al catálogo vigente', onClick: () => aplicarOC(existente) }, '✅ Aplicar al catálogo'),
        h('button', { class: 'btn', title: 'Resumen ejecutivo de la OC (PDF) para presentar al cliente y firmar', onClick: generarPdf }, '⤓ PDF para el cliente'),
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
          !readonly && h('button', { class: 'btn sm ok', onClick: () => addAgregar() }, '＋ Agregar concepto'),
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
        rubrosNode,
        h('p', { class: 'muted', style: { fontSize: '11px', marginTop: '8px' } }, 'Cotización: así quedaría el contrato SI se aplica esta OC. En borrador no se toca nada. El desglose por rubro es lo que bitácora usará para ajustar su presupuesto al aplicar.')
      ]),
      !readonly && h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, [
        h('button', { class: 'btn ghost', onClick: () => drawLista() }, 'Cancelar'),
        h('button', { class: 'btn primary', onClick: guardar }, '💾 Guardar borrador')
      ])
    ]);

    renderShell(crumbs(obraId, m.nombre), editor);
    renderItems();

    function generarPdf() {
      if (!work.items.length) { toast('Agrega al menos una partida al cambio', 'warn'); return; }
      const t = ocTotales(work, conceptosMap);
      try {
        exportOrdenCambioPdf(obra, { numero: work.numero, descripcion: work.descripcion, fecha: work.fecha, tipo: t.tipo, items: work.items, montoAditivo: t.aditivo, montoDeductivo: t.deductivo, montoNeto: t.neto });
      } catch (err) { toast('Error al generar PDF: ' + err.message, 'danger'); }
    }

    async function guardar() {
      const t = ocTotales(work, conceptosMap);
      const r = ocRubros(work);
      const r2 = {};
      for (const k in r) r2[k] = Math.round((r[k] || 0) * 100) / 100;
      const payload = {
        id: work.id, descripcion: work.descripcion || '', fecha: work.fecha,
        estado: 'borrador', tipo: t.tipo,
        items: work.items,
        montoAditivo: Math.round(t.aditivo * 100) / 100,
        montoDeductivo: Math.round(t.deductivo * 100) / 100,
        montoNeto: Math.round(t.neto * 100) / 100,
        // Desglose por rubro (con signo) para que bitácora ajuste su presupuesto al aplicar.
        impactoRubros: r2
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
