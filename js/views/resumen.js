// RESUMEN: vista por estimación con estado de cuenta y exports.
// Antes de exportar PDF/XLSX abre un diálogo de configuración (filtros, modo,
// amortización, notas).

import { h, modal, toast, buzonBadge } from '../util/dom.js';
import { renderShell } from './shell.js';
import { rread, loadObra, setPagoCliente, setEstimacionIvaMonto, updateObraMeta, getObraLinks, listBuzonItems, pushBuzonItem, updateBuzonItem } from '../services/db.js';
import { state } from '../state/store.js';
import { money, num, dateMx, pct } from '../util/format.js';
import { buildResumenData, exportResumenPdf, exportResumenXlsx, exportEstimacionJson } from '../services/export.js';
import { initDrive, isConfigured as driveConfigured, isSignedIn as driveSignedIn, signIn as driveSignIn } from '../services/drive.js';

export async function renderResumen({ params }) {
  const obraId = params.id;
  renderShell(crumbs(obraId), h('div', { class: 'empty' }, 'Cargando RESUMEN…'));

  const obra = await loadObra(obraId);
  if (!obra) { renderShell(crumbs(obraId), h('div', { class: 'empty' }, 'Obra no encontrada.')); return; }
  const m = obra.meta || {};
  const ests = obra.estimaciones || {};
  const estsArr = Object.entries(ests).map(([id, e]) => ({ id, ...e })).sort((a, b) => (a.numero || 0) - (b.numero || 0));

  if (!estsArr.length) {
    renderShell(crumbs(obraId, m.nombre), h('div', {}, [
      h('h1', {}, 'RESUMEN'),
      h('div', { class: 'empty' }, [
        h('div', { class: 'ico' }, '📋'),
        'No hay estimaciones todavía. Crea la primera para generar un RESUMEN.',
        h('div', { style: { marginTop: '12px' } }, h('a', { href: `#/obras/${obraId}/estimaciones` }, 'Ir a Estimaciones'))
      ])
    ]));
    return;
  }

  const queryEst = new URLSearchParams(location.hash.split('?')[1] || '').get('est');
  let activeEstId = queryEst && ests[queryEst] ? queryEst : estsArr[estsArr.length - 1].id;
  await draw(obraId, obra, activeEstId);
}

async function draw(obraId, obra, estId) {
  // Buzón state para esta estimación (para badges y bloqueo de edición).
  // Si hay varios items históricos (p.ej. uno rechazado + uno re-enviado),
  // el ACTIVO (pendiente/aprobado/huerfano) prevalece sobre el rechazado.
  let buzonItems = {};
  try { buzonItems = await listBuzonItems(); } catch {}
  const matching = Object.values(buzonItems).filter(it =>
    it?.tipo === 'pago_cliente' && it?.obraId === obraId && it?.estimId === estId
  );
  const activo = matching.find(it => it.estado !== 'rechazado' && it.estado !== 'cerrado');
  const buzonItem = activo || matching.sort((a, b) => (b.creadoAt || 0) - (a.creadoAt || 0))[0] || null;
  const buzonEstado = buzonItem?.estado || null;
  const m = obra.meta || {};
  const ests = obra.estimaciones || {};
  const estsArr = Object.entries(ests).map(([id, e]) => ({ id, ...e })).sort((a, b) => (a.numero || 0) - (b.numero || 0));
  const data = buildResumenData(obra, estId);
  const { est, ivaPct, anticipoPct, rows, subtotalEsta, ivaEsta, ivaAcum, ivaManual, importeEsta, avPond, importeAcumEjec, importeAcumEjecCIVA, subtotalPagado, ivaPagado, importePagado, diferencia, diferenciaPct, anticipoMontoBase, amortizacionEsta, amortizacionAcum, saldoAnticipoPorAmortizar, netoEsta, netoAcum, anticipoRecibido, totalRecibidoCliente, saldoCaja, excesoAnticipo, abonosCliente, subtotalAbono, sugeridoPagoJusto, amortizacionAcumHasta, netoAcumHasta, pagosPrevios } = data;

  const estSel = h('select', { onchange: e => { draw(obraId, obra, e.target.value); } },
    estsArr.map(es => h('option', { value: es.id, selected: es.id === estId }, `Estimación #${es.numero}`)));

  const head = h('div', { class: 'row' }, [
    h('h1', { style: { margin: 0 } }, 'RESUMEN'),
    estSel,
    h('span', {}, est.estado === 'cerrada' ? h('span', { class: 'tag ok' }, '🔒 Cerrada') : h('span', { class: 'tag warn' }, '✎ Borrador')),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn ghost', onClick: () => exportEstimacionJson(obra, estId), title: 'Exportar JSON para app contable SOGRUB' }, '{ } JSON'),
    h('button', { class: 'btn', onClick: () => printConfigDialog(obra, estId, 'xlsx') }, '⬇ XLSX'),
    h('button', { class: 'btn primary', onClick: () => printConfigDialog(obra, estId, 'pdf') }, '⬇ PDF'),
    h('button', { class: 'btn ghost', onClick: () => navigate(`/obras/${obraId}/estimaciones/${estId}/galeria`), title: 'Ver fotos y croquis del período' }, '📸 Galería')
  ]);

  const editable = est.estado === 'borrador' || state.user.role === 'admin';
  const bloqueado = buzonEstado === 'aprobado' || buzonEstado === 'cobrado' || buzonEstado === 'pagado';
  const editPagosBtn = editable
    ? h('button', { class: 'btn sm ghost', onClick: async () => { const ok = await editPagoDialog(obraId, estId, est, ivaPct, { subtotalEsta, ivaEsta, sugeridoPagoJusto, netoAcumHasta, pagosPrevios, excesoAnticipo }); if (ok) renderResumen({ params: { id: obraId } }); } },
      bloqueado ? '🔒 Ver pago' : '💵 Registrar / enviar pago')
    : null;
  const badge = buzonBadge(buzonEstado, buzonItem);

  // Bloque de anticipo (solo si > 0)
  const anticipoCard = anticipoPct > 0 ? h('div', { class: 'card' }, [
    h('h3', {}, `Anticipo (${pct(anticipoPct)})`),
    h('div', { class: 'grid-4' }, [
      kvBig('Anticipo otorgado', money(anticipoMontoBase), ''),
      kvBig('Amortización (esta)', money(amortizacionEsta), 'warn'),
      kvBig('Amortización acum.', money(amortizacionAcum), 'warn'),
      kvBig('Saldo por amortizar', money(saldoAnticipoPorAmortizar), saldoAnticipoPorAmortizar > 0 ? '' : 'ok')
    ])
  ]) : null;

  const ecBodyRows = [
    h('tr', {}, [
      h('td', {}, [h('b', {}, `Estimación #${est.numero}`), ' ', h('span', { class: 'muted', style: { fontSize: '12px' } }, '(esta)')]),
      h('td', { class: 'num' }, money(subtotalEsta)),
      h('td', { class: 'num muted' }, money(ivaEsta)),
      h('td', { class: 'num' }, h('b', {}, money(importeEsta)))
    ]),
    h('tr', { style: { background: 'var(--bg-2)' } }, [
      h('td', {}, 'Acumulado ejecutado (todas)'),
      h('td', { class: 'num' }, money(importeAcumEjec)),
      h('td', { class: 'num muted' }, money(ivaAcum)),
      h('td', { class: 'num' }, h('b', {}, money(importeAcumEjecCIVA)))
    ])
  ];
  if (anticipoPct > 0) {
    ecBodyRows.push(h('tr', { style: { color: 'var(--warn)' } }, [
      h('td', {}, `Amortización anticipo (esta)`),
      h('td', { class: 'num' }, '—'),
      h('td', { class: 'num' }, '—'),
      h('td', { class: 'num' }, '-' + money(amortizacionEsta))
    ]));
    ecBodyRows.push(h('tr', { style: { fontWeight: 600 } }, [
      h('td', {}, 'Neto a cobrar (esta)'),
      h('td', { class: 'num' }, '—'),
      h('td', { class: 'num' }, '—'),
      h('td', { class: 'num' }, money(netoEsta))
    ]));
    ecBodyRows.push(h('tr', { style: { fontWeight: 600 } }, [
      h('td', {}, 'Neto a cobrar (acumulado)'),
      h('td', { class: 'num' }, '—'),
      h('td', { class: 'num' }, '—'),
      h('td', { class: 'num' }, money(netoAcum))
    ]));
  }
  ecBodyRows.push(h('tr', {}, [
    h('td', {}, ['Pagos cliente (acumulado) ', editPagosBtn, badge,
      excesoAnticipo ? h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '2px' } },
        excesoAnticipo > 0
          ? `incluye ${money(excesoAnticipo)} de anticipo excedente (a favor)`
          : `descuenta ${money(-excesoAnticipo)} de anticipo faltante`) : null
    ]),
    h('td', { class: 'num' }, money(subtotalAbono)),
    h('td', { class: 'num muted' }, money(ivaPagado)),
    h('td', { class: 'num' }, h('b', {}, money(abonosCliente)))
  ]));

  const editIvaBtn = editable
    ? h('button', { class: 'btn sm ghost', onClick: async () => { const ok = await editIvaDialog(obraId, estId, est); if (ok) renderResumen({ params: { id: obraId } }); } }, '✎ IVA')
    : null;
  // Trazabilidad del IVA: si ESTA estimación quedó en 16% auto pero OTRA se capturó
  // manual, avisa (fácil olvidar ajustarla y descuadrar el IVA acumulado).
  const otrasManual = Object.entries(ests).filter(([id, e]) => id !== estId && e.ivaMonto != null && e.ivaMonto !== '').map(([, e]) => e.numero);
  const avisoIvaAuto = (!ivaManual && otrasManual.length)
    ? h('span', { class: 'tag warn', title: `La(s) estimación(es) #${otrasManual.join(', #')} tienen IVA manual, y esta está en 16% automático. Ajústala con ✎ IVA para no reportar IVA de más.` }, `⚠ IVA en 16% (la #${otrasManual.join('/#')} fue manual)`)
    : null;
  const estadoCuenta = h('div', { class: 'card' }, [
    h('div', { class: 'row', style: { marginBottom: '10px' } }, [
      h('h3', { style: { margin: 0 } }, 'Estado de cuenta'),
      h('div', { style: { flex: 1 } }),
      avisoIvaAuto,
      ivaManual
        ? h('span', { class: 'tag ok', title: 'El IVA de esta estimación se capturó como monto manual (no 16% sobre todo)' }, `IVA manual: ${money(ivaEsta)}`)
        : h('span', { class: 'tag muted', title: 'IVA automático (16% del subtotal). Edítalo para poner solo el IVA de materiales gravados.' }, `IVA 16% auto`),
      editIvaBtn
    ]),
    h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [h('th', {}, 'Documento'), h('th', { class: 'num' }, 'Subtotal'), h('th', { class: 'num' }, 'IVA'), h('th', { class: 'num' }, 'Importe')])]),
      h('tbody', {}, ecBodyRows)
    ]),
    h('div', { class: 'grid-2', style: { marginTop: '16px', paddingTop: '14px', borderTop: '1px solid var(--border)' } }, [
      kvBig('Diferencia financiera', money(diferencia), diferencia > 0 ? 'warn' : (diferencia < 0 ? 'danger' : 'ok')),
      kvBig('Diferencia %', pct(diferenciaPct), diferencia > 0 ? 'warn' : (diferencia < 0 ? 'danger' : 'ok'))
    ]),
    h('div', { style: { marginTop: '12px' } }, [
      kvBig('Avance ponderado de obra', pct(avPond), '')
    ])
  ]);

  const tbl = h('table', { class: 'tbl' }, [
    h('thead', {}, [h('tr', {}, [
      h('th', {}, 'Clave'),
      h('th', {}, 'Descripción'),
      h('th', {}, 'U.'),
      h('th', { class: 'num' }, 'Cantidad'),
      h('th', { class: 'num' }, 'P.U.'),
      h('th', { class: 'num' }, 'Total'),
      h('th', { class: 'num' }, 'Ejec. esta'),
      h('th', { class: 'num' }, '% Av.'),
      h('th', { class: 'num' }, '$ Por cobrar'),
      h('th', { class: 'num' }, '$ Por ejecutar')
    ])]),
    h('tbody', {}, rows.map(r => {
      const overrun = r.c.cantidad && r.totalAcum > r.c.cantidad;
      return h('tr', { class: overrun ? 'row-overrun' : '' }, [
        h('td', { class: 'mono muted' }, r.c.clave || ''),
        h('td', {}, h('div', { class: 'desc' }, r.c.descripcion || '')),
        h('td', { class: 'muted' }, r.c.unidad || ''),
        h('td', { class: 'num' }, num(r.c.cantidad, 2)),
        h('td', { class: 'num muted' }, money(r.c.precio_unitario)),
        h('td', { class: 'num' }, money(r.c.total)),
        h('td', { class: 'num' }, r.enEsta ? num(r.enEsta, 2) : h('span', { class: 'muted' }, '—')),
        h('td', { class: 'num' + (overrun ? ' warn' : '') }, pct(r.pctAv)),
        h('td', { class: 'num' }, money(r.aCobrarEsta)),
        h('td', { class: 'num' + (r.restante < 0 ? ' warn' : '') }, money(r.restante))
      ]);
    }))
  ]);

  const tablaCard = h('div', { class: 'card', style: { padding: 0, overflow: 'hidden' } }, tbl);

  const sub = h('div', { class: 'card' }, [
    h('div', { class: 'grid-3' }, [
      kv('Período', `${est.periodoIni ? dateMx(est.periodoIni) : '—'} – ${est.periodoFin ? dateMx(est.periodoFin) : '—'}`),
      kv('Fecha de corte', est.fechaCorte ? dateMx(est.fechaCorte) : '—'),
      kv('IVA / Anticipo', `${pct(ivaPct)} · ${pct(anticipoPct)}`)
    ])
  ]);

  // Caja del cliente: efectivo real recibido vs lo facturado. El anticipo real
  // (que pudo ser mayor al contractual) se captura aquí y forma parte del saldo.
  const cajaCard = h('div', { class: 'card' }, [
    h('div', { class: 'row', style: { marginBottom: '10px' } }, [
      h('h3', { style: { margin: 0 } }, 'Caja del cliente'),
      h('div', { style: { flex: 1 } }),
      editable && h('button', { class: 'btn sm ghost', onClick: async () => { const ok = await editAnticipoRecibidoDialog(obraId, m); if (ok) renderResumen({ params: { id: obraId } }); } }, '✎ Anticipo recibido')
    ]),
    h('div', { class: 'grid-4' }, [
      kvBig('Anticipo recibido', money(anticipoRecibido), ''),
      kvBig('Pagos recibidos', money(importePagado), ''),
      kvBig('Total recibido', money(totalRecibidoCliente), ''),
      kvBig('Ejecutado (c/IVA)', money(importeAcumEjecCIVA), '')
    ]),
    h('div', { style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--border)' } }, [
      kvBig(saldoCaja >= 0 ? 'Saldo a favor del cliente' : 'Saldo por cobrar al cliente', money(Math.abs(saldoCaja)), saldoCaja >= 0 ? 'ok' : 'warn')
    ]),
    h('p', { class: 'muted', style: { fontSize: '11px', marginTop: '8px' } }, 'Total recibido − ejecutado a la fecha. Positivo = el cliente ha entregado de más (p.ej. anticipo por encima del contractual); negativo = falta cobrarle.')
  ]);

  const blocks = [head, sub];
  if (anticipoCard) blocks.push(anticipoCard);
  blocks.push(estadoCuenta);
  blocks.push(cajaCard);
  blocks.push(h('h2', {}, 'Conceptos'));
  blocks.push(tablaCard);

  renderShell(crumbs(obraId, m.nombre), h('div', {}, blocks));
}

function kv(label, val) { return h('div', { class: 'field' }, [h('label', {}, label), h('div', {}, val)]); }
function kvBig(label, val, kind) {
  const color = kind === 'warn' ? 'var(--warn)' : (kind === 'danger' ? 'var(--danger)' : (kind === 'ok' ? 'var(--ok)' : 'var(--accent)'));
  return h('div', { class: 'field' }, [
    h('label', {}, label),
    h('div', { class: 'mono', style: { fontSize: '20px', fontWeight: 600, color } }, val)
  ]);
}

// IVA manual (monto) de una estimación. Vacío/automático = 16% del subtotal.
async function editIvaDialog(obraId, estId, est) {
  const cur = est.ivaMonto;
  const esManual = cur != null && cur !== '';
  const rAuto = h('input', { type: 'radio', name: 'iva-modo', checked: !esManual });
  const rManual = h('input', { type: 'radio', name: 'iva-modo', checked: esManual });
  const montoIn = h('input', { type: 'number', step: '0.01', value: esManual ? cur : '', placeholder: '0.00', style: { marginLeft: '8px', width: '160px' } });
  montoIn.addEventListener('focus', () => { rManual.checked = true; });
  return await modal({
    title: `IVA — Estimación #${est.numero}`,
    body: h('div', {}, [
      h('p', { class: 'muted', style: { fontSize: '12px', marginTop: 0 } }, 'Usa monto manual cuando solo algunos materiales causan IVA (no el 16% sobre todo). El cálculo detallado será otro módulo; aquí lo ajustas al monto.'),
      h('label', { class: 'row', style: { padding: '4px 0' } }, [rAuto, h('span', {}, `Automático — 16% del subtotal`)]),
      h('label', { class: 'row', style: { padding: '4px 0' } }, [rManual, h('span', {}, 'Monto manual:'), montoIn])
    ]),
    confirmLabel: 'Guardar',
    onConfirm: async () => {
      try {
        await setEstimacionIvaMonto(obraId, estId, rManual.checked ? (Number(montoIn.value) || 0) : null);
        toast('IVA actualizado', 'ok');
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

// Anticipo REAL recibido del cliente (puede diferir del contractual).
async function editAnticipoRecibidoDialog(obraId, m) {
  const inp = h('input', { type: 'number', step: '0.01', value: m.anticipoRecibido ?? '', placeholder: '0.00' });
  return await modal({
    title: 'Anticipo recibido (real)',
    body: h('div', {}, [
      h('p', { class: 'muted', style: { fontSize: '12px', marginTop: 0 } }, 'El monto de anticipo que el cliente realmente depositó. Alimenta la caja; la amortización sigue el anticipo contractual, y el excedente aparece como saldo a favor.'),
      h('div', { class: 'field' }, [h('label', {}, 'Monto recibido'), inp])
    ]),
    confirmLabel: 'Guardar',
    onConfirm: async () => {
      try {
        await updateObraMeta(obraId, { anticipoRecibido: Number(inp.value) || 0 });
        toast('Anticipo recibido actualizado', 'ok');
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'RESUMEN' }
  ];
}

async function editPagoDialog(obraId, estId, est, ivaPct, recon = {}) {
  const reconSub = Number(recon.subtotalEsta) || 0;
  const reconIva = Number(recon.ivaEsta) || 0;
  // Si el pago ya fue aprobado por el contador en bitácora, NO se puede editar
  // desde estimaciones (evita inconsistencia con el movimiento contable creado).
  // Para correcciones reales, el contador edita en bitácora o rechaza el buzón.
  const items = await listBuzonItems();
  // Buscar el item ACTIVO (no rechazado). Solo bloqueamos si está aprobado.
  const matchingPC = Object.entries(items).filter(([_, it]) =>
    it?.tipo === 'pago_cliente' && it?.obraId === obraId && it?.estimId === estId
  );
  const aprobado = matchingPC.find(([_, it]) => it.estado === 'aprobado');

  if (aprobado) {
    const [, it] = aprobado;
    const fechaApr = it.aprobadoAt ? new Date(it.aprobadoAt).toLocaleString('es-MX') : 'fecha desconocida';
    await modal({
      title: `Pago — Estimación #${est.numero} (aprobado)`,
      body: h('div', {}, [
        h('div', { class: 'card', style: { background: 'rgba(93,211,158,0.08)', borderColor: 'var(--ok)', padding: '12px', marginTop: 0 } }, [
          h('div', { class: 'tag ok', style: { marginBottom: '8px' } }, '🔒 Aprobado por el contador'),
          h('div', { style: { fontSize: '13px', marginBottom: '8px' } }, `Aprobado el ${fechaApr}.`),
          h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Para hacer cualquier cambio en este pago, debe gestionarse del lado de la app contadora (SOGRUB Bitácora). Desde aquí no se puede editar para evitar que los datos queden desincronizados con el movimiento ya registrado.')
        ]),
        h('div', { class: 'grid-2', style: { marginTop: '14px' } }, [
          h('div', { class: 'field' }, [h('label', {}, 'Subtotal'), h('div', { class: 'mono' }, money(it.monto?.subtotal || 0))]),
          h('div', { class: 'field' }, [h('label', {}, 'IVA'), h('div', { class: 'mono' }, money(it.monto?.iva || 0))])
        ]),
        h('div', { class: 'grid-2', style: { marginTop: '8px' } }, [
          h('div', { class: 'field' }, [h('label', {}, 'Importe'), h('div', { class: 'mono', style: { color: 'var(--accent)', fontWeight: 600 } }, money(it.monto?.importe || 0))]),
          h('div', { class: 'field' }, [h('label', {}, 'Fecha del pago'), h('div', {}, it.fecha ? dateMx(it.fecha) : '—')])
        ]),
        it.metodoPago && h('div', { class: 'field', style: { marginTop: '8px' } }, [
          h('label', {}, 'Método de pago'),
          h('div', {}, it.metodoPago === 'efectivo' ? '💵 Efectivo' : '🏦 Transferencia')
        ]),
        it.movId && h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '12px' } }, [
          'ID del movimiento contable: ', h('code', {}, it.movId)
        ])
      ]),
      confirmLabel: 'Cerrar', cancelLabel: '',
      onConfirm: () => true
    });
    return false;
  }

  // Subtotal + IVA = lo que se FACTURA (fiscal). El NETO a cobrar es la diferencia
  // financiera al corte de ESTA estimación: neto amortizado acumulado hasta esta,
  // menos pagos previos y el saldo a favor por anticipo excedente. Eso es lo que el
  // cliente transfiere; el importe bruto NO, porque no está amortizado.
  const reconBruto = reconSub + reconIva;
  const ivaEsManual = est.ivaMonto != null && est.ivaMonto !== '';
  const netoSugerido = Number.isFinite(Number(recon.sugeridoPagoJusto)) ? Number(recon.sugeridoPagoJusto) : reconBruto;
  const netoHasta = Number(recon.netoAcumHasta) || 0;
  const pagosPrev = Number(recon.pagosPrevios) || 0;
  const exceso = Number(recon.excesoAnticipo) || 0;

  // Estado inicial: si ya había un pago cuyo importe difiere del neto sugerido,
  // arrancamos en "otro monto"; si no, en "justo".
  const prev = est.pagoCliente || null;
  const difiere = prev && Math.abs((Number(prev.importe) || 0) - netoSugerido) > 0.01;
  const startJusto = !prev || !difiere;

  const importeIn = h('input', { type: 'number', step: '0.01',
    value: (startJusto ? netoSugerido : (Number(prev.importe) || netoSugerido)).toFixed(2) });
  const fechaIn = h('input', { type: 'date',
    value: prev?.fecha ? new Date(prev.fecha).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10) });

  // ¿Pagó el neto justo, o un monto distinto?
  const rJusto = h('input', { type: 'radio', name: 'pago-modo', checked: startJusto });
  const rOtro  = h('input', { type: 'radio', name: 'pago-modo', checked: !startJusto });
  function setModo(justo) {
    importeIn.disabled = justo;
    importeIn.style.opacity = justo ? '0.7' : '1';
    if (justo) importeIn.value = netoSugerido.toFixed(2);
  }
  rJusto.addEventListener('change', () => setModo(true));
  rOtro.addEventListener('change', () => setModo(false));

  // Desglose de cómo se forma el neto sugerido (para cerrar números).
  const desgloseRows = [
    ['Neto a cobrar acumulado (hasta esta estim.)', money(netoHasta)]
  ];
  if (pagosPrev) desgloseRows.push(['− Pagos de estimaciones previas', '-' + money(pagosPrev)]);
  if (exceso)    desgloseRows.push([exceso > 0 ? '− Saldo a favor (anticipo excedente)' : '+ Anticipo faltante', (exceso > 0 ? '-' : '+') + money(Math.abs(exceso))]);
  const desglose = h('div', { style: { marginTop: '8px', fontSize: '12px' } }, [
    ...desgloseRows.map(([k, v]) => h('div', { class: 'row', style: { justifyContent: 'space-between', color: 'var(--muted)' } }, [h('span', {}, k), h('span', { class: 'mono' }, v)])),
    h('div', { class: 'row', style: { justifyContent: 'space-between', fontWeight: 600, borderTop: '1px solid var(--border)', marginTop: '4px', paddingTop: '4px' } }, [
      h('span', {}, 'Neto a cobrar de esta estimación'), h('span', { class: 'mono', style: { color: 'var(--accent)' } }, money(netoSugerido))
    ])
  ]);

  // Método de pago (Efectivo / Transferencia). Default: transferencia.
  const prevMetodo = prev?.metodoPago || 'transferencia';
  const mTransfer = h('input', { type: 'radio', name: 'metodo-pago', checked: prevMetodo !== 'efectivo' });
  const mEfectivo = h('input', { type: 'radio', name: 'metodo-pago', checked: prevMetodo === 'efectivo' });

  const body = h('div', {}, [
    h('p', { class: 'muted', style: { marginTop: 0, fontSize: '12px' } }, [
      `Esto se ENVÍA AL CONTADOR (bitácora fiscal) y se registra como abono del cliente en el proyecto. `,
      h('b', {}, ivaEsManual ? `El IVA es el manual de la estimación: ${money(reconIva)}.` : `IVA ${pct(ivaPct)}.`),
      ' Debe coincidir con el IVA que se le cobra al cliente.'
    ]),

    // Referencia fiscal de la estimación (lo facturado).
    h('div', { class: 'grid-2', style: { margin: '4px 0 6px' } }, [
      h('div', { class: 'field' }, [h('label', {}, 'Subtotal (facturado)'), h('div', { class: 'mono' }, money(reconSub))]),
      h('div', { class: 'field' }, [h('label', {}, ivaEsManual ? 'IVA (manual)' : 'IVA'), h('div', { class: 'mono' }, money(reconIva))])
    ]),
    desglose,

    h('h3', { style: { margin: '14px 0 6px', fontSize: '14px' } }, '¿Cuánto pagó el cliente?'),
    h('label', { class: 'row', style: { padding: '4px 0', cursor: 'pointer' } }, [
      rJusto, h('span', {}, ['Justo lo que corresponde — ', h('b', {}, money(netoSugerido)),
        h('span', { class: 'muted' }, ' (neto ya amortizado)')])
    ]),
    h('label', { class: 'row', style: { padding: '4px 0', cursor: 'pointer' } }, [
      rOtro, h('span', {}, 'Pagó otro monto (capturar abajo)')
    ]),
    h('div', { class: 'grid-2', style: { marginTop: '8px' } }, [
      h('div', { class: 'field' }, [h('label', {}, 'Neto pagado'), importeIn]),
      h('div', { class: 'field' }, [h('label', {}, 'Fecha del pago'), fechaIn])
    ]),

    h('h3', { style: { margin: '14px 0 6px', fontSize: '14px' } }, 'Método de pago'),
    h('label', { class: 'row', style: { padding: '4px 0', cursor: 'pointer' } }, [mTransfer, h('span', {}, '🏦 Transferencia')]),
    h('label', { class: 'row', style: { padding: '4px 0', cursor: 'pointer' } }, [mEfectivo, h('span', {}, '💵 Efectivo')])
  ]);

  setModo(startJusto);

  return await modal({
    title: `Pago cliente — Estimación #${est.numero}`,
    body, confirmLabel: 'Guardar y enviar al contador',
    onConfirm: async () => {
      try {
        // Abono NETO: el importe es lo realmente cobrado; el IVA es el de la
        // estimación (MANUAL si se capturó, si no 16%) y NO se recalcula como % del
        // importe; el subtotal es el resto para que subtotal + IVA = importe.
        const importeNeto = Number(importeIn.value) || 0;
        const pago = {
          subtotal: importeNeto - reconIva,
          iva: reconIva,
          ivaManual: ivaEsManual,
          importe: importeNeto,
          fecha: fechaIn.value ? new Date(fechaIn.value).getTime() : Date.now(),
          metodoPago: mEfectivo.checked ? 'efectivo' : 'transferencia',
          esPagoJusto: rJusto.checked
        };
        // 1) Guarda el pago localmente en la estimación (igual que antes)
        await setPagoCliente(obraId, estId, pago);

        // 2) Escribe (o actualiza) item del buzón para que el contador apruebe
        await sincronizarConBuzon(obraId, estId, est, pago);

        toast(`Pago (${pago.metodoPago}) enviado al buzón del contador`, 'ok');
        return true;
      } catch (err) {
        console.error(err);
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

async function sincronizarConBuzon(obraId, estId, est, pago) {
  // Lee link de obra → proyecto contable y meta para el snapshot
  const [links, obraMeta] = await Promise.all([
    getObraLinks(),
    rread(`obras/${obraId}/meta`)
  ]);
  const proyectoId = links?.[obraId] || null;
  const obraNombre = obraMeta?.nombre || '';

  // ABONO NETO: se contabiliza el neto realmente cobrado. El desglose CUADRA
  // (importe_sin_iva + iva = importe), así bitácora NO recalcula el IVA como % del
  // importe. El IVA es el de la estimación (manual si se capturó) y viaja explícito
  // con su bandera. La amortización del anticipo NO va aquí (vive en el bloque de
  // Anticipo de estimaciones); se manda 0 para que bitácora no la reste de nuevo.
  const ivaPct = Number(obraMeta?.ivaPct ?? 0.16);
  const importe_sin_iva = Math.round((Number(pago.subtotal) || 0) * 100) / 100;
  const iva = Math.round((Number(pago.iva) || 0) * 100) / 100;
  const ivaManual = pago.ivaManual === true;
  const amortizacion_anticipo = 0;

  // Busca si ya hay un item PENDIENTE o HUÉRFANO para esta estimación. Si sí,
  // lo actualiza (vuelve a pendiente). Si está aprobado, no debería llegar aquí
  // porque editPagoDialog ya lo bloqueó. Si está rechazado, creamos uno nuevo.
  const items = await listBuzonItems();
  const existing = Object.entries(items).find(([_, it]) =>
    it?.tipo === 'pago_cliente' &&
    it?.obraId === obraId &&
    it?.estimId === estId &&
    (it?.estado === 'pendiente' || it?.estado === 'huerfano')
  );

  const metodoPago = pago.metodoPago || 'transferencia';
  const payload = {
    tipo: 'pago_cliente',
    origenApp: 'estimaciones',
    obraId,
    obraNombre,
    proyectoId,
    estimId: estId,
    estimNumero: est.numero,
    monto: pago,
    // Desglose para bitácora (cuadra: importe_sin_iva + iva = importe cobrado):
    importe_sin_iva,
    iva,
    ivaManual,           // true = usar el IVA enviado tal cual (no recalcular 16%)
    ivaPct,              // referencia de la tasa de la obra
    importe: Math.round((Number(pago.importe) || 0) * 100) / 100,
    amortizacion_anticipo,   // 0: el abono ya es neto (amortización va aparte)
    // Cómo pagó el cliente (para el registro de abono en el proyecto contable):
    metodoPago,
    esPagoJusto: pago.esPagoJusto === true,
    fecha: pago.fecha,
    descripcion: `Pago de estimación #${est.numero} (${metodoPago})${proyectoId ? '' : ' — obra sin vincular a proyecto contable'}`,
    estado: 'pendiente',
    creadoPor: state.user?.uid || ''
  };

  if (existing) {
    const [itemId] = existing;
    // Limpia campos del estado huérfano si los había
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

async function printConfigDialog(obra, estId, formato) {
  const m = obra.meta || {};
  const anticipoPct = Number(m.anticipoPct ?? 0);

  const modoEst = h('input', { type: 'radio', name: 'modo', value: 'estimacion', checked: true });
  const modoEC = h('input', { type: 'radio', name: 'modo', value: 'estadoCuenta' });
  const soloMov = h('input', { type: 'checkbox', checked: true });
  const mostrarAmort = h('input', { type: 'checkbox', checked: anticipoPct > 0, disabled: anticipoPct === 0 });
  const mostrarEC = h('input', { type: 'checkbox', checked: true });
  const incluirMemoria = h('input', { type: 'checkbox' });
  const incluirAnexo = h('input', { type: 'checkbox' });
  const notas = h('textarea', { rows: 3, placeholder: 'Notas que aparecerán al final del PDF (opcional)…', style: { width: '100%', resize: 'vertical' } });

  // Si elige "Estado de cuenta" se desactiva soloMovimiento (no aplica)
  function syncMode() {
    const ec = modoEC.checked;
    soloMov.disabled = ec;
    if (ec) soloMov.checked = false;
    else soloMov.checked = true;
  }
  modoEst.addEventListener('change', syncMode);
  modoEC.addEventListener('change', syncMode);

  const body = h('div', {}, [
    h('h3', { style: { marginTop: 0 } }, 'Tipo de reporte'),
    h('label', { class: 'row', style: { padding: '6px 0', cursor: 'pointer' } }, [
      modoEst, h('div', {}, [
        h('div', {}, h('b', {}, 'Resumen de estimación')),
        h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Lo ejecutado en este período. Útil para soportar la facturación de la estimación.')
      ])
    ]),
    h('label', { class: 'row', style: { padding: '6px 0', cursor: 'pointer' } }, [
      modoEC, h('div', {}, [
        h('div', {}, h('b', {}, 'Estado de cuenta general')),
        h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Todos los conceptos del catálogo con avance acumulado a la fecha de corte. Útil para entregar al cliente.')
      ])
    ]),

    h('h3', { style: { marginTop: '14px' } }, 'Opciones'),
    h('label', { class: 'row', style: { padding: '4px 0' } }, [soloMov, h('span', {}, 'Solo conceptos con avance en esta estimación')]),
    h('label', { class: 'row', style: { padding: '4px 0' } }, [mostrarAmort, h('span', {}, 'Mostrar amortización de anticipo' + (anticipoPct === 0 ? ' (sin anticipo configurado)' : ` (${pct(anticipoPct)})`))]),
    h('label', { class: 'row', style: { padding: '4px 0' } }, [mostrarEC, h('span', {}, 'Incluir bloque de Estado de Cuenta')]),
    h('label', { class: 'row', style: { padding: '4px 0' } }, [incluirMemoria, h('span', {}, '📐 Incluir memoria de generadores (detalle de medición, solo PDF)')]),
    h('label', { class: 'row', style: { padding: '4px 0' } }, [incluirAnexo, h('span', {}, '📎 Anexar croquis y fotos del sitio (requiere Drive conectado, solo PDF)')]),

    h('h3', { style: { marginTop: '14px' } }, 'Notas adicionales'),
    notas
  ]);

  await modal({
    title: 'Configurar ' + (formato === 'pdf' ? 'PDF' : 'XLSX'),
    body,
    confirmLabel: '⬇ Generar ' + (formato === 'pdf' ? 'PDF' : 'XLSX'),
    onConfirm: async () => {
      const cfg = {
        modo: modoEC.checked ? 'estadoCuenta' : 'estimacion',
        soloMovimiento: soloMov.checked,
        mostrarAmortizacion: mostrarAmort.checked,
        mostrarEstadoCuenta: mostrarEC.checked,
        incluirMemoria: incluirMemoria.checked,
        incluirAnexoFotos: incluirAnexo.checked,
        notas: notas.value || ''
      };
      // Si pidió el anexo y Drive no está conectado, intenta conectarlo ahora
      // (el clic de "Generar" es un gesto de usuario válido para abrir el OAuth).
      if (formato === 'pdf' && cfg.incluirAnexoFotos && !driveSignedIn()) {
        if (!driveConfigured()) {
          toast('Google Drive no está configurado; el PDF se generará sin el anexo.', 'warn');
          cfg.incluirAnexoFotos = false;
        } else {
          try { await initDrive(); await driveSignIn(); }
          catch (e) { toast('No se conectó a Drive; el PDF se generará sin el anexo.', 'warn'); cfg.incluirAnexoFotos = false; }
        }
      }
      try {
        if (formato !== 'pdf') { exportResumenXlsx(obra, estId, cfg); toast('Reporte generado', 'ok'); return true; }
        const res = await exportResumenPdf(obra, estId, cfg);
        const a = cfg.incluirAnexoFotos ? res?.anexo : null;
        if (a?.added) toast(`PDF generado con ${a.count} imagen(es) en el anexo`, 'ok');
        else if (a?.reason === 'empty') toast('PDF generado, pero esta estimación no tiene croquis/fotos (súbelos en el generador → “Croquis/Fotos del sitio”).', 'warn');
        else if (a?.reason === 'no-drive') toast('PDF generado sin anexo (Drive no conectado).', 'warn');
        else toast('Reporte generado', 'ok');
        return true;
      } catch (err) {
        console.error(err);
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}
