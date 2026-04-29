// Galería de croquis y fotos de todos los generadores en una estimación.
// Filtros por tipo (croquis/foto) y por concepto. Click abre lightbox.

import { h, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { loadObra, getConceptoById } from '../services/db.js';
import { state } from '../state/store.js';
import { navigate } from '../state/router.js';
import { dateMx, num0 } from '../util/format.js';
import { initDrive, isConfigured as driveConfigured, isSignedIn as driveSignedIn,
         signIn as driveSignIn, getImageObjectUrl } from '../services/drive.js';

export async function renderGaleria({ params }) {
  const obraId = params.id;
  const estId = params.estid;

  renderShell(crumbs(obraId, '...', estId), h('div', { class: 'empty' }, 'Cargando galería…'));

  const obra = await loadObra(obraId);
  if (!obra) { renderShell(crumbs(obraId, '?', estId), h('div', { class: 'empty' }, 'Obra no encontrada.')); return; }
  const m = obra.meta || {};
  const est = obra.estimaciones?.[estId];
  if (!est) { renderShell(crumbs(obraId, m.nombre, estId), h('div', { class: 'empty' }, 'Estimación no encontrada.')); return; }
  const generadores = obra.generadores || {};

  // Reunir todos los adjuntos de generadores en esta estimación
  const items = [];
  for (const [gid, gen] of Object.entries(generadores)) {
    if (gen.estimacionId !== estId) continue;
    const concepto = getConceptoById(obra, gen.conceptoId) || {};
    for (const att of (gen.croquis || [])) {
      items.push({ ...att, kind: 'croquis', generadorId: gid, generadorNumero: gen.numero, conceptoId: gen.conceptoId, clave: concepto.clave || '?', descripcion: concepto.descripcion || '' });
    }
    for (const att of (gen.fotos || [])) {
      items.push({ ...att, kind: 'foto', generadorId: gid, generadorNumero: gen.numero, conceptoId: gen.conceptoId, clave: concepto.clave || '?', descripcion: concepto.descripcion || '' });
    }
  }

  // Inicializar Drive (necesario para descargar imágenes)
  if (driveConfigured()) initDrive().catch(() => {});

  // Filtros
  let filterKind = 'all';      // 'all' | 'croquis' | 'foto'
  let filterClave = '';        // '' = todos
  let search = '';

  const claves = [...new Set(items.map(i => i.clave))].sort();

  const head = h('div', { class: 'row' }, [
    h('h1', { style: { margin: 0 } }, 'Galería'),
    h('span', { class: 'muted' }, `Estimación #${est.numero}`),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn ghost', onClick: () => navigate(`/obras/${obraId}/estimaciones/${estId}`) }, '← Estimación'),
    h('button', { class: 'btn ghost', onClick: () => navigate(`/obras/${obraId}/resumen`) }, 'RESUMEN')
  ]);

  if (items.length === 0) {
    renderShell(crumbs(obraId, m.nombre, estId, est.numero),
      h('div', {}, [
        head,
        h('div', { class: 'empty' }, [
          h('div', { class: 'ico' }, '📷'),
          h('div', {}, 'Sin croquis ni fotos en esta estimación.'),
          h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } }, 'Sube imágenes desde el editor de cualquier generador.')
        ])
      ])
    );
    return;
  }

  if (!driveConfigured() || !driveSignedIn()) {
    renderShell(crumbs(obraId, m.nombre, estId, est.numero),
      h('div', {}, [
        head,
        h('div', { class: 'card' }, [
          h('div', { class: 'row' }, [
            h('span', { class: 'tag warn' }, '⚠ Drive no conectado'),
            h('span', { class: 'muted' }, `Hay ${items.length} archivo(s) en esta estimación, pero necesitas conectar Google Drive para verlos.`),
            h('div', { style: { flex: 1 } }),
            driveConfigured() && h('button', {
              class: 'btn primary', onClick: async () => {
                try { await initDrive(); await driveSignIn(); renderGaleria({ params }); }
                catch (err) { toast('Error: ' + err.message, 'danger'); }
              }
            }, 'Conectar Drive')
          ])
        ])
      ])
    );
    return;
  }

  // ===== Filtros UI =====
  const kindSelect = h('select', { onchange: e => { filterKind = e.target.value; rerender(); } }, [
    h('option', { value: 'all' }, `Todos (${items.length})`),
    h('option', { value: 'croquis' }, `Solo croquis (${items.filter(i => i.kind === 'croquis').length})`),
    h('option', { value: 'foto' }, `Solo fotos (${items.filter(i => i.kind === 'foto').length})`)
  ]);
  const claveSelect = h('select', { onchange: e => { filterClave = e.target.value; rerender(); } }, [
    h('option', { value: '' }, 'Todos los conceptos'),
    ...claves.map(c => h('option', { value: c }, c))
  ]);
  const searchIn = h('input', { placeholder: 'Buscar descripción…', oninput: e => { search = e.target.value.toLowerCase(); rerender(); } });

  const filtersCard = h('div', { class: 'card' }, [
    h('div', { class: 'row' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Tipo'), kindSelect]),
      h('div', { class: 'field' }, [h('label', {}, 'Concepto'), claveSelect]),
      h('div', { class: 'field', style: { flex: 1 } }, [h('label', {}, 'Búsqueda'), searchIn])
    ])
  ]);

  // ===== Grid de imágenes agrupadas por concepto =====
  const grid = h('div', {});

  function rerender() {
    const filtered = items.filter(i => {
      if (filterKind !== 'all' && i.kind !== filterKind) return false;
      if (filterClave && i.clave !== filterClave) return false;
      if (search && !i.descripcion.toLowerCase().includes(search) && !i.clave.toLowerCase().includes(search)) return false;
      return true;
    });
    // Agrupar por concepto
    const groups = new Map();
    for (const i of filtered) {
      const key = i.conceptoId;
      if (!groups.has(key)) groups.set(key, { clave: i.clave, descripcion: i.descripcion, items: [] });
      groups.get(key).items.push(i);
    }
    grid.innerHTML = '';
    if (filtered.length === 0) {
      grid.appendChild(h('div', { class: 'empty' }, 'Sin resultados con esos filtros.'));
      return;
    }
    for (const [_, group] of groups) {
      grid.appendChild(h('div', { class: 'card' }, [
        h('div', { class: 'row' }, [
          h('h3', { style: { margin: 0 } }, h('span', { class: 'mono' }, group.clave)),
          h('span', { class: 'muted', style: { fontSize: '12px' } }, group.descripcion)
        ]),
        h('div', { class: 'attach-grid' }, group.items.map(att => galleryThumb(att, filtered)))
      ]));
    }
  }

  function galleryThumb(att, all) {
    const imgEl = h('div', { class: 'attach-thumb', title: att.name }, '⏳');
    getImageObjectUrl(att.driveId)
      .then(url => { imgEl.innerHTML = ''; imgEl.appendChild(h('img', { src: url, alt: att.name })); })
      .catch(() => { imgEl.textContent = att.kind === 'foto' ? '📸' : '✏'; });
    return h('div', { class: 'attach-card', style: { cursor: 'zoom-in' }, onClick: () => openLightbox(att, all) }, [
      imgEl,
      h('div', { class: 'attach-name' }, [
        h('span', { class: 'tag muted', style: { fontSize: '10px', marginRight: '4px' } }, att.kind === 'foto' ? '📸' : '✏'),
        att.name
      ])
    ]);
  }

  rerender();

  renderShell(crumbs(obraId, m.nombre, estId, est.numero), h('div', {}, [
    head,
    h('div', { class: 'card' }, [
      h('div', { class: 'row' }, [
        h('div', {}, [h('span', { class: 'muted' }, 'Período: '), dateMx(est.periodoIni) + ' – ' + dateMx(est.periodoFin)]),
        h('div', { style: { flex: 1 } }),
        h('div', {}, [h('span', { class: 'muted' }, 'Total adjuntos: '), h('b', {}, num0(items.length))])
      ])
    ]),
    filtersCard,
    grid
  ]));
}

function openLightbox(att, all) {
  const idx = all.indexOf(att);
  let cur = idx >= 0 ? idx : 0;

  const root = document.getElementById('modal-root');
  const close = () => root.innerHTML = '';

  function render() {
    const item = all[cur];
    const imgEl = h('img', { src: '', alt: item.name, style: { maxWidth: '90vw', maxHeight: '78vh', objectFit: 'contain', borderRadius: '6px', background: '#000' } });
    getImageObjectUrl(item.driveId).then(url => imgEl.src = url).catch(() => {});

    const caption = h('div', { style: { color: 'white', textAlign: 'center', marginTop: '10px' } }, [
      h('div', { style: { fontWeight: 600 } }, item.name),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, [
        item.clave, ' · ', item.descripcion?.slice(0, 100), ' · ',
        h('span', { class: 'tag muted' }, item.kind === 'foto' ? '📸 foto' : '✏ croquis'),
        ' · ', `Generador #${item.generadorNumero}`
      ])
    ]);

    const counter = h('div', { style: { position: 'absolute', top: '20px', left: '20px', color: 'white', fontSize: '14px' } }, `${cur + 1} / ${all.length}`);
    const closeBtn = h('button', { class: 'btn ghost', style: { position: 'absolute', top: '14px', right: '20px', color: 'white', fontSize: '20px' }, onClick: close }, '✕');
    const prevBtn = h('button', { class: 'btn ghost', style: { position: 'absolute', top: '50%', left: '20px', transform: 'translateY(-50%)', color: 'white', fontSize: '24px', padding: '12px 16px' }, onClick: () => { cur = (cur - 1 + all.length) % all.length; render(); } }, '‹');
    const nextBtn = h('button', { class: 'btn ghost', style: { position: 'absolute', top: '50%', right: '20px', transform: 'translateY(-50%)', color: 'white', fontSize: '24px', padding: '12px 16px' }, onClick: () => { cur = (cur + 1) % all.length; render(); } }, '›');

    root.innerHTML = '';
    root.appendChild(h('div', {
      style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, flexDirection: 'column', padding: '40px' },
      onClick: e => { if (e.target === e.currentTarget) close(); }
    }, [closeBtn, counter, prevBtn, nextBtn, imgEl, caption]));
  }
  render();

  // Teclado
  function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    if (e.key === 'ArrowLeft') { cur = (cur - 1 + all.length) % all.length; render(); }
    if (e.key === 'ArrowRight') { cur = (cur + 1) % all.length; render(); }
  }
  document.addEventListener('keydown', onKey);
}

function crumbs(obraId, nombre, estId, num) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Estimaciones', to: `/obras/${obraId}/estimaciones` },
    { label: num != null ? '#' + num : (estId || '').slice(0, 6), to: `/obras/${obraId}/estimaciones/${estId}` },
    { label: 'Galería' }
  ];
}
