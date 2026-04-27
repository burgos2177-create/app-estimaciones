// Plantillas de medición. Se ligan a un concepto la 1ª vez que se le registra un generador.
// Cada plantilla declara columnas y la fórmula para calcular el total de una partida.
// La plantilla "personalizado" se configura al momento (config se guarda en el concepto).

export const PLANTILLAS = {
  areas: {
    label: 'Áreas',
    descripcion: 'Largo × Ancho. Útil para m², losas, pisos, fachadas.',
    columns: [
      { key: 'eje', label: 'Eje', type: 'text' },
      { key: 'tramo', label: 'Tramo', type: 'text' },
      { key: 'largo', label: 'Largo', type: 'number', factor: true },
      { key: 'ancho', label: 'Ancho', type: 'number', factor: true }
    ],
    calc: row => (toNum(row.largo) * toNum(row.ancho)) || 0
  },

  volumenes: {
    label: 'Volúmenes',
    descripcion: 'Largo × Ancho × Alto. Útil para m³, concretos, rellenos.',
    columns: [
      { key: 'eje', label: 'Eje', type: 'text' },
      { key: 'tramo', label: 'Tramo', type: 'text' },
      { key: 'largo', label: 'Largo', type: 'number', factor: true },
      { key: 'ancho', label: 'Ancho', type: 'number', factor: true },
      { key: 'alto', label: 'Alto', type: 'number', factor: true }
    ],
    calc: row => (toNum(row.largo) * toNum(row.ancho) * toNum(row.alto)) || 0
  },

  distancias: {
    label: 'Distancias',
    descripcion: 'Solo Largo. Útil para ml, cortes, tuberías, barandales.',
    columns: [
      { key: 'eje', label: 'Eje', type: 'text' },
      { key: 'tramo', label: 'Tramo', type: 'text' },
      { key: 'largo', label: 'Largo', type: 'number', factor: true }
    ],
    calc: row => toNum(row.largo)
  },

  piezas: {
    label: 'Piezas',
    descripcion: 'Conteo. Útil para luminarias, salidas, anclas, placas.',
    columns: [
      { key: 'elemento', label: 'Elemento', type: 'text' },
      { key: 'cantidad', label: 'Cantidad', type: 'number', factor: true }
    ],
    calc: row => toNum(row.cantidad)
  },

  personalizado: {
    label: 'Personalizado',
    descripcion: 'Define tus columnas y marca cuáles se multiplican.',
    columns: null, // se toma de plantillaConfig.columns en el concepto
    calc: null     // se construye desde plantillaConfig.columns (factor: true → multiplica)
  }
};

export function getColumns(concepto) {
  if (!concepto?.plantillaTipo) return null;
  if (concepto.plantillaTipo === 'personalizado') {
    return concepto.plantillaConfig?.columns || [];
  }
  return PLANTILLAS[concepto.plantillaTipo]?.columns || null;
}

export function getCalcFn(concepto) {
  if (!concepto?.plantillaTipo) return () => 0;
  if (concepto.plantillaTipo === 'personalizado') {
    const cols = concepto.plantillaConfig?.columns || [];
    const factors = cols.filter(c => c.factor);
    if (factors.length === 0) return () => 0;
    return row => factors.reduce((acc, c) => acc * toNum(row[c.key]), 1);
  }
  return PLANTILLAS[concepto.plantillaTipo]?.calc || (() => 0);
}

export function calcPartidaTotal(concepto, partida) {
  return getCalcFn(concepto)(partida);
}

export function calcGeneradorTotal(concepto, generador) {
  const calc = getCalcFn(concepto);
  const partidas = (generador.partidas || []).reduce((s, p) => s + (calc(p) || 0), 0);
  const ajustes = (generador.ajustes || []).reduce((s, a) => s + (toNum(a.cantidad)), 0);
  return partidas + ajustes;
}

export function blankPartida(columns) {
  const o = {};
  for (const c of columns) o[c.key] = c.type === 'number' ? '' : '';
  return o;
}

function toNum(x) {
  if (x == null || x === '') return 0;
  const n = parseFloat(String(x).replace(/[,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}
