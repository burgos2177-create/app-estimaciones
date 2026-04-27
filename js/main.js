import { onAuth, getUserProfile } from './services/auth.js';
import { rread, rset } from './services/db.js';
import { state, setState } from './state/store.js';
import { route, startRouter, navigate } from './state/router.js';
import { renderLogin } from './views/login.js';
import { renderObrasList } from './views/obras.js';
import { renderObra } from './views/obra.js';
import { renderCatalogo } from './views/catalogo.js';
import { renderAdmin } from './views/admin.js';
import { renderEstimaciones } from './views/estimaciones.js';
import { renderEstimacion } from './views/estimacion.js';
import { renderGenerador } from './views/generador.js';
import { renderF1 } from './views/f1.js';
import { renderResumen } from './views/resumen.js';
import { renderSubcontratos } from './views/subcontratos.js';
import { renderSubcontrato } from './views/subcontrato.js';
import { renderSubEstimacion } from './views/sub-estimacion.js';
import { renderGaleria } from './views/galeria.js';
import { renderConcepto } from './views/stubs.js';
import { h, mount } from './util/dom.js';

route('/',                                                       () => renderObrasList());
route('/admin',                                                  () => renderAdmin());
route('/obras/:id',                                              renderObra);
route('/obras/:id/catalogo',                                     renderCatalogo);
route('/obras/:id/conceptos/:cid',                               renderConcepto);
route('/obras/:id/estimaciones',                                 renderEstimaciones);
route('/obras/:id/estimaciones/:estid',                          renderEstimacion);
route('/obras/:id/estimaciones/:estid/generadores/:gid',         renderGenerador);
route('/obras/:id/f1',                                           renderF1);
route('/obras/:id/resumen',                                      renderResumen);
route('/obras/:id/subcontratos',                                 renderSubcontratos);
route('/obras/:id/subcontratos/:subid',                          renderSubcontrato);
route('/obras/:id/subcontratos/:subid/:tab',                     renderSubcontrato);
route('/obras/:id/subcontratos/:subid/estimaciones/:eid',        renderSubEstimacion);
route('/obras/:id/estimaciones/:estid/galeria',                  renderGaleria);

let started = false;

onAuth(async (fbUser) => {
  if (!fbUser) {
    setState({ user: null });
    renderLogin();
    return;
  }
  let profile = null;
  try { profile = await getUserProfile(fbUser.uid); }
  catch (err) { console.error('No se pudo leer /users/{uid}', err); }

  if (!profile) {
    // Bootstrap: si no hay ningún usuario registrado todavía, este se vuelve admin
    let allUsers = null;
    try { allUsers = await rread('users'); } catch {}
    if (!allUsers || Object.keys(allUsers).length === 0) {
      const seed = {
        email: fbUser.email,
        displayName: fbUser.email?.split('@')[0] || 'Admin',
        role: 'admin',
        createdAt: Date.now()
      };
      try {
        await rset(`users/${fbUser.uid}`, seed);
        profile = seed;
      } catch (err) {
        console.error('Bootstrap admin falló', err);
      }
    }
  }

  if (!profile) {
    mount('#app', h('div', { class: 'login-shell' }, h('div', { class: 'login-card' }, [
      h('h1', {}, 'Sin acceso'),
      h('p', { class: 'sub' }, 'Tu cuenta existe pero el administrador aún no te ha dado acceso.'),
      h('button', { class: 'btn', onClick: async () => {
        const { logout } = await import('./services/auth.js');
        logout();
      } }, 'Salir')
    ])));
    return;
  }
  setState({ user: { uid: fbUser.uid, email: fbUser.email, ...profile } });
  if (!started) { startRouter(); started = true; }
  else { navigate('/'); }
});
