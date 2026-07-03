// Cálculo del CONTRATO a partir de la integración OPUS.
// Fuente única de verdad de la cascada de sobrecostos. Es puro (sin DOM ni
// Firebase): lo usan el modal "Nueva obra", el editor de obra, db.createObra y
// buildResumenData. El bloque `integracion` es EXCLUSIVO de estimaciones.
//
// Cascada (idéntica a OPUS — ¡ojo con la base de cada nivel!):
//   costo_directo (CD)
//   + ind_oficina = CD * pct_ind_oficina      // ambos indirectos son % de CD,
//   + ind_campo   = CD * pct_ind_campo         // NO en cascada uno sobre otro
//   = subtotal_indirectos
//   + financiamiento = subtotal_indirectos * pct_financiamiento              // cascada
//   + utilidad       = (subtotal_indirectos + financiamiento) * pct_utilidad // cascada
//   + cargos_adic    = subtotal_parcial * pct_cargos_adicionales   // cascada, opcional
//   + otro           = subtotal_parcial * pct_otro                 // cascada, opcional
//   = subtotal_venta            // precio de venta SIN IVA
//   + iva = subtotal_venta * iva_pct
//   = monto_con_iva             // contrato
//
// Todos los pct son fracciones decimales (0.05 = 5%).

const num = (x) => Number(x) || 0;

export function computeContrato(cfg = {}) {
  const costo_directo = num(cfg.costo_directo);
  const pct_ind_oficina = num(cfg.pct_ind_oficina);
  const pct_ind_campo = num(cfg.pct_ind_campo);
  const pct_financiamiento = num(cfg.pct_financiamiento);
  const pct_utilidad = num(cfg.pct_utilidad);
  const pct_cargos_adicionales = num(cfg.pct_cargos_adicionales);
  const pct_otro = num(cfg.pct_otro);
  const iva_pct = cfg.iva_pct == null ? 0.16 : num(cfg.iva_pct);

  const ind_oficina = costo_directo * pct_ind_oficina;
  const ind_campo = costo_directo * pct_ind_campo;
  const subtotal_indirectos = costo_directo + ind_oficina + ind_campo;

  const financiamiento = subtotal_indirectos * pct_financiamiento;
  const base_utilidad = subtotal_indirectos + financiamiento;
  const utilidad = base_utilidad * pct_utilidad;

  let running = base_utilidad + utilidad;
  const cargos_adicionales = running * pct_cargos_adicionales;
  running += cargos_adicionales;
  const otro = running * pct_otro;
  running += otro;

  const subtotal_venta = running;                 // precio de venta SIN IVA
  const iva_monto = subtotal_venta * iva_pct;     // el IVA es una capa aparte
  const monto_con_iva = subtotal_venta + iva_monto;

  return {
    costo_directo,
    pct_ind_oficina, pct_ind_campo, pct_financiamiento, pct_utilidad,
    pct_cargos_adicionales, pct_otro,
    ind_oficina, ind_campo, subtotal_indirectos,
    financiamiento, utilidad, cargos_adicionales, otro,
    subtotal_venta, iva_pct, iva_monto, monto_con_iva
  };
}

// Monto del anticipo según la base elegida (en la moneda de su base).
export function computeAnticipo(contrato, anticipo_pct = 0, anticipo_base = 'subtotal') {
  const pct = num(anticipo_pct);
  const base = anticipo_base === 'total_c_iva' ? contrato.monto_con_iva : contrato.subtotal_venta;
  return base * pct;
}

// Tasa de amortización aplicada al SUBTOTAL (sin IVA) de cada estimación, de modo
// que la Σ de amortizaciones recupere el anticipo al llegar al 100% de avance.
//   base 'subtotal'    → amortiza pct del subtotal ejecutado
//   base 'total_c_iva' → amortiza pct del importe c/IVA (= pct*(1+iva) sobre el subtotal)
export function amortRateOnSubtotal(anticipo_pct = 0, anticipo_base = 'subtotal', iva_pct = 0.16) {
  const pct = num(anticipo_pct);
  return anticipo_base === 'total_c_iva' ? pct * (1 + num(iva_pct)) : pct;
}

// Desglose de la cascada para previews (datos puros; el caller lo pinta).
export function cascadaBreakdown(c, anticipoMonto, anticipo_base = 'subtotal') {
  const rows = [
    { label: 'Costo directo (OPUS, sin sobrecostos)', value: c.costo_directo },
    { label: `(+) Indirectos de oficina (${(c.pct_ind_oficina * 100).toFixed(2)}%)`, value: c.ind_oficina },
    { label: `(+) Indirectos de campo (${(c.pct_ind_campo * 100).toFixed(2)}%)`, value: c.ind_campo },
    { label: '(=) Subtotal indirectos', value: c.subtotal_indirectos, strong: true }
  ];
  if (c.pct_financiamiento) rows.push({ label: `(+) Financiamiento (${(c.pct_financiamiento * 100).toFixed(2)}%)`, value: c.financiamiento });
  if (c.pct_utilidad) rows.push({ label: `(+) Utilidad (${(c.pct_utilidad * 100).toFixed(2)}%)`, value: c.utilidad });
  if (c.pct_cargos_adicionales) rows.push({ label: `(+) Cargos adicionales (${(c.pct_cargos_adicionales * 100).toFixed(2)}%)`, value: c.cargos_adicionales });
  if (c.pct_otro) rows.push({ label: `(+) Otro (${(c.pct_otro * 100).toFixed(2)}%)`, value: c.otro });
  rows.push({ label: '(=) Subtotal de venta (sin IVA)', value: c.subtotal_venta, strong: true });
  rows.push({ label: `(+) IVA (${(c.iva_pct * 100).toFixed(2)}%)`, value: c.iva_monto });
  rows.push({ label: '(=) MONTO CONTRATO C/IVA', value: c.monto_con_iva, grand: true });
  rows.push({ label: `Anticipo (${anticipo_base === 'total_c_iva' ? 'sobre total c/IVA' : 'sobre subtotal'})`, value: anticipoMonto, anticipo: true });
  return rows;
}
