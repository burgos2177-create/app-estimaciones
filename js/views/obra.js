import { h, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import { rread, loadObra, updateObraMeta, reconcileCatalogo } from '../services/db.js';
import { parseOpusXLS } from '../services/opus-parser.js';
import { navigate } from '../state/router.js';
import { money, dateMx, num0, pct } from '../util/format.js';
import { initDrive, isConfigured as driveConfigured, isSignedIn as driveSignedIn,
         signIn as driveSignIn, signOut as driveSignOut } from '../services/drive.js';

export async function renderObra({ params }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId), h('div', { class: 'empty' }, 'Cargando obra…'));

  const obra = await loadObra(obraId);
  if (!obra) {
    renderShell(crumbs(obraId), h('div', { class: 'empty' }, 'Obra no encontrada.'));
    return;
  }

  const m = obra.meta || {};
  const numConceptos = obra.catalogo?.conceptos ? Object.keys(obra.catalogo.conceptos).length : 0;
  const numEsts = obra.estimaciones ? Object.keys(obra.estimaciones).length : 0;

  const headerCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Datos de la obra'),
    h('div', { class: 'grid-3' }, [
      kv('Nombre', m.nombre),
      kv('Contrato', m.contratoNo),
      kv('Cliente', m.cliente),
      kv('Constructora', m.construye),
      kv('Ubicación', `${m.ubicacion || ''}${m.municipio ? ', ' + m.municipio : ''}`),
      kv('Programa', m.programa),
      kv('Monto C/IVA', money(m.montoContratoCIVA)),
      kv('IVA', pct(m.ivaPct ?? 0.16)),
      kv('% Anticipo', pct(m.anticipoPct ?? 0)),
      kv('Período', `${m.fechaInicio ? dateMx(m.fechaInicio) : '—'} – ${m.fechaFin ? dateMx(m.fechaFin) : '—'}`)
    ]),
    h('div', { class: 'row', style: { marginTop: '12px' } }, [
      state.user.role === 'admin' && h('button', { class: 'btn ghost sm', onClick: () => editMetaDialog(obraId, m) }, 'Editar')
    ])
  ]);

  const catalogoCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Catálogo OPUS'),
    numConceptos === 0
      ? h('div', { class: 'empty' }, [
        h('div', {}, 'No hay catálogo cargado todavía.'),
        h('div', { style: { marginTop: '12px' } }, importButton(obraId))
      ])
      : h('div', {}, [
        h('div', { class: 'row' }, [
          h('div', {}, [h('b', {}, num0(numConceptos)), ' conceptos · ', h('span', { class: 'muted' }, obra.catalogo.sourceFileName || ''), ' · ', h('span', { class: 'muted' }, dateMx(obra.catalogo.importedAt))]),
          h('div', { style: { flex: 1 } }),
          h('button', { class: 'btn', onClick: () => navigate(`/obras/${obraId}/catalogo`) }, 'Ver catálogo'),
          importButton(obraId, true)
        ])
      ])
  ]);

  const numSubs = obra.subcontratos ? Object.keys(obra.subcontratos).length : 0;

  // Estado de Google Drive
  const driveStatusEl = h('span', {}, '');
  const driveBtn = h('button', { class: 'btn sm', onClick: async () => {
    if (driveSignedIn()) {
      driveSignOut();
      toast('Drive desconectado', 'ok');
    } else {
      try { await initDrive(); await driveSignIn(); toast('Drive conectado', 'ok'); }
      catch (err) { toast('Error: ' + err.message, 'danger'); return; }
    }
    refreshDriveStatus();
  }}, '');

  function refreshDriveStatus() {
    driveStatusEl.innerHTML = '';
    if (!driveConfigured()) {
      driveStatusEl.appendChild(h('span', { class: 'tag warn' }, '⚠ Drive no configurado'));
      driveBtn.style.display = 'none';
    } else if (driveSignedIn()) {
      driveStatusEl.appendChild(h('span', { class: 'tag ok' }, '✓ Drive conectado'));
      driveBtn.textContent = 'Desconectar';
      driveBtn.style.display = '';
    } else {
      driveStatusEl.appendChild(h('span', { class: 'tag muted' }, 'Drive desconectado'));
      driveBtn.textContent = 'Conectar Drive';
      driveBtn.style.display = '';
    }
  }
  refreshDriveStatus();
  // Inicializar Drive (si está configurado) para checar token persistido
  if (driveConfigured()) initDrive().then(refreshDriveStatus).catch(() => {});

  const driveCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Google Drive (croquis y fotos)'),
    h('div', { class: 'row' }, [
      driveStatusEl,
      h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Los croquis y fotos del sitio se guardan en tu Google Drive bajo "Estimaciones SGR"'),
      h('div', { style: { flex: 1 } }),
      driveBtn
    ])
  ]);

  const accionesCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Trabajo'),
    h('div', { class: 'row' }, [
      h('button', { class: 'btn', onClick: () => navigate(`/obras/${obraId}/estimaciones`) }, [`Estimaciones (${numEsts})`]),
      h('button', { class: 'btn', onClick: () => navigate(`/obras/${obraId}/f1`) }, 'F-1 / Concentrado'),
      h('button', { class: 'btn', onClick: () => navigate(`/obras/${obraId}/resumen`) }, 'RESUMEN / Estado de cuenta'),
      h('button', { class: 'btn', onClick: () => navigate(`/obras/${obraId}/subcontratos`) }, [`Subcontratos (${numSubs})`])
    ])
  ]);

  renderShell(crumbs(obraId, m.nombre), h('div', {}, [
    h('h1', {}, m.nombre || 'Obra'),
    headerCard,
    catalogoCard,
    driveCard,
    accionesCard
  ]));
}

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6) }
  ];
}

function kv(label, val) {
  return h('div', { class: 'field' }, [
    h('label', {}, label),
    h('div', {}, val || '—')
  ]);
}

function importButton(obraId, replace = false) {
  const fileIn = h('input', { type: 'file', accept: '.xls,.xlsx', style: { display: 'none' } });
  const btn = h('button', { class: 'btn ' + (replace ? 'ghost' : 'primary'), onClick: () => fileIn.click() }, replace ? 'Re-importar' : '↥ Importar OPUS (.xls/.xlsx)');
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    if (!f) return;
    try {
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Procesando…';
      const result = await parseOpusXLS(f);
      const ok = await confirmImport(result, replace);
      if (!ok) { btn.disabled = false; btn.textContent = replace ? 'Re-importar' : '↥ Importar OPUS'; return; }
      const merged = await reconcileCatalogo(obraId, result.conceptos, f.name);
      const finalCount = Object.keys(merged).length;
      const archivados = Object.values(merged).filter(c => c.archivado).length;
      const activos = finalCount - archivados;
      const dedupeados = result.conceptos.length - (activos);
      const partes = [`${activos} conceptos activos`];
      if (archivados > 0) partes.push(`${archivados} archivados (con generadores)`);
      if (dedupeados > 0) partes.push(`${dedupeados} duplicados omitidos`);
      toast(`Catálogo importado: ${partes.join(' · ')}`, 'ok');
      const fresh = await rread(`obras/${obraId}/meta`);
      await reconciliarMontoConCatalogo(obraId, fresh, result.totalPUs);
      renderObra({ params: { id: obraId } });
    } catch (err) {
      console.error(err);
      toast('Error al importar: ' + err.message, 'danger');
      btn.disabled = false; btn.textContent = replace ? 'Re-importar' : '↥ Importar OPUS';
    }
  });
  return h('span', {}, [btn, fileIn]);
}

async function reconciliarMontoConCatalogo(obraId, m, catalogTotal) {
  if (!catalogTotal) return;
  const ivaPct = Number(m.ivaPct ?? 0.16);
  const obraMonto = Number(m.montoContratoCIVA) || 0;

  const close = (a, b) => Math.abs(a - b) < Math.max(1, b * 0.005);
  const yaCuadraConIVA = obraMonto > 0 && close(catalogTotal * (1 + ivaPct), obraMonto);
  const yaCuadraSinIVA = obraMonto > 0 && close(catalogTotal, obraMonto);
  if (yaCuadraConIVA || yaCuadraSinIVA) return; // todo bien

  const montoSiSinIVA = catalogTotal * (1 + ivaPct);
  const montoSiConIVA = catalogTotal;

  const body = h('div', {}, [
    h('p', { class: 'muted', style: { marginTop: 0, fontSize: '13px' } },
      'El total del catálogo OPUS y el monto contrato registrado en la obra no coinciden. Indica si el catálogo viene con IVA o sin IVA para ajustar el monto de la obra.'),
    h('div', { class: 'card', style: { padding: '12px', background: 'var(--bg-2)' } }, [
      h('div', { class: 'row' }, [
        h('div', { class: 'muted' }, 'Total del catálogo:'),
        h('div', { class: 'mono', style: { fontWeight: 600, marginLeft: 'auto' } }, money(catalogTotal))
      ]),
      h('div', { class: 'row', style: { marginTop: '6px' } }, [
        h('div', { class: 'muted' }, 'Monto contrato (actual):'),
        h('div', { class: 'mono', style: { marginLeft: 'auto' } }, obraMonto ? money(obraMonto) : h('span', { class: 'muted' }, 'sin definir'))
      ]),
      h('div', { class: 'row', style: { marginTop: '6px' } }, [
        h('div', { class: 'muted' }, 'IVA aplicado:'),
        h('div', { class: 'mono', style: { marginLeft: 'auto' } }, pct(ivaPct))
      ])
    ])
  ]);

  // Render manualmente porque queremos 3 botones, no el modal estándar de 2.
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const close = (val) => { root.innerHTML = ''; resolve(val); };
    const card = h('div', { class: 'modal' }, [
      h('h2', {}, 'Ajustar monto del contrato'),
      body,
      h('div', { style: { marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '8px' } }, [
        h('button', {
          class: 'btn primary',
          onClick: async () => {
            await updateObraMeta(obraId, { montoContratoCIVA: montoSiSinIVA });
            toast(`Monto actualizado a ${money(montoSiSinIVA)} (catálogo + IVA)`, 'ok');
            close('sinIVA');
          }
        }, [
          h('div', { style: { fontWeight: 600 } }, 'Catálogo SIN IVA'),
          h('div', { style: { fontSize: '11px', opacity: 0.85 } }, `Calcular monto: ${money(catalogTotal)} × ${pct(1 + ivaPct)} = ${money(montoSiSinIVA)}`)
        ]),
        h('button', {
          class: 'btn',
          onClick: async () => {
            await updateObraMeta(obraId, { montoContratoCIVA: montoSiConIVA });
            toast(`Monto actualizado a ${money(montoSiConIVA)} (catálogo tal cual)`, 'ok');
            close('conIVA');
          }
        }, [
          h('div', { style: { fontWeight: 600 } }, 'Catálogo YA viene con IVA'),
          h('div', { style: { fontSize: '11px', opacity: 0.7 } }, `Establecer monto = ${money(montoSiConIVA)}`)
        ]),
        h('button', { class: 'btn ghost', onClick: () => close('keep') }, 'Conservar monto actual')
      ])
    ]);
    root.appendChild(h('div', { class: 'modal-backdrop', onClick: e => { if (e.target === e.currentTarget) close('keep'); } }, card));
  });
}

async function confirmImport(result, replace) {
  const { conceptos, totalPUs, totalRaices, warning } = result;
  const pus = conceptos.filter(c => c.tipo === 'precio_unitario').length;
  const grp = conceptos.filter(c => c.tipo === 'agrupador').length;
  const body = h('div', {}, [
    h('div', {}, [h('b', {}, conceptos.length), ' filas — ', pus, ' precios unitarios · ', grp, ' agrupadores']),
    h('div', { style: { marginTop: '8px' } }, [h('span', { class: 'muted' }, 'Σ PUs: '), money(totalPUs), ' · ', h('span', { class: 'muted' }, 'Σ raíces: '), money(totalRaices)]),
    warning && h('div', { class: 'tag warn', style: { marginTop: '10px', display: 'inline-block' } }, '⚠ ' + warning),
    replace && h('div', { style: { marginTop: '12px', color: 'var(--warn)' } }, '⚠ Re-import: se conservarán plantillas ya ligadas y generadores; los conceptos que ya no estén en el nuevo catálogo se marcarán como archivados.')
  ]);
  return await modal({ title: 'Confirmar importación', body, confirmLabel: replace ? 'Re-importar' : 'Importar' });
}

async function editMetaDialog(obraId, m) {
  const nombre = h('input', { value: m.nombre || '' });
  const contratoNo = h('input', { value: m.contratoNo || '' });
  const cliente = h('input', { value: m.cliente || '' });
  const construye = h('input', { value: m.construye || '' });
  const ubicacion = h('input', { value: m.ubicacion || '' });
  const municipio = h('input', { value: m.municipio || '' });
  const programa = h('select', {}, [
    h('option', { value: 'PRIVADO', selected: m.programa === 'PRIVADO' }, 'PRIVADO'),
    h('option', { value: 'PÚBLICO', selected: m.programa === 'PÚBLICO' }, 'PÚBLICO')
  ]);
  const monto = h('input', { type: 'number', step: '0.01', value: m.montoContratoCIVA ?? 0 });
  const ivaPct = h('input', { type: 'number', step: '0.0001', value: m.ivaPct ?? 0.16 });
  const anticipoPct = h('input', { type: 'number', step: '0.01', min: '0', max: '1', value: m.anticipoPct ?? 0 });
  const fI = h('input', { type: 'date', value: m.fechaInicio ? new Date(m.fechaInicio).toISOString().slice(0,10) : '' });
  const fF = h('input', { type: 'date', value: m.fechaFin ? new Date(m.fechaFin).toISOString().slice(0,10) : '' });

  const body = h('div', {}, [
    h('div', { class: 'field' }, [h('label', {}, 'Nombre'), nombre]),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Contrato'), contratoNo]),
      h('div', { class: 'field' }, [h('label', {}, 'Cliente'), cliente])
    ]),
    h('div', { class: 'field' }, [h('label', {}, 'Constructora'), construye]),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Ubicación'), ubicacion]),
      h('div', { class: 'field' }, [h('label', {}, 'Municipio'), municipio])
    ]),
    h('div', { class: 'grid-4' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Programa'), programa]),
      h('div', { class: 'field' }, [h('label', {}, 'Monto C/IVA'), monto]),
      h('div', { class: 'field' }, [h('label', {}, 'IVA'), ivaPct]),
      h('div', { class: 'field' }, [h('label', {}, '% Anticipo'), anticipoPct])
    ]),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Inicio'), fI]),
      h('div', { class: 'field' }, [h('label', {}, 'Fin'), fF])
    ])
  ]);

  await modal({
    title: 'Editar obra', body, confirmLabel: 'Guardar',
    onConfirm: async () => {
      await updateObraMeta(obraId, {
        nombre: nombre.value, contratoNo: contratoNo.value, cliente: cliente.value,
        construye: construye.value, ubicacion: ubicacion.value, municipio: municipio.value,
        programa: programa.value, montoContratoCIVA: Number(monto.value) || 0,
        ivaPct: Number(ivaPct.value) || 0.16,
        anticipoPct: Number(anticipoPct.value) || 0,
        fechaInicio: fI.value ? new Date(fI.value).getTime() : null,
        fechaFin: fF.value ? new Date(fF.value).getTime() : null
      });
      toast('Obra actualizada', 'ok');
      renderObra({ params: { id: obraId } });
      return true;
    }
  });
}
