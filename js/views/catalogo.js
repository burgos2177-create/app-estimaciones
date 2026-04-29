import { h } from '../util/dom.js';
import { renderShell } from './shell.js';
import { rread, loadObra } from '../services/db.js';
import { money, num, num0 } from '../util/format.js';
import { navigate } from '../state/router.js';

export async function renderCatalogo({ params }) {
  const obraId = params.id;
  renderShell(crumbs(obraId), h('div', { class: 'empty' }, 'Cargando catálogo…'));

  const obraFull = await loadObra(obraId);
  const obra = obraFull?.meta || null;
  const catalogo = obraFull?.catalogo || null;

  if (!catalogo || !catalogo.conceptos) {
    renderShell(crumbs(obraId, obra?.nombre), h('div', { class: 'empty' }, [
      'No hay catálogo importado todavía.',
      h('div', { style: { marginTop: '12px' } }, h('a', { href: '#/obras/' + obraId }, 'Volver a la obra'))
    ]));
    return;
  }

  const conceptos = Object.entries(catalogo.conceptos)
    .map(([id, c]) => ({ id, ...c }))
    .sort((a, b) => a.orden - b.orden);

  const filterIn = h('input', { placeholder: 'Buscar por clave o descripción…', style: { flex: 1, maxWidth: '420px' } });
  const onlyPUs = h('input', { type: 'checkbox' });
  const showArch = h('input', { type: 'checkbox' });

  const tbody = h('tbody', {});
  function rerender() {
    const q = filterIn.value.trim().toLowerCase();
    const flt = c => {
      if (!showArch.checked && c.archivado) return false;
      if (onlyPUs.checked && c.tipo !== 'precio_unitario') return false;
      if (!q) return true;
      return (c.clave || '').toLowerCase().includes(q) || (c.descripcion || '').toLowerCase().includes(q);
    };
    const filtered = conceptos.filter(flt);
    tbody.innerHTML = '';
    if (filtered.length === 0) {
      tbody.appendChild(h('tr', {}, [h('td', { colSpan: 7, class: 'empty', style: { padding: '24px' } }, 'Sin resultados.')]));
      return;
    }
    filtered.forEach(c => tbody.appendChild(renderRow(c, obraId)));
  }
  filterIn.addEventListener('input', rerender);
  onlyPUs.addEventListener('change', rerender);
  showArch.addEventListener('change', rerender);

  const totalRoot = conceptos.filter(c => c.nivel === 0 && c.tipo === 'agrupador').reduce((s, c) => s + (c.total || 0), 0);
  const pusActivos = conceptos.filter(c => c.tipo === 'precio_unitario' && !c.archivado);
  const numPUs = pusActivos.length;
  const numArch = conceptos.filter(c => c.archivado).length;
  const sumaPUs = pusActivos.reduce((s, c) => s + (c.total || 0), 0);

  // Detección de claves duplicadas entre PUs activos
  const claveCount = {};
  for (const c of pusActivos) claveCount[c.clave] = (claveCount[c.clave] || 0) + 1;
  const duplicados = Object.entries(claveCount).filter(([_, n]) => n > 1);

  // Monto contractual (de obra.meta) — comparar contra suma del catálogo
  const ivaPct = Number(obra?.ivaPct ?? 0.16);
  const montoContrato = Number(obra?.montoContratoCIVA) || 0;
  const subtotalContrato = montoContrato / (1 + ivaPct);
  const close = (a, b) => b > 0 && Math.abs(a - b) < Math.max(1, b * 0.005);
  const cuadraConContrato = close(sumaPUs, subtotalContrato) || close(totalRoot, subtotalContrato);

  const colgroup = h('colgroup', {}, [
    h('col', { style: { width: '110px' } }),       // clave
    h('col', {}),                                   // descripción (auto / 1fr)
    h('col', { style: { width: '60px' } }),        // unidad
    h('col', { style: { width: '110px' } }),       // cantidad
    h('col', { style: { width: '120px' } }),       // pu
    h('col', { style: { width: '140px' } }),       // total
    h('col', { style: { width: '90px' } })         // acción
  ]);

  const table = h('table', { class: 'cat-table' }, [
    colgroup,
    h('thead', {}, [h('tr', {}, [
      h('th', {}, 'Clave'),
      h('th', {}, 'Descripción / Unidad'),
      h('th', {}, 'U.'),
      h('th', { class: 'num' }, 'Cantidad'),
      h('th', { class: 'num' }, 'P.U.'),
      h('th', { class: 'num' }, 'Total'),
      h('th', {}, '')
    ])]),
    tbody
  ]);

  const body = h('div', {}, [
    h('h1', {}, 'Catálogo'),
    h('div', { class: 'card' }, [
      h('div', { class: 'row' }, [
        h('div', {}, [h('span', { class: 'muted' }, 'Archivo: '), h('span', { class: 'mono' }, catalogo.sourceFileName)]),
        h('div', { style: { flex: 1 } }),
        h('div', {}, [h('span', { class: 'muted' }, 'PUs: '), h('b', {}, num0(numPUs))])
      ]),
      h('div', { class: 'row', style: { marginTop: '8px', fontSize: '12px', flexWrap: 'wrap' } }, [
        h('div', {}, [h('span', { class: 'muted' }, 'Σ PUs del catálogo: '), h('b', { class: 'mono' }, money(sumaPUs))]),
        h('div', {}, [h('span', { class: 'muted' }, ' · Σ agrupadores raíz: '), h('b', { class: 'mono' }, money(totalRoot))]),
        h('div', {}, [h('span', { class: 'muted' }, ' · Subtotal contrato (sin IVA): '), h('b', { class: 'mono' }, money(subtotalContrato))]),
        montoContrato > 0 && !cuadraConContrato && h('span', { class: 'tag warn', title: 'La suma del catálogo no coincide con el monto del contrato. Edita la obra o re-importa.' }, '⚠ desfase con contrato'),
        Math.abs(sumaPUs - totalRoot) > 1 && h('span', { class: 'tag warn', title: 'Los PUs no suman lo mismo que los agrupadores raíz. El XLS puede tener PUs huérfanos o estructura inusual.' }, '⚠ Σ PUs ≠ Σ raíces'),
        duplicados.length > 0 && h('span', { class: 'tag danger', title: `Claves duplicadas: ${duplicados.slice(0, 5).map(([k, n]) => `${k} (×${n})`).join(', ')}${duplicados.length > 5 ? ', …' : ''}` }, `⚠ ${duplicados.length} clave(s) duplicada(s)`)
      ]),
      h('div', { class: 'row', style: { marginTop: '10px' } }, [
        filterIn,
        h('label', { class: 'row' }, [onlyPUs, h('span', {}, 'Solo precios unitarios')]),
        h('label', { class: 'row' }, [showArch, h('span', {}, 'Mostrar archivados')]),
        numArch > 0 && h('span', { class: 'tag warn' }, `${numArch} archivado(s)`)
      ])
    ]),
    h('div', { class: 'card', style: { padding: '0', overflow: 'hidden' } }, table)
  ]);

  rerender();
  renderShell(crumbs(obraId, obra?.nombre), body);
}

function renderRow(c, obraId) {
  const isAgr = c.tipo === 'agrupador';
  const cls = isAgr ? `agrupador lvl-${c.nivel}` : 'pu';
  const indent = c.nivel * 16;
  const arch = c.archivado ? h('span', { class: 'tag warn' }, 'archivado') : '';
  const plant = c.plantillaTipo ? h('span', { class: 'tag muted' }, c.plantillaTipo) : '';
  const action = !isAgr && !c.archivado
    ? h('button', { class: 'btn sm', onClick: (e) => { e.stopPropagation(); navigate(`/obras/${obraId}/conceptos/${c.id}`); } }, 'Abrir')
    : null;

  return h('tr', { class: cls }, [
    h('td', { class: 'clave', style: { paddingLeft: `${10 + indent}px` } }, c.clave || ''),
    h('td', { class: 'desc-cell' }, [
      h('span', { class: 'desc', title: c.descripcion || '' }, c.descripcion || ''),
      (arch || plant) && h('span', { class: 'badges', style: { marginLeft: '6px' } }, [arch, ' ', plant])
    ]),
    h('td', { class: 'muted' }, c.unidad || ''),
    h('td', { class: 'num' }, c.cantidad ? num(c.cantidad, 2) : ''),
    h('td', { class: 'num muted' }, c.precio_unitario ? money(c.precio_unitario) : ''),
    h('td', { class: 'num' }, c.total ? money(c.total) : ''),
    h('td', { class: 'actions-cell' }, action)
  ]);
}

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Catálogo' }
  ];
}
