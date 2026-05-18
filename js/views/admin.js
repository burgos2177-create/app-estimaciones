import { h, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state } from '../state/store.js';
import { listUsers, createUser, updateUserRole, setUserAssignment } from '../services/auth.js';
import {
  rread, deleteObra,
  listLicitantesCatalogo, addLicitanteCatalogo, updateLicitanteCatalogo,
  archiveLicitanteCatalogo, deleteLicitanteCatalogo
} from '../services/db.js';
import { migrateCatalogoToShared } from '../services/catalogo-migration.js';
import { navigate } from '../state/router.js';

export async function renderAdmin() {
  if (state.user.role !== 'admin') {
    renderShell([{ label: 'Sin acceso' }], h('div', { class: 'empty' }, 'Solo el administrador puede acceder a este panel.'));
    return;
  }

  renderShell([{ label: 'Obras', to: '/' }, { label: 'Admin' }], h('div', { class: 'empty' }, 'Cargando…'));
  const [users, obras, licitantes] = await Promise.all([
    listUsers(),
    rread('obras').then(o => o || {}),
    listLicitantesCatalogo()
  ]);

  const usersBlock = renderUsersBlock(users, obras);
  const obrasBlock = renderObrasBlock(obras);
  const licitantesBlock = renderLicitantesBlock(licitantes);

  const integracionBlock = h('div', { class: 'card' }, [
    h('h3', {}, 'Integración con bitácora'),
    h('div', { class: 'row' }, [
      h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Pareo de obras con proyectos contables. Necesario para que los pagos cliente y estimaciones a subcontratistas se enruten al proyecto correcto en la bitácora.'),
      h('div', { style: { flex: 1 } }),
      h('button', { class: 'btn primary', onClick: () => navigate('/admin/vincular-obras') }, 'Vincular obras ↔ proyectos')
    ])
  ]);

  renderShell([{ label: 'Obras', to: '/' }, { label: 'Admin' }], h('div', {}, [
    h('h1', {}, 'Administración'),
    usersBlock,
    obrasBlock,
    licitantesBlock,
    integracionBlock
  ]));
}

// === Catálogo de licitantes ===
function renderLicitantesBlock(licitantes) {
  const showArchivados = h('input', { type: 'checkbox' });
  const search = h('input', { placeholder: 'Buscar nombre, contacto, email…', style: { flex: '1', minWidth: '240px' } });
  const tbody = h('tbody', {});
  const counter = h('div', { class: 'muted', style: { fontSize: '12px' } }, '');

  function refresh() {
    const q = search.value.trim().toLowerCase();
    const wantArch = showArchivados.checked;
    const rows = Object.entries(licitantes)
      .filter(([, l]) => wantArch || !l.archivado)
      .filter(([, l]) => !q || `${l.nombre || ''} ${l.contacto || ''} ${l.email || ''}`.toLowerCase().includes(q))
      .sort((a, b) => String(a[1].nombre || '').localeCompare(String(b[1].nombre || ''), 'es'));

    tbody.innerHTML = '';
    if (rows.length === 0) {
      tbody.appendChild(h('tr', {}, h('td', { colspan: 6, class: 'muted', style: { textAlign: 'center', padding: '20px', fontSize: '12px' } },
        Object.keys(licitantes).length === 0 ? 'Aún no hay licitantes en el catálogo. Se llenará al ir agregando licitantes a subcontratos, o créalos directo aquí.' : 'Sin coincidencias.')));
    } else {
      for (const [id, l] of rows) tbody.appendChild(licitanteRow(id, l));
    }
    counter.textContent = `${rows.length} / ${Object.keys(licitantes).length} licitantes${wantArch ? ' (incluye archivados)' : ''}`;
  }
  search.addEventListener('input', refresh);
  showArchivados.addEventListener('change', refresh);

  function licitanteRow(id, l) {
    return h('tr', { style: { opacity: l.archivado ? 0.55 : 1 } }, [
      h('td', {}, l.nombre || '—'),
      h('td', { class: 'muted', style: { fontSize: '12px' } }, l.contacto || '—'),
      h('td', { class: 'muted', style: { fontSize: '12px' } }, l.telefono || '—'),
      h('td', { class: 'muted', style: { fontSize: '12px' } }, l.email || '—'),
      h('td', {}, l.archivado ? h('span', { class: 'tag muted' }, 'archivado') : h('span', { class: 'tag ok' }, 'activo')),
      h('td', {}, h('div', { class: 'row', style: { gap: '4px' } }, [
        h('button', { class: 'btn sm ghost', onClick: () => editLicitanteCatDialog(id, l) }, 'Editar'),
        h('button', {
          class: 'btn sm ghost',
          onClick: () => onToggleArchivar(id, l)
        }, l.archivado ? 'Reactivar' : 'Archivar'),
        l.archivado && h('button', { class: 'btn sm danger', onClick: () => onDeleteLicitanteCat(id, l) }, 'Borrar')
      ]))
    ]);
  }

  refresh();

  return h('div', { class: 'card' }, [
    h('div', { class: 'row' }, [
      h('h3', {}, 'Catálogo de licitantes'),
      h('div', { style: { flex: 1 } }),
      h('button', { class: 'btn primary sm', onClick: () => newLicitanteCatDialog() }, '+ Nuevo licitante')
    ]),
    h('div', { class: 'row', style: { marginTop: '8px' } }, [
      search,
      h('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } }, [
        showArchivados, h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Mostrar archivados')
      ]),
      h('div', { style: { flex: 1 } }),
      counter
    ]),
    h('table', { class: 'tbl', style: { marginTop: '10px' } }, [
      h('thead', {}, [h('tr', {}, [
        h('th', {}, 'Nombre'),
        h('th', {}, 'Contacto'),
        h('th', {}, 'Teléfono'),
        h('th', {}, 'Email'),
        h('th', {}, 'Estado'),
        h('th', {}, '')
      ])]),
      tbody
    ]),
    h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
      'Los licitantes en este catálogo aparecen en el picker al agregar uno a un subcontrato. Archivar oculta del picker sin perder historial.')
  ]);
}

async function newLicitanteCatDialog() {
  const nombre = h('input', { placeholder: 'Nombre o razón social', autofocus: true });
  const contacto = h('input', { placeholder: 'Persona de contacto' });
  const email = h('input', { type: 'email', placeholder: 'correo@empresa.com' });
  const telefono = h('input', { placeholder: 'Teléfono' });
  const notas = h('input', { placeholder: 'Notas (opcional)' });
  await modal({
    title: 'Nuevo licitante',
    body: h('div', {}, [
      h('div', { class: 'field' }, [h('label', {}, 'Nombre *'), nombre]),
      h('div', { class: 'grid-2', style: { marginTop: '10px' } }, [
        h('div', { class: 'field' }, [h('label', {}, 'Contacto'), contacto]),
        h('div', { class: 'field' }, [h('label', {}, 'Teléfono'), telefono])
      ]),
      h('div', { class: 'field', style: { marginTop: '10px' } }, [h('label', {}, 'Email'), email]),
      h('div', { class: 'field', style: { marginTop: '10px' } }, [h('label', {}, 'Notas'), notas])
    ]),
    confirmLabel: 'Crear',
    onConfirm: async () => {
      if (!nombre.value.trim()) { toast('Nombre requerido', 'warn'); return false; }
      try {
        await addLicitanteCatalogo({
          nombre: nombre.value, contacto: contacto.value,
          email: email.value, telefono: telefono.value, notas: notas.value
        });
        toast('Licitante agregado al catálogo', 'ok');
        renderAdmin();
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function editLicitanteCatDialog(id, l) {
  const nombre = h('input', { value: l.nombre || '', autofocus: true });
  const contacto = h('input', { value: l.contacto || '' });
  const email = h('input', { type: 'email', value: l.email || '' });
  const telefono = h('input', { value: l.telefono || '' });
  const notas = h('input', { value: l.notas || '' });
  await modal({
    title: `Editar: ${l.nombre || ''}`,
    body: h('div', {}, [
      h('div', { class: 'field' }, [h('label', {}, 'Nombre *'), nombre]),
      h('div', { class: 'grid-2', style: { marginTop: '10px' } }, [
        h('div', { class: 'field' }, [h('label', {}, 'Contacto'), contacto]),
        h('div', { class: 'field' }, [h('label', {}, 'Teléfono'), telefono])
      ]),
      h('div', { class: 'field', style: { marginTop: '10px' } }, [h('label', {}, 'Email'), email]),
      h('div', { class: 'field', style: { marginTop: '10px' } }, [h('label', {}, 'Notas'), notas]),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '10px' } },
        'Estos cambios solo afectan al catálogo. Los licitantes ya agregados a subcontratos conservan su snapshot original.')
    ]),
    confirmLabel: 'Guardar',
    onConfirm: async () => {
      if (!nombre.value.trim()) { toast('Nombre requerido', 'warn'); return false; }
      try {
        await updateLicitanteCatalogo(id, {
          nombre: nombre.value.trim(), contacto: contacto.value.trim(),
          email: email.value.trim(), telefono: telefono.value.trim(),
          notas: notas.value.trim()
        });
        toast('Licitante actualizado', 'ok');
        renderAdmin();
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function onToggleArchivar(id, l) {
  try {
    await archiveLicitanteCatalogo(id, !l.archivado);
    toast(l.archivado ? 'Licitante reactivado' : 'Licitante archivado', 'ok');
    renderAdmin();
  } catch (err) { toast('Error: ' + err.message, 'danger'); }
}

async function onDeleteLicitanteCat(id, l) {
  await modal({
    title: 'Borrar licitante del catálogo', danger: true, confirmLabel: 'Borrar definitivamente',
    body: h('div', {}, [
      h('p', {}, `Se borrará "${l.nombre}" del catálogo global. No se puede deshacer.`),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'Los licitantes que ya están en subcontratos conservan su información (snapshot). Solo se borra la entrada del catálogo.')
    ]),
    onConfirm: async () => {
      await deleteLicitanteCatalogo(id);
      toast('Licitante borrado', 'ok');
      renderAdmin();
      return true;
    }
  });
}

function renderUsersBlock(users, obras) {
  const tbody = h('tbody', {}, Object.entries(users).map(([uid, u]) => userRow(uid, u, obras)));
  const card = h('div', { class: 'card' }, [
    h('div', { class: 'row' }, [
      h('h3', {}, 'Usuarios'),
      h('div', { style: { flex: 1 } }),
      h('button', { class: 'btn primary sm', onClick: () => newUserDialog() }, '+ Crear usuario')
    ]),
    h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', {}, 'Nombre'), h('th', {}, 'Email'), h('th', {}, 'Rol'),
        h('th', {}, 'Obras asignadas'), h('th', {}, '')
      ])]),
      tbody
    ])
  ]);
  return card;
}

function userRow(uid, u, obras) {
  const assigned = u.obrasAsignadas || {};
  const obraNames = Object.keys(assigned).map(id => obras[id]?.meta?.nombre || id.slice(0, 6)).join(', ') || '—';
  return h('tr', {}, [
    h('td', {}, u.displayName || ''),
    h('td', { class: 'mono' }, u.email),
    h('td', {}, h('span', { class: 'tag ' + (u.role === 'admin' ? 'ok' : '') }, u.role)),
    h('td', { class: 'muted' }, obraNames),
    h('td', {}, h('div', { class: 'row' }, [
      h('button', { class: 'btn sm ghost', onClick: () => assignmentsDialog(uid, u, obras) }, 'Asignar'),
      u.role !== 'admin' && h('button', { class: 'btn sm ghost', onClick: () => promoteDialog(uid) }, '↑ Admin')
    ]))
  ]);
}

function renderObrasBlock(obras) {
  const ids = Object.keys(obras);
  return h('div', { class: 'card' }, [
    h('h3', {}, 'Obras'),
    ids.length === 0
      ? h('div', { class: 'empty', style: { padding: '20px' } }, 'Aún no hay obras.')
      : h('table', { class: 'tbl' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, 'Nombre'), h('th', {}, 'Contrato'), h('th', {}, 'Cliente'),
          h('th', {}, 'Catálogo'), h('th', {}, '')
        ])]),
        h('tbody', {}, ids.map(id => obraRow(id, obras[id])))
      ])
  ]);
}

function obraRow(id, obra) {
  const cat = obra.catalogo;
  const hasCatalogo = !!cat?.conceptos;
  const conceptosCount = hasCatalogo ? Object.keys(cat.conceptos).length : 0;
  const migratedAt = cat?.migratedAt || null;

  let catalogoCell;
  if (!hasCatalogo) {
    catalogoCell = h('span', { class: 'muted', style: { fontSize: '12px' } }, 'sin catálogo');
  } else if (migratedAt) {
    catalogoCell = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, [
      h('span', { class: 'tag ok', title: `Migrado a /shared/catalogos/${id}` }, `✓ migrado · ${conceptosCount}`),
      h('span', { class: 'muted', style: { fontSize: '11px' } }, new Date(migratedAt).toLocaleString())
    ]);
  } else {
    catalogoCell = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' } }, [
      h('span', { class: 'tag', style: { background: 'rgba(255,193,7,.15)', color: '#ffc107' } }, `legacy · ${conceptosCount}`),
      h('button', { class: 'btn sm', onClick: () => migrateCatalogoConfirm(id, obra.meta?.nombre, conceptosCount) }, 'Migrar a /shared')
    ]);
  }

  return h('tr', {}, [
    h('td', {}, h('a', { href: '#/obras/' + id }, obra.meta?.nombre || '—')),
    h('td', { class: 'mono' }, obra.meta?.contratoNo || ''),
    h('td', {}, obra.meta?.cliente || ''),
    h('td', {}, catalogoCell),
    h('td', {}, h('button', { class: 'btn sm danger', onClick: () => deleteObraConfirm(id, obra.meta?.nombre) }, 'Borrar'))
  ]);
}

async function migrateCatalogoConfirm(obraId, nombre, count) {
  const body = h('div', {}, [
    h('p', {}, [
      'Se copiará el catálogo de "', h('strong', {}, nombre || obraId.slice(0, 6)),
      `" (${count} conceptos) a `,
      h('code', {}, `/shared/catalogos/${obraId}`),
      '.'
    ]),
    h('p', { class: 'muted', style: { fontSize: '12px' } }, 'Los IDs de los conceptos se reemplazan por keys derivados de la clave OPUS + hash de la jerarquía. El catálogo legacy NO se borra; solo se marca con migratedAt y se guarda el mapeo legacyId→conceptoKey para futuras migraciones de generadores y desgloses históricos en bitácora.'),
    h('p', { class: 'muted', style: { fontSize: '12px' } }, 'Esta acción no afecta lecturas/escrituras de la app aún — eso viene en el siguiente paso (A2).')
  ]);

  await modal({
    title: 'Migrar catálogo a /shared/', body, confirmLabel: 'Migrar',
    onConfirm: async () => {
      try {
        const res = await migrateCatalogoToShared(obraId);
        const msg = res.collisions.length > 0
          ? `Catálogo migrado · ${res.conceptosCount} conceptos · ${res.collisions.length} colisiones desambiguadas con sufijo`
          : `Catálogo migrado · ${res.conceptosCount} conceptos (${res.pusCount} PUs, ${res.agrupadoresCount} agrupadores)`;
        toast(msg, 'ok');
        renderAdmin();
        return true;
      } catch (err) {
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

async function newUserDialog() {
  const email = h('input', { type: 'email', placeholder: 'correo@empresa.com' });
  const displayName = h('input', { placeholder: 'Nombre visible' });
  const password = h('input', { type: 'text', placeholder: 'contraseña inicial (min 6)', value: randomPwd() });
  const role = h('select', {}, [
    h('option', { value: 'ingeniero' }, 'Ingeniero'),
    h('option', { value: 'admin' }, 'Admin')
  ]);

  const body = h('div', {}, [
    h('div', { class: 'field' }, [h('label', {}, 'Email'), email]),
    h('div', { class: 'field' }, [h('label', {}, 'Nombre'), displayName]),
    h('div', { class: 'field' }, [h('label', {}, 'Contraseña inicial'), password]),
    h('div', { class: 'field' }, [h('label', {}, 'Rol'), role]),
    h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } }, 'El usuario podrá iniciar sesión con esta contraseña; se le pedirá cambiarla en el primer login (próximamente).')
  ]);

  await modal({
    title: 'Crear usuario', body, confirmLabel: 'Crear',
    onConfirm: async () => {
      try {
        await createUser({
          email: email.value.trim(),
          password: password.value,
          displayName: displayName.value.trim(),
          role: role.value
        });
        toast('Usuario creado', 'ok');
        renderAdmin();
        return true;
      } catch (err) {
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

async function assignmentsDialog(uid, user, obras) {
  const assigned = user.obrasAsignadas || {};
  const checks = {};
  const list = h('div', { style: { maxHeight: '300px', overflow: 'auto' } }, Object.entries(obras).map(([oid, o]) => {
    checks[oid] = h('input', { type: 'checkbox', checked: !!assigned[oid] });
    return h('label', { class: 'row', style: { padding: '6px 0', cursor: 'pointer' } }, [
      checks[oid], h('span', {}, o.meta?.nombre || oid.slice(0, 6))
    ]);
  }));

  await modal({
    title: `Asignar obras a ${user.displayName || user.email}`,
    body: list, confirmLabel: 'Guardar',
    onConfirm: async () => {
      try {
        await Promise.all(Object.entries(checks).map(([oid, cb]) =>
          setUserAssignment(uid, oid, cb.checked)
        ));
        toast('Asignaciones actualizadas', 'ok');
        renderAdmin();
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function promoteDialog(uid) {
  await modal({
    title: 'Promover a admin', body: h('div', {}, '¿Convertir este usuario en administrador? Tendrá acceso completo.'),
    confirmLabel: 'Promover', danger: true,
    onConfirm: async () => {
      await updateUserRole(uid, 'admin');
      toast('Usuario promovido', 'ok');
      renderAdmin(); return true;
    }
  });
}

async function deleteObraConfirm(oid, nombre) {
  await modal({
    title: 'Borrar obra', danger: true, confirmLabel: 'Borrar definitivamente',
    body: h('div', {}, `Se borrará la obra "${nombre || oid.slice(0,6)}" con todos sus generadores, estimaciones y catálogo. Esta acción no se puede deshacer.`),
    onConfirm: async () => {
      await deleteObra(oid);
      toast('Obra borrada', 'ok');
      renderAdmin(); return true;
    }
  });
}

function randomPwd() {
  const c = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 10 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}
