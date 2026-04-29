// RESUMEN: vista por estimación con estado de cuenta y exports.
// Antes de exportar PDF/XLSX abre un diálogo de configuración (filtros, modo,
// amortización, notas).

import { h, modal, toast } from '../util/dom.js';
import { renderShell } from './shell.js';
import { rread, loadObra, setPagoCliente, getObraLinks, listBuzonItems, pushBuzonItem, updateBuzonItem } from '../services/db.js';
import { state } from '../state/store.js';
import { money, num, dateMx, pct } from '../util/format.js';
import { buildResumenData, exportResumenPdf, exportResumenXlsx, exportEstimacionJson } from '../services/export.js';

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
  const activo = matching.find(it => it.estado !== 'rechazado');
  const buzonItem = activo || matching.sort((a, b) => (b.creadoAt || 0) - (a.creadoAt || 0))[0] || null;
  const buzonEstado = buzonItem?.estado || null;
  const m = obra.meta || {};
  const ests = obra.estimaciones || {};
  const estsArr = Object.entries(ests).map(([id, e]) => ({ id, ...e })).sort((a, b) => (a.numero || 0) - (b.numero || 0));
  const data = buildResumenData(obra, estId);
  const { est, ivaPct, anticipoPct, rows, subtotalEsta, ivaEsta, importeEsta, avPond, importeAcumEjec, importeAcumEjecCIVA, subtotalPagado, ivaPagado, importePagado, diferencia, diferenciaPct, anticipoMontoBase, amortizacionEsta, amortizacionAcum, saldoAnticipoPorAmortizar, netoEsta, netoAcum } = data;

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
  const editPagosBtn = editable
    ? h('button', { class: 'btn sm ghost', onClick: async () => { const ok = await editPagoDialog(obraId, estId, est, ivaPct); if (ok) renderResumen({ params: { id: obraId } }); } },
      buzonEstado === 'aprobado' ? '🔒 Ver pago' : '✎ Editar pago')
    : null;
  const buzonBadge =
    buzonEstado === 'pendiente' ? h('span', { class: 'tag warn', style: { marginLeft: '6px' }, title: 'El contador todavía no aprueba este pago en bitácora.' }, '⏳ Esperando aprobación')
    : buzonEstado === 'aprobado' ? h('span', {
        class: 'tag ok', style: { marginLeft: '6px' },
        title: (buzonItem?.aprobadoAt ? 'Aprobado el ' + new Date(buzonItem.aprobadoAt).toLocaleString('es-MX') : 'Aprobado por el contador') +
               (buzonItem?.actualizadoPorContador ? ' · Editado luego por el contador' : '')
      }, buzonItem?.actualizadoPorContador ? '✓ Aprobado · ✎ editado por contador' : '✓ Aprobado por contador')
    : buzonEstado === 'rechazado' ? h('span', { class: 'tag danger', style: { marginLeft: '6px' }, title: buzonItem?.comentarioRechazo ? 'Motivo: ' + buzonItem.comentarioRechazo : 'Rechazado por el contador' }, '✕ Rechazado')
    : buzonEstado === 'huerfano' ? h('span', {
        class: 'tag warn', style: { marginLeft: '6px', borderColor: '#a06bd9', color: '#a06bd9' },
        title: (buzonItem?.descripcionHuerfano || 'El contador eliminó el movimiento contable.') +
               (buzonItem?.huerfanoAt ? ' · ' + new Date(buzonItem.huerfanoAt).toLocaleString('es-MX') : '')
      }, '⚠ Movimiento eliminado')
    : null;

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
      h('td', { class: 'num muted' }, money(importeAcumEjec * ivaPct)),
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
    h('td', {}, ['Pagos cliente (acumulado) ', editPagosBtn, buzonBadge]),
    h('td', { class: 'num' }, money(subtotalPagado)),
    h('td', { class: 'num muted' }, money(ivaPagado)),
    h('td', { class: 'num' }, h('b', {}, money(importePagado)))
  ]));

  const estadoCuenta = h('div', { class: 'card' }, [
    h('h3', {}, 'Estado de cuenta'),
    h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [h('th', {}, 'Documento'), h('th', { class: 'num' }, 'Subtotal'), h('th', { class: 'num' }, `IVA (${pct(ivaPct)})`), h('th', { class: 'num' }, 'Importe')])]),
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

  const blocks = [head, sub];
  if (anticipoCard) blocks.push(anticipoCard);
  blocks.push(estadoCuenta);
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

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'RESUMEN' }
  ];
}

async function editPagoDialog(obraId, estId, est, ivaPct) {
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
        it.movId && h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '12px' } }, [
          'ID del movimiento contable: ', h('code', {}, it.movId)
        ])
      ]),
      confirmLabel: 'Cerrar', cancelLabel: '',
      onConfirm: () => true
    });
    return false;
  }

  const cur = est.pagoCliente || { subtotal: 0, iva: 0, importe: 0, fecha: Date.now() };
  const subtotalIn = h('input', { type: 'number', step: '0.01', value: cur.subtotal || '' });
  const ivaIn = h('input', { type: 'number', step: '0.01', value: cur.iva || '' });
  const importeIn = h('input', { type: 'number', step: '0.01', value: cur.importe || '' });
  const fechaIn = h('input', { type: 'date', value: cur.fecha ? new Date(cur.fecha).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10) });

  function syncFromSubtotal() {
    const s = Number(subtotalIn.value) || 0;
    ivaIn.value = (s * ivaPct).toFixed(2);
    importeIn.value = (s * (1 + ivaPct)).toFixed(2);
  }
  function syncFromImporte() {
    const i = Number(importeIn.value) || 0;
    const s = i / (1 + ivaPct);
    subtotalIn.value = s.toFixed(2);
    ivaIn.value = (s * ivaPct).toFixed(2);
  }
  subtotalIn.addEventListener('input', syncFromSubtotal);
  importeIn.addEventListener('input', syncFromImporte);

  const body = h('div', {}, [
    h('p', { class: 'muted', style: { marginTop: 0, fontSize: '12px' } }, `Registra el pago que el cliente hizo por la estimación #${est.numero}. IVA aplicado: ${pct(ivaPct)}.`),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Subtotal'), subtotalIn]),
      h('div', { class: 'field' }, [h('label', {}, 'IVA (auto)'), ivaIn])
    ]),
    h('div', { class: 'grid-2', style: { marginTop: '10px' } }, [
      h('div', { class: 'field' }, [h('label', {}, 'Importe (con IVA)'), importeIn]),
      h('div', { class: 'field' }, [h('label', {}, 'Fecha'), fechaIn])
    ])
  ]);

  return await modal({
    title: `Pago cliente — Estimación #${est.numero}`,
    body, confirmLabel: 'Guardar y enviar al contador',
    onConfirm: async () => {
      try {
        const pago = {
          subtotal: Number(subtotalIn.value) || 0,
          iva: Number(ivaIn.value) || 0,
          importe: Number(importeIn.value) || 0,
          fecha: fechaIn.value ? new Date(fechaIn.value).getTime() : Date.now()
        };
        // 1) Guarda el pago localmente en la estimación (igual que antes)
        await setPagoCliente(obraId, estId, pago);

        // 2) Escribe (o actualiza) item del buzón para que el contador apruebe
        await sincronizarConBuzon(obraId, estId, est, pago);

        toast('Pago guardado y enviado al buzón del contador', 'ok');
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
  // Lee link de obra → proyecto contable y nombre de obra para el snapshot
  const [links, obraMeta] = await Promise.all([
    getObraLinks(),
    rread(`obras/${obraId}/meta`)
  ]);
  const proyectoId = links?.[obraId] || null;
  const obraNombre = obraMeta?.nombre || '';

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

  const payload = {
    tipo: 'pago_cliente',
    origenApp: 'estimaciones',
    obraId,
    obraNombre,
    proyectoId,
    estimId: estId,
    estimNumero: est.numero,
    monto: pago,
    fecha: pago.fecha,
    descripcion: `Pago de estimación #${est.numero}${proyectoId ? '' : ' (obra sin vincular a proyecto contable)'}`,
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
        incluirAnexoFotos: incluirAnexo.checked,
        notas: notas.value || ''
      };
      try {
        if (formato === 'pdf') await exportResumenPdf(obra, estId, cfg);
        else exportResumenXlsx(obra, estId, cfg);
        toast('Reporte generado', 'ok');
        return true;
      } catch (err) {
        console.error(err);
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}
