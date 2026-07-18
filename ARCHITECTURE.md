# Arquitectura: anatomía aumentada (Three.js + MediaPipe + WebXR)

## Objetivo

Prototipo web educativo que superpone modelos anatómicos 3D reales (GLB de
HuBMAP/NIH) sobre una persona, detectada por la cámara. No es dispositivo
médico ni navegación quirúrgica: es divulgación y aprendizaje.

## Distinción de partida

El video de referencia (MEDIVIS SurgicalAR) es navegación quirúrgica con
registro rígido: marcadores físicos en el paciente y cámaras infrarrojas
externas para precisión milimétrica. Ese nivel es requisito clínico.

Este prototipo usa visión sobre cámara RGB estándar (MediaPipe), sin marcadores
ni sensores externos. Es lo correcto para un objetivo educativo, con un techo
de precisión que no pretende alcanzar uso clínico.

## Los tres modos

El usuario elige modo en la pantalla inicial:

### 1. Cámara fija (`runCameraMode`)
La persona o la cámara están quietas; los órganos SIGUEN al cuerpo detectado.
MediaPipe `PoseLandmarker` (VIDEO) corre por frame, se deriva el marco de torso
y los órganos se billboardean sobre el cuerpo. Funciona en cualquier navegador.
Es el modo body-tracked.

### 2. Caminar alrededor / AR (`runWebXRMode`)
Los órganos se anclan a un punto FIJO del espacio real vía WebXR hit-test
(tocás una superficie para colocarlos). Al rodear a la persona quieta se ve la
otra cara del órgano, porque son objetos 3D world-locked, no billboards. NO usa
MediaPipe: el anclaje es al mundo, no al cuerpo. Requiere Android con WebXR AR
(ARCore). Si no hay soporte, cae a una vista previa sin AR real. Es el modo
world-anchored.

### 3. Imagen de prueba (`runTestMode`)
Sin cámara. Carga una figura ficticia ilustrada (`assets/test/*.svg`), corre
MediaPipe en modo IMAGE y superpone los órganos. Sirve para iterar la
visualización sin hardware. Si la detección fallara, usa landmarks autorales
(`AUTHORED_TEST_LANDMARKS`) para que la tubería sea verificable igual. En la
práctica MediaPipe SÍ detecta la ilustración (33 landmarks).

## Componentes y estructura

```
ar-anatomia-prototipo/
  index.html            shell, selector de modo, HUD, chips de sistemas, import map
  src/config.js         tabla de órganos + sistemas + landmarks de prueba
  src/pose-pipeline.js  puente 2D->3D: marco de torso + colocación de órganos
  src/main.js           orquestador: 3 modos, carga lazy, UI, capas
  assets/organs/*.glb    43 modelos HuBMAP/NIH (CC BY 4.0)
  assets/test/*.svg      figuras ficticias (parada / acostada)
```

## El puente de coordenadas (crítico)

Los landmarks de MediaPipe viven en espacio normalizado de imagen; Three.js en
mundo 3D. Pasos (`pose-pipeline.js`):

1. **Marco de torso**: de hombros (11,12) y caderas (23,24) se derivan punto
   medio, ancho de hombros, alto de torso y ángulo de rotación.
2. **Des-proyección**: cada punto NDC se des-proyecta contra la cámara hacia un
   plano de profundidad fija (la capa del órgano), dando su posición 3D.
3. **Colocación por órgano**: cada órgano se ubica con `anchorT` (vertical
   hombros->caderas), `lateral` (a lo largo del eje de hombros), `depth` (capa)
   y `ratio` (tamaño relativo a una medida corporal).
4. **Órganos de cabeza**: el cerebro se ancla al landmark de la nariz (0), no a
   la extrapolación del torso (poco fiable arriba de los hombros).

### Alineación canvas<->media (clave para que no "flote")
El `<video>`/`<img>` se muestra con `object-fit`, que escala y recorta respecto
al viewport. En vez de corregir landmarks con matemática frágil, el canvas WebGL
se dimensiona y posiciona para superponerse EXACTAMENTE al rectángulo visible de
la media (`layoutCanvasToMedia`). Así los landmarks (normalizados a la media)
coinciden 1:1 con el canvas: alineación exacta, sin deriva, en los dos modos.

### Anti-jitter y anti-volteo
- Suavizado exponencial (lerp) sobre posición, escala y rotación por órgano.
- El ángulo de hombros se normaliza a (-90°,90°] y se interpola por el camino
  más corto, para que el modelo no se voltee 180° por ruido de detección
  (bug real corregido: `normalizeLineAngle` + `lerpAngle`).
- Si las caderas quedan fuera de cuadro (persona cerca), se estiman por
  proporción anatómica en vez de confiar en el landmark extrapolado.

## Efecto TAC en capas

Los órganos se agrupan por SISTEMA (piel, esqueleto, respiratorio,
cardiovascular, digestivo, urinario, nervioso), togglables por chips. Cada
órgano tiene una capa de profundidad (`depth`): piel al frente y translúcida,
columna/pelvis al fondo. `renderOrder` dibuja de atrás hacia adelante; la piel
va con baja opacidad para leer como "ventana al interior". Un slider de opacidad
global permite atenuar todas las capas. Carga lazy: los GLB de un sistema se
bajan solo al activarlo.

## Estado de verificación (2026-07-18)

Verificado en modo imagen de prueba (el único con render observable en el
sandbox; ver limitación de rAF abajo):
- MediaPipe detecta la figura ilustrada (33 landmarks).
- Los 19 órganos configurados cargan sin fallos y se superponen en capas
  anatómicas correctas sobre el torso (pulmones, corazón, hígado, bazo,
  intestinos, riñones, pelvis, vasos, columna).
- Alineación torso correcta tras el fix canvas<->media.
- El cerebro se ancla a la cabeza (vía nariz); su offset vertical fino depende
  de una cara real, no de la figura sin rasgos.
- Modo cámara fija: verificado antes en Chrome real (tracking 33 landmarks,
  ~60 FPS con pocos órganos; el fix anti-volteo funciona).
- Modo WebXR: carga sin errores y detecta correctamente falta de soporte AR en
  el sandbox; el render AR real necesita un Android con ARCore.

## Limitaciones conocidas (por diseño)

| Limitación | Causa | Estado |
|---|---|---|
| Sin precisión milimétrica | Cámara RGB monocular, sin marcadores | Fuera de alcance; declarado educativo |
| Órganos "flotan" sobre la piel | MediaPipe Pose no segmenta a la persona | Futuro: MediaPipe Image Segmentation para oclusión |
| Sin profundidad métrica real (modo cámara) | z de Pose es relativo | Órganos en plano por capa; sin paralaje (sí lo hay en WebXR) |
| Rendimiento con muchos órganos | Mallas pesadas (vértebras/cerebro ~12MB) | Futuro: decimar mallas / Draco |
| Precisión de órganos de cabeza | Depende del landmark de nariz | Bien en cara real; impreciso en figura sin rasgos |
| WebXR AR solo en Android | Safari iOS no soporta WebXR AR | Feature-gate + fallback |

## Nota de verificación en entornos de preview

El panel de preview del sandbox PAUSA `requestAnimationFrame` cuando no está
pintando, así que un loop de render WebGL no tickea ahí. Para verificar sin
depender de rAF, `main.js` expone `window.__ar.step(n)` (fuerza colocación +
render una vez) y `window.__ar.state()` (órganos cargados/visibles). El render
en vivo se valida en Chrome real (donde rAF corre normal).

## Próximos pasos

1. Oclusión real con segmentación de persona (el mayor salto de realismo).
2. Modo acostado: validar detección de pose supina/cenital en cámara real
   (punto débil de MediaPipe; puede requerir ajustes o un modelo full).
3. Decimar la malla de vértebras/cerebro para subir FPS en teléfono.
4. Ajustar offsets finos de órganos contra cuerpos reales, no la figura.
5. Anclaje 6DOF más estable en WebXR (anchors persistentes).
