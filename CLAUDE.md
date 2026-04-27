# app-estimaciones

App web para el ingeniero de campo. Sister app de **SOGRUB Bitácora Financiera** (la del contador). Aquí no hay cuentas ni gastos: solo catálogo OPUS, generadores de obra, estimaciones por período y avance.

## Stack
- Vanilla JS (módulos ES nativos), HTML, CSS — sin frameworks ni bundler
- Firebase Realtime Database + Auth (proyecto aislado del de la app hermana)
- SheetJS (CDN) para leer/escribir XLS/XLSX
- Google Drive API para imágenes de croquis (carpeta aparte por obra)
- jsPDF (CDN) para exportar reportes

## Decisiones de producto (2026-04-25)

1. Firebase **aislado** del proyecto del contador (mismo Google account, proyecto distinto).
2. Roles: `admin` (crea usuarios y obras, asigna obras a usuarios) y `ingeniero` (solo ve sus obras asignadas, captura generadores y estimaciones).
3. Vínculo con app hermana: **export manual JSON** de estimaciones cerradas.
4. Plantillas de medición fijas, **se ligan al concepto la primera vez** que se le registra un generador. Tipos:
   - `areas` — eje, tramo, largo, ancho → total = L×A
   - `volumenes` — eje, tramo, largo, ancho, alto → total = L×A×H
   - `distancias` — eje, tramo, largo → total = L
   - `piezas` — descripción/elemento, cantidad → total = cantidad
   - `personalizado` — el usuario define columnas y fórmula
5. Estimaciones **ilimitadas**; las columnas en F-1 crecen conforme se generan.
6. Numeración de generadores **se reinicia por estimación** (Gen 1..N por estimación).
7. Estimaciones cerradas son **inmutables**; reapertura explícita por admin.
8. IVA configurable por obra, default 16%.
9. Imágenes de croquis viven en **Google Drive** (carpeta por obra). RTDB guarda solo `fileId` + `webViewLink`. Los PDFs traen las imágenes embebidas.
10. Export PDF y XLSX. Formato propio elegante, traslada la información del Excel original sin replicarlo pixel a pixel.
11. Sobreejecución (ejecutado > contratado) **se permite** y muestra **alerta visual** (amarillo) en F-1, RESUMEN y editor.

## Modelo de datos (Firebase RTDB)

```
/users/{uid}:
  email, displayName, role: "admin" | "ingeniero", createdAt

/users/{uid}/obrasAsignadas/{obraId}: true   # solo ingenieros

/obras/{obraId}:
  meta: { nombre, ubicacion, municipio, programa, contratoNo,
          montoContratoCIVA, fechaInicio, fechaFin, construye, cliente,
          ivaPct, driveFolderId, createdAt, updatedAt, ownerUid }

  catalogo:
    sourceFileName, importedAt, hash
    conceptos/{conceptoId}:
      tipo, clave, descripcion, unidad, cantidadContratada,
      precioUnitario, total, nivel, path, agrupadores, orden,
      plantillaTipo            # se setea la 1ª vez que se genera
      plantillaConfig          # solo si tipo=personalizado: { columnas, formula }
      archivado: bool          # marcado al re-importar si ya no existe en OPUS

  estimaciones/{estimacionId}:
    numero, fechaCorte, periodoIni, periodoFin,
    estado: "borrador" | "cerrada",
    cerradaAt, cerradaPor,
    pagoCliente: { subtotal, iva, importe, fecha }   # opcional

  generadores/{generadorId}:
    numero,                    # 1..N dentro de la estimación
    conceptoId, estimacionId,
    plantillaTipo,             # cacheado del concepto al crear
    partidas: [{...}],         # filas de medición
    ajustes: [{ etiqueta, cantidad }],
    totalEjecutado,            # cacheado
    croquisDriveId, croquisUrl,
    notas, createdAt, updatedAt, createdBy

  avances/{conceptoId}/{estimacionId}: cantidad
    # incluye conceptos sin generador (capturados directo)
```

## Estructura de archivos

```
index.html            # SPA shell
css/main.css          # tema oscuro
js/
  main.js             # bootstrap + router + auth gate
  config/
    firebase-config.js
  services/
    firebase.js       # init Firebase (auth + db)
    auth.js           # login, signup (vía REST), logout, role
    db.js             # helpers RTDB
    opus-parser.js    # XLS → catálogo (stack + remaining budget)
    drive.js          # Google Drive API
    export.js         # PDF + XLSX
  state/
    store.js          # estado global { user, obraActual, ... }
    router.js         # hash routing
  util/
    dom.js, format.js
  views/
    login.js, admin.js, obras.js, obra.js,
    catalogo.js, estimaciones.js, estimacion.js,
    generador.js, f1.js, resumen.js
```

## Reglas de Firebase RTDB (configurar en consola)

```json
{
  "rules": {
    "users": {
      ".read": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'",
      "$uid": {
        ".read": "auth != null && (auth.uid === $uid || root.child('users').child(auth.uid).child('role').val() === 'admin')",
        ".write": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'"
      }
    },
    "obras": {
      ".read": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'",
      "$obraId": {
        ".read": "auth != null && (root.child('users').child(auth.uid).child('role').val() === 'admin' || root.child('users').child(auth.uid).child('obrasAsignadas').child($obraId).val() === true)",
        ".write": "auth != null && (root.child('users').child(auth.uid).child('role').val() === 'admin' || (root.child('users').child(auth.uid).child('obrasAsignadas').child($obraId).val() === true && !data.child('estimaciones').child(newData.child('updatedEstimacionId').val()).child('estado').val() === 'cerrada'))"
      }
    }
  }
}
```

(Reglas se afinan después; el modelo es: admin lee/escribe todo, ingeniero solo en obras asignadas y solo en estimaciones no cerradas.)

## Setup de Google Drive (OAuth para croquis y fotos)

Los croquis y fotos del sitio se guardan en el Google Drive del usuario que se conecte. Estructura: `Estimaciones SGR / {Obra} / Estimación {N} / {clave}-croquis-{N}.{ext}` y `{clave}-foto-{N}.{ext}`.

Pasos (una sola vez):

1. Abre [Google Cloud Console](https://console.cloud.google.com/) con la cuenta donde quieras guardar los archivos.
2. Crea un proyecto nuevo (o usa el existente del Firebase). En el header arriba, "Select a project" → "New Project".
3. **APIs & Services → Library** → busca "Google Drive API" → **Enable**.
4. **APIs & Services → OAuth consent screen**:
   - User Type: **External** → Create.
   - App name: "Estimaciones SGR" (o el que quieras).
   - User support email + Developer contact: tu email.
   - Save and continue → **Scopes**: agrega `https://www.googleapis.com/auth/drive.file` → save.
   - Test users: agrega los emails de quienes usarán la app (`estimaciones.sgr@gmail.com` y los ingenieros).
   - Save and continue.
5. **APIs & Services → Credentials → + Create Credentials → OAuth Client ID**:
   - Application type: **Web application**.
   - Authorized JavaScript origins: agrega `http://localhost:8080` (y cualquier URL de producción).
   - Create.
6. Copia el **Client ID** que te muestra (termina en `.apps.googleusercontent.com`).
7. Pégalo en `js/config/firebase-config.js`:
   ```js
   export const googleConfig = {
     clientId: "1234567890-xxxxxxxxxxxxx.apps.googleusercontent.com",
     apiKey: ""  // opcional; se reusa la apiKey de Firebase
   };
   ```
8. Recarga la app → en el detalle de la obra aparece el botón **"Conectar Drive"** → click → ventana de Google → autoriza acceso a `drive.file`.

Una vez conectado, en cada generador podrás subir croquis y fotos. Los archivos quedan en TU Drive (la app no tiene acceso a otros archivos fuera de los que crea).

## Cómo arrancar

1. Crear proyecto Firebase nuevo → activar **Authentication (Email/Password)** y **Realtime Database**.
2. Copiar config en `js/config/firebase-config.js`.
3. Crear primer admin manualmente: en Firebase console → Authentication → Add user. Tomar el UID y en la base de datos crear `/users/{uid}` con `{ email, role: "admin" }`.
4. Servir la carpeta como estática (Live Server, `python -m http.server`, Firebase Hosting, etc.). Por uso de módulos ES no se puede abrir como `file://`.
