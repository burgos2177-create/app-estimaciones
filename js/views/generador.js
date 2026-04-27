import { h, mount, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { rread, saveGenerador, addGeneradorAttachment, removeGeneradorAttachment } from '../services/db.js';
import { state } from '../state/store.js';
import { navigate } from '../state/router.js';
import { money, num, num0, dateMx } from '../util/format.js';
import { getColumns, getCalcFn, calcGeneradorTotal, blankPartida, PLANTILLAS } from '../services/plantillas.js';
import { initDrive, isConfigured as driveConfigured, isSignedIn as driveSignedIn, signIn as driveSignIn,
         ensureFolderPath, uploadFile, deleteFile, getImageObjectUrl, safeFilename } from '../services/drive.js';

export async function renderGenerador({ params }) {
  const { id: obraId, estid: estId, gid } = params;

  renderShell([{ label: 'Obras', to: '/' }, { label: 'cargando…' }], h('div', { class: 'empty' }, 'Cargando…'));

  const obra = await rread(`obras/${obraId}`);
  const est = obra?.estimaciones?.[estId];
  const gen = obra?.generadores?.[gid];
  if (!obra || !est || !gen) {
    renderShell([{ label: 'Obras', to: '/' }], h('div', { class: 'empty' }, 'Generador no encontrado.'));
    return;
  }
  const concepto = obra.catalogo?.conceptos?.[gen.conceptoId];
  if (!concepto) {
    renderShell([{ label: 'Obras', to: '/' }], h('div', { class: 'empty' }, 'El concepto del catálogo ya no existe (¿re-importado y archivado?).'));
    return;
  }

  const editable = est.estado === 'borrador';
  const columns = getColumns(concepto) || [];
  const calc = getCalcFn(concepto);

  // estado local del editor (no se persiste hasta guardar)
  const work = {
    partidas: deepClone(gen.partidas || []),
    ajustes: deepClone(gen.ajustes || []),
    notas: gen.notas || '',
    croquisDriveId: gen.croquisDriveId || '',
    croquisUrl: gen.croquisUrl || '',
    dirty: false
  };

  const m = obra.meta || {};
  const breadcrumbs = [
    { label: 'Obras', to: '/' },
    { label: m.nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Estimaciones', to: `/obras/${obraId}/estimaciones` },
    { label: '#' + est.numero, to: `/obras/${obraId}/estimaciones/${estId}` },
    { label: 'Generador #' + gen.numero }
  ];

  const totalDisplay = h('span', { class: 'mono', style: { fontWeight: 700 } }, '0');
  const importeDisplay = h('span', { class: 'mono muted' }, money(0));
  const overrunBadge = h('span', {}, '');

  function recompute() {
    const total = calc ? work.partidas.reduce((s, p) => s + (calc(p) || 0), 0) : 0;
    const ajusteSum = work.ajustes.reduce((s, a) => s + (Number(a.cantidad) || 0), 0);
    const grand = total + ajusteSum;
    totalDisplay.textContent = num(grand, 4);
    importeDisplay.textContent = money(grand * (concepto.precio_unitario || 0));
    overrunBadge.innerHTML = '';
    if (concepto.cantidad && grand > concepto.cantidad) {
      overrunBadge.appendChild(h('span', { class: 'tag warn' }, `⚠ Sobreejecución: ${num(grand - concepto.cantidad, 2)} ${concepto.unidad || ''} arriba del contrato`));
    }
  }

  // ===== Header =====
  const headerCard = h('div', { class: 'card' }, [
    h('div', { class: 'row' }, [
      h('h3', { style: { margin: 0 } }, 'Concepto'),
      h('span', { class: 'tag muted' }, PLANTILLAS[gen.plantillaTipo]?.label || 'sin plantilla'),
      h('div', { style: { flex: 1 } }),
      !editable && h('span', { class: 'tag ok' }, '🔒 estim. cerrada')
    ]),
    h('div', { class: 'mono muted', style: { fontSize: '12px', marginTop: '8px' } }, concepto.clave),
    h('div', { style: { marginTop: '4px' } }, concepto.descripcion),
    h('div', { class: 'grid-3', style: { marginTop: '12px' } }, [
      kv('Unidad', concepto.unidad),
      kv('Cantidad contratada', num(concepto.cantidad, 2)),
      kv('P.U.', money(concepto.precio_unitario))
    ])
  ]);

  // ===== Partidas table =====
  const tbody = h('tbody');

  function renderPartidas() {
    tbody.innerHTML = '';
    work.partidas.forEach((p, idx) => tbody.appendChild(partidaRow(p, idx)));
    if (work.partidas.length === 0) {
      tbody.appendChild(h('tr', {}, [
        h('td', { colSpan: columns.length + 3, class: 'empty', style: { padding: '20px' } }, editable ? 'Sin partidas. Agrega la primera ↓' : 'Este generador no tiene partidas.')
      ]));
    }
    recompute();
  }

  function partidaRow(p, idx) {
    const cells = columns.map(col => {
      const inp = h('input', {
        type: col.type === 'number' ? 'number' : 'text',
        step: col.type === 'number' ? 'any' : null,
        value: p[col.key] ?? '',
        disabled: !editable,
        style: { width: '100%' }
      });
      inp.addEventListener('input', e => { p[col.key] = e.target.value; work.dirty = true; recompute(); rowTotalCell.textContent = num(calc(p) || 0, 4); markDirty(); });
      return h('td', {}, inp);
    });
    const rowTotalCell = h('td', { class: 'num mono' }, num(calc(p) || 0, 4));
    const obsIn = h('input', { value: p.observaciones || '', placeholder: 'Observaciones', disabled: !editable });
    obsIn.addEventListener('input', e => { p.observaciones = e.target.value; work.dirty = true; markDirty(); });
    const delBtn = editable && h('button', { class: 'btn sm danger ghost', onClick: () => { work.partidas.splice(idx, 1); work.dirty = true; renderPartidas(); markDirty(); } }, '✕');
    return h('tr', {}, [...cells, rowTotalCell, h('td', {}, obsIn), h('td', {}, delBtn)]);
  }

  const partidasTable = h('table', { class: 'tbl' }, [
    h('thead', {}, [h('tr', {}, [
      ...columns.map(c => h('th', { class: c.type === 'number' ? 'num' : '' }, c.label)),
      h('th', { class: 'num' }, 'Total'),
      h('th', {}, 'Observaciones'),
      h('th', {}, '')
    ])]),
    tbody
  ]);

  const partidasCard = h('div', { class: 'card' }, [
    h('div', { class: 'row' }, [
      h('h3', { style: { margin: 0 } }, 'Partidas de medición'),
      h('div', { style: { flex: 1 } }),
      editable && h('button', { class: 'btn sm', onClick: () => duplicateLastDialog() }, '⎘ Duplicar última'),
      editable && h('button', { class: 'btn primary sm', onClick: () => { work.partidas.push(blankPartida(columns)); work.dirty = true; renderPartidas(); markDirty(); } }, '+ Partida')
    ]),
    partidasTable
  ]);

  function duplicateLastDialog() {
    if (!work.partidas.length) { toast('No hay partidas para duplicar', 'warn'); return; }
    const last = work.partidas[work.partidas.length - 1];
    work.partidas.push({ ...last });
    work.dirty = true; renderPartidas(); markDirty();
  }

  // ===== Ajustes =====
  const ajustesBody = h('tbody');

  function renderAjustes() {
    ajustesBody.innerHTML = '';
    work.ajustes.forEach((a, idx) => {
      const etqIn = h('input', { value: a.etiqueta || '', placeholder: 'Concepto del ajuste (escuadras, desperdicio, traslapes…)', disabled: !editable });
      etqIn.addEventListener('input', e => { a.etiqueta = e.target.value; work.dirty = true; markDirty(); });
      const cantIn = h('input', { type: 'number', step: 'any', value: a.cantidad ?? '', disabled: !editable });
      cantIn.addEventListener('input', e => { a.cantidad = e.target.value; work.dirty = true; recompute(); markDirty(); });
      const del = editable && h('button', { class: 'btn sm danger ghost', onClick: () => { work.ajustes.splice(idx, 1); work.dirty = true; renderAjustes(); recompute(); markDirty(); } }, '✕');
      ajustesBody.appendChild(h('tr', {}, [
        h('td', {}, etqIn),
        h('td', { class: 'num' }, cantIn),
        h('td', {}, del)
      ]));
    });
    if (!work.ajustes.length) {
      ajustesBody.appendChild(h('tr', {}, [h('td', { colSpan: 3, class: 'muted', style: { padding: '12px', textAlign: 'center' } }, editable ? 'Sin ajustes. Útil para escuadras y traslapes en aceros, desperdicio, etc.' : 'Sin ajustes.')]));
    }
  }
  const ajustesTable = h('table', { class: 'tbl' }, [
    h('thead', {}, [h('tr', {}, [h('th', {}, 'Concepto'), h('th', { class: 'num' }, 'Cantidad'), h('th', {}, '')])]),
    ajustesBody
  ]);
  const ajustesCard = h('div', { class: 'card' }, [
    h('div', { class: 'row' }, [
      h('h3', { style: { margin: 0 } }, 'Ajustes'),
      h('div', { style: { flex: 1 } }),
      editable && h('button', { class: 'btn sm', onClick: () => { work.ajustes.push({ etiqueta: '', cantidad: '' }); work.dirty = true; renderAjustes(); markDirty(); } }, '+ Ajuste')
    ]),
    ajustesTable
  ]);

  // ===== Notas =====
  const notasIn = h('textarea', { rows: 3, disabled: !editable, style: { width: '100%', resize: 'vertical' }, value: work.notas, placeholder: 'Observaciones del generador…' });
  notasIn.addEventListener('input', e => { work.notas = e.target.value; work.dirty = true; markDirty(); });

  const notasCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Notas'),
    h('div', { class: 'field' }, [h('label', {}, ''), notasIn])
  ]);

  // ===== Croquis y fotos del sitio (Google Drive) =====
  // Garantizamos arrays
  if (!Array.isArray(gen.croquis)) gen.croquis = [];
  if (!Array.isArray(gen.fotos)) gen.fotos = [];

  const croquisCard = buildAttachmentsCard({
    title: 'Croquis del concepto',
    descripcion: 'Dibujos o esquemas que respaldan la medición.',
    kind: 'croquis',
    obraId, gid, obra, est, gen, concepto, editable
  });
  const fotosCard = buildAttachmentsCard({
    title: 'Fotos del sitio',
    descripcion: 'Evidencia fotográfica de los trabajos ejecutados.',
    kind: 'fotos',
    obraId, gid, obra, est, gen, concepto, editable
  });

  // ===== Footer / save bar =====
  const dirtyTag = h('span', { class: 'tag warn hidden' }, '● cambios sin guardar');
  function markDirty() { if (work.dirty) dirtyTag.classList.remove('hidden'); else dirtyTag.classList.add('hidden'); }

  const saveBtn = editable && h('button', { class: 'btn primary', onClick: doSave }, '💾 Guardar generador');
  async function doSave() {
    if (!work.dirty) { toast('Nada que guardar', 'warn'); return; }
    saveBtn.disabled = true; saveBtn.innerHTML = '<span class="spinner"></span> Guardando…';
    try {
      const total = calcGeneradorTotal(concepto, { partidas: work.partidas, ajustes: work.ajustes });
      // Limpia partidas antes de guardar (números a Number, vacíos a null/'')
      const clean = work.partidas.map(p => {
        const o = {};
        for (const c of columns) o[c.key] = c.type === 'number' ? (p[c.key] === '' || p[c.key] == null ? null : Number(p[c.key])) : (p[c.key] || '');
        if (p.observaciones) o.observaciones = p.observaciones;
        return o;
      });
      const cleanAj = work.ajustes
        .filter(a => (a.etiqueta && a.etiqueta.trim()) || a.cantidad)
        .map(a => ({ etiqueta: a.etiqueta || '', cantidad: Number(a.cantidad) || 0 }));
      await saveGenerador(obraId, gid, {
        partidas: clean,
        ajustes: cleanAj,
        notas: work.notas || '',
        croquisDriveId: work.croquisDriveId || '',
        croquisUrl: work.croquisUrl || '',
        totalEjecutado: total
      });
      work.dirty = false; markDirty();
      toast('Generador guardado', 'ok');
    } catch (err) {
      console.error(err);
      toast('Error al guardar: ' + err.message, 'danger');
    } finally {
      saveBtn.disabled = false; saveBtn.innerHTML = '💾 Guardar generador';
    }
  }

  // Confirma navegación si hay cambios
  window.addEventListener('beforeunload', warnIfDirty, { once: false });
  function warnIfDirty(e) { if (work.dirty) { e.preventDefault(); e.returnValue = ''; } }

  const totalsCard = h('div', { class: 'card' }, [
    h('div', { class: 'row' }, [
      h('div', {}, [
        h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Total ejecutado'),
        h('div', { style: { fontSize: '24px', fontWeight: 700 } }, [totalDisplay, ' ', h('span', { class: 'muted', style: { fontSize: '14px', fontWeight: 400 } }, concepto.unidad || '')])
      ]),
      h('div', { style: { flex: 1 } }),
      h('div', { class: 'txt-r' }, [
        h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Importe'),
        h('div', { style: { fontSize: '20px' } }, importeDisplay)
      ])
    ]),
    h('div', { style: { marginTop: '8px' } }, overrunBadge)
  ]);

  const top = h('div', { class: 'row' }, [
    h('h1', { style: { margin: 0 } }, `Generador #${gen.numero}`),
    h('div', { class: 'muted' }, 'Estimación #' + est.numero),
    h('div', { style: { flex: 1 } }),
    dirtyTag,
    saveBtn
  ]);

  renderShell(breadcrumbs, h('div', {}, [
    top,
    headerCard,
    totalsCard,
    partidasCard,
    ajustesCard,
    croquisCard,
    fotosCard,
    notasCard
  ]));

  renderPartidas();
  renderAjustes();
  recompute();
}

function kv(label, val) { return h('div', { class: 'field' }, [h('label', {}, label), h('div', {}, val ?? '—')]); }

function deepClone(x) { return JSON.parse(JSON.stringify(x ?? null)) ?? (Array.isArray(x) ? [] : {}); }

// === Bloque para subir/listar adjuntos en Drive (croquis o fotos) ===
function buildAttachmentsCard({ title, descripcion, kind, obraId, gid, obra, est, gen, concepto, editable }) {
  const m = obra.meta || {};

  const list = h('div', { class: 'attach-grid' });
  const status = h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '6px' } });

  function refreshStatus() {
    status.innerHTML = '';
    if (!driveConfigured()) {
      status.appendChild(h('span', { class: 'tag warn' }, '⚠ Drive no configurado (falta clientId)'));
    } else if (!driveSignedIn()) {
      const btn = h('button', { class: 'btn sm primary', onClick: connectFlow }, 'Conectar Google Drive');
      status.appendChild(h('span', {}, [h('span', { class: 'tag muted' }, 'Drive desconectado'), ' ', btn]));
    } else {
      status.appendChild(h('span', { class: 'tag ok' }, '✓ Drive conectado'));
    }
  }

  async function connectFlow() {
    try { await initDrive(); await driveSignIn(); refreshStatus(); refreshList(); toast('Drive conectado', 'ok'); }
    catch (err) { toast('Error: ' + err.message, 'danger'); }
  }

  function thumbCell(att) {
    const img = h('div', { class: 'attach-thumb', title: att.name }, '⏳');
    // Cargar miniatura real (descarga vía API porque thumbnailLink requiere auth)
    if (driveSignedIn() && att.driveId) {
      getImageObjectUrl(att.driveId)
        .then(url => { img.innerHTML = ''; img.appendChild(h('img', { src: url, alt: att.name })); })
        .catch(() => { img.textContent = '🖼'; });
    } else {
      img.textContent = '🖼';
    }
    const actions = h('div', { class: 'attach-actions' }, [
      att.webViewLink && h('a', { href: att.webViewLink, target: '_blank', rel: 'noopener', class: 'btn sm ghost', title: 'Abrir en Drive' }, '↗'),
      editable && h('button', { class: 'btn sm danger ghost', title: 'Borrar', onClick: () => removeOne(att) }, '✕')
    ]);
    return h('div', { class: 'attach-card' }, [
      img,
      h('div', { class: 'attach-name' }, att.name),
      actions
    ]);
  }

  function refreshList() {
    list.innerHTML = '';
    const items = gen[kind] || [];
    if (items.length === 0) {
      list.appendChild(h('div', { class: 'attach-empty muted' }, 'Sin archivos.'));
    } else {
      items.forEach(att => list.appendChild(thumbCell(att)));
    }
  }

  async function uploadFlow() {
    if (!driveSignedIn()) { await connectFlow(); if (!driveSignedIn()) return; }
    const fileIn = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, style: { display: 'none' } });
    document.body.appendChild(fileIn);
    fileIn.click();
    fileIn.addEventListener('change', async () => {
      const files = [...(fileIn.files || [])];
      fileIn.remove();
      if (!files.length) return;
      try {
        const folderId = await ensureFolderPath([m.nombre, `Estimación ${est.numero}`]);
        for (const f of files) {
          const ext = (f.name.match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase();
          const existentes = (gen[kind] || []).length;
          const numero = existentes + 1;
          const filename = safeFilename(`${concepto.clave || 'sn'}-${kind === 'croquis' ? 'croquis' : 'foto'}-${numero}${ext}`);
          const meta = await uploadFile(f, folderId, filename);
          const att = {
            driveId: meta.id,
            name: meta.name,
            mimeType: meta.mimeType,
            size: Number(meta.size) || 0,
            webViewLink: meta.webViewLink || '',
            thumbnailLink: meta.thumbnailLink || '',
            uploadedAt: Date.now(),
            uploadedBy: state.user?.uid || ''
          };
          const updated = await addGeneradorAttachment(obraId, gid, kind, att);
          gen[kind] = updated;
        }
        refreshList();
        toast(`${files.length} archivo(s) subido(s)`, 'ok');
      } catch (err) {
        console.error(err);
        toast('Error al subir: ' + err.message, 'danger');
      }
    });
  }

  async function removeOne(att) {
    const ok = await modal({
      title: 'Borrar archivo', danger: true, confirmLabel: 'Borrar',
      body: h('div', {}, `Se borrará "${att.name}" de Google Drive y de la app. Esta acción no se puede deshacer.`),
      onConfirm: () => true
    });
    if (!ok) return;
    try {
      try { await deleteFile(att.driveId); } catch (e) { console.warn('No se pudo borrar de Drive:', e); }
      const updated = await removeGeneradorAttachment(obraId, gid, kind, att.driveId);
      gen[kind] = updated;
      refreshList();
      toast('Borrado', 'ok');
    } catch (err) { toast('Error: ' + err.message, 'danger'); }
  }

  refreshStatus();
  refreshList();

  const head = h('div', { class: 'row' }, [
    h('h3', { style: { margin: 0 } }, title),
    h('div', { class: 'muted', style: { fontSize: '12px', marginLeft: '8px' } }, descripcion),
    h('div', { style: { flex: 1 } }),
    editable && h('button', { class: 'btn sm primary', onClick: uploadFlow }, '↥ Subir')
  ]);

  return h('div', { class: 'card' }, [head, status, list]);
}
