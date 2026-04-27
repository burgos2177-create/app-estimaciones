// Parser para archivos .xls/.xlsx exportados de OPUS (software mexicano de costos unitarios).
//
// Reglas:
//  - Cada fila trae: Tipo ("Agrupador" | "Precio unitario"), Clave, Descripción, Unidad,
//    Cantidad, Precio unitario, Total.
//  - Reconstruye la jerarquía con un stack + remaining-budget:
//      • Cada agrupador abierto recuerda cuánto queda por colocar (remainingBudget = total).
//      • Cada PU encontrado descuenta su total del top del stack.
//      • Al encontrar un nuevo agrupador, se cierran los de arriba cuyo rem ≈ 0.
//      • El nuevo agrupador descuenta su total al padre y se apila.
//  - Salida: array plano de items { id, tipo, descripcion, nivel, path, agrupadores,
//    clave, unidad, cantidad, precio_unitario, total, orden }.

const EPS = 0.5; // tolerancia en pesos (los XLS de OPUS suelen tener centavos redondeados)

export async function parseOpusXLS(file) {
  // Lee el archivo con SheetJS (carga como ArrayBuffer)
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  return parseOpusRows(rows);
}

export function parseOpusRows(rows) {
  // Detección de encabezado: busca la fila que contenga "Tipo" + "Clave" + "Descripción"
  const hdr = findHeader(rows);
  if (!hdr) throw new Error('No se reconoce el formato del archivo OPUS (no se encontraron columnas Tipo/Clave/Descripción).');
  const cols = hdr.cols;

  const conceptos = [];
  const stack = []; // { node, remainingBudget }
  let orden = 0;

  for (let i = hdr.rowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const tipoRaw = clean(row[cols.tipo]);
    if (!tipoRaw) continue;
    const tipo = normalizeTipo(tipoRaw);
    if (!tipo) continue;

    const clave = clean(row[cols.clave]) || '';
    const descripcion = clean(row[cols.descripcion]) || '';
    const unidad = clean(row[cols.unidad]) || '';
    const cantidad = num(row[cols.cantidad]);
    const precioUnitario = num(row[cols.pu]);
    const total = num(row[cols.total]);

    if (!clave && !descripcion) continue;

    if (tipo === 'agrupador') {
      // Cierra agrupadores cuyo rem ya esté agotado
      while (stack.length && stack[stack.length - 1].remainingBudget < EPS) stack.pop();

      const ancestors = stack.map(s => ({ clave: s.node.clave, descripcion: s.node.descripcion }));
      const node = {
        id: makeId('a', orden),
        tipo: 'agrupador',
        clave, descripcion, unidad,
        cantidad: cantidad || 0,
        precio_unitario: precioUnitario || 0,
        total: total || 0,
        nivel: stack.length,
        path: [...ancestors, { clave, descripcion }],
        agrupadores: ancestors,
        orden: orden++
      };
      conceptos.push(node);

      // Descuenta del padre
      if (stack.length) stack[stack.length - 1].remainingBudget -= node.total;
      // Apila
      stack.push({ node, remainingBudget: node.total });
    } else {
      // PU: ancestros = stack actual (sin auto-cierre porque hijos pueden seguir vaciando padre)
      const ancestors = stack.map(s => ({ clave: s.node.clave, descripcion: s.node.descripcion }));
      const node = {
        id: makeId('p', orden),
        tipo: 'precio_unitario',
        clave, descripcion, unidad,
        cantidad: cantidad || 0,
        precio_unitario: precioUnitario || 0,
        total: total || 0,
        nivel: stack.length,
        path: [...ancestors, { clave, descripcion }],
        agrupadores: ancestors,
        orden: orden++
      };
      conceptos.push(node);
      if (stack.length) stack[stack.length - 1].remainingBudget -= node.total;
    }
  }

  // Validación suave: total raíz vs Σ PUs
  const totalPUs = conceptos.filter(c => c.tipo === 'precio_unitario').reduce((s, c) => s + c.total, 0);
  const raices = conceptos.filter(c => c.nivel === 0 && c.tipo === 'agrupador');
  const totalRaices = raices.reduce((s, c) => s + c.total, 0);
  const desfase = Math.abs(totalRaices - totalPUs);
  const warning = desfase > Math.max(1, totalPUs * 0.001)
    ? `Diferencia entre Σ agrupadores raíz (${totalRaices.toFixed(2)}) y Σ PUs (${totalPUs.toFixed(2)}): ${desfase.toFixed(2)}`
    : null;

  return { conceptos, totalPUs, totalRaices, warning };
}

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const r = rows[i] || [];
    const norm = r.map(x => clean(x)?.toLowerCase() || '');
    const tipoIdx = norm.findIndex(x => x === 'tipo');
    if (tipoIdx === -1) continue;
    const findIdx = (...keys) => {
      for (const k of keys) {
        const j = norm.findIndex(x => x.startsWith(k));
        if (j !== -1) return j;
      }
      return -1;
    };
    const claveIdx = findIdx('clave');
    const descIdx = findIdx('descripci', 'concepto');
    if (claveIdx === -1 || descIdx === -1) continue;
    return {
      rowIdx: i,
      cols: {
        tipo: tipoIdx,
        clave: claveIdx,
        descripcion: descIdx,
        unidad: findIdx('unidad'),
        cantidad: findIdx('cantidad'),
        pu: findIdx('precio unitario', 'p.u', 'pu'),
        total: findIdx('total', 'importe')
      }
    };
  }
  return null;
}

function normalizeTipo(s) {
  const x = String(s).trim().toLowerCase();
  if (x.startsWith('agrup')) return 'agrupador';
  if (x.startsWith('precio') || x === 'pu' || x === 'concepto') return 'pu';
  return null;
}

function clean(x) {
  if (x == null) return null;
  return String(x).replace(/\s+/g, ' ').trim();
}

function num(x) {
  if (x == null || x === '') return 0;
  if (typeof x === 'number') return x;
  const s = String(x).replace(/[$,\s]/g, '').replace(/[^\d.\-]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

let _seq = 0;
function makeId(prefix, orden) {
  _seq = (_seq + 1) % 1e9;
  return `${prefix}_${orden}_${_seq.toString(36)}`;
}
