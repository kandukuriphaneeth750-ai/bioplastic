import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export type PipeCameraPreset = "iso" | "cutaway" | "bore";

export interface Pipe3DController {
  setCutawayAmount: (percent: number) => void;
  setWaterFlow: (enabled: boolean) => void;
  setPreset: (preset: PipeCameraPreset) => void;
  resize: () => void;
  dispose: () => void;
  isSoftwareRenderer: () => boolean;
}

interface PresetPose {
  pos: THREE.Vector3;
  target: THREE.Vector3;
}

const PRESET_POSES: Record<PipeCameraPreset, PresetPose> = {
  iso: {
    pos: new THREE.Vector3(3.35, 2.05, 3.85),
    target: new THREE.Vector3(0, 0.85, 0)
  },
  cutaway: {
    pos: new THREE.Vector3(0.05, 1.35, 4.45),
    target: new THREE.Vector3(0, 0.88, 0)
  },
  bore: {
    pos: new THREE.Vector3(4.2, 1.05, 0.45),
    target: new THREE.Vector3(0, 0.85, 0)
  }
};

function detectSoftwareWebGL(): boolean {
  const probeCanvas = document.createElement("canvas");
  const gl = probeCanvas.getContext("webgl2") || probeCanvas.getContext("webgl");
  if (!gl) return true;
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const rawRenderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "";
  return /SwiftShader|llvmpipe|Software Rasterizer|Apple Software/i.test(rawRenderer);
}

function createBioplasticTexture(maxAnisotropy: number): { map: THREE.CanvasTexture; roughnessMap: THREE.CanvasTexture } {
  const colorCanvas = document.createElement("canvas");
  colorCanvas.width = 512;
  colorCanvas.height = 512;
  const cctx = colorCanvas.getContext("2d")!;

  cctx.fillStyle = "#d9d0ba";
  cctx.fillRect(0, 0, 512, 512);

  // Subtle organic cellulose flecks and fine extrusion striation
  for (let y = 0; y < 512; y += 2) {
    const shade = 210 + Math.sin(y * 0.19) * 5;
    cctx.fillStyle = `rgba(${Math.round(shade)}, ${Math.round(shade - 7)}, ${Math.round(shade - 26)}, 0.14)`;
    cctx.fillRect(0, y, 512, 1);
  }
  for (let i = 0; i < 1600; i++) {
    const x = ((i * 73) % 512);
    const y = ((i * 197) % 512);
    const len = 3 + (i % 8);
    cctx.fillStyle = i % 3 === 0 ? "rgba(82, 130, 96, 0.18)" : "rgba(182, 134, 62, 0.14)";
    cctx.fillRect(x, y, len, 1.5);
  }

  const map = new THREE.CanvasTexture(colorCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(2, 2);
  map.anisotropy = maxAnisotropy;

  const roughCanvas = document.createElement("canvas");
  roughCanvas.width = 512;
  roughCanvas.height = 512;
  const rctx = roughCanvas.getContext("2d")!;
  rctx.fillStyle = "#b8b8b8";
  rctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 1200; i++) {
    const x = (i * 97) % 512;
    const y = (i * 149) % 512;
    const v = 155 + (i % 60);
    rctx.fillStyle = `rgb(${v},${v},${v})`;
    rctx.fillRect(x, y, 5, 2);
  }

  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  roughnessMap.wrapS = THREE.RepeatWrapping;
  roughnessMap.wrapT = THREE.RepeatWrapping;
  roughnessMap.repeat.set(2, 2);
  roughnessMap.anisotropy = maxAnisotropy;

  return { map, roughnessMap };
}

function createContactShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(128, 128, 12, 128, 128, 124);
  grad.addColorStop(0, "rgba(2, 10, 7, 0.62)");
  grad.addColorStop(0.5, "rgba(2, 10, 7, 0.28)");
  grad.addColorStop(1, "rgba(2, 10, 7, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Builds a hollow cylindrical arc shell rotated along X-axis using ExtrudeGeometry
 * so wall thickness, end bevels, and cutaway seam caps are clean watertight geometry.
 */
function buildArcPipeShellGeometry(
  innerR: number,
  outerR: number,
  length: number,
  thetaStart: number,
  thetaLength: number,
  segments = 40
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  for (let i = 0; i <= segments; i++) {
    const a = thetaStart + (i / segments) * thetaLength;
    const x = Math.cos(a) * outerR;
    const y = Math.sin(a) * outerR;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  for (let i = segments; i >= 0; i--) {
    const a = thetaStart + (i / segments) * thetaLength;
    shape.lineTo(Math.cos(a) * innerR, Math.sin(a) * innerR);
  }
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: length,
    bevelEnabled: true,
    bevelThickness: 0.015,
    bevelSize: 0.012,
    bevelSegments: 2,
    curveSegments: segments
  });
  // Center extruded Z along [-length/2, length/2], then rotate so pipe axis runs along X
  geo.translate(0, 0, -length * 0.5);
  geo.rotateY(Math.PI * 0.5);
  geo.computeVertexNormals();
  return geo;
}

export function initBioPipe3D(canvas: HTMLCanvasElement): Pipe3DController {
  const isSoftwareGl = detectSoftwareWebGL();
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !isSoftwareGl,
    powerPreference: "high-performance",
    alpha: false
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = !isSoftwareGl;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const bgColor = new THREE.Color(0x061912);
  scene.background = bgColor;
  scene.fog = new THREE.FogExp2(0x061912, 0.055);

  // Environment IBL via PMREM + RoomEnvironment (works across WebGL contexts)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.85;

  const camera = new THREE.PerspectiveCamera(40, 4 / 3, 0.1, 40);
  camera.position.copy(PRESET_POSES.iso.pos);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 2.4;
  controls.maxDistance = 8.2;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.target.copy(PRESET_POSES.iso.target);
  controls.update();

  // Lighting: Warm Key + Cool Sky/Ground Fill + Emerald Rim
  const keyLight = new THREE.DirectionalLight(0xffe9c7, 2.15);
  keyLight.position.set(4.5, 6.2, 4.2);
  if (!isSoftwareGl) {
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 18;
    keyLight.shadow.camera.left = -3.6;
    keyLight.shadow.camera.right = 3.6;
    keyLight.shadow.camera.top = 3.6;
    keyLight.shadow.camera.bottom = -3.6;
    keyLight.shadow.bias = -0.0004;
    keyLight.shadow.normalBias = 0.02;
  }
  scene.add(keyLight);

  const hemiLight = new THREE.HemisphereLight(0x88d4b4, 0x0b2218, 0.72);
  scene.add(hemiLight);

  const rimLight = new THREE.DirectionalLight(0x52b788, 0.85);
  rimLight.position.set(-4.2, 2.8, -3.5);
  scene.add(rimLight);

  // Ground Plane + Soft Radial Contact Shadow
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x071d15,
    roughness: 0.9,
    metalness: 0.05
  });
  const groundMesh = new THREE.Mesh(new THREE.CircleGeometry(14, 48), groundMat);
  groundMesh.rotation.x = -Math.PI * 0.5;
  groundMesh.receiveShadow = !isSoftwareGl;
  scene.add(groundMesh);

  const contactTex = createContactShadowTexture();
  const shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(5.6, 3.1),
    new THREE.MeshBasicMaterial({
      map: contactTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.85
    })
  );
  shadowPlane.rotation.x = -Math.PI * 0.5;
  shadowPlane.position.y = 0.004;
  scene.add(shadowPlane);

  // Composite Multi-Part Pipe Assembly Root (seated on pedestal at y = 0)
  const assembly = new THREE.Group();
  scene.add(assembly);

  const pipeAxisY = 0.88;
  const pipeLength = 3.1;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const bioTex = createBioplasticTexture(maxAniso);

  // Materials with clear roughness separation (>= 0.25)
  const outerBioMat = new THREE.MeshPhysicalMaterial({
    color: 0xe3dac2,
    map: bioTex.map,
    roughnessMap: bioTex.roughnessMap,
    roughness: 0.68,
    metalness: 0.03,
    clearcoat: 0.14,
    clearcoatRoughness: 0.45
  });

  const fiberMatrixMat = new THREE.MeshStandardMaterial({
    color: 0x67ad82,
    roughness: 0.55,
    metalness: 0.08
  });

  const helicalStrandMat = new THREE.MeshStandardMaterial({
    color: 0xd99b3d,
    roughness: 0.42,
    metalness: 0.15
  });

  const innerBoreMat = new THREE.MeshPhysicalMaterial({
    color: 0x205441,
    roughness: 0.24,
    metalness: 0.08,
    clearcoat: 0.6,
    clearcoatRoughness: 0.18
  });

  const brassCollarMat = new THREE.MeshStandardMaterial({
    color: 0xcf9438,
    roughness: 0.3,
    metalness: 0.72
  });

  const cradleStandMat = new THREE.MeshStandardMaterial({
    color: 0x16382b,
    roughness: 0.42,
    metalness: 0.68
  });

  // 1. Calibration Cradle & Stand (grounded flush at y = 0)
  const cradleGroup = new THREE.Group();
  const basePlate = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.08, 1.35), cradleStandMat);
  basePlate.position.set(0, 0.04, 0);
  basePlate.castShadow = !isSoftwareGl;
  basePlate.receiveShadow = !isSoftwareGl;
  cradleGroup.add(basePlate);

  const saddleGeo = new THREE.BoxGeometry(0.14, 0.44, 0.82);
  const saddleTopGeo = new THREE.CylinderGeometry(0.56, 0.56, 0.15, 24, 1, false, Math.PI * 0.62, Math.PI * 0.76);
  saddleTopGeo.rotateZ(Math.PI * 0.5);

  [-0.95, 0.95].forEach((xPos) => {
    const pillar = new THREE.Mesh(saddleGeo, cradleStandMat);
    pillar.position.set(xPos, 0.28, 0);
    pillar.castShadow = !isSoftwareGl;
    cradleGroup.add(pillar);

    const cradleRing = new THREE.Mesh(
      buildArcPipeShellGeometry(0.52, 0.59, 0.16, Math.PI * 1.15, Math.PI * 0.7, 24),
      cradleStandMat
    );
    cradleRing.position.set(xPos, pipeAxisY, 0);
    cradleRing.castShadow = !isSoftwareGl;
    cradleGroup.add(cradleRing);
  });
  assembly.add(cradleGroup);

  // Pipe Body Group centered at y = pipeAxisY
  const pipeBody = new THREE.Group();
  pipeBody.position.set(0, pipeAxisY, 0);
  assembly.add(pipeBody);

  // 2. Lower Outer Bioplastic Wall (fixed lower 210 deg arc)
  const lowerOuterGeo = buildArcPipeShellGeometry(0.43, 0.52, pipeLength, Math.PI * 0.62, Math.PI * 1.34, 42);
  const lowerOuterMesh = new THREE.Mesh(lowerOuterGeo, outerBioMat);
  lowerOuterMesh.castShadow = !isSoftwareGl;
  lowerOuterMesh.receiveShadow = !isSoftwareGl;
  pipeBody.add(lowerOuterMesh);

  // 3. Lower Inner Cellulose-Fiber Matrix Sleeve (fixed lower arc)
  const lowerMatrixGeo = buildArcPipeShellGeometry(0.36, 0.428, pipeLength - 0.06, Math.PI * 0.62, Math.PI * 1.34, 38);
  const lowerMatrixMesh = new THREE.Mesh(lowerMatrixGeo, fiberMatrixMat);
  lowerMatrixMesh.castShadow = !isSoftwareGl;
  pipeBody.add(lowerMatrixMesh);

  // 4. Lower Smooth Hydrophobic Inner Liner Bore
  const lowerBoreGeo = buildArcPipeShellGeometry(0.305, 0.358, pipeLength + 0.04, Math.PI * 0.62, Math.PI * 1.34, 36);
  const lowerBoreMesh = new THREE.Mesh(lowerBoreGeo, innerBoreMat);
  lowerBoreMesh.receiveShadow = !isSoftwareGl;
  pipeBody.add(lowerBoreMesh);

  // 5. Helical Cellulose Reinforcement Strands inside the middle wall layer
  const helixGroup = new THREE.Group();
  const strandCount = 6;
  const helixPts = 48;
  for (let s = 0; s < strandCount; s++) {
    const pts: THREE.Vector3[] = [];
    const baseAngle = (s / strandCount) * Math.PI * 2;
    for (let i = 0; i <= helixPts; i++) {
      const t = i / helixPts;
      const x = (t - 0.5) * (pipeLength - 0.14);
      const ang = baseAngle + t * Math.PI * 3.5;
      pts.push(new THREE.Vector3(x, Math.sin(ang) * 0.394, Math.cos(ang) * 0.394));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const tubeGeo = new THREE.TubeGeometry(curve, 52, 0.014, 8, false);
    const strand = new THREE.Mesh(tubeGeo, helicalStrandMat);
    strand.castShadow = !isSoftwareGl;
    helixGroup.add(strand);
  }
  pipeBody.add(helixGroup);

  // 6. Upper Cutaway Section (lifts smoothly upward + slightly backward to reveal interior)
  const upperCutawayGroup = new THREE.Group();
  const upperOuterGeo = buildArcPipeShellGeometry(0.43, 0.52, pipeLength, -Math.PI * 0.04, Math.PI * 0.66, 32);
  const upperOuterMesh = new THREE.Mesh(upperOuterGeo, outerBioMat);
  upperOuterMesh.castShadow = !isSoftwareGl;
  upperCutawayGroup.add(upperOuterMesh);

  const upperMatrixGeo = buildArcPipeShellGeometry(0.36, 0.428, pipeLength - 0.06, -Math.PI * 0.04, Math.PI * 0.66, 28);
  const upperMatrixMesh = new THREE.Mesh(upperMatrixGeo, fiberMatrixMat);
  upperCutawayGroup.add(upperMatrixMesh);

  const upperBoreGeo = buildArcPipeShellGeometry(0.305, 0.358, pipeLength + 0.04, -Math.PI * 0.04, Math.PI * 0.66, 28);
  const upperBoreMesh = new THREE.Mesh(upperBoreGeo, innerBoreMat);
  upperCutawayGroup.add(upperBoreMesh);

  pipeBody.add(upperCutawayGroup);

  // 7. End Joining Flanges & Instanced Compression Fasteners
  const collarGeo = buildArcPipeShellGeometry(0.515, 0.61, 0.18, 0, Math.PI * 2, 42);
  [-pipeLength * 0.5 + 0.1, pipeLength * 0.5 - 0.1].forEach((xPos) => {
    const collar = new THREE.Mesh(collarGeo, brassCollarMat);
    collar.position.set(xPos, 0, 0);
    collar.castShadow = !isSoftwareGl;
    pipeBody.add(collar);
  });

  const boltGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.21, 6);
  boltGeo.rotateZ(Math.PI * 0.5);
  const boltCountPerSide = 8;
  const boltsMesh = new THREE.InstancedMesh(boltGeo, cradleStandMat, boltCountPerSide * 2);
  const dummy = new THREE.Object3D();
  let bIdx = 0;
  [-pipeLength * 0.5 + 0.1, pipeLength * 0.5 - 0.1].forEach((xPos) => {
    for (let i = 0; i < boltCountPerSide; i++) {
      const a = (i / boltCountPerSide) * Math.PI * 2;
      dummy.position.set(xPos, Math.sin(a) * 0.565, Math.cos(a) * 0.565);
      dummy.rotation.set(a, 0, 0);
      dummy.updateMatrix();
      boltsMesh.setMatrixAt(bIdx++, dummy.matrix);
    }
  });
  boltsMesh.instanceMatrix.needsUpdate = true;
  pipeBody.add(boltsMesh);

  // 8. Water Flow Droplets inside Bore (InstancedMesh)
  const dropCount = 44;
  const dropGeo = new THREE.SphereGeometry(0.032, 10, 8);
  dropGeo.scale(1.65, 0.85, 0.85);
  const dropMat = new THREE.MeshPhysicalMaterial({
    color: 0x74d4c0,
    roughness: 0.1,
    metalness: 0.05,
    transmission: 0.45,
    transparent: true,
    opacity: 0.78
  });
  const waterDrops = new THREE.InstancedMesh(dropGeo, dropMat, dropCount);
  const dropMeta = Array.from({ length: dropCount }, (_, i) => ({
    xOffset: (i / dropCount) * pipeLength - pipeLength * 0.5,
    r: 0.05 + ((i * 37) % 100) / 100 * 0.19,
    angle: ((i * 131) % 360) * (Math.PI / 180),
    speed: 0.65 + ((i * 19) % 10) * 0.05
  }));
  pipeBody.add(waterDrops);

  // State for damped transitions
  let targetCutaway = 0.55; // 55% open by default so structure is immediately readable
  let currentCutaway = 0.55;
  let waterFlowEnabled = !prefersReducedMotion;
  let activePresetTween: PresetPose | null = null;
  let isDisposed = false;
  let isVisible = true;
  let rafId = 0;
  let needsRender = true;
  let lastTime = performance.now();

  controls.addEventListener("start", () => {
    activePresetTween = null;
    needsRender = true;
  });

  controls.addEventListener("change", () => {
    needsRender = true;
  });

  const resize = () => {
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = Math.max(240, parent.clientWidth);
    const height = Math.max(240, parent.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    needsRender = true;
  };

  const ro = new ResizeObserver(() => resize());
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  resize();

  const io = new IntersectionObserver(
    (entries) => {
      isVisible = entries.some((e) => e.isIntersecting);
      if (isVisible) {
        needsRender = true;
        scheduleTick();
      }
    },
    { threshold: 0.05 }
  );
  io.observe(canvas);

  function updateWaterInstances(timeSec: number) {
    waterDrops.visible = waterFlowEnabled;
    if (!waterFlowEnabled) return;
    const halfLen = pipeLength * 0.5;
    for (let i = 0; i < dropCount; i++) {
      const m = dropMeta[i];
      let x = ((m.xOffset + timeSec * m.speed + halfLen) % pipeLength) - halfLen;
      const swirl = m.angle + timeSec * 0.45;
      dummy.position.set(x, Math.sin(swirl) * m.r, Math.cos(swirl) * m.r);
      dummy.rotation.set(0, 0, 0);
      const edgeFade = Math.min(1, (halfLen - Math.abs(x)) * 3.5);
      dummy.scale.setScalar(Math.max(0.01, edgeFade));
      dummy.updateMatrix();
      waterDrops.setMatrixAt(i, dummy.matrix);
    }
    waterDrops.instanceMatrix.needsUpdate = true;
  }

  function renderFrame(now: number) {
    if (isDisposed) return;
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    const elapsed = now * 0.001;

    // Smoothly damp cutaway reveal
    if (Math.abs(currentCutaway - targetCutaway) > 0.001) {
      currentCutaway = THREE.MathUtils.damp(currentCutaway, targetCutaway, 8, dt);
      needsRender = true;
    } else {
      currentCutaway = targetCutaway;
    }

    // Apply cutaway offset cleanly without clipping or z-fighting
    upperCutawayGroup.position.set(0, currentCutaway * 0.62, -currentCutaway * 0.24);
    upperCutawayGroup.rotation.x = -currentCutaway * 0.28;

    // Smooth camera preset tweening
    if (activePresetTween) {
      camera.position.x = THREE.MathUtils.damp(camera.position.x, activePresetTween.pos.x, 6, dt);
      camera.position.y = THREE.MathUtils.damp(camera.position.y, activePresetTween.pos.y, 6, dt);
      camera.position.z = THREE.MathUtils.damp(camera.position.z, activePresetTween.pos.z, 6, dt);
      controls.target.x = THREE.MathUtils.damp(controls.target.x, activePresetTween.target.x, 6, dt);
      controls.target.y = THREE.MathUtils.damp(controls.target.y, activePresetTween.target.y, 6, dt);
      controls.target.z = THREE.MathUtils.damp(controls.target.z, activePresetTween.target.z, 6, dt);
      needsRender = true;

      if (camera.position.distanceTo(activePresetTween.pos) < 0.02) {
        activePresetTween = null;
      }
    }

    if (waterFlowEnabled && !prefersReducedMotion) {
      updateWaterInstances(elapsed);
      needsRender = true;
    }

    const controlsChanged = controls.update();
    if (controlsChanged) needsRender = true;

    if (needsRender) {
      renderer.render(scene, camera);
      needsRender = false;
    }

    if (!isSoftwareGl && isVisible) {
      rafId = requestAnimationFrame(renderFrame);
    } else if (isSoftwareGl && (activePresetTween || Math.abs(currentCutaway - targetCutaway) > 0.001)) {
      rafId = requestAnimationFrame(renderFrame);
    } else {
      rafId = 0;
    }
  }

  function scheduleTick() {
    if (isDisposed || rafId !== 0) return;
    lastTime = performance.now();
    rafId = requestAnimationFrame(renderFrame);
  }

  // Initial static placement of water droplets for software GL / first frame
  updateWaterInstances(0.4);
  renderer.render(scene, camera);
  if (!isSoftwareGl) scheduleTick();

  return {
    setCutawayAmount(percent: number) {
      targetCutaway = Math.max(0, Math.min(1, percent / 100));
      needsRender = true;
      scheduleTick();
    },
    setWaterFlow(enabled: boolean) {
      waterFlowEnabled = enabled && !prefersReducedMotion;
      updateWaterInstances(performance.now() * 0.001);
      needsRender = true;
      scheduleTick();
    },
    setPreset(preset: PipeCameraPreset) {
      activePresetTween = PRESET_POSES[preset];
      needsRender = true;
      scheduleTick();
    },
    resize,
    isSoftwareRenderer: () => isSoftwareGl,
    dispose() {
      isDisposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      io.disconnect();
      controls.dispose();
      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          mesh.geometry?.dispose();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((m) => m?.dispose());
        }
      });
      bioTex.map.dispose();
      bioTex.roughnessMap.dispose();
      contactTex.dispose();
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
    }
  };
}
