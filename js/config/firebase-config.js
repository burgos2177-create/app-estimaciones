// Firebase config — proyecto unificado sogrub-suite (decisión 2026-04-28).
// Todos los datos de esta app viven bajo /legacy/estimaciones/* en el RTDB.
// La app contadora (appsogrub) vivirá bajo /legacy/bitacora/* en el mismo proyecto.
// Plan futuro: migrar progresivamente a /shared/* por entidad.

export const firebaseConfig = {
  apiKey: "AIzaSyBjOrl1JW4Y383diRe4WO4rX5IF23UEN0k",
  authDomain: "sogrub-suite.firebaseapp.com",
  databaseURL: "https://sogrub-suite-default-rtdb.firebaseio.com",
  projectId: "sogrub-suite",
  storageBucket: "sogrub-suite.firebasestorage.app",
  messagingSenderId: "330378687274",
  appId: "1:330378687274:web:8be51640a6d9d7006ca453",
  measurementId: "G-98BM4PNBPP"
};

// Base path donde vive todo el dato de esta app dentro del RTDB compartido.
// Cualquier path relativo en db.js se resuelve bajo este prefijo automáticamente.
export const APP_BASE_PATH = "legacy/estimaciones";

export const googleConfig = {
  clientId: "1058194321879-00c6sgmgf7ic90kackmjdise5om95vdq.apps.googleusercontent.com",
  apiKey: ""
};
