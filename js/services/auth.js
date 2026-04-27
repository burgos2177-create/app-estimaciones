import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import { ref, get, set, update } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js';
import { auth, db, firebaseConfig } from './firebase.js';

// Para crear usuarios sin backend: usamos la REST API de Firebase Auth con la apiKey pública.
// Esto permite al admin (logueado) crear cuentas directamente desde el navegador.
// El "lado peligroso" es que cualquiera con la apiKey puede crear cuentas: por eso las reglas
// de RTDB exigen que /users/{uid} solo lo escriba el admin, así que un usuario creado pero sin
// registro en /users/{uid} no tiene acceso real a nada.

const REST = 'https://identitytoolkit.googleapis.com/v1/accounts';

export function login(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}
export function logout() { return signOut(auth); }
export function onAuth(cb) { return onAuthStateChanged(auth, cb); }

export async function getUserProfile(uid) {
  const snap = await get(ref(db, `users/${uid}`));
  return snap.exists() ? snap.val() : null;
}

export async function createUser({ email, password, displayName, role = 'ingeniero' }) {
  // Hace signUp directo via REST. NO cambia la sesión actual del admin si usamos returnSecureToken=false? Sí cambia.
  // Truco: hacemos signUp sin tocar el SDK, así no cambia la sesión del admin.
  const r = await fetch(`${REST}:signUp?key=${firebaseConfig.apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: false })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || 'Error creando usuario');
  const uid = data.localId;
  await set(ref(db, `users/${uid}`), {
    email, displayName: displayName || email,
    role, createdAt: Date.now()
  });
  return { uid, email, displayName, role };
}

export async function updateUserRole(uid, role) {
  await update(ref(db, `users/${uid}`), { role });
}

export async function setUserAssignment(uid, obraId, assigned) {
  await set(ref(db, `users/${uid}/obrasAsignadas/${obraId}`), assigned ? true : null);
}

export async function listUsers() {
  const snap = await get(ref(db, 'users'));
  return snap.exists() ? snap.val() : {};
}
