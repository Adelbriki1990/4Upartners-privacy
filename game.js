// Street Ops — 3D urban combat in the browser (Three.js, no server, no assets).
import * as THREE from './lib/three.module.min.js';

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1420);
scene.fog = new THREE.FogExp2(0x0d1420, 0.011);

const BASE_FOV = 75, ADS_FOV = 52;
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.08, 400);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Lighting — dusk city
// ---------------------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0x4a6285, 0x201d18, 1.5));
const moon = new THREE.DirectionalLight(0x9fb8ff, 1.6);
moon.position.set(-40, 70, -30);
moon.castShadow = true;
moon.shadow.mapSize.set(2048, 2048);
moon.shadow.camera.left = -90; moon.shadow.camera.right = 90;
moon.shadow.camera.top = 90;   moon.shadow.camera.bottom = -90;
moon.shadow.camera.far = 220;
moon.shadow.bias = -0.0004;
scene.add(moon);

// ---------------------------------------------------------------------------
// World geometry + colliders
// ---------------------------------------------------------------------------
const colliders = [];              // THREE.Box3 — blocks movement and bullets
function addCollider(box3) { colliders.push(box3); }

const STREET_HALF = 12;            // road + sidewalks span x in [-12, 12]
const STREET_LEN = 170;            // z in [-85, 85]

// Ground: asphalt strip + sidewalks + dirt beyond
{
  const asphalt = new THREE.Mesh(
    new THREE.PlaneGeometry(17, STREET_LEN),
    new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.95 }));
  asphalt.rotation.x = -Math.PI / 2;
  asphalt.receiveShadow = true;
  scene.add(asphalt);

  const walkMat = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.9 });
  for (const sx of [-1, 1]) {
    const walk = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.22, STREET_LEN), walkMat);
    walk.position.set(sx * 10.5, 0.11, 0);
    walk.receiveShadow = true;
    scene.add(walk);
  }

  // dashed center line
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xd8d4ba });
  for (let z = -82; z < 84; z += 6) {
    const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 2.6), lineMat);
    dash.rotation.x = -Math.PI / 2;
    dash.position.set(0, 0.012, z);
    scene.add(dash);
  }
}

// Procedural lit-window texture for building faces
function makeWindowTexture(hue) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = '#000000'; g.fillRect(0, 0, 128, 128);
  for (let y = 8; y < 120; y += 22) {
    for (let x = 8; x < 120; x += 20) {
      const lit = Math.random() < 0.45;
      g.fillStyle = lit ? `hsl(${hue}, 70%, ${60 + Math.random() * 20}%)` : '#0a0d12';
      g.fillRect(x, y, 11, 14);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function addBuilding(x, z, w, d, h) {
  const tex = makeWindowTexture(Math.random() < 0.7 ? 45 : 200);
  tex.repeat.set(Math.max(1, Math.round(w / 8)), Math.max(1, Math.round(h / 8)));
  const side = new THREE.MeshStandardMaterial({
    color: 0x5a6675, roughness: 0.85,
    emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.85,
  });
  const roof = new THREE.MeshStandardMaterial({ color: 0x191d24, roughness: 1 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [side, side, roof, roof, side, side]);
  mesh.position.set(x, h / 2, z);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  addCollider(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(x, h / 2, z), new THREE.Vector3(w, h, d)));
}

// Two rows of buildings flanking the street, with alley gaps for spawns
const ALLEY_Z = [-55, -20, 15, 50];   // gaps between buildings (enemy spawn lanes)
{
  let z = -85;
  while (z < 85) {
    const gap = ALLEY_Z.some(a => Math.abs(a - z) < 5);
    if (gap) { z += 7; continue; }
    const d = 12 + Math.random() * 10;
    if (z + d > 85) break;
    for (const sx of [-1, 1]) {
      const w = 10 + Math.random() * 8;
      const h = 12 + Math.random() * 22;
      addBuilding(sx * (STREET_HALF + 1.4 + w / 2), z + d / 2, w, d, h);
    }
    z += d + 2.5;
  }
  // end-cap buildings so the street feels enclosed
  addBuilding(0, -97, 40, 14, 26);
  addBuilding(0, 97, 40, 14, 26);
}

// Parked cars — cover
function addCar(x, z, rotY, bodyColor) {
  const g = new THREE.Group();
  const mBody = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.4, metalness: 0.5 });
  const mDark = new THREE.MeshStandardMaterial({ color: 0x11151a, roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.62, 4.4), mBody);
  body.position.y = 0.55; g.add(body);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 2.2), mDark);
  cab.position.set(0, 1.1, -0.2); g.add(cab);
  for (const [wx, wz] of [[-0.95, 1.45], [0.95, 1.45], [-0.95, -1.45], [0.95, -1.45]]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.25, 12), mDark);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.34, wz); g.add(wheel);
  }
  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  g.traverse(o => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
  scene.add(g);
  // collider aligned to rotation (cars are axis-aligned or 90°)
  const along = Math.abs(Math.sin(rotY)) > 0.5;
  addCollider(new THREE.Box3().setFromCenterAndSize(
    new THREE.Vector3(x, 0.8, z),
    new THREE.Vector3(along ? 4.4 : 2.0, 1.6, along ? 2.0 : 4.4)));
}
const CAR_COLORS = [0x7a2f2f, 0x2f4a7a, 0x565b60, 0x6d6437, 0x3b4b41];
for (const [x, z, r] of [[-8.3, -40, 0.06], [8.3, -12, -0.05], [-8.4, 12, 0], [8.2, 38, 0.04],
                         [-8.2, 62, -0.03], [8.4, -62, 0], [2.5, -28, Math.PI / 2], [-3, 30, Math.PI / 2]]) {
  addCar(x, z, r, CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)]);
}

// Concrete barriers + crates mid-street
{
  const mConc = new THREE.MeshStandardMaterial({ color: 0x6f7276, roughness: 0.95 });
  for (const [x, z] of [[0, -5], [-2.2, -5], [2.2, -5], [1, 45], [-1.2, 45], [0, -48], [-4, 20], [4, -33]]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.05, 0.65), mConc);
    b.position.set(x, 0.52, z);
    b.castShadow = b.receiveShadow = true;
    scene.add(b);
    addCollider(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(x, 0.52, z), new THREE.Vector3(2.1, 1.05, 0.65)));
  }
  const mCrate = new THREE.MeshStandardMaterial({ color: 0x5b4a2e, roughness: 0.9 });
  for (const [x, z, s] of [[-6, 4, 1.1], [6.2, 22, 1.3], [-5.5, -22, 1.0], [5.8, -50, 1.2], [-6.5, 55, 1.1]]) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), mCrate);
    c.position.set(x, s / 2, z);
    c.rotation.y = Math.random();
    c.castShadow = c.receiveShadow = true;
    scene.add(c);
    addCollider(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(x, s / 2, z), new THREE.Vector3(s + 0.2, s, s + 0.2)));
  }
}

// Street lamps with warm point lights
{
  const mPole = new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.7, metalness: 0.6 });
  for (let z = -70; z <= 70; z += 35) {
    for (const sx of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 5.6, 8), mPole);
      pole.position.set(sx * 9.6, 2.8, z);
      pole.castShadow = true;
      scene.add(pole);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.1, 0.1), mPole);
      arm.position.set(sx * 8.95, 5.55, z);
      scene.add(arm);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffd9a0 }));
      bulb.position.set(sx * 8.35, 5.45, z);
      scene.add(bulb);
      const light = new THREE.PointLight(0xffc37a, 22, 26, 2);
      light.position.set(sx * 8.35, 5.3, z);
      scene.add(light);
    }
  }
}

// ---------------------------------------------------------------------------
// Ray helpers (bullets & line of sight vs Box3 colliders — no mesh raycasts)
// ---------------------------------------------------------------------------
const _ray = new THREE.Ray();
const _hitPt = new THREE.Vector3();
function worldHitDistance(origin, dir, maxDist) {
  _ray.set(origin, dir);
  let best = maxDist;
  for (const box of colliders) {
    if (_ray.intersectBox(box, _hitPt)) {
      const d = origin.distanceTo(_hitPt);
      if (d < best) best = d;
    }
  }
  return best;
}
const _losDir = new THREE.Vector3();
function hasLineOfSight(from, to) {
  _losDir.subVectors(to, from);
  const dist = _losDir.length();
  _losDir.normalize();
  return worldHitDistance(from, _losDir, dist) >= dist - 0.05;
}

// ---------------------------------------------------------------------------
// Audio — procedural WebAudio, no files
// ---------------------------------------------------------------------------
let AC = null;
function audioInit() { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); }
function noiseBuffer(dur) {
  const buf = AC.createBuffer(1, AC.sampleRate * dur, AC.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
function playShot(volume = 0.5, freq = 900) {
  if (!AC) return;
  const t = AC.currentTime;
  const src = AC.createBufferSource();
  src.buffer = noiseBuffer(0.16);
  const lp = AC.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.setValueAtTime(freq * 4, t);
  lp.frequency.exponentialRampToValueAtTime(180, t + 0.14);
  const gain = AC.createGain();
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  src.connect(lp).connect(gain).connect(AC.destination);
  src.start(t);
  const osc = AC.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(60, t + 0.09);
  const og = AC.createGain();
  og.gain.setValueAtTime(volume * 0.7, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  osc.connect(og).connect(AC.destination);
  osc.start(t); osc.stop(t + 0.11);
}
function playClick(pitch = 1400, vol = 0.15) {
  if (!AC) return;
  const t = AC.currentTime;
  const osc = AC.createOscillator();
  osc.type = 'square';
  osc.frequency.value = pitch;
  const g = AC.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  osc.connect(g).connect(AC.destination);
  osc.start(t); osc.stop(t + 0.06);
}
function playHurt() {
  if (!AC) return;
  const t = AC.currentTime;
  const osc = AC.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(220, t);
  osc.frequency.exponentialRampToValueAtTime(70, t + 0.18);
  const g = AC.createGain();
  g.gain.setValueAtTime(0.22, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  osc.connect(g).connect(AC.destination);
  osc.start(t); osc.stop(t + 0.22);
}

// ---------------------------------------------------------------------------
// Player state + controls
// ---------------------------------------------------------------------------
const player = {
  pos: new THREE.Vector3(0, 0, 72),   // feet position
  vel: new THREE.Vector3(),
  yaw: 0,                              // face down -z
  pitch: 0,
  health: 100,
  lastHurt: -99,
  onGround: true,
  dead: false,
};
const EYE = 1.66, RADIUS = 0.38;

const keys = {};
document.addEventListener('keydown', e => { keys[e.code] = true; if (e.code === 'KeyR') startReload(); });
document.addEventListener('keyup', e => { keys[e.code] = false; });

let firing = false, aiming = false;
document.addEventListener('mousedown', e => {
  if (!locked) return;
  if (e.button === 0) firing = true;
  if (e.button === 2) aiming = true;
});
document.addEventListener('mouseup', e => {
  if (e.button === 0) firing = false;
  if (e.button === 2) aiming = false;
});
document.addEventListener('contextmenu', e => e.preventDefault());

let locked = false;
let started = false;
document.addEventListener('mousemove', e => {
  if (!locked || player.dead) return;
  const sens = aiming ? 0.0012 : 0.0022;
  player.yaw -= e.movementX * sens;
  player.pitch -= e.movementY * sens;
  player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch));
});

const menuEl = document.getElementById('menu');
const pausedEl = document.getElementById('paused');
const gameoverEl = document.getElementById('gameover');
const hudEl = document.getElementById('hud');

function requestLock() { canvas.requestPointerLock(); }
menuEl.addEventListener('click', () => { audioInit(); requestLock(); });
pausedEl.addEventListener('click', requestLock);
gameoverEl.addEventListener('click', () => location.reload());

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (locked) {
    started = true;
    menuEl.style.display = 'none';
    pausedEl.style.display = 'none';
    hudEl.style.display = 'block';
    if (AC && AC.state === 'suspended') AC.resume();
  } else if (started && !player.dead) {
    pausedEl.style.display = 'flex';
    firing = false; aiming = false;
    for (const k in keys) keys[k] = false;
  }
});

// Cylinder-ish collision: push the player horizontally out of every collider
function resolveCollisions(pos, height) {
  for (const box of colliders) {
    if (pos.y + height < box.min.y || pos.y > box.max.y) continue;
    const nx = Math.max(box.min.x, Math.min(pos.x, box.max.x));
    const nz = Math.max(box.min.z, Math.min(pos.z, box.max.z));
    const dx = pos.x - nx, dz = pos.z - nz;
    const d2 = dx * dx + dz * dz;
    if (d2 < RADIUS * RADIUS) {
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        pos.x = nx + (dx / d) * RADIUS;
        pos.z = nz + (dz / d) * RADIUS;
      } else {
        // center inside the box — push out along the smallest penetration axis
        const px = Math.min(pos.x - box.min.x + RADIUS, box.max.x - pos.x + RADIUS);
        const pz = Math.min(pos.z - box.min.z + RADIUS, box.max.z - pos.z + RADIUS);
        if (px < pz) pos.x = (pos.x - box.min.x < box.max.x - pos.x) ? box.min.x - RADIUS : box.max.x + RADIUS;
        else pos.z = (pos.z - box.min.z < box.max.z - pos.z) ? box.min.z - RADIUS : box.max.z + RADIUS;
      }
    }
  }
  // keep inside the street bounds
  pos.x = Math.max(-STREET_HALF - 0.4, Math.min(STREET_HALF + 0.4, pos.x));
  pos.z = Math.max(-88, Math.min(88, pos.z));
}

// ---------------------------------------------------------------------------
// Weapon view model — simple rifle built from boxes, attached to the camera
// ---------------------------------------------------------------------------
const gun = new THREE.Group();
{
  const mGun = new THREE.MeshStandardMaterial({ color: 0x23272c, roughness: 0.45, metalness: 0.7 });
  const mGrip = new THREE.MeshStandardMaterial({ color: 0x33281c, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.085, 0.42), mGun);
  gun.add(body);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.3, 10), mGun);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.012, -0.33);
  gun.add(barrel);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.075), mGrip);
  mag.position.set(0, -0.1, 0.02);
  mag.rotation.x = 0.18;
  gun.add(mag);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.075, 0.17), mGrip);
  stock.position.set(0, -0.012, 0.27);
  gun.add(stock);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.035, 0.06), mGun);
  sight.position.set(0, 0.06, -0.05);
  gun.add(sight);
}
const HIP_POS = new THREE.Vector3(0.24, -0.2, -0.48);
const ADS_POS = new THREE.Vector3(0, -0.115, -0.34);
gun.position.copy(HIP_POS);
camera.add(gun);
scene.add(camera);

const muzzleFlash = new THREE.Mesh(
  new THREE.PlaneGeometry(0.16, 0.16),
  new THREE.MeshBasicMaterial({ color: 0xffd080, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
muzzleFlash.position.set(0, 0.012, -0.52);
gun.add(muzzleFlash);
const muzzleLight = new THREE.PointLight(0xffb060, 0, 8, 2);
muzzleLight.position.set(0, 0, -0.6);
gun.add(muzzleLight);

// ---------------------------------------------------------------------------
// Weapon logic
// ---------------------------------------------------------------------------
const weapon = {
  mag: 30, magSize: 30, reserve: 120,
  fireInterval: 0.1,               // 600 rpm
  damage: 30,
  cooldown: 0,
  reloading: 0,
  recoil: 0,
};

function startReload() {
  if (weapon.reloading > 0 || weapon.mag === weapon.magSize || weapon.reserve <= 0 || player.dead) return;
  weapon.reloading = 1.9;
  playClick(900, 0.2);
  document.getElementById('reloadmsg').style.display = 'block';
}

// Tracers + impact flashes (pooled, short-lived)
const effects = [];
const tracerMat = new THREE.LineBasicMaterial({ color: 0xffe6a8, transparent: true, opacity: 0.9 });
function spawnTracer(from, to) {
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const line = new THREE.Line(geo, tracerMat.clone());
  scene.add(line);
  effects.push({ obj: line, life: 0.07, fade: m => m.obj.material.opacity = 0.9 * (m.life / 0.07) });
}
const impactMat = new THREE.MeshBasicMaterial({ color: 0xffcf7e, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
function spawnImpact(at) {
  const s = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), impactMat.clone());
  s.position.copy(at);
  scene.add(s);
  effects.push({ obj: s, life: 0.12, fade: m => { m.obj.material.opacity = m.life / 0.12; m.obj.scale.setScalar(1 + (0.12 - m.life) * 12); } });
}
function updateEffects(dt) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    e.life -= dt;
    if (e.life <= 0) {
      scene.remove(e.obj);
      e.obj.geometry?.dispose?.();
      e.obj.material?.dispose?.();
      effects.splice(i, 1);
    } else e.fade(e);
  }
}

const hitmarkerEl = document.getElementById('hitmarker');
let hitmarkerTimer = 0;
function showHitmarker(kill) {
  hitmarkerEl.classList.toggle('kill', kill);
  hitmarkerEl.style.opacity = 1;
  hitmarkerTimer = 0.18;
  playClick(kill ? 500 : 1800, 0.18);
}

const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
function fireBullet() {
  weapon.mag--;
  weapon.cooldown = weapon.fireInterval;
  weapon.recoil = Math.min(weapon.recoil + 1, 5);
  playShot(0.45, 950);
  muzzleFlash.material.opacity = 1;
  muzzleFlash.rotation.z = Math.random() * Math.PI;
  muzzleLight.intensity = 14;

  camera.getWorldDirection(_dir);
  const spread = aiming ? 0.004 : 0.018;
  _dir.x += (Math.random() - 0.5) * spread;
  _dir.y += (Math.random() - 0.5) * spread;
  _dir.z += (Math.random() - 0.5) * spread;
  _dir.normalize();
  _origin.copy(camera.position);

  const maxDist = 200;
  let hitDist = worldHitDistance(_origin, _dir, maxDist);
  let hitEnemy = null, headshot = false;
  _ray.set(_origin, _dir);
  for (const en of enemies) {
    if (en.dead) continue;
    if (_ray.intersectBox(en.headBox, _hitPt)) {
      const d = _origin.distanceTo(_hitPt);
      if (d < hitDist) { hitDist = d; hitEnemy = en; headshot = true; }
    }
    if (_ray.intersectBox(en.bodyBox, _hitPt)) {
      const d = _origin.distanceTo(_hitPt);
      if (d < hitDist) { hitDist = d; hitEnemy = en; headshot = false; }
    }
  }

  const end = _origin.clone().addScaledVector(_dir, hitDist);
  const muzzleWorld = muzzleFlash.getWorldPosition(new THREE.Vector3());
  spawnTracer(muzzleWorld, end);
  spawnImpact(end);

  if (hitEnemy) {
    const dmg = headshot ? weapon.damage * 2 : weapon.damage;
    damageEnemy(hitEnemy, dmg);
    showHitmarker(hitEnemy.dead);
  }
}

// ---------------------------------------------------------------------------
// Enemies — patrol / chase / shoot, simple box-soldier rigs
// ---------------------------------------------------------------------------
const enemies = [];
const SPAWNS = [];
for (const az of ALLEY_Z) { SPAWNS.push([-STREET_HALF - 2, az], [STREET_HALF + 2, az]); }
SPAWNS.push([0, -84], [4, -84], [-4, -84]);

const mSkin = new THREE.MeshStandardMaterial({ color: 0xb08a67, roughness: 0.9 });
function makeSoldier() {
  const g = new THREE.Group();
  const mUniform = new THREE.MeshStandardMaterial({ color: 0x424b3a, roughness: 0.9 });
  const mVest = new THREE.MeshStandardMaterial({ color: 0x2c2f2a, roughness: 0.85 });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.62, 0.3), mVest);
  torso.position.y = 1.12; g.add(torso);
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.24, 0.27), mUniform);
  hips.position.y = 0.72; g.add(hips);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.28, 0.26), mSkin);
  head.position.y = 1.62; g.add(head);
  const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.3), mUniform);
  helmet.position.y = 1.76; g.add(helmet);
  const legs = [];
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.6, 0.2), mUniform);
    leg.position.set(sx * 0.13, 0.3, 0);
    g.add(leg); legs.push(leg);
  }
  const arms = [];
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.5, 0.16), mUniform);
    arm.position.set(sx * 0.34, 1.15, 0);
    g.add(arm); arms.push(arm);
  }
  const rifle = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.62),
    new THREE.MeshStandardMaterial({ color: 0x1b1e22, roughness: 0.5, metalness: 0.6 }));
  rifle.position.set(0.2, 1.2, -0.3);
  g.add(rifle);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return { group: g, legs, arms, rifle };
}

function spawnEnemy(x, z) {
  const rig = makeSoldier();
  rig.group.position.set(x, 0, z);
  scene.add(rig.group);
  enemies.push({
    rig,
    pos: rig.group.position,
    health: 100,
    dead: false,
    deathT: 0,
    fireCooldown: 1 + Math.random() * 1.5,
    strafe: Math.random() < 0.5 ? 1 : -1,
    strafeT: 1 + Math.random() * 2,
    walkPhase: Math.random() * 6,
    speed: 3.0 + Math.random() * 1.2,
    bodyBox: new THREE.Box3(),
    headBox: new THREE.Box3(),
  });
}

function damageEnemy(en, dmg) {
  if (en.dead) return;
  en.health -= dmg;
  if (en.health <= 0) {
    en.dead = true;
    en.deathT = 0;
    game.kills++;
    addFeed('Hostile down');
  }
}

const _toPlayer = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _enEye = new THREE.Vector3();
function updateEnemy(en, dt) {
  if (en.dead) {
    en.deathT += dt;
    en.rig.group.rotation.x = Math.min(en.deathT * 4, Math.PI / 2);   // topple
    en.rig.group.position.y = -Math.max(0, en.deathT - 1.6) * 0.6;    // sink away
    if (en.deathT > 3) {
      scene.remove(en.rig.group);
      en.gone = true;
    }
    return;
  }

  _eye.set(player.pos.x, player.pos.y + EYE, player.pos.z);
  _enEye.set(en.pos.x, en.pos.y + 1.55, en.pos.z);
  _toPlayer.subVectors(player.pos, en.pos);
  _toPlayer.y = 0;
  const dist = _toPlayer.length();
  _toPlayer.normalize();

  // face the player
  en.rig.group.rotation.y = Math.atan2(_toPlayer.x, _toPlayer.z);

  const los = dist < 70 && hasLineOfSight(_enEye, _eye);

  // movement: close distance, strafe when near
  let moving = false;
  if (!player.dead) {
    en.strafeT -= dt;
    if (en.strafeT <= 0) { en.strafe *= -1; en.strafeT = 1.2 + Math.random() * 2.2; }
    const step = new THREE.Vector3();
    if (dist > 16 || !los) step.addScaledVector(_toPlayer, 1);
    else if (dist < 8) step.addScaledVector(_toPlayer, -0.6);
    if (los && dist < 26) step.add(new THREE.Vector3(-_toPlayer.z, 0, _toPlayer.x).multiplyScalar(en.strafe * 0.7));
    if (step.lengthSq() > 0.001) {
      step.normalize().multiplyScalar(en.speed * dt);
      en.pos.add(step);
      resolveCollisions(en.pos, 1.7);
      moving = true;
    }
  }

  // walk cycle
  if (moving) {
    en.walkPhase += dt * 9;
    const sw = Math.sin(en.walkPhase) * 0.5;
    en.rig.legs[0].rotation.x = sw;
    en.rig.legs[1].rotation.x = -sw;
    en.rig.arms[0].rotation.x = -sw * 0.5;
    en.rig.arms[1].rotation.x = sw * 0.5;
  }

  // shooting
  en.fireCooldown -= dt;
  if (!player.dead && los && dist < 55 && en.fireCooldown <= 0) {
    en.fireCooldown = 0.55 + Math.random() * 0.9;
    const muzzle = _enEye.clone();
    // accuracy falls off with distance and player sprinting
    let hitChance = Math.max(0.12, 0.55 - dist * 0.007);
    if (keys['ShiftLeft'] || keys['ShiftRight']) hitChance *= 0.72;
    playShot(Math.max(0.08, 0.4 - dist * 0.005), 700);
    if (Math.random() < hitChance) {
      spawnTracer(muzzle, _eye.clone().add(new THREE.Vector3((Math.random() - .5) * .1, (Math.random() - .5) * .1, 0)));
      hurtPlayer(7 + Math.random() * 8);
    } else {
      const miss = _eye.clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 2.5, (Math.random() - 0.5) * 3));
      const d = miss.sub(muzzle).normalize();
      const hd = worldHitDistance(muzzle, d, 90);
      const end = muzzle.clone().addScaledVector(d, hd);
      spawnTracer(muzzle, end);
      spawnImpact(end);
    }
  }

  // hitboxes
  en.bodyBox.setFromCenterAndSize(new THREE.Vector3(en.pos.x, en.pos.y + 0.75, en.pos.z), new THREE.Vector3(0.62, 1.5, 0.45));
  en.headBox.setFromCenterAndSize(new THREE.Vector3(en.pos.x, en.pos.y + 1.65, en.pos.z), new THREE.Vector3(0.34, 0.4, 0.34));
}

// ---------------------------------------------------------------------------
// Player damage / regen (COD-style)
// ---------------------------------------------------------------------------
const vignetteEl = document.getElementById('vignette');
function hurtPlayer(dmg) {
  if (player.dead) return;
  player.health -= dmg;
  player.lastHurt = game.time;
  playHurt();
  if (player.health <= 0) {
    player.health = 0;
    playerDie();
  }
}
function playerDie() {
  player.dead = true;
  firing = false;
  document.getElementById('go-wave').textContent = game.wave;
  document.getElementById('go-kills').textContent = game.kills;
  document.exitPointerLock();
  pausedEl.style.display = 'none';
  gameoverEl.style.display = 'flex';
}

// ---------------------------------------------------------------------------
// Waves + HUD
// ---------------------------------------------------------------------------
const game = { wave: 0, kills: 0, time: 0, intermission: 0 };
const waveEl = document.getElementById('wave');
const aliveEl = document.getElementById('alive');
const killsEl = document.getElementById('kills');
const magEl = document.getElementById('mag');
const reserveEl = document.getElementById('reserve');
const healthfillEl = document.getElementById('healthfill');
const bannerEl = document.getElementById('wavebanner');
const feedEl = document.getElementById('feed');

function addFeed(text) {
  const div = document.createElement('div');
  div.textContent = text;
  feedEl.prepend(div);
  while (feedEl.children.length > 4) feedEl.lastChild.remove();
  setTimeout(() => div.remove(), 4000);
}

let bannerTimer = 0;
function showBanner(text) {
  bannerEl.textContent = text;
  bannerEl.style.opacity = 1;
  bannerTimer = 2.2;
}

function startWave() {
  game.wave++;
  weapon.reserve = Math.max(weapon.reserve, 120);
  const count = Math.min(3 + game.wave * 2, 14);
  const pool = [...SPAWNS].sort(() => Math.random() - 0.5);
  for (let i = 0; i < count; i++) {
    const [x, z] = pool[i % pool.length];
    spawnEnemy(x + (Math.random() - 0.5) * 2, z + (Math.random() - 0.5) * 2);
  }
  showBanner(`Wave ${game.wave}`);
  addFeed(`Wave ${game.wave} — ${count} hostiles inbound`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let bobPhase = 0;

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!started) { renderer.render(scene, camera); return; }
  if (!locked && !player.dead) { renderer.render(scene, camera); return; }
  game.time += dt;

  // ---- player movement ----
  if (!player.dead) {
    const sprinting = (keys['ShiftLeft'] || keys['ShiftRight']) && keys['KeyW'] && !aiming;
    const speed = aiming ? 2.6 : sprinting ? 8.2 : 5.2;
    const fwd = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const wish = new THREE.Vector3();
    if (keys['KeyW']) wish.add(fwd);
    if (keys['KeyS']) wish.sub(fwd);
    if (keys['KeyD']) wish.add(right);
    if (keys['KeyA']) wish.sub(right);
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
    // smooth accelerate
    player.vel.x += (wish.x - player.vel.x) * Math.min(1, dt * 12);
    player.vel.z += (wish.z - player.vel.z) * Math.min(1, dt * 12);
    // gravity + jump
    player.vel.y -= 22 * dt;
    if (keys['Space'] && player.onGround) { player.vel.y = 7.2; player.onGround = false; }
    player.pos.addScaledVector(player.vel, dt);
    if (player.pos.y <= 0) { player.pos.y = 0; player.vel.y = 0; player.onGround = true; }
    resolveCollisions(player.pos, 1.75);

    // view bob
    const planarSpeed = Math.hypot(player.vel.x, player.vel.z);
    if (planarSpeed > 0.5 && player.onGround) bobPhase += dt * planarSpeed * 1.6;
    const bob = Math.sin(bobPhase) * 0.017 * Math.min(planarSpeed / 5, 1) * (aiming ? 0.3 : 1);

    camera.position.set(player.pos.x, player.pos.y + EYE + bob, player.pos.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(player.pitch + weapon.recoil * 0.012, player.yaw, 0);

    // health regen after 4s without damage
    if (player.health < 100 && game.time - player.lastHurt > 4) {
      player.health = Math.min(100, player.health + dt * 22);
    }

    // ---- weapon ----
    weapon.cooldown -= dt;
    weapon.recoil = Math.max(0, weapon.recoil - dt * 10);
    if (weapon.reloading > 0) {
      weapon.reloading -= dt;
      if (weapon.reloading <= 0) {
        const need = weapon.magSize - weapon.mag;
        const take = Math.min(need, weapon.reserve);
        weapon.mag += take;
        weapon.reserve -= take;
        playClick(1600, 0.2);
        document.getElementById('reloadmsg').style.display = 'none';
      }
    } else if (firing && weapon.cooldown <= 0) {
      if (weapon.mag > 0) fireBullet();
      else { playClick(2100, 0.12); weapon.cooldown = 0.25; if (weapon.reserve > 0) startReload(); }
    }

    // ADS interpolation + gun sway
    const targetPos = aiming ? ADS_POS : HIP_POS;
    gun.position.lerp(targetPos, Math.min(1, dt * 12));
    gun.position.y += bob * 0.5;
    gun.position.z += weapon.recoil * 0.006;
    gun.rotation.x = weapon.recoil * 0.02;
    const targetFov = aiming ? ADS_FOV : BASE_FOV;
    if (Math.abs(camera.fov - targetFov) > 0.1) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 14);
      camera.updateProjectionMatrix();
    }
  }
  muzzleFlash.material.opacity = Math.max(0, muzzleFlash.material.opacity - dt * 18);
  muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 160);

  // ---- enemies + waves ----
  let alive = 0;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const en = enemies[i];
    updateEnemy(en, dt);
    if (en.gone) enemies.splice(i, 1);
    else if (!en.dead) alive++;
  }
  if (!player.dead) {
    if (game.wave === 0) startWave();
    else if (alive === 0 && enemies.length === 0) {
      game.intermission += dt;
      if (game.intermission > 4) { game.intermission = 0; startWave(); }
      else if (game.intermission > 3.9) showBanner('Get ready…');
    }
  }

  updateEffects(dt);

  // ---- HUD ----
  waveEl.textContent = game.wave;
  aliveEl.textContent = alive;
  killsEl.textContent = game.kills;
  magEl.textContent = weapon.mag;
  reserveEl.textContent = weapon.reserve;
  healthfillEl.style.width = player.health + '%';
  healthfillEl.style.background = player.health > 50
    ? 'linear-gradient(90deg,#3ddc7a,#8bf0b0)'
    : 'linear-gradient(90deg,#e0483a,#f09a5a)';
  vignetteEl.style.opacity = Math.min(1, (100 - player.health) / 70 + (game.time - player.lastHurt < 0.4 ? 0.5 : 0));
  if (hitmarkerTimer > 0) {
    hitmarkerTimer -= dt;
    if (hitmarkerTimer <= 0) hitmarkerEl.style.opacity = 0;
  }
  if (bannerTimer > 0) {
    bannerTimer -= dt;
    bannerEl.style.opacity = Math.min(1, bannerTimer);
  }

  renderer.render(scene, camera);
}
tick();
