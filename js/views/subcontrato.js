// Editor del subcontrato. Dos pestañas funcionales:
//  · Alcance: selección de conceptos del catálogo + cantidad para el subcontrato
//  · Licitantes: tabla cruzada con precios cotizados, comparativa contra catálogo,
//                add/edit/delete licitantes, import/export XLSX y PDF de invitación.

import { h, modal, toast } from '../util/dom.js';
import { renderShell } from './shell.js';
import {
  rread, updateSubcontratoMeta, setSubcontratoConceptos,
  addLicitante, updateLicitante, setLicitantePrecios, deleteLicitante,
  adjudicarSubcontrato, desadjudicarSubcontrato,
  createSubEstimacion, setSubEstimacionAvance, cerrarSubEstimacion, reabrirSubEstimacion,
  setPagoSub, deleteSubEstimacion
} from '../services/db.js';
import { state } from '../state/store.js';
import { navigate, dispatch } from '../state/router.js';
import { money, num, num0, pct, dateMx } from '../util/format.js';
import {
  exportLicitantePdf, exportLicitanteXlsx, parseLicitanteXlsx,
  exportComparativaXlsx, exportComparativaPdf
} from '../services/export.js';

const TAB_ALCANCE = 'alcance';
const TAB_LICITANTES = 'licitantes';
const TAB_ADJUDICACION = 'adjudicacion';
const TAB_ESTIMACIONES = 'estimaciones';

export async function renderSubcontrato({ params }) {
  const obraId = params.id;
  const subId = params.subid;

  renderShell(crumbs(obraId, '...', subId), h('div', { class: 'empty' }, 'Cargando…'));

  const obra = await rread(`obras/${obraId}`);
  const sub = obra?.subcontratos?.[subId];
  if (!obra || !sub) {
    renderShell(crumbs(obraId, '?', subId), h('div', { class: 'empty' }, 'Subcontrato no encontrado.'));
    return;
  }
  const m = obra.meta || {};
  const meta = sub.meta || {};
  const conceptosAll = obra.catalogo?.conceptos || {};
  const conceptosSub = sub.conceptos || [];
  const licitantes = sub.licitantes || {};

  const tab = params.tab || TAB_ALCANCE;

  // ===== Header =====
  const head = h('div', { class: 'row' }, [
    h('h1', { style: { margin: 0 } }, meta.nombre || 'Subcontrato'),
    estadoTag(meta.estado),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn sm ghost', onClick: () => editMetaDialog(obraId, subId, meta) }, '✎ Editar'),
    h('button', { class: 'btn sm ghost', onClick: () => navigate(`/obras/${obraId}/subcontratos`) }, '← Volver')
  ]);

  const adjudicado = !!meta.licitanteAdjudicadoId;
  const numSubEsts = Object.keys(sub.estimaciones || {}).length;

  const tabsBar = h('div', { class: 'row', style: { borderBottom: '1px solid var(--border)', marginBottom: '14px' } }, [
    tabBtn('Alcance', TAB_ALCANCE, tab, () => setTab(obraId, subId, TAB_ALCANCE)),
    tabBtn('Licitantes', TAB_LICITANTES, tab, () => setTab(obraId, subId, TAB_LICITANTES)),
    tabBtn('Adjudicación', TAB_ADJUDICACION, tab, () => setTab(obraId, subId, TAB_ADJUDICACION)),
    adjudicado && tabBtn(`Estimaciones (${numSubEsts})`, TAB_ESTIMACIONES, tab, () => setTab(obraId, subId, TAB_ESTIMACIONES)),
    h('div', { style: { flex: 1 } }),
    h('span', { class: 'muted', style: { fontSize: '12px' } }, [
      h('span', {}, num0(conceptosSub.length) + ' concepto(s) · '),
      h('span', {}, num0(Object.values(licitantes).filter(l => !l.archivado).length) + ' licitante(s)')
    ])
  ]);

  let body;
  if (tab === TAB_ALCANCE) {
    body = renderAlcance(obraId, subId, conceptosAll, conceptosSub);
  } else if (tab === TAB_LICITANTES) {
    body = renderLicitantes(obraId, subId, sub, conceptosAll, conceptosSub, licitantes, obra);
  } else if (tab === TAB_ADJUDICACION) {
    body = renderAdjudicacion(obraId, subId, sub, conceptosAll, conceptosSub, licitantes, obra);
  } else if (tab === TAB_ESTIMACIONES) {
    body = renderSubEstimaciones(obraId, subId, sub, conceptosAll, conceptosSub, obra);
  } else {
    body = renderAlcance(obraId, subId, conceptosAll, conceptosSub);
  }

  renderShell(crumbs(obraId, m.nombre, subId, meta.nombre), h('div', {}, [head, tabsBar, body]));
}

function tabBtn(label, value, current, onClick) {
  const active = value === current;
  return h('button', {
    onClick,
    class: 'btn ghost',
    style: {
      borderRadius: 0,
      borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
      color: active ? 'var(--accent)' : 'var(--text-1)',
      padding: '10px 16px',
      fontWeight: active ? 600 : 400
    }
  }, label);
}

function setTab(obraId, subId, tab) {
  location.hash = `#/obras/${obraId}/subcontratos/${subId}/${tab}`;
}

function estadoTag(estado) {
  const e = estado || 'cotizando';
  if (e === 'cotizando') return h('span', { class: 'tag warn' }, 'Cotizando');
  if (e === 'adjudicado') return h('span', { class: 'tag ok' }, 'Adjudicado');
  if (e === 'ejecutando') return h('span', { class: 'tag ok' }, 'Ejecutando');
  if (e === 'cerrado') return h('span', { class: 'tag muted' }, 'Cerrado');
  return h('span', { class: 'tag muted' }, e);
}

// =====================================================================
//                            TAB ALCANCE
// =====================================================================

function renderAlcance(obraId, subId, conceptosAll, conceptosSub) {
  const total = conceptosSub.reduce((s, c) => {
    const cat = conceptosAll[c.conceptoId];
    return s + (Number(c.cantidadSub) || 0) * (cat?.precio_unitario || 0);
  }, 0);

  const head = h('div', { class: 'row' }, [
    h('h2', { style: { margin: 0 } }, 'Alcance del subcontrato'),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn primary', onClick: () => addConceptosDialog(obraId, subId, conceptosAll, conceptosSub) }, '+ Agregar conceptos del catálogo')
  ]);

  const table = conceptosSub.length === 0
    ? h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '📋'),
      'No hay conceptos en el alcance todavía.',
      h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } }, 'Click en "+ Agregar conceptos del catálogo" para empezar.')
    ])
    : h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', {}, 'Clave'),
        h('th', {}, 'Descripción'),
        h('th', {}, 'U.'),
        h('th', { class: 'num' }, 'Cantidad sub'),
        h('th', { class: 'num' }, 'Cant. catálogo'),
        h('th', { class: 'num' }, 'P.U. catálogo'),
        h('th', { class: 'num' }, 'Importe ref.'),
        h('th', {}, '')
      ])]),
      h('tbody', {}, conceptosSub.map((c, idx) => {
        const cat = conceptosAll[c.conceptoId];
        if (!cat) {
          return h('tr', {}, [
            h('td', { colSpan: 7, class: 'muted' }, [h('span', {}, '⚠ Concepto eliminado del catálogo')]),
            h('td', {}, h('button', { class: 'btn sm danger ghost', onClick: () => removeConcepto(obraId, subId, conceptosSub, idx) }, '✕'))
          ]);
        }
        const cantIn = h('input', {
          type: 'number', step: 'any', value: c.cantidadSub ?? cat.cantidad ?? 0,
          style: { width: '110px', textAlign: 'right' }
        });
        cantIn.addEventListener('change', async () => {
          const newC = [...conceptosSub];
          newC[idx] = { ...c, cantidadSub: Number(cantIn.value) || 0 };
          await setSubcontratoConceptos(obraId, subId, newC);
          dispatch();
        });
        const importe = (Number(c.cantidadSub) || 0) * (cat.precio_unitario || 0);
        return h('tr', {}, [
          h('td', { class: 'mono muted' }, cat.clave || ''),
          h('td', {}, h('div', { class: 'desc' }, cat.descripcion || '')),
          h('td', { class: 'muted' }, cat.unidad || ''),
          h('td', {}, cantIn),
          h('td', { class: 'num muted' }, num(cat.cantidad, 2)),
          h('td', { class: 'num muted' }, money(cat.precio_unitario)),
          h('td', { class: 'num' }, money(importe)),
          h('td', {}, h('button', { class: 'btn sm danger ghost', onClick: () => removeConcepto(obraId, subId, conceptosSub, idx) }, '✕'))
        ]);
      }))
    ]);

  const totalCard = conceptosSub.length > 0 ? h('div', { class: 'card', style: { textAlign: 'right' } }, [
    h('div', { class: 'muted' }, 'Importe de referencia (a precios del catálogo):'),
    h('div', { class: 'mono', style: { fontSize: '24px', fontWeight: 700, color: 'var(--accent)' } }, money(total))
  ]) : null;

  return h('div', {}, [head, table, totalCard].filter(Boolean));
}

async function addConceptosDialog(obraId, subId, conceptosAll, current) {
  const yaIncluidos = new Set(current.map(c => c.conceptoId));

  // PUs ordenados por su orden original (preserva la jerarquía del XLS)
  const pus = Object.entries(conceptosAll)
    .filter(([_, c]) => c.tipo === 'precio_unitario' && !c.archivado)
    .map(([id, c]) => ({ id, ...c }))
    .sort((a, b) => (a.orden || 0) - (b.orden || 0));

  // Agrupar por partida usando la cadena completa de ancestros
  const grupos = new Map();   // key → { label, pus[] }
  for (const c of pus) {
    const ancestros = c.agrupadores || [];
    const key = ancestros.map(a => (a?.descripcion || a?.clave || '?').trim()).join(' › ') || '(sin partida)';
    if (!grupos.has(key)) grupos.set(key, { label: key, pus: [] });
    grupos.get(key).pus.push(c);
  }

  const search = h('input', { placeholder: 'Buscar clave, descripción o partida…', autofocus: true });
  const expandAll = h('button', { class: 'btn sm ghost', type: 'button' }, 'Expandir todo');
  const collapseAll = h('button', { class: 'btn sm ghost', type: 'button' }, 'Contraer todo');
  const checks = {};      // id → input checkbox de PU
  const collapsed = new Set();   // claves de partidas contraídas
  const list = h('div', { style: { maxHeight: '460px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: '6px' } });
  const summary = h('div', { class: 'row', style: { fontSize: '12px', marginTop: '8px', justifyContent: 'space-between' } });

  function getCheck(id) {
    if (!checks[id]) checks[id] = h('input', { type: 'checkbox', checked: yaIncluidos.has(id), disabled: yaIncluidos.has(id) });
    return checks[id];
  }
  function updateSummary() {
    let count = 0, total = 0;
    for (const c of pus) {
      const cb = checks[c.id];
      if (cb && cb.checked && !yaIncluidos.has(c.id)) {
        count++;
        total += (c.cantidad || 0) * (c.precio_unitario || 0);
      }
    }
    summary.innerHTML = '';
    summary.appendChild(h('div', {}, [h('b', {}, count + ' conceptos seleccionados')]));
    summary.appendChild(h('div', { class: 'muted' }, ['Importe ref.: ', h('b', {}, money(total))]));
  }

  function rerender() {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = '';
    for (const [key, g] of grupos) {
      const matching = q
        ? g.pus.filter(c => c.clave?.toLowerCase().includes(q) || c.descripcion?.toLowerCase().includes(q) || key.toLowerCase().includes(q))
        : g.pus;
      if (matching.length === 0) continue;

      // Estado del grupo: marcar/desmarcar todos los PUs visibles del grupo
      const visibles = matching.filter(c => !yaIncluidos.has(c.id));
      const todosMarcados = visibles.length > 0 && visibles.every(c => getCheck(c.id).checked);
      const algunoMarcado = visibles.some(c => getCheck(c.id).checked);

      const groupCb = h('input', { type: 'checkbox', checked: todosMarcados });
      groupCb.indeterminate = !todosMarcados && algunoMarcado;
      groupCb.addEventListener('click', e => {
        e.stopPropagation();
        const v = groupCb.checked;
        for (const c of visibles) getCheck(c.id).checked = v;
        rerender(); updateSummary();
      });

      const isCollapsed = collapsed.has(key) && !q;   // si hay búsqueda, expandir todo
      const arrow = h('span', { class: 'muted', style: { width: '14px', display: 'inline-block', cursor: 'pointer' } }, isCollapsed ? '▶' : '▼');
      const totalGrupo = matching.reduce((s, c) => s + (c.cantidad || 0) * (c.precio_unitario || 0), 0);

      const header = h('div', {
        class: 'row',
        style: {
          padding: '8px 12px',
          background: 'var(--bg-2)',
          borderBottom: '1px solid var(--border)',
          position: 'sticky', top: 0, zIndex: 1, cursor: 'pointer'
        },
        onClick: e => {
          if (e.target === groupCb) return;
          if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
          rerender();
        }
      }, [
        arrow, groupCb,
        h('div', { style: { flex: 1, fontWeight: 600, marginLeft: '4px' } }, key),
        h('span', { class: 'muted', style: { fontSize: '11px' } }, [`${matching.length} PU · `, money(totalGrupo)])
      ]);
      list.appendChild(header);

      if (!isCollapsed) {
        for (const c of matching) {
          const cb = getCheck(c.id);
          cb.onchange = () => { rerender(); updateSummary(); };
          list.appendChild(h('label', {
            class: 'row',
            style: { padding: '6px 12px 6px 38px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }
          }, [
            cb,
            h('div', { style: { flex: 1 } }, [
              h('div', { class: 'mono muted', style: { fontSize: '11px' } }, c.clave),
              h('div', { style: { fontSize: '13px' } }, c.descripcion),
              h('div', { class: 'muted', style: { fontSize: '11px' } }, [c.unidad, ' · cant. ', num(c.cantidad, 2), ' · ', money(c.precio_unitario)])
            ]),
            yaIncluidos.has(c.id) && h('span', { class: 'tag muted' }, 'ya incluido')
          ]));
        }
      }
    }
  }
  expandAll.addEventListener('click', () => { collapsed.clear(); rerender(); });
  collapseAll.addEventListener('click', () => { for (const k of grupos.keys()) collapsed.add(k); rerender(); });
  search.addEventListener('input', () => { rerender(); updateSummary(); });

  // Inicialmente contraído para fácil panorama
  for (const k of grupos.keys()) collapsed.add(k);
  rerender();
  updateSummary();

  await modal({
    title: 'Agregar conceptos al alcance',
    body: h('div', {}, [
      h('p', { class: 'muted', style: { marginTop: 0, fontSize: '12px' } }, 'Marca una partida para incluir todos sus PUs, o selecciónalos uno por uno. Las partidas con la misma clave en distintas ramas son tratadas como conceptos diferentes.'),
      h('div', { class: 'row' }, [search, expandAll, collapseAll]),
      h('div', { style: { height: '8px' } }),
      list,
      summary
    ]),
    confirmLabel: 'Agregar seleccionados',
    onConfirm: async () => {
      try {
        const nuevos = [];
        for (const c of pus) {
          const cb = checks[c.id];
          if (cb && cb.checked && !yaIncluidos.has(c.id)) nuevos.push({ conceptoId: c.id, cantidadSub: c.cantidad || 0 });
        }
        if (nuevos.length === 0) { toast('Nada que agregar', 'warn'); return false; }
        await setSubcontratoConceptos(obraId, subId, [...current, ...nuevos]);
        toast(`${nuevos.length} concepto(s) agregado(s)`, 'ok');
        dispatch();
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function removeConcepto(obraId, subId, current, idx) {
  const newList = current.filter((_, i) => i !== idx);
  await setSubcontratoConceptos(obraId, subId, newList);
  dispatch();
}

// =====================================================================
//                          TAB LICITANTES
// =====================================================================

function renderLicitantes(obraId, subId, sub, conceptosAll, conceptosSub, licitantes, obra) {
  const licsArr = Object.entries(licitantes)
    .filter(([_, l]) => !l.archivado)
    .map(([id, l]) => ({ id, ...l }));

  // Header con acciones
  const head = h('div', { class: 'row' }, [
    h('h2', { style: { margin: 0 } }, 'Licitantes y comparativa'),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn ghost sm', onClick: () => exportLicitantePdf(obra, sub, conceptosAll) }, '📄 PDF invitación'),
    h('button', { class: 'btn ghost sm', onClick: () => exportLicitanteXlsx(obra, sub, conceptosAll) }, '📊 XLSX template'),
    licsArr.length > 0 && h('button', { class: 'btn ghost sm', onClick: () => exportComparativaXlsx(obra, sub, conceptosAll) }, '⬇ Comparativa XLSX'),
    licsArr.length > 0 && h('button', { class: 'btn ghost sm', onClick: () => exportComparativaPdf(obra, sub, conceptosAll) }, '⬇ Comparativa PDF'),
    h('button', { class: 'btn ghost sm', onClick: () => importLicitanteFlow(obraId, subId, sub) }, '📥 Importar XLSX'),
    h('button', { class: 'btn primary sm', onClick: () => addLicitanteDialog(obraId, subId) }, '+ Licitante manual')
  ]);

  if (conceptosSub.length === 0) {
    return h('div', {}, [head, h('div', { class: 'empty' }, [
      h('div', {}, 'Primero agrega conceptos al alcance.'),
      h('button', { class: 'btn primary sm', style: { marginTop: '12px' }, onClick: () => setTab(obraId, subId, TAB_ALCANCE) }, 'Ir a Alcance')
    ])]);
  }

  if (licsArr.length === 0) {
    return h('div', {}, [head, h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '👥'),
      h('div', {}, 'Aún no hay licitantes.'),
      h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } }, [
        'Generar template y enviarlo: ',
        h('b', {}, '"📊 XLSX template"'),
        '. Cuando reciba el archivo de regreso, usar ',
        h('b', {}, '"📥 Importar XLSX"'),
        '. O agregar manualmente con ',
        h('b', {}, '"+ Licitante manual"'),
        '.'
      ])
    ])]);
  }

  // Tabla cruzada: filas = conceptos, columnas = licitantes
  const totalCatalogo = conceptosSub.reduce((s, cs) => {
    const cat = conceptosAll[cs.conceptoId];
    return s + (Number(cs.cantidadSub) || 0) * (cat?.precio_unitario || 0);
  }, 0);

  // Totales por licitante
  const totalesLic = {};
  for (const lic of licsArr) {
    totalesLic[lic.id] = conceptosSub.reduce((s, cs) => {
      const p = Number(lic.precios?.[cs.conceptoId]);
      return s + (Number(cs.cantidadSub) || 0) * (Number.isFinite(p) ? p : 0);
    }, 0);
  }

  // Header de la tabla con licitantes (3 columnas por licitante: P.U. | Importe | Δ%)
  const thead = h('thead', {}, [
    h('tr', {}, [
      h('th', { rowSpan: 2 }, 'Clave'),
      h('th', { rowSpan: 2 }, 'Descripción'),
      h('th', { rowSpan: 2 }, 'U.'),
      h('th', { rowSpan: 2, class: 'num' }, 'Cant.'),
      h('th', { colSpan: 2, class: 'num', style: { background: 'var(--bg-3)', textAlign: 'center' } }, 'CATÁLOGO'),
      ...licsArr.map(lic => h('th', { colSpan: 3, class: 'num', style: { borderLeft: '2px solid var(--border-strong)', textAlign: 'center' } }, [
        h('div', {}, lic.nombre),
        h('div', { class: 'muted', style: { fontWeight: 400, fontSize: '10px' } }, [
          h('button', { class: 'btn sm ghost', onClick: e => { e.stopPropagation(); editLicitanteDialog(obraId, subId, lic.id, lic, conceptosSub, conceptosAll); } }, '✎'),
          ' ',
          h('button', { class: 'btn sm ghost', onClick: e => { e.stopPropagation(); deleteLicConfirm(obraId, subId, lic.id, lic.nombre); } }, '✕')
        ])
      ]))
    ]),
    h('tr', {}, [
      h('th', { class: 'num', style: { background: 'var(--bg-3)' } }, 'P.U.'),
      h('th', { class: 'num', style: { background: 'var(--bg-3)' } }, 'Importe'),
      ...licsArr.flatMap(() => [
        h('th', { class: 'num', style: { borderLeft: '2px solid var(--border-strong)' } }, 'P.U.'),
        h('th', { class: 'num' }, 'Importe'),
        h('th', { class: 'num', title: 'Positivo = ahorro vs catálogo. Negativo = sobrecosto.' }, 'Ahorro %')
      ])
    ])
  ]);

  // Filas de conceptos
  const rows = conceptosSub.map(cs => {
    const cat = conceptosAll[cs.conceptoId];
    if (!cat) return null;
    const cant = Number(cs.cantidadSub) || 0;
    const puCat = cat.precio_unitario || 0;
    const importeCat = cant * puCat;

    // mejor PU para resaltar
    const precios = licsArr.map(l => Number(l.precios?.[cs.conceptoId])).filter(p => Number.isFinite(p) && p > 0);
    const bestPU = precios.length ? Math.min(...precios) : null;

    return h('tr', {}, [
      h('td', { class: 'mono muted' }, cat.clave),
      h('td', {}, h('div', { class: 'desc' }, cat.descripcion)),
      h('td', { class: 'muted' }, cat.unidad),
      h('td', { class: 'num' }, num(cant, 2)),
      h('td', { class: 'num muted', style: { background: 'rgba(255,255,255,0.02)' } }, money(puCat)),
      h('td', { class: 'num', style: { background: 'rgba(255,255,255,0.02)' } }, money(importeCat)),
      ...licsArr.flatMap(lic => {
        const p = Number(lic.precios?.[cs.conceptoId]);
        const valid = Number.isFinite(p) && p > 0;
        const isBest = valid && bestPU != null && Math.abs(p - bestPU) < 0.01;
        const importe = valid ? p * cant : 0;
        // Ahorro = (puCat - p) / puCat. Positivo = licitante más barato (bueno).
        const ahorro = valid && puCat > 0 ? (puCat - p) / puCat : null;
        const ahorroColor = ahorro == null ? 'muted' : (ahorro > 0 ? 'ok' : 'warn');
        const bestStyle = isBest ? { background: 'rgba(93,211,158,0.12)', fontWeight: 600 } : {};
        return [
          h('td', { class: 'num', style: { borderLeft: '2px solid var(--border-strong)', ...bestStyle } },
            valid ? money(p) : h('span', { class: 'muted' }, '—')),
          h('td', { class: 'num', style: bestStyle },
            valid ? money(importe) : h('span', { class: 'muted' }, '—')),
          h('td', { class: 'num ' + ahorroColor }, ahorro != null ? pct(ahorro) : '—')
        ];
      })
    ]);
  }).filter(Boolean);

  // Fila de totales
  const totalRow = h('tr', { style: { fontWeight: 600, background: 'var(--bg-2)', borderTop: '2px solid var(--border-strong)' } }, [
    h('td', { colSpan: 4 }, 'TOTALES'),
    h('td', { class: 'num', style: { background: 'var(--bg-3)' } }, ''),
    h('td', { class: 'num', style: { background: 'var(--bg-3)' } }, money(totalCatalogo)),
    ...licsArr.flatMap(lic => {
      const t = totalesLic[lic.id];
      const ahorro = totalCatalogo > 0 ? (totalCatalogo - t) / totalCatalogo : null;
      const c = ahorro == null ? '' : (ahorro > 0 ? 'ok' : 'warn');
      return [
        h('td', { class: 'num', style: { borderLeft: '2px solid var(--border-strong)' } }, ''),
        h('td', { class: 'num' }, money(t)),
        h('td', { class: 'num ' + c }, ahorro != null ? pct(ahorro) : '—')
      ];
    })
  ]);

  const table = h('div', { style: { overflow: 'auto' } }, h('table', { class: 'tbl', style: { fontSize: '12px', minWidth: '100%' } }, [thead, h('tbody', {}, [...rows, totalRow])]));

  return h('div', {}, [head, h('div', { class: 'card', style: { padding: 0, overflow: 'hidden' } }, table)]);
}

async function addLicitanteDialog(obraId, subId) {
  const nombre = h('input', { placeholder: 'Nombre o razón social', autofocus: true });
  const contacto = h('input', { placeholder: 'Persona de contacto' });
  const email = h('input', { type: 'email', placeholder: 'correo@empresa.com' });
  const telefono = h('input', { placeholder: 'Teléfono' });
  await modal({
    title: 'Nuevo licitante',
    body: h('div', {}, [
      h('div', { class: 'field' }, [h('label', {}, 'Nombre'), nombre]),
      h('div', { class: 'grid-2', style: { marginTop: '10px' } }, [
        h('div', { class: 'field' }, [h('label', {}, 'Contacto'), contacto]),
        h('div', { class: 'field' }, [h('label', {}, 'Teléfono'), telefono])
      ]),
      h('div', { class: 'field', style: { marginTop: '10px' } }, [h('label', {}, 'Email'), email]),
      h('div', { class: 'muted', style: { marginTop: '10px', fontSize: '12px' } }, 'Después podrás capturar sus precios cotizando concepto por concepto, o importando un XLSX que él/ella te haya devuelto.')
    ]),
    confirmLabel: 'Crear',
    onConfirm: async () => {
      if (!nombre.value.trim()) { toast('Nombre requerido', 'warn'); return false; }
      try {
        await addLicitante(obraId, subId, {
          nombre: nombre.value.trim(),
          contacto: contacto.value, email: email.value, telefono: telefono.value
        });
        toast('Licitante agregado', 'ok');
        dispatch();
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function editLicitanteDialog(obraId, subId, licId, lic, conceptosSub, conceptosAll) {
  const nombre = h('input', { value: lic.nombre || '' });
  const contacto = h('input', { value: lic.contacto || '' });
  const email = h('input', { type: 'email', value: lic.email || '' });
  const telefono = h('input', { value: lic.telefono || '' });
  const notas = h('textarea', { rows: 2, style: { width: '100%', resize: 'vertical' }, value: lic.notas || '' });

  // Tabla de precios editable
  const inputs = {};
  const tbody = h('tbody', {}, conceptosSub.map(cs => {
    const cat = conceptosAll[cs.conceptoId];
    if (!cat) return null;
    const cur = Number(lic.precios?.[cs.conceptoId]);
    const inp = h('input', { type: 'number', step: 'any', value: Number.isFinite(cur) && cur > 0 ? cur : '', style: { width: '100%', minWidth: '110px', textAlign: 'right' } });
    inputs[cs.conceptoId] = inp;
    return h('tr', {}, [
      h('td', { class: 'mono muted', style: { fontSize: '11px', whiteSpace: 'nowrap', verticalAlign: 'top' } }, cat.clave),
      h('td', { style: { fontSize: '12px', lineHeight: '1.4', minWidth: '300px', maxWidth: '500px', verticalAlign: 'top' } }, cat.descripcion || ''),
      h('td', { class: 'muted', style: { whiteSpace: 'nowrap', verticalAlign: 'top' } }, cat.unidad),
      h('td', { class: 'num muted', style: { whiteSpace: 'nowrap', verticalAlign: 'top' } }, num(cs.cantidadSub, 2)),
      h('td', { class: 'num muted', style: { fontSize: '11px', whiteSpace: 'nowrap', verticalAlign: 'top' } }, money(cat.precio_unitario)),
      h('td', { style: { verticalAlign: 'top' } }, inp)
    ]);
  }).filter(Boolean));

  const body = h('div', {}, [
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Nombre'), nombre]),
      h('div', { class: 'field' }, [h('label', {}, 'Contacto'), contacto])
    ]),
    h('div', { class: 'grid-2', style: { marginTop: '10px' } }, [
      h('div', { class: 'field' }, [h('label', {}, 'Email'), email]),
      h('div', { class: 'field' }, [h('label', {}, 'Teléfono'), telefono])
    ]),
    h('div', { class: 'field', style: { marginTop: '10px' } }, [h('label', {}, 'Notas'), notas]),
    h('h3', { style: { marginTop: '16px', marginBottom: '8px' } }, 'Precios cotizados'),
    h('div', { style: { maxHeight: '350px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: '6px' } },
      h('table', { class: 'tbl', style: { fontSize: '12px' } }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, 'Clave'), h('th', {}, 'Descripción'), h('th', {}, 'U.'),
          h('th', { class: 'num' }, 'Cant.'), h('th', { class: 'num' }, 'P.U. cat.'), h('th', { class: 'num' }, 'P.U. licit.')
        ])]),
        tbody
      ])
    )
  ]);

  await modal({
    title: 'Editar licitante: ' + (lic.nombre || ''),
    body, size: 'xl',
    confirmLabel: 'Guardar',
    onConfirm: async () => {
      try {
        const precios = {};
        for (const [cid, inp] of Object.entries(inputs)) {
          const v = Number(inp.value);
          if (Number.isFinite(v) && v > 0) precios[cid] = v;
        }
        await updateLicitante(obraId, subId, licId, {
          nombre: nombre.value.trim(),
          contacto: contacto.value, email: email.value, telefono: telefono.value,
          notas: notas.value
        });
        await setLicitantePrecios(obraId, subId, licId, precios);
        toast('Guardado', 'ok');
        dispatch();
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function deleteLicConfirm(obraId, subId, licId, nombre) {
  await modal({
    title: 'Borrar licitante', danger: true, confirmLabel: 'Borrar',
    body: h('div', {}, `Se borrará "${nombre || licId.slice(0, 6)}" con todos sus precios cotizados.`),
    onConfirm: async () => {
      await deleteLicitante(obraId, subId, licId);
      toast('Borrado', 'ok');
      dispatch();
      return true;
    }
  });
}

async function importLicitanteFlow(obraId, subId, sub) {
  const fileIn = h('input', { type: 'file', accept: '.xls,.xlsx', style: { display: 'none' } });
  document.body.appendChild(fileIn);
  fileIn.click();
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    fileIn.remove();
    if (!f) return;
    try {
      const conceptosAll = await rread(`obras/${obraId}/catalogo/conceptos`) || {};
      const result = await parseLicitanteXlsx(f, sub, conceptosAll);
      if (!result.precios || Object.keys(result.precios).length === 0) {
        toast('No se detectaron precios en el archivo', 'warn');
        return;
      }
      // Diálogo de confirmación: muestra qué se detectó y permite ajustar nombre
      const nombre = h('input', { value: result.nombre || f.name.replace(/\.[^.]+$/, ''), placeholder: 'Nombre del licitante' });
      const email = h('input', { value: result.email || '', placeholder: 'Email' });
      await modal({
        title: 'Importar licitante',
        body: h('div', {}, [
          h('div', { style: { marginBottom: '10px' } }, [
            h('span', { class: 'tag ok' }, `${Object.keys(result.precios).length} precio(s) detectado(s)`)
          ]),
          h('div', { class: 'field' }, [h('label', {}, 'Nombre'), nombre]),
          h('div', { class: 'field', style: { marginTop: '8px' } }, [h('label', {}, 'Email (opcional)'), email]),
          h('p', { class: 'muted', style: { fontSize: '12px', marginTop: '10px' } }, 'Si ya hay un licitante con este nombre, se actualizarán sus precios. Si no, se creará nuevo.')
        ]),
        confirmLabel: 'Importar',
        onConfirm: async () => {
          try {
            const targetName = nombre.value.trim() || 'Licitante';
            // Buscar licitante existente por nombre (case-insensitive)
            const lics = sub.licitantes || {};
            const existing = Object.entries(lics).find(([_, l]) => !l.archivado && (l.nombre || '').trim().toLowerCase() === targetName.toLowerCase());
            if (existing) {
              const [licId] = existing;
              await setLicitantePrecios(obraId, subId, licId, result.precios);
              await updateLicitante(obraId, subId, licId, { email: email.value || existing[1].email || '' });
              toast(`Precios actualizados para ${targetName}`, 'ok');
            } else {
              await addLicitante(obraId, subId, { nombre: targetName, email: email.value, precios: result.precios });
              toast(`Licitante "${targetName}" agregado`, 'ok');
            }
            dispatch();
            return true;
          } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
        }
      });
    } catch (err) { toast('Error al leer XLSX: ' + err.message, 'danger'); }
  });
}

async function editMetaDialog(obraId, subId, meta) {
  const nombre = h('input', { value: meta.nombre || '' });
  const descripcion = h('textarea', { rows: 2, value: meta.descripcion || '', style: { width: '100%', resize: 'vertical' } });
  await modal({
    title: 'Editar subcontrato',
    body: h('div', {}, [
      h('div', { class: 'field' }, [h('label', {}, 'Nombre'), nombre]),
      h('div', { class: 'field', style: { marginTop: '10px' } }, [h('label', {}, 'Descripción'), descripcion])
    ]),
    confirmLabel: 'Guardar',
    onConfirm: async () => {
      try {
        await updateSubcontratoMeta(obraId, subId, { nombre: nombre.value.trim(), descripcion: descripcion.value });
        toast('Guardado', 'ok');
        dispatch();
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

// =====================================================================
//                         TAB ADJUDICACIÓN
// =====================================================================

function renderAdjudicacion(obraId, subId, sub, conceptosAll, conceptosSub, licitantes, obra) {
  const meta = sub.meta || {};
  const adjudicadoId = meta.licitanteAdjudicadoId;
  const licsArr = Object.entries(licitantes).filter(([_, l]) => !l.archivado).map(([id, l]) => ({ id, ...l }));

  // Calcular totales por licitante para mostrar el ranking
  const ranking = licsArr.map(lic => {
    let total = 0, cotizados = 0;
    for (const cs of conceptosSub) {
      const p = Number(lic.precios?.[cs.conceptoId]);
      if (Number.isFinite(p) && p > 0) { total += p * (Number(cs.cantidadSub) || 0); cotizados++; }
    }
    return { ...lic, total, cotizados, completo: cotizados === conceptosSub.length };
  }).sort((a, b) => {
    if (a.completo !== b.completo) return a.completo ? -1 : 1;
    return a.total - b.total;
  });

  if (adjudicadoId) {
    const ganador = licitantes[adjudicadoId];
    if (!ganador) {
      return h('div', { class: 'card' }, [h('div', { class: 'empty' }, 'El licitante adjudicado fue borrado. Reabre la adjudicación.')]);
    }
    const totalGanador = ranking.find(l => l.id === adjudicadoId)?.total || 0;
    return h('div', {}, [
      h('div', { class: 'card', style: { background: 'rgba(93,211,158,0.08)', borderColor: 'var(--ok)' } }, [
        h('div', { class: 'row' }, [
          h('div', {}, [
            h('div', { class: 'tag ok' }, '✓ ADJUDICADO'),
            h('h2', { style: { margin: '8px 0 4px' } }, ganador.nombre),
            ganador.contacto && h('div', { class: 'muted', style: { fontSize: '13px' } }, [ganador.contacto, ganador.email && ' · ' + ganador.email, ganador.telefono && ' · ' + ganador.telefono])
          ]),
          h('div', { style: { flex: 1 } }),
          h('div', { style: { textAlign: 'right' } }, [
            h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Monto adjudicado'),
            h('div', { class: 'mono', style: { fontSize: '24px', fontWeight: 700, color: 'var(--accent)' } }, money(totalGanador)),
            h('div', { class: 'muted', style: { fontSize: '11px' } }, `Adjudicado el ${dateMx(meta.adjudicadoAt)}`)
          ])
        ]),
        h('div', { class: 'row', style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--border)' } }, [
          h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Ya puedes capturar estimaciones de avance del subcontratista para pagarle.'),
          h('div', { style: { flex: 1 } }),
          h('button', { class: 'btn primary', onClick: () => setTab(obraId, subId, TAB_ESTIMACIONES) }, 'Ir a estimaciones del sub →'),
          state.user.role === 'admin' && h('button', { class: 'btn ghost danger', onClick: () => desadjudicarConfirm(obraId, subId, ganador.nombre) }, 'Reabrir adjudicación')
        ])
      ])
    ]);
  }

  // Si no hay adjudicado: mostrar ranking de licitantes
  if (ranking.length === 0) {
    return h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '🏆'),
      'No hay licitantes registrados todavía. Agrégalos en la pestaña Licitantes.'
    ]);
  }

  const completos = ranking.filter(r => r.completo);
  return h('div', {}, [
    h('h2', { style: { margin: '0 0 8px' } }, 'Selecciona el licitante ganador'),
    h('p', { class: 'muted', style: { marginTop: 0, fontSize: '13px' } }, 'Solo licitantes con cotización completa pueden adjudicarse. Una vez adjudicado, se habilitan las estimaciones del subcontratista.'),
    h('div', { style: { display: 'grid', gap: '10px' } }, ranking.map((lic, idx) => h('div', {
      class: 'card',
      style: {
        padding: '14px',
        borderColor: idx === 0 && lic.completo ? 'var(--ok)' : 'var(--border)',
        opacity: lic.completo ? 1 : 0.6
      }
    }, [
      h('div', { class: 'row' }, [
        h('div', {}, [
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
            idx === 0 && lic.completo ? h('span', { class: 'tag ok' }, '★ MEJOR PRECIO') : '',
            h('h3', { style: { margin: 0, fontSize: '16px', textTransform: 'none', letterSpacing: 0 } }, lic.nombre)
          ]),
          h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, [
            `Cotizó ${lic.cotizados}/${conceptosSub.length} conceptos`,
            !lic.completo && ' · ⚠ Incompleto',
            lic.email && ` · ${lic.email}`
          ])
        ]),
        h('div', { style: { flex: 1 } }),
        h('div', { style: { textAlign: 'right' } }, [
          h('div', { class: 'mono', style: { fontSize: '20px', fontWeight: 600 } }, money(lic.total))
        ]),
        h('button', {
          class: 'btn primary',
          disabled: !lic.completo,
          style: { marginLeft: '14px' },
          onClick: () => adjudicarConfirm(obraId, subId, lic)
        }, 'Adjudicar')
      ])
    ])))
  ]);
}

async function adjudicarConfirm(obraId, subId, lic) {
  await modal({
    title: 'Adjudicar a ' + lic.nombre,
    body: h('div', {}, [
      h('p', {}, `¿Confirmas adjudicar este subcontrato a "${lic.nombre}" por ${money(lic.total || 0)}?`),
      h('p', { class: 'muted', style: { fontSize: '12px' } }, 'A partir de ahora podrás capturar estimaciones de avance del subcontratista para gestionar sus pagos.')
    ]),
    confirmLabel: 'Adjudicar',
    onConfirm: async () => {
      try {
        await adjudicarSubcontrato(obraId, subId, lic.id);
        toast(`Adjudicado a ${lic.nombre}`, 'ok');
        dispatch();
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function desadjudicarConfirm(obraId, subId, nombre) {
  await modal({
    title: 'Reabrir adjudicación', danger: true,
    body: h('div', {}, [
      h('p', {}, `Se desadjudicará "${nombre}" y el subcontrato volverá al estado "cotizando". Las estimaciones del sub se conservan pero quedarán huérfanas hasta una nueva adjudicación.`)
    ]),
    confirmLabel: 'Reabrir',
    onConfirm: async () => {
      await desadjudicarSubcontrato(obraId, subId);
      toast('Adjudicación reabierta', 'ok');
      dispatch();
      return true;
    }
  });
}

// =====================================================================
//                  TAB ESTIMACIONES DEL SUBCONTRATISTA
// =====================================================================

function renderSubEstimaciones(obraId, subId, sub, conceptosAll, conceptosSub, obra) {
  const meta = sub.meta || {};
  const m = obra.meta || {};
  const ivaPct = Number(m.ivaPct ?? 0.16);
  const adjudicadoId = meta.licitanteAdjudicadoId;
  if (!adjudicadoId) {
    return h('div', { class: 'empty' }, 'Primero adjudica el subcontrato en la pestaña Adjudicación.');
  }
  const ganador = sub.licitantes?.[adjudicadoId];
  const ests = sub.estimaciones || {};
  const estIds = Object.keys(ests).sort((a, b) => (ests[a].numero || 0) - (ests[b].numero || 0));

  const head = h('div', { class: 'row' }, [
    h('h2', { style: { margin: 0 } }, `Estimaciones del subcontratista`),
    h('span', { class: 'muted' }, ganador?.nombre || ''),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn primary', onClick: () => newSubEstimDialog(obraId, subId, ests) }, '+ Nueva estimación')
  ]);

  if (estIds.length === 0) {
    return h('div', {}, [head, h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '📋'),
      'Aún no hay estimaciones del subcontratista.'
    ])]);
  }

  // Calcular monto por estimación
  const totalsByEst = {};
  for (const eid of estIds) {
    const est = ests[eid];
    let subtotal = 0;
    for (const cs of conceptosSub) {
      const cant = Number(est.avances?.[cs.conceptoId]) || 0;
      const p = Number(ganador?.precios?.[cs.conceptoId]) || 0;
      subtotal += cant * p;
    }
    const iva = subtotal * ivaPct;
    totalsByEst[eid] = { subtotal, iva, importe: subtotal + iva, pago: est.pagoSub };
  }

  const table = h('table', { class: 'tbl' }, [
    h('thead', {}, [h('tr', {}, [
      h('th', {}, '#'), h('th', {}, 'Período'), h('th', {}, 'Estado'),
      h('th', { class: 'num' }, 'Subtotal'), h('th', { class: 'num' }, 'IVA'),
      h('th', { class: 'num' }, 'Importe'), h('th', { class: 'num' }, 'Pago al sub'),
      h('th', {}, '')
    ])]),
    h('tbody', {}, estIds.map(eid => {
      const e = ests[eid];
      const t = totalsByEst[eid];
      return h('tr', { onClick: () => navigate(`/obras/${obraId}/subcontratos/${subId}/estimaciones/${eid}`), style: { cursor: 'pointer' } }, [
        h('td', {}, h('b', {}, '#' + e.numero)),
        h('td', {}, [e.periodoIni ? dateMx(e.periodoIni) : '—', ' – ', e.periodoFin ? dateMx(e.periodoFin) : '—']),
        h('td', {}, e.estado === 'cerrada' ? h('span', { class: 'tag ok' }, '🔒 Cerrada') : h('span', { class: 'tag warn' }, '✎ Borrador')),
        h('td', { class: 'num' }, money(t.subtotal)),
        h('td', { class: 'num muted' }, money(t.iva)),
        h('td', { class: 'num' }, h('b', {}, money(t.importe))),
        h('td', { class: 'num' }, t.pago ? money(t.pago.importe) : h('span', { class: 'muted' }, '—')),
        h('td', { onClick: e2 => e2.stopPropagation() }, h('div', { class: 'row' }, [
          e.estado === 'borrador'
            ? h('button', { class: 'btn sm', onClick: () => cerrarSubEstConfirm(obraId, subId, eid, e.numero) }, '🔒')
            : (state.user.role === 'admin' ? h('button', { class: 'btn sm ghost', onClick: () => reabrirSubEstConfirm(obraId, subId, eid, e.numero) }, '↺') : null),
          h('button', { class: 'btn sm danger ghost', onClick: () => deleteSubEstConfirm(obraId, subId, eid, e.numero) }, '✕')
        ]))
      ]);
    }))
  ]);

  // Resumen acumulado
  const totalSubtotal = Object.values(totalsByEst).reduce((s, t) => s + t.subtotal, 0);
  const totalImporte = Object.values(totalsByEst).reduce((s, t) => s + t.importe, 0);
  const totalPagado = Object.values(totalsByEst).reduce((s, t) => s + (t.pago?.importe || 0), 0);
  const totalContrato = Object.values(sub.licitantes?.[adjudicadoId]?.precios || {})
    .reduce((s, p, i) => s + (Number(p) || 0) * (Number(conceptosSub[i]?.cantidadSub) || 0), 0);
  // Mejor: recalculamos por concepto correctamente
  let totalContratoCorrecto = 0;
  for (const cs of conceptosSub) {
    const p = Number(ganador?.precios?.[cs.conceptoId]) || 0;
    totalContratoCorrecto += p * (Number(cs.cantidadSub) || 0);
  }

  const summary = h('div', { class: 'card' }, [
    h('div', { class: 'grid-4' }, [
      kv('Contrato del sub (subtotal)', money(totalContratoCorrecto)),
      kv('Estimado acumulado (subtotal)', money(totalSubtotal)),
      kv('Importe acumulado (c/IVA)', money(totalImporte)),
      kv('Pagado al sub', money(totalPagado))
    ])
  ]);

  return h('div', {}, [head, summary, table]);
}

async function newSubEstimDialog(obraId, subId, ests) {
  const next = Math.max(0, ...Object.values(ests).map(e => e.numero || 0)) + 1;
  const periodoIni = h('input', { type: 'date' });
  const periodoFin = h('input', { type: 'date' });
  const fechaCorte = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  await modal({
    title: `Nueva estimación del sub #${next}`,
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
        const eid = await createSubEstimacion(obraId, subId, {
          periodoIni: periodoIni.value ? new Date(periodoIni.value).getTime() : null,
          periodoFin: periodoFin.value ? new Date(periodoFin.value).getTime() : null,
          fechaCorte: fechaCorte.value ? new Date(fechaCorte.value).getTime() : Date.now()
        });
        toast('Estimación del sub creada', 'ok');
        navigate(`/obras/${obraId}/subcontratos/${subId}/estimaciones/${eid}`);
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function cerrarSubEstConfirm(obraId, subId, eid, num) {
  await modal({
    title: `Cerrar estimación del sub #${num}`,
    body: h('div', {}, 'Una vez cerrada, no se podrán modificar avances ni el pago al sub. El admin puede reabrirla.'),
    confirmLabel: 'Cerrar',
    onConfirm: async () => { await cerrarSubEstimacion(obraId, subId, eid, state.user.uid); toast('Cerrada', 'ok'); dispatch(); return true; }
  });
}
async function reabrirSubEstConfirm(obraId, subId, eid, num) {
  await modal({
    title: `Reabrir estimación del sub #${num}`, danger: true,
    body: h('div', {}, 'Permitirá editar nuevamente.'),
    confirmLabel: 'Reabrir',
    onConfirm: async () => { await reabrirSubEstimacion(obraId, subId, eid); toast('Reabierta', 'ok'); dispatch(); return true; }
  });
}
async function deleteSubEstConfirm(obraId, subId, eid, num) {
  await modal({
    title: `Borrar estimación del sub #${num}`, danger: true,
    body: h('div', {}, 'Se perderá toda la captura de avances y el pago registrado. Esta acción no se puede deshacer.'),
    confirmLabel: 'Borrar',
    onConfirm: async () => { await deleteSubEstimacion(obraId, subId, eid); toast('Borrada', 'ok'); dispatch(); return true; }
  });
}

function kv(label, val) { return h('div', { class: 'field' }, [h('label', {}, label), h('div', {}, val ?? '—')]); }

function crumbs(obraId, nombre, subId, subNombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Subcontratos', to: `/obras/${obraId}/subcontratos` },
    { label: subNombre || (subId || '').slice(0, 6) }
  ];
}
