const listeners = new Set();
export const state = {
  user: null,           // { uid, email, role, displayName }
  obras: {},            // dict obraId → obra (cargado por admin) o subset (ingeniero)
  obraActual: null,     // obraId activo
  catalogo: null,       // { sourceFileName, conceptos: { ... } } del obraActual
  estimaciones: null,   // dict estimId → estim del obraActual
  generadores: null,    // dict generadorId → gen del obraActual
  avances: null,        // dict conceptoId/estimId → cantidad
  loading: false
};

export function setState(patch) {
  Object.assign(state, patch);
  listeners.forEach(fn => fn(state));
}

export function onState(fn) { listeners.add(fn); return () => listeners.delete(fn); }
