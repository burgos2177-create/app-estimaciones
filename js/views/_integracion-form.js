// Formulario reutilizable de INTEGRACIÓN OPUS con preview en vivo de la cascada
// del contrato. Lo usan el modal "Nueva obra" y el editor de obra.
//
// Los porcentajes se capturan como enteros (5 = 5%) y se leen como decimales
// (0.05), que es el formato que persiste `integracion` y espera computeContrato.

import { h } from '../util/dom.js';
import { money } from '../util/format.js';
import { computeContrato, computeAnticipo, cascadaBreakdown } from '../services/contrato.js';

export function buildIntegracionForm(initial = {}) {
  const pctToInput = (d) => (d == null || d === '') ? '' : +(Number(d) * 100).toFixed(4);

  const costo = h('input', { type: 'number', step: '0.01', min: '0', placeholder: 'Subtotal OPUS sin sobrecostos', value: initial.costo_directo ?? '' });
  const pOfi = h('input', { type: 'number', step: '0.01', value: pctToInput(initial.pct_ind_oficina) });
  const pCampo = h('input', { type: 'number', step: '0.01', value: pctToInput(initial.pct_ind_campo) });
  const pFin = h('input', { type: 'number', step: '0.01', value: pctToInput(initial.pct_financiamiento) });
  const pUtil = h('input', { type: 'number', step: '0.01', value: pctToInput(initial.pct_utilidad) });
  const pCargos = h('input', { type: 'number', step: '0.01', value: pctToInput(initial.pct_cargos_adicionales) });
  const pOtro = h('input', { type: 'number', step: '0.01', value: pctToInput(initial.pct_otro) });
  const iva = h('input', { type: 'number', step: '0.01', value: pctToInput(initial.iva_pct == null ? 0.16 : initial.iva_pct) });
  const antPct = h('input', { type: 'number', step: '0.01', min: '0', value: pctToInput(initial.anticipo_pct ?? 0) });
  const antBase = h('select', {}, [
    h('option', { value: 'subtotal', selected: (initial.anticipo_base || 'subtotal') === 'subtotal' }, 'Sobre subtotal (sin IVA)'),
    h('option', { value: 'total_c_iva', selected: initial.anticipo_base === 'total_c_iva' }, 'Sobre total (con IVA)')
  ]);

  const dec = (input) => (Number(input.value) || 0) / 100;
  function readInput() {
    return {
      costo_directo: Number(costo.value) || 0,
      pct_ind_oficina: dec(pOfi),
      pct_ind_campo: dec(pCampo),
      pct_financiamiento: dec(pFin),
      pct_utilidad: dec(pUtil),
      pct_cargos_adicionales: dec(pCargos),
      pct_otro: dec(pOtro),
      iva_pct: dec(iva),
      anticipo_pct: dec(antPct),
      anticipo_base: antBase.value
    };
  }

  const preview = h('div', { class: 'card', style: { marginTop: '10px', background: 'var(--bg-2)' } });
  function refresh() {
    const input = readInput();
    const c = computeContrato(input);
    const antMonto = computeAnticipo(c, input.anticipo_pct, input.anticipo_base);
    const rows = cascadaBreakdown(c, antMonto, input.anticipo_base);
    preview.innerHTML = '';
    preview.appendChild(h('div', { class: 'muted', style: { fontSize: '11px', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '.5px' } }, 'Contrato derivado'));
    for (const r of rows) {
      preview.appendChild(h('div', {
        class: 'row',
        style: {
          justifyContent: 'space-between',
          padding: '3px 0',
          fontWeight: (r.grand || r.strong) ? '700' : '400',
          color: r.grand ? 'var(--accent)' : (r.anticipo ? 'var(--warn)' : 'inherit'),
          borderTop: r.grand ? '1px solid var(--border)' : 'none',
          marginTop: r.grand ? '4px' : '0',
          fontSize: r.grand ? '15px' : '12px'
        }
      }, [h('span', {}, r.label), h('span', { class: 'mono' }, money(r.value))]));
    }
  }
  [costo, pOfi, pCampo, pFin, pUtil, pCargos, pOtro, iva, antPct].forEach(i => i.addEventListener('input', refresh));
  antBase.addEventListener('change', refresh);

  const node = h('div', { class: 'card', style: { marginTop: '10px' } }, [
    h('h3', { style: { marginTop: 0 } }, 'Integración OPUS'),
    h('p', { class: 'muted', style: { fontSize: '11px', marginTop: 0 } }, 'El contrato se DERIVA de estos datos; no se teclea a mano. Los % van como números enteros (5 = 5%).'),
    h('div', { class: 'field' }, [h('label', {}, 'Costo directo (subtotal OPUS, sin sobrecostos)'), costo]),
    h('div', { class: 'grid-4' }, [
      h('div', { class: 'field' }, [h('label', {}, '% Ind. oficina'), pOfi]),
      h('div', { class: 'field' }, [h('label', {}, '% Ind. campo'), pCampo]),
      h('div', { class: 'field' }, [h('label', {}, '% Financiamiento'), pFin]),
      h('div', { class: 'field' }, [h('label', {}, '% Utilidad'), pUtil])
    ]),
    h('div', { class: 'grid-4' }, [
      h('div', { class: 'field' }, [h('label', {}, '% Cargos adic.'), pCargos]),
      h('div', { class: 'field' }, [h('label', {}, '% Otro'), pOtro]),
      h('div', { class: 'field' }, [h('label', {}, 'IVA %'), iva]),
      h('div', { class: 'field' }, [h('label', {}, '% Anticipo'), antPct])
    ]),
    h('div', { class: 'field' }, [h('label', {}, 'Base del anticipo'), antBase]),
    preview
  ]);
  refresh();
  return { node, readInput, refresh };
}
