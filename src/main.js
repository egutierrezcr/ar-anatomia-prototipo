import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { ORGANS, SYSTEMS, DEFAULT_ACTIVE_SYSTEMS, AUTHORED_TEST_LANDMARKS } from "./config.js";
import { PosePipeline, lerpAngle } from "./pose-pipeline.js";

const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const SMOOTHING_ALPHA = 0.28;
const CAM_Z = 5;

// --- DOM ---
const video = document.getElementById("video");
const testImg = document.getElementById("test-img");
const canvas = document.getElementById("canvas");
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
let renderer, scene, camera, pipeline;
let loader;
const organObjects = {}; // name -> { cfg, group, materials, nativeSize, smoothed, loaded, loading }
const activeSystems = new Set(DEFAULT_ACTIVE_SYSTEMS);
let globalOpacity = 1;
let currentMode = null;
let mediaEl = null;   // <video> o <img> activo
let mediaFit = "cover"; // "cover" (camara) | "contain" (imagen)
let lastLandmarks = null; // ultimos landmarks aplicados (para debug/paso manual)

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
  if (!r) return false;
  canvas.style.left = r.left + "px";
  canvas.style.top = r.top + "px";
  canvas.style.width = r.w + "px";
  canvas.style.height = r.h + "px";
  renderer.setSize(r.w, r.h, false);
  camera.aspect = r.w / r.h;
  camera.updateProjectionMatrix();
  return true;
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
    const w = window.innerWidth, h = window.innerHeight;
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

    const group = new THREE.Group();
    group.add(inner);
    group.visible = false;
    scene.add(group);

    entry.group = group;
    entry.materials = materials;
    entry.nativeSize = (cfg.sizeRef === "torsoHeight" ? size.y : size.x) || 0.001;
    entry.smoothed = { position: new THREE.Vector3(), scale: 0.001, rotationZ: 0, ready: false };
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

backBtn.addEventListener("click", () => location.reload());

// ---------- colocacion billboard (camara / imagen) ----------
// El canvas se superpone exactamente sobre el rectangulo de la media
// (layoutCanvasToMedia), asi que los landmarks se usan tal cual: su espacio
// normalizado coincide con el del canvas.
function placeVisibleOrgans(landmarks) {
  const frame = pipeline.computeTorsoFrame(landmarks);
  if (!frame) return false;
  for (const name of Object.keys(organObjects)) {
    const e = organObjects[name];
    if (!e.loaded || !e.group.visible) continue;
    const target = pipeline.computeOrganTarget(e.cfg, frame, e.nativeSize);
    const s = e.smoothed;
    if (!s.ready) {
      s.position.copy(target.position);
      s.scale = target.scale;
      s.rotationZ = target.rotationZ;
      s.ready = true;
    } else {
      s.position.lerp(target.position, SMOOTHING_ALPHA);
      s.scale += (target.scale - s.scale) * SMOOTHING_ALPHA;
      s.rotationZ = lerpAngle(s.rotationZ, target.rotationZ, SMOOTHING_ALPHA);
    }
    e.group.position.copy(s.position);
    e.group.scale.setScalar(s.scale);
    e.group.rotation.set(0, 0, s.rotationZ);
  }
  return true;
}

// ---------- MediaPipe ----------
async function createPoseLandmarker(runningMode) {
  const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
  return PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: "GPU" },
    runningMode,
    numPoses: 1,
  });
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
      if (lms) { lastLandmarks = lms; placeVisibleOrgans(lms); setStatus("trackeando"); }
      else setStatus("sin persona detectada");
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

  const tick = makeFpsMeter();
  function frame() {
    requestAnimationFrame(frame);
    placeVisibleOrgans(landmarks); // el suavizado converge; permite togglear en vivo
    renderer.render(scene, camera);
    tick();
  }
  requestAnimationFrame(frame);
}

// ---------- MODO: WebXR caminar alrededor ----------
let xrRig = null;
async function runWebXRMode() {
  modeNameEl.textContent = "caminar alrededor (AR)";
  video.style.display = "none";
  xrBtn.style.display = "inline-block";

  const supported = navigator.xr && (await navigator.xr.isSessionSupported?.("immersive-ar").catch(() => false));
  if (!supported) {
    setStatus("WebXR AR no disponible en este navegador");
    xrBtn.textContent = "AR no soportado";
    xrBtn.style.opacity = "0.5";
    // igual mostramos la anatomia flotando para no dejar pantalla vacia
  }

  setStatus("cargando anatomia");
  await preloadActiveSystems();
  xrRig = buildAnatomyRig();
  xrRig.visible = true;
  xrRig.position.set(0, 0, -1.2); // frente a la camara hasta que se coloque
  scene.add(xrRig);

  // reticulo para hit-test
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.08, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x7ee787 })
  );
  reticle.visible = false;
  reticle.matrixAutoUpdate = false;
  scene.add(reticle);

  let hitTestSource = null, localSpace = null;

  xrBtn.addEventListener("click", async () => {
    if (!supported) return;
    try {
      const session = await navigator.xr.requestSession("immersive-ar", {
        requiredFeatures: ["hit-test", "local"],
        optionalFeatures: ["dom-overlay"],
        domOverlay: { root: document.body },
      });
      renderer.xr.setReferenceSpaceType("local");
      await renderer.xr.setSession(session);
      setStatus("busca una superficie y toca para colocar");

      const viewerSpace = await session.requestReferenceSpace("viewer");
      hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
      localSpace = await session.requestReferenceSpace("local");

      session.addEventListener("select", () => {
        if (reticle.visible) {
          xrRig.matrix.copy(reticle.matrix);
          xrRig.matrix.decompose(xrRig.position, xrRig.quaternion, xrRig.scale);
          xrRig.scale.setScalar(currentRigScale);
          setStatus("colocado - camina alrededor");
        }
      });
      session.addEventListener("end", () => { hitTestSource = null; });
    } catch (e) {
      setStatus("no se pudo iniciar AR: " + e.message);
      console.error(e);
    }
  });

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

// Rig anatomico con posiciones 3D reales (metros), para paralaje al rodear.
const CANON = { shoulderWidth: 0.4, torsoHeight: 0.52, depthScale: 0.5 };
let currentRigScale = 1;
function buildAnatomyRig() {
  const rig = new THREE.Group();
  for (const name of Object.keys(organObjects)) {
    const e = organObjects[name];
    if (!e.loaded || !e.group.visible) continue;
    const cfg = e.cfg;
    const holder = new THREE.Group();
    const clone = e.group.children[0].clone(true);
    holder.add(clone);
    const x = (cfg.lateral || 0) * CANON.shoulderWidth;
    const y = -(cfg.anchorT || 0) * CANON.torsoHeight + CANON.torsoHeight * 0.25;
    const z = (cfg.depth || 0) * CANON.depthScale;
    holder.position.set(x, y, z);
    const base = cfg.sizeRef === "torsoHeight" ? CANON.torsoHeight : CANON.shoulderWidth;
    holder.scale.setScalar((base * cfg.ratio) / e.nativeSize);
    rig.add(holder);
  }
  return rig;
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
      if (lastLandmarks) for (let i = 0; i < n; i++) placeVisibleOrgans(lastLandmarks);
      renderer.render(scene, camera);
      return this.state();
    },
    state() {
      const loaded = [], failed = [], visible = [];
      for (const [k, e] of Object.entries(organObjects)) {
        if (e.loaded) loaded.push(k);
        if (e.failed) failed.push(k);
        if (e.loaded && e.group.visible) visible.push(k);
      }
      return { loaded, failed, visible, hasLandmarks: !!lastLandmarks };
    },
    setSystemActive,
  };

  const run = mode === "camera" ? runCameraMode : mode === "test" ? runTestMode : runWebXRMode;
  run().catch((err) => { setStatus("error: " + err.message); console.error(err); });
}

document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => startMode(btn.dataset.mode));
});
