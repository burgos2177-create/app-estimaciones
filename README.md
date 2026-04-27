# App Estimaciones SGR

App web para el ingeniero de campo: catálogo OPUS, generadores de obra, estimaciones, subcontratos y croquis/fotos en Drive.

Sister app de **SOGRUB Bitácora Financiera** (la del contador).

## Stack
- Vanilla JS (ES modules nativos), HTML, CSS — sin frameworks ni bundler.
- Firebase Realtime Database + Authentication.
- SheetJS (CDN) para XLS/XLSX.
- jsPDF + jspdf-autotable (CDN) para PDFs.
- Google Drive API (OAuth) para croquis y fotos del sitio.

## Demo
Despliegue automático en **GitHub Pages**. Ver [Settings → Pages](../../settings/pages) para la URL.

## Setup local
```bash
python serve.py 8080
```
Luego abre http://localhost:8080/

## Documentación
Ver [CLAUDE.md](CLAUDE.md) para las decisiones de producto, modelo de datos y reglas de Firebase.
