import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
// Los modulos propios se importan con la misma version que main.js para que
// el cache del navegador no sirva una mezcla de codigo viejo y nuevo.
const _v = new URL(import.meta.url).searchParams.get("v");
const _q = _v ? "?v=" + _v : "";
const { ORGANS, SYSTEMS, CANON, DEFAULT_ACTIVE_SYSTEMS, AUTHORED_TEST_LANDMARKS } = await import("./config.js" + _q);
const { PosePipeline, lerpAngle } = await import("./pose-pipeline.js" + _q);

const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const SMOOTHING_ALPHA = 0.28;
const CAM_Z = 5;
// mismo factor que pose-pipeline: el hombro (acromion) es mas ancho que el tronco
const TRUNK_WIDTH_FACTOR = 0.72;

// --- DOM ---
const video = document.getElementById("video");
const testImg = document.getElementById("test-img");
const canvas = document.getElementById("canvas");
const skeletonCanvas = document.getElementById("skeleton");
const skeletonCtx = skeletonCanvas.getContext("2d");
const statusEl = document.getElementById("status");
const modeNameEl = document.getElementById("mode-name");
const fpsEl = document.getElementById("fps");
const landmarkCountEl = document.getElementById("landmark-count");
const startOverlay = document.getElementById("start-overlay");
const controlsEl = document.getElementById("controls");
const chipsEl = document.getElementById("chips");
const opacityInput = document.getElementById("opacity");
const opacityVal = document.getElementById("opacity-val");
const backBtn = document.getElementById("back-btn");
const xrBtn = document.getElementById("xr-btn");

// --- estado ---
let renderer, scene, camera, pipeline, anatomyRoot, anatomyRig;
const rigSmoothed = { position: new THREE.Vector3(), scale: 1,
                      quaternion: new THREE.Quaternion(), rotationZ: 0, ready: false };
let loader;
let poseDetected = false;   // ya se detecto una persona al menos una vez
let showSkeleton = true;    // overlay de landmarks (diagnostico)
let showLabels = true;      // nombres de cada estructura (uso educativo)
const organObjects = {}; // name -> { cfg, group, materials, nativeSize, smoothed, loaded, loading }
const activeSystems = new Set(DEFAULT_ACTIVE_SYSTEMS);
let globalOpacity = 1;
let currentMode = null;
let mediaEl = null;   // <video> o <img> activo
let mediaFit = "cover"; // "cover" (camara) | "contain" (imagen)
let lastLandmarks = null;      // ultimos landmarks 2D aplicados
let lastWorldLandmarks = null; // ultimos landmarks 3D (metros) para orientacion
let currentMediaRect = null;   // rect de la media (puede desbordar el viewport)
let lastLabelBoxes = [];       // instrumentacion: cajas de etiquetas dibujadas

function setStatus(s) { statusEl.textContent = s; }

// ---------- escena ----------
function setupScene({ xr = false } = {}) {
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.xr.enabled = xr;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
  camera.position.set(0, 0, CAM_Z);

  scene.add(new THREE.AmbientLight(0xffffff, 0.95));
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(2, 3, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.4);
  fill.position.set(-3, -1, 2);
  scene.add(fill);

  // Todos los organos cuelgan de este nodo. En modos con camara/imagen se
  // mantiene OCULTO hasta que se detecte una persona: antes se mostraban
  // apenas cargaban, asi que si la deteccion fallaba parecia que "proyecta
  // los organos al vacio" en vez de avisar que no hay cuerpo detectado.
  anatomyRoot = new THREE.Group();
  anatomyRoot.visible = false;
  scene.add(anatomyRoot);

  // Rig unico: contiene TODOS los organos con sus posiciones relativas fijas.
  // Se transforma como una sola pieza, asi el cuerpo queda enlazado.
  anatomyRig = new THREE.Group();
  anatomyRoot.add(anatomyRig);

  pipeline = new PosePipeline(camera);
  resize();
  window.addEventListener("resize", resize);
}

// Rectangulo (en px de viewport) donde object-fit muestra realmente la media.
function computeMediaRect() {
  if (!mediaEl) return null;
  const mw = mediaEl.videoWidth || mediaEl.naturalWidth;
  const mh = mediaEl.videoHeight || mediaEl.naturalHeight;
  if (!mw || !mh) return null;
  const vw = window.innerWidth, vh = window.innerHeight;
  const scale = mediaFit === "contain" ? Math.min(vw / mw, vh / mh) : Math.max(vw / mw, vh / mh);
  const w = mw * scale, h = mh * scale;
  return { left: (vw - w) / 2, top: (vh - h) / 2, w, h };
}

// Superpone el canvas EXACTAMENTE sobre el rectangulo de la media. Asi los
// landmarks (normalizados al frame de la media) coinciden 1:1 con el espacio
// del canvas: no hace falta corregir por object-fit y no hay deriva.
function layoutCanvasToMedia() {
  const r = computeMediaRect();
  // Un viewport de 0 (rotacion de pantalla, pestana oculta) daria aspect=NaN,
  // y eso propaga NaN a toda la matriz de proyeccion: los organos desaparecen.
  if (!r || !(r.w > 0) || !(r.h > 0)) return false;
  currentMediaRect = r;
  for (const el of [canvas, skeletonCanvas]) {
    el.style.left = r.left + "px";
    el.style.top = r.top + "px";
    el.style.width = r.w + "px";
    el.style.height = r.h + "px";
  }
  // El canvas 2D del esqueleto usa pixeles reales para dibujar nitido.
  skeletonCanvas.width = Math.round(r.w);
  skeletonCanvas.height = Math.round(r.h);

  renderer.setSize(r.w, r.h, false);
  camera.aspect = r.w / r.h;
  camera.updateProjectionMatrix();
  return true;
}

// Dibuja el esqueleto detectado. Es el diagnostico clave: si se ve sobre la
// persona, la deteccion funciona y cualquier problema es de colocacion; si no
// aparece nada, el problema es que MediaPipe no esta detectando.
const BONES = [
  [11, 12], [11, 23], [12, 24], [23, 24],          // torso
  [11, 13], [13, 15], [12, 14], [14, 16],          // brazos
  [23, 25], [25, 27], [24, 26], [26, 28],          // piernas
];

// Dibuja todo el overlay 2D en un solo pase (limpia una vez y compone).
function drawOverlay(landmarks) {
  const w = skeletonCanvas.width, h = skeletonCanvas.height;
  skeletonCtx.clearRect(0, 0, w, h);
  if (showSkeleton && landmarks) drawSkeletonLines(landmarks, w, h);
  if (showLabels) drawOrganLabels(w, h);
}

// Nombres de cada estructura, proyectados desde su posicion 3D real. Se dibuja
// en el canvas 2D (no como sprites) para que el texto quede nitido y legible.
function drawOrganLabels(w, h) {
  lastLabelBoxes = [];
  if (!anatomyRoot || !anatomyRoot.visible) return;

  const items = [];
  for (const name of Object.keys(organObjects)) {
    const e = organObjects[name];
    if (!e.loaded || !e.group.visible) continue;
    // posicion MUNDIAL: el organo vive dentro del rig, su position es local
    const p = e.group.getWorldPosition(new THREE.Vector3()).project(camera);
    if (p.z > 1) continue; // detras de la camara
    items.push({
      text: e.cfg.label || name,
      x: (p.x * 0.5 + 0.5) * w,
      y: (-p.y * 0.5 + 0.5) * h,
      color: SYSTEMS[e.cfg.system].color,
    });
  }
  if (!items.length) return;

  // Con object-fit "cover" el canvas es MAS GRANDE que la pantalla y se sale
  // por los costados. Las etiquetas deben ir contra el borde VISIBLE, no
  // contra el borde del canvas, o quedan cortadas ("lígado", "Baz"...).
  const r = currentMediaRect || { left: 0, top: 0, w, h };
  const vx0 = Math.max(0, -r.left);
  const vx1 = Math.min(w, -r.left + window.innerWidth);
  const vy0 = Math.max(0, -r.top);
  const vy1 = Math.min(h, -r.top + window.innerHeight);
  // margenes para no quedar debajo del HUD (arriba) ni de los chips (abajo)
  const topSafe = Math.max(vy0, -r.top + 118);
  const botSafe = Math.min(vy1, -r.top + window.innerHeight - 165);

  const fs = Math.max(9, Math.round((vx1 - vx0) * 0.028));
  skeletonCtx.font = "600 " + fs + "px Inter, system-ui, sans-serif";
  skeletonCtx.textBaseline = "middle";

  // Las etiquetas se llevan a los margenes (como lamina anatomica) para no
  // tapar los organos, con una linea guia hasta su posicion real. Cada lado
  // se separa por su cuenta para que no se pisen entre si.
  const pad = 4;
  const gap = fs * 1.6;
  const medio = (vx0 + vx1) / 2;
  const cols = { izq: [], der: [] };
  for (const it of items) {
    it.tw = skeletonCtx.measureText(it.text).width;
    (it.x < medio ? cols.izq : cols.der).push(it);
  }

  for (const lado of ["izq", "der"]) {
    const col = cols[lado];
    if (!col.length) continue;
    col.sort((a, b) => a.y - b.y);
    // reparte verticalmente evitando solapes, dentro del area visible
    for (let i = 0; i < col.length; i++) {
      col[i].ty = i === 0 ? Math.max(col[i].y, topSafe)
                          : Math.max(col[i].y, col[i - 1].ty + gap);
    }
    const exceso = col[col.length - 1].ty - botSafe;
    if (exceso > 0) for (const it of col) it.ty -= exceso;
    for (const it of col) it.ty = Math.max(topSafe, Math.min(botSafe, it.ty));

    for (const it of col) {
      const tx = lado === "izq" ? vx0 + pad : vx1 - pad - it.tw;
      const anclaX = lado === "izq" ? tx + it.tw + 4 : tx - 4;
      lastLabelBoxes.push({ text: it.text, tx, ty: it.ty, tw: it.tw, lado });

      skeletonCtx.strokeStyle = "rgba(255,255,255,0.45)";
      skeletonCtx.lineWidth = 1;
      skeletonCtx.beginPath();
      skeletonCtx.moveTo(anclaX, it.ty);
      skeletonCtx.lineTo(it.x, it.y);
      skeletonCtx.stroke();

      skeletonCtx.fillStyle = it.color;
      skeletonCtx.beginPath();
      skeletonCtx.arc(it.x, it.y, Math.max(2, fs * 0.18), 0, Math.PI * 2);
      skeletonCtx.fill();

      // fondo oscuro para que se lea sobre piel, ropa o fondo claro
      skeletonCtx.fillStyle = "rgba(0,0,0,0.66)";
      skeletonCtx.fillRect(tx - 3, it.ty - fs * 0.7, it.tw + 6, fs * 1.4);
      skeletonCtx.fillStyle = it.color;
      skeletonCtx.fillText(it.text, tx, it.ty);
    }
  }
}

function drawSkeletonLines(landmarks, w, h) {
  skeletonCtx.lineWidth = Math.max(2, w * 0.005);
  skeletonCtx.strokeStyle = "#7ee787";
  skeletonCtx.fillStyle = "#00e5ff";

  for (const [a, b] of BONES) {
    const p = landmarks[a], q = landmarks[b];
    if (!p || !q) continue;
    skeletonCtx.beginPath();
    skeletonCtx.moveTo(p.x * w, p.y * h);
    skeletonCtx.lineTo(q.x * w, q.y * h);
    skeletonCtx.stroke();
  }
  const r = Math.max(3, w * 0.008);
  for (const i of [11, 12, 23, 24]) {
    const p = landmarks[i];
    if (!p) continue;
    skeletonCtx.beginPath();
    skeletonCtx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2);
    skeletonCtx.fill();
  }
}

function resize() {
  if (renderer.xr.isPresenting) return;
  if (currentMode === "webxr") {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    return;
  }
  // camara / imagen: ajustar al rectangulo real de la media si ya se conoce.
  if (!layoutCanvasToMedia()) {
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

// ---------- organos ----------
function tintMaterial(mat, colorHex) {
  // Respeta la textura del modelo pero empuja el tono hacia el color del sistema
  // para leer las capas. Si el modelo no tiene textura util, el color domina.
  const c = new THREE.Color(colorHex);
  mat.color = mat.color ? mat.color.lerp(c, 0.55) : c;
  mat.transparent = true;
  mat.side = THREE.DoubleSide;
  mat.depthWrite = false;
}

async function loadWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await loader.loadAsync(url); }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
  }
  throw lastErr;
}

async function ensureOrganLoaded(name) {
  const cfg = ORGANS[name];
  if (!cfg) return null;
  let entry = organObjects[name];
  if (entry && (entry.loaded || entry.loading)) {
    if (entry.loading) await entry.loading;
    return organObjects[name];
  }
  entry = organObjects[name] = { cfg, loaded: false, failed: false, loading: null, materials: [] };
  entry.loading = (async () => {
    const gltf = await loadWithRetry(cfg.file);
    const inner = gltf.scene;
    const box = new THREE.Box3().setFromObject(inner);
    const size = new THREE.Vector3(), center = new THREE.Vector3();
    box.getSize(size); box.getCenter(center);
    inner.position.sub(center);

    const sys = SYSTEMS[cfg.system];
    const materials = [];
    inner.traverse((o) => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => { tintMaterial(m, sys.color); materials.push(m); });
        o.renderOrder = Math.round((cfg.depth || 0) * 100);
      }
    });

    // El organo se monta DENTRO del rig con su posicion anatomica relativa
    // fija (en unidades del cuerpo canonico). Nunca se vuelve a tocar: el
    // conjunto entero se mueve como una sola pieza.
    const nativeSize = (cfg.sizeRef === "torsoHeight" ? size.y : size.x) || 0.001;
    const base = cfg.sizeRef === "torsoHeight"
      ? CANON.torsoHeight
      : CANON.shoulderWidth * TRUNK_WIDTH_FACTOR;

    const group = new THREE.Group();
    group.add(inner);
    group.position.set(
      (cfg.lateral || 0) * CANON.shoulderWidth,
      -(cfg.anchorT || 0) * CANON.torsoHeight,
      (cfg.depth || 0) * CANON.depthScale
    );
    group.scale.setScalar((base * cfg.ratio) / nativeSize);
    group.visible = false;
    anatomyRig.add(group);

    entry.group = group;
    entry.materials = materials;
    entry.nativeSize = nativeSize;
    entry.loaded = true;
    applyOpacity(name);
  })().catch((e) => {
    // Una falla de carga (ej. red intermitente) no debe abortar el resto.
    entry.failed = true;
    console.warn("no se pudo cargar " + name + ": " + (e && e.message));
  });
  await entry.loading;
  return entry;
}

function applyOpacity(name) {
  const entry = organObjects[name];
  if (!entry || !entry.loaded) return;
  const sys = SYSTEMS[entry.cfg.system];
  const op = sys.defaultOpacity * globalOpacity;
  entry.materials.forEach((m) => {
    m.opacity = op;
    m.depthWrite = op >= 0.98;
  });
}

function organsInSystem(sys) {
  return Object.keys(ORGANS).filter((n) => ORGANS[n].system === sys);
}

async function setSystemActive(sys, active) {
  if (active) activeSystems.add(sys); else activeSystems.delete(sys);
  const names = organsInSystem(sys);
  if (active) {
    setStatus("cargando " + SYSTEMS[sys].label + "...");
    await Promise.all(names.map(ensureOrganLoaded));
    setStatus("listo");
  }
  names.forEach((n) => {
    const e = organObjects[n];
    if (e && e.loaded) { e.group.visible = active; if (e.smoothed) e.smoothed.ready = false; }
  });
}

// ---------- UI ----------
function buildChips() {
  chipsEl.innerHTML = "";

  // Atajo para prender/apagar todo: los sistemas apagados eran la razon por la
  // que "faltaban" organos, no que no existieran.
  const todos = document.createElement("div");
  todos.className = "chip";
  todos.textContent = "Todos";
  todos.addEventListener("click", async () => {
    const encender = Object.keys(SYSTEMS).some((s) => !activeSystems.has(s));
    todos.textContent = encender ? "Ninguno" : "Todos";
    for (const s of Object.keys(SYSTEMS)) await setSystemActive(s, encender);
    buildChips();
  });
  chipsEl.appendChild(todos);

  // Nombres de las estructuras (modo educativo).
  const nombres = document.createElement("div");
  nombres.className = "chip" + (showLabels ? " active" : "");
  nombres.textContent = "Nombres";
  nombres.addEventListener("click", () => {
    showLabels = !showLabels;
    nombres.classList.toggle("active", showLabels);
  });
  chipsEl.appendChild(nombres);

  // Esqueleto de deteccion (util para ensenar y para diagnosticar).
  const esq = document.createElement("div");
  esq.className = "chip" + (showSkeleton ? " active" : "");
  esq.textContent = "Puntos";
  esq.addEventListener("click", () => {
    showSkeleton = !showSkeleton;
    esq.classList.toggle("active", showSkeleton);
  });
  chipsEl.appendChild(esq);

  Object.entries(SYSTEMS).forEach(([sys, meta]) => {
    const chip = document.createElement("div");
    chip.className = "chip" + (activeSystems.has(sys) ? " active" : "");
    chip.textContent = meta.label;
    chip.style.borderColor = activeSystems.has(sys) ? meta.color : "";
    chip.addEventListener("click", async () => {
      const nowActive = !activeSystems.has(sys);
      chip.classList.toggle("active", nowActive);
      await setSystemActive(sys, nowActive);
    });
    chipsEl.appendChild(chip);
  });
}

opacityInput.addEventListener("input", () => {
  globalOpacity = Number(opacityInput.value) / 100;
  opacityVal.textContent = opacityInput.value + "%";
  Object.keys(organObjects).forEach(applyOpacity);
});

// Calibracion en vivo sobre un cuerpo real: mover verticalmente y escalar.
const calibY = document.getElementById("calib-y");
const calibYVal = document.getElementById("calib-y-val");
const calibS = document.getElementById("calib-s");
const calibSVal = document.getElementById("calib-s-val");

calibY.addEventListener("input", () => {
  const v = Number(calibY.value);
  calibYVal.textContent = String(v);
  if (pipeline) pipeline.calib.offsetT = v / 100; // -0.40 .. +0.40 del torso
});
calibS.addEventListener("input", () => {
  const v = Number(calibS.value);
  // En AR el rig se escala directo (no pasa por el pipeline de pose).
  currentRigScale = v / 100;
  if (currentMode === "webxr" && anatomyRig) anatomyRig.scale.setScalar(currentRigScale);
  calibSVal.textContent = v + "%";
  if (pipeline) pipeline.calib.scale = v / 100;
});

backBtn.addEventListener("click", () => location.reload());

// ---------- colocacion billboard (camara / imagen) ----------
// El canvas se superpone exactamente sobre el rectangulo de la media
// (layoutCanvasToMedia), asi que los landmarks se usan tal cual: su espacio
// normalizado coincide con el del canvas.
function placeVisibleOrgans(landmarks, worldLandmarks) {
  const frame = pipeline.computeTorsoFrame(landmarks, worldLandmarks);
  if (!frame) return false;

  // UNA sola transformacion para todo el cuerpo. Los organos conservan sus
  // posiciones relativas fijas dentro del rig, asi que se mueven juntos y
  // nunca se desconectan entre si.
  const target = pipeline.computeRigTransform(frame, CANON);
  const s = rigSmoothed;
  if (!s.ready) {
    s.position.copy(target.position);
    s.scale = target.scale;
    s.rotationZ = target.rotationZ;
    if (target.quaternion) s.quaternion.copy(target.quaternion);
    s.ready = true;
  } else {
    s.position.lerp(target.position, SMOOTHING_ALPHA);
    s.scale += (target.scale - s.scale) * SMOOTHING_ALPHA;
    s.rotationZ = lerpAngle(s.rotationZ, target.rotationZ, SMOOTHING_ALPHA);
    // Slerp para la orientacion 3D: interpolar cuaterniones evita los saltos
    // y el bloqueo de ejes que da interpolar angulos por separado.
    if (target.quaternion) s.quaternion.slerp(target.quaternion, SMOOTHING_ALPHA);
  }

  anatomyRig.position.copy(s.position);
  anatomyRig.scale.setScalar(s.scale);
  if (target.quaternion) {
    anatomyRig.quaternion.copy(s.quaternion);   // orientacion 3D real del torso
  } else {
    anatomyRig.rotation.set(0, 0, s.rotationZ); // respaldo: rotacion plana
  }
  return true;
}

// ---------- MediaPipe ----------
// En varios GPU de celular el delegate "GPU" falla o no devuelve resultados.
// Se intenta GPU y, si falla, se cae a CPU (mas lento pero funciona).
async function createPoseLandmarker(runningMode) {
  const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
  const build = (delegate) => PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate },
    runningMode,
    numPoses: 1,
    minPoseDetectionConfidence: 0.4,
    minPosePresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });
  try {
    return await build("GPU");
  } catch (e) {
    console.warn("delegate GPU fallo, usando CPU:", e && e.message);
    setStatus("GPU no disponible, usando CPU");
    return build("CPU");
  }
}

// FPS helper
function makeFpsMeter() {
  let count = 0, start = performance.now();
  return () => {
    count++;
    const now = performance.now();
    if (now - start >= 1000) { fpsEl.textContent = String(count); count = 0; start = now; }
  };
}

// ---------- MODO: camara fija ----------
async function runCameraMode() {
  modeNameEl.textContent = "camara fija";
  mediaEl = video; mediaFit = "cover";
  setStatus("activando camara");
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  await new Promise((r) => (video.onloadedmetadata = r));
  await video.play();
  layoutCanvasToMedia();

  setStatus("cargando MediaPipe");
  const landmarker = await createPoseLandmarker("VIDEO");
  await preloadActiveSystems();

  setStatus("listo");
  const tick = makeFpsMeter();
  let lastT = -1;
  function frame() {
    requestAnimationFrame(frame);
    if (video.readyState >= 2 && video.currentTime !== lastT) {
      lastT = video.currentTime;
      const res = landmarker.detectForVideo(video, performance.now());
      const lms = res.landmarks && res.landmarks[0];
      landmarkCountEl.textContent = lms ? lms.length : "0";
      const wlms = res.worldLandmarks && res.worldLandmarks[0];
      if (lms && lms.length) {
        lastLandmarks = lms;
        lastWorldLandmarks = wlms;
        placeVisibleOrgans(lms, wlms);
        poseDetected = true;
        anatomyRoot.visible = true;   // solo se muestra con persona detectada
        setStatus("trackeando persona");
      } else {
        // Sin deteccion NO se dibujan organos: antes quedaban flotando en el
        // centro y parecia que "proyecta al vacio".
        anatomyRoot.visible = false;
        setStatus(poseDetected
          ? "perdi a la persona; volve a encuadrarla"
          : "buscando persona: que se vean hombros y caderas, con buena luz");
      }
      drawOverlay(lms);
    }
    renderer.render(scene, camera);
    tick();
  }
  requestAnimationFrame(frame);
}

// ---------- MODO: imagen de prueba ----------
async function runTestMode() {
  modeNameEl.textContent = "imagen de prueba";
  mediaEl = testImg; mediaFit = "contain";
  video.style.display = "none";
  testImg.style.display = "block";

  setStatus("cargando figura");
  testImg.src = "./assets/test/figura-parada.svg";
  await new Promise((r) => { testImg.onload = r; testImg.onerror = r; });
  layoutCanvasToMedia();

  setStatus("cargando MediaPipe");
  let landmarks = null;
  try {
    const landmarker = await createPoseLandmarker("IMAGE");
    // dibuja la SVG a un canvas con tamano intrinseco para la deteccion
    const off = document.createElement("canvas");
    off.width = 600; off.height = 1000;
    off.getContext("2d").drawImage(testImg, 0, 0, 600, 1000);
    const res = landmarker.detect(off);
    if (res.landmarks && res.landmarks[0] && res.landmarks[0].length) {
      landmarks = res.landmarks[0];
      lastWorldLandmarks = res.worldLandmarks && res.worldLandmarks[0];
      setStatus("pose detectada en figura");
    }
  } catch (e) { console.warn("deteccion en imagen fallo:", e); }

  if (!landmarks) {
    landmarks = AUTHORED_TEST_LANDMARKS;
    setStatus("usando landmarks de referencia");
  }
  landmarkCountEl.textContent = String(landmarks.length);
  lastLandmarks = landmarks;

  await preloadActiveSystems();
  setStatus("listo");

  poseDetected = true;
  anatomyRoot.visible = true;

  const tick = makeFpsMeter();
  function frame() {
    requestAnimationFrame(frame);
    placeVisibleOrgans(landmarks, lastWorldLandmarks); // suavizado converge
    drawOverlay(landmarks);
    renderer.render(scene, camera);
    tick();
  }
  requestAnimationFrame(frame);
}

// ---------- MODO: WebXR caminar alrededor ----------
let xrRig = null;
let currentRigScale = 1; // 1 = tamano real (el rig esta en metros)

// Aviso honesto cuando el dispositivo no puede hacer AR con anclaje al mundo.
function showNoXrNotice() {
  const box = document.createElement("div");
  box.className = "overlay";
  box.style.background = "rgba(10,10,10,0.95)";
  box.innerHTML =
    '<h1>Este dispositivo no soporta AR</h1>' +
    '<p>Para rodear a la persona y ver el otro lado de un organo hace falta ' +
    'que el telefono siga su posicion en el espacio real (WebXR con ARCore). ' +
    'Safari en iPhone no lo soporta, y algunos Android tampoco.</p>' +
    '<p>El modo <b>Camara fija</b> si funciona en este dispositivo: detecta el ' +
    'cuerpo y pega los organos encima, aunque sin poder rodearlo.</p>';
  const btn = document.createElement("button");
  btn.className = "mode-btn";
  btn.textContent = "Usar camara fija";
  btn.addEventListener("click", () => { box.remove(); location.href = location.pathname + "?modo=camera"; });
  box.appendChild(btn);
  const btn2 = document.createElement("button");
  btn2.className = "mode-btn";
  btn2.textContent = "Volver";
  btn2.addEventListener("click", () => location.reload());
  box.appendChild(btn2);
  document.getElementById("stage").appendChild(box);
}
async function runWebXRMode() {
  modeNameEl.textContent = "caminar alrededor (AR)";
  video.style.display = "none";
  xrBtn.style.display = "inline-block";

  const supported = navigator.xr && (await navigator.xr.isSessionSupported?.("immersive-ar").catch(() => false));

  // Sin WebXR no hay forma de sostener la posicion en el espacio real al
  // caminar (hace falta tracking 6DOF de ARCore). Antes igual se dibujaba la
  // anatomia flotando sobre negro y SIN camara, que es justo la "proyeccion
  // al vacio". Ahora se dice claramente y se ofrece el modo que si sirve.
  if (!supported) {
    xrBtn.style.display = "none";
    setStatus("este navegador no soporta AR");
    showNoXrNotice();
    return;
  }

  setStatus("cargando anatomia");
  await preloadActiveSystems();
  // Se usa el MISMO rig que los otros modos, no una copia. Antes se clonaban
  // los organos al entrar en AR, asi que prender o apagar un sistema despues
  // no afectaba a los clones y los chips parecian no funcionar.
  xrRig = anatomyRig;
  // El rig ya esta en metros (cuerpo canonico), o sea tamano real para AR.
  xrRig.position.set(0, 0, -1.2);
  xrRig.quaternion.identity();
  xrRig.scale.setScalar(currentRigScale);
  // OCULTO hasta entrar a la sesion AR: el passthrough de camara solo existe
  // dentro de la sesion, asi que dibujarlo antes daba una pantalla negra con
  // organos flotando (que es justo lo que se veia mal).
  anatomyRoot.visible = false;

  // reticulo para hit-test (se crea antes: enterXrSession lo necesita)
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.08, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x7ee787 })
  );
  reticle.visible = false;
  reticle.matrixAutoUpdate = false;
  scene.add(reticle);

  let hitTestSource = null;
  let entrando = false;

  // requestSession EXIGE un gesto de usuario reciente. Por eso se llama
  // directo desde el handler del boton y no encadenando un click sintetico.
  async function enterXrSession(onError) {
    if (entrando) return;
    entrando = true;
    try {
      const session = await navigator.xr.requestSession("immersive-ar", {
        requiredFeatures: ["hit-test"],
        optionalFeatures: ["dom-overlay", "local-floor"],
        domOverlay: { root: document.body },
      });
      renderer.xr.setReferenceSpaceType("local");
      await renderer.xr.setSession(session);
      anatomyRoot.visible = true; // ya hay passthrough de camara detras
      setStatus("busca una superficie y toca para colocar");

      const viewerSpace = await session.requestReferenceSpace("viewer");
      hitTestSource = await session.requestHitTestSource({ space: viewerSpace });

      session.addEventListener("select", () => {
        if (reticle.visible) {
          xrRig.matrix.copy(reticle.matrix);
          xrRig.matrix.decompose(xrRig.position, xrRig.quaternion, xrRig.scale);
          xrRig.scale.setScalar(currentRigScale);
          setStatus("colocado - camina alrededor");
        }
      });
      session.addEventListener("end", () => {
        hitTestSource = null; anatomyRoot.visible = false; entrando = false;
        setStatus("sesion AR terminada");
      });
      return true;
    } catch (e) {
      entrando = false;
      console.error(e);
      setStatus("no se pudo iniciar AR");
      if (onError) onError(e);
      return false;
    }
  }

  const intro = document.createElement("div");
  intro.className = "overlay";
  intro.style.background = "rgba(10,10,10,0.92)";
  intro.innerHTML =
    '<h1>Listo para AR</h1>' +
    '<p>Al entrar, se abre la camara a pantalla completa. Apunta al piso o a la ' +
    'camilla cerca de la persona hasta ver el circulo verde, y toca para colocar ' +
    'la anatomia. Despues podes caminar alrededor.</p>';
  const err = document.createElement("p");
  err.style.color = "#f0a060";
  intro.appendChild(err);

  const go = document.createElement("button");
  go.className = "xr-enter-btn mode-btn";   // sin data-mode: no es cambio de modo
  go.textContent = "Entrar en AR";
  go.addEventListener("click", async () => {
    err.textContent = "Abriendo AR...";
    const ok = await enterXrSession((e) => {
      err.textContent = "Fallo: " + (e && e.message ? e.message : e) +
        ". Revisa que tengas Google Play Services for AR (ARCore) instalado y actualizado.";
    });
    if (ok) intro.remove();
  });
  intro.appendChild(go);
  document.getElementById("stage").appendChild(intro);

  xrBtn.addEventListener("click", () => { enterXrSession(); });

  renderer.setAnimationLoop((_, frame) => {
    if (frame && hitTestSource) {
      const refSpace = renderer.xr.getReferenceSpace();
      const hits = frame.getHitTestResults(hitTestSource);
      if (hits.length) {
        const pose = hits[0].getPose(refSpace);
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
      } else reticle.visible = false;
    }
    renderer.render(scene, camera);
  });
  setStatus(supported ? "toca 'Colocar en AR'" : "vista previa (sin AR real)");
}


// ---------- util ----------
async function preloadActiveSystems() {
  const names = [];
  activeSystems.forEach((sys) => organsInSystem(sys).forEach((n) => names.push(n)));
  await Promise.all(names.map(ensureOrganLoaded));
  names.forEach((n) => { const e = organObjects[n]; if (e && e.loaded) e.group.visible = true; });
}

// ---------- arranque ----------
function startMode(mode) {
  // Guarda: reiniciar un modo ya activo creaba un segundo renderer/escena y
  // dejaba la pantalla congelada (paso al tocar "Entrar en AR").
  if (currentMode) { console.warn("modo ya iniciado:", currentMode); return; }
  currentMode = mode;
  startOverlay.remove();
  controlsEl.style.display = "flex";
  backBtn.style.display = "block";
  loader = new GLTFLoader();

  buildChips();
  opacityVal.textContent = opacityInput.value + "%";

  setupScene({ xr: mode === "webxr" });

  // Hook de depuracion: permite forzar render sin depender de rAF (util en
  // entornos que pausan requestAnimationFrame, como paneles de preview).
  window.__ar = {
    step(n = 12) {
      if (lastLandmarks) {
        for (let i = 0; i < n; i++) placeVisibleOrgans(lastLandmarks, lastWorldLandmarks);
        drawOverlay(lastLandmarks);
      }
      renderer.render(scene, camera);
      return this.state();
    },
    world() {
      if (!lastWorldLandmarks) return null;
      const p = (i) => { const l = lastWorldLandmarks[i]; return l ? {x:+l.x.toFixed(3), y:+l.y.toFixed(3), z:+l.z.toFixed(3)} : null; };
      return { hombroIzq: p(11), hombroDer: p(12), caderaIzq: p(23), caderaDer: p(24), nariz: p(0) };
    },
    organQuat(name) {
      const e = organObjects[name];
      if (!e || !e.loaded) return null;
      const q = e.group.quaternion, eu = new THREE.Euler().setFromQuaternion(q, "XYZ");
      return { euler: { x:+eu.x.toFixed(3), y:+eu.y.toFixed(3), z:+eu.z.toFixed(3) } };
    },
    labels() { return { cajas: lastLabelBoxes, rect: currentMediaRect, vw: window.innerWidth }; },
    simularRect(r) { currentMediaRect = r; },
    rig() {
      if (!anatomyRig) return null;
      const q = anatomyRig.quaternion, p = anatomyRig.position, sc = anatomyRig.scale;
      return { pos: [p.x, p.y, p.z], scale: sc.x, quat: [q.x, q.y, q.z, q.w],
               suavizado: { pos: rigSmoothed.position.toArray(), scale: rigSmoothed.scale,
                            quat: rigSmoothed.quaternion.toArray(), ready: rigSmoothed.ready } };
    },
    organWorld(name) {
      const e = organObjects[name];
      if (!e || !e.loaded) return null;
      const v = e.group.getWorldPosition(new THREE.Vector3());
      return { x: +v.x.toFixed(4), y: +v.y.toFixed(4), z: +v.z.toFixed(4) };
    },
    organPos(name) {
      const e = organObjects[name];
      if (!e || !e.loaded) return null;
      return { x: +e.group.position.x.toFixed(4), y: +e.group.position.y.toFixed(4),
               s: +e.group.scale.x.toFixed(5), rot: +e.group.rotation.z.toFixed(4) };
    },
    state() {
      const loaded = [], failed = [], visible = [];
      for (const [k, e] of Object.entries(organObjects)) {
        if (e.loaded) loaded.push(k);
        if (e.failed) failed.push(k);
        if (e.loaded && e.group.visible) visible.push(k);
      }
      return { loaded, failed, visible, hasLandmarks: !!lastLandmarks,
               calib: pipeline ? { ...pipeline.calib } : null };
    },
    setSystemActive,
  };

  const run = mode === "camera" ? runCameraMode : mode === "test" ? runTestMode : runWebXRMode;
  run().catch((err) => { setStatus("error: " + err.message); console.error(err); });
}

// Los clics de los botones los captura el bootstrap clasico de index.html
// (delegacion), que funciona aunque este modulo tarde o falle. Aca solo se
// publica el arranque real y se atiende una eleccion hecha durante la carga.
window.__startMode = (mode) => {
  try { startMode(mode); }
  catch (err) {
    console.error(err);
    if (window.__showFatal) window.__showFatal(err.message);
  }
};

if (window.__pendingMode) {
  const m = window.__pendingMode;
  window.__pendingMode = null;
  window.__startMode(m);
} else {
  // Permite entrar directo a un modo por URL (?modo=camera), usado por el
  // aviso de "sin AR" para saltar al modo que si funciona.
  const m = new URLSearchParams(location.search).get("modo");
  if (m && ["camera", "test", "webxr"].includes(m)) window.__startMode(m);
}
