export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class' || k === 'className') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
    else if (k in el && typeof el[k] !== 'function') el[k] = v;
    else el.setAttribute(k, v);
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(parent, children) {
  if (children == null || children === false) return;
  if (Array.isArray(children)) { children.forEach(c => appendChildren(parent, c)); return; }
  if (children instanceof Node) { parent.appendChild(children); return; }
  parent.appendChild(document.createTextNode(String(children)));
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

export function mount(rootSelector, node) {
  const root = typeof rootSelector === 'string' ? document.querySelector(rootSelector) : rootSelector;
  clear(root);
  root.appendChild(node);
  return root;
}

export function toast(msg, kind = '') {
  const root = document.getElementById('toast-root');
  if (!root.classList.contains('toast-root')) root.className = 'toast-root';
  const t = h('div', { class: `toast ${kind}` }, msg);
  root.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2700);
  setTimeout(() => t.remove(), 3100);
}

// Badge de estado del buzón para las vistas de estimaciones.
// Mapea todos los estados del nuevo esquema (recibido → cerrado).
export function buzonBadge(estado, item) {
  if (!estado) return null;
  const folio = item?.folio ? ` [${item.folio}]` : '';
  if (estado === 'recibido' || estado === 'pendiente')
    return h('span', { class: 'tag warn', style: { marginLeft: '6px' }, title: 'En espera de revisión por el contador.' }, `⏳ Recibido${folio}`);
  if (estado === 'en_revision')
    return h('span', { class: 'tag warn', style: { marginLeft: '6px', borderColor: '#5b9ef2', color: '#5b9ef2' }, title: 'El contador está revisando.' }, `🔍 En revisión${folio}`);
  if (estado === 'aprobado') {
    const aprDate = item?.aprobadoAt ? ' · ' + new Date(item.aprobadoAt).toLocaleString('es-MX') : '';
    const edited  = item?.actualizadoPorContador ? ' · Editado luego por el contador' : '';
    return h('span', { class: 'tag ok', style: { marginLeft: '6px' }, title: `Aprobado${aprDate}${edited}` },
      item?.actualizadoPorContador ? `✓ Aprobado${folio} · ✎ editado` : `✓ Aprobado${folio}`);
  }
  if (estado === 'cobrado' || estado === 'pagado') {
    const ts = item?.cobradoAt || item?.pagadoAt;
    const date = ts ? ' · ' + new Date(ts).toLocaleString('es-MX') : '';
    const met  = item?.metodoPago ? ` · ${item.metodoPago}` : '';
    return h('span', { class: 'tag ok', style: { marginLeft: '6px' }, title: `${estado === 'cobrado' ? 'Cobrado' : 'Pagado'}${date}${met}` },
      `✓ ${estado === 'cobrado' ? 'Cobrado' : 'Pagado'}${folio}`);
  }
  if (estado === 'rechazado')
    return h('span', { class: 'tag danger', style: { marginLeft: '6px' }, title: item?.comentarioRechazo ? 'Motivo: ' + item.comentarioRechazo : 'Rechazado por el contador' }, `✕ Rechazado${folio}`);
  if (estado === 'huerfano')
    return h('span', { class: 'tag warn', style: { marginLeft: '6px', borderColor: '#a06bd9', color: '#a06bd9' },
      title: (item?.descripcionHuerfano || 'El movimiento contable fue eliminado.') + (item?.huerfanoAt ? ' · ' + new Date(item.huerfanoAt).toLocaleString('es-MX') : '') },
      `⚠ Movimiento eliminado${folio}`);
  if (estado === 'cerrado')
    return h('span', { class: 'tag', style: { marginLeft: '6px', opacity: '.6' }, title: 'Cerrado por el contador.' }, `Cerrado${folio}`);
  return null;
}

export function modal({ title, body, onConfirm, confirmLabel = 'Aceptar', cancelLabel = 'Cancelar', danger = false, size = '' }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const close = (val) => { clear(root); resolve(val); };
    const card = h('div', { class: 'modal' + (size ? ' ' + size : '') }, [
      h('h2', {}, title),
      typeof body === 'string' ? h('div', {}, body) : body,
      h('div', { class: 'actions' }, [
        h('button', { class: 'btn ghost', onClick: () => close(false) }, cancelLabel),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onClick: async () => { const r = onConfirm ? await onConfirm() : true; close(r); } }, confirmLabel)
      ])
    ]);
    root.appendChild(h('div', { class: 'modal-backdrop', onClick: (e) => { if (e.target === e.currentTarget) close(false); } }, card));
  });
}
