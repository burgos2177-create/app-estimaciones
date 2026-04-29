// Vista admin: vincular obras (estimaciones) ↔ proyectos (bitácora).
// El pareo permite que el buzón sepa a qué proyecto contable mandar
// los pagos/gastos cuando vienen desde estimaciones.
//
// Datos:
//   /legacy/estimaciones/obras/{obraId}/meta — origen
//   /legacy/bitacora/sogrub_proyectos — destino (array)
//   /shared/obraLinks/{obraId} → proyectoId — el mapeo

import { h, modal, toast } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state } from '../state/store.js';
import { rread, getObraLinks, setObraLink, getProyectosBitacora } from '../services/db.js';
import { navigate } from '../state/router.js';
import { money, dateMx, num0 } from '../util/format.js';

export async function renderVincularObras() {
  if (state.user.role !== 'admin') {
    renderShell([{ label: 'Sin acceso' }], h('div', { class: 'empty' }, 'Solo el administrador puede acceder a esta pantalla.'));
    return;
  }

  renderShell(crumbs(), h('div', { class: 'empty' }, 'Cargando…'));

  let obrasRaw, proyectos, links;
  try {
    [obrasRaw, proyectos, links] = await Promise.all([
      rread('obras'),                  // /legacy/estimaciones/obras
      getProyectosBitacora(),          // /legacy/bitacora/sogrub_proyectos
      getObraLinks()                   // /shared/obraLinks
    ]);
  } catch (err) {
    renderShell(crumbs(), h('div', { class: 'empty' }, 'Error: ' + err.message));
    return;
  }

  const obras = Object.entries(obrasRaw || {})
    .map(([id, o]) => ({ id, ...(o.meta || {}) }))
    .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));

  const proyMap = new Map();
  for (const p of (proyectos || [])) {
    if (p?.id != null) proyMap.set(String(p.id), p);
  }
  const proyOptions = (proyectos || []).slice().sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));

  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Vincular obras ↔ proyectos contables'),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn ghost', onClick: () => navigate('/admin') }, '← Admin')
  ]);

  const intro = h('div', { class: 'card' }, [
    h('p', { class: 'muted', style: { marginTop: 0, fontSize: '13px' } }, [
      'Empareja cada obra con su proyecto contable. Esto se usa para que cuando el ingeniero registre un pago de cliente o una estimación a subcontratista, la app contadora sepa exactamente a qué proyecto se debe abonar / cargar el gasto.'
    ]),
    h('div', { class: 'row', style: { fontSize: '12px' } }, [
      h('div', {}, [h('span', { class: 'muted' }, 'Obras: '), h('b', {}, num0(obras.length))]),
      h('div', {}, [h('span', { class: 'muted' }, ' · Proyectos contables: '), h('b', {}, num0(proyectos.length))]),
      h('div', {}, [h('span', { class: 'muted' }, ' · Vinculados: '), h('b', {}, num0(Object.keys(links || {}).length))])
    ])
  ]);

  if (obras.length === 0) {
    renderShell(crumbs(), h('div', {}, [head, intro, h('div', { class: 'empty' }, 'No hay obras todavía.')]));
    return;
  }

  // Tabla
  const rows = obras.map(o => {
    const proyId = links?.[o.id] || '';
    const proy = proyId ? proyMap.get(String(proyId)) : null;

    const select = h('select', { style: { minWidth: '220px' } }, [
      h('option', { value: '' }, '— sin vincular —'),
      ...proyOptions.map(p => h('option', { value: String(p.id), selected: String(p.id) === String(proyId) },
        `${p.nombre || '?'}${p.cliente ? ' · ' + p.cliente : ''}`))
    ]);
    select.addEventListener('change', async () => {
      try {
        const newPid = select.value || null;
        await setObraLink(o.id, newPid);
        toast(newPid ? 'Vinculado' : 'Desvinculado', 'ok');
        renderVincularObras();
      } catch (err) { toast('Error: ' + err.message, 'danger'); }
    });

    return h('tr', {}, [
      h('td', {}, [
        h('div', { style: { fontWeight: 600 } }, o.nombre || '(sin nombre)'),
        h('div', { class: 'muted', style: { fontSize: '11px' } }, [
          o.contratoNo ? `Contrato ${o.contratoNo} · ` : '',
          o.cliente || '',
          o.montoContratoCIVA ? ` · ${money(o.montoContratoCIVA)}` : ''
        ])
      ]),
      h('td', { class: 'mono muted', style: { fontSize: '10px' } }, o.id),
      h('td', {}, select),
      h('td', {}, proy
        ? h('div', { class: 'muted', style: { fontSize: '11px' } }, [
            proy.estado === 'terminado' ? h('span', { class: 'tag muted' }, 'terminado') : h('span', { class: 'tag ok' }, 'activo'),
            ' · ', proy.cliente || '',
            proy.presupuesto_contrato ? ` · ${money(proy.presupuesto_contrato)}` : ''
          ])
        : h('span', { class: 'muted', style: { fontSize: '12px' } }, '—'))
    ]);
  });

  const table = h('table', { class: 'tbl' }, [
    h('thead', {}, [h('tr', {}, [
      h('th', {}, 'Obra (estimaciones)'),
      h('th', {}, 'ID obra'),
      h('th', {}, 'Proyecto contable (bitácora)'),
      h('th', {}, 'Detalles del proyecto')
    ])]),
    h('tbody', {}, rows)
  ]);

  // Diagnóstico de proyectos sin obra vinculada
  const linkedProyIds = new Set(Object.values(links || {}).map(String));
  const sinVincular = proyOptions.filter(p => !linkedProyIds.has(String(p.id)));
  const aviso = sinVincular.length > 0
    ? h('div', { class: 'card', style: { marginTop: '14px' } }, [
        h('h3', {}, `Proyectos contables sin vincular (${sinVincular.length})`),
        h('p', { class: 'muted', style: { fontSize: '12px', margin: '4px 0 8px' } }, 'Estos proyectos están en bitácora pero ninguna obra de estimaciones los apunta. Puede ser intencional (proyectos solo contables, terminados, etc.) o puede faltar pareo.'),
        h('ul', { style: { fontSize: '12px', paddingLeft: '20px' } },
          sinVincular.slice(0, 20).map(p => h('li', {}, `${p.nombre || '?'} ${p.cliente ? '· ' + p.cliente : ''}`))
        )
      ])
    : null;

  renderShell(crumbs(), h('div', {}, [
    head, intro, table, aviso
  ].filter(Boolean)));
}

function crumbs() {
  return [
    { label: 'Obras', to: '/' },
    { label: 'Admin', to: '/admin' },
    { label: 'Vincular obras' }
  ];
}
