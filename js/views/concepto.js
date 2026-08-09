// Detalle de un concepto del catálogo: ficha, bloque de AVANCE acumulado,
// desglose por estimación e historial de generadores.
//
// El avance se calcula igual que el concentrado F-1: por estimación, el
// generador manda sobre el avance capturado directo (para no doble-contar), y
// lo marcado como proyección no cuenta salvo que se pida verlo con el toggle.
//
// Si el concepto es un AGRUPADOR (partida/subpartida del OPUS), se muestra el
// avance consolidado de todos los PUs que cuelgan de él.

import { h } from '../util/dom.js';
import { renderShell } from './shell.js';
import { loadObra, resolveConceptoKeyLocal } from '../services/db.js';
import { money, num, pct, dateMx } from '../util/format.js';
import { navigate } from '../state/router.js';
import { calcGeneradorTotal, PLANTILLAS } from '../services/plantillas.js';

export async function renderConcepto({ params }) {
  const obraId = params.id;
  const cid = params.cid;
  renderShell(crumbs(obraId), h('div', { class: 'empty' }, 'Cargando concepto…'));

  const obra = await loadObra(obraId);
  if (!obra) { renderShell(crumbs(obraId), h('div', { class: 'empty' }, 'Obra no encontrada.')); return; }

  const m = obra.meta || {};
  const conceptos = obra.catalogo?.conceptos || {};
  const key = resolveConceptoKeyLocal(obra, cid) || cid;
  const concepto = conceptos[key];
  if (!concepto) {
    renderShell(crumbs(obraId, m.nombre), h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '🔍'),
      'Ese concepto ya no existe en el catálogo vigente.',
      h('div', { style: { marginTop: '12px' } }, h('a', { href: `#/obras/${obraId}/catalogo` }, 'Volver al catálogo'))
    ]));
    return;
  }

  const ests = obra.estimaciones || {};
  const estsArr = Object.entries(ests).map(([id, e]) => ({ id, ...e })).sort((a, b) => (a.numero || 0) - (b.numero || 0));
  const hayProyeccion = estsArr.some(e => e.esProyeccion)
    || Object.values(obra.generadores || {}).some(g => g.esProyeccion);

  // Estado de la vista: ver o no lo marcado como proyección.
  let incluirProyeccion = false;
  draw();

  // Cantidad ejecutada por estimación para un concepto dado (misma regla que F-1).
  function avanceDe(cKey, cObj) {
    const byEst = {}, origen = {};
    const gens = [];
    for (const [gid, g] of Object.entries(obra.generadores || {})) {
      if ((resolveConceptoKeyLocal(obra, g.conceptoId) || g.conceptoId) !== cKey) continue;
      const proy = !!(g.esProyeccion || ests[g.estimacionId]?.esProyeccion);
      const cantidad = calcGeneradorTotal(cObj, g);
      gens.push({ gid, ...g, cantidad, proy });
      if (proy && !incluirProyeccion) continue;
      byEst[g.estimacionId] = (byEst[g.estimacionId] || 0) + cantidad;
      origen[g.estimacionId] = 'generador';
    }
    for (const [aCid, byE] of Object.entries(obra.avances || {})) {
      if ((resolveConceptoKeyLocal(obra, aCid) || aCid) !== cKey) continue;
      for (const [eid, cant] of Object.entries(byE || {})) {
        if (origen[eid]) continue;                                   // el generador manda
        if (!incluirProyeccion && ests[eid]?.esProyeccion) continue;
        const v = Number(cant) || 0;
        if (!v) continue;
        byEst[eid] = v; origen[eid] = 'directo';
      }
    }
    gens.sort((a, b) => (ests[a.estimacionId]?.numero || 0) - (ests[b.estimacionId]?.numero || 0) || (a.numero || 0) - (b.numero || 0));
    const total = Object.values(byEst).reduce((s, x) => s + x, 0);
    return { byEst, origen, gens, total };
  }

  function draw() {
    const esAgrupador = concepto.tipo === 'agrupador';
    const body = h('div', {}, [
      header(),
      ficha(),
      esAgrupador ? bloqueAgrupador() : bloqueAvancePU()
    ]);
    renderShell(crumbs(obraId, m.nombre, concepto), body);
  }

  function header() {
    return h('div', { class: 'row' }, [
      h('h1', { style: { margin: 0 } }, concepto.tipo === 'agrupador' ? 'Partida del catálogo' : 'Concepto del catálogo'),
      h('div', { class: 'muted' }, m.nombre || ''),
      h('div', { style: { flex: 1 } }),
      hayProyeccion && h('label', { class: 'row', style: { fontSize: '12px', gap: '6px' }, title: 'Ver también lo capturado como escenario/proyección' }, [
        (() => {
          const cb = h('input', { type: 'checkbox' });
          cb.checked = incluirProyeccion;
          cb.addEventListener('change', () => { incluirProyeccion = cb.checked; draw(); });
          return cb;
        })(),
        h('span', {}, '🔮 Incluir proyección')
      ]),
      h('button', { class: 'btn ghost', onClick: () => navigate('/obras/' + obraId + '/catalogo') }, '← Catálogo'),
      h('button', { class: 'btn ghost', onClick: () => navigate('/obras/' + obraId + '/f1') }, 'F-1 →')
    ]);
  }

  function ficha() {
    const plant = concepto.plantillaTipo
      ? h('span', { class: 'tag muted', title: PLANTILLAS[concepto.plantillaTipo]?.descripcion || '' }, '📐 ' + (PLANTILLAS[concepto.plantillaTipo]?.label || concepto.plantillaTipo))
      : h('span', { class: 'tag muted', title: 'Se asigna la 1ª vez que se le registra un generador' }, 'sin plantilla');
    return h('div', { class: 'card' }, [
      h('div', { class: 'row', style: { gap: '10px' } }, [
        h('span', { class: 'mono', style: { fontSize: '13px', color: 'var(--accent)' } }, concepto.clave || '—'),
        concepto.archivado && h('span', { class: 'tag warn', title: 'Ya no aparece en el catálogo OPUS vigente' }, 'archivado'),
        concepto.ocOrigen && h('span', { class: 'tag ok', title: 'Concepto que entró por una orden de cambio aplicada' }, `＋ OC #${concepto.ocNumero || ''}`),
        concepto.tipo !== 'agrupador' && plant
      ]),
      h('div', { style: { marginTop: '6px', fontSize: '15px' } }, concepto.descripcion || '—'),
      (concepto.agrupadores || []).length > 0 && h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '6px' } },
        (concepto.agrupadores || []).map(a => a?.descripcion || a?.clave || '').filter(Boolean).join('  ›  ')),
      h('div', { class: 'grid-4', style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--border)' } }, [
        kv('Unidad', concepto.unidad || '—'),
        kv('Cantidad contratada', num(concepto.cantidad, 2)),
        kv('P.U.', money(concepto.precio_unitario)),
        kv('Importe contratado', money(concepto.total))
      ])
    ]);
  }

  // ===================== AVANCE (precio unitario) =====================
  function bloqueAvancePU() {
    const { byEst, origen, gens, total } = avanceDe(key, concepto);
    const contratada = Number(concepto.cantidad) || 0;
    const pu = Number(concepto.precio_unitario) || 0;
    const avance = contratada ? total / contratada : 0;
    const importeEjec = total * pu;
    const restanteCant = contratada - total;
    const restanteImp = (Number(concepto.total) || contratada * pu) - importeEjec;
    const sobre = contratada > 0 && total > contratada;

    // Filas: solo estimaciones con movimiento, acumulando en orden.
    const conMov = estsArr.filter(e => byEst[e.id] != null);
    let acum = 0;
    const filas = conMov.map(e => {
      const cant = byEst[e.id] || 0;
      acum += cant;
      const acumPct = contratada ? acum / contratada : 0;
      const over = contratada > 0 && acum > contratada;
      return h('tr', { class: over ? 'row-overrun' : '' }, [
        h('td', {}, [
          h('a', { href: `#/obras/${obraId}/estimaciones/${e.id}`, style: { fontWeight: 600 } }, '#' + (e.numero || '?')),
          e.esProyeccion && h('span', { class: 'tag muted', style: { marginLeft: '6px' }, title: 'Escenario / proyección' }, '🔮')
        ]),
        h('td', { class: 'muted' }, e.fechaCorte ? dateMx(e.fechaCorte) : '—'),
        h('td', {}, h('span', { class: 'tag ' + (e.estado === 'cerrada' ? 'ok' : 'muted') }, e.estado === 'cerrada' ? 'cerrada' : 'borrador')),
        h('td', {}, origen[e.id] === 'directo'
          ? h('span', { class: 'tag muted', title: 'Cantidad capturada directo, sin generador' }, '✎ directo')
          : h('span', { class: 'tag muted', title: 'Calculado desde el generador de obra' }, '📐 generador')),
        h('td', { class: 'num' }, num(cant, 2)),
        h('td', { class: 'num' }, h('b', {}, num(acum, 2))),
        h('td', { class: 'num ' + (over ? 'warn' : '') }, contratada ? pct(acumPct) : '—'),
        h('td', { class: 'num muted' }, money(cant * pu)),
        h('td', { class: 'num' }, money(acum * pu))
      ]);
    });

    const tablaEst = conMov.length === 0
      ? h('div', { class: 'empty', style: { padding: '28px' } }, [h('div', { class: 'ico' }, '📊'), 'Este concepto todavía no tiene avance registrado.'])
      : h('table', { class: 'tbl' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, 'Estim.'), h('th', {}, 'Fecha corte'), h('th', {}, 'Estado'), h('th', {}, 'Origen'),
          h('th', { class: 'num' }, 'Cant. periodo'), h('th', { class: 'num' }, 'Acumulado'),
          h('th', { class: 'num' }, '% acum.'), h('th', { class: 'num' }, 'Importe periodo'), h('th', { class: 'num' }, 'Importe acum.')
        ])]),
        h('tbody', {}, [...filas, h('tr', { style: { fontWeight: 600, background: 'var(--bg-2)', borderTop: '2px solid var(--border-strong)' } }, [
          h('td', { colSpan: 4 }, 'TOTAL EJECUTADO'),
          h('td', { class: 'num' }, num(total, 2)),
          h('td', { class: 'num' }, num(total, 2)),
          h('td', { class: 'num ' + (sobre ? 'warn' : '') }, contratada ? pct(avance) : '—'),
          h('td', {}, ''),
          h('td', { class: 'num' }, money(importeEjec))
        ])])
      ]);

    // Historial de generadores del concepto.
    const filasGen = gens.map(g => {
      const e = ests[g.estimacionId] || {};
      const ignorado = g.proy && !incluirProyeccion;
      return h('tr', { style: ignorado ? { opacity: .5 } : {} }, [
        h('td', {}, [h('b', {}, 'Gen ' + (g.numero || '?')), g.proy && h('span', { class: 'tag muted', style: { marginLeft: '6px' } }, '🔮')]),
        h('td', {}, h('a', { href: `#/obras/${obraId}/estimaciones/${g.estimacionId}` }, '#' + (e.numero || '?'))),
        h('td', { class: 'num muted' }, num0Safe((g.partidas || []).length)),
        h('td', { class: 'num muted' }, (g.ajustes || []).length ? num((g.ajustes || []).reduce((s, a) => s + (Number(a.cantidad) || 0), 0), 2) : '—'),
        h('td', { class: 'num' }, h('b', {}, num(g.cantidad, 2))),
        h('td', { class: 'num muted' }, money(g.cantidad * pu)),
        h('td', {}, [
          ((g.croquis || []).length || (g.fotos || []).length)
            ? h('span', { class: 'muted', style: { fontSize: '11px' } }, `${(g.croquis || []).length ? '📐' + (g.croquis || []).length + ' ' : ''}${(g.fotos || []).length ? '📷' + (g.fotos || []).length : ''}`)
            : h('span', { class: 'muted' }, '—')
        ]),
        h('td', {}, h('div', { class: 'desc', style: { maxWidth: '240px', fontSize: '12px' } }, g.notas || '')),
        h('td', {}, h('button', { class: 'btn sm ghost', onClick: () => navigate(`/obras/${obraId}/estimaciones/${g.estimacionId}/generadores/${g.gid}`) }, 'Abrir'))
      ]);
    });

    const tablaGen = gens.length === 0
      ? h('div', { class: 'empty', style: { padding: '24px' } }, [h('div', { class: 'ico' }, '📐'), 'Sin generadores. El avance de este concepto se capturó directo o aún no empieza.'])
      : h('table', { class: 'tbl' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, 'Generador'), h('th', {}, 'Estim.'), h('th', { class: 'num' }, 'Partidas'), h('th', { class: 'num' }, 'Ajustes'),
          h('th', { class: 'num' }, 'Cantidad'), h('th', { class: 'num' }, 'Importe'), h('th', {}, 'Adj.'), h('th', {}, 'Notas'), h('th', {}, '')
        ])]),
        h('tbody', {}, filasGen)
      ]);

    return h('div', {}, [
      // KPIs + barra de avance
      h('div', { class: 'card' }, [
        h('div', { class: 'grid-4' }, [
          kvBig('Ejecutado', `${num(total, 2)} ${concepto.unidad || ''}`, sobre ? 'warn' : ''),
          kvBig('% de avance', contratada ? pct(avance) : '—', sobre ? 'warn' : 'accent'),
          kvBig('Importe ejecutado', money(importeEjec), ''),
          kvBig('Restante', `${num(restanteCant, 2)} ${concepto.unidad || ''}`, restanteCant < 0 ? 'warn' : '')
        ]),
        h('div', { style: { marginTop: '14px' } }, [
          h('div', { class: 'bar' + (sobre ? ' warn' : '') }, h('span', { style: { width: Math.min(100, Math.max(0, avance * 100)) + '%' } })),
          h('div', { class: 'row', style: { marginTop: '6px', fontSize: '11px' } }, [
            h('span', { class: 'muted' }, `${num(total, 2)} de ${num(contratada, 2)} ${concepto.unidad || ''}`),
            h('div', { style: { flex: 1 } }),
            h('span', { class: 'muted' }, `Restante por cobrar: ${money(restanteImp)}`)
          ])
        ]),
        sobre && h('div', { style: { marginTop: '10px' } },
          h('span', { class: 'tag warn' }, `⚠ Sobreejecución: ${num(total - contratada, 2)} ${concepto.unidad || ''} (${money((total - contratada) * pu)}) arriba de lo contratado`)),
        incluirProyeccion && h('div', { style: { marginTop: '10px' } },
          h('span', { class: 'tag muted' }, '🔮 Estas cifras INCLUYEN proyección — no son el avance real'))
      ]),
      subcontratosCard(),
      h('h2', {}, 'Avance por estimación'),
      h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } }, tablaEst),
      h('h2', {}, 'Generadores del concepto'),
      h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } }, tablaGen)
    ]);
  }

  // Subcontratos que incluyen este concepto: cuánto se subcontrató y cuánto
  // lleva ejecutado el sub (para comparar contra lo que se le estima al cliente).
  function subcontratosCard() {
    const filas = [];
    for (const [subId, sub] of Object.entries(obra.subcontratos || {})) {
      const cs = (sub.conceptos || []).find(x => (resolveConceptoKeyLocal(obra, x.conceptoId) || x.conceptoId) === key);
      if (!cs) continue;
      const ejecSub = Object.values(sub.estimaciones || {}).reduce((s, e) => {
        const av = e.avances || {};
        let v = 0;
        for (const [aCid, cant] of Object.entries(av)) {
          if ((resolveConceptoKeyLocal(obra, aCid) || aCid) === key) v += Number(cant) || 0;
        }
        return s + v;
      }, 0);
      const cant = Number(cs.cantidadSub) || 0;
      const ganador = sub.licitantes?.[sub.meta?.licitanteAdjudicadoId];
      const puSub = ganador ? Number(ganador.precios?.[cs.conceptoId] ?? ganador.precios?.[key]) || 0 : 0;
      filas.push(h('tr', {}, [
        h('td', {}, h('a', { href: `#/obras/${obraId}/subcontratos/${subId}` }, sub.meta?.nombre || 'Subcontrato')),
        h('td', {}, h('span', { class: 'tag ' + (sub.meta?.estado === 'adjudicado' ? 'ok' : 'muted') }, sub.meta?.estado || '—')),
        h('td', { class: 'num' }, num(cant, 2)),
        h('td', { class: 'num' }, num(ejecSub, 2)),
        h('td', { class: 'num ' + (cant && ejecSub > cant ? 'warn' : '') }, cant ? pct(ejecSub / cant) : '—'),
        h('td', { class: 'num muted' }, puSub ? money(puSub) : '—'),
        h('td', { class: 'num' }, puSub ? money(ejecSub * puSub) : '—')
      ]));
    }
    if (!filas.length) return null;
    return h('div', {}, [
      h('h2', {}, 'Subcontratado'),
      h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } }, h('table', { class: 'tbl' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, 'Subcontrato'), h('th', {}, 'Estado'), h('th', { class: 'num' }, 'Cant. subcontratada'),
          h('th', { class: 'num' }, 'Ejecutado sub'), h('th', { class: 'num' }, '% sub'),
          h('th', { class: 'num' }, 'P.U. adjudicado'), h('th', { class: 'num' }, 'Costo ejecutado')
        ])]),
        h('tbody', {}, filas)
      ]))
    ]);
  }

  // ===================== AVANCE (agrupador / partida) =====================
  function bloqueAgrupador() {
    const idMatch = (c) => (c.agrupadores || []).some(a => (a?.clave || '') === (concepto.clave || '') && (a?.descripcion || '') === (concepto.descripcion || ''));
    const hijos = Object.entries(conceptos)
      .filter(([, c]) => c.tipo === 'precio_unitario' && !c.archivado && idMatch(c))
      .map(([id, c]) => ({ id, ...c }))
      .sort((a, b) => (a.orden || 0) - (b.orden || 0));

    let totalPpto = 0, totalEjec = 0, ponderado = 0;
    const pre = hijos.map(c => {
      const { total } = avanceDe(c.id, c);
      const imp = total * (Number(c.precio_unitario) || 0);
      totalPpto += Number(c.total) || 0;
      totalEjec += imp;
      return { c, cant: total, imp };
    });
    for (const r of pre) ponderado += totalPpto ? ((Number(r.c.total) || 0) / totalPpto) * (r.c.cantidad ? r.cant / r.c.cantidad : 0) : 0;

    const filas = pre.map(({ c, cant, imp }) => {
      const av = c.cantidad ? cant / c.cantidad : 0;
      const over = c.cantidad && cant > c.cantidad;
      return h('tr', { class: over ? 'row-overrun' : '' }, [
        h('td', { class: 'mono muted' }, c.clave || ''),
        h('td', {}, h('div', { class: 'desc', style: { maxWidth: '340px' } }, c.descripcion || '')),
        h('td', { class: 'muted' }, c.unidad || ''),
        h('td', { class: 'num muted' }, num(c.cantidad, 2)),
        h('td', { class: 'num' }, num(cant, 2)),
        h('td', { class: 'num ' + (over ? 'warn' : '') }, c.cantidad ? pct(av) : '—'),
        h('td', { class: 'num muted' }, money(c.total)),
        h('td', { class: 'num' }, money(imp)),
        h('td', {}, h('button', { class: 'btn sm ghost', onClick: () => navigate(`/obras/${obraId}/conceptos/${c.id}`) }, 'Abrir'))
      ]);
    });

    const avancePart = totalPpto ? totalEjec / totalPpto : 0;
    return h('div', {}, [
      h('div', { class: 'card' }, [
        h('div', { class: 'grid-4' }, [
          kvBig('Conceptos', String(hijos.length), ''),
          kvBig('% de avance (importe)', totalPpto ? pct(avancePart) : '—', 'accent'),
          kvBig('Importe ejecutado', money(totalEjec), ''),
          kvBig('Restante', money(totalPpto - totalEjec), (totalPpto - totalEjec) < 0 ? 'warn' : '')
        ]),
        h('div', { style: { marginTop: '14px' } }, [
          h('div', { class: 'bar' }, h('span', { style: { width: Math.min(100, Math.max(0, avancePart * 100)) + '%' } })),
          h('div', { class: 'row', style: { marginTop: '6px', fontSize: '11px' } }, [
            h('span', { class: 'muted' }, `${money(totalEjec)} de ${money(totalPpto)}`),
            h('div', { style: { flex: 1 } }),
            h('span', { class: 'muted' }, `Avance ponderado por cantidad: ${pct(ponderado)}`)
          ])
        ])
      ]),
      h('h2', {}, 'Conceptos de esta partida'),
      h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } }, hijos.length === 0
        ? h('div', { class: 'empty', style: { padding: '28px' } }, 'Esta partida no tiene conceptos directos.')
        : h('table', { class: 'tbl' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', {}, 'Clave'), h('th', {}, 'Descripción'), h('th', {}, 'U.'),
            h('th', { class: 'num' }, 'Contratada'), h('th', { class: 'num' }, 'Ejecutada'), h('th', { class: 'num' }, '% Av.'),
            h('th', { class: 'num' }, 'Importe contratado'), h('th', { class: 'num' }, 'Importe ejecutado'), h('th', {}, '')
          ])]),
          h('tbody', {}, filas)
        ]))
    ]);
  }
}

function num0Safe(n) { return Number.isFinite(n) ? String(n) : '0'; }

function kv(label, val) {
  return h('div', { class: 'field' }, [h('label', {}, label), h('div', { class: 'mono' }, val)]);
}
function kvBig(label, val, kind) {
  const color = kind === 'ok' ? 'var(--ok)' : kind === 'warn' ? 'var(--warn)' : kind === 'accent' ? 'var(--accent)' : '';
  return h('div', { class: 'field' }, [
    h('label', {}, label),
    h('div', { class: 'mono', style: { fontSize: '20px', fontWeight: 600, color } }, val)
  ]);
}

function crumbs(obraId, nombre, concepto) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || (obraId || '').slice(0, 6), to: '/obras/' + obraId },
    { label: 'Catálogo', to: `/obras/${obraId}/catalogo` },
    { label: concepto ? (concepto.clave || concepto.descripcion || 'Concepto').slice(0, 28) : 'Concepto' }
  ];
}
