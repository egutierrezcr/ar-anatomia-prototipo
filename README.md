# Anatomía aumentada (prototipo)

Superpone modelos anatómicos 3D reales sobre una persona vista por la cámara
del celular o tablet, tipo "rayos X / TAC" educativo.

> **Prototipo educativo. No es un dispositivo médico y no sirve para uso
> clínico ni diagnóstico.** No tiene la precisión ni la estabilidad de un
> sistema de navegación quirúrgica (que usa marcadores físicos y cámaras
> infrarrojas externas).

## Cómo probarlo

Abrí la página y elegí un modo:

1. **Cámara fija** — la persona o la cámara quietas; los órganos siguen al
   cuerpo detectado. Funciona en cualquier navegador con cámara.
2. **Caminar alrededor (AR)** — ancla los órganos en el espacio real para
   rodear a la persona y ver el otro lado del órgano. Requiere **Android con
   WebXR/ARCore** (Safari en iOS no soporta WebXR AR).
3. **Imagen de prueba** — sin cámara, sobre una figura ficticia ilustrada.

Requiere HTTPS para acceder a la cámara y a WebXR (GitHub Pages ya lo provee).

Consejos para el modo cámara: que se vea el torso completo (hombros y caderas
en cuadro) y con buena luz. Empezá con pocos sistemas activos; las mallas
pesadas (vértebras, cerebro) bajan los FPS en teléfono.

## Stack

Three.js (render) + MediaPipe Tasks Vision (pose) + WebXR (AR anclado al
mundo). Sin paso de build: import maps y CDN.

Ver [ARCHITECTURE.md](ARCHITECTURE.md) para el diseño, el puente de
coordenadas 2D→3D y las limitaciones conocidas.

## Créditos y licencia de los modelos 3D

Los modelos anatómicos provienen de la **HuBMAP CCF 3D Reference Object
Library** (Human Reference Atlas), dataset Visible Human Male:

- Fuente: https://github.com/hubmapconsortium/ccf-3d-reference-object-library
- Licencia: **Creative Commons Attribution 4.0 International (CC BY 4.0)**
- Financiado por los NIH Common Fund / HuBMAP Consortium

Los modelos se redistribuyen aquí bajo CC BY 4.0 con esta atribución. El
código del prototipo es de Emmanuel Gutiérrez.
