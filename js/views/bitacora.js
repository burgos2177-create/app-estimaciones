// ============================================================================
// Bitácora de Obra — vista. Se abre SOBRE una obra existente de la suite
// (hereda nombre/contrato/cliente/ubicación/residente); no captura la obra de
// cero. Retematizada al tema oscuro de estimaciones. El informe por periodo
// vive en informe-bitacora.js (fase 3).
// ============================================================================

import { h, mount, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state } from '../state/store.js';
import { navigate } from '../state/router.js';
import { loadObra, rread } from '../services/db.js';
import { dateMx } from '../util/format.js';
import {
  CLS, loadBitacora, guardarBorrador, borrarNota, setBitacoraMeta,
  asentarNota, crearNotaAsentada, anularNota
} from '../services/bitacora.js';
import { comprimir, subirFoto } from '../services/bitacora-fotos.js';

const V = { obraId: null, obra: null, meta: null, notas: [], filtro: 'TODAS', q: '', draft: [] };
const nid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmtDT = (iso) => { const d = new Date(iso); return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }) + ' · ' + d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }); };
const folioStr = (n) => n > 0 ? 'NOTA ' + String(n).padStart(3, '0') : 'BORRADOR';
const crumbs = (obraId, nombre) => [{ label: 'Obras', to: '/' }, { label: nombre || obraId.slice(0, 6), to: `/obras/${obraId}` }, { label: 'Bitácora' }];

// ---------- vista móvil / PC ----------
function applyView() {
  const v = localStorage.getItem('bitobra:view') || 'auto';
  const mobile = v === 'mobile' || (v === 'auto' && window.matchMedia('(max-width:640px)').matches);
  document.body.classList.toggle('bit-mobile', mobile);
  document.querySelectorAll('.bit-vt button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
}
window.__bitSetView = (v) => { localStorage.setItem('bitobra:view', v); applyView(); };

export async function renderBitacora({ params }) {
  const obraId = V.obraId = params.id;
  renderShell(crumbs(obraId), h('div', { class: 'empty' }, 'Cargando bitácora…'));
  const obra = V.obra = await loadObra(obraId);
  if (!obra) { renderShell(crumbs(obraId), h('div', { class: 'empty' }, 'Obra no encontrada.')); return; }
  const bit = await loadBitacora(obraId);
  V.meta = bit.meta; V.notas = bit.notas;
  if (!bit.meta) return renderApertura();
  renderLista();
}

// ---------- apertura sobre obra existente ----------
async function renderApertura() {
  const m = V.obra.meta || {};
  let residente = state.user?.displayName || '';
  if (m.ownerUid) { try { const o = await rread(`users/${m.ownerUid}`); if (o?.displayName) residente = o.displayName; } catch {} }

  const panel = h('div', { class: 'card', style: { maxWidth: '640px', margin: '0 auto' } }, [
    h('h3', {}, 'Abrir bitácora de esta obra'),
    h('p', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '12px' } },
      'La bitácora inicia con una nota de apertura (NOTA 001) que hereda los datos de la obra y queda asentada e inalterable. Verifica antes de abrir.'),
    h('div', { class: 'grid-2' }, [
      kv('Obra', m.nombre), kv('Contrato', m.contratoNo || '—'),
      kv('Contratante', m.cliente || '—'), kv('Ubicación', `${m.ubicacion || ''}${m.municipio ? ', ' + m.municipio : ''}` || '—'),
      kv('Residente / superintendente', residente || '—'), kv('Inicio pactado', m.fechaInicio ? dateMx(m.fechaInicio) : '—')
    ]),
    h('div', { class: 'row', style: { marginTop: '16px', justifyContent: 'space-between' } }, [
      h('button', { class: 'btn ghost', onClick: () => navigate(`/obras/${V.obraId}`) }, '← Volver a la obra'),
      h('button', { class: 'btn primary', onClick: () => abrirBitacora(residente) }, 'Abrir bitácora y asentar NOTA 001')
    ])
  ]);
  renderShell(crumbs(V.obraId, m.nombre), h('div', {}, [h('h1', {}, 'Bitácora de obra'), panel]));
  applyView();
}

async function abrirBitacora(residente) {
  const m = V.obra.meta || {};
  const asunto = `Se abre la presente bitácora de obra para «${m.nombre}».\n` +
    `Contratante: ${m.cliente || '—'}. Contratista: Grupo Constructor SOGRUB SAS de CV.\n` +
    (m.contratoNo ? `Contrato: ${m.contratoNo}. ` : '') +
    (m.fechaInicio ? `Inicio pactado: ${dateMx(m.fechaInicio)}. ` : '') +
    `\nResidente/superintendente autorizado para asentar: ${residente || state.user?.displayName || '—'}. ` +
    `Las notas se numeran en forma consecutiva, con fecha del sistema, y una vez asentadas son inalterables; los errores se corrigen mediante anulación y nueva nota.`;
  const nota = { id: nid(), cls: 'APERTURA', asunto, ubicacion: m.ubicacion || '', creadaEn: Date.now(),
    emiteUid: state.user?.uid || '', emiteNombre: residente || state.user?.displayName || '', recibe: m.cliente || '', fotos: [] };
  try {
    await crearNotaAsentada(V.obraId, nota);
    await setBitacoraMeta(V.obraId, { cerrada: false, abiertaAt: Date.now(), abiertaPor: state.user?.uid || '' });
    toast('Bitácora abierta · NOTA 001 asentada', 'ok');
    renderBitacora({ params: { id: V.obraId } });
  } catch (e) { toast('Error al abrir: ' + (e.message || e), 'danger'); }
}

// ---------- lista principal ----------
function renderLista() {
  const m = V.obra.meta || {};
  const cerrada = !!V.meta?.cerrada;
  const asent = V.notas.filter(n => n.estado === 'asentada').length;
  const anul = V.notas.filter(n => n.estado === 'anulada').length;
  const bor = V.notas.filter(n => n.estado === 'borrador').length;
  const fotos = V.notas.reduce((a, n) => a + ((n.fotos || []).length), 0);
  const avNotes = V.notas.filter(n => n.estado !== 'anulada' && n.avance != null);
  const lastAv = avNotes.length ? avNotes[avNotes.length - 1].avance : null;

  const q = V.q.toLowerCase();
  const vis = V.notas.filter(n => {
    if (V.filtro !== 'TODAS' && n.cls !== V.filtro) return false;
    if (q && !((n.asunto || '') + ' ' + (n.ubicacion || '') + ' ' + (n.emiteNombre || '') + ' ' + folioStr(n.folio)).toLowerCase().includes(q)) return false;
    return true;
  }).slice().reverse();

  let lista;
  if (!V.notas.length) lista = h('div', { class: 'empty' }, 'Bitácora abierta, sin notas aún.');
  else if (!vis.length) lista = h('div', { class: 'empty' }, 'Sin notas que coincidan con el filtro o la búsqueda.');
  else lista = h('div', {}, vis.map(notaCard));

  const clasesPresentes = ['APERTURA', ...CLS, 'CIERRE'].filter(c => V.notas.some(n => n.cls === c));

  const body = h('div', {}, [
    h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'flex-start' } }, [
      h('div', {}, [h('h1', {}, 'Bitácora de obra'), h('p', { class: 'muted', style: { fontSize: '13px', margin: '-8px 0 0' } }, `${m.nombre || ''}${m.contratoNo ? ' · Contrato ' + m.contratoNo : ''}`)]),
      h('div', { class: 'bit-vt' }, [
        h('button', { dataset: { v: 'auto' }, onClick: () => window.__bitSetView('auto') }, 'Auto'),
        h('button', { dataset: { v: 'mobile' }, onClick: () => window.__bitSetView('mobile') }, 'Móvil'),
        h('button', { dataset: { v: 'desktop' }, onClick: () => window.__bitSetView('desktop') }, 'PC')
      ])
    ]),
    h('div', { class: 'row', style: { margin: '4px 0 14px' } }, [
      h('span', { class: cerrada ? 'tag danger' : 'tag ok' }, cerrada ? 'Bitácora cerrada' : 'Bitácora abierta')
    ]),

    h('div', { class: 'grid-4', style: { marginBottom: '14px' } }, [
      stat(asent, 'Notas asentadas'), stat(lastAv != null ? lastAv + '%' : '—', 'Último avance físico'),
      stat(fotos, 'Fotografías'), stat(`${anul}${bor ? ' / ' + bor : ''}`, `Anuladas${bor ? ' / borrador' : ''}`)
    ]),
    lastAv != null ? h('div', { class: 'bit-avbar', style: { marginBottom: '16px' } }, h('i', { style: { width: Math.min(100, lastAv) + '%' } })) : null,

    h('div', { class: 'row', style: { marginBottom: '10px' } }, [
      h('button', { class: 'btn primary', disabled: cerrada, onClick: () => openEditor(null, {}) }, '+ Nueva nota'),
      h('button', { class: 'btn', disabled: cerrada, onClick: () => openEditor(null, { avance: true }) }, 'Reporte de avance'),
      h('input', { class: 'bit-search', placeholder: 'Buscar en notas…', value: V.q, oninput: (e) => { V.q = e.target.value; debounceRender(); } }),
      h('div', { style: { flex: 1 } }),
      informeButton(),
      h('button', { class: 'btn ghost', onClick: exportJSON }, 'Exportar JSON'),
      h('button', { class: 'btn ghost', onClick: () => window.print() }, 'Imprimir'),
      !cerrada ? h('button', { class: 'btn danger', onClick: cerrarBitacoraFlow }, 'Cerrar bitácora') : null
    ]),
    h('div', { class: 'row', style: { gap: '6px', marginBottom: '14px' } }, [
      chip('TODAS', 'Todas'),
      ...clasesPresentes.map(c => chip(c, c.charAt(0) + c.slice(1).toLowerCase()))
    ]),
    lista
  ]);
  renderShell(crumbs(V.obraId, m.nombre), body);
  applyView();
  loadFotos();
}

// ---------- informe por periodo (retematizado al tema de la suite) ----------
function informeButton() { return h('button', { class: 'btn', onClick: openInforme }, 'Generar informe'); }

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
const mondayOf = (d) => { const x = startOfDay(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x; };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const PERIODOS = [['semana', 'Semana corriente'], ['semana_ant', 'Semana anterior'], ['quincena_ant', 'Quincena anterior'], ['mes', 'Mes corriente'], ['mes_ant', 'Mes anterior'], ['todo', 'Toda la obra'], ['custom', 'Personalizado…']];
function periodoRango(clave) {
  const now = new Date(); const monThis = mondayOf(now);
  switch (clave) {
    case 'semana': return [monThis, endOfDay(now)];
    case 'semana_ant': return [mondayOf(new Date(monThis.getTime() - 1)), endOfDay(new Date(monThis.getTime() - 1))];
    case 'quincena_ant': {
      const d = now.getDate();
      if (d <= 15) return [startOfDay(new Date(now.getFullYear(), now.getMonth() - 1, 16)), endOfDay(new Date(now.getFullYear(), now.getMonth(), 0))];
      return [startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)), endOfDay(new Date(now.getFullYear(), now.getMonth(), 15))];
    }
    case 'mes': return [startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)), endOfDay(now)];
    case 'mes_ant': return [startOfDay(new Date(now.getFullYear(), now.getMonth() - 1, 1)), endOfDay(new Date(now.getFullYear(), now.getMonth(), 0))];
    case 'todo': return [startOfDay(new Date(2000, 0, 1)), endOfDay(now)];
    default: return [monThis, endOfDay(now)];
  }
}

function openInforme() {
  let clave = 'semana';
  const from = h('input', { type: 'date' }), to = h('input', { type: 'date', value: ymd(new Date()) });
  const elaboro = h('input', { value: state.user?.displayName || '' });
  const incFotos = h('input', { type: 'checkbox', checked: true });
  const customWrap = h('div', { class: 'grid-2', style: { display: 'none' } }, [h('div', { class: 'field' }, [h('label', {}, 'Desde'), from]), h('div', { class: 'field' }, [h('label', {}, 'Hasta'), to])]);
  const prev = h('div', { class: 'tag muted', style: { display: 'block', padding: '10px 12px', marginTop: '4px' } }, '');
  const getRango = () => { if (clave === 'custom') { if (!from.value || !to.value) return null; return [startOfDay(new Date(from.value + 'T00:00')), endOfDay(new Date(to.value + 'T00:00'))]; } return periodoRango(clave); };
  const refresh = () => { const r = getRango(); if (!r) { prev.textContent = 'Indica ambas fechas del periodo personalizado.'; return; } const [a, b] = r; const n = V.notas.filter(x => x.estado === 'asentada' && new Date(x.fecha) >= a && new Date(x.fecha) <= b).length; prev.textContent = `Periodo: ${a.toLocaleDateString('es-MX')} — ${b.toLocaleDateString('es-MX')} · Notas asentadas: ${n}`; };
  const chips = PERIODOS.map(([k, lbl], i) => h('button', { class: 'bit-chip' + (i === 0 ? ' on' : ''), dataset: { p: k }, onClick: (e) => { clave = k; overlay.querySelectorAll('[data-p]').forEach(x => x.classList.toggle('on', x.dataset.p === k)); customWrap.style.display = clave === 'custom' ? 'grid' : 'none'; if (clave === 'custom' && !from.value) { const f = new Date(); f.setDate(f.getDate() - 7); from.value = ymd(f); } refresh(); } }, lbl));
  [from, to].forEach(el => el.addEventListener('input', refresh));

  const overlay = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal', style: { maxHeight: '92vh', overflowY: 'auto' } }, [
    h('h2', {}, 'Generar informe de obra'),
    h('p', { class: 'muted', style: { fontSize: '11px', marginBottom: '14px' } }, 'Recopila las notas asentadas del periodo en un documento formal SOGRUB.'),
    h('div', { class: 'field' }, [h('label', {}, 'Periodo'), h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, chips)]),
    customWrap,
    h('div', { class: 'field' }, [h('label', {}, 'Elaboró (residente/superintendente)'), elaboro]),
    h('label', { class: 'field-inline', style: { margin: '6px 0' } }, [incFotos, 'Incluir evidencia fotográfica']),
    prev,
    h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '16px' } }, [
      h('button', { class: 'btn ghost', onClick: () => overlay.remove() }, 'Cancelar'),
      h('button', { class: 'btn primary', onClick: async () => { const r = getRango(); if (!r) { toast('Completa las fechas', 'warn'); return; } const [a, b] = r; const sel = V.notas.filter(x => x.estado === 'asentada' && new Date(x.fecha) >= a && new Date(x.fecha) <= b).sort((x, y) => x.folio - y.folio); if (!sel.length) { toast('No hay notas asentadas en ese periodo', 'warn'); return; } overlay.remove(); renderInforme(sel, a, b, { withFotos: incFotos.checked, elaboro: elaboro.value.trim(), clave }); } }, 'Generar documento')
    ])
  ]));
  document.body.appendChild(overlay);
  refresh();
}

function renderInforme(notas, a, b, opt) {
  const p = V.obra.meta || {};
  const perLabel = (PERIODOS.find(x => x[0] === opt.clave) || ['', 'Personalizado'])[1];
  const avNotes = notas.filter(n => n.avance != null);
  const avIni = avNotes.length ? avNotes[0].avance : null, avFin = avNotes.length ? avNotes[avNotes.length - 1].avance : null;
  const totalFotos = notas.reduce((s, n) => s + (opt.withFotos ? (n.fotos || []).length : 0), 0);
  const porCls = {}; notas.forEach(n => porCls[n.cls] = (porCls[n.cls] || 0) + 1);
  const esc = (s) => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const filas = notas.map(n => {
    const det = [];
    const add = (k, v) => { if (v != null && v !== '') det.push([k, v]); };
    add('Ubicación', n.ubicacion); add('Causa', n.causa); add('Solución / instrucción', n.solucion);
    add('Prevención', n.prevencion); add('Consecuencia económica', n.impacto); add('Responsabilidad', n.responsable);
    add('Fecha de atención', n.fechaAtencion); if (n.avance != null) add('Avance físico', n.avance + ' %');
    add('Personal en obra', n.personal); add('Condiciones climáticas', n.clima); if (n.ref) add('Referencia', 'NOTA ' + String(n.ref).padStart(3, '0'));
    const fotos = opt.withFotos ? (n.fotos || []) : [];
    return `<div class="nt">
      <div class="nh"><span class="fo">${folioStr(n.folio)}</span><span class="cl">${esc(n.cls)}</span><span class="fe">${fmtDT(n.fecha)}</span></div>
      <div class="as">${esc(n.asunto)}</div>
      ${det.length ? `<table class="dt">${det.map(d => `<tr><td>${d[0]}</td><td>${esc(String(d[1]))}</td></tr>`).join('')}</table>` : ''}
      ${fotos.length ? `<div class="ft">${fotos.map(f => `<img src="${f.url}">`).join('')}</div>` : ''}
      <div class="fi"><span>Emite: <b>${esc(n.emiteNombre || '—')}</b></span><span>Recibe/enterado: <b>${esc(n.recibe || '—')}</b></span></div>
    </div>`;
  }).join('');
  const clsResumen = Object.entries(porCls).sort((x, y) => y[1] - x[1]).map(([c, q]) => `<span class="pl">${c.charAt(0) + c.slice(1).toLowerCase()}: <b>${q}</b></span>`).join('');

  // Retematizado: sin Fraunces/navy/cyan; tipografía de sistema + grises neutros
  // + acento de la suite. Conserva membrete textual SOGRUB y firmas Elaboró/Revisó.
  const doc = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Informe de obra · ${esc(p.nombre)} · ${a.toLocaleDateString('es-MX')}</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1f;font-size:11px;line-height:1.5;background:#eceef2}
.page{max-width:820px;margin:20px auto;background:#fff;padding:46px 52px;box-shadow:0 4px 30px rgba(0,0,0,.12)}
.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #262c38;padding-bottom:16px;margin-bottom:22px}
.br{display:flex;gap:12px;align-items:center}
.lg{width:44px;height:44px;border-radius:9px;background:#262c38;color:#4cc2ff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:22px}
.br h1{font-size:18px;color:#262c38}.br small{color:#6a6c85;letter-spacing:1.5px;font-size:8.5px;text-transform:uppercase}
.mt{text-align:right;font-size:9.5px;color:#555}
.ti{font-size:22px;color:#262c38;font-weight:700;margin-bottom:2px}.pe{color:#2c8ec0;font-weight:600;font-size:13px;margin-bottom:20px}
.bk{border:1px solid #dde;border-radius:8px;padding:14px 16px;margin-bottom:18px}.bk h3{font-size:12px;color:#262c38;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
.in{display:grid;grid-template-columns:1fr 1fr;gap:3px 20px}.in div{border-bottom:1px dotted #ddd;padding:2px 0;display:flex;justify-content:space-between;gap:10px}
.in span:first-child{color:#888;font-size:9.5px;text-transform:uppercase}.in b{text-align:right}
.st{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px}.st .s{flex:1;min-width:110px;background:#f5f7fb;border:1px solid #e3e7f0;border-radius:8px;padding:10px 14px;text-align:center}
.st b{display:block;font-size:22px;color:#2c8ec0}.st span{font-size:8.5px;text-transform:uppercase;letter-spacing:1px;color:#888}
.pl{display:inline-block;background:#eef3fa;border:1px solid #dbe6f2;border-radius:20px;padding:3px 11px;margin:3px 4px 0 0;font-size:10px}
.se{font-size:14px;color:#262c38;font-weight:700;border-bottom:1px solid #262c38;padding-bottom:5px;margin:24px 0 14px}
.nt{border:1px solid #dde;border-left:3px solid #4cc2ff;border-radius:8px;padding:13px 15px;margin-bottom:12px;break-inside:avoid}
.nh{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:7px}.fo{font-weight:700;color:#262c38;font-size:13px}
.cl{font-size:8.5px;letter-spacing:1px;text-transform:uppercase;background:#262c38;color:#fff;border-radius:4px;padding:2px 8px}.fe{color:#888;font-size:10px;margin-left:auto}
.as{white-space:pre-wrap;margin-bottom:8px}.dt{width:100%;border-collapse:collapse;margin-bottom:8px}
.dt td{border:1px solid #eaeef4;padding:4px 8px;vertical-align:top;font-size:10px}.dt td:first-child{background:#f6f8fb;color:#666;width:150px;text-transform:uppercase;font-size:8.5px}
.ft{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}.ft img{width:140px;height:104px;object-fit:cover;border:1px solid #ddd;border-radius:5px}
.fi{display:flex;gap:24px;flex-wrap:wrap;border-top:1px dotted #ddd;padding-top:7px;font-size:10px;color:#555}
.sg{display:flex;justify-content:space-around;gap:40px;margin-top:46px;break-inside:avoid}.sg div{flex:1;text-align:center;border-top:1px solid #333;padding-top:6px;font-size:10px}.sg b{display:block;color:#262c38}
.fo2{margin-top:30px;border-top:1px solid #ddd;padding-top:10px;font-size:8.5px;color:#999;text-align:center}
.ac{max-width:820px;margin:0 auto;padding:14px 52px;display:flex;gap:10px;justify-content:flex-end}.ac button{cursor:pointer;border:none;border-radius:7px;padding:10px 18px;font-size:12px}
.pr{background:#4cc2ff;color:#08121a;font-weight:600}.cs{background:#e5e8ee;color:#444}
@media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none;padding:0 8mm}.ac{display:none}}
</style></head><body>
<div class="ac"><button class="cs" onclick="window.close()">Cerrar</button><button class="pr" onclick="window.print()">Imprimir / Guardar PDF</button></div>
<div class="page">
  <div class="hd"><div class="br"><div class="lg">S</div><div><h1>Grupo Constructor SOGRUB</h1><small>SAS de CV · RFC GCS231002C19</small></div></div>
    <div class="mt">Corregidora, Querétaro<br>Emitido: ${new Date().toLocaleString('es-MX')}<br>Documento generado desde bitácora</div></div>
  <div class="ti">Informe de seguimiento de obra</div>
  <div class="pe">${perLabel} · ${a.toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' })} al ${b.toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' })}</div>
  <div class="bk"><h3>Datos de la obra</h3><div class="in">
    <div><span>Obra</span><b>${esc(p.nombre)}</b></div><div><span>Contrato</span><b>${esc(p.contratoNo || '—')}</b></div>
    <div><span>Contratante</span><b>${esc(p.cliente || '—')}</b></div><div><span>Ubicación</span><b>${esc(p.ubicacion || '—')}</b></div>
  </div></div>
  <div class="bk"><h3>Resumen del periodo</h3><div class="st">
    <div class="s"><b>${notas.length}</b><span>Notas asentadas</span></div>
    <div class="s"><b>${avFin != null ? avFin + '%' : '—'}</b><span>Avance al cierre</span></div>
    <div class="s"><b>${avIni != null && avFin != null ? '+' + (avFin - avIni) + '%' : '—'}</b><span>Progreso en el lapso</span></div>
    <div class="s"><b>${totalFotos}</b><span>Fotografías</span></div>
  </div><div style="margin-top:8px">${clsResumen}</div></div>
  <div class="se">Notas de bitácora del periodo</div>
  ${filas}
  <div class="sg"><div><b>${esc(opt.elaboro || state.user?.displayName || '')}</b>Elaboró — Residente / Superintendente</div><div><b>${esc(p.cliente || '')}</b>Revisó / Enterado — Supervisión</div></div>
  <div class="fo2">Este informe recopila exclusivamente las notas ASENTADAS de la bitácora de obra en el periodo indicado. Las notas asentadas constituyen registro inalterable; su contenido íntegro obra en la bitácora. Documento de control interno emitido por Grupo Constructor SOGRUB SAS de CV.</div>
</div></body></html>`;

  const w = window.open('', '_blank');
  if (!w) { toast('Permite las ventanas emergentes para ver el informe', 'warn'); return; }
  w.document.open(); w.document.write(doc); w.document.close();
  toast('Informe generado (' + notas.length + ' notas)', 'ok');
}

let _rt;
function debounceRender() { clearTimeout(_rt); _rt = setTimeout(() => { const el = document.querySelector('.bit-search'); const pos = el?.selectionStart; renderLista(); const n = document.querySelector('.bit-search'); if (n) { n.focus(); if (pos != null) n.setSelectionRange(pos, pos); } }, 220); }

function stat(v, label) { return h('div', { class: 'card', style: { padding: '12px 14px' } }, [h('b', { style: { display: 'block', fontSize: '20px', color: 'var(--accent)' } }, String(v)), h('span', { class: 'muted', style: { fontSize: '10px', letterSpacing: '1px', textTransform: 'uppercase' } }, label)]); }
function chip(f, label) { return h('button', { class: 'bit-chip' + (V.filtro === f ? ' on' : ''), onClick: () => { V.filtro = f; renderLista(); } }, label); }
function kv(label, val) { return h('div', { class: 'field' }, [h('label', {}, label), h('div', {}, val || '—')]); }

// ---------- tarjeta de nota ----------
function notaCard(n) {
  const det = [];
  const push = (k, v) => { if (v != null && v !== '') det.push([k, v]); };
  push('Ubicación', n.ubicacion); push('Causa', n.causa); push('Solución', n.solucion);
  push('Prevención', n.prevencion); push('Consec. económica', n.impacto); push('Responsabilidad', n.responsable);
  push('Fecha de atención', n.fechaAtencion); if (n.avance != null) push('Avance físico', n.avance + ' %');
  push('Personal en obra', n.personal); push('Condiciones clima', n.clima);

  const actions = [];
  if (n.estado === 'borrador') {
    actions.push(h('button', { class: 'btn primary sm', onClick: () => asentarFlow(n) }, 'Asentar nota'));
    actions.push(h('button', { class: 'btn sm', onClick: () => openEditor(n, {}) }, 'Editar borrador'));
    actions.push(h('button', { class: 'btn danger sm', onClick: () => descartarFlow(n) }, 'Descartar'));
  } else if (n.estado === 'asentada' && !V.meta?.cerrada && n.cls !== 'APERTURA' && n.cls !== 'CIERRE') {
    actions.push(h('button', { class: 'btn ghost sm', onClick: () => openEditor(null, { ref: n.folio }) }, '↳ Responder'));
    actions.push(h('button', { class: 'btn danger sm', onClick: () => anularFlow(n) }, 'Anular'));
  }

  return h('div', { class: 'bit-nota ' + n.estado }, [
    h('div', { class: 'bit-nh' }, [
      h('span', { class: 'bit-folio' }, folioStr(n.folio)),
      h('span', { class: 'bit-cls' }, n.cls),
      h('span', { class: 'muted', style: { fontSize: '11px' } }, n.estado === 'borrador' ? ('Reportado ' + fmtDT(n.reportadoEn || n.creadaEn)) : fmtDT(n.fecha)),
      h('span', { class: 'bit-status s-' + n.estado, style: { marginLeft: 'auto' } }, n.estado === 'asentada' ? '● Asentada' : n.estado === 'borrador' ? '○ Borrador' : '✕ Anulada')
    ]),
    h('div', { style: { padding: '12px 14px' } }, [
      n.ref ? h('div', { class: 'bit-ref' }, `↳ En referencia a ${folioStr(n.ref)}`) : null,
      n.anuladaPor ? h('div', { class: 'bit-ref', style: { color: 'var(--danger)' } }, `✕ Anulada mediante ${folioStr(n.anuladaPor)} — ${n.motivoAnulacion || ''}`) : null,
      h('div', { class: 'bit-asunto' }, n.asunto),
      det.length ? h('dl', { class: 'bit-det' }, det.flatMap(d => [h('dt', {}, d[0]), h('dd', {}, String(d[1]))])) : null,
      (n.fotos || []).length ? h('div', { class: 'bit-fotos', dataset: { nid: n.id } }, (n.fotos).map(f => h('img', { src: f.url, loading: 'lazy', onClick: () => lightbox(f.url) }))) : null,
      h('div', { class: 'bit-firmas' }, [
        firma(n.emiteNombre, 'Emite'), firma(n.recibe, 'Recibe / enterado')
      ]),
      (n.estado === 'asentada' && n.reportadoEn && n.asentadaEn && Math.abs(Date.parse(n.asentadaEn) - n.reportadoEn) > 60000)
        ? h('div', { class: 'bit-sello', style: { color: 'var(--warn)' } }, `Reportado el ${fmtDT(n.reportadoEn)} · asentado el ${fmtDT(n.asentadaEn)}`) : null,
      n.estado === 'asentada' ? h('div', { class: 'bit-sello' }, `Asentada el ${fmtDT(n.asentadaEn || n.fecha)} · folio consecutivo verificado · registro inalterable`) : null
    ]),
    actions.length ? h('div', { class: 'row', style: { padding: '0 14px 14px' } }, actions) : null
  ]);
}
function firma(nombre, rol) { return h('div', { class: 'bit-firma' }, [h('b', {}, nombre || '—'), h('span', {}, rol)]); }
function lightbox(src) { const d = h('div', { class: 'bit-lightbox', onClick: (e) => e.currentTarget.remove() }, h('img', { src })); document.body.appendChild(d); }
function loadFotos() { /* las <img> cargan por URL directa desde Storage; nada que hidratar */ }

// ---------- editor ----------
function openEditor(nota, opts) {
  opts = opts || {};
  const m = V.obra.meta || {};
  const isEdit = !!nota;
  const d = nota || { cls: opts.avance ? 'AVANCE' : 'AVANCE', asunto: '', ubicacion: '', causa: '', solucion: '', prevencion: '', impacto: '', responsable: '', fechaAtencion: '', avance: null, personal: '', clima: '', recibe: m.cliente || '', ref: opts.ref || null };
  V.draft = [];
  let cls = d.cls;

  const input = (id, val, attrs = {}) => h('input', { id, value: val ?? '', ...attrs });
  const clsChips = CLS.map(c => h('button', { class: 'bit-chip' + (cls === c ? ' on' : ''), dataset: { c }, onClick: (e) => { cls = c; overlay.querySelectorAll('[data-c]').forEach(x => x.classList.toggle('on', x.dataset.c === cls)); } }, c.charAt(0) + c.slice(1).toLowerCase()));
  const prev = h('div', { class: 'bit-fotoprev' });

  const body = h('div', {}, [
    h('div', { class: 'field' }, [h('label', {}, 'Clasificación'), h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, clsChips)]),
    h('div', { class: 'field' }, [h('label', {}, 'Descripción del asunto *'), h('textarea', { id: 'e_asunto', placeholder: 'Describe el hecho de forma clara y sin ambigüedades. Un asunto por nota.' }, d.asunto || '')]),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Ubicación en obra'), input('e_ubic', d.ubicacion, { placeholder: 'Eje, nivel, frente…' })]),
      h('div', { class: 'field' }, [h('label', {}, 'Fecha límite de atención'), input('e_fat', d.fechaAtencion, { type: 'date' })])
    ]),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Causa'), input('e_causa', d.causa)]),
      h('div', { class: 'field' }, [h('label', {}, 'Solución / instrucción'), input('e_sol', d.solucion)])
    ]),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Prevención'), input('e_prev', d.prevencion)]),
      h('div', { class: 'field' }, [h('label', {}, 'Consecuencia económica'), input('e_imp', d.impacto, { placeholder: 'Monto o «sin impacto»' })])
    ]),
    h('div', { class: 'field' }, [h('label', {}, 'Responsabilidad (si la hubiere)'), input('e_resp', d.responsable)]),
    h('div', { class: 'grid-3' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Avance físico %'), input('e_av', d.avance != null ? d.avance : '', { type: 'number', min: '0', max: '100', placeholder: '—' })]),
      h('div', { class: 'field' }, [h('label', {}, 'Personal en obra'), input('e_pers', d.personal, { placeholder: 'p. ej. 8 (2 alb, 4 ayud…)' })]),
      h('div', { class: 'field' }, [h('label', {}, 'Clima'), input('e_clima', d.clima, { placeholder: 'Despejado / lluvia…' })])
    ]),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Emite'), h('input', { value: state.user?.displayName || state.user?.email || '', disabled: true })]),
      h('div', { class: 'field' }, [h('label', {}, 'Recibe / enterado'), input('e_recibe', d.recibe)])
    ]),
    h('div', { class: 'field' }, [
      h('label', {}, 'Evidencia fotográfica (máx 4, se comprimen)'),
      h('input', { type: 'file', id: 'e_fotos', accept: 'image/*', multiple: true, capture: 'environment', onchange: onFotos }),
      prev
    ])
  ]);

  const overlay = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal lg', style: { maxHeight: '92vh', overflowY: 'auto' } }, [
    h('h2', {}, isEdit ? 'Editar borrador — ' + folioStr(nota.folio) : 'Nueva nota de bitácora'),
    h('p', { class: 'muted', style: { fontSize: '11px', marginBottom: '14px' } }, `Folio y fecha se asignan por el sistema al asentar.${d.ref ? ' En referencia a ' + folioStr(d.ref) + '.' : ''}`),
    body,
    h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '16px' } }, [
      h('button', { class: 'btn ghost', onClick: close }, 'Cancelar'),
      h('button', { class: 'btn', onClick: () => save(false) }, 'Guardar borrador'),
      h('button', { class: 'btn primary', onClick: () => save(true) }, 'Asentar nota')
    ])
  ]));
  document.body.appendChild(overlay);
  const escH = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', escH);
  function close() { document.removeEventListener('keydown', escH); overlay.remove(); }
  if (opts.avance) setTimeout(() => document.getElementById('e_av')?.focus(), 50);

  async function onFotos(e) {
    for (const f of Array.from(e.target.files)) {
      if (V.draft.length >= 4) { toast('Máximo 4 fotos por nota', 'warn'); break; }
      const blob = await comprimir(f); if (blob) V.draft.push(blob);
    }
    e.target.value = '';
    prev.innerHTML = '';
    V.draft.forEach((b, i) => {
      const url = URL.createObjectURL(b);
      const wrap = h('div', { class: 'fp' }, [h('img', { src: url }), h('button', { onClick: () => { V.draft.splice(i, 1); onFotos({ target: { files: [], value: '' } }); } }, '×')]);
      prev.appendChild(wrap);
    });
  }
  function collect() {
    const g = (id) => (document.getElementById(id)?.value || '').trim();
    const av = g('e_av');
    return { cls, asunto: g('e_asunto'), ubicacion: g('e_ubic'), causa: g('e_causa'), solucion: g('e_sol'), prevencion: g('e_prev'), impacto: g('e_imp'), responsable: g('e_resp'), fechaAtencion: g('e_fat'), avance: av === '' ? null : Math.max(0, Math.min(100, parseFloat(av))), personal: g('e_pers'), clima: g('e_clima'), recibe: g('e_recibe'), ref: d.ref || null };
  }
  let busy = false;
  async function save(asentar) {
    if (busy) return;
    const c = collect();
    if (!c.asunto) { toast('La descripción del asunto es obligatoria', 'warn'); return; }
    if (asentar && !await modal({ title: 'Asentar nota', body: h('p', {}, 'Al asentar, la nota recibe folio y fecha del sistema y ya NO podrá editarse ni borrarse (solo anularse mediante otra nota). ¿Asentar ahora?'), confirmLabel: 'Asentar' })) return;
    busy = true;
    try {
      const notaId = isEdit ? nota.id : nid();
      // Subida de fotos best-effort: si una falla (p.ej. reglas de Storage), NO
      // se cae el asentado; la nota legal se guarda con las fotos que sí subieron.
      const fotos = [...(isEdit ? (nota.fotos || []) : [])];
      let fotoFail = 0;
      for (let i = 0; i < V.draft.length; i++) {
        try { fotos.push(await subirFoto(V.obraId, notaId, fotos.length, V.draft[i])); }
        catch (e) { fotoFail++; console.warn('[Bitácora] foto no subida:', e); }
      }
      // Hora de reporte: se sella al primer guardado (borrador) y se conserva al
      // asentar más tarde. Es informativa; la fecha oficial (art. 94) sigue siendo
      // la del sistema al asentar.
      const reportadoEn = (isEdit ? (nota.reportadoEn || nota.creadaEn) : null) || Date.now();
      const n = Object.assign({}, isEdit ? nota : {}, c, {
        id: notaId, fotos, reportadoEn,
        creadaEn: (isEdit ? nota.creadaEn : null) || reportadoEn,
        emiteUid: state.user?.uid || '', emiteNombre: state.user?.displayName || state.user?.email || ''
      });
      if (asentar) {
        if (isEdit) { await guardarBorrador(V.obraId, { ...n, estado: 'borrador', folio: 0 }); await asentarNota(V.obraId, notaId); }
        else { await crearNotaAsentada(V.obraId, n); }
      } else {
        await guardarBorrador(V.obraId, { ...n, estado: 'borrador', folio: n.folio || 0 });
      }
      close();
      const okMsg = asentar ? 'Nota asentada' : 'Borrador guardado';
      toast(fotoFail ? `${okMsg}, pero ${fotoFail} foto(s) no se subieron (revisa permisos de Storage).` : okMsg, fotoFail ? 'warn' : 'ok');
      const bit = await loadBitacora(V.obraId); V.meta = bit.meta; V.notas = bit.notas; renderLista();
    } catch (e) { busy = false; toast('Error: ' + (e.message || e), 'danger'); }
  }
}

// ---------- acciones ----------
async function asentarFlow(n) {
  if (!await modal({ title: 'Asentar nota', body: h('p', {}, 'Al asentar, la nota recibe folio y fecha del sistema y será inalterable. ¿Continuar?'), confirmLabel: 'Asentar' })) return;
  try { await asentarNota(V.obraId, n.id); toast('Nota asentada', 'ok'); await reload(); } catch (e) { toast('Error: ' + (e.message || e), 'danger'); }
}
async function descartarFlow(n) {
  if (!await modal({ title: 'Descartar borrador', body: h('p', {}, 'Los borradores no forman parte del registro legal; las notas asentadas nunca se borran. ¿Descartar este borrador?'), confirmLabel: 'Descartar', danger: true })) return;
  try { await borrarNota(V.obraId, n.id); toast('Borrador descartado', 'ok'); await reload(); } catch (e) { toast('Error: ' + (e.message || e), 'danger'); }
}
async function anularFlow(n) {
  const ta = h('textarea', { placeholder: 'Motivo de anulación (quedará registrado en una nueva nota)' });
  const okp = await modal({ title: 'Anular ' + folioStr(n.folio), body: h('div', {}, [h('p', { class: 'muted', style: { fontSize: '12px' } }, 'La nota anulada permanece como constancia y carece de efectos; se emite una nota nueva con la anulación.'), ta]), confirmLabel: 'Anular', danger: true });
  if (!okp) return;
  const motivo = (ta.value || '').trim();
  if (!motivo) { toast('Se requiere el motivo', 'warn'); return; }
  const nueva = { id: nid(), cls: n.cls, asunto: `Se ANULA la ${folioStr(n.folio)} por el siguiente motivo: ${motivo}. La nota anulada permanece únicamente como constancia y carece de efectos.`, creadaEn: Date.now(), emiteUid: state.user?.uid || '', emiteNombre: state.user?.displayName || state.user?.email || '', recibe: (V.obra.meta || {}).cliente || '', fotos: [] };
  try { await anularNota(V.obraId, n.id, motivo, nueva); toast('Nota anulada', 'ok'); await reload(); } catch (e) { toast('Error: ' + (e.message || e), 'danger'); }
}
async function cerrarBitacoraFlow() {
  if (V.notas.some(n => n.estado === 'borrador')) { toast('Asienta o descarta los borradores antes de cerrar', 'warn'); return; }
  if (!await modal({ title: 'Cerrar bitácora', body: h('p', {}, 'El cierre asienta la nota final y BLOQUEA la bitácora: no podrán agregarse más notas. ¿Cerrar?'), confirmLabel: 'Cerrar', danger: true })) return;
  const m = V.obra.meta || {};
  const nota = { id: nid(), cls: 'CIERRE', asunto: `Con esta fecha se CIERRA la presente bitácora de «${m.nombre}», dándose por concluido el registro de los trabajos. El cierre no exime al contratista de responsabilidad por vicios ocultos conforme al contrato.`, creadaEn: Date.now(), emiteUid: state.user?.uid || '', emiteNombre: state.user?.displayName || state.user?.email || '', recibe: m.cliente || '', fotos: [] };
  try { await crearNotaAsentada(V.obraId, nota); await setBitacoraMeta(V.obraId, { cerrada: true, cerradaAt: Date.now(), cerradaPor: state.user?.uid || '' }); toast('Bitácora cerrada', 'ok'); await reload(); } catch (e) { toast('Error: ' + (e.message || e), 'danger'); }
}
async function reload() { const bit = await loadBitacora(V.obraId); V.meta = bit.meta; V.notas = bit.notas; renderLista(); }

// ---------- export JSON ----------
function exportJSON() {
  const out = { app: 'SOGRUB Bitácora de Obra', version: 2, exportado: new Date().toISOString(), obra: V.obra.meta || {}, notas: V.notas };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'bitacora_' + ((V.obra.meta?.contratoNo || V.obra.meta?.nombre || 'obra').replace(/[^\w-]+/g, '_')) + '.json'; a.click();
  toast('JSON exportado', 'ok');
}

// exports para la fase 3 (informe)
export { V, folioStr, fmtDT };
