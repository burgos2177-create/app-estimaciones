import { h, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state } from '../state/store.js';
import { listUsers, createUser, updateUserRole, setUserAssignment } from '../services/auth.js';
import { rread, deleteObra } from '../services/db.js';
import { navigate } from '../state/router.js';

export async function renderAdmin() {
  if (state.user.role !== 'admin') {
    renderShell([{ label: 'Sin acceso' }], h('div', { class: 'empty' }, 'Solo el administrador puede acceder a este panel.'));
    return;
  }

  renderShell([{ label: 'Obras', to: '/' }, { label: 'Admin' }], h('div', { class: 'empty' }, 'Cargando…'));
  const [users, obras] = await Promise.all([listUsers(), rread('obras').then(o => o || {})]);

  const usersBlock = renderUsersBlock(users, obras);
  const obrasBlock = renderObrasBlock(obras);

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
    integracionBlock
  ]));
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
        h('thead', {}, [h('tr', {}, [h('th', {}, 'Nombre'), h('th', {}, 'Contrato'), h('th', {}, 'Cliente'), h('th', {}, '')])]),
        h('tbody', {}, ids.map(id => h('tr', {}, [
          h('td', {}, h('a', { href: '#/obras/' + id }, obras[id].meta?.nombre || '—')),
          h('td', { class: 'mono' }, obras[id].meta?.contratoNo || ''),
          h('td', {}, obras[id].meta?.cliente || ''),
          h('td', {}, h('button', { class: 'btn sm danger', onClick: () => deleteObraConfirm(id, obras[id].meta?.nombre) }, 'Borrar'))
        ])))
      ])
  ]);
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
