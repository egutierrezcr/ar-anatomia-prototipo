// Configuracion anatomica de organos y sistemas.
//
// Cada organo se ancla al "marco de torso" derivado de la pose (hombros y
// caderas). Como cada modelo se centra en su propio bounding box al cargarse,
// su posicion anatomica relativa la define ESTA tabla, no las coordenadas
// internas del GLB. Asi el emplazamiento es determinista y ajustable.
//
// Campos:
//   file       ruta al GLB
//   system     sistema anatomico (para agrupar y togglear)
//   anchorT    posicion vertical: 0 = linea de hombros, 1 = linea de caderas.
//              Puede salirse de [0,1] (ej. cerebro < 0, vejiga > 1).
//   lateral    desplazamiento lateral como fraccion del ancho de hombros.
//              + = lado izquierdo de la persona (derecha de la imagen).
//   sizeRef    "shoulderWidth" | "torsoHeight": que medida gobierna la escala.
//   ratio      tamano del organo como fraccion de la medida de referencia.
//   depth      capa de profundidad en unidades de mundo. + = hacia la camara
//              (piel), - = lejos (columna). Da el efecto TAC en capas y la
//              paralaje real en modo WebXR.

export const SYSTEMS = {
  piel:           { label: "Piel",          color: "#e8b89a", defaultOpacity: 0.13 },
  esqueleto:      { label: "Esqueleto",     color: "#f0ece0", defaultOpacity: 1.0 },
  respiratorio:   { label: "Respiratorio",  color: "#e79aa6", defaultOpacity: 0.9 },
  cardiovascular: { label: "Cardiovascular",color: "#c0392b", defaultOpacity: 1.0 },
  digestivo:      { label: "Digestivo",     color: "#c98a5e", defaultOpacity: 0.95 },
  urinario:       { label: "Urinario",      color: "#d4a72c", defaultOpacity: 0.95 },
  nervioso:       { label: "Nervioso",      color: "#e6e2b0", defaultOpacity: 0.95 },
};

// label: nombre mostrado en pantalla (uso educativo).
export const ORGANS = {
  // piel (translucida, capa mas externa)
  skin:            { label: "Piel", file: "./assets/organs/VH_M_Skin.glb",              system: "piel",           anchorT: 0.50, lateral: 0.00, sizeRef: "torsoHeight", ratio: 1.05, depth: 0.34 },

  // respiratorio
  lung:            { label: "Pulmones", file: "./assets/organs/VH_M_Lung.glb",          system: "respiratorio",   anchorT: 0.26, lateral: 0.00, sizeRef: "shoulderWidth", ratio: 0.95, depth: 0.10 },

  // cardiovascular
  heart:           { label: "Corazón", file: "./assets/organs/VH_M_Heart.glb",          system: "cardiovascular", anchorT: 0.32, lateral: -0.05, sizeRef: "shoulderWidth", ratio: 0.40, depth: 0.16 },
  vasculature:     { label: "Vasos sanguíneos", file: "./assets/organs/VH_M_Blood_Vasculature.glb", system: "cardiovascular", anchorT: 0.45, lateral: 0.00, sizeRef: "torsoHeight", ratio: 1.10, depth: 0.06 },

  // digestivo
  liver:           { label: "Hígado", file: "./assets/organs/VH_M_Liver.glb",           system: "digestivo",      anchorT: 0.48, lateral: -0.12, sizeRef: "shoulderWidth", ratio: 0.62, depth: 0.12 },
  spleen:          { label: "Bazo", file: "./assets/organs/VH_M_Spleen.glb",            system: "digestivo",      anchorT: 0.48, lateral: 0.28, sizeRef: "shoulderWidth", ratio: 0.22, depth: 0.10 },
  pancreas:        { label: "Páncreas", file: "./assets/organs/VH_M_Pancreas.glb",      system: "digestivo",      anchorT: 0.52, lateral: 0.05, sizeRef: "shoulderWidth", ratio: 0.34, depth: 0.04 },
  gallbladder:     { label: "Vesícula biliar", file: "./assets/organs/VH_M_Gallbladder.glb", system: "digestivo", anchorT: 0.50, lateral: -0.14, sizeRef: "shoulderWidth", ratio: 0.12, depth: 0.13 },
  small_intestine: { label: "Intestino delgado", file: "./assets/organs/VH_M_Small_Intestine.glb", system: "digestivo", anchorT: 0.66, lateral: 0.00, sizeRef: "shoulderWidth", ratio: 0.70, depth: 0.11 },
  large_intestine: { label: "Intestino grueso", file: "./assets/organs/SBU_M_Intestine_Large.glb", system: "digestivo", anchorT: 0.64, lateral: 0.00, sizeRef: "shoulderWidth", ratio: 0.80, depth: 0.09 },

  // urinario
  kidney_l:        { label: "Riñón izquierdo", file: "./assets/organs/VH_M_Kidney_L.glb", system: "urinario",     anchorT: 0.55, lateral: 0.28, sizeRef: "shoulderWidth", ratio: 0.20, depth: -0.06 },
  kidney_r:        { label: "Riñón derecho", file: "./assets/organs/VH_M_Kidney_R.glb",  system: "urinario",      anchorT: 0.55, lateral: -0.28, sizeRef: "shoulderWidth", ratio: 0.20, depth: -0.06 },
  ureter_l:        { label: "Uréter izquierdo", file: "./assets/organs/VH_M_Ureter_L.glb", system: "urinario",    anchorT: 0.72, lateral: 0.18, sizeRef: "torsoHeight", ratio: 0.42, depth: -0.04 },
  ureter_r:        { label: "Uréter derecho", file: "./assets/organs/VH_M_Ureter_R.glb", system: "urinario",      anchorT: 0.72, lateral: -0.18, sizeRef: "torsoHeight", ratio: 0.42, depth: -0.04 },
  bladder:         { label: "Vejiga urinaria", file: "./assets/organs/VH_M_Urinary_Bladder.glb", system: "urinario", anchorT: 0.92, lateral: 0.00, sizeRef: "shoulderWidth", ratio: 0.22, depth: 0.06 },

  // nervioso
  brain:           { label: "Cerebro", file: "./assets/organs/Allen_M_Brain.glb",       system: "nervioso",       anchorT: -0.62, lateral: 0.00, sizeRef: "shoulderWidth", ratio: 0.62, depth: 0.10 },
  spinal_cord:     { label: "Médula espinal", file: "./assets/organs/VH_M_Spinal_Cord.glb", system: "nervioso",   anchorT: 0.52, lateral: 0.00, sizeRef: "torsoHeight", ratio: 1.05, depth: -0.22 },

  // esqueleto (capa mas profunda)
  vertebrae:       { label: "Columna vertebral", file: "./assets/organs/VH_M_Vertebrae.glb", system: "esqueleto", anchorT: 0.52, lateral: 0.00, sizeRef: "torsoHeight", ratio: 1.15, depth: -0.30 },
  pelvis:          { label: "Pelvis", file: "./assets/organs/VH_M_Pelvis.glb",          system: "esqueleto",      anchorT: 0.95, lateral: 0.00, sizeRef: "shoulderWidth", ratio: 0.78, depth: -0.24 },
};

// Cuerpo canonico de referencia (metros). Todos los organos se montan UNA vez
// dentro de un rig usando estas medidas, con sus posiciones relativas fijas.
// Despues se mueve/rota/escala el rig entero como una sola pieza: asi la
// columna nunca se despega de la pelvis ni el corazon se aleja del torax.
// El origen del rig esta en la linea de hombros; +y sube, -y baja hacia caderas.
export const CANON = { shoulderWidth: 0.40, torsoHeight: 0.52, depthScale: 0.45 };

// Sistemas activos al iniciar (buena vista tipo "rayos X" sin saturar).
export const DEFAULT_ACTIVE_SYSTEMS = ["esqueleto", "cardiovascular", "respiratorio"];

// Landmarks normalizados (0..1 en el espacio de la imagen) que coinciden con
// las figuras SVG de prueba. Se usan si MediaPipe no detecta la ilustracion,
// para que la tuberia de visualizacion sea verificable de todos modos.
// Indices segun MediaPipe Pose (11/12 hombros, 23/24 caderas).
export const AUTHORED_TEST_LANDMARKS = (() => {
  const p = (x, y) => ({ x: x / 600, y: y / 1000, z: 0, visibility: 1 });
  const arr = new Array(33).fill(null).map(() => p(300, 500));
  arr[0] = p(300, 120);   // nariz
  arr[11] = p(400, 300);  // hombro izq (persona) / derecha imagen
  arr[12] = p(200, 300);  // hombro der
  arr[23] = p(355, 580);  // cadera izq
  arr[24] = p(245, 580);  // cadera der
  return arr;
})();
