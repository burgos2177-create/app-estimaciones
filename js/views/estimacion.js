import { h, modal, toast } from '../util/dom.js';
import { renderShell } from './shell.js';
import { loadObra, getConceptoById, resolveConceptoKeyLocal, createGenerador, setAvance, deleteGenerador, moveGenerador, moverGeneradoresAEstimacion, setEstimacionProyeccion, setGeneradorProyeccion, setAvanceObra } from '../services/db.js';
import { state } from '../state/store.js';
import { navigate } from '../state/router.js';
import { money, dateMx, num, num0, pct } from '../util/format.js';
import { calcGeneradorTotal, PLANTILLAS } from '../services/plantillas.js';
import { exportEstimacionPdf, computeAvanceObra } from '../services/export.js';

export async function renderEstimacion({ params }) {
  const obraId = params.id;
  const estId = params.estid;

  renderShell(crumbs(obraId, '...', estId), h('div', { class: 'empty' }, 'Cargando…'));

  const obra = await loadObra(obraId);
  if (!obra) { renderShell(crumbs(obraId, '?', estId), h('div', { class: 'empty' }, 'Obra no encontrada.')); return; }
  const m = obra.meta || {};
  const est = obra.estimaciones?.[estId];
  if (!est) { renderShell(crumbs(obraId, m.nombre, estId), h('div', { class: 'empty' }, 'Estimación no encontrada.')); return; }

  // Republica el avance a /shared para bitácora (excluye proyección). Fire-and-forget.
  // Cubre el caso de togglear proyección aquí sin abrir el RESUMEN.
  try { const s = computeAvanceObra(obra); if (s) setAvanceObra(obraId, s); } catch {}

  const conceptos = obra.catalogo?.conceptos || {};
  const generadores = obra.generadores || {};
  const avances = obra.avances || {};
  const editable = est.estado === 'borrador';

  const gensInEstim = Object.entries(generadores)
    .filter(([_, g]) => g.estimacionId === estId)
    .sort((a, b) => (a[1].numero || 0) - (b[1].numero || 0));

  async function borrarGeneradorFlow(gid, numero, c) {
    const ok = await modal({
      title: 'Borrar generador', danger: true, confirmLabel: 'Borrar',
      body: h('div', {}, [
        h('p', {}, `Se borrará el generador #${numero}${c?.clave ? ' (' + c.clave + ')' : ''} y sus mediciones.`),
        h('p', { class: 'muted', style: { fontSize: '12px' } }, 'Los generadores siguientes de esta estimación se renumeran automáticamente (sin huecos).')
      ])
    });
    if (!ok) return;
    try {
      await deleteGenerador(obraId, gid);
      toast('Generador borrado', 'ok');
      renderEstimacion({ params: { id: obraId, estid: estId } });
    } catch (err) { toast('Error: ' + err.message, 'danger'); }
  }

  // Trae generadores de otra estimación a esta. Pensado para la proyección que
  // se dejó armada en el periodo pasado y que en realidad se ejecutó en este:
  // en vez de recapturar las mediciones, se mueve el generador tal cual.
  async function traerDeOtraEstimacionFlow() {
    const otras = Object.entries(obra.estimaciones || {})
      .filter(([id]) => id !== estId)
      .map(([id, e]) => ({ id, ...e }))
      .sort((a, b) => (b.numero || 0) - (a.numero || 0));
    if (!otras.length) { toast('No hay otra estimación de dónde traer', 'warn'); return; }

    const sel = h('select', { style: { width: '100%' } }, otras.map(e =>
      h('option', { value: e.id }, `Estimación #${e.numero}${e.esProyeccion ? ' · 🔮 proyección' : ''}${e.estado === 'cerrada' ? ' · cerrada' : ''}`)));
    const limpiar = h('input', { type: 'checkbox' }); limpiar.checked = true;
    const lista = h('div', { style: { maxHeight: '320px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: '6px' } });
    const resumen = h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } });
    const seleccion = new Set();

    function pintarLista() {
      const origen = obra.estimaciones?.[sel.value] || {};
      const gens = Object.entries(generadores)
        .filter(([, g]) => g.estimacionId === sel.value)
        .sort((a, b) => (a[1].numero || 0) - (b[1].numero || 0));
      seleccion.clear();
      lista.innerHTML = '';
      if (!gens.length) {
        lista.appendChild(h('div', { class: 'muted', style: { padding: '16px', textAlign: 'center' } }, 'Esa estimación no tiene generadores.'));
        actualizarResumen(0); return;
      }
      for (const [gid, g] of gens) {
        const c = getConceptoById(obra, g.conceptoId) || {};
        const proy = !!(g.esProyeccion || origen.esProyeccion);
        const cb = h('input', { type: 'checkbox' });
        cb.checked = proy;                       // por defecto, solo lo de proyección
        if (proy) seleccion.add(gid);
        cb.addEventListener('change', () => {
          if (cb.checked) seleccion.add(gid); else seleccion.delete(gid);
          actualizarResumen();
        });
        lista.appendChild(h('label', { class: 'row', style: { padding: '8px 10px', borderBottom: '1px solid var(--border)', alignItems: 'flex-start', cursor: 'pointer' } }, [
          cb,
          h('div', { style: { flex: 1, minWidth: 0 } }, [
            h('div', { style: { fontSize: '12px' } }, [
              h('b', {}, `Gen ${g.numero || '?'}`),
              h('span', { class: 'mono muted', style: { marginLeft: '8px' } }, c.clave || ''),
              proy && h('span', { class: 'tag muted', style: { marginLeft: '6px' } }, '🔮')
            ]),
            h('div', { class: 'desc', style: { fontSize: '12px' } }, c.descripcion || ''),
            h('div', { class: 'muted', style: { fontSize: '11px' } },
              `${num((g.partidas || []).length, 0)} partida(s) · ${num(calcGeneradorTotal(c, g), 2)} ${c.unidad || ''}`)
          ])
        ]));
      }
      actualizarResumen();
    }
    function actualizarResumen() {
      const origen = obra.estimaciones?.[sel.value] || {};
      resumen.innerHTML = '';
      resumen.appendChild(h('span', {}, `${seleccion.size} generador(es) seleccionado(s).`));
      if (origen.estado === 'cerrada') {
        resumen.appendChild(h('div', { class: 'warn', style: { marginTop: '4px' } },
          `⚠ La estimación #${origen.numero} está cerrada. Mover algo que SÍ contaba cambiaría sus cifras ya cerradas; lo de proyección no, porque nunca contó.`));
      }
    }
    sel.addEventListener('change', pintarLista);
    pintarLista();

    const ok = await modal({
      title: `Traer generadores a la estimación #${est.numero}`,
      confirmLabel: 'Traer a esta estimación',
      body: h('div', {}, [
        h('p', { class: 'muted', style: { fontSize: '12px', marginTop: 0 } }, 'Mueve generadores completos (con sus mediciones, croquis y fotos) de otra estimación a esta. Útil cuando lo que dejaste proyectado en un periodo se terminó ejecutando en este.'),
        h('div', { class: 'field' }, [h('label', {}, 'Traer desde'), sel]),
        h('div', { style: { marginTop: '10px' } }, lista),
        resumen,
        h('label', { class: 'row', style: { marginTop: '10px', fontSize: '12px' } }, [limpiar, h('span', {}, 'Quitarles la marca de proyección (ya se ejecutaron de verdad)')]),
        h('p', { class: 'muted', style: { fontSize: '11px', marginTop: '8px' } }, 'Ambas estimaciones se renumeran 1..N sin huecos. Los traídos se agregan al final de esta.')
      ]),
      onConfirm: () => { if (!seleccion.size) { toast('Selecciona al menos un generador', 'warn'); return false; } return true; }
    });
    if (!ok) return;
    try {
      const n = await moverGeneradoresAEstimacion(obraId, [...seleccion], estId, { limpiarProyeccion: limpiar.checked });
      toast(`${n} generador(es) movido(s) a esta estimación`, 'ok');
      renderEstimacion({ params: { id: obraId, estid: estId } });
    } catch (err) { toast('Error: ' + err.message, 'danger'); }
  }

  // Reordena un generador (dir=-1 sube, +1 baja) y renumera 1..N.
  async function moverGeneradorFlow(gid, dir) {
    try {
      await moveGenerador(obraId, gid, dir);
      renderEstimacion({ params: { id: obraId, estid: estId } });
    } catch (err) { toast('Error: ' + err.message, 'danger'); }
  }

  // Modo proyección: la estimación completa, o un generador, se marca como "no
  // cuenta" (escenario) y se excluye de los acumulados. Se alterna para ver con/sin.
  const estProyeccion = est.esProyeccion === true;
  async function toggleEstProyeccion() {
    try {
      await setEstimacionProyeccion(obraId, estId, !estProyeccion);
      renderEstimacion({ params: { id: obraId, estid: estId } });
    } catch (err) { toast('Error: ' + err.message, 'danger'); }
  }
  async function toggleGenProyeccion(gid, actual) {
    try {
      await setGeneradorProyeccion(obraId, gid, !actual);
      renderEstimacion({ params: { id: obraId, estid: estId } });
    } catch (err) { toast('Error: ' + err.message, 'danger'); }
  }

  // Subtotal calculado (excluye lo marcado como proyección para que cuadre con
  // los acumulados; la estimación-proyección igual muestra su total propio).
  let subtotal = 0;
  const generadoresRows = gensInEstim.map(([gid, g], idx) => {
    const c = getConceptoById(obra, g.conceptoId);
    const cant = c ? calcGeneradorTotal(c, g) : 0;
    const importe = cant * (c?.precio_unitario || 0);
    const genProy = g.esProyeccion === true;
    if (!genProy) subtotal += importe;
    const overrun = c && cant > (c.cantidad || 0);
    const noCuenta = genProy || estProyeccion;
    return h('tr', {
      class: overrun ? 'row-overrun' : '',
      style: { cursor: 'pointer', opacity: noCuenta ? '0.5' : '1' },
      onClick: () => navigate(`/obras/${obraId}/estimaciones/${estId}/generadores/${gid}`)
    }, [
      h('td', {}, h('b', {}, '#' + g.numero)),
      h('td', { class: 'mono muted' }, c?.clave || '?'),
      h('td', {}, h('div', { class: 'desc' }, c?.descripcion || '(concepto eliminado)')),
      h('td', { class: 'muted' }, c?.unidad || ''),
      h('td', { class: 'num' }, num(cant, 2)),
      h('td', { class: 'num muted' }, money(c?.precio_unitario)),
      h('td', { class: 'num' }, h('b', {}, money(importe))),
      h('td', { style: { whiteSpace: 'nowrap' } }, [
        genProy ? h('span', { class: 'tag', style: { borderColor: '#a06bd9', color: '#a06bd9' }, title: 'Este generador no cuenta en los acumulados' }, '🔮 proyección')
          : (overrun ? h('span', { class: 'tag warn' }, '⚠ sobreejec.') : h('span', { class: 'tag muted' }, PLANTILLAS[g.plantillaTipo]?.label || '—')),
        editable && h('button', {
          class: 'btn sm ghost', style: { marginLeft: '6px', color: genProy ? '#a06bd9' : '' },
          title: genProy ? 'Marcado como proyección — click para que SÍ cuente' : 'Marcar como proyección (no cuenta en acumulados)',
          onClick: (e) => { e.stopPropagation(); toggleGenProyeccion(gid, genProy); }
        }, '🔮'),
        editable && h('button', {
          class: 'btn sm ghost', style: { marginLeft: '6px' }, disabled: idx === 0,
          title: 'Subir (intercambia con el anterior)',
          onClick: (e) => { e.stopPropagation(); if (idx > 0) moverGeneradorFlow(gid, -1); }
        }, '↑'),
        editable && h('button', {
          class: 'btn sm ghost', disabled: idx === gensInEstim.length - 1,
          title: 'Bajar (intercambia con el siguiente)',
          onClick: (e) => { e.stopPropagation(); if (idx < gensInEstim.length - 1) moverGeneradorFlow(gid, 1); }
        }, '↓'),
        editable && h('button', {
          class: 'btn sm danger ghost',
          style: { marginLeft: '6px' },
          title: 'Borrar este generador (los siguientes se renumeran)',
          onClick: (e) => { e.stopPropagation(); borrarGeneradorFlow(gid, g.numero, c); }
        }, '🗑')
      ])
    ]);
  });

  // Avances sin generador. Comparamos por conceptoKey resuelto para que un
  // generador legacy y un avance con la misma identidad no se dupliquen.
  const conceptosUsadosConGen = new Set(
    gensInEstim.map(([_, g]) => resolveConceptoKeyLocal(obra, g.conceptoId)).filter(Boolean)
  );
  const avancesDirectos = [];
  for (const [cid, byEstim] of Object.entries(avances)) {
    const k = resolveConceptoKeyLocal(obra, cid);
    if (!k || conceptosUsadosConGen.has(k)) continue;
    const cant = Number(byEstim?.[estId]) || 0;
    if (!cant) continue;
    const c = conceptos[k];
    if (!c) continue;
    const importe = cant * (c.precio_unitario || 0);
    subtotal += importe;
    const overrun = cant > (c.cantidad || 0);
    avancesDirectos.push({ cid, c, cant, importe, overrun });
  }

  const ivaPct = Number(m.ivaPct ?? 0.16);
  const iva = subtotal * ivaPct;
  const importe = subtotal + iva;

  const head = h('div', { class: 'row' }, [
    h('h1', {}, `Estimación #${est.numero}`),
    h('div', {}, est.estado === 'cerrada'
      ? h('span', { class: 'tag ok' }, '🔒 Cerrada')
      : h('span', { class: 'tag warn' }, '✎ Borrador')),
    estProyeccion && h('span', { class: 'tag', style: { borderColor: '#a06bd9', color: '#a06bd9' }, title: 'Toda esta estimación es un escenario: no cuenta en F-1, RESUMEN ni ejecutado a catálogo' }, '🔮 Proyección (no cuenta)'),
    editable && h('button', {
      class: 'btn sm ' + (estProyeccion ? 'primary' : 'ghost'),
      title: estProyeccion ? 'Proyección activa: esta estimación no cuenta en acumulados. Click para volverla real.' : 'Marcar TODA la estimación como proyección (escenario que no cuenta en acumulados)',
      onClick: toggleEstProyeccion
    }, estProyeccion ? '🔮 Proyección: ON' : '🔮 Proyección'),
    h('div', { style: { flex: 1 } }),
    h('button', {
      class: 'btn',
      title: 'Generar documento ejecutivo de la estimación (PDF): avance, estado de cuenta y memoria de generadores',
      onClick: async (e) => {
        const btn = e.currentTarget;
        const prev = btn.textContent;
        btn.disabled = true; btn.textContent = '⏳ Generando…';
        try { await exportEstimacionPdf(obra, estId); }
        catch (err) { toast('Error: ' + err.message, 'danger'); }
        finally { btn.disabled = false; btn.textContent = prev; }
      }
    }, '⤓ PDF estimación'),
    editable && h('button', {
      class: 'btn',
      title: 'Mover generadores completos desde otra estimación (p. ej. lo que dejaste proyectado y se ejecutó en este periodo)',
      onClick: traerDeOtraEstimacionFlow
    }, '⇄ Traer de otra estimación'),
    editable && h('button', { class: 'btn primary', onClick: () => pickConceptoDialog(obra, obraId, estId, conceptos) }, '+ Nuevo generador'),
    editable && h('button', { class: 'btn', onClick: () => pickConceptoSinGenDialog(obra, obraId, estId, conceptos, avances) }, '+ Avance sin generador')
  ]);

  const summary = h('div', { class: 'card' }, [
    h('div', { class: 'grid-3' }, [
      kv('Período', `${est.periodoIni ? dateMx(est.periodoIni) : '—'} – ${est.periodoFin ? dateMx(est.periodoFin) : '—'}`),
      kv('Fecha de corte', est.fechaCorte ? dateMx(est.fechaCorte) : '—'),
      kv('Generadores', num0(gensInEstim.length))
    ]),
    h('div', { class: 'grid-3', style: { marginTop: '14px', paddingTop: '14px', borderTop: '1px solid var(--border)' } }, [
      kvNum('Subtotal', money(subtotal)),
      kvNum('IVA (' + pct(ivaPct) + ')', money(iva)),
      kvNum('Importe', money(importe), true)
    ])
  ]);

  const generadoresTable = gensInEstim.length === 0 && avancesDirectos.length === 0
    ? h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '📐'),
      'No hay generadores ni avances en esta estimación.',
      editable && h('div', { style: { marginTop: '12px' } }, 'Click en "+ Nuevo generador" para empezar.')
    ])
    : h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', {}, '#'), h('th', {}, 'Clave'), h('th', {}, 'Concepto'),
        h('th', {}, 'U.'), h('th', { class: 'num' }, 'Cantidad'),
        h('th', { class: 'num' }, 'P.U.'), h('th', { class: 'num' }, 'Importe'),
        h('th', {}, '')
      ])]),
      h('tbody', {}, [
        ...generadoresRows,
        ...avancesDirectos.map(({ cid, c, cant, importe, overrun }) => h('tr', {
          class: overrun ? 'row-overrun' : '',
          style: { cursor: 'pointer' },
          onClick: () => editAvanceDirectoDialog(obraId, estId, cid, c, cant, editable)
        }, [
          h('td', { class: 'muted' }, '—'),
          h('td', { class: 'mono muted' }, c.clave),
          h('td', {}, [h('div', { class: 'desc' }, c.descripcion), ' ', h('span', { class: 'tag muted' }, 'sin generador')]),
          h('td', { class: 'muted' }, c.unidad),
          h('td', { class: 'num' }, num(cant, 2)),
          h('td', { class: 'num muted' }, money(c.precio_unitario)),
          h('td', { class: 'num' }, h('b', {}, money(importe))),
          h('td', {}, overrun ? h('span', { class: 'tag warn' }, '⚠ sobreejec.') : '')
        ]))
      ])
    ]);

  renderShell(crumbs(obraId, m.nombre, estId, est.numero), h('div', {}, [head, summary, generadoresTable]));
}

function kv(label, val) { return h('div', { class: 'field' }, [h('label', {}, label), h('div', {}, val)]); }
function kvNum(label, val, big) { return h('div', { class: 'field' }, [
  h('label', {}, label),
  h('div', { class: 'num mono', style: big ? { fontSize: '20px', fontWeight: 600, color: 'var(--accent)' } : { fontSize: '15px' } }, val)
]); }

function crumbs(obraId, nombre, estId, num) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Estimaciones', to: `/obras/${obraId}/estimaciones` },
    { label: num != null ? '#' + num : (estId || '').slice(0, 6) }
  ];
}

async function pickConceptoDialog(obra, obraId, estId, conceptos) {
  const items = Object.entries(conceptos)
    .filter(([_, c]) => c.tipo === 'precio_unitario' && !c.archivado)
    .sort((a, b) => (a[1].orden || 0) - (b[1].orden || 0));
  if (items.length === 0) {
    toast('No hay conceptos en el catálogo. Importa el OPUS primero.', 'warn');
    return;
  }
  const search = h('input', { placeholder: 'Buscar clave o descripción…', autofocus: true });
  const list = h('div', { style: { maxHeight: '380px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: '6px' } });
  function rerender() {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = '';
    items
      .filter(([_, c]) => !q || c.clave?.toLowerCase().includes(q) || c.descripcion?.toLowerCase().includes(q))
      .slice(0, 200)
      .forEach(([cid, c]) => {
        list.appendChild(h('div', {
          style: { padding: '8px 10px', borderBottom: '1px solid var(--border)', cursor: 'pointer' },
          onClick: async () => {
            // cierra modal y arranca generador
            document.getElementById('modal-root').innerHTML = '';
            await startNewGenerador(obraId, estId, cid, c);
          }
        }, [
          h('div', { class: 'mono muted', style: { fontSize: '11px' } }, c.clave),
          h('div', {}, c.descripcion),
          h('div', { class: 'muted', style: { fontSize: '11px' } }, [
            c.unidad, ' · contratado: ', num(c.cantidad, 2), ' · ', money(c.precio_unitario),
            c.plantillaTipo ? ` · plantilla: ${c.plantillaTipo}` : ''
          ])
        ]));
      });
    if (!list.children.length) list.appendChild(h('div', { class: 'empty', style: { padding: '20px' } }, 'Sin resultados'));
  }
  search.addEventListener('input', rerender);
  rerender();

  await modal({
    title: 'Seleccionar concepto',
    body: h('div', {}, [search, h('div', { style: { height: '8px' } }), list]),
    confirmLabel: 'Cerrar',
    onConfirm: () => true
  });
}

async function startNewGenerador(obraId, estId, conceptoId, concepto) {
  if (!concepto.plantillaTipo) {
    const ok = await pickPlantillaDialog(obraId, conceptoId, concepto);
    if (!ok) return;
    // pickPlantillaDialog mutó concepto.plantillaTipo / plantillaConfig al guardar
  }
  try {
    const gid = await createGenerador(obraId, {
      conceptoId, estimacionId: estId,
      plantillaTipo: concepto.plantillaTipo,
      partidas: [],
      ajustes: [],
      totalEjecutado: 0,
      notas: '',
      createdBy: state.user.uid
    });
    navigate(`/obras/${obraId}/estimaciones/${estId}/generadores/${gid}`);
  } catch (err) { toast('Error: ' + err.message, 'danger'); }
}

export async function pickPlantillaDialog(obraId, conceptoId, concepto, pickOpts = {}) {
  const opts = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  let chosen = null;
  let customConfig = null;
  for (const [key, p] of Object.entries(PLANTILLAS)) {
    const card = h('div', {
      class: 'card',
      style: { padding: '12px', cursor: 'pointer', border: '1px solid var(--border)' },
      onClick: () => {
        opts.querySelectorAll('.card').forEach(c => c.style.borderColor = 'var(--border)');
        card.style.borderColor = 'var(--accent)';
        chosen = key;
        if (key === 'personalizado') customBuilder.classList.remove('hidden');
        else customBuilder.classList.add('hidden');
      }
    }, [
      h('div', { style: { fontWeight: 600 } }, p.label),
      h('div', { class: 'muted', style: { fontSize: '12px' } }, p.descripcion)
    ]);
    opts.appendChild(card);
  }
  const customBuilder = buildCustomPlantillaUI(cfg => customConfig = cfg);
  customBuilder.classList.add('hidden');

  const ok = await modal({
    title: pickOpts.title || `Plantilla para "${concepto.descripcion?.slice(0, 60) || ''}…"`,
    body: h('div', {}, [
      pickOpts.warning ? h('div', { class: 'card', style: { background: 'rgba(245,196,81,0.1)', borderColor: 'var(--warn)', marginBottom: '10px', fontSize: '12px', color: 'var(--text-1)' } }, pickOpts.warning) : null,
      h('p', { class: 'muted', style: { marginTop: 0, fontSize: '12px' } }, 'Esta plantilla se ligará al concepto y se usará en todos sus generadores.'),
      opts,
      customBuilder
    ]),
    confirmLabel: pickOpts.confirmLabel || 'Usar esta plantilla',
    onConfirm: async () => {
      if (!chosen) { toast('Elige una plantilla', 'warn'); return false; }
      if (chosen === 'personalizado') {
        if (!customConfig || !customConfig.columns?.length) { toast('Define al menos una columna', 'warn'); return false; }
        if (!customConfig.columns.some(c => c.factor)) { toast('Marca al menos una columna como factor', 'warn'); return false; }
      }
      const { setPlantillaConcepto } = await import('../services/db.js');
      await setPlantillaConcepto(obraId, conceptoId, chosen, chosen === 'personalizado' ? customConfig : null);
      // Mutamos el concepto en memoria para que el caller (startNewGenerador)
      // lea la plantilla recién seteada sin re-fetch.
      concepto.plantillaTipo = chosen;
      concepto.plantillaConfig = chosen === 'personalizado' ? customConfig : null;
      return true;
    }
  });
  return ok;
}

function buildCustomPlantillaUI(onChange) {
  const cols = [
    { key: 'col1', label: 'Columna 1', type: 'number', factor: true }
  ];
  function emit() { onChange({ columns: cols.map(c => ({ ...c })) }); }
  const wrap = h('div', { class: 'card', style: { marginTop: '8px' } }, [
    h('h3', {}, 'Columnas personalizadas')
  ]);
  const list = h('div', {});
  function rerender() {
    list.innerHTML = '';
    cols.forEach((c, i) => {
      const labelIn = h('input', { value: c.label, placeholder: 'Etiqueta', oninput: e => { c.label = e.target.value; c.key = slug(e.target.value) + '_' + i; emit(); } });
      const typeSel = h('select', { onchange: e => { c.type = e.target.value; if (c.type === 'text') c.factor = false; rerender(); emit(); } }, [
        h('option', { value: 'number', selected: c.type === 'number' }, 'Número'),
        h('option', { value: 'text', selected: c.type === 'text' }, 'Texto')
      ]);
      const factorIn = h('input', { type: 'checkbox', checked: c.factor, disabled: c.type !== 'number', onchange: e => { c.factor = e.target.checked; emit(); } });
      const del = h('button', { class: 'btn sm danger ghost', onClick: () => { cols.splice(i, 1); rerender(); emit(); } }, '✕');
      list.appendChild(h('div', { class: 'row', style: { padding: '6px 0', borderBottom: '1px solid var(--border)' } }, [
        labelIn, typeSel,
        h('label', { class: 'row' }, [factorIn, h('span', { class: 'muted', style: { fontSize: '11px' } }, 'multiplica')]),
        del
      ]));
    });
  }
  const addBtn = h('button', { class: 'btn sm', onClick: () => { cols.push({ label: 'Columna ' + (cols.length + 1), type: 'number', factor: true, key: 'col' + (cols.length + 1) }); rerender(); emit(); } }, '+ Columna');
  wrap.appendChild(list); wrap.appendChild(addBtn);
  rerender(); emit();
  return wrap;
}

function slug(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'col';
}

async function pickConceptoSinGenDialog(obra, obraId, estId, conceptos, avances) {
  // Mismo selector pero al confirmar pide cantidad directa
  const items = Object.entries(conceptos)
    .filter(([_, c]) => c.tipo === 'precio_unitario' && !c.archivado)
    .sort((a, b) => (a[1].orden || 0) - (b[1].orden || 0));
  const search = h('input', { placeholder: 'Buscar…', autofocus: true });
  const list = h('div', { style: { maxHeight: '380px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: '6px' } });
  function rerender() {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = '';
    items
      .filter(([_, c]) => !q || c.clave?.toLowerCase().includes(q) || c.descripcion?.toLowerCase().includes(q))
      .slice(0, 200)
      .forEach(([cid, c]) => {
        const cant = avances?.[cid]?.[estId] || 0;
        list.appendChild(h('div', {
          style: { padding: '8px 10px', borderBottom: '1px solid var(--border)', cursor: 'pointer' },
          onClick: async () => {
            document.getElementById('modal-root').innerHTML = '';
            await editAvanceDirectoDialog(obraId, estId, cid, c, cant, true);
          }
        }, [
          h('div', { class: 'mono muted', style: { fontSize: '11px' } }, c.clave),
          h('div', {}, c.descripcion),
          h('div', { class: 'muted', style: { fontSize: '11px' } }, [c.unidad, ' · contratado: ', num(c.cantidad, 2)])
        ]));
      });
  }
  search.addEventListener('input', rerender);
  rerender();
  await modal({
    title: 'Avance sin generador (captura directa)',
    body: h('div', {}, [
      h('p', { class: 'muted', style: { marginTop: 0, fontSize: '12px' } }, 'Para conceptos administrativos (pólizas, lumpsum, cuotas) que no requieren memoria de cálculo.'),
      search, h('div', { style: { height: '8px' } }), list
    ]),
    confirmLabel: 'Cerrar',
    onConfirm: () => true
  });
}

async function editAvanceDirectoDialog(obraId, estId, cid, c, cantInicial, editable) {
  if (!editable) {
    toast('La estimación está cerrada.', 'warn'); return;
  }
  const cantIn = h('input', { type: 'number', step: 'any', value: cantInicial || '' });
  await modal({
    title: 'Avance directo: ' + (c.clave || ''),
    body: h('div', {}, [
      h('div', { class: 'muted', style: { marginBottom: '8px' } }, c.descripcion),
      h('div', { class: 'field' }, [h('label', {}, `Cantidad ejecutada en esta estimación (${c.unidad || ''})`), cantIn]),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } }, [
        'Contratado: ', num(c.cantidad, 2), ' · P.U.: ', money(c.precio_unitario)
      ])
    ]),
    confirmLabel: 'Guardar',
    onConfirm: async () => {
      try {
        const cant = Number(cantIn.value) || 0;
        await setAvance(obraId, cid, estId, cant);
        toast('Avance guardado', 'ok');
        renderEstimacion({ params: { id: obraId, estid: estId } });
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}
