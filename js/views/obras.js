import { h } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import { listObrasForUser, createObra } from '../services/db.js';
import { navigate } from '../state/router.js';
import { money, dateMx, pct } from '../util/format.js';
import { modal, toast } from '../util/dom.js';

export async function renderObrasList() {
  renderShell([{ label: 'Obras' }], h('div', {}, [h('div', { class: 'empty' }, 'Cargando obras…')]));

  let obras;
  try {
    obras = await listObrasForUser(state.user);
  } catch (err) {
    renderShell([{ label: 'Obras' }], h('div', { class: 'empty' }, 'Error: ' + err.message));
    return;
  }
  setState({ obras });

  const isAdmin = state.user.role === 'admin';
  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Obras'),
    h('div', { class: 'spacer', style: { flex: 1 } }),
    isAdmin && h('button', { class: 'btn ghost', onClick: () => navigate('/admin') }, '⚙ Admin'),
    isAdmin && h('button', { class: 'btn primary', onClick: () => newObraDialog() }, '+ Nueva obra')
  ]);

  const ids = Object.keys(obras);
  const grid = ids.length === 0
    ? h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '🏗'),
      h('div', {}, isAdmin ? 'Aún no hay obras. Crea la primera.' : 'No tienes obras asignadas. Pídele al admin que te asigne.')
    ])
    : h('div', { class: 'obras-grid' }, ids.map(id => obraCard(id, obras[id])));

  renderShell([{ label: 'Obras' }], h('div', {}, [head, grid]));
}

function obraCard(id, obra) {
  const m = obra.meta || {};
  const ests = obra.estimaciones || {};
  const numEsts = Object.keys(ests).length;
  // % avance global se podría calcular, pendiente cuando el modelo esté completo
  return h('div', { class: 'obra-card', onClick: () => navigate('/obras/' + id) }, [
    h('h3', {}, m.nombre || 'Sin nombre'),
    h('div', { class: 'meta' }, [
      h('div', {}, [h('span', { class: 'muted' }, 'Contrato '), m.contratoNo || '—']),
      h('div', {}, [h('span', { class: 'muted' }, 'Ubicación: '), m.ubicacion || '—', m.municipio ? `, ${m.municipio}` : '']),
      h('div', {}, [h('span', { class: 'muted' }, 'Monto: '), money(m.montoContratoCIVA)])
    ]),
    h('div', { class: 'stats' }, [
      h('div', {}, [h('b', {}, numEsts), ' estimaciones']),
      h('div', {}, m.fechaInicio ? dateMx(m.fechaInicio) : '—')
    ])
  ]);
}

async function newObraDialog() {
  const nombre = h('input', { placeholder: 'p.ej. Mezzanine Sta Rosa' });
  const contratoNo = h('input', { placeholder: 'Contrato No.' });
  const cliente = h('input', { placeholder: 'Cliente' });
  const construye = h('input', { placeholder: 'Constructora' });
  const ubicacion = h('input', { placeholder: 'Ubicación' });
  const municipio = h('input', { placeholder: 'Municipio' });
  const programa = h('select', {}, [
    h('option', { value: 'PRIVADO' }, 'PRIVADO'),
    h('option', { value: 'PÚBLICO' }, 'PÚBLICO')
  ]);
  const monto = h('input', { type: 'number', step: '0.01', placeholder: 'Monto contrato (con IVA)' });
  const ivaPct = h('input', { type: 'number', step: '0.0001', value: '0.16' });
  const anticipoPct = h('input', { type: 'number', step: '0.01', min: '0', max: '1', value: '0', placeholder: '0.30 = 30%' });
  const fInicio = h('input', { type: 'date' });
  const fFin = h('input', { type: 'date' });

  const body = h('div', {}, [
    h('div', { class: 'field' }, [h('label', {}, 'Nombre'), nombre]),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Contrato No.'), contratoNo]),
      h('div', { class: 'field' }, [h('label', {}, 'Cliente'), cliente])
    ]),
    h('div', { class: 'field' }, [h('label', {}, 'Constructora'), construye]),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Ubicación'), ubicacion]),
      h('div', { class: 'field' }, [h('label', {}, 'Municipio'), municipio])
    ]),
    h('div', { class: 'grid-4' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Programa'), programa]),
      h('div', { class: 'field' }, [h('label', {}, 'Monto C/IVA'), monto]),
      h('div', { class: 'field' }, [h('label', {}, 'IVA'), ivaPct]),
      h('div', { class: 'field' }, [h('label', {}, '% Anticipo'), anticipoPct])
    ]),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Fecha inicio'), fInicio]),
      h('div', { class: 'field' }, [h('label', {}, 'Fecha fin'), fFin])
    ])
  ]);

  await modal({
    title: 'Nueva obra',
    body,
    confirmLabel: 'Crear',
    onConfirm: async () => {
      try {
        const id = await createObra({
          nombre: nombre.value, contratoNo: contratoNo.value, cliente: cliente.value,
          construye: construye.value, ubicacion: ubicacion.value, municipio: municipio.value,
          programa: programa.value, montoContratoCIVA: monto.value,
          ivaPct: ivaPct.value || 0.16,
          anticipoPct: anticipoPct.value || 0,
          fechaInicio: fInicio.value ? new Date(fInicio.value).getTime() : null,
          fechaFin: fFin.value ? new Date(fFin.value).getTime() : null
        }, state.user.uid);
        toast('Obra creada', 'ok');
        navigate('/obras/' + id);
        return true;
      } catch (err) {
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}
