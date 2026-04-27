// Vistas que se construyen en la siguiente iteración.
// Cada una muestra una pantalla "próximamente" con la ruta y el contexto que recibe,
// para que el flujo de navegación se valide ya completo.

import { h } from '../util/dom.js';
import { renderShell } from './shell.js';

function comingSoon(title, crumbs, extra) {
  renderShell(crumbs, h('div', {}, [
    h('h1', {}, title),
    h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '🛠'),
      h('div', {}, 'Próximamente'),
      extra && h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } }, extra)
    ])
  ]));
}

export function renderConcepto({ params }) {
  comingSoon('Concepto del catálogo', [
    { label: 'Obras', to: '/' },
    { label: params.id.slice(0, 6), to: '/obras/' + params.id },
    { label: 'Catálogo', to: `/obras/${params.id}/catalogo` },
    { label: 'Concepto' }
  ], 'Detalle del concepto con historial de generadores y % avance acumulado por estimación. Próxima iteración.');
}

export function renderResumen({ params }) {
  comingSoon('RESUMEN', [
    { label: 'Obras', to: '/' },
    { label: params.id.slice(0, 6), to: '/obras/' + params.id },
    { label: 'RESUMEN' }
  ], 'Carátula de estimación: Subtotal/IVA/Importe, pagos del cliente, diferencia financiera, exportar PDF y XLSX.');
}
