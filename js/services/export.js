// Exports a PDF (jsPDF + autotable) y XLSX (SheetJS).
// jsPDF y SheetJS están cargados via CDN en index.html como globals (window.jspdf, window.XLSX).
//
// Dos reportes:
//  - F-1 / Concentrado de obra (todo el catálogo con todas las estimaciones)
//  - RESUMEN de una estimación (carátula + estado de cuenta para entrega)

import { calcGeneradorTotal } from './plantillas.js';
import { getImageObjectUrl, isSignedIn as driveSignedIn } from './drive.js';

const fmtMxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtN2 = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => Number.isFinite(n) ? (n * 100).toFixed(2).replace('.', ',') + '%' : '—';
const money = (n) => fmtMxn.format(Number(n) || 0);
const num2 = (n) => fmtN2.format(Number(n) || 0);

function dateStr(d) {
  if (!d) return '—';
  const x = d instanceof Date ? d : new Date(d);
  return x.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
}
function safeName(s, fallback = 'documento') {
  return (String(s || fallback).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9-_ ]/g, '_').replace(/\s+/g, '_').slice(0, 60)) || fallback;
}

// ===== Helpers de cómputo =====
// Resuelve un conceptoId que puede ser legacy → conceptoKey actual del catálogo.
function resolveKey(conceptos, migrationKeyMap, id) {
  if (!id) return null;
  if (conceptos[id]) return id;
  if (migrationKeyMap && migrationKeyMap[id] && conceptos[migrationKeyMap[id]]) return migrationKeyMap[id];
  return null;
}

function buildExecMap(conceptos, generadores, avances, migrationKeyMap) {
  const ejecMap = {};
  for (const cid of Object.keys(conceptos)) ejecMap[cid] = {};
  for (const g of Object.values(generadores || {})) {
    const k = resolveKey(conceptos, migrationKeyMap, g.conceptoId);
    if (!k || !ejecMap[k]) continue;
    const c = conceptos[k];
    const cant = calcGeneradorTotal(c, g);
    ejecMap[k][g.estimacionId] = (ejecMap[k][g.estimacionId] || 0) + cant;
  }
  for (const [cid, byEst] of Object.entries(avances || {})) {
    const k = resolveKey(conceptos, migrationKeyMap, cid);
    if (!k || !ejecMap[k]) continue;
    for (const [eid, cant] of Object.entries(byEst)) {
      if (ejecMap[k][eid] != null) continue;
      ejecMap[k][eid] = Number(cant) || 0;
    }
  }
  return ejecMap;
}

// ====================================================================
//                          F-1 (CONCENTRADO)
// ====================================================================

export function exportF1Xlsx(obra) {
  const m = obra.meta || {};
  const conceptos = filterCatalogo(obra.catalogo?.conceptos || {});
  const estims = sortedEstims(obra.estimaciones || {});
  const ejecMap = buildExecMap(obra.catalogo?.conceptos || {}, obra.generadores || {}, obra.avances || {}, obra.catalogo?.migrationKeyMap);

  const totalPpto = conceptos.reduce((s, c) => s + (c.total || 0), 0);

  // Hoja 1: Encabezado
  const head = [
    ['NÚMEROS GENERADORES Y CONCENTRADO DE OBRA'],
    [],
    ['OBRA:', m.nombre || '', '', 'CONTRATO No:', m.contratoNo || ''],
    ['CLIENTE:', m.cliente || '', '', 'CONSTRUYE:', m.construye || ''],
    ['UBICACIÓN:', `${m.ubicacion || ''}${m.municipio ? ', ' + m.municipio : ''}`, '', 'PROGRAMA:', m.programa || ''],
    ['MONTO C/IVA:', m.montoContratoCIVA || 0, '', 'IVA:', `${((m.ivaPct ?? 0.16) * 100).toFixed(2)}%`],
    ['INICIO:', m.fechaInicio ? dateStr(m.fechaInicio) : '', '', 'FIN:', m.fechaFin ? dateStr(m.fechaFin) : ''],
    [],
    ['F-1 / CONCENTRADO']
  ];

  const headerRow = [
    'Clave', 'Descripción', 'U.', 'Cantidad', 'P.U.', 'Total',
    ...estims.map(e => '#' + e.numero),
    'Total Ejec.', '% Avance', '% PPTO', '% Ponderado', 'A cobrar', 'Restante'
  ];

  const rows = [];
  let totEjec = 0, totRest = 0, avPond = 0;
  const totByEst = Object.fromEntries(estims.map(e => [e.id, 0]));

  for (const c of conceptos) {
    const ejec = ejecMap[c.id] || {};
    const totalEjec = estims.reduce((s, e) => s + (ejec[e.id] || 0), 0);
    const aCobrar = totalEjec * (c.precio_unitario || 0);
    const restante = (c.total || 0) - aCobrar;
    const pctAv = c.cantidad ? totalEjec / c.cantidad : 0;
    const pctPpto = totalPpto ? (c.total || 0) / totalPpto : 0;
    const pctPond = pctAv * pctPpto;
    totEjec += aCobrar;
    totRest += restante;
    avPond += pctPond;
    for (const e of estims) totByEst[e.id] += (ejec[e.id] || 0) * (c.precio_unitario || 0);
    rows.push([
      c.clave, c.descripcion, c.unidad,
      c.cantidad, c.precio_unitario, c.total,
      ...estims.map(e => ejec[e.id] || ''),
      totalEjec, pctAv, pctPpto, pctPond, aCobrar, restante
    ]);
  }
  const totalRow = [
    'TOTAL', '', '', '', '', totalPpto,
    ...estims.map(e => totByEst[e.id]),
    '', avPond, '', '', totEjec, totRest
  ];

  const aoa = [...head, headerRow, ...rows, totalRow];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 12 }, { wch: 60 }, { wch: 6 },
    { wch: 10 }, { wch: 12 }, { wch: 14 },
    ...estims.map(() => ({ wch: 11 })),
    { wch: 12 }, { wch: 9 }, { wch: 9 }, { wch: 11 }, { wch: 14 }, { wch: 14 }
  ];
  // Formatos numéricos en filas de datos
  const headerRowIdx = head.length;            // fila índice (0-based) del header
  const firstDataRow = headerRowIdx + 1;
  const lastDataRow = firstDataRow + rows.length;
  const totalRowIdx = lastDataRow;

  const moneyCols = [4, 5, ...estims.map((_, i) => 6 + estims.length + 0).slice(0,0), // placeholder
  ];
  // (más abajo aplico formatos por columna)
  for (let r = firstDataRow; r <= lastDataRow; r++) {
    setNumFmt(ws, r, 3, '#,##0.00');                       // cantidad
    setNumFmt(ws, r, 4, '"$"#,##0.00');                    // PU
    setNumFmt(ws, r, 5, '"$"#,##0.00');                    // total
    for (let i = 0; i < estims.length; i++) setNumFmt(ws, r, 6 + i, '#,##0.00');
    setNumFmt(ws, r, 6 + estims.length, '#,##0.00');       // total ejec
    setNumFmt(ws, r, 7 + estims.length, '0.00%');          // % av
    setNumFmt(ws, r, 8 + estims.length, '0.00%');          // % ppto
    setNumFmt(ws, r, 9 + estims.length, '0.00%');          // % pond
    setNumFmt(ws, r, 10 + estims.length, '"$"#,##0.00');   // a cobrar
    setNumFmt(ws, r, 11 + estims.length, '"$"#,##0.00');   // restante
  }
  // total row (al final)
  setNumFmt(ws, totalRowIdx, 5, '"$"#,##0.00');
  for (let i = 0; i < estims.length; i++) setNumFmt(ws, totalRowIdx, 6 + i, '"$"#,##0.00');
  setNumFmt(ws, totalRowIdx, 7 + estims.length, '0.00%');
  setNumFmt(ws, totalRowIdx, 10 + estims.length, '"$"#,##0.00');
  setNumFmt(ws, totalRowIdx, 11 + estims.length, '"$"#,##0.00');

  XLSX.utils.book_append_sheet(wb, ws, 'F-1');
  XLSX.writeFile(wb, `F-1_${safeName(m.nombre)}.xlsx`);
}

export function exportF1Pdf(obra) {
  const m = obra.meta || {};
  const conceptos = filterCatalogo(obra.catalogo?.conceptos || {});
  const estims = sortedEstims(obra.estimaciones || {});
  const ejecMap = buildExecMap(obra.catalogo?.conceptos || {}, obra.generadores || {}, obra.avances || {}, obra.catalogo?.migrationKeyMap);

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });

  drawObraHeader(doc, m, 'F-1 / CONCENTRADO DE OBRA');

  const totalPpto = conceptos.reduce((s, c) => s + (c.total || 0), 0);
  let totEjec = 0, totRest = 0, avPond = 0;
  const totByEst = Object.fromEntries(estims.map(e => [e.id, 0]));

  const body = conceptos.map(c => {
    const ejec = ejecMap[c.id] || {};
    const totalEjec = estims.reduce((s, e) => s + (ejec[e.id] || 0), 0);
    const aCobrar = totalEjec * (c.precio_unitario || 0);
    const restante = (c.total || 0) - aCobrar;
    const pctAv = c.cantidad ? totalEjec / c.cantidad : 0;
    const pctPpto = totalPpto ? (c.total || 0) / totalPpto : 0;
    const pctPond = pctAv * pctPpto;
    totEjec += aCobrar;
    totRest += restante;
    avPond += pctPond;
    for (const e of estims) totByEst[e.id] += (ejec[e.id] || 0) * (c.precio_unitario || 0);
    const overrun = c.cantidad && totalEjec > c.cantidad;
    return {
      _overrun: overrun,
      cells: [
        c.clave || '', c.descripcion || '', c.unidad || '',
        num2(c.cantidad), money(c.precio_unitario), money(c.total),
        ...estims.map(e => ejec[e.id] ? num2(ejec[e.id]) : '—'),
        num2(totalEjec), fmtPct(pctAv), fmtPct(pctPpto), fmtPct(pctPond),
        money(aCobrar), money(restante)
      ]
    };
  });

  const head = [[
    'Clave', 'Descripción', 'U.', 'Cantidad', 'P.U.', 'Total',
    ...estims.map(e => '#' + e.numero),
    'Total Ejec.', '% Av.', '% PPTO', '% Pond.', 'A cobrar', 'Restante'
  ]];
  const foot = [[
    { content: 'TOTAL', colSpan: 5, styles: { halign: 'right', fontStyle: 'bold' } },
    money(totalPpto),
    ...estims.map(e => money(totByEst[e.id])),
    '', fmtPct(avPond), '', '', money(totEjec), money(totRest)
  ]];

  doc.autoTable({
    startY: 165,
    head, body: body.map(r => r.cells), foot,
    styles: { font: 'helvetica', fontSize: 7, cellPadding: 3, lineColor: [200, 210, 220], lineWidth: 0.3 },
    headStyles: { fillColor: [40, 50, 65], textColor: 230, fontStyle: 'bold', fontSize: 7 },
    footStyles: { fillColor: [240, 245, 250], textColor: 30, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 50, font: 'courier' },
      1: { cellWidth: 200 },
      2: { cellWidth: 28 },
      3: { halign: 'right' },
      4: { halign: 'right' }, 5: { halign: 'right' }
    },
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      const row = body[data.row.index];
      if (row?._overrun && data.column.index >= 6) data.cell.styles.fillColor = [253, 245, 220];
      if (data.column.index >= 7 + estims.length) data.cell.styles.halign = 'right';
      if (data.column.index >= 6 && data.column.index < 6 + estims.length) data.cell.styles.halign = 'right';
    },
    margin: { left: 30, right: 30, bottom: 40 },
    didDrawPage: (data) => drawFooter(doc, data, m)
  });

  // KPI block después de la tabla
  const y = doc.lastAutoTable.finalY + 14;
  doc.setFillColor(245, 248, 252); doc.rect(30, y, doc.internal.pageSize.width - 60, 36, 'F');
  doc.setTextColor(40); doc.setFontSize(9);
  doc.text(`% AVANCE PONDERADO: ${fmtPct(avPond)}`, 40, y + 14);
  doc.text(`IMPORTE EJECUTADO: ${money(totEjec)}`, 280, y + 14);
  doc.text(`IMPORTE RESTANTE: ${money(totRest)}`, 540, y + 14);
  doc.setFontSize(7); doc.setTextColor(120);
  doc.text(`Generado ${new Date().toLocaleString('es-MX')}`, 40, y + 28);

  doc.save(`F-1_${safeName(m.nombre)}.pdf`);
}

// ====================================================================
//                  RESUMEN (CARÁTULA DE ESTIMACIÓN)
// ====================================================================

export function buildResumenData(obra, estId) {
  const m = obra.meta || {};
  const est = obra.estimaciones?.[estId];
  if (!est) throw new Error('Estimación no encontrada');
  const conceptosAll = obra.catalogo?.conceptos || {};
  const conceptos = filterCatalogo(conceptosAll);
  const estims = sortedEstims(obra.estimaciones || {});
  const ejecMap = buildExecMap(conceptosAll, obra.generadores || {}, obra.avances || {}, obra.catalogo?.migrationKeyMap);
  const ivaPct = Number(m.ivaPct ?? 0.16);
  const anticipoPct = Number(m.anticipoPct ?? 0);

  let subtotalEsta = 0;
  let avPond = 0;
  const totalPpto = conceptos.reduce((s, c) => s + (c.total || 0), 0);

  const rows = conceptos.map(c => {
    const ejec = ejecMap[c.id] || {};
    const totalAcum = Object.values(ejec).reduce((s, x) => s + x, 0);
    const enEsta = ejec[estId] || 0;
    const aCobrarEsta = enEsta * (c.precio_unitario || 0);
    const aCobrarAcum = totalAcum * (c.precio_unitario || 0);
    const restante = (c.total || 0) - aCobrarAcum;
    const pctAv = c.cantidad ? totalAcum / c.cantidad : 0;
    const pctPpto = totalPpto ? (c.total || 0) / totalPpto : 0;
    const pctPond = pctAv * pctPpto;
    subtotalEsta += aCobrarEsta;
    avPond += pctPond;
    return { c, totalAcum, enEsta, aCobrarEsta, aCobrarAcum, restante, pctAv, pctPpto, pctPond };
  });

  const ivaEsta = subtotalEsta * ivaPct;
  const importeEstaBruto = subtotalEsta + ivaEsta;

  const importeAcumEjec = rows.reduce((s, r) => s + r.aCobrarAcum, 0);
  const importeAcumEjecCIVA = importeAcumEjec * (1 + ivaPct);

  // Amortización de anticipo (modelo estándar Mx: amortiza % del subtotal sin IVA)
  // El anticipo otorgado se calcula sobre el SUBTOTAL DEL CONTRATO (monto C/IVA / (1+IVA)),
  // no sobre la Σ del catálogo, porque ambos pueden divergir si el catálogo importado no
  // representa el alcance contratado completo.
  const subtotalContrato = (Number(m.montoContratoCIVA) || 0) / (1 + ivaPct);
  const anticipoMontoBase = subtotalContrato * anticipoPct;     // sin IVA
  const anticipoMontoCIVA = anticipoMontoBase * (1 + ivaPct);
  const amortizacionEsta = subtotalEsta * anticipoPct;
  const amortizacionAcum = importeAcumEjec * anticipoPct;
  const saldoAnticipoPorAmortizar = anticipoMontoBase - amortizacionAcum;
  const netoEsta = importeEstaBruto - amortizacionEsta;
  const netoAcum = importeAcumEjecCIVA - amortizacionAcum;

  // Pagos cliente
  let subtotalPagado = 0, ivaPagado = 0, importePagado = 0;
  for (const e of estims) {
    if (e.pagoCliente) {
      subtotalPagado += Number(e.pagoCliente.subtotal) || 0;
      ivaPagado += Number(e.pagoCliente.iva) || 0;
      importePagado += Number(e.pagoCliente.importe) || 0;
    }
  }

  return {
    m, est, ivaPct, anticipoPct, rows, totalPpto, estims,
    subtotalEsta, ivaEsta, importeEsta: importeEstaBruto,
    avPond, importeAcumEjec, importeAcumEjecCIVA,
    anticipoMontoBase, anticipoMontoCIVA,
    amortizacionEsta, amortizacionAcum, saldoAnticipoPorAmortizar,
    netoEsta, netoAcum,
    pagoCliente: est.pagoCliente || null,
    diferencia: netoAcum - importePagado,
    diferenciaPct: netoAcum ? (netoAcum - importePagado) / netoAcum : 0,
    subtotalPagado, ivaPagado, importePagado
  };
}

const DEFAULT_PRINT_CFG = {
  modo: 'estimacion',          // 'estimacion' | 'estadoCuenta'
  soloMovimiento: true,        // en modo estimación, solo conceptos con avance en esta estim
  mostrarAmortizacion: true,   // bloque de anticipo
  mostrarEstadoCuenta: true,   // bloque financiero
  incluirAnexoFotos: false,    // anexar fotos/croquis al final
  notas: ''                     // texto libre al final del PDF
};

// Convierte un objectURL a dataURL (necesario para jsPDF.addImage)
async function blobUrlToDataUrl(url) {
  const r = await fetch(url);
  const blob = await r.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Recolecta croquis y fotos de los generadores en una estimación, agrupados por concepto.
function collectAttachments(obra, estId) {
  const generadores = obra.generadores || {};
  const conceptos = obra.catalogo?.conceptos || {};
  const keyMap = obra.catalogo?.migrationKeyMap;
  const groups = new Map();   // conceptoKey → { clave, descripcion, items: [...] }
  for (const [gid, gen] of Object.entries(generadores)) {
    if (gen.estimacionId !== estId) continue;
    const k = resolveKey(conceptos, keyMap, gen.conceptoId);
    if (!k) continue;
    const concepto = conceptos[k];
    const ensure = () => {
      if (!groups.has(k)) {
        groups.set(k, { clave: concepto.clave || '', descripcion: concepto.descripcion || '', items: [] });
      }
      return groups.get(k);
    };
    for (const att of (gen.croquis || [])) ensure().items.push({ ...att, kind: 'croquis', generadorNumero: gen.numero });
    for (const att of (gen.fotos || [])) ensure().items.push({ ...att, kind: 'foto', generadorNumero: gen.numero });
  }
  return groups;
}

// Anexa secciones de croquis/fotos al PDF. Solo si el usuario está conectado a Drive.
async function appendAnexoFotos(doc, obra, estId, m) {
  if (!driveSignedIn()) return false;
  const groups = collectAttachments(obra, estId);
  if (groups.size === 0) return false;

  const w = doc.internal.pageSize.width;
  const h = doc.internal.pageSize.height;

  doc.addPage();
  drawObraHeader(doc, m, 'ANEXO — CROQUIS Y FOTOS DEL SITIO');
  let y = 165;

  for (const [_, group] of groups) {
    // Título del concepto
    if (y > h - 200) { doc.addPage(); drawObraHeader(doc, m, 'ANEXO — CROQUIS Y FOTOS DEL SITIO (cont.)'); y = 165; }
    doc.setFillColor(245, 248, 252); doc.rect(30, y, w - 60, 26, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(30);
    doc.text(group.clave, 38, y + 12);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80);
    const descLines = doc.splitTextToSize(group.descripcion || '', w - 80);
    doc.text(descLines.slice(0, 1), 38, y + 22);
    y += 32;

    // Grid de imágenes 2 por fila
    const imgW = (w - 60 - 10) / 2;
    const imgH = imgW * 0.65;
    let col = 0;
    for (const att of group.items) {
      if (col === 0 && y + imgH + 16 > h - 40) {
        doc.addPage();
        drawObraHeader(doc, m, 'ANEXO — CROQUIS Y FOTOS DEL SITIO (cont.)');
        y = 165;
      }
      const x = 30 + col * (imgW + 10);
      try {
        const objectUrl = await getImageObjectUrl(att.driveId);
        const dataUrl = await blobUrlToDataUrl(objectUrl);
        const fmt = (att.mimeType || '').includes('png') ? 'PNG' : 'JPEG';
        doc.addImage(dataUrl, fmt, x, y, imgW, imgH, undefined, 'FAST');
      } catch (err) {
        // si falla, dibujar caja con error
        doc.setDrawColor(220); doc.rect(x, y, imgW, imgH);
        doc.setFontSize(8); doc.setTextColor(150);
        doc.text(`(no se pudo cargar ${att.name})`, x + 8, y + imgH / 2);
      }
      doc.setFontSize(7); doc.setTextColor(100);
      const tag = att.kind === 'foto' ? 'FOTO' : 'CROQUIS';
      doc.text(`${tag} · ${att.name} · Gen #${att.generadorNumero}`, x, y + imgH + 10);
      col++;
      if (col === 2) { col = 0; y += imgH + 18; }
    }
    if (col !== 0) y += imgH + 18;
    y += 10;
  }

  return true;
}

function applyPrintFilter(rows, cfg) {
  if (cfg.modo === 'estimacion' && cfg.soloMovimiento) {
    return rows.filter(r => (r.enEsta || 0) > 0);
  }
  return rows;
}

export function exportResumenXlsx(obra, estId, cfg = {}) {
  cfg = { ...DEFAULT_PRINT_CFG, ...cfg };
  const data = buildResumenData(obra, estId);
  const { m, est, ivaPct, anticipoPct, subtotalEsta, ivaEsta, importeEsta, avPond, diferencia, diferenciaPct, importeAcumEjec, importeAcumEjecCIVA, subtotalPagado, ivaPagado, importePagado, anticipoMontoBase, amortizacionEsta, amortizacionAcum, saldoAnticipoPorAmortizar, netoEsta, netoAcum } = data;
  const rows = applyPrintFilter(data.rows, cfg);
  const titulo = cfg.modo === 'estadoCuenta' ? 'ESTADO DE CUENTA' : 'RESUMEN DE ESTIMACIÓN';

  const aoa = [
    [titulo],
    [],
    ['OBRA:', m.nombre || '', '', 'CONTRATO No:', m.contratoNo || ''],
    ['CLIENTE:', m.cliente || '', '', 'CONSTRUYE:', m.construye || ''],
    ['UBICACIÓN:', `${m.ubicacion || ''}${m.municipio ? ', ' + m.municipio : ''}`, '', 'PROGRAMA:', m.programa || ''],
    ['MONTO C/IVA:', m.montoContratoCIVA || 0, '', 'PERÍODO:', `${dateStr(m.fechaInicio)} – ${dateStr(m.fechaFin)}`],
    [],
    cfg.modo === 'estadoCuenta'
      ? ['ESTADO DE CUENTA AL', dateStr(est.fechaCorte), '', 'Estimación de referencia:', '#' + est.numero]
      : ['ESTIMACIÓN #' + est.numero, '', '', 'PERIODO:', `${dateStr(est.periodoIni)} – ${dateStr(est.periodoFin)}`],
    [`Estado: ${est.estado === 'cerrada' ? 'CERRADA' : 'BORRADOR'}`, '', '', 'Fecha de corte:', dateStr(est.fechaCorte)],
    cfg.modo === 'estimacion' && cfg.soloMovimiento
      ? ['(Solo conceptos con avance en esta estimación)']
      : [],
    [],
    cfg.modo === 'estadoCuenta'
      ? ['Clave', 'Descripción', 'Unidad', 'Cantidad', 'P.U.', 'Total', 'Ejecutado acum.', '% Avance', '$ Acumulado', '$ Por ejecutar', '', 'Observaciones']
      : ['Clave', 'Descripción', 'Unidad', 'Cantidad', 'P.U.', 'Total', 'Ejecutado (esta)', '% Avance acum.', '% Ponderado', '$ Por Cobrar (esta)', '$ Por Ejecutar', 'Observaciones']
  ];
  for (const r of rows) {
    if (cfg.modo === 'estadoCuenta') {
      aoa.push([
        r.c.clave || '', r.c.descripcion || '', r.c.unidad || '',
        r.c.cantidad || 0, r.c.precio_unitario || 0, r.c.total || 0,
        r.totalAcum || 0, r.pctAv || 0, r.aCobrarAcum || 0, r.restante || 0, '', ''
      ]);
    } else {
      aoa.push([
        r.c.clave || '', r.c.descripcion || '', r.c.unidad || '',
        r.c.cantidad || 0, r.c.precio_unitario || 0, r.c.total || 0,
        r.enEsta || 0, r.pctAv || 0, r.pctPond || 0,
        r.aCobrarEsta || 0, r.restante || 0, ''
      ]);
    }
  }
  aoa.push([]);
  if (cfg.modo === 'estadoCuenta') {
    aoa.push(['', '', '', '', '', 'TOTAL EJECUTADO', '', avPond, importeAcumEjec, '']);
  } else {
    aoa.push(['', '', '', '', '', 'TOTALES ESTIMACIÓN', '', avPond, '', subtotalEsta, '']);
  }
  aoa.push([]);

  if (cfg.mostrarEstadoCuenta) {
    aoa.push(['ESTADO DE CUENTA']);
    aoa.push(['Documento', 'Subtotal', 'IVA (' + (ivaPct * 100).toFixed(2) + '%)', 'Importe']);
    aoa.push(['Estimación #' + est.numero + ' (esta)', subtotalEsta, ivaEsta, importeEsta]);
    aoa.push(['Acumulado ejecutado (todas)', importeAcumEjec, importeAcumEjec * ivaPct, importeAcumEjecCIVA]);
    if (cfg.mostrarAmortizacion && anticipoPct > 0) {
      aoa.push([`Amortización anticipo (esta) — ${(anticipoPct * 100).toFixed(2)}%`, '', '', -amortizacionEsta]);
      aoa.push(['Amortización anticipo (acumulada)', '', '', -amortizacionAcum]);
      aoa.push(['Neto a cobrar (esta)', '', '', netoEsta]);
      aoa.push(['Neto a cobrar (acumulado)', '', '', netoAcum]);
    }
    aoa.push(['Pagos cliente (acumulado)', subtotalPagado, ivaPagado, importePagado]);
    aoa.push([]);
    aoa.push(['DIFERENCIA FINANCIERA', '', '', diferencia]);
    aoa.push(['DIFERENCIA FINANCIERA %', '', '', diferenciaPct]);
    aoa.push(['AVANCE OBRA (Σ ponderado)', '', '', avPond]);
    if (cfg.mostrarAmortizacion && anticipoPct > 0) {
      aoa.push([`Anticipo total otorgado (${(anticipoPct * 100).toFixed(2)}%)`, '', '', anticipoMontoBase]);
      aoa.push(['Saldo de anticipo por amortizar', '', '', saldoAnticipoPorAmortizar]);
    }
  }

  if (cfg.notas && cfg.notas.trim()) {
    aoa.push([]);
    aoa.push(['NOTAS / OBSERVACIONES']);
    cfg.notas.split('\n').forEach(line => aoa.push([line]));
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 12 }, { wch: 55 }, { wch: 6 }, { wch: 10 }, { wch: 11 }, { wch: 13 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 22 }];

  // Formatos numéricos sobre las filas de la tabla
  const headerRowIdx = aoa.findIndex(r => Array.isArray(r) && r[0] === 'Clave');
  const dataStart = headerRowIdx + 1;
  for (let i = 0; i < rows.length; i++) {
    const r = dataStart + i;
    setNumFmt(ws, r, 3, '#,##0.00');
    setNumFmt(ws, r, 4, '"$"#,##0.00');
    setNumFmt(ws, r, 5, '"$"#,##0.00');
    setNumFmt(ws, r, 6, '#,##0.00');
    setNumFmt(ws, r, 7, '0.00%');
    if (cfg.modo === 'estadoCuenta') {
      setNumFmt(ws, r, 8, '"$"#,##0.00');
      setNumFmt(ws, r, 9, '"$"#,##0.00');
    } else {
      setNumFmt(ws, r, 8, '0.00%');
      setNumFmt(ws, r, 9, '"$"#,##0.00');
      setNumFmt(ws, r, 10, '"$"#,##0.00');
    }
  }

  const sheetName = (cfg.modo === 'estadoCuenta' ? 'EstadoCuenta' : 'RESUMEN') + '-Est' + est.numero;
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const fname = (cfg.modo === 'estadoCuenta' ? 'EstadoCuenta' : 'RESUMEN') + '_' + safeName(m.nombre) + '_Est' + est.numero + '.xlsx';
  XLSX.writeFile(wb, fname);
}

export async function exportResumenPdf(obra, estId, cfg = {}) {
  cfg = { ...DEFAULT_PRINT_CFG, ...cfg };
  const data = buildResumenData(obra, estId);
  const { m, est, ivaPct, anticipoPct, subtotalEsta, ivaEsta, importeEsta, avPond, diferencia, diferenciaPct, importeAcumEjec, importeAcumEjecCIVA, subtotalPagado, ivaPagado, importePagado, anticipoMontoBase, amortizacionEsta, amortizacionAcum, saldoAnticipoPorAmortizar, netoEsta, netoAcum } = data;
  const rows = applyPrintFilter(data.rows, cfg);
  const isEstadoCuenta = cfg.modo === 'estadoCuenta';

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });

  const titulo = isEstadoCuenta ? `ESTADO DE CUENTA` : `RESUMEN — ESTIMACIÓN #${est.numero}`;
  drawObraHeader(doc, m, titulo);

  // Sub-encabezado
  let y = 168;
  doc.setFontSize(9); doc.setTextColor(70);
  if (isEstadoCuenta) {
    doc.text(`Estimación de referencia: #${est.numero}`, 30, y);
    doc.text(`Fecha de corte: ${dateStr(est.fechaCorte)}`, 220, y);
    doc.text(`Estado: ${est.estado === 'cerrada' ? 'CERRADA' : 'BORRADOR'}`, 420, y);
  } else {
    doc.text(`Período: ${dateStr(est.periodoIni)} – ${dateStr(est.periodoFin)}`, 30, y);
    doc.text(`Fecha de corte: ${dateStr(est.fechaCorte)}`, 270, y);
    doc.text(`Estado: ${est.estado === 'cerrada' ? 'CERRADA' : 'BORRADOR'}`, 460, y);
  }
  if (cfg.modo === 'estimacion' && cfg.soloMovimiento) {
    doc.setFontSize(7.5); doc.setTextColor(120);
    doc.text(`(Solo conceptos con avance en esta estimación — ${rows.length} de ${data.rows.length})`, 30, y + 12);
  }

  // Tabla de conceptos
  const head = isEstadoCuenta
    ? [['Clave', 'Descripción', 'U.', 'Cant.', 'P.U.', 'Total', 'Ejec. acum.', '% Av.', '$ Acumulado', '$ Por ejec.']]
    : [['Clave', 'Descripción', 'U.', 'Cant.', 'P.U.', 'Total', 'Ejec.', '% Av.', '$ a cobrar', '$ por ejec.']];

  const body = rows.map(r => isEstadoCuenta ? [
    r.c.clave || '', r.c.descripcion || '', r.c.unidad || '',
    num2(r.c.cantidad), money(r.c.precio_unitario), money(r.c.total),
    r.totalAcum ? num2(r.totalAcum) : '—',
    fmtPct(r.pctAv), money(r.aCobrarAcum), money(r.restante)
  ] : [
    r.c.clave || '', r.c.descripcion || '', r.c.unidad || '',
    num2(r.c.cantidad), money(r.c.precio_unitario), money(r.c.total),
    r.enEsta ? num2(r.enEsta) : '—',
    fmtPct(r.pctAv), money(r.aCobrarEsta), money(r.restante)
  ]);

  const footTotal = isEstadoCuenta
    ? [[{ content: 'TOTAL EJECUTADO', colSpan: 8, styles: { halign: 'right', fontStyle: 'bold' } }, { content: money(importeAcumEjec), styles: { halign: 'right', fontStyle: 'bold' } }, '']]
    : [[{ content: 'TOTAL DE LA ESTIMACIÓN', colSpan: 8, styles: { halign: 'right', fontStyle: 'bold' } }, { content: money(subtotalEsta), styles: { halign: 'right', fontStyle: 'bold' } }, '']];

  doc.autoTable({
    startY: 192,
    head, body, foot: footTotal,
    styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 3, lineColor: [200, 210, 220], lineWidth: 0.3 },
    headStyles: { fillColor: [40, 50, 65], textColor: 230, fontStyle: 'bold' },
    footStyles: { fillColor: [240, 245, 250], textColor: 30 },
    columnStyles: {
      0: { cellWidth: 48, font: 'courier' },
      1: { cellWidth: 200 },
      2: { cellWidth: 24 },
      3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' },
      6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right' }, 9: { halign: 'right' }
    },
    didParseCell: (d) => {
      if (d.section !== 'body') return;
      const r = rows[d.row.index];
      if (r?.c?.cantidad && r.totalAcum > r.c.cantidad && d.column.index >= 6) d.cell.styles.fillColor = [253, 245, 220];
    },
    margin: { left: 30, right: 30, bottom: 90 },
    didDrawPage: (data) => drawFooter(doc, data, m)
  });

  if (cfg.mostrarEstadoCuenta) {
    let yy = doc.lastAutoTable.finalY + 16;
    if (yy > 580) { doc.addPage(); yy = 80; }

    doc.setFillColor(245, 248, 252); doc.rect(30, yy, doc.internal.pageSize.width - 60, 18, 'F');
    doc.setFontSize(10); doc.setTextColor(30);
    doc.text('ESTADO DE CUENTA', 38, yy + 13);

    const ecBody = [
      [`Estimación #${est.numero} (esta)`, money(subtotalEsta), money(ivaEsta), money(importeEsta)],
      ['Acumulado ejecutado (todas)', money(importeAcumEjec), money(importeAcumEjec * ivaPct), money(importeAcumEjecCIVA)]
    ];
    if (cfg.mostrarAmortizacion && anticipoPct > 0) {
      ecBody.push([`Amortización anticipo esta (${(anticipoPct * 100).toFixed(2)}%)`, '—', '—', { content: '-' + money(amortizacionEsta), styles: { textColor: [180, 70, 60] } }]);
      ecBody.push(['Amortización anticipo acumulada', '—', '—', { content: '-' + money(amortizacionAcum), styles: { textColor: [180, 70, 60] } }]);
      ecBody.push([{ content: 'Neto a cobrar (esta)', styles: { fontStyle: 'bold' } }, '—', '—', { content: money(netoEsta), styles: { fontStyle: 'bold' } }]);
      ecBody.push([{ content: 'Neto a cobrar (acumulado)', styles: { fontStyle: 'bold' } }, '—', '—', { content: money(netoAcum), styles: { fontStyle: 'bold' } }]);
    }
    ecBody.push(['Pagos cliente (acumulado)', money(subtotalPagado), money(ivaPagado), money(importePagado)]);

    doc.autoTable({
      startY: yy + 22,
      head: [['Documento', 'Subtotal', `IVA (${(ivaPct * 100).toFixed(2)}%)`, 'Importe']],
      body: ecBody,
      styles: { font: 'helvetica', fontSize: 9, cellPadding: 6 },
      headStyles: { fillColor: [40, 50, 65], textColor: 230 },
      columnStyles: { 0: { fontStyle: 'bold' }, 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right', fontStyle: 'bold' } },
      margin: { left: 30, right: 30 }
    });

    yy = doc.lastAutoTable.finalY + 14;
    doc.setFontSize(10); doc.setTextColor(40);
    const lh = 16;
    doc.text(`AVANCE PONDERADO DE OBRA`, 40, yy + lh);
    doc.setTextColor(20); doc.setFontSize(13);
    doc.text(fmtPct(avPond), doc.internal.pageSize.width - 40, yy + lh, { align: 'right' });

    if (cfg.mostrarAmortizacion && anticipoPct > 0) {
      doc.setTextColor(40); doc.setFontSize(9);
      doc.text(`SALDO DE ANTICIPO POR AMORTIZAR`, 40, yy + lh * 2);
      doc.setTextColor(20); doc.setFontSize(11);
      doc.text(`${money(saldoAnticipoPorAmortizar)} de ${money(anticipoMontoBase)}`, doc.internal.pageSize.width - 40, yy + lh * 2, { align: 'right' });
      yy += lh;
    }

    doc.setTextColor(40); doc.setFontSize(10);
    doc.text(`DIFERENCIA FINANCIERA`, 40, yy + lh * 2);
    doc.setTextColor(diferencia >= 0 ? 200 : 25, diferencia >= 0 ? 60 : 100, 60);
    doc.setFontSize(13);
    doc.text(`${money(diferencia)}  (${fmtPct(diferenciaPct)})`, doc.internal.pageSize.width - 40, yy + lh * 2, { align: 'right' });
  }

  if (cfg.notas && cfg.notas.trim()) {
    let ny = doc.lastAutoTable ? doc.lastAutoTable.finalY + 70 : 200;
    if (ny > 600) { doc.addPage(); ny = 80; }
    doc.setFontSize(9); doc.setTextColor(40);
    doc.setFont('helvetica', 'bold'); doc.text('NOTAS / OBSERVACIONES', 30, ny);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(70);
    const lines = doc.splitTextToSize(cfg.notas, doc.internal.pageSize.width - 60);
    doc.text(lines, 30, ny + 14);
  }

  // Anexo de croquis y fotos (opcional)
  if (cfg.incluirAnexoFotos) {
    try { await appendAnexoFotos(doc, obra, estId, m); }
    catch (err) { console.error('No se pudo anexar fotos:', err); }
  }

  const fname = (isEstadoCuenta ? 'EstadoCuenta' : 'RESUMEN') + '_' + safeName(m.nombre) + '_Est' + est.numero + '.pdf';
  doc.save(fname);
}

// ====================================================================
//                          UTILIDADES PDF
// ====================================================================

// Header reducido para invitaciones a licitantes. Oculta información comercial sensible:
//  · Monto del contrato
//  · Nombre del cliente
//  · Número de contrato (referencia interna)
//  · % anticipo
// Solo expone: constructora (nosotros), ubicación, programa y período de la obra.
function drawObraHeaderLite(doc, m, titulo) {
  const w = doc.internal.pageSize.width;

  // Barra de título
  doc.setFillColor(40, 50, 65); doc.rect(0, 0, w, 70, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(230);
  doc.text(titulo, 30, 32);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(180);
  // No mostramos m.nombre por defecto porque podría revelar información del cliente.
  // Si la constructora quiere identificar la obra, puede agregar nombre genérico en el subtítulo.
  doc.setFontSize(8); doc.setTextColor(150);
  doc.text(`Emitido ${new Date().toLocaleString('es-MX')}`, w - 30, 32, { align: 'right' });

  // Banda de datos: solo info no comercial (3 columnas × 2 filas)
  doc.setFillColor(248, 250, 252); doc.rect(0, 70, w, 75, 'F');
  doc.setTextColor(60); doc.setFontSize(8.5);
  const cols = 3;
  const colW = (w - 60) / cols;
  const xs = [0, 1, 2].map(i => 30 + i * colW);
  const ys = [90, 124];
  const cell = (label, val, ix, iy) => {
    const x = xs[ix], y = ys[iy];
    doc.setFont('helvetica', 'bold'); doc.setTextColor(95);
    doc.text(label, x, y);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(35);
    const lines = doc.splitTextToSize(String(val || '—'), colW - 8);
    doc.text(lines.slice(0, 1), x, y + 12);
  };
  cell('Constructora', m.construye, 0, 0);
  cell('Programa', m.programa, 1, 0);
  cell('Ubicación', `${m.ubicacion || ''}${m.municipio ? ', ' + m.municipio : ''}`, 2, 0);
  cell('Inicio de obra', dateStr(m.fechaInicio), 0, 1);
  cell('Fin de obra', dateStr(m.fechaFin), 1, 1);
  cell('', '', 2, 1); // espacio reservado
}

function drawObraHeader(doc, m, titulo) {
  const w = doc.internal.pageSize.width;

  // Barra de título
  doc.setFillColor(40, 50, 65); doc.rect(0, 0, w, 70, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(230);
  doc.text(titulo, 30, 32);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(180);
  const nombreLines = doc.splitTextToSize(m.nombre || '—', w - 240);
  doc.text(nombreLines.slice(0, 1), 30, 50);
  doc.setFontSize(8); doc.setTextColor(150);
  doc.text(`Generado ${new Date().toLocaleString('es-MX')}`, w - 30, 32, { align: 'right' });

  // Banda de datos en grid 4×2
  doc.setFillColor(248, 250, 252); doc.rect(0, 70, w, 75, 'F');
  doc.setTextColor(60); doc.setFontSize(8.5);

  const marginX = 30;
  const cols = 4;
  const colW = (w - marginX * 2) / cols;
  const xs = [0, 1, 2, 3].map(i => marginX + i * colW);
  const ys = [90, 124];

  const cell = (label, val, ix, iy) => {
    const x = xs[ix], y = ys[iy];
    doc.setFont('helvetica', 'bold'); doc.setTextColor(95);
    doc.text(label, x, y);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(35);
    const lines = doc.splitTextToSize(String(val || '—'), colW - 8);
    doc.text(lines.slice(0, 1), x, y + 12);
  };

  // Fila 1
  cell('Contrato No.', m.contratoNo, 0, 0);
  cell('Cliente', m.cliente, 1, 0);
  cell('Construye', m.construye, 2, 0);
  cell('Programa', m.programa, 3, 0);

  // Fila 2
  cell('Ubicación', `${m.ubicacion || ''}${m.municipio ? ', ' + m.municipio : ''}`, 0, 1);
  cell('Inicio', dateStr(m.fechaInicio), 1, 1);
  cell('Fin', dateStr(m.fechaFin), 2, 1);
  cell('Monto C/IVA', money(m.montoContratoCIVA), 3, 1);
}

function drawFooter(doc, data, m) {
  const w = doc.internal.pageSize.width;
  const h = doc.internal.pageSize.height;
  doc.setDrawColor(220); doc.line(30, h - 30, w - 30, h - 30);
  doc.setFontSize(8); doc.setTextColor(150);
  doc.text(`${m.nombre || ''}  ·  Contrato ${m.contratoNo || ''}`, 30, h - 18);
  doc.text(`Página ${data.pageNumber}`, w - 30, h - 18, { align: 'right' });
}

// Footer reducido para invitaciones a licitantes — no incluye datos comerciales.
function drawFooterLite(doc, data, m) {
  const w = doc.internal.pageSize.width;
  const h = doc.internal.pageSize.height;
  doc.setDrawColor(220); doc.line(30, h - 30, w - 30, h - 30);
  doc.setFontSize(8); doc.setTextColor(150);
  doc.text(m.construye || '', 30, h - 18);
  doc.text(`Página ${data.pageNumber}`, w - 30, h - 18, { align: 'right' });
}

// ====================================================================
//                  EXPORT JSON PARA APP HERMANA (SOGRUB)
// ====================================================================
// Formato estable y versionado para que la app contadora pueda importar
// estimaciones cerradas sin acoplarse al modelo interno.

export function exportEstimacionJson(obra, estId) {
  const data = buildResumenData(obra, estId);
  const { m, est, ivaPct, anticipoPct, rows, subtotalEsta, ivaEsta, importeEsta,
          amortizacionEsta, netoEsta, importeAcumEjec, importeAcumEjecCIVA, amortizacionAcum, netoAcum,
          pagoCliente, avPond } = data;

  const payload = {
    schemaVersion: '1.0',
    exportedAt: new Date().toISOString(),
    source: 'app-estimaciones',
    obra: {
      nombre: m.nombre || '',
      contratoNo: m.contratoNo || '',
      cliente: m.cliente || '',
      construye: m.construye || '',
      ubicacion: m.ubicacion || '',
      municipio: m.municipio || '',
      programa: m.programa || '',
      monto_civa: Number(m.montoContratoCIVA) || 0,
      iva_pct: ivaPct,
      anticipo_pct: anticipoPct,
      fecha_inicio: m.fechaInicio || null,
      fecha_fin: m.fechaFin || null
    },
    estimacion: {
      numero: est.numero,
      estado: est.estado,
      fecha_corte: est.fechaCorte || null,
      periodo_ini: est.periodoIni || null,
      periodo_fin: est.periodoFin || null,
      cerrada_at: est.cerradaAt || null,
      subtotal: subtotalEsta,
      iva: ivaEsta,
      importe_bruto: importeEsta,
      amortizacion_anticipo: amortizacionEsta,
      neto_a_cobrar: netoEsta,
      pago_cliente: pagoCliente || null
    },
    acumulados: {
      importe_ejecutado_subtotal: importeAcumEjec,
      importe_ejecutado_civa: importeAcumEjecCIVA,
      amortizacion_acumulada: amortizacionAcum,
      neto_a_cobrar_acumulado: netoAcum,
      avance_ponderado: avPond
    },
    conceptos: rows
      .filter(r => (r.enEsta || 0) > 0 || (r.totalAcum || 0) > 0)
      .map(r => ({
        clave: r.c.clave || '',
        descripcion: r.c.descripcion || '',
        unidad: r.c.unidad || '',
        cantidad_contratada: r.c.cantidad || 0,
        precio_unitario: r.c.precio_unitario || 0,
        importe_contratado: r.c.total || 0,
        ejecutado_esta_estim: r.enEsta || 0,
        ejecutado_acumulado: r.totalAcum || 0,
        importe_esta_estim: r.aCobrarEsta || 0,
        importe_acumulado: r.aCobrarAcum || 0,
        porcentaje_avance: r.pctAv || 0
      }))
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Estimacion_${safeName(m.nombre)}_Est${est.numero}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ====================================================================
//                       SUBCONTRATOS / LICITANTES
// ====================================================================
//
// Tres operaciones:
//   1. exportLicitanteXlsx — genera template para que el licitante llene precios
//   2. exportLicitantePdf  — invitación a cotizar en PDF
//   3. parseLicitanteXlsx  — lee el XLSX devuelto y extrae precios
//   4. exportComparativaXlsx / exportComparativaPdf — comparativa de licitantes
//
// El XLSX para licitante incluye una fila "marca" #LIC# con metadata para que
// al importarse se reconozca como template de subcontrato.

const LIC_MARK = '#APP-ESTIMACIONES-LICITANTE#';

export function exportLicitanteXlsx(obra, sub, conceptosAll) {
  const m = obra.meta || {};
  const meta = sub.meta || {};
  const conceptosSub = sub.conceptos || [];

  // No incluimos monto del contrato, cliente ni # de contrato — info confidencial.
  const aoa = [
    ['SOLICITUD DE COTIZACIÓN'],
    [LIC_MARK, sub.id || '', meta.nombre || ''],   // marca de identificación interna
    [],
    ['CONSTRUCTORA:', m.construye || '', '', 'PROGRAMA:', m.programa || ''],
    ['UBICACIÓN:', `${m.ubicacion || ''}${m.municipio ? ', ' + m.municipio : ''}`, '', 'PERÍODO DE OBRA:', `${dateStr(m.fechaInicio)} – ${dateStr(m.fechaFin)}`],
    ['SUBCONTRATO:', meta.nombre || '', '', 'FECHA EMISIÓN:', dateStr(Date.now())],
    [],
    ['DATOS DEL LICITANTE (favor de llenar)'],
    ['Nombre / Razón social:', ''],
    ['Persona de contacto:', ''],
    ['Email:', ''],
    ['Teléfono:', ''],
    ['Fecha de cotización:', ''],
    [],
    ['INSTRUCCIONES:'],
    ['  · Llene la columna "P.U. COTIZADO" con sus precios unitarios.'],
    ['  · La columna "Importe" se calcula automáticamente.'],
    ['  · NO modifique la columna "Clave" (es nuestro identificador).'],
    ['  · Devuélvanos este mismo archivo lleno por correo.'],
    [],
    ['Clave', 'Descripción', 'Unidad', 'Cantidad', 'P.U. COTIZADO', 'Importe']
  ];

  const headerRow = aoa.length - 1;
  const startData = aoa.length;

  for (const cs of conceptosSub) {
    const cat = conceptosAll[cs.conceptoId];
    if (!cat) continue;
    aoa.push([cat.clave || '', cat.descripcion || '', cat.unidad || '', Number(cs.cantidadSub) || 0, '', '']);
  }
  const endData = aoa.length - 1;
  aoa.push([]);
  aoa.push(['', '', '', 'TOTAL', '', '']);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 14 }, { wch: 60 }, { wch: 8 }, { wch: 12 }, { wch: 16 }, { wch: 16 }];

  // Fórmulas en columna F (Importe = D × E) y total
  for (let r = startData; r <= endData; r++) {
    const dCell = XLSX.utils.encode_cell({ r, c: 3 });
    const eCell = XLSX.utils.encode_cell({ r, c: 4 });
    const fCell = XLSX.utils.encode_cell({ r, c: 5 });
    ws[fCell] = { f: `${dCell}*${eCell}`, t: 'n', z: '"$"#,##0.00' };
    setNumFmt(ws, r, 3, '#,##0.00');
    setNumFmt(ws, r, 4, '"$"#,##0.00');
  }
  // Total: SUM(F)
  const totalRow = endData + 2;
  const fTotal = XLSX.utils.encode_cell({ r: totalRow, c: 5 });
  ws[fTotal] = { f: `SUM(${XLSX.utils.encode_cell({ r: startData, c: 5 })}:${XLSX.utils.encode_cell({ r: endData, c: 5 })})`, t: 'n', z: '"$"#,##0.00' };

  XLSX.utils.book_append_sheet(wb, ws, 'Cotización');
  XLSX.writeFile(wb, `Cotizacion_${safeName(m.nombre)}_${safeName(meta.nombre)}.xlsx`);
}

export function exportLicitantePdf(obra, sub, conceptosAll) {
  const m = obra.meta || {};
  const meta = sub.meta || {};
  const conceptosSub = sub.conceptos || [];

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });

  // Header SIN datos comerciales (monto, cliente, contrato) — info confidencial
  drawObraHeaderLite(doc, m, 'INVITACIÓN A COTIZAR');

  // Sub-encabezado
  let y = 168;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(30);
  doc.text(`Subcontrato: ${meta.nombre || ''}`, 30, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(70);
  if (meta.descripcion) {
    const lines = doc.splitTextToSize(meta.descripcion, doc.internal.pageSize.width - 60);
    doc.text(lines, 30, y + 14);
    y += 14 + lines.length * 11;
  }

  // Datos del licitante (espacio para llenar)
  y += 10;
  doc.setFillColor(245, 248, 252); doc.rect(30, y, doc.internal.pageSize.width - 60, 76, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(40);
  doc.text('DATOS DEL LICITANTE', 38, y + 14);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  const labels = ['Nombre / Razón social:', 'Persona de contacto:', 'Email:', 'Teléfono:', 'Fecha de cotización:'];
  labels.forEach((l, i) => {
    const yy = y + 28 + (i % 3) * 16;
    const xx = i < 3 ? 38 : 320;
    doc.setTextColor(80); doc.text(l, xx, yy);
    doc.setDrawColor(180); doc.line(xx + (i === 0 ? 95 : i === 1 ? 95 : i === 2 ? 35 : i === 3 ? 50 : 100), yy + 1, xx + 250, yy + 1);
  });

  // Tabla de conceptos
  doc.autoTable({
    startY: y + 90,
    head: [['Clave', 'Descripción', 'Unidad', 'Cantidad', 'P.U. cotizado', 'Importe']],
    body: conceptosSub.map(cs => {
      const cat = conceptosAll[cs.conceptoId] || {};
      return [cat.clave || '', cat.descripcion || '', cat.unidad || '', num2(cs.cantidadSub), '', ''];
    }),
    foot: [[{ content: 'TOTAL', colSpan: 5, styles: { halign: 'right', fontStyle: 'bold' } }, '']],
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 5, lineColor: [200, 210, 220], lineWidth: 0.4 },
    headStyles: { fillColor: [40, 50, 65], textColor: 230, fontStyle: 'bold' },
    footStyles: { fillColor: [240, 245, 250], textColor: 30, minCellHeight: 24 },
    columnStyles: {
      0: { cellWidth: 60, font: 'courier' },
      1: { cellWidth: 220 },
      2: { cellWidth: 36, halign: 'center' },
      3: { halign: 'right' },
      4: { halign: 'right', minCellHeight: 22 },
      5: { halign: 'right' }
    },
    margin: { left: 30, right: 30, bottom: 90 },
    didDrawPage: (data) => drawFooterLite(doc, data, m)
  });

  // Bloque firma
  let yy = doc.lastAutoTable.finalY + 30;
  if (yy > 680) { doc.addPage(); yy = 100; }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(60);
  doc.text('NOTAS:', 30, yy);
  for (let i = 0; i < 3; i++) { doc.setDrawColor(200); doc.line(30, yy + 14 + i * 14, doc.internal.pageSize.width - 30, yy + 14 + i * 14); }
  yy += 60;
  // Firmas
  doc.line(60, yy + 30, 260, yy + 30);
  doc.line(360, yy + 30, 560, yy + 30);
  doc.setFontSize(8); doc.setTextColor(120);
  doc.text('Firma del licitante', 160, yy + 42, { align: 'center' });
  doc.text('Sello / fecha', 460, yy + 42, { align: 'center' });

  doc.save(`Invitacion_${safeName(m.nombre)}_${safeName(meta.nombre)}.pdf`);
}

export async function parseLicitanteXlsx(file, sub, conceptosAll = {}) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // Buscar marca opcional
  let isOurTemplate = false;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    if ((rows[i] || []).some(c => c === LIC_MARK)) { isOurTemplate = true; break; }
  }

  // Extraer datos del licitante (si está en formato esperado)
  let nombre = '', email = '';
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const r = rows[i] || [];
    const lbl = String(r[0] || '').toLowerCase();
    if (lbl.includes('nombre') || lbl.includes('razón social')) nombre = String(r[1] || '').trim();
    if (lbl.includes('email') || lbl.includes('correo')) email = String(r[1] || '').trim();
  }

  // Encontrar header de tabla
  let headerIdx = -1, claveCol = -1, puCol = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = (rows[i] || []).map(x => String(x || '').toLowerCase().trim());
    const cIdx = r.findIndex(c => c === 'clave');
    if (cIdx === -1) continue;
    const pIdx = r.findIndex(c => c.includes('p.u') || c.includes('precio unitario') || c.includes('p u') || c === 'pu cotizado' || c.includes('cotizado'));
    if (pIdx === -1) continue;
    headerIdx = i; claveCol = cIdx; puCol = pIdx;
    break;
  }
  if (headerIdx === -1) throw new Error('No se encontró la tabla con columnas "Clave" y "P.U. cotizado"');

  const preciosByClave = {};
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const clave = String(r[claveCol] || '').trim();
    if (!clave) continue;
    const pu = Number(String(r[puCol] || '').replace(/[$,\s]/g, ''));
    if (!Number.isFinite(pu) || pu <= 0) continue;
    preciosByClave[clave] = pu;
  }

  // Mapear clave → conceptoId usando los conceptos del subcontrato + catálogo
  const precios = {};
  let unmatched = [];
  for (const cs of (sub.conceptos || [])) {
    const cat = conceptosAll[cs.conceptoId];
    if (!cat) continue;
    const p = preciosByClave[cat.clave];
    if (p != null) precios[cs.conceptoId] = p;
  }
  for (const k of Object.keys(preciosByClave)) {
    const found = (sub.conceptos || []).some(cs => conceptosAll[cs.conceptoId]?.clave === k);
    if (!found) unmatched.push(k);
  }
  return { nombre, email, precios, preciosByClave, unmatched, isOurTemplate, foundCount: Object.keys(precios).length };
}

export function exportComparativaXlsx(obra, sub, conceptosAll) {
  const m = obra.meta || {};
  const meta = sub.meta || {};
  const conceptosSub = sub.conceptos || [];
  const lics = Object.entries(sub.licitantes || {})
    .filter(([_, l]) => !l.archivado)
    .map(([id, l]) => ({ id, ...l }));

  const aoa = [
    ['COMPARATIVA DE LICITANTES'],
    [],
    ['OBRA:', m.nombre || '', '', 'SUBCONTRATO:', meta.nombre || ''],
    ['CONTRATO:', m.contratoNo || '', '', 'FECHA:', dateStr(Date.now())],
    [],
    ['Clave', 'Descripción', 'U.', 'Cant.', 'P.U. catálogo', 'Importe catálogo',
      ...lics.flatMap(l => [`${l.nombre} P.U.`, `${l.nombre} importe`, `${l.nombre} Ahorro %`])
    ]
  ];

  let totalCat = 0;
  const totales = lics.map(() => 0);

  for (const cs of conceptosSub) {
    const cat = conceptosAll[cs.conceptoId];
    if (!cat) continue;
    const cant = Number(cs.cantidadSub) || 0;
    const puCat = cat.precio_unitario || 0;
    const impCat = cant * puCat;
    totalCat += impCat;
    const cells = [cat.clave, cat.descripcion, cat.unidad, cant, puCat, impCat];
    lics.forEach((l, i) => {
      const p = Number(l.precios?.[cs.conceptoId]);
      const valid = Number.isFinite(p) && p > 0;
      const imp = valid ? p * cant : 0;
      totales[i] += imp;
      cells.push(valid ? p : '');
      cells.push(valid ? imp : '');
      // Ahorro: positivo = licitante más barato que catálogo
      cells.push(valid && puCat > 0 ? (puCat - p) / puCat : '');
    });
    aoa.push(cells);
  }

  // Total
  const totalRow = ['', '', '', '', 'TOTAL', totalCat];
  lics.forEach((l, i) => {
    const t = totales[i];
    totalRow.push('', t, totalCat > 0 ? (totalCat - t) / totalCat : '');
  });
  aoa.push([]);
  aoa.push(totalRow);

  // ===== Análisis =====
  const cotizadosArr = lics.map((_, i) => 0);
  for (const cs of conceptosSub) {
    lics.forEach((l, i) => {
      const p = Number(l.precios?.[cs.conceptoId]);
      if (Number.isFinite(p) && p > 0) cotizadosArr[i]++;
    });
  }
  const resumen = lics.map((l, i) => ({
    nombre: l.nombre || '',
    total: totales[i],
    cotizados: cotizadosArr[i],
    completo: cotizadosArr[i] === conceptosSub.length,
    ahorroAbs: totalCat - totales[i],
    ahorroPct: totalCat > 0 ? (totalCat - totales[i]) / totalCat : 0
  }));
  const completos = resumen.filter(r => r.completo).sort((a, b) => a.total - b.total);
  const ganador = completos.length ? completos[0] : null;

  aoa.push([]);
  aoa.push([]);
  aoa.push(['ANÁLISIS DE COTIZACIONES']);
  aoa.push(['Licitante', 'Cotizado', 'Total', 'Ahorro $ vs catálogo', 'Ahorro % vs catálogo', '# Mejor precio']);
  for (const r of resumen) {
    const i = lics.findIndex(l => (l.nombre || '') === r.nombre);
    let mejores = 0;
    for (const cs of conceptosSub) {
      const precios = lics.map(l => Number(l.precios?.[cs.conceptoId])).filter(p => Number.isFinite(p) && p > 0);
      const best = precios.length ? Math.min(...precios) : null;
      const myP = Number(lics[i].precios?.[cs.conceptoId]);
      if (Number.isFinite(myP) && best != null && Math.abs(myP - best) < 0.01) mejores++;
    }
    aoa.push([
      r.nombre,
      `${r.cotizados} / ${conceptosSub.length}` + (r.completo ? '' : ' (incompleto)'),
      r.total, r.ahorroAbs, r.ahorroPct, mejores
    ]);
  }
  aoa.push([]);
  if (ganador) {
    aoa.push(['OPCIÓN MÁS ECONÓMICA:', ganador.nombre]);
    aoa.push(['Total:', '', ganador.total]);
    aoa.push([(ganador.ahorroAbs >= 0 ? 'Ahorro' : 'Sobrecosto') + ' vs catálogo:', '', Math.abs(ganador.ahorroAbs), ganador.ahorroPct]);
  } else {
    aoa.push(['SIN OPCIÓN COMPLETA — ningún licitante cotizó todo el alcance']);
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const cols = [{ wch: 12 }, { wch: 50 }, { wch: 6 }, { wch: 10 }, { wch: 12 }, { wch: 14 }];
  for (const _ of lics) cols.push({ wch: 12 }, { wch: 14 }, { wch: 9 });
  ws['!cols'] = cols;

  // Formatos
  const headerIdx = 5;
  const startData = 6;
  const endData = startData + conceptosSub.length - 1;
  for (let r = startData; r <= endData; r++) {
    setNumFmt(ws, r, 3, '#,##0.00');
    setNumFmt(ws, r, 4, '"$"#,##0.00');
    setNumFmt(ws, r, 5, '"$"#,##0.00');
    lics.forEach((_, i) => {
      const base = 6 + i * 3;
      setNumFmt(ws, r, base, '"$"#,##0.00');
      setNumFmt(ws, r, base + 1, '"$"#,##0.00');
      setNumFmt(ws, r, base + 2, '0.00%');
    });
  }
  setNumFmt(ws, endData + 2, 5, '"$"#,##0.00');
  lics.forEach((_, i) => {
    const base = 6 + i * 3;
    setNumFmt(ws, endData + 2, base + 1, '"$"#,##0.00');
    setNumFmt(ws, endData + 2, base + 2, '0.00%');
  });

  XLSX.utils.book_append_sheet(wb, ws, 'Comparativa');
  XLSX.writeFile(wb, `Comparativa_${safeName(m.nombre)}_${safeName(meta.nombre)}.xlsx`);
}

export function exportComparativaPdf(obra, sub, conceptosAll) {
  const m = obra.meta || {};
  const meta = sub.meta || {};
  const conceptosSub = sub.conceptos || [];
  const lics = Object.entries(sub.licitantes || {})
    .filter(([_, l]) => !l.archivado)
    .map(([id, l]) => ({ id, ...l }));

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  drawObraHeader(doc, m, `COMPARATIVA — ${meta.nombre || 'Subcontrato'}`);

  // ===== Cómputos por concepto =====
  let totalCat = 0;
  const totales = lics.map(() => 0);
  const cotizados = lics.map(() => 0);   // # conceptos con precio válido por licitante
  const mejores = lics.map(() => 0);     // # conceptos donde es el mejor precio
  const body = [];
  const cellMeta = [];                   // { bestCols: Set, ahorroDir: { col → 'good'|'bad' } } por fila

  for (const cs of conceptosSub) {
    const cat = conceptosAll[cs.conceptoId];
    if (!cat) continue;
    const cant = Number(cs.cantidadSub) || 0;
    const puCat = cat.precio_unitario || 0;
    const impCat = cant * puCat;
    totalCat += impCat;

    const precios = lics.map(l => Number(l.precios?.[cs.conceptoId]));
    const validIdxs = precios.map((p, i) => Number.isFinite(p) && p > 0 ? i : -1).filter(i => i >= 0);
    const bestPU = validIdxs.length ? Math.min(...validIdxs.map(i => precios[i])) : null;

    const row = [cat.clave || '', cat.descripcion || '', cat.unidad || '', num2(cant), money(puCat), money(impCat)];
    const meta = { bestCols: new Set(), ahorroDir: {} };

    lics.forEach((l, i) => {
      const p = precios[i];
      const valid = Number.isFinite(p) && p > 0;
      if (valid) cotizados[i]++;
      const imp = valid ? p * cant : 0;
      if (valid) totales[i] += imp;
      const isBest = valid && bestPU != null && Math.abs(p - bestPU) < 0.01;
      if (isBest) mejores[i]++;

      const baseCol = 6 + i * 3;
      row.push(valid ? money(p) : '—');
      row.push(valid ? money(imp) : '—');
      const ahorroPct = valid && puCat > 0 ? (puCat - p) / puCat : null;
      row.push(ahorroPct != null ? fmtPct(ahorroPct) : '—');

      if (isBest) { meta.bestCols.add(baseCol); meta.bestCols.add(baseCol + 1); }
      if (ahorroPct != null) meta.ahorroDir[baseCol + 2] = ahorroPct >= 0 ? 'good' : 'bad';
    });
    cellMeta.push(meta);
    body.push(row);
  }

  // ===== Encabezado en 2 niveles =====
  const head = [
    [
      { content: 'Clave', rowSpan: 2 },
      { content: 'Descripción', rowSpan: 2 },
      { content: 'U.', rowSpan: 2 },
      { content: 'Cant.', rowSpan: 2 },
      { content: 'CATÁLOGO', colSpan: 2, styles: { halign: 'center' } },
      ...lics.map(l => ({ content: truncate(l.nombre || '', 24), colSpan: 3, styles: { halign: 'center' } }))
    ],
    [
      { content: 'P.U.', styles: { halign: 'right' } },
      { content: 'Importe', styles: { halign: 'right' } },
      ...lics.flatMap(() => [
        { content: 'P.U.', styles: { halign: 'right' } },
        { content: 'Importe', styles: { halign: 'right' } },
        { content: 'Ahorro %', styles: { halign: 'right' } }
      ])
    ]
  ];

  // ===== Fila TOTAL =====
  const totalRow = [
    { content: 'TOTAL', colSpan: 5, styles: { halign: 'right', fontStyle: 'bold' } },
    { content: money(totalCat), styles: { halign: 'right', fontStyle: 'bold' } },
    ...lics.flatMap((l, i) => {
      const ahorroPct = totalCat > 0 ? (totalCat - totales[i]) / totalCat : 0;
      return [
        { content: '', styles: {} },
        { content: money(totales[i]), styles: { halign: 'right', fontStyle: 'bold' } },
        { content: fmtPct(ahorroPct), styles: { halign: 'right', fontStyle: 'bold', textColor: ahorroPct >= 0 ? [40, 130, 80] : [180, 130, 40] } }
      ];
    })
  ];

  // ===== Anchos: dinámico según # licitantes =====
  const pageW = doc.internal.pageSize.width;
  const usableW = pageW - 60;
  const fixedW = 45 + 22 + 38 + 50 + 60; // clave, U, cant, pu cat, imp cat = 215pt
  const remaining = usableW - fixedW;
  // Descripción 30% del remaining; resto se reparte entre licitantes (3 cols c/u)
  const descW = Math.max(140, Math.min(220, Math.round(remaining * 0.32)));
  const licW = (remaining - descW) / Math.max(lics.length, 1);
  const licColW = licW / 3;
  // Mínimos para que no se rompa el layout
  const safeLic = Math.max(licColW, 38);

  const colStyles = {
    0: { cellWidth: 45, font: 'courier' },
    1: { cellWidth: descW },
    2: { cellWidth: 22 },
    3: { halign: 'right', cellWidth: 38 },
    4: { halign: 'right', cellWidth: 50 },
    5: { halign: 'right', cellWidth: 60 }
  };
  for (let i = 0; i < lics.length; i++) {
    colStyles[6 + i * 3] = { halign: 'right', cellWidth: safeLic };
    colStyles[6 + i * 3 + 1] = { halign: 'right', cellWidth: safeLic };
    colStyles[6 + i * 3 + 2] = { halign: 'right', cellWidth: safeLic };
  }

  doc.autoTable({
    startY: 165, head, body, foot: [totalRow],
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 6.8, cellPadding: 3, lineColor: [200, 210, 220], lineWidth: 0.3, overflow: 'linebreak' },
    headStyles: { fillColor: [40, 50, 65], textColor: 230, fontStyle: 'bold', fontSize: 7 },
    footStyles: { fillColor: [240, 245, 250], textColor: 30 },
    columnStyles: colStyles,
    didParseCell: d => {
      if (d.section !== 'body') return;
      const meta = cellMeta[d.row.index];
      if (!meta) return;
      if (meta.bestCols.has(d.column.index)) {
        d.cell.styles.fillColor = [232, 250, 240];
        d.cell.styles.fontStyle = 'bold';
      }
      const dir = meta.ahorroDir[d.column.index];
      if (dir === 'good') d.cell.styles.textColor = [40, 130, 80];
      if (dir === 'bad') d.cell.styles.textColor = [180, 130, 40];
    },
    margin: { left: 30, right: 30, bottom: 40 },
    didDrawPage: (data) => drawFooter(doc, data, m)
  });

  // ===== ANÁLISIS =====
  let yy = doc.lastAutoTable.finalY + 18;
  if (yy > doc.internal.pageSize.height - 200) { doc.addPage(); yy = 60; }

  doc.setFillColor(40, 50, 65); doc.rect(30, yy, pageW - 60, 22, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(230);
  doc.text('ANÁLISIS DE COTIZACIONES', 40, yy + 15);

  // Tabla resumen
  const resumen = lics.map((l, i) => ({
    nombre: l.nombre || '',
    total: totales[i],
    cotizados: cotizados[i],
    mejores: mejores[i],
    ahorroAbs: totalCat - totales[i],
    ahorroPct: totalCat > 0 ? (totalCat - totales[i]) / totalCat : 0,
    completo: cotizados[i] === conceptosSub.length
  }));
  // Solo elegir ganador entre licitantes que cotizaron todo el alcance
  const completos = resumen.filter(r => r.completo);
  completos.sort((a, b) => a.total - b.total);
  const ganador = completos.length ? completos[0] : null;
  const peor = completos.length ? completos[completos.length - 1] : null;

  doc.autoTable({
    startY: yy + 26,
    head: [['Licitante', 'Cotizado', 'Total', 'vs catálogo ($)', 'vs catálogo (%)', '# Mejor precio']],
    body: resumen.map(r => [
      r.nombre,
      `${r.cotizados} / ${conceptosSub.length}` + (r.completo ? '' : ' ⚠'),
      money(r.total),
      (r.ahorroAbs >= 0 ? '-' : '+') + money(Math.abs(r.ahorroAbs)),
      fmtPct(r.ahorroPct),
      String(r.mejores)
    ]),
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 5, lineColor: [200, 210, 220], lineWidth: 0.3 },
    headStyles: { fillColor: [60, 75, 95], textColor: 230 },
    columnStyles: {
      0: { fontStyle: 'bold' },
      1: { halign: 'center' },
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right' },
      5: { halign: 'center' }
    },
    didParseCell: d => {
      if (d.section !== 'body') return;
      const r = resumen[d.row.index];
      if (ganador && r.nombre === ganador.nombre) {
        d.cell.styles.fillColor = [220, 245, 230];
      }
      if (d.column.index === 3 || d.column.index === 4) {
        d.cell.styles.textColor = r.ahorroPct >= 0 ? [40, 130, 80] : [180, 130, 40];
      }
    },
    margin: { left: 30, right: 30 }
  });

  // Recomendación final (banner)
  yy = doc.lastAutoTable.finalY + 16;
  if (yy > doc.internal.pageSize.height - 80) { doc.addPage(); yy = 60; }

  if (ganador) {
    doc.setFillColor(220, 245, 230); doc.rect(30, yy, pageW - 60, 64, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(40, 110, 60);
    doc.text('OPCIÓN MÁS ECONÓMICA', 40, yy + 18);
    doc.setFontSize(14); doc.setTextColor(20, 90, 50);
    doc.text(ganador.nombre, 40, yy + 38);
    doc.setFontSize(11); doc.setTextColor(40);
    doc.text(`Total: ${money(ganador.total)}`, 40, yy + 56);

    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(40, 110, 60);
    const sign = ganador.ahorroAbs >= 0 ? 'AHORRO vs CATÁLOGO' : 'SOBRECOSTO vs CATÁLOGO';
    doc.text(sign, pageW - 40, yy + 18, { align: 'right' });
    doc.setFontSize(14); doc.setTextColor(ganador.ahorroAbs >= 0 ? 20 : 180, ganador.ahorroAbs >= 0 ? 90 : 90, ganador.ahorroAbs >= 0 ? 50 : 60);
    doc.text(money(Math.abs(ganador.ahorroAbs)), pageW - 40, yy + 38, { align: 'right' });
    doc.setFontSize(10); doc.setTextColor(60);
    doc.text(`(${fmtPct(Math.abs(ganador.ahorroPct))})`, pageW - 40, yy + 54, { align: 'right' });

    if (peor && peor.nombre !== ganador.nombre) {
      yy += 70;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
      doc.text(`Diferencia entre el mejor y el peor licitante: ${money(peor.total - ganador.total)} (${fmtPct((peor.total - ganador.total) / ganador.total)})`, 40, yy);
    }
  } else {
    doc.setFillColor(255, 244, 220); doc.rect(30, yy, pageW - 60, 50, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(150, 110, 30);
    doc.text('SIN OPCIÓN COMPLETA', 40, yy + 18);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(60);
    doc.text(`Ningún licitante cotizó los ${conceptosSub.length} conceptos. Solicita cotizaciones completas para poder hacer una recomendación.`, 40, yy + 36);
  }

  doc.save(`Comparativa_${safeName(m.nombre)}_${safeName(meta.nombre)}.pdf`);
}

function setNumFmt(ws, r, c, fmt) {
  const addr = XLSX.utils.encode_cell({ r, c });
  if (ws[addr]) ws[addr].z = fmt;
}

function filterCatalogo(catalog) {
  return Object.entries(catalog)
    .filter(([_, c]) => c.tipo === 'precio_unitario' && !c.archivado)
    .map(([id, c]) => ({ id, ...c }))
    .sort((a, b) => (a.orden || 0) - (b.orden || 0));
}

function sortedEstims(estims) {
  return Object.entries(estims).map(([id, e]) => ({ id, ...e })).sort((a, b) => (a.numero || 0) - (b.numero || 0));
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
