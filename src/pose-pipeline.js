import * as THREE from "three";

// Puente entre los landmarks 2D de MediaPipe y el espacio 3D de Three.js.
// Deriva un "marco de torso" (hombros/caderas) y coloca cada organo respecto
// a el, con capas de profundidad para el efecto TAC.

const LM = { NOSE: 0, LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12, LEFT_HIP: 23, RIGHT_HIP: 24 };
const HIP_VISIBILITY_THRESHOLD = 0.5;
const FALLBACK_TORSO_RATIO = 1.35; // torso (hombro-cadera) ~ 1.35x ancho de hombros

function ndcFromLandmark(lm) {
  return { x: lm.x * 2 - 1, y: -(lm.y * 2 - 1) };
}

// Un segmento hombro-hombro no tiene "sentido"; atan2 distingue las dos
// direcciones con 180deg de diferencia. Sin normalizar, el angulo de reposo
// cae cerca de +-180deg (camara sin espejo) y el ruido lo hace saltar entre
// +179 y -179, volteando el modelo. Se normaliza a (-90, 90].
export function normalizeLineAngle(angle) {
  let a = angle;
  while (a > Math.PI / 2) a -= Math.PI;
  while (a <= -Math.PI / 2) a += Math.PI;
  return a;
}

export function lerpAngle(current, target, alpha) {
  const delta = ((target - current + Math.PI) % (2 * Math.PI)) - Math.PI;
  return current + delta * alpha;
}

export class PosePipeline {
  constructor(camera) {
    this.camera = camera;
    this.camZ = camera.position.z;
  }

  // Des-proyecta un punto NDC a un plano de profundidad fija en el mundo.
  unprojectToDepth(ndcX, ndcY, targetZ) {
    const point = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(this.camera);
    const dir = point.sub(this.camera.position).normalize();
    const distance = (targetZ - this.camera.position.z) / dir.z;
    return this.camera.position.clone().add(dir.multiplyScalar(distance));
  }

  // Construye el marco de torso a partir de los 33 landmarks.
  // Devuelve null si faltan hombros.
  computeTorsoFrame(landmarks) {
    const ls = landmarks[LM.LEFT_SHOULDER];
    const rs = landmarks[LM.RIGHT_SHOULDER];
    const lh = landmarks[LM.LEFT_HIP];
    const rh = landmarks[LM.RIGHT_HIP];
    if (!ls || !rs) return null;

    const nLS = ndcFromLandmark(ls);
    const nRS = ndcFromLandmark(rs);
    const shoulderMidNdc = { x: (nLS.x + nRS.x) / 2, y: (nLS.y + nRS.y) / 2 };
    const nose = landmarks[LM.NOSE];
    const noseNdc = nose ? ndcFromLandmark(nose) : null;

    // Medidas de referencia en el plano z=0.
    const wLS = this.unprojectToDepth(nLS.x, nLS.y, 0);
    const wRS = this.unprojectToDepth(nRS.x, nRS.y, 0);
    const shoulderWidth0 = wLS.distanceTo(wRS);

    // Eje de hombros en pantalla (para el desplazamiento lateral de organos).
    const shoulderAxisNdc = { x: nLS.x - nRS.x, y: nLS.y - nRS.y };
    const axisLen = Math.hypot(shoulderAxisNdc.x, shoulderAxisNdc.y) || 1;
    shoulderAxisNdc.x /= axisLen;
    shoulderAxisNdc.y /= axisLen;

    // Caderas: si no son visibles (persona cerca), se estiman por proporcion.
    let hipMidNdc, torsoHeight0;
    const hipsVisible =
      lh && rh &&
      (lh.visibility ?? 1) > HIP_VISIBILITY_THRESHOLD &&
      (rh.visibility ?? 1) > HIP_VISIBILITY_THRESHOLD;

    if (hipsVisible) {
      const nLH = ndcFromLandmark(lh);
      const nRH = ndcFromLandmark(rh);
      hipMidNdc = { x: (nLH.x + nRH.x) / 2, y: (nLH.y + nRH.y) / 2 };
      const wLH = this.unprojectToDepth(nLH.x, nLH.y, 0);
      const wRH = this.unprojectToDepth(nRH.x, nRH.y, 0);
      const shoulderMid0 = wLS.clone().add(wRS).multiplyScalar(0.5);
      const hipMid0 = wLH.clone().add(wRH).multiplyScalar(0.5);
      torsoHeight0 = shoulderMid0.distanceTo(hipMid0);
    } else {
      // Estima cadera hacia "abajo" en el eje perpendicular al de hombros.
      const perp = { x: -shoulderAxisNdc.y, y: shoulderAxisNdc.x };
      // Asegura que apunte hacia abajo en pantalla (y negativo en NDC).
      const down = perp.y < 0 ? perp : { x: -perp.x, y: -perp.y };
      const shoulderWidthNdc = axisLen; // longitud NDC del ancho de hombros
      const drop = shoulderWidthNdc * FALLBACK_TORSO_RATIO;
      hipMidNdc = { x: shoulderMidNdc.x + down.x * drop, y: shoulderMidNdc.y + down.y * drop };
      torsoHeight0 = shoulderWidth0 * FALLBACK_TORSO_RATIO;
    }

    const rotationZ = normalizeLineAngle(Math.atan2(wRS.y - wLS.y, wRS.x - wLS.x));

    return {
      shoulderMidNdc,
      hipMidNdc,
      noseNdc,              // landmark de nariz en NDC (para organos de cabeza)
      shoulderAxisNdc,      // direccion unitaria del eje de hombros en NDC
      shoulderWidthNdc: axisLen, // ancho de hombros en NDC (sin normalizar)
      shoulderWidth0,       // ancho de hombros en mundo (plano z=0)
      torsoHeight0,
      rotationZ,
      hipsVisible,
    };
  }

  // Calcula posicion, escala y rotacion objetivo de un organo dado el marco.
  computeOrganTarget(cfg, frame, nativeSize) {
    // Ancla vertical. Los organos de cabeza (cerebro) se anclan a la nariz,
    // no a la extrapolacion del torso (poco fiable arriba de los hombros).
    let ndcX, ndcY;
    if (cfg.anchorTo === "head" && frame.noseNdc) {
      ndcX = frame.noseNdc.x;
      ndcY = frame.noseNdc.y + (cfg.headOffsetY || 0) * frame.shoulderWidthNdc;
    } else {
      const t = cfg.anchorT;
      ndcX = frame.shoulderMidNdc.x + (frame.hipMidNdc.x - frame.shoulderMidNdc.x) * t;
      ndcY = frame.shoulderMidNdc.y + (frame.hipMidNdc.y - frame.shoulderMidNdc.y) * t;
    }

    // Desplazamiento lateral a lo largo del eje de hombros, en fraccion del
    // ancho de hombros (medido en NDC para que la magnitud sea correcta).
    if (cfg.lateral) {
      const off = cfg.lateral * frame.shoulderWidthNdc;
      ndcX += frame.shoulderAxisNdc.x * off;
      ndcY += frame.shoulderAxisNdc.y * off;
    }

    const depth = cfg.depth || 0;
    const position = this.unprojectToDepth(ndcX, ndcY, depth);

    // Escala: medida de referencia en mundo, corregida por profundidad para
    // que el tamano aparente en pantalla sea consistente.
    const depthFactor = (this.camZ - depth) / this.camZ;
    const base = cfg.sizeRef === "torsoHeight" ? frame.torsoHeight0 : frame.shoulderWidth0;
    const refWorld = base * depthFactor;
    const scale = (refWorld * cfg.ratio) / (nativeSize || 0.001);

    return { position, scale, rotationZ: frame.rotationZ };
  }
}
