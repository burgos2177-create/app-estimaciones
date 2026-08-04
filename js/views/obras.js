import { h } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import { listObrasForUser, createObra, getEstadoObras } from '../services/db.js';
import { navigate } from '../state/router.js';
import { money, dateMx, pct } from '../util/format.js';
import { modal, toast } from '../util/dom.js';
import { buildIntegracionForm } from './integracion-form.js';

// Estados del proyecto contable que sacan a la obra del listado: sólo se
// trabaja en las activas. La obra sigue existiendo y su URL /obras/{id} sigue
// funcionando; sólo deja de estorbar en el día a día. Se administra desde la
// consola de la suite (no desde aquí).
const ESTADOS_OCULTOS = ['pausa', 'terminado'];
const ETIQUETA_ESTADO = { pausa: '⏸ En pausa', terminado: '✓ Terminada' };

// Mostrar también las ocultas (lo prende el usuario con "Ver todas"). Vive
// fuera de la función para sobrevivir al re-render.
let _verOcultas = false;

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

  // El estado vive en bitácora. Si no se puede leer (permisos del ingeniero,
  // red caída), se muestran TODAS: es preferible mostrar de más que dejar a
  // alguien sin sus obras por un fallo de lectura ajeno a esta app.
  let estados = {};
  try {
    estados = await getEstadoObras();
  } catch (err) {
    console.warn('[Obras] no se pudo leer el estado de los proyectos; se muestran todas', err);
  }

  const isAdmin = state.user.role === 'admin';
  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Obras'),
    h('div', { class: 'spacer', style: { flex: 1 } }),
    isAdmin && h('button', { class: 'btn ghost', onClick: () => navigate('/admin') }, '⚙ Admin'),
    isAdmin && h('button', { class: 'btn primary', onClick: () => newObraDialog() }, '+ Nueva obra')
  ]);

  const ids = Object.keys(obras);
  // Sin estado (obra no vinculada aún) = activa. Nunca esconder por omisión.
  const ocultas  = ids.filter(id => ESTADOS_OCULTOS.includes(estados[id]));
  const visibles = _verOcultas ? ids : ids.filter(id => !ESTADOS_OCULTOS.includes(estados[id]));

  const grid = visibles.length === 0
    ? h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '🏗'),
      ocultas.length > 0
        ? h('div', {}, `No tienes obras activas (${ocultas.length} en pausa o terminada${ocultas.length === 1 ? '' : 's'}).`)
        : h('div', {}, isAdmin ? 'Aún no hay obras. Crea la primera.' : 'No tienes obras asignadas. Pídele al admin que te asigne.')
    ])
    : h('div', { class: 'obras-grid' }, visibles.map(id => obraCard(id, obras[id], estados[id])));

  // Pie discreto: deja ver las no activas sin que estorben. Sin esto, una obra
  // en pausa o terminada quedaría inalcanzable desde la interfaz.
  const pie = ocultas.length === 0 ? null : h('div', {
    class: 'muted',
    style: { marginTop: '18px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }
  }, [
    h('span', {}, `${ocultas.length} obra${ocultas.length === 1 ? '' : 's'} en pausa o terminada${ocultas.length === 1 ? '' : 's'}`),
    h('button', {
      class: 'btn ghost sm',
      onClick: () => { _verOcultas = !_verOcultas; renderObrasList(); }
    }, _verOcultas ? 'Ver sólo activas' : 'Ver todas')
  ]);

  renderShell([{ label: 'Obras' }], h('div', {}, [head, grid, pie]));
}

function obraCard(id, obra, estado) {
  const m = obra.meta || {};
  const ests = obra.estimaciones || {};
  const numEsts = Object.keys(ests).length;
  // % avance global se podría calcular, pendiente cuando el modelo esté completo
  return h('div', {
    class: 'obra-card',
    // Atenuada cuando se muestra por "Ver todas", para que se note que no está activa.
    style: ESTADOS_OCULTOS.includes(estado) ? { opacity: '.55' } : {},
    onClick: () => navigate('/obras/' + id)
  }, [
    h('h3', {}, [
      m.nombre || 'Sin nombre',
      ESTADOS_OCULTOS.includes(estado)
        ? h('span', {
            class: estado === 'terminado' ? 'tag' : 'tag warn',
            style: { marginLeft: '8px', fontSize: '11px' }
          }, ETIQUETA_ESTADO[estado] || estado)
        : null
    ]),
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
  const fInicio = h('input', { type: 'date' });
  const fFin = h('input', { type: 'date' });

  // El "Monto C/IVA" ya NO se teclea: se deriva de la integración OPUS.
  const integ = buildIntegracionForm();

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
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Programa'), programa]),
      h('div', {}, [])
    ]),
    integ.node,
    h('div', { class: 'grid-2', style: { marginTop: '10px' } }, [
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
          programa: programa.value,
          integracion: integ.readInput(),   // deriva montoContratoCIVA, ivaPct, anticipoPct
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
