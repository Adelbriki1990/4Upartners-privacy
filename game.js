// Street Ops — cinematic 3D urban combat in the browser (Three.js, no assets).
// Three selectable cities, sponsor advertising, drivable cars, wave combat.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CITIES } from './sponsors.js?v=16';

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
const BASE_FOV = 75, ADS_FOV = 52;
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.08, 500);

// post-processing: bloom makes the neon actually glow
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.5, 0.82);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());
function doRender() { composer.render(); }

// cinematic color grade (death cam overrides with grayscale)
const GRADE = 'saturate(1.14) contrast(1.05)';
canvas.style.filter = GRADE;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// City themes (visuals per city id; sponsors/config live in sponsors.js)
// ---------------------------------------------------------------------------
const THEMES = {
  neon: {
    sky: 0x0d1420, fog: 0.0105, hemi: [0x4a6285, 0x201d18, 1.5],
    moonColor: 0x9fb8ff, lamp: 0x9fd8ff,
    wall: { h: 220, s: 10, l: 27 }, windowHues: [200, 210, 265, 285, 45, 200],
    neon: ['#41d8ff', '#ff4fd8', '#7dff8a', '#d07dff', '#ffd23f'],
    rain: 1400, thunder: true, hMin: 18, hMax: 46,
    styles: { curtain: 0.5, brick: 0.05 }, tree: { color: 0x1e3022, every: 26, chance: 0.5 },
  },
  marina: {
    sky: 0x141824, fog: 0.008, hemi: [0x5a6a8a, 0x2a2318, 1.6],
    moonColor: 0xbcccff, lamp: 0xffc37a,
    wall: { h: 38, s: 16, l: 33 }, windowHues: [45, 48, 52, 42, 200, 46],
    neon: ['#ffd23f', '#ff9c41', '#41d8ff', '#ff5f6d', '#7dff8a'],
    rain: 0, thunder: false, hMin: 16, hMax: 42,
    styles: { curtain: 0.45, brick: 0.08 }, tree: { color: 0x2a4530, every: 20, chance: 0.65 },
  },
  harbor: {
    sky: 0x14100e, fog: 0.0125, hemi: [0x6a5648, 0x241c14, 1.4],
    moonColor: 0xd8c8b0, lamp: 0xffa04a,
    wall: { h: 14, s: 30, l: 26 }, windowHues: [35, 40, 30, 45, 38, 25],
    neon: ['#ff8a5f', '#ffd23f', '#ff5f6d', '#7dff8a', '#41d8ff'],
    rain: 750, thunder: true, hMin: 9, hMax: 24,
    styles: { curtain: 0.06, brick: 0.6 }, tree: { color: 0x2c3620, every: 22, chance: 0.55 },
  },
};
let CITY = null, THEME = null;

// ---------------------------------------------------------------------------
// Real-time day/night: the city matches the player's actual local clock.
// Override for testing with ?time=day | ?time=night | ?time=18.5
// ---------------------------------------------------------------------------
function localHour() {
  const q = new URLSearchParams(location.search).get('time');
  if (q === 'day') return 13;
  if (q === 'night') return 23;
  if (q === 'dusk') return 18.5;
  if (q !== null && !isNaN(parseFloat(q))) return parseFloat(q);
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
}
// 1 = full night, 0 = full day, smooth through dawn (5-8h) and dusk (17-20h)
function nightFactorAt(h) {
  if (h >= 20 || h < 5) return 1;
  if (h >= 8 && h < 17) return 0;
  if (h < 8) return 1 - (h - 5) / 3;
  return (h - 17) / 3;
}
let NF = 1; // current night factor
const DAY = {
  neon:   { sky: 0x8d9aab, fogMul: 0.55 },   // overcast rainy day
  marina: { sky: 0x9dbcdd, fogMul: 0.4 },    // clear blue
  harbor: { sky: 0x9aa4ac, fogMul: 0.6 },
};
const lampLights = [];   // point lights that dim at day
const EMI_MATS = [];     // window/storefront materials whose glow dims at day
let starsObj = null, moonSprite = null;

// ---------------------------------------------------------------------------
// Lighting + sky
// ---------------------------------------------------------------------------
const hemi = new THREE.HemisphereLight(0x4a6285, 0x201d18, 1.5);
scene.add(hemi);
const moon = new THREE.DirectionalLight(0x9fb8ff, 1.6);
moon.position.set(-40, 70, -30);
moon.castShadow = true;
moon.shadow.mapSize.set(2048, 2048);
moon.shadow.camera.left = -90; moon.shadow.camera.right = 90;
moon.shadow.camera.top = 90;   moon.shadow.camera.bottom = -90;
moon.shadow.camera.far = 260;
moon.shadow.bias = -0.0004;
scene.add(moon);
scene.add(moon.target);
let MOON_BASE = 1.6;

{
  const starGeo = new THREE.BufferGeometry();
  const pos = new Float32Array(500 * 3);
  for (let i = 0; i < 500; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 700;
    pos[i * 3 + 1] = 60 + Math.random() * 260;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 700;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  starsObj = new THREE.Points(starGeo, new THREE.PointsMaterial({
    color: 0xaabbdd, size: 0.6, transparent: true, opacity: 0.8, fog: false }));
  scene.add(starsObj);

  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, 'rgba(235,240,255,1)');
  grad.addColorStop(0.25, 'rgba(190,205,235,.85)');
  grad.addColorStop(1, 'rgba(150,170,220,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  moonSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cv), transparent: true, fog: false, depthWrite: false }));
  moonSprite.scale.setScalar(44);
  moonSprite.position.set(-130, 150, -220);
  scene.add(moonSprite);
}

// gradient sky dome (repainted per city/time in buildCity)
let skyCtx = null, skyTex = null;
{
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 512;
  skyCtx = cv.getContext('2d');
  skyTex = new THREE.CanvasTexture(cv);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(430, 24, 16),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false }));
  dome.renderOrder = -10;
  scene.add(dome);
}
function paintSky() {
  const day = DAY[CITY.id] || DAY.neon;
  const top = new THREE.Color(day.sky).multiplyScalar(0.72).lerp(new THREE.Color(0x03040a), NF);
  const mid = new THREE.Color(day.sky).lerp(new THREE.Color(THEME.sky), NF);
  const hor = mid.clone().lerp(new THREE.Color(THEME.lamp), 0.08 + 0.35 * NF); // city glow
  const grad = skyCtx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#' + top.getHexString());
  grad.addColorStop(0.52, '#' + mid.getHexString());
  grad.addColorStop(0.76, '#' + hor.getHexString());
  grad.addColorStop(1, '#' + mid.clone().multiplyScalar(0.45).getHexString());
  skyCtx.fillStyle = grad;
  skyCtx.fillRect(0, 0, 64, 512);
  skyTex.needsUpdate = true;
}
// shared radial glow sprite texture (lamp halos etc.)
const glowTexShared = (() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,.9)');
  grad.addColorStop(0.4, 'rgba(255,255,255,.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
})();

// ---------------------------------------------------------------------------
// City layout constants
// ---------------------------------------------------------------------------
const STREETS = [-120, -60, 0, 60, 120];
const ROAD_HALF = 7;
const CITY_HALF = 150;
const BOUND = 132;

// Fictional street names (deliberately not real streets)
const AVE_NAMES = ['VOLT AVE', 'NOVA AVE', 'CENTRAL AVE', 'HARBOR AVE', 'SUNSET AVE'];
const ST_NAMES = ['1ST STREET', '2ND STREET', '3RD STREET', '4TH STREET', '5TH STREET'];
const DISTRICTS = ['NORTH HEIGHTS', 'OLD QUARTER', 'MARKET END', 'TOWER GARDENS'];
function locationName(x, z) {
  const ai = STREETS.findIndex(s => Math.abs(x - s) <= ROAD_HALF + 1.5);
  const si = STREETS.findIndex(s => Math.abs(z - s) <= ROAD_HALF + 1.5);
  if (ai >= 0 && si >= 0) return AVE_NAMES[ai] + ' × ' + ST_NAMES[si];
  if (ai >= 0) return AVE_NAMES[ai];
  if (si >= 0) return ST_NAMES[si];
  return DISTRICTS[(x < 0 ? 0 : 1) + (z < 0 ? 0 : 2)];
}

// ---------------------------------------------------------------------------
// Colliders + ray helpers (everything solid is an axis-aligned Box3)
// ---------------------------------------------------------------------------
const colliders = [];
function addCollider(box3) { colliders.push(box3); return box3; }

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
function audioInit() {
  if (AC) return;
  AC = new (window.AudioContext || window.webkitAudioContext)();
  const src = AC.createBufferSource();
  src.buffer = noiseBuffer(2);
  src.loop = true;
  const lp = AC.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 420;
  const g = AC.createGain();
  g.gain.value = 0.05;
  const lfo = AC.createOscillator();
  lfo.frequency.value = 0.13;
  const lfoGain = AC.createGain();
  lfoGain.gain.value = 0.02;
  lfo.connect(lfoGain).connect(g.gain);
  src.connect(lp).connect(g).connect(AC.destination);
  src.start(); lfo.start();
  renderMusic(); // async: loops fade in once rendered
}
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
function playThunder() {
  if (!AC) return;
  const t = AC.currentTime + 0.7;
  const src = AC.createBufferSource();
  src.buffer = noiseBuffer(2.2);
  const lp = AC.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(140, t);
  lp.frequency.exponentialRampToValueAtTime(45, t + 2);
  const g = AC.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.3, t + 0.15);
  g.gain.exponentialRampToValueAtTime(0.001, t + 2.1);
  src.connect(lp).connect(g).connect(AC.destination);
  src.start(t);
}
// ---------------------------------------------------------------------------
// Music — procedurally rendered loops (city synthwave + club four-on-floor),
// mixed live by distance to the nightclub
// ---------------------------------------------------------------------------
let musicNodes = null, musicOn = true;
const clubPos = new THREE.Vector3(11.5, 0, 45);
async function renderMusic() {
  const mk = async (kind) => {
    const bpm = kind === 'club' ? 126 : 96;
    const spb = 60 / bpm, bars = 4, dur = bars * 4 * spb;
    const oc = new OfflineAudioContext(1, Math.ceil(44100 * dur), 44100);
    const master = oc.createGain();
    master.gain.value = 0.9;
    master.connect(oc.destination);
    const nb = oc.createBuffer(1, 44100, 44100);
    { const d = nb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const tone = (type, freq, t, len, vol, lpf) => {
      const o = oc.createOscillator();
      o.type = type; o.frequency.value = freq;
      const g = oc.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t + len);
      const f = oc.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = lpf || 4000;
      o.connect(g).connect(f).connect(master);
      o.start(t); o.stop(t + len + 0.02);
    };
    const hat = (t, vol) => {
      const s = oc.createBufferSource();
      s.buffer = nb;
      const f = oc.createBiquadFilter();
      f.type = 'highpass'; f.frequency.value = 8000;
      const g = oc.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
      s.connect(f).connect(g).connect(master);
      s.start(t); s.stop(t + 0.06);
    };
    const kick = (t) => {
      const o = oc.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
      const g = oc.createGain();
      g.gain.setValueAtTime(0.85, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      o.connect(g).connect(master);
      o.start(t); o.stop(t + 0.25);
    };
    const roots = [110, 87.31, 130.81, 98]; // Am F C G
    for (let bar = 0; bar < bars; bar++) {
      const r = roots[bar], t0 = bar * 4 * spb;
      if (kind === 'club') {
        for (let b = 0; b < 4; b++) {
          kick(t0 + b * spb);
          hat(t0 + b * spb + spb / 2, 0.14);
        }
        for (let s16 = 0; s16 < 16; s16++)
          if (s16 % 2 === 0)
            tone('sawtooth', r / 2, t0 + s16 * spb / 4, spb / 4 * 0.8, 0.15, 420 + (s16 % 8) * 200);
        if (bar % 2 === 0)
          for (const f of [r * 2, r * 2.38, r * 3]) tone('square', f, t0, spb * 0.55, 0.045, 2200);
      } else {
        for (const f of [r, r * 1.19, r * 1.5, r * 2]) tone('sawtooth', f, t0 + 0.02, 4 * spb * 0.95, 0.045, 750);
        for (let e = 0; e < 8; e++)
          tone('triangle', r / 2, t0 + e * spb / 2, spb / 2 * 0.7, e % 2 ? 0.055 : 0.095, 420);
        hat(t0 + spb * 1.5, 0.05);
        hat(t0 + spb * 3.5, 0.05);
      }
    }
    return oc.startRendering();
  };
  const [cityBuf, clubBuf] = await Promise.all([mk('city'), mk('club')]);
  const mkNode = (buf) => {
    const src = AC.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filt = AC.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 18000;
    const g = AC.createGain();
    g.gain.value = 0;
    src.connect(filt).connect(g).connect(AC.destination);
    src.start();
    return { src, g, filt };
  };
  musicNodes = { city: mkNode(cityBuf), club: mkNode(clubBuf) };
}
function updateMusic() {
  if (!musicNodes) return;
  const d = Math.hypot(player.pos.x - clubPos.x, player.pos.z - clubPos.z);
  const prox = Math.max(0, 1 - d / 52);
  musicNodes.club.g.gain.value = musicOn ? 0.5 * Math.pow(prox, 1.6) : 0;
  musicNodes.club.filt.frequency.value = 320 + Math.pow(prox, 2) * 11000;
  musicNodes.city.g.gain.value = musicOn ? 0.05 * (1 - prox * 0.85) : 0;
}

function playCrash(k) {
  if (!AC) return;
  const t = AC.currentTime;
  const src = AC.createBufferSource();
  src.buffer = noiseBuffer(0.35);
  const lp = AC.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(900, t);
  lp.frequency.exponentialRampToValueAtTime(120, t + 0.3);
  const g = AC.createGain();
  g.gain.setValueAtTime(0.55 * k, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
  src.connect(lp).connect(g).connect(AC.destination);
  src.start(t);
  const osc = AC.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(170, t);
  osc.frequency.exponentialRampToValueAtTime(55, t + 0.18);
  const og = AC.createGain();
  og.gain.setValueAtTime(0.3 * k, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  osc.connect(og).connect(AC.destination);
  osc.start(t); osc.stop(t + 0.22);
}

let engineNodes = null;
function engineStart() {
  if (!AC || engineNodes) return;
  const osc = AC.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = 55;
  const lp = AC.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 240;
  const g = AC.createGain();
  g.gain.value = 0.05;
  osc.connect(lp).connect(g).connect(AC.destination);
  osc.start();
  engineNodes = { osc, g };
}
function engineUpdate(speed) {
  if (engineNodes) engineNodes.osc.frequency.value = 55 + Math.abs(speed) * 5.5;
}
function engineStop() {
  if (!engineNodes) return;
  engineNodes.osc.stop();
  engineNodes = null;
}

// ---------------------------------------------------------------------------
// Facade / storefront / sign / billboard texture builders
// ---------------------------------------------------------------------------
// One 512px tile represents ~20m x 24m of wall (8 floors).
// Three facade families so the skyline reads like a real mixed city.
function makeFacadeCanvases(wall, hue, style) {
  const S = 512, FLOORS = 8;
  const mapCv = document.createElement('canvas');
  const emiCv = document.createElement('canvas');
  mapCv.width = mapCv.height = emiCv.width = emiCv.height = S;
  const m = mapCv.getContext('2d');
  const e = emiCv.getContext('2d');
  const fh = S / FLOORS;
  e.fillStyle = '#04060a'; e.fillRect(0, 0, S, S);

  if (style === 'curtain') {
    // glass tower: spandrel bands + continuous window bands with mullions
    const panel = `hsl(${wall.h}, ${Math.max(4, wall.s - 8)}%, ${Math.max(10, wall.l - 12)}%)`;
    m.fillStyle = panel; m.fillRect(0, 0, S, S);
    for (let f = 0; f < FLOORS; f++) {
      const gy = f * fh + fh * 0.3, gh = fh * 0.62;
      const grad = m.createLinearGradient(0, gy, 0, gy + gh);
      grad.addColorStop(0, '#141d2b');
      grad.addColorStop(1, '#0a1019');
      m.fillStyle = grad; m.fillRect(0, gy, S, gh);
      m.fillStyle = 'rgba(140,170,210,.08)';
      m.fillRect(0, gy, S, gh * 0.28);
      // lit runs of offices
      let b = 0;
      while (b < 16) {
        const run = 1 + Math.floor(Math.random() * 3);
        if (Math.random() < 0.3 - f * 0.015) {
          const warm = Math.random() < 0.6;
          const col = warm ? `hsla(${hue}, 55%, ${58 + Math.random() * 18}%,` : `hsla(210, 25%, ${62 + Math.random() * 15}%,`;
          m.fillStyle = col + '.85)';
          m.fillRect(b * 32, gy + 2, run * 32, gh - 4);
          e.fillStyle = col + '.9)';
          e.fillRect(b * 32, gy + 2, run * 32, gh - 4);
        }
        b += run;
      }
      // mullions
      m.fillStyle = 'rgba(0,0,0,.55)';
      for (let x = 0; x < S; x += 32) m.fillRect(x, gy, 2, gh);
      m.fillStyle = 'rgba(0,0,0,.4)';
      m.fillRect(0, gy - 2, S, 2);
      m.fillRect(0, gy + gh, S, 3);
    }
  } else if (style === 'brick') {
    // masonry: mortar courses, smaller punched windows with lintels
    m.fillStyle = `hsl(${wall.h}, ${wall.s + 12}%, ${wall.l - 2 + Math.random() * 6}%)`;
    m.fillRect(0, 0, S, S);
    for (let y = 0; y < S; y += 7) {
      m.fillStyle = 'rgba(0,0,0,.12)';
      m.fillRect(0, y, S, 1);
    }
    for (let i = 0; i < 2200; i++) {
      m.fillStyle = `rgba(${Math.random() < 0.5 ? '255,240,220' : '20,10,5'},${0.02 + Math.random() * 0.05})`;
      m.fillRect(Math.random() * S, Math.random() * S, 3, 2);
    }
    const BAYS = 10, bw = S / BAYS;
    for (let f = 0; f < FLOORS; f++) {
      m.fillStyle = 'rgba(0,0,0,.28)';
      m.fillRect(0, f * fh + fh - 3, S, 3);
      for (let b = 0; b < BAYS; b++) {
        if (Math.random() < 0.08) continue; // blind bay
        const wx = b * bw + bw * 0.24, wy = f * fh + fh * 0.22;
        const ww = bw * 0.52, wh = fh * 0.56;
        m.fillStyle = 'rgba(225,220,205,.35)'; m.fillRect(wx - 3, wy - 4, ww + 6, 3);  // lintel
        m.fillStyle = 'rgba(225,220,205,.25)'; m.fillRect(wx - 2, wy + wh + 1, ww + 4, 2); // sill
        m.fillStyle = '#0d1117'; m.fillRect(wx - 2, wy - 1, ww + 4, wh + 2);
        if (Math.random() < 0.35 - f * 0.02) {
          const bright = 50 + Math.random() * 25;
          m.fillStyle = `hsl(${hue}, 60%, ${bright}%)`; m.fillRect(wx, wy, ww, wh);
          e.fillStyle = `hsl(${hue}, 60%, ${bright}%)`; e.fillRect(wx, wy, ww, wh);
          if (Math.random() < 0.4) {
            m.fillStyle = 'rgba(16,18,24,.9)'; m.fillRect(wx, wy, ww, wh * 0.45);
            e.fillStyle = 'rgba(0,0,0,.9)'; e.fillRect(wx, wy, ww, wh * 0.45);
          }
        } else {
          const grad = m.createLinearGradient(0, wy, 0, wy + wh);
          grad.addColorStop(0, '#151d29'); grad.addColorStop(1, '#0a0f16');
          m.fillStyle = grad; m.fillRect(wx, wy, ww, wh);
        }
        m.fillStyle = 'rgba(0,0,0,.5)';
        m.fillRect(wx + ww / 2 - 1, wy, 2, wh);
      }
    }
  } else {
    // punched concrete (refined): framed windows, blinds, floor slabs
    m.fillStyle = `hsl(${wall.h + Math.random() * 12}, ${wall.s}%, ${wall.l + Math.random() * 10}%)`;
    m.fillRect(0, 0, S, S);
    for (let i = 0; i < 1600; i++) {
      m.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},${0.03 + Math.random() * 0.04})`;
      m.fillRect(Math.random() * S, Math.random() * S, 2, 2);
    }
    const BAYS = 8, bw = S / BAYS;
    for (let f = 0; f < FLOORS; f++) {
      m.fillStyle = 'rgba(0,0,0,.35)';
      m.fillRect(0, f * fh + fh - 4, S, 4);
      for (let b = 0; b < BAYS; b++) {
        const wx = b * bw + bw * 0.18, wy = f * fh + fh * 0.16;
        const ww = bw * 0.64, wh = fh * 0.6;
        m.fillStyle = 'rgba(10,12,16,.9)';
        m.fillRect(wx - 3, wy - 3, ww + 6, wh + 6);
        if (Math.random() < 0.4 - f * 0.025) {
          const bright = 55 + Math.random() * 28;
          const grad = m.createLinearGradient(0, wy, 0, wy + wh);
          grad.addColorStop(0, `hsl(${hue}, 66%, ${bright}%)`);
          grad.addColorStop(1, `hsl(${hue}, 60%, ${bright - 18}%)`);
          m.fillStyle = grad; m.fillRect(wx, wy, ww, wh);
          e.fillStyle = grad; e.fillRect(wx, wy, ww, wh);
          if (Math.random() < 0.35) {
            const bl = wh * (0.25 + Math.random() * 0.4);
            m.fillStyle = 'rgba(18,20,26,.92)'; m.fillRect(wx, wy, ww, bl);
            e.fillStyle = 'rgba(0,0,0,.92)'; e.fillRect(wx, wy, ww, bl);
          }
        } else {
          const grad = m.createLinearGradient(0, wy, 0, wy + wh);
          grad.addColorStop(0, '#182231');
          grad.addColorStop(1, '#0b111b');
          m.fillStyle = grad; m.fillRect(wx, wy, ww, wh);
          m.fillStyle = 'rgba(120,150,190,.09)';
          m.fillRect(wx, wy, ww, wh * 0.3);
          if (Math.random() < 0.25) {
            e.fillStyle = `hsla(${hue}, 50%, 30%, .3)`;
            e.fillRect(wx, wy + wh * 0.4, ww, wh * 0.6);
          }
        }
        m.fillStyle = 'rgba(0,0,0,.5)';
        m.fillRect(wx + ww / 2 - 1, wy, 2, wh);
      }
    }
  }
  return { mapCv, emiCv };
}
let FACADES = [];

const SHOP_NAMES = ['CAFE NOIR', 'CITY MARKET', '24H PIZZA', 'THE BARBER', 'GYM ONE', 'PHONE HUB', 'LUCKY DINER', 'NIGHT PHARMACY'];
function makeStorefrontCanvas() {
  const W = 1024, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#141821'; g.fillRect(0, 0, W, H);
  const names = [...SHOP_NAMES].sort(() => Math.random() - 0.5);
  for (let s = 0; s < 4; s++) {
    const x0 = s * 256;
    const neon = THEME.neon[Math.floor(Math.random() * THEME.neon.length)];
    const name = Math.random() < 0.35
      ? CITY.sponsors[Math.floor(Math.random() * CITY.sponsors.length)].name
      : names[s];
    g.fillStyle = '#0c0f15'; g.fillRect(x0 + 6, 8, 244, 30);
    g.strokeStyle = neon; g.lineWidth = 2; g.strokeRect(x0 + 8, 10, 240, 26);
    g.font = '700 19px Arial'; g.textAlign = 'center';
    g.shadowColor = neon; g.shadowBlur = 12;
    g.fillStyle = neon;
    g.fillText(name, x0 + 128, 30, 220);
    g.shadowBlur = 0;
    const grad = g.createLinearGradient(0, 46, 0, 118);
    grad.addColorStop(0, 'rgba(255,205,140,.75)');
    grad.addColorStop(1, 'rgba(120,90,50,.5)');
    g.fillStyle = grad;
    g.fillRect(x0 + 12, 46, 150, 72);
    g.fillStyle = 'rgba(40,30,20,.55)';
    for (let i = 0; i < 3; i++) g.fillRect(x0 + 22 + i * 46, 62, 34, 8 + Math.random() * 30);
    g.fillStyle = 'rgba(200,225,255,.16)';
    g.fillRect(x0 + 176, 46, 60, 72);
    g.strokeStyle = 'rgba(0,0,0,.6)'; g.strokeRect(x0 + 176, 46, 60, 72);
    g.fillStyle = '#1c212b'; g.fillRect(x0, 0, 8, H); g.fillRect(x0 + 248, 0, 8, H);
  }
  return cv;
}
let STOREFRONTS = [];

function makeNeonSignTexture(text, color) {
  const cv = document.createElement('canvas');
  cv.width = 96; cv.height = 512;
  const g = cv.getContext('2d');
  g.fillStyle = '#0a0c12'; g.fillRect(0, 0, 96, 512);
  g.strokeStyle = color; g.lineWidth = 4; g.strokeRect(6, 6, 84, 500);
  g.font = '800 44px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = color; g.shadowBlur = 16;
  g.fillStyle = color;
  const chars = text.replace(/ /g, '').split('').slice(0, 9);
  chars.forEach((c, i) => g.fillText(c, 48, 44 + i * (440 / Math.max(chars.length - 1, 1) * 0.95)));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeBillboardTexture(sponsor) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 256;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, sponsor.colorA);
  grad.addColorStop(1, sponsor.colorB);
  g.fillStyle = grad; g.fillRect(0, 0, 512, 256);
  g.strokeStyle = '#ffffff'; g.lineWidth = 10;
  g.strokeRect(8, 8, 496, 240);
  g.textAlign = 'center';
  g.fillStyle = '#ffffff';
  g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 12;
  g.font = '800 58px Arial';
  g.fillText(sponsor.name, 256, sponsor.logo ? 226 : 130, 470);
  if (!sponsor.logo) {
    g.font = '400 30px Arial';
    g.fillStyle = 'rgba(255,255,255,.85)';
    g.fillText(sponsor.tagline, 256, 180, 470);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (sponsor.logo) {
    const img = new Image();
    img.onload = () => {
      // big hero logo filling most of the board
      const s = Math.min(400 / img.width, 160 / img.height);
      g.drawImage(img, 256 - img.width * s / 2, 100 - img.height * s / 2, img.width * s, img.height * s);
      tex.needsUpdate = true;
    };
    img.src = sponsor.logo;
  }
  return tex;
}
let sponsorIdx = 0;
function addBillboard(x, y, z, rotY, width) {
  const sponsor = CITY.sponsors[sponsorIdx++ % CITY.sponsors.length];
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, width * 0.5),
    new THREE.MeshBasicMaterial({ map: makeBillboardTexture(sponsor) }));
  mesh.position.set(x, y, z);
  mesh.rotation.y = rotY;
  scene.add(mesh);
}

function texFromCanvas(cv, rx, ry) {
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(rx, ry);
  return tex;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------
const blinkers = [];
const mRoof = new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 1 });
const mRoofBox = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.9 });
const mMast = new THREE.MeshStandardMaterial({ color: 0x30343b, roughness: 0.6, metalness: 0.5 });

function facadeMat(fac, spanW, spanH, ei) {
  const rx = Math.max(1, Math.round(spanW / 20));
  const ry = Math.max(1, Math.round(spanH / 24));
  const m = new THREE.MeshStandardMaterial({
    map: texFromCanvas(fac.mapCv, rx, ry), roughness: 0.8,
    emissive: 0xffffff, emissiveMap: texFromCanvas(fac.emiCv, rx, ry), emissiveIntensity: ei,
  });
  EMI_MATS.push({ mat: m, base: ei });
  return m;
}
function towerSection(x, yBase, z, w, d, h, fac) {
  fac = fac || FACADES[Math.floor(Math.random() * FACADES.length)];
  const ei = 0.6 + Math.random() * 0.45;
  const mx = facadeMat(fac, d, h, ei); // x-facing walls span d metres
  const mz = facadeMat(fac, w, h, ei); // z-facing walls span w metres
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [mx, mx, mRoof, mRoof, mz, mz]);
  mesh.position.set(x, yBase + h / 2, z);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  return fac;
}

function addRoofClutter(x, yTop, z, w, d) {
  const lip = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.5, d + 0.3), mRoofBox);
  lip.position.set(x, yTop + 0.25, z);
  scene.add(lip);
  const n = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < n; i++) {
    const bw = 1 + Math.random() * 2, bh = 0.8 + Math.random() * 1.6;
    const box = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bw * 0.8), mRoofBox);
    box.position.set(x + (Math.random() - 0.5) * (w - bw - 1), yTop + bh / 2, z + (Math.random() - 0.5) * (d - bw - 1));
    scene.add(box);
  }
  if (Math.random() < 0.45) {
    const mh = 3 + Math.random() * 5;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, mh, 6), mMast);
    const mx = x + (Math.random() - 0.5) * w * 0.5, mz = z + (Math.random() - 0.5) * d * 0.5;
    mast.position.set(mx, yTop + mh / 2, mz);
    scene.add(mast);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xff2a2a }));
    beacon.position.set(mx, yTop + mh + 0.1, mz);
    scene.add(beacon);
    blinkers.push({ mesh: beacon, phase: Math.random() * 6 });
  }
}

// face = { ax: 'x'|'z', dir: -1|1 } — which wall fronts the street
const shadowSpots = [];
function addBuilding(x, z, w, d, h, face) {
  const SF_H = 4.2;
  const sfCv = STOREFRONTS[Math.floor(Math.random() * STOREFRONTS.length)];
  const sfM = (span) => {
    const m = new THREE.MeshStandardMaterial({
      map: texFromCanvas(sfCv, Math.max(1, Math.round(span / 13)), 1), roughness: 0.6,
      emissive: 0xffffff, emissiveMap: texFromCanvas(sfCv, Math.max(1, Math.round(span / 13)), 1),
      emissiveIntensity: 0.85,
    });
    EMI_MATS.push({ mat: m, base: 0.85 });
    return m;
  };
  const sfMatX = sfM(d), sfMatZ = sfM(w);
  const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, SF_H, d + 0.6),
    [sfMatX, sfMatX, mRoofBox, mRoofBox, sfMatZ, sfMatZ]);
  base.position.set(x, SF_H / 2, z);
  base.castShadow = base.receiveShadow = true;
  scene.add(base);

  let yBase = SF_H, remaining = h - SF_H;
  let cw = w, cd = d;
  const sections = remaining > 18 && Math.random() < 0.6 ? 2 : 1;
  let fac = null;
  for (let s = 0; s < sections; s++) {
    const sh = s === sections - 1 ? remaining : remaining * (0.55 + Math.random() * 0.15);
    fac = towerSection(x, yBase, z, cw, cd, sh, fac);
    yBase += sh; remaining -= sh;
    if (s < sections - 1) { cw *= 0.72 + Math.random() * 0.12; cd *= 0.72 + Math.random() * 0.12; }
  }
  addRoofClutter(x, yBase, z, cw, cd);
  shadowSpots.push({ x, z, sx: w + 4, sz: d + 4 });

  addCollider(new THREE.Box3().setFromCenterAndSize(
    new THREE.Vector3(x, h / 2, z), new THREE.Vector3(w + 0.6, h, d + 0.6)));

  if (!face) return;
  const along = face.ax === 'x' ? d : w;   // wall length
  const half = face.ax === 'x' ? w / 2 : d / 2;

  // shop awnings over the street-facing storefronts
  const nAwn = Math.floor(along / 7);
  for (let i = 0; i < nAwn; i++) {
    if (Math.random() < 0.35) continue;
    const col = new THREE.Color(THEME.neon[Math.floor(Math.random() * THEME.neon.length)]).multiplyScalar(0.5);
    const awn = new THREE.Mesh(new THREE.BoxGeometry(
      face.ax === 'x' ? 0.9 : 3.4, 0.14, face.ax === 'x' ? 3.4 : 0.9),
      new THREE.MeshStandardMaterial({ color: col, roughness: 0.85 }));
    const off = -along / 2 + 3.5 + i * 7 + (Math.random() - 0.5) * 1.2;
    awn.position.set(
      face.ax === 'x' ? x + face.dir * (half + 0.75) : x + off,
      2.9,
      face.ax === 'x' ? z + off : z + face.dir * (half + 0.75));
    awn.rotation[face.ax === 'x' ? 'z' : 'x'] = face.dir * (face.ax === 'x' ? 0.12 : -0.12);
    awn.castShadow = true;
    scene.add(awn);
  }
  const rotY = face.ax === 'x'
    ? (face.dir > 0 ? Math.PI / 2 : -Math.PI / 2)
    : (face.dir > 0 ? 0 : Math.PI);
  const wallAt = off => face.ax === 'x'
    ? [x + face.dir * (half + off), z]
    : [x, z + face.dir * (half + off)];

  if (h > 19 && Math.random() < 0.7) {
    const [bx, bz] = wallAt(0.14);
    addBillboard(bx, Math.min(h * 0.55, h - 4), bz, rotY, Math.min(along * 0.7, 9));
  }
  if (Math.random() < 0.4) {
    const text = Math.random() < 0.45
      ? CITY.sponsors[Math.floor(Math.random() * CITY.sponsors.length)].name
      : SHOP_NAMES[Math.floor(Math.random() * SHOP_NAMES.length)];
    const color = THEME.neon[Math.floor(Math.random() * THEME.neon.length)];
    const sh = Math.min(h * 0.45, 11);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(sh * 96 / 512, sh),
      new THREE.MeshBasicMaterial({ map: makeNeonSignTexture(text, color) }));
    const [sx2, sz2] = wallAt(0.55);
    const slide = (Math.random() - 0.5) * along * 0.5;
    sign.position.set(
      face.ax === 'x' ? sx2 : sx2 + slide,
      4.2 + sh / 2 + 1.5,
      face.ax === 'x' ? sz2 + slide : sz2);
    sign.rotation.y = rotY;
    scene.add(sign);
  }
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------
const vehicles = [];
const CAR_COLORS = [0x7a2f2f, 0x2f4a7a, 0x565b60, 0x6d6437, 0x3b4b41, 0x802a48, 0x1d5c66];
// per-type handling: top speed, acceleration, turn rate, camera seat height…
const VEH_STATS = {
  car:     { label: 'SEDAN',       maxF: 31, maxR: -9,  accel: 15, turn: 1.5, camH: 1.34, size: [2.0, 4.4], engine: true,  freq: 55, radius: 1.45, kill: 2.3 },
  suv:     { label: 'CRUISER 4X4', maxF: 28, maxR: -9,  accel: 13, turn: 1.35, camH: 1.62, size: [2.1, 4.6], engine: true, freq: 45, radius: 1.55, kill: 2.6 },
  sports:  { label: 'ROSSO GT',    maxF: 45, maxR: -10, accel: 24, turn: 1.7, camH: 1.12, size: [2.0, 4.3], engine: true,  freq: 75, radius: 1.4,  kill: 2.2 },
  hyper:   { label: 'TORO HYPER',  maxF: 50, maxR: -10, accel: 27, turn: 1.75, camH: 1.05, size: [2.0, 4.4], engine: true, freq: 88, radius: 1.4,  kill: 2.2 },
  luxury:  { label: 'LUX SEDAN',   maxF: 36, maxR: -9,  accel: 17, turn: 1.5, camH: 1.34, size: [2.0, 4.9], engine: true,  freq: 50, radius: 1.5,  kill: 2.4 },
  phantom: { label: 'PHANTOM LIMO', maxF: 34, maxR: -8, accel: 14, turn: 1.35, camH: 1.5,  size: [2.1, 5.2], engine: true,  freq: 42, radius: 1.55, kill: 2.5 },
  scooter: { label: 'SCOOTER',     maxF: 24, maxR: -5,  accel: 21, turn: 2.3, camH: 1.52, size: [0.8, 2.2], engine: true,  freq: 95, radius: 0.7,  kill: 1.4 },
  bicycle: { label: 'BICYCLE',     maxF: 13, maxR: -3,  accel: 9,  turn: 2.6, camH: 1.55, size: [0.7, 2.0], engine: false, freq: 0,  radius: 0.6,  kill: 1.2 },
};
const CAR_STYLE_COLORS = {
  car:    [0x7a2f2f, 0x2f4a7a, 0x565b60, 0x6d6437, 0x3b4b41, 0x802a48, 0x1d5c66],
  suv:    [0x8a7a5c, 0x4a4a42, 0x2e3438, 0x5c5348, 0x3d4a3a, 0xd8d4c8],
  sports: [0xc41e1e, 0xe0b41e, 0xd84a10, 0x14161a, 0xd8d8d8],
  hyper:  [0xf0a814, 0xf07800, 0x1a1c20, 0xb8bcc4, 0x38c04a],
  luxury: [0x0e1013, 0xe8e8ea, 0xb8bcc2, 0x1c2436, 0x2e2226],
  phantom: [0x101216, 0xe8d8c8, 0xdfe2e6, 0x24182a, 0x2a2018],
};
function carBox(pos, yaw, size = [2.0, 4.4]) {
  const along = Math.abs(Math.sin(yaw)) > 0.5;
  return new THREE.Box3().setFromCenterAndSize(
    new THREE.Vector3(pos.x, 0.8, pos.z),
    new THREE.Vector3(along ? size[1] : size[0], 1.6, along ? size[0] : size[1]));
}
// Four distinct real-world silhouettes: sedan, big 4x4 SUV,
// low sports GT, and a long luxury sedan.
function buildCarMesh(bodyColor, style = 'car') {
  const g = new THREE.Group();
  const mBody = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.25, metalness: 0.65 });
  const mDark = new THREE.MeshStandardMaterial({ color: 0x11151a, roughness: 0.6 });
  const mCab = new THREE.MeshStandardMaterial({ color: 0x0d141c, roughness: 0.08, metalness: 0.85 });
  const mChrome = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.15, metalness: 0.9 });
  const mHub = new THREE.MeshStandardMaterial({ color: 0x8a9099, roughness: 0.25, metalness: 0.85 });
  // rounded panels so bodies read as real sheet metal, not boxes
  const RB = (w, h, d, r) => new RoundedBoxGeometry(w, h, d, 3, r);

  const wheel = (wx, wz, r) => {
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.26, 16), mDark);
    tire.rotation.z = Math.PI / 2;
    tire.position.set(wx, r, wz);
    g.add(tire);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, 0.27, 12), mHub);
    hub.rotation.z = Math.PI / 2;
    hub.position.set(wx, r, wz);
    g.add(hub);
  };
  const lights = (frontZ, rearZ, y) => {
    const mGlow = new THREE.MeshBasicMaterial({ color: 0xfff2cc });
    const mTail = new THREE.MeshBasicMaterial({ color: 0xff3b30 });
    for (const hx of [-0.6, 0.6]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.1, 0.06), mGlow);
      hl.position.set(hx, y, frontZ); g.add(hl);
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.09, 0.06), mTail);
      tl.position.set(hx, y, rearZ); g.add(tl);
    }
  };
  const mGlass = new THREE.MeshStandardMaterial({ color: 0x10161f, roughness: 0.12, metalness: 0.6 });
  const glassPane = (w, h, y, z, tilt) => {
    const p = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.04), mGlass);
    p.position.set(0, y, z);
    p.rotation.x = tilt;
    g.add(p);
  };
  const mirrors = (wx, y, z) => {
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.08, 0.06), mDark);
      m.position.set(sx * wx, y, z); g.add(m);
    }
  };

  if (style === 'suv') {
    // tall boxy 4x4: high stance, roof rails, rear-mounted spare wheel
    const body = new THREE.Mesh(RB(2.0, 0.9, 4.6, 0.14), mBody);
    body.position.y = 0.85; g.add(body);
    const cab = new THREE.Mesh(RB(1.85, 0.62, 2.7, 0.12), mCab);
    cab.position.set(0, 1.6, -0.15); g.add(cab);
    for (const rx of [-0.7, 0.7]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 2.6), mChrome);
      rail.position.set(rx, 1.96, -0.15); g.add(rail);
    }
    const spare = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.24, 12), mDark);
    spare.rotation.x = Math.PI / 2;
    spare.position.set(0.5, 1.0, -2.42); g.add(spare);
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.24, 0.2), mChrome);
    bumper.position.set(0, 0.5, 2.35); g.add(bumper);
    glassPane(1.72, 0.62, 1.5, 1.32, -0.35);
    glassPane(1.72, 0.55, 1.5, -1.62, 0.4);
    mirrors(1.05, 1.42, 1.12);
    wheel(-1.0, 1.5, 0.44); wheel(1.0, 1.5, 0.44); wheel(-1.0, -1.5, 0.44); wheel(1.0, -1.5, 0.44);
    lights(2.31, -2.31, 0.95);
  } else if (style === 'sports') {
    // low wide GT: wedge nose, sleek cabin, rear wing
    const body = new THREE.Mesh(RB(1.95, 0.42, 4.2, 0.1), mBody);
    body.position.y = 0.42; g.add(body);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.26, 1.1), mBody);
    nose.position.set(0, 0.36, 2.05);
    nose.rotation.x = 0.1; g.add(nose);
    const cab = new THREE.Mesh(RB(1.5, 0.36, 1.7, 0.12), mCab);
    cab.position.set(0, 0.78, -0.35); g.add(cab);
    const intake = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 0.5), mDark);
    intake.position.set(0, 0.25, 2.0); g.add(intake);
    const wingPosts = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.16, 0.06), mDark);
    wingPosts.position.set(0, 0.7, -2.0); g.add(wingPosts);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.06, 0.34), mBody);
    wing.position.set(0, 0.82, -2.05); g.add(wing);
    glassPane(1.42, 0.42, 0.8, 0.6, -0.8);
    mirrors(0.88, 0.74, 0.5);
    wheel(-0.95, 1.35, 0.33); wheel(0.95, 1.35, 0.33); wheel(-0.95, -1.4, 0.33); wheel(0.95, -1.4, 0.33);
    lights(2.15, -2.12, 0.45);
  } else if (style === 'hyper') {
    // ultra-low angular hypercar: sharp wedge, side intakes, big fixed wing
    const body = new THREE.Mesh(RB(2.0, 0.36, 4.35, 0.09), mBody);
    body.position.y = 0.38; g.add(body);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.2, 1.3), mBody);
    nose.position.set(0, 0.34, 2.05);
    nose.rotation.x = 0.14; g.add(nose);
    const cab = new THREE.Mesh(RB(1.35, 0.3, 1.55, 0.1), mCab);
    cab.position.set(0, 0.7, -0.25); g.add(cab);
    for (const sx of [-1.02, 1.02]) {
      const intake = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.9), mDark);
      intake.position.set(sx, 0.45, -1.1); g.add(intake);
    }
    const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.14, 0.3), mDark);
    diffuser.position.set(0, 0.28, -2.15); g.add(diffuser);
    for (const wx of [-0.7, 0.7]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.24, 0.07), mDark);
      post.position.set(wx, 0.72, -2.0); g.add(post);
    }
    const wing = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.05, 0.42), mBody);
    wing.position.set(0, 0.88, -2.05); g.add(wing);
    glassPane(1.32, 0.38, 0.72, 0.58, -0.92);
    mirrors(0.9, 0.68, 0.42);
    wheel(-0.95, 1.35, 0.33); wheel(0.95, 1.35, 0.33); wheel(-0.95, -1.4, 0.34); wheel(0.95, -1.4, 0.34);
    lights(2.35, -2.16, 0.42);
  } else if (style === 'phantom') {
    // stately limousine: long tall body, upright chrome grille, hood strip
    const body = new THREE.Mesh(RB(2.0, 0.75, 5.2, 0.12), mBody);
    body.position.y = 0.72; g.add(body);
    const cab = new THREE.Mesh(RB(1.8, 0.56, 2.6, 0.12), mCab);
    cab.position.set(0, 1.36, -0.5); g.add(cab);
    const grille = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.5, 0.14), mChrome);
    grille.position.set(0, 0.8, 2.6); g.add(grille);
    const hoodStrip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 1.6), mChrome);
    hoodStrip.position.set(0, 1.11, 1.7); g.add(hoodStrip);
    for (const sx of [-1.01, 1.01]) {
      const trim = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, 4.8), mChrome);
      trim.position.set(sx, 0.95, -0.1); g.add(trim);
    }
    glassPane(1.72, 0.55, 1.5, 0.92, -0.42);
    glassPane(1.72, 0.5, 1.5, -1.88, 0.45);
    mirrors(1.05, 1.36, 0.88);
    wheel(-0.98, 1.7, 0.38); wheel(0.98, 1.7, 0.38); wheel(-0.98, -1.7, 0.38); wheel(0.98, -1.7, 0.38);
    lights(2.61, -2.61, 0.8);
  } else if (style === 'luxury') {
    // long executive sedan: stretched body, chrome side trim, wide grille bar
    const body = new THREE.Mesh(RB(1.95, 0.6, 4.9, 0.12), mBody);
    body.position.y = 0.56; g.add(body);
    const cab = new THREE.Mesh(RB(1.72, 0.5, 2.5, 0.12), mCab);
    cab.position.set(0, 1.08, -0.3); g.add(cab);
    for (const sx of [-0.99, 0.99]) {
      const trim = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 4.4), mChrome);
      trim.position.set(sx, 0.62, 0); g.add(trim);
    }
    const grille = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.3, 0.08), mChrome);
    grille.position.set(0, 0.55, 2.46); g.add(grille);
    glassPane(1.62, 0.52, 1.08, 0.98, -0.5);
    glassPane(1.62, 0.48, 1.08, -1.6, 0.55);
    mirrors(1.0, 0.98, 0.78);
    const hood = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.1, 1.2), mBody);
    hood.position.set(0, 0.9, 1.8); g.add(hood);
    wheel(-0.95, 1.6, 0.35); wheel(0.95, 1.6, 0.35); wheel(-0.95, -1.6, 0.35); wheel(0.95, -1.6, 0.35);
    lights(2.46, -2.46, 0.62);
  } else {
    // standard sedan
    const body = new THREE.Mesh(RB(1.9, 0.62, 4.4, 0.12), mBody);
    body.position.y = 0.55; g.add(body);
    const cab = new THREE.Mesh(RB(1.7, 0.55, 2.2, 0.12), mCab);
    cab.position.set(0, 1.1, -0.2); g.add(cab);
    glassPane(1.58, 0.52, 1.08, 0.92, -0.48);
    glassPane(1.58, 0.48, 1.08, -1.32, 0.52);
    mirrors(0.98, 0.98, 0.72);
    wheel(-0.95, 1.45, 0.34); wheel(0.95, 1.45, 0.34); wheel(-0.95, -1.45, 0.34); wheel(0.95, -1.45, 0.34);
    lights(2.21, -2.21, 0.62);
  }
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
  return g;
}
function randomCarStyle() {
  const r = Math.random();
  return r < 0.34 ? 'car' : r < 0.54 ? 'suv' : r < 0.72 ? 'luxury'
    : r < 0.84 ? 'sports' : r < 0.93 ? 'phantom' : 'hyper';
}
function carColorFor(style) {
  const pal = CAR_STYLE_COLORS[style] || CAR_STYLE_COLORS.car;
  return pal[Math.floor(Math.random() * pal.length)];
}
function registerVehicle(g, x, z, rotY, type) {
  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  scene.add(g);
  const stats = VEH_STATS[type];
  const veh = { group: g, yaw: rotY, speed: 0, type, stats, health: 100, smokeT: 0,
    box: addCollider(carBox(g.position, rotY, stats.size)) };
  vehicles.push(veh);
  return veh;
}
function addCar(x, z, rotY, style = 'car') {
  return registerVehicle(buildCarMesh(carColorFor(style), style), x, z, rotY, style);
}

// Delivery scooter with a sponsor-branded box on the back
function buildScooterMesh(boxColor) {
  const g = new THREE.Group();
  const mDark = new THREE.MeshStandardMaterial({ color: 0x14171b, roughness: 0.6 });
  const mBody = new THREE.MeshStandardMaterial({ color: 0xc8cdd4, roughness: 0.4, metalness: 0.5 });
  for (const wz of [0.72, -0.72]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.12, 12), mDark);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(0, 0.26, wz);
    g.add(wheel);
  }
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 1.15), mBody);
  deck.position.set(0, 0.38, -0.05); g.add(deck);
  const col = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.78, 0.08), mBody);
  col.position.set(0, 0.75, 0.62); col.rotation.x = -0.25; g.add(col);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.06, 0.06), mDark);
  bar.position.set(0, 1.12, 0.53); g.add(bar);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.1, 0.42), mDark);
  seat.position.set(0, 0.78, -0.3); g.add(seat);
  const crate = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.52, 0.5),
    new THREE.MeshStandardMaterial({ color: boxColor, roughness: 0.5 }));
  crate.position.set(0, 1.0, -0.78); g.add(crate);
  const hl = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.05), new THREE.MeshBasicMaterial({ color: 0xfff2cc }));
  hl.position.set(0, 0.95, 0.78); g.add(hl);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function buildBicycleMesh() {
  const g = new THREE.Group();
  const mDark = new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.6 });
  const mFrame = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(Math.random(), 0.5, 0.4), roughness: 0.4, metalness: 0.4 });
  for (const wz of [0.62, -0.62]) {
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.03, 6, 16), mDark);
    wheel.rotation.y = Math.PI / 2;
    wheel.position.set(0, 0.33, wz);
    g.add(wheel);
  }
  const tube1 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 1.0), mFrame);
  tube1.position.set(0, 0.62, 0); tube1.rotation.x = 0.12; g.add(tube1);
  const tube2 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.55, 0.05), mFrame);
  tube2.position.set(0, 0.62, 0.5); tube2.rotation.x = -0.3; g.add(tube2);
  const tube3 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.05), mFrame);
  tube3.position.set(0, 0.6, -0.35); g.add(tube3);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.26), mDark);
  seat.position.set(0, 0.92, -0.35); g.add(seat);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.05, 0.05), mDark);
  bar.position.set(0, 0.95, 0.58); g.add(bar);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// ---------------------------------------------------------------------------
// AI traffic — cars cruising the lanes, braking for the player
// ---------------------------------------------------------------------------
const traffic = [];
function spawnTraffic() {
  for (let i = 0; i < 12; i++) {
    const s = STREETS[Math.floor(Math.random() * STREETS.length)];
    const alongX = Math.random() < 0.5;
    const dir = Math.random() < 0.5 ? 1 : -1;
    const lane = 3.5 * dir; // right-hand side of travel direction
    const v = -120 + Math.random() * 240;
    const style = randomCarStyle();
    const g = buildCarMesh(carColorFor(style), style);
    scene.add(g);
    const car = { group: g, s, alongX, dir, lane, v, speed: 8 + Math.random() * 3 };
    placeTrafficCar(car);
    traffic.push(car);
  }
}
function placeTrafficCar(c) {
  if (c.alongX) {
    c.group.position.set(c.v, 0, c.s + c.lane);
    c.group.rotation.y = c.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  } else {
    c.group.position.set(c.s - c.lane, 0, c.v);
    c.group.rotation.y = c.dir > 0 ? 0 : Math.PI;
  }
}
function updateTraffic(dt) {
  for (const c of traffic) {
    // brake for the player (walking or driving) and for cars ahead in lane
    const px = c.alongX ? player.pos.x : player.pos.z;
    const cx = c.v;
    const aheadPlayer = (px - cx) * c.dir;
    const lateral = c.alongX
      ? Math.abs(player.pos.z - (c.s + c.lane))
      : Math.abs(player.pos.x - (c.s - c.lane));
    let target = c.speed;
    if (lateral < 3 && aheadPlayer > 0 && aheadPlayer < 9) target = 0;
    for (const o of traffic) {
      if (o === c || o.s !== c.s || o.alongX !== c.alongX || o.dir !== c.dir) continue;
      const gap = (o.v - c.v) * c.dir;
      if (gap > 0 && gap < 8) target = Math.min(target, Math.max(0, o.speed - 2));
    }
    c.cur = c.cur === undefined ? c.speed : c.cur;
    c.cur += (target - c.cur) * Math.min(1, dt * 3);
    c.v += c.cur * c.dir * dt;
    if (c.v > 128) c.v = -128;
    if (c.v < -128) c.v = 128;
    placeTrafficCar(c);
  }
}

// ---------------------------------------------------------------------------
// Characters — men and women built from boxes: used for the player's
// driver avatar, the menu preview, and every pedestrian on the street.
// ---------------------------------------------------------------------------
const SKINS = [0xd9b08c, 0xc59a76, 0xb08a67, 0x8a6248, 0x6b4a35];
const HAIRS = [0x1c1712, 0x3a2a18, 0x6b4a26, 0x9a7b46, 0x666666, 0x2a2a35];
// Rounded low-poly humans: capsule bodies, real heads with faces and hair,
// jointed limbs (shoulder/hip pivots) and per-person height variation.
function makeCharacter(cfg, opts = {}) {
  const g = new THREE.Group();
  const female = cfg.gender === 'f';
  const mSkinC = new THREE.MeshStandardMaterial({ color: cfg.skin, roughness: 0.75 });
  const shirt = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(cfg.shirtHue, 0.5, 0.32 + (cfg.shirtHue % 0.3)), roughness: 0.85 });
  const pants = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(cfg.pantsHue, 0.25, 0.16 + (cfg.pantsHue % 0.2)), roughness: 0.9 });
  const hairM = new THREE.MeshStandardMaterial({ color: cfg.hairColor, roughness: 0.95 });
  const mDarkC = new THREE.MeshStandardMaterial({ color: 0x181a1e, roughness: 0.8 });

  const uniformed = cfg.uniform !== undefined;
  if (uniformed) shirt.color.set(cfg.uniform);

  // torso + hips (capsules, squashed for shoulders)
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(female ? 0.14 : 0.16, 0.34, 4, 10), shirt);
  torso.scale.set(1.35, 1, 0.8);
  torso.position.y = 1.16; g.add(torso);
  const hips = new THREE.Mesh(new THREE.CapsuleGeometry(female ? 0.135 : 0.145, 0.08, 4, 10), pants);
  hips.scale.set(1.25, 1, 0.85);
  hips.position.y = 0.85; g.add(hips);

  if (uniformed) {
    const mStripe = new THREE.MeshStandardMaterial({
      color: 0xe8ecf0, roughness: 0.4, emissive: 0xaab4be, emissiveIntensity: 0.25 });
    for (const sy of [1.26, 1.06]) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.05, 0.3), mStripe);
      stripe.position.y = sy; g.add(stripe);
    }
    const mPack = new THREE.MeshStandardMaterial({
      color: new THREE.Color(cfg.uniform).multiplyScalar(1.15), roughness: 0.55 });
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.46, 0.24), mPack);
    pack.position.set(0, 1.18, -0.28); g.add(pack);
    const packBand = new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.09, 0.25),
      new THREE.MeshStandardMaterial({ color: 0xf0f2f4, roughness: 0.5 }));
    packBand.position.set(0, 1.35, -0.28); g.add(packBand);
  }

  if (opts.head !== false) {
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.09, 8), mSkinC);
    neck.position.y = 1.47; g.add(neck);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.135, 12, 10), mSkinC);
    head.scale.set(0.95, 1.12, 0.98);
    head.position.y = 1.63; g.add(head);
    // face: eyes
    for (const ex of [-0.05, 0.05]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.016, 6, 6), mDarkC);
      eye.position.set(ex, 1.65, 0.12); g.add(eye);
    }
    // hair: rounded cap hugging the skull (+ long back for long hair)
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.142, 12, 8), hairM);
    hair.scale.set(0.97, 0.85, 1.0);
    hair.position.y = 1.68; g.add(hair);
    if (cfg.hairLong) {
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.36, 0.08), hairM);
      back.position.set(0, 1.5, -0.14); g.add(back);
    }
    if (uniformed) {
      const mCap = new THREE.MeshStandardMaterial({ color: cfg.uniform, roughness: 0.7 });
      const ucap = new THREE.Mesh(new THREE.SphereGeometry(0.148, 12, 8), mCap);
      ucap.scale.set(1, 0.68, 1);
      ucap.position.y = 1.7; g.add(ucap);
      const brim = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.025, 0.13), mCap);
      brim.position.set(0, 1.7, 0.19); g.add(brim);
    }
  }

  // legs: hip pivots so the walk cycle bends at the joint
  const legs = [];
  const legMat = cfg.skirt ? mSkinC : pants;
  const legLen = cfg.skirt ? 0.34 : 0.42;
  if (cfg.skirt) {
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 0.3, 10), pants);
    skirt.position.y = 0.68; g.add(skirt);
  }
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.1, 0.82, 0);
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.062, legLen, 4, 8), legMat);
    leg.position.y = -(legLen / 2 + 0.12);
    pivot.add(leg);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.2), mDarkC);
    foot.position.set(0, -(legLen + 0.22), 0.04);
    pivot.add(foot);
    g.add(pivot); legs.push(pivot);
  }

  // arms: shoulder pivots with skin hands
  const arms = [];
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * (female ? 0.235 : 0.27), 1.36, 0);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.3, 4, 8), shirt);
    arm.position.y = -0.2;
    pivot.add(arm);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), mSkinC);
    hand.position.y = -0.42;
    pivot.add(hand);
    g.add(pivot); arms.push(pivot);
  }

  g.scale.setScalar(cfg.height || 1);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return { group: g, legs, arms };
}
function randomLook() {
  const f = Math.random() < 0.45;
  return {
    gender: f ? 'f' : 'm',
    skin: SKINS[Math.floor(Math.random() * SKINS.length)],
    shirtHue: Math.random(),
    pantsHue: Math.random(),
    hairColor: HAIRS[Math.floor(Math.random() * HAIRS.length)],
    hairLong: f ? Math.random() < 0.75 : Math.random() < 0.1,
    skirt: f && Math.random() < 0.5,
    height: (f ? 0.92 : 0.97) + Math.random() * 0.12,
  };
}

// ---------------------------------------------------------------------------
// Pedestrians — real men and women walking the sidewalks, fleeing gunfire
// ---------------------------------------------------------------------------
const peds = [];
let lastShot = { x: 0, z: 0, t: -99 };
function makeCivilian() {
  return makeCharacter(randomLook());
}
function spawnPed(nearPlayer) {
  const s = STREETS[Math.floor(Math.random() * STREETS.length)];
  const alongX = Math.random() < 0.5;
  const dir = Math.random() < 0.5 ? 1 : -1;
  const side = (Math.random() < 0.5 ? 1 : -1) * (ROAD_HALF + 1.6 + Math.random() * 1.6);
  let v = -126 + Math.random() * 252;
  if (nearPlayer) {
    const base = alongX ? player.pos.x : player.pos.z;
    v = Math.max(-126, Math.min(126, base + (Math.random() - 0.5) * 120));
  }
  const rig = makeCivilian();
  scene.add(rig.group);
  const p = { rig, s, alongX, dir, side, v, speed: 1.1 + Math.random() * 0.8, walkPhase: Math.random() * 6, fleeT: 0 };
  placePed(p);
  peds.push(p);
}
function placePed(p) {
  if (p.alongX) {
    p.rig.group.position.set(p.v, 0, p.s + p.side);
    p.rig.group.rotation.y = p.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  } else {
    p.rig.group.position.set(p.s + p.side, 0, p.v);
    p.rig.group.rotation.y = p.dir > 0 ? 0 : Math.PI;
  }
}
function spawnPeds() {
  const n = Math.round(26 + 10 * (1 - NF)); // busier by day
  for (let i = 0; i < n; i++) spawnPed(false);
}
function updatePeds(dt) {
  for (const p of peds) {
    // panic when shots land nearby
    const gp = p.rig.group.position;
    if (game.time - lastShot.t < 0.3 && Math.hypot(gp.x - lastShot.x, gp.z - lastShot.z) < 25) {
      p.fleeT = 5 + Math.random() * 3;
      const away = (p.alongX ? gp.x - lastShot.x : gp.z - lastShot.z) >= 0 ? 1 : -1;
      p.dir = away;
    }
    const fleeing = p.fleeT > 0;
    if (fleeing) p.fleeT -= dt;
    const sp = fleeing ? 4.6 : p.speed;
    p.v += sp * p.dir * dt;
    if (p.v > 128 || p.v < -128) { p.dir *= -1; p.v = Math.max(-128, Math.min(128, p.v)); }
    placePed(p);
    p.walkPhase += dt * (fleeing ? 13 : 6.5);
    const sw = Math.sin(p.walkPhase) * (fleeing ? 0.7 : 0.4);
    p.rig.legs[0].rotation.x = sw;
    p.rig.legs[1].rotation.x = -sw;
    p.rig.arms[0].rotation.x = fleeing ? -2.6 : -sw * 0.6;
    p.rig.arms[1].rotation.x = fleeing ? -2.6 : sw * 0.6;
    // recycle pedestrians that drift too far from the player
    if (Math.hypot(gp.x - player.pos.x, gp.z - player.pos.z) > 150) {
      scene.remove(p.rig.group);
      peds.splice(peds.indexOf(p), 1);
      spawnPed(true);
    }
  }
}

// ---------------------------------------------------------------------------
// buildCity — called once, after the player picks a city
// ---------------------------------------------------------------------------
function buildCity(city) {
  CITY = city;
  THEME = THEMES[city.id] || THEMES.neon;

  // blend the theme's night palette against a daytime palette by real clock
  NF = nightFactorAt(localHour());
  const day = DAY[city.id] || DAY.neon;
  const skyCol = new THREE.Color(day.sky).lerp(new THREE.Color(THEME.sky), NF);
  scene.background = null;
  scene.fog = new THREE.FogExp2(skyCol, THEME.fog * (day.fogMul + (1 - day.fogMul) * NF));
  paintSky();
  hemi.color.set(new THREE.Color(0xcfe0f0).lerp(new THREE.Color(THEME.hemi[0]), NF));
  hemi.groundColor.set(new THREE.Color(0x8a8478).lerp(new THREE.Color(THEME.hemi[1]), NF));
  hemi.intensity = 2.1 + (THEME.hemi[2] - 2.1) * NF;
  moon.color.set(new THREE.Color(0xfff1d2).lerp(new THREE.Color(THEME.moonColor), NF));
  MOON_BASE = 2.8 - (2.8 - 1.6) * NF;
  moon.intensity = MOON_BASE;
  renderer.toneMappingExposure = 1.25 - (1 - NF) * 0.15;
  if (starsObj) starsObj.visible = NF > 0.45;
  if (moonSprite) moonSprite.visible = NF > 0.45;

  FACADES = [];
  for (let i = 0; i < 9; i++) {
    const hue = THEME.windowHues[i % THEME.windowHues.length];
    const r = Math.random();
    const style = r < THEME.styles.curtain ? 'curtain'
      : r < THEME.styles.curtain + THEME.styles.brick ? 'brick' : 'punched';
    FACADES.push(makeFacadeCanvases(THEME.wall, hue, style));
  }
  STOREFRONTS = [0, 1, 2, 3, 4, 5].map(makeStorefrontCanvas);

  // ---- ground: whole road network painted into one texture ----
  {
    const T = 4096, sc = T / (CITY_HALF * 2);
    const cv = document.createElement('canvas');
    cv.width = cv.height = T;
    const g = cv.getContext('2d');
    const W = v => (v + CITY_HALF) * sc;

    // sidewalk concrete with paving-slab joints and grime
    g.fillStyle = '#3d4046'; g.fillRect(0, 0, T, T);
    g.strokeStyle = 'rgba(0,0,0,.22)'; g.lineWidth = 1.5;
    for (let v = -CITY_HALF; v <= CITY_HALF; v += 2) {
      g.beginPath(); g.moveTo(W(v), 0); g.lineTo(W(v), T); g.stroke();
      g.beginPath(); g.moveTo(0, W(v)); g.lineTo(T, W(v)); g.stroke();
    }
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(0,0,0,${0.04 + Math.random() * 0.08})`;
      const r = (0.5 + Math.random() * 2.5) * sc;
      g.beginPath();
      g.ellipse(Math.random() * T, Math.random() * T, r, r * (0.4 + Math.random() * 0.6), Math.random() * 3, 0, Math.PI * 2);
      g.fill();
    }

    // asphalt streets
    g.fillStyle = '#25282d';
    for (const s of STREETS) {
      g.fillRect(W(s - ROAD_HALF), 0, ROAD_HALF * 2 * sc, T);
      g.fillRect(0, W(s - ROAD_HALF), T, ROAD_HALF * 2 * sc);
    }
    // darker tire tracks along each lane
    g.fillStyle = 'rgba(0,0,0,.16)';
    for (const s of STREETS) for (const lane of [-ROAD_HALF / 2, ROAD_HALF / 2])
      for (const off of [-0.85, 0.85]) {
        g.fillRect(W(s + lane + off) - 0.35 * sc, 0, 0.7 * sc, T);
        g.fillRect(0, W(s + lane + off) - 0.35 * sc, T, 0.7 * sc);
      }
    // curbs (bright edge + shadow)
    for (const s of STREETS) for (const e of [-ROAD_HALF, ROAD_HALF]) {
      g.fillStyle = 'rgba(255,255,255,.16)';
      g.fillRect(W(s + e) - 2, 0, 4, T);
      g.fillRect(0, W(s + e) - 2, T, 4);
      g.fillStyle = 'rgba(0,0,0,.3)';
      g.fillRect(W(s + e) + (e > 0 ? -6 : 2), 0, 4, T);
      g.fillRect(0, W(s + e) + (e > 0 ? -6 : 2), T, 4);
    }
    // lane dashes (skip intersections)
    g.fillStyle = '#c9c5aa';
    const inIntersection = v => STREETS.some(s => Math.abs(v - s) < ROAD_HALF + 4);
    for (const s of STREETS)
      for (let v = -CITY_HALF + 4; v < CITY_HALF - 4; v += 7) {
        if (inIntersection(v)) continue;
        g.fillRect(W(s) - 0.16 * sc, W(v), 0.32 * sc, 3.2 * sc);
        g.fillRect(W(v), W(s) - 0.16 * sc, 3.2 * sc, 0.32 * sc);
      }
    // crosswalks
    g.fillStyle = 'rgba(225,225,218,.7)';
    for (const sx of STREETS) for (const sz of STREETS)
      for (const side of [-1, 1]) {
        for (let k = -ROAD_HALF + 1.2; k < ROAD_HALF - 0.8; k += 1.5) {
          g.fillRect(W(sx + k), W(sz + side * (ROAD_HALF + 1.1)) - 0.75 * sc, 0.8 * sc, 1.5 * sc);
          g.fillRect(W(sx + side * (ROAD_HALF + 1.1)) - 0.75 * sc, W(sz + k), 1.5 * sc, 0.8 * sc);
        }
      }
    // manholes + oil stains on the roads
    for (let i = 0; i < 70; i++) {
      const s = STREETS[Math.floor(Math.random() * STREETS.length)];
      const v = -CITY_HALF + 8 + Math.random() * (CITY_HALF * 2 - 16);
      const onX = Math.random() < 0.5;
      const px = onX ? W(s + (Math.random() - 0.5) * 8) : W(v);
      const pz = onX ? W(v) : W(s + (Math.random() - 0.5) * 8);
      if (Math.random() < 0.5) {
        g.fillStyle = '#1b1d21';
        g.beginPath(); g.arc(px, pz, 0.55 * sc, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 2;
        g.beginPath(); g.arc(px, pz, 0.55 * sc, 0, Math.PI * 2); g.stroke();
      } else {
        g.fillStyle = `rgba(8,8,12,${0.15 + Math.random() * 0.2})`;
        g.beginPath();
        g.ellipse(px, pz, (0.8 + Math.random() * 2) * sc, (0.5 + Math.random() * 1.2) * sc, Math.random() * 3, 0, Math.PI * 2);
        g.fill();
      }
    }
    const groundTex = new THREE.CanvasTexture(cv);
    groundTex.colorSpace = THREE.SRGBColorSpace;
    groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(CITY_HALF * 2, CITY_HALF * 2),
      new THREE.MeshStandardMaterial({ map: groundTex,
        roughness: THEME.rain > 0 ? 0.35 : 0.75, metalness: THEME.rain > 0 ? 0.15 : 0.05 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
  }

  // ---- buildings: fill every block with 2x2 lots ----
  for (let ix = 0; ix < STREETS.length - 1; ix++)
    for (let iz = 0; iz < STREETS.length - 1; iz++) {
      const x0 = STREETS[ix] + ROAD_HALF + 3.5, x1 = STREETS[ix + 1] - ROAD_HALF - 3.5;
      const z0 = STREETS[iz] + ROAD_HALF + 3.5, z1 = STREETS[iz + 1] - ROAD_HALF - 3.5;
      const lotW = (x1 - x0) / 2, lotD = (z1 - z0) / 2;
      for (const qx of [0, 1]) for (const qz of [0, 1]) {
        if (Math.random() < 0.12) continue; // empty lot
        const w = lotW * (0.62 + Math.random() * 0.28);
        const d = lotD * (0.62 + Math.random() * 0.28);
        const cx = x0 + lotW * qx + lotW / 2 + (Math.random() - 0.5) * 2;
        const cz = z0 + lotD * qz + lotD / 2 + (Math.random() - 0.5) * 2;
        const centerBoost = 1 + Math.max(0, 1 - Math.hypot(cx, cz) / 240) * 0.7;
        const h = (THEME.hMin + Math.random() * (THEME.hMax - THEME.hMin)) * centerBoost;
        const face = Math.random() < 0.5
          ? { ax: 'x', dir: qx === 0 ? -1 : 1 }
          : { ax: 'z', dir: qz === 0 ? -1 : 1 };
        addBuilding(cx, cz, w, d, h, face);
      }
    }

  // ---- perimeter ring so the city feels endless ----
  for (let p = -120; p <= 120; p += 48) {
    const h = 30 + Math.random() * 22;
    addBuilding(p, -(CITY_HALF - 8), 34, 15, h, { ax: 'z', dir: 1 });
    addBuilding(p, CITY_HALF - 8, 34, 15, h, { ax: 'z', dir: -1 });
    addBuilding(-(CITY_HALF - 8), p, 15, 34, h, { ax: 'x', dir: 1 });
    addBuilding(CITY_HALF - 8, p, 15, 34, h, { ax: 'x', dir: -1 });
  }

  // ---- street lamps (real point lights only near the spawn avenue) ----
  {
    const mPole = new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.7, metalness: 0.6 });
    const bulbMat = new THREE.MeshBasicMaterial({ color: THEME.lamp });
    let lightBudget = 10;
    for (const sx of STREETS) for (const sz of STREETS)
      for (const [ox, oz] of [[1, 1], [-1, -1]]) {
        const lx = sx + ox * (ROAD_HALF + 1.2), lz = sz + oz * (ROAD_HALF + 1.2);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 5.6, 6), mPole);
        pole.position.set(lx, 2.8, lz);
        scene.add(pole);
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), bulbMat);
        bulb.position.set(lx, 5.65, lz);
        scene.add(bulb);
        if (NF > 0.2) {
          const halo = new THREE.Sprite(new THREE.SpriteMaterial({
            map: glowTexShared, color: THEME.lamp, transparent: true,
            opacity: 0.3 * NF, blending: THREE.AdditiveBlending, depthWrite: false }));
          halo.scale.setScalar(2.8);
          halo.position.set(lx, 5.6, lz);
          scene.add(halo);
        }
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(2.1, 5.2, 12, 1, true),
          new THREE.MeshBasicMaterial({ color: THEME.lamp, transparent: true, opacity: 0.05,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        cone.position.set(lx, 3.0, lz);
        scene.add(cone);
        if (lightBudget > 0 && Math.hypot(lx - 4, lz - 26) < 95) {
          const light = new THREE.PointLight(THEME.lamp, 20, 24, 2);
          light.position.set(lx, 5.4, lz);
          scene.add(light);
          lampLights.push(light);
          lightBudget--;
        }
      }
  }

  // ---- parked cars along curbs (all drivable, mixed real-world designs) ----
  for (const s of STREETS)
    for (let v = -110; v <= 110; v += 24) {
      if (STREETS.some(t => Math.abs(v - t) < 13)) continue;
      if (Math.random() < 0.4)
        addCar(s + (Math.random() < 0.5 ? ROAD_HALF - 1.9 : -(ROAD_HALF - 1.9)), v + Math.random() * 6, Math.random() < 0.1 ? 0.06 : 0, randomCarStyle());
      if (Math.random() < 0.4)
        addCar(v + Math.random() * 6, s + (Math.random() < 0.5 ? ROAD_HALF - 1.9 : -(ROAD_HALF - 1.9)), Math.PI / 2, randomCarStyle());
    }

  // ---- delivery scooters + bicycles parked on the sidewalks ----
  {
    let nScooter = 0, nBike = 0;
    const boxCol = new THREE.Color(CITY.sponsors[0].colorA);
    for (const s of STREETS)
      for (let v = -116; v <= 116; v += 18) {
        if (STREETS.some(t => Math.abs(v - t) < 11)) continue;
        const side = Math.random() < 0.5 ? 1 : -1;
        const r = Math.random();
        if (r < 0.17 && nScooter < 18) {
          nScooter++;
          registerVehicle(buildScooterMesh(boxCol),
            s + side * (ROAD_HALF + 1.0), v + Math.random() * 5, Math.random() * 6.28, 'scooter');
        } else if (r < 0.3 && nBike < 12) {
          nBike++;
          registerVehicle(buildBicycleMesh(),
            v + Math.random() * 5, s + side * (ROAD_HALF + 1.0), Math.random() * 6.28, 'bicycle');
        }
      }
  }

  // ---- cover props + sponsor ad stands near the spawn area ----
  {
    const mConc = new THREE.MeshStandardMaterial({ color: 0x6f7276, roughness: 0.95 });
    const mCrate = new THREE.MeshStandardMaterial({ color: 0x5b4a2e, roughness: 0.9 });
    for (let i = 0; i < 14; i++) {
      const p = streetPoint();
      if (Math.random() < 0.5) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.05, 0.65), mConc);
        b.position.set(p.x, 0.52, p.z);
        b.castShadow = true;
        scene.add(b);
        addCollider(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(p.x, 0.52, p.z), new THREE.Vector3(2.1, 1.05, 0.65)));
      } else {
        const s = 0.9 + Math.random() * 0.5;
        const c = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), mCrate);
        c.position.set(p.x, s / 2, p.z);
        c.rotation.y = Math.random();
        c.castShadow = true;
        scene.add(c);
        addCollider(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(p.x, s / 2, p.z), new THREE.Vector3(s + 0.2, s, s + 0.2)));
      }
    }
    const mStand = new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.5, metalness: 0.6 });
    for (let i = 0; i < 10; i++) {
      const s = STREETS[Math.floor(Math.random() * STREETS.length)];
      const v = -100 + Math.random() * 200;
      if (STREETS.some(t => Math.abs(v - t) < 11)) continue;
      const side = Math.random() < 0.5 ? 1 : -1;
      const alongX = Math.random() < 0.5;
      const x = alongX ? v : s + side * (ROAD_HALF + 1.3);
      const z = alongX ? s + side * (ROAD_HALF + 1.3) : v;
      addBillboard(x, 1.7, z, alongX ? (side > 0 ? Math.PI : 0) : (side > 0 ? -Math.PI / 2 : Math.PI / 2), 3.2);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.1, 0.4), mStand);
      post.position.set(x, 0.55, z);
      scene.add(post);
      addCollider(new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(x, 1.4, z), new THREE.Vector3(alongX ? 3.2 : 0.4, 2.8, alongX ? 0.4 : 3.2)));
    }
  }

  // ---- street trees (instanced: 2 draw calls total) ----
  {
    const t = THEME.tree;
    const spots = [];
    for (const s of STREETS)
      for (let v = -126; v <= 126; v += t.every) {
        if (STREETS.some(q => Math.abs(v - q) < ROAD_HALF + 4)) continue;
        for (const side of [-1, 1]) {
          if (Math.random() < t.chance)
            spots.push([s + side * (ROAD_HALF + 2.6), v + (Math.random() - 0.5) * 4]);
          if (Math.random() < t.chance)
            spots.push([v + (Math.random() - 0.5) * 4, s + side * (ROAD_HALF + 2.6)]);
        }
      }
    if (spots.length) {
      const trunks = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.09, 0.16, 2.6, 6),
        new THREE.MeshStandardMaterial({ color: 0x3a2c1c, roughness: 0.95 }), spots.length);
      const cans = new THREE.InstancedMesh(
        new THREE.SphereGeometry(1, 8, 6),
        new THREE.MeshStandardMaterial({ color: t.color, roughness: 0.95 }), spots.length);
      const m4 = new THREE.Matrix4();
      spots.forEach(([x, z], i) => {
        m4.makeTranslation(x, 1.3, z);
        trunks.setMatrixAt(i, m4);
        const s = 1.2 + Math.random() * 0.9;
        m4.makeScale(s * 1.25, s, s * 1.25).setPosition(x, 2.9 + s * 0.4, z);
        cans.setMatrixAt(i, m4);
        shadowSpots.push({ x, z, sx: 3.2, sz: 3.2 });
        addCollider(new THREE.Box3().setFromCenterAndSize(
          new THREE.Vector3(x, 1.4, z), new THREE.Vector3(0.5, 2.8, 0.5)));
      });
      trunks.castShadow = cans.castShadow = true;
      scene.add(trunks);
      scene.add(cans);
    }
  }

  // ---- traffic lights on the central avenues ----
  {
    const mPoleT = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.6, metalness: 0.5 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.7 });
    for (const sx of STREETS) for (const sz of STREETS) {
      if (sx !== 0 && sz !== 0) continue;
      for (const [ox, oz] of [[1, -1], [-1, 1]]) {
        const px = sx + ox * (ROAD_HALF + 0.9), pz = sz + oz * (ROAD_HALF + 0.9);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 4.8, 6), mPoleT);
        pole.position.set(px, 2.4, pz);
        scene.add(pole);
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.78, 0.28), headMat);
        head.position.set(px, 4.6, pz);
        scene.add(head);
        const go = Math.random() < 0.5;
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 8),
          new THREE.MeshBasicMaterial({ color: go ? 0x35e06a : 0xff3b30 }));
        lamp.position.set(px, go ? 4.34 : 4.86, pz);
        scene.add(lamp);
      }
    }
  }

  // ---- soft contact shadows grounding buildings and trees (1 draw call) ----
  {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 10, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,0,0,.5)');
    grad.addColorStop(0.7, 'rgba(0,0,0,.28)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    const inst = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false }),
      shadowSpots.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const p = new THREE.Vector3(), sv = new THREE.Vector3();
    shadowSpots.forEach((sp, i) => {
      m4.compose(p.set(sp.x, 0.02, sp.z), q, sv.set(sp.sx, sp.sz, 1));
      inst.setMatrixAt(i, m4);
    });
    inst.renderOrder = 1;
    scene.add(inst);
  }

  // rain amount per theme
  rainPts.visible = THEME.rain > 0;
  rainPts.geometry.setDrawRange(0, THEME.rain);

  // day/night dimming: window glow and street lamps fade out in daylight
  const glow = 0.12 + 0.88 * NF;
  for (const e of EMI_MATS) e.mat.emissiveIntensity = e.base * glow;
  for (const l of lampLights) l.intensity = 20 * NF;

  buildClub();
  spawnTraffic();
  spawnPeds();
  for (let i = 0; i < 10; i++) spawnCanPickup();
}

// ---------------------------------------------------------------------------
// The nightclub — glowing marquee, sweeping light beams, a dancing queue,
// and dance music that swells as you approach (see updateMusic)
// ---------------------------------------------------------------------------
const clubBeams = [];
const clubbers = [];
let clubLight = null;
function buildClub() {
  const z = clubPos.z;
  // POWER GYM marquee facing the street
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 192;
  const g2 = cv.getContext('2d');
  g2.fillStyle = '#0c0a08'; g2.fillRect(0, 0, 1024, 192);
  g2.strokeStyle = '#ffb02a'; g2.lineWidth = 8; g2.strokeRect(10, 10, 1004, 172);
  g2.font = '900 96px Arial'; g2.textAlign = 'center';
  g2.shadowColor = '#ffb02a'; g2.shadowBlur = 30;
  g2.fillStyle = '#ffd479';
  g2.fillText('🏋 POWER GYM', 512, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(8, 1.5),
    new THREE.MeshBasicMaterial({ map: tex }));
  sign.position.set(11.2, 5.2, z);
  sign.rotation.y = -Math.PI / 2;
  scene.add(sign);

  // warm entrance spotlights
  for (const [dz, col] of [[-2.2, 0xffb02a], [2.2, 0xffd479]]) {
    const beam = new THREE.Mesh(
      new THREE.ConeGeometry(1.0, 8, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.08,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.set(10.6, 4, z + dz);
    scene.add(beam);
    clubBeams.push({ mesh: beam, phase: dz });
  }
  clubLight = new THREE.PointLight(0xffb02a, 7, 22, 2);
  clubLight.position.set(9.8, 3.5, z);
  scene.add(clubLight);

  // outdoor barbells
  const mIron = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.4, metalness: 0.7 });
  for (const bz of [z - 6, z + 6]) {
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.7, 8), mIron);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(9.6, 0.5, bz);
    scene.add(bar);
    for (const px of [-0.7, 0.7]) {
      const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.1, 14), mIron);
      plate.rotation.z = Math.PI / 2;
      plate.position.set(9.6 + px, 0.5, bz);
      scene.add(plate);
    }
    addCollider(new THREE.Box3().setFromCenterAndSize(
      new THREE.Vector3(9.6, 0.5, bz), new THREE.Vector3(1.8, 1, 0.6)));
  }

  // people training outside — jumping jacks and squats to the music
  for (let i = 0; i < 5; i++) {
    const c = makeCivilian();
    c.group.position.set(9.4 + Math.random() * 1.4, 0, z - 4.5 + i * 2.1 + Math.random());
    c.group.rotation.y = Math.PI / 2 + (Math.random() - 0.5) * 0.6;
    scene.add(c.group);
    clubbers.push({ rig: c, phase: Math.random() * 6, jack: i % 2 === 0 });
  }
}
function updateClub(dt) {
  if (!clubLight) return;
  const beat = game.time * (126 / 60) * Math.PI * 2;
  clubLight.intensity = (5 + 3 * Math.max(0, Math.sin(beat))) * (0.35 + 0.65 * NF);
  for (const b of clubBeams) {
    b.mesh.rotation.z = Math.sin(game.time * 0.8 + b.phase) * 0.2;
  }
  for (const c of clubbers) {
    const cyc = Math.abs(Math.sin(beat / 2 + c.phase));
    if (c.jack) {
      // jumping jacks: hop + arms swinging overhead
      c.rig.group.position.y = cyc * 0.14;
      c.rig.arms[0].rotation.z = 0.3 + cyc * 2.4;
      c.rig.arms[1].rotation.z = -0.3 - cyc * 2.4;
    } else {
      // squats: dip with arms held forward (scale.x holds the height factor)
      c.rig.group.scale.y = c.rig.group.scale.x * (1 - cyc * 0.12);
      c.rig.arms[0].rotation.x = c.rig.arms[1].rotation.x = -1.4;
      c.rig.legs[0].rotation.x = cyc * 0.5;
      c.rig.legs[1].rotation.x = cyc * 0.5;
    }
  }
}

// random point on some road
function streetPoint() {
  const s = STREETS[Math.floor(Math.random() * STREETS.length)];
  const v = -BOUND + Math.random() * BOUND * 2;
  return Math.random() < 0.5
    ? new THREE.Vector3(s + (Math.random() - 0.5) * 9, 0, v)
    : new THREE.Vector3(v, 0, s + (Math.random() - 0.5) * 9);
}
function streetPointNear(center, rMin, rMax) {
  for (let i = 0; i < 30; i++) {
    const p = streetPoint();
    const d = Math.hypot(p.x - center.x, p.z - center.z);
    if (d > rMin && d < rMax) return p;
  }
  return new THREE.Vector3(
    Math.max(-BOUND, Math.min(BOUND, center.x + 45)), 0, center.z);
}

// ---------------------------------------------------------------------------
// Rain + thunder
// ---------------------------------------------------------------------------
const RAIN_N = 1400;
let rainPts, rainSpeeds;
{
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(RAIN_N * 3);
  rainSpeeds = new Float32Array(RAIN_N);
  for (let i = 0; i < RAIN_N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 60;
    pos[i * 3 + 1] = Math.random() * 42;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 120;
    rainSpeeds[i] = 34 + Math.random() * 22;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  rainPts = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0x9aa8c0, size: 0.07, transparent: true, opacity: 0.5 }));
  rainPts.visible = false;
  scene.add(rainPts);
}
let thunderIn = 9 + Math.random() * 12, thunderT = 0;
function updateAtmosphere(dt) {
  if (THEME && THEME.rain > 0) {
    const p = rainPts.geometry.attributes.position.array;
    const n = THEME.rain;
    for (let i = 0; i < n; i++) {
      p[i * 3 + 1] -= rainSpeeds[i] * dt;
      p[i * 3] += 3.5 * dt;
      if (p[i * 3 + 1] < 0) {
        p[i * 3 + 1] = 42;
        p[i * 3] = camera.position.x + (Math.random() - 0.5) * 60;
        p[i * 3 + 2] = camera.position.z + (Math.random() - 0.5) * 120;
      }
    }
    rainPts.geometry.attributes.position.needsUpdate = true;
  }

  for (const b of blinkers) b.mesh.visible = ((game.time * 1.4 + b.phase) % 2) < 1.5;

  if (THEME && THEME.thunder) {
    thunderIn -= dt;
    if (thunderIn <= 0) {
      thunderIn = 16 + Math.random() * 22;
      thunderT = 0.55;
      playThunder();
    }
    if (thunderT > 0) {
      thunderT -= dt;
      moon.intensity = MOON_BASE + (Math.random() < 0.5 ? 5.5 : 1.5) * thunderT;
    } else moon.intensity = MOON_BASE;
  }

  // keep the moving shadow window centred on the player
  moon.position.set(camera.position.x - 40, 70, camera.position.z - 30);
  moon.target.position.set(camera.position.x, 0, camera.position.z);
}

// ---------------------------------------------------------------------------
// Player state + controls
// ---------------------------------------------------------------------------
const player = {
  pos: new THREE.Vector3(4, 0, 26),
  vel: new THREE.Vector3(),
  yaw: 0,
  pitch: 0,
  health: 100,
  lastHurt: -99,
  onGround: true,
  dead: false,
};
const EYE = 1.66, RADIUS = 0.38;

const keys = {};
document.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'KeyR' && !driving) startReload();
  if (e.code === 'KeyE') toggleDrive();
  if (e.code === 'Digit1') switchWeapon(0);
  if (e.code === 'Digit2') switchWeapon(1);
  if (e.code === 'Digit3') switchWeapon(2);
  if (e.code === 'KeyQ' && locked) drinkEnergy();
  if (e.code === 'KeyC' && driving) camMode = camMode === 'chase' ? 'hood' : 'chase';
  if (e.code === 'KeyM' && locked) {
    musicOn = !musicOn;
    addFeed(musicOn ? '♪ Music on' : '♪ Music off');
  }
});
document.addEventListener('keyup', e => { keys[e.code] = false; });

let firing = false, aiming = false;
document.addEventListener('mousedown', e => {
  if (!locked) return;
  if (cine.active) { if (cine.t > 0.5) finishCinematic(); return; }
  if (driving) return;
  if (e.button === 0) { firing = true; pendingShot = true; }
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
menuEl.addEventListener('click', () => {
  audioInit();
  if (!CITY) buildCity(selectedCity());
  requestLock();
});
pausedEl.addEventListener('click', requestLock);
gameoverEl.addEventListener('click', () => location.reload());

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (locked) {
    menuEl.style.display = 'none';
    pausedEl.style.display = 'none';
    if (!started) { started = true; startCinematic(); }
    else if (!cine.active) hudEl.style.display = 'block';
    if (AC && AC.state === 'suspended') AC.resume();
  } else if (started && !player.dead) {
    pausedEl.style.display = 'flex';
    firing = false; aiming = false;
    for (const k in keys) keys[k] = false;
  }
});

function resolveCollisions(pos, height, radius = RADIUS) {
  let hit = false;
  for (const box of colliders) {
    if (pos.y + height < box.min.y || pos.y > box.max.y) continue;
    const nx = Math.max(box.min.x, Math.min(pos.x, box.max.x));
    const nz = Math.max(box.min.z, Math.min(pos.z, box.max.z));
    const dx = pos.x - nx, dz = pos.z - nz;
    const d2 = dx * dx + dz * dz;
    if (d2 < radius * radius) {
      hit = true;
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        pos.x = nx + (dx / d) * radius;
        pos.z = nz + (dz / d) * radius;
      } else {
        const px = Math.min(pos.x - box.min.x + radius, box.max.x - pos.x + radius);
        const pz = Math.min(pos.z - box.min.z + radius, box.max.z - pos.z + radius);
        if (px < pz) pos.x = (pos.x - box.min.x < box.max.x - pos.x) ? box.min.x - radius : box.max.x + radius;
        else pos.z = (pos.z - box.min.z < box.max.z - pos.z) ? box.min.z - radius : box.max.z + radius;
      }
    }
  }
  pos.x = Math.max(-BOUND, Math.min(BOUND, pos.x));
  pos.z = Math.max(-BOUND, Math.min(BOUND, pos.z));
  return hit;
}

// ---------------------------------------------------------------------------
// Weapon view model
// ---------------------------------------------------------------------------
const gun = new THREE.Group();
{
  const mMetal = new THREE.MeshStandardMaterial({ color: 0x2a2e34, roughness: 0.35, metalness: 0.75 });
  const mDark = new THREE.MeshStandardMaterial({ color: 0x17191d, roughness: 0.5, metalness: 0.6 });
  const mPoly = new THREE.MeshStandardMaterial({ color: 0x24221e, roughness: 0.8 });
  const mHand = new THREE.MeshStandardMaterial({ color: 0xb08a67, roughness: 0.8 });
  const part = (geo, mat, x, y, z, rx = 0) => {
    const p = new THREE.Mesh(geo, mat);
    p.position.set(x, y, z);
    p.rotation.x = rx;
    gun.add(p);
    return p;
  };
  // receiver + dust cover
  part(new THREE.BoxGeometry(0.06, 0.08, 0.3), mMetal, 0, 0, 0);
  part(new THREE.BoxGeometry(0.05, 0.025, 0.28), mDark, 0, 0.05, 0);
  // handguard with rail slots
  part(new THREE.BoxGeometry(0.054, 0.06, 0.26), mPoly, 0, -0.002, -0.27);
  for (let i = 0; i < 3; i++)
    part(new THREE.BoxGeometry(0.058, 0.012, 0.05), mDark, 0, -0.02, -0.19 - i * 0.08);
  // barrel + muzzle brake
  const barrel = part(new THREE.CylinderGeometry(0.013, 0.013, 0.18, 10), mDark, 0, 0.012, -0.48, Math.PI / 2);
  part(new THREE.BoxGeometry(0.03, 0.032, 0.06), mMetal, 0, 0.012, -0.56);
  // curved magazine (two angled segments)
  part(new THREE.BoxGeometry(0.046, 0.1, 0.07), mDark, 0, -0.085, -0.015, 0.22);
  part(new THREE.BoxGeometry(0.044, 0.08, 0.065), mDark, 0, -0.155, 0.008, 0.45);
  // pistol grip + trigger guard
  part(new THREE.BoxGeometry(0.042, 0.11, 0.06), mPoly, 0, -0.08, 0.09, -0.35);
  part(new THREE.BoxGeometry(0.036, 0.008, 0.07), mDark, 0, -0.05, 0.035);
  // stock: buffer tube + butt with riser
  part(new THREE.CylinderGeometry(0.02, 0.02, 0.14, 8), mDark, 0, 0.005, 0.21, Math.PI / 2);
  part(new THREE.BoxGeometry(0.05, 0.1, 0.06), mPoly, 0, -0.01, 0.3);
  part(new THREE.BoxGeometry(0.04, 0.03, 0.09), mPoly, 0, 0.045, 0.27);
  // sights
  part(new THREE.BoxGeometry(0.018, 0.035, 0.03), mMetal, 0, 0.075, 0.06);
  part(new THREE.BoxGeometry(0.014, 0.03, 0.02), mMetal, 0, 0.075, -0.36);
  // hands: rear on the grip, lead under the handguard
  part(new THREE.BoxGeometry(0.055, 0.06, 0.07), mHand, 0.008, -0.075, 0.1);
  part(new THREE.BoxGeometry(0.06, 0.05, 0.09), mHand, -0.004, -0.045, -0.28);
}
const HIP_POS = new THREE.Vector3(0.24, -0.2, -0.48);
const ADS_POS = new THREE.Vector3(0, -0.115, -0.34);
gun.position.copy(HIP_POS);
camera.add(gun);
scene.add(camera);

const muzzleFlash = new THREE.Mesh(
  new THREE.PlaneGeometry(0.16, 0.16),
  new THREE.MeshBasicMaterial({ color: 0xffd080, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
muzzleFlash.position.set(0, 0.012, -0.62);
gun.add(muzzleFlash);
const muzzleLight = new THREE.PointLight(0xffb060, 0, 8, 2);
muzzleLight.position.set(0, 0, -0.6);
gun.add(muzzleLight);

// ---------------------------------------------------------------------------
// Weapon logic + effects
// ---------------------------------------------------------------------------
const WEAPONS = [
  { name: 'MK-4 ASSAULT RIFLE', magSize: 30, mag: 30, reserve: 120, damage: 30, interval: 0.1,  auto: true,  spread: 0.018, adsSpread: 0.004, freq: 950,  vol: 0.45, reload: 1.9, scale: 1 },
  { name: 'P9 SIDEARM',         magSize: 12, mag: 12, reserve: 72,  damage: 24, interval: 0.15, auto: false, spread: 0.012, adsSpread: 0.005, freq: 1350, vol: 0.34, reload: 1.2, scale: 0.62 },
  { name: 'VIPER SMG',          magSize: 36, mag: 36, reserve: 144, damage: 17, interval: 0.065, auto: true, spread: 0.032, adsSpread: 0.012, freq: 1150, vol: 0.4,  reload: 1.6, scale: 0.8 },
];
let curW = 0, pendingShot = false;
function W() { return WEAPONS[curW]; }
const weapon = { cooldown: 0, reloading: 0, recoil: 0 }; // transient state
const wnameEl = document.getElementById('wname');
function switchWeapon(i) {
  if (i === curW || i >= WEAPONS.length || player.dead || driving) return;
  if (prog.level < WEAPON_UNLOCK[i]) {
    addFeed(`🔒 ${WEAPONS[i].name} unlocks at level ${WEAPON_UNLOCK[i]}`);
    playClick(320, 0.15);
    return;
  }
  curW = i;
  weapon.reloading = 0;
  weapon.cooldown = 0.35;
  document.getElementById('reloadmsg').style.display = 'none';
  gun.scale.setScalar(W().scale);
  if (wnameEl) wnameEl.textContent = W().name;
  playClick(1000, 0.16);
}

function startReload() {
  const w = W();
  if (weapon.reloading > 0 || w.mag === w.magSize || w.reserve <= 0 || player.dead) return;
  weapon.reloading = w.reload;
  playClick(900, 0.2);
  document.getElementById('reloadmsg').style.display = 'block';
}

const effects = [];
const tracerMat = new THREE.LineBasicMaterial({ color: 0xffe6a8, transparent: true, opacity: 0.9 });
function spawnTracer(from, to) {
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const line = new THREE.Line(geo, tracerMat.clone());
  scene.add(line);
  effects.push({ obj: line, life: 0.07, fade: m => m.obj.material.opacity = 0.9 * (m.life / 0.07) });
}
const smokeTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  grad.addColorStop(0, 'rgba(190,190,200,.7)');
  grad.addColorStop(1, 'rgba(190,190,200,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
})();
function spawnSmoke(at) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: smokeTex, transparent: true, opacity: 0.28, depthWrite: false }));
  s.position.copy(at);
  s.scale.setScalar(0.14);
  scene.add(s);
  effects.push({ obj: s, life: 0.55, fade: (m, dt) => {
    m.obj.material.opacity = 0.28 * (m.life / 0.55);
    m.obj.scale.addScalar(dt * 0.9);
    m.obj.position.y += dt * 0.35;
  } });
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
      if (!e.obj.isSprite) e.obj.geometry?.dispose?.();
      e.obj.material?.dispose?.();
      effects.splice(i, 1);
    } else e.fade(e, dt);
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
  const w = W();
  w.mag--;
  weapon.cooldown = w.interval;
  weapon.recoil = Math.min(weapon.recoil + 1, 5);
  playShot(w.vol, w.freq);
  lastShot = { x: player.pos.x, z: player.pos.z, t: game.time };
  muzzleFlash.material.opacity = 1;
  muzzleFlash.rotation.z = Math.random() * Math.PI;
  muzzleLight.intensity = 14;

  camera.getWorldDirection(_dir);
  const spread = aiming ? w.adsSpread : w.spread;
  _dir.x += (Math.random() - 0.5) * spread;
  _dir.y += (Math.random() - 0.5) * spread;
  _dir.z += (Math.random() - 0.5) * spread;
  _dir.normalize();
  _origin.copy(camera.position);

  const maxDist = 220;
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
  if (Math.random() < 0.4) spawnSmoke(muzzleWorld);
  shake = Math.min(shake + 0.05, 0.22);

  if (hitEnemy) {
    const dmg = headshot ? w.damage * 2 : w.damage;
    damageEnemy(hitEnemy, dmg);
    showHitmarker(hitEnemy.dead);
  }
}

// ---------------------------------------------------------------------------
// Enemies
// ---------------------------------------------------------------------------
const enemies = [];
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
    health: 100 + Math.min(prog.level * 2, 120),
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
    addXP(8);
    progressMission('kill', 1);
    if (enemies.every(e => e.dead)) {
      slowmo = 1.1;
      if (mode === 'waves') addXP(20);
    }
  }
}

const _toPlayer = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _enEye = new THREE.Vector3();
function updateEnemy(en, dt) {
  if (en.dead) {
    en.deathT += dt;
    en.rig.group.rotation.x = Math.min(en.deathT * 4, Math.PI / 2);
    en.rig.group.position.y = -Math.max(0, en.deathT - 1.6) * 0.6;
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

  en.rig.group.rotation.y = Math.atan2(_toPlayer.x, _toPlayer.z);

  const los = dist < 70 && hasLineOfSight(_enEye, _eye);

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

  if (moving) {
    en.walkPhase += dt * 9;
    const sw = Math.sin(en.walkPhase) * 0.5;
    en.rig.legs[0].rotation.x = sw;
    en.rig.legs[1].rotation.x = -sw;
    en.rig.arms[0].rotation.x = -sw * 0.5;
    en.rig.arms[1].rotation.x = sw * 0.5;
  }

  en.fireCooldown -= dt;
  if (!player.dead && los && dist < 55 && en.fireCooldown <= 0) {
    en.fireCooldown = 0.55 + Math.random() * 0.9;
    const muzzle = _enEye.clone();
    let hitChance = Math.max(0.12, 0.55 - dist * 0.007);
    if (keys['ShiftLeft'] || keys['ShiftRight']) hitChance *= 0.72;
    if (driving && Math.abs(driving.speed) > 8) hitChance *= 0.5;
    playShot(Math.max(0.08, 0.4 - dist * 0.005), 700);
    lastShot = { x: en.pos.x, z: en.pos.z, t: game.time };
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

  en.bodyBox.setFromCenterAndSize(new THREE.Vector3(en.pos.x, en.pos.y + 0.75, en.pos.z), new THREE.Vector3(0.62, 1.5, 0.45));
  en.headBox.setFromCenterAndSize(new THREE.Vector3(en.pos.x, en.pos.y + 1.65, en.pos.z), new THREE.Vector3(0.34, 0.4, 0.34));
}

// ---------------------------------------------------------------------------
// Driving
// ---------------------------------------------------------------------------
let driving = null;
let camMode = 'chase'; // 'chase' | 'hood' while driving (C to toggle)
const drivehintEl = document.getElementById('drivehint');
const speedoEl = document.getElementById('speedo');

function nearestVehicle(maxD) {
  let best = null, bd = maxD;
  for (const v of vehicles) {
    const d = Math.hypot(v.group.position.x - player.pos.x, v.group.position.z - player.pos.z);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}
function toggleDrive() {
  if (player.dead || cine.active || !locked) return;
  if (driving) {
    const v = driving;
    driving = null;
    gun.visible = true;
    const right = new THREE.Vector3(Math.cos(v.yaw), 0, -Math.sin(v.yaw));
    player.pos.copy(v.group.position).addScaledVector(right, 2.4);
    player.pos.y = 0;
    resolveCollisions(player.pos, 1.75);
    v.box = addCollider(carBox(v.group.position, v.yaw, v.stats.size));
    if (v.light) { v.group.remove(v.light); v.group.remove(v.light.target); v.light = null; }
    if (v.rider) { v.group.remove(v.rider.group); v.rider = null; }
    engineStop();
    speedoEl.style.display = 'none';
  } else {
    const v = nearestVehicle(3.8);
    if (!v) return;
    const need = VEH_UNLOCK[v.type];
    if (need && prog.level < need) {
      addFeed(`🔒 ${v.stats.label} unlocks at level ${need} — keep delivering!`);
      playClick(320, 0.15);
      return;
    }
    if (v.health <= 0) {
      addFeed('🚗 That vehicle is wrecked');
      return;
    }
    driving = v;
    gun.visible = false;
    firing = false; aiming = false;
    const i = colliders.indexOf(v.box);
    if (i >= 0) colliders.splice(i, 1);
    if (v.type !== 'bicycle' && NF > 0.15) {
      v.light = new THREE.SpotLight(0xffedc0, 80, 60, 0.5, 0.45, 1.2);
      v.light.position.set(0, 1.2, 1.8);
      v.light.target.position.set(0, 0.2, 14);
      v.group.add(v.light);
      v.group.add(v.light.target);
    }
    if (VEH_STATS[v.type] === undefined || v.type === 'scooter' || v.type === 'bicycle') {
      v.rider = makeRider();
      v.group.add(v.rider.group);
    }
    player.yaw = v.yaw;          // chase cam starts behind the vehicle
    if (v.stats.engine) engineStart();
    speedoEl.style.display = 'block';
    playClick(700, 0.2);
  }
}
function updateDriving(dt) {
  const v = driving;
  const st = v.stats;
  const fwd = new THREE.Vector3(Math.sin(v.yaw), 0, Math.cos(v.yaw));
  const boost = energy.boostT > 0 ? 1.25 : 1;
  const wrecked = v.health <= 0;
  const accel = wrecked ? 0 : keys['KeyW'] ? st.accel * boost : keys['KeyS'] ? -st.accel * 0.65 : 0;
  v.speed += accel * dt;
  v.speed -= v.speed * 0.55 * dt;
  // real brakes on Space
  if (keys['Space']) v.speed -= Math.sign(v.speed) * Math.min(Math.abs(v.speed), 26 * dt);
  v.speed = Math.max(st.maxR, Math.min(st.maxF * boost, v.speed));
  const steer = (keys['KeyA'] ? 1 : 0) - (keys['KeyD'] ? 1 : 0);
  v.yaw += steer * Math.min(Math.abs(v.speed) / 6, 1) * st.turn * dt * Math.sign(v.speed || 1);
  v.group.rotation.y = v.yaw;
  // scooters and bikes lean into turns
  if (v.type !== 'car') v.group.rotation.z = -steer * Math.min(Math.abs(v.speed) / st.maxF, 1) * 0.25;
  v.group.position.addScaledVector(fwd, v.speed * dt);
  const preSpeed = v.speed;
  if (resolveCollisions(v.group.position, 1.5, st.radius)) {
    const impact = Math.abs(preSpeed);
    if (impact > 6) {
      // crash: damage, sparks, crunch, shake
      v.health = Math.max(0, v.health - (impact - 5) * 3.2);
      playCrash(Math.min(1, impact / 30));
      const nose = v.group.position.clone().addScaledVector(fwd, Math.sign(preSpeed) * st.size[1] / 2);
      nose.y = 0.7;
      spawnImpact(nose);
      spawnSmoke(nose);
      shake = Math.min(shake + 0.15 + impact * 0.015, 0.9);
      if (v.health <= 0 && !v.wrecked) {
        v.wrecked = true;
        engineStop();
        addFeed('🚗 Vehicle wrecked — press E and find another ride');
        showBanner('VEHICLE WRECKED');
      }
    } else if (impact > 2) playClick(260, 0.2);
    v.speed *= -0.25;
  }
  // damaged engine smokes
  if (v.health < 45) {
    v.smokeT -= dt;
    if (v.smokeT <= 0) {
      v.smokeT = v.health <= 0 ? 0.08 : 0.18;
      const hood = v.group.position.clone().addScaledVector(fwd, st.size[1] * 0.35);
      hood.y = 1.0;
      spawnSmoke(hood);
    }
  }

  if (Math.abs(v.speed) > 4)
    for (const en of enemies) {
      if (en.dead) continue;
      if (Math.hypot(en.pos.x - v.group.position.x, en.pos.z - v.group.position.z) < st.kill) {
        damageEnemy(en, 999);
        showHitmarker(true);
        v.speed *= 0.85;
        shake = Math.min(shake + 0.25, 0.6);
      }
    }

  player.pos.set(v.group.position.x, 0, v.group.position.z);
  if (camMode === 'hood') {
    camera.position.set(
      v.group.position.x + fwd.x * 0.1,
      st.camH,
      v.group.position.z + fwd.z * 0.1);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(
      player.pitch + (Math.random() - 0.5) * shake * 0.05,
      player.yaw,
      (Math.random() - 0.5) * shake * 0.05);
  } else {
    // third-person chase camera: behind the car, mouse orbits, walls pull it in
    const dist = 6.2 + st.size[1] * 0.4;
    const orbit = new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw));
    const from = v.group.position.clone().setY(1.5);
    const want = from.clone().addScaledVector(orbit, -dist);
    want.y = Math.min(6, Math.max(1.6, 2.8 - player.pitch * 4));
    const toCam = want.clone().sub(from);
    const L = toCam.length();
    toCam.normalize();
    const hd = worldHitDistance(from, toCam, L);
    if (hd < L) want.copy(from).addScaledVector(toCam, Math.max(hd - 0.5, 1.6));
    camera.position.lerp(want, Math.min(1, dt * 7));
    camera.rotation.order = 'YXZ';
    camera.lookAt(v.group.position.x, v.group.position.y + 1.2, v.group.position.z);
    camera.rotation.x += (Math.random() - 0.5) * shake * 0.04;
    camera.rotation.z += (Math.random() - 0.5) * shake * 0.04;
  }
  if (st.engine) {
    if (engineNodes) engineNodes.osc.frequency.value = st.freq + Math.abs(v.speed) * 5.5;
  }
  speedoEl.textContent = st.label + ' · ' + Math.round(Math.abs(v.speed) * 3.6) + ' KM/H'
    + (v.health <= 0 ? ' · 💥 WRECKED' : v.health < 60 ? ` · ⚠ ${Math.round(v.health)}%` : '');

  const targetFov = BASE_FOV + Math.min(Math.abs(v.speed) * 0.5, 14);
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 6);
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------------------
// Player damage / death
// ---------------------------------------------------------------------------
const vignetteEl = document.getElementById('vignette');
function hurtPlayer(dmg) {
  if (player.dead) return;
  player.health -= dmg;
  player.lastHurt = game.time;
  shake = Math.min(shake + 0.45, 0.8);
  playHurt();
  if (player.health <= 0) {
    player.health = 0;
    playerDie();
  }
}
function playerDie() {
  player.dead = true;
  firing = false;
  slowmo = 1.6;
  shake = 0.9;
  game.streak = 0;
  // personal records
  prog.best = prog.best || {};
  let newRec = false;
  for (const [k, v] of [['deliveries', game.deliveries], ['cash', game.money], ['wave', game.wave], ['kills', game.kills]]) {
    if (v > (prog.best[k] || 0)) { prog.best[k] = v; newRec = true; }
  }
  saveProg();
  if (newRec) setTimeout(() => showBanner('🏆 NEW PERSONAL RECORD'), 300);
  if (driving) { engineStop(); speedoEl.style.display = 'none'; driving = null; gun.visible = true; }
  canvas.style.filter = 'grayscale(0.85) brightness(0.75)';
  document.querySelector('#gameover .stats').innerHTML = `<b>${playerName()}</b><br>` + (mode === 'delivery'
    ? `Deliveries completed: <b>${game.deliveries}</b><br>Cash earned: <b>$${game.money}</b><br>Eliminations: <b>${game.kills}</b>`
    : `Waves survived: <b>${game.wave}</b><br>Eliminations: <b>${game.kills}</b>`)
    + `<br>Driver level: <b>${prog.level} / 100</b>`
    + `<br><span style="font-size:14px;color:#9fb2c4">Records — deliveries ${prog.best.deliveries || 0} · cash $${prog.best.cash || 0} · wave ${prog.best.wave || 0}</span>`;
  saveProg();
  document.exitPointerLock();
  pausedEl.style.display = 'none';
  setTimeout(() => { gameoverEl.style.display = 'flex'; }, 1400);
}

// ---------------------------------------------------------------------------
// Waves + HUD
// ---------------------------------------------------------------------------
const game = { wave: 0, kills: 0, money: 0, deliveries: 0, streak: 0, time: 0, intermission: 0 };

// ---------------------------------------------------------------------------
// Driver progression — 100 levels, persistent across sessions
// ---------------------------------------------------------------------------
const prog = (() => {
  try { return Object.assign({ level: 1, xp: 0, bank: 0 }, JSON.parse(localStorage.getItem('streetops.prog'))); }
  catch { return { level: 1, xp: 0, bank: 0 }; }
})();
function xpNeed(l) { return 40 + l * 12; }
function saveProg() { localStorage.setItem('streetops.prog', JSON.stringify(prog)); }
function addXP(n) {
  if (prog.level >= 100) { saveProg(); return; }
  prog.xp += Math.round(n);
  while (prog.level < 100 && prog.xp >= xpNeed(prog.level)) {
    prog.xp -= xpNeed(prog.level);
    prog.level++;
    showBanner(`LEVEL ${prog.level}`);
    addFeed(`⭐ Level up — ${prog.level} / 100`);
    const unlock = UNLOCK_LADDER.find(u => u.level === prog.level);
    if (unlock) {
      showBanner(`UNLOCKED: ${unlock.what}`);
      addFeed(`🔓 ${unlock.what} unlocked!`);
    }
    playClick(2600, 0.3);
  }
  saveProg();
}

// ---------------------------------------------------------------------------
// Retention loop: unlock ladder, daily missions, streaks, VIP orders, records
// ---------------------------------------------------------------------------
const WEAPON_UNLOCK = [1, 3, 6];
const VEH_UNLOCK = { sports: 8, phantom: 10, hyper: 12 };
const UNLOCK_LADDER = [
  { level: 3, what: 'P9 SIDEARM' },
  { level: 6, what: 'VIPER SMG' },
  { level: 8, what: 'ROSSO GT' },
  { level: 10, what: 'PHANTOM LIMO' },
  { level: 12, what: 'TORO HYPER' },
];
function nextUnlock() {
  return UNLOCK_LADDER.find(u => u.level > prog.level);
}

const MISSION_DEFS = [
  { id: 'del5', txt: 'Complete 5 deliveries', n: 5, ev: 'delivery', reward: 60 },
  { id: 'earn150', txt: 'Earn $150 in fares', n: 150, ev: 'cash', reward: 50 },
  { id: 'rob6', txt: 'Stop 6 robbers', n: 6, ev: 'kill', reward: 55 },
  { id: 'dist2k', txt: 'Travel 2,000 m', n: 2000, ev: 'dist', reward: 40 },
  { id: 'boost3', txt: 'Drink 3 Red Bulls', n: 3, ev: 'drink', reward: 35 },
  { id: 'vip2', txt: 'Complete 2 VIP orders', n: 2, ev: 'vip', reward: 70 },
];
const missions = (() => {
  const day = new Date().toISOString().slice(0, 10);
  let m = null;
  try { m = JSON.parse(localStorage.getItem('streetops.missions')); } catch {}
  if (!m || m.day !== day) {
    // deterministic daily rotation of 3 missions
    let h = 0;
    for (const ch of day) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const picks = [];
    while (picks.length < 3) {
      const id = MISSION_DEFS[(h = (h * 1103515245 + 12345) >>> 0) % MISSION_DEFS.length].id;
      if (!picks.includes(id)) picks.push(id);
    }
    m = { day, picks, prog: {}, done: {} };
  }
  return m;
})();
function saveMissions() { localStorage.setItem('streetops.missions', JSON.stringify(missions)); }
function progressMission(ev, amt) {
  for (const id of missions.picks) {
    const def = MISSION_DEFS.find(d => d.id === id);
    if (!def || def.ev !== ev || missions.done[id]) continue;
    missions.prog[id] = (missions.prog[id] || 0) + amt;
    if (missions.prog[id] >= def.n) {
      missions.done[id] = true;
      game.money += def.reward;
      prog.bank += def.reward;
      addXP(def.reward * 0.6);
      showBanner(`MISSION COMPLETE +$${def.reward}`);
      addFeed(`✅ ${def.txt} — +$${def.reward}`);
      playClick(2200, 0.3);
    }
  }
  saveMissions();
  renderMissions();
}
function renderMissions() {
  const el = document.getElementById('missions');
  if (!el) return;
  let html = '<div class="mtitle">DAILY MISSIONS</div>';
  for (const id of missions.picks) {
    const def = MISSION_DEFS.find(d => d.id === id);
    if (!def) continue;
    const p = Math.min(missions.prog[id] || 0, def.n);
    html += `<div class="mrow${missions.done[id] ? ' done' : ''}">` +
      `${missions.done[id] ? '✅' : '☐'} ${def.txt} <b>${missions.done[id] ? `+$${def.reward}` : Math.floor(p) + '/' + def.n}</b></div>`;
  }
  el.innerHTML = html;
}
let distAcc = 0, lastDistPos = null;
function trackDistance() {
  if (!lastDistPos) lastDistPos = player.pos.clone();
  const d = Math.hypot(player.pos.x - lastDistPos.x, player.pos.z - lastDistPos.z);
  if (d > 0.05 && d < 30) distAcc += d;
  lastDistPos.copy(player.pos);
  if (distAcc > 25) { progressMission('dist', distAcc); distAcc = 0; }
}
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
  for (const w of WEAPONS) w.reserve = Math.max(w.reserve, w.magSize * 4);
  const count = Math.min(3 + game.wave * 2 + Math.floor(prog.level / 10), 16);
  for (let i = 0; i < count; i++) {
    const p = streetPointNear(player.pos, 30, 85);
    spawnEnemy(p.x + (Math.random() - 0.5) * 3, p.z + (Math.random() - 0.5) * 3);
  }
  showBanner(`Wave ${game.wave}`);
  addFeed(`Wave ${game.wave} — ${count} hostiles inbound`);
}

// ---------------------------------------------------------------------------
// Red Bull energy boost — pick up cans around the city, press Q to drink,
// move fast for a few seconds ("gives you wings")
// ---------------------------------------------------------------------------
const energy = { cans: 1, boostT: 0, drinkT: 0 };
const BOOST_DUR = 8;
const canPickups = [];
// real Red Bull label from ads/ (uploaded logo), graceful if missing
const redbullTex = new THREE.TextureLoader().load('ads/redbull.png',
  t => { t.colorSpace = THREE.SRGBColorSpace; });
// optional real bottle photo — upload ads/redbull_bottle.png and pickups
// switch from the 3D can to the actual bottle image
let bottleTex = null;
new THREE.TextureLoader().load('ads/redbull_bottle.png', t => {
  t.colorSpace = THREE.SRGBColorSpace;
  bottleTex = t;
  for (const c of canPickups) applyBottleSprite(c.mesh);
}, undefined, () => {});
function applyBottleSprite(g) {
  if (!bottleTex || g.userData.bottled) return;
  g.userData.bottled = true;
  for (const ch of g.children)
    if (!(ch.geometry && ch.geometry.type === 'RingGeometry')) ch.visible = false;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: bottleTex, transparent: true }));
  spr.scale.set(0.55, 0.8, 1);
  g.add(spr);
}
function canLabel(w, h, z) {
  const label = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: redbullTex, transparent: true }));
  label.position.z = z;
  return label;
}
function makeCanMesh() {
  const g = new THREE.Group();
  const silver = new THREE.MeshStandardMaterial({ color: 0xd2d6dc, roughness: 0.2, metalness: 0.9 });
  const blue = new THREE.MeshStandardMaterial({ color: 0x1c4fd0, roughness: 0.35, metalness: 0.4 });
  const red = new THREE.MeshBasicMaterial({ color: 0xe01b30 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.34, 12), silver);
  g.add(body);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.102, 0.102, 0.13, 12), blue);
  g.add(band);
  const dot = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.02), red);
  dot.position.set(0, 0, 0.1);
  g.add(dot);
  g.add(canLabel(0.17, 0.13, 0.105));           // real logo, front
  const backLabel = canLabel(0.17, 0.13, -0.105);
  backLabel.rotation.y = Math.PI;
  g.add(backLabel);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.35, 0.55, 20),
    new THREE.MeshBasicMaterial({ color: 0x3a6cff, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -0.95;
  g.add(ring);
  return g;
}
function spawnCanPickup() {
  const p = streetPointNear(player.pos, 25, 115);
  const mesh = makeCanMesh();
  applyBottleSprite(mesh);
  mesh.position.set(p.x, 1.0, p.z);
  scene.add(mesh);
  canPickups.push({ mesh, t: Math.random() * 6 });
}
function drinkEnergy() {
  if (energy.cans <= 0 || energy.boostT > 0 || player.dead || cine.active) return;
  energy.cans--;
  energy.boostT = BOOST_DUR;
  energy.drinkT = 0.9;
  playGulp();
  addFeed('⚡ RED BULL — speed boost!');
  progressMission('drink', 1);
}
function playGulp() {
  if (!AC) return;
  for (let i = 0; i < 3; i++) {
    const t = AC.currentTime + i * 0.16;
    const osc = AC.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(420 - i * 60, t);
    osc.frequency.exponentialRampToValueAtTime(120, t + 0.1);
    const g = AC.createGain();
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(g).connect(AC.destination);
    osc.start(t); osc.stop(t + 0.13);
  }
}
const boostfxEl = document.getElementById('boostfx');
function updateEnergy(dt) {
  for (const c of canPickups) {
    c.t += dt;
    c.mesh.position.y = 1.0 + Math.sin(c.t * 2) * 0.15;
    c.mesh.rotation.y += dt * 2.2;
    if (energy.cans < 3 &&
        Math.hypot(c.mesh.position.x - player.pos.x, c.mesh.position.z - player.pos.z) < 1.8) {
      energy.cans++;
      playClick(2100, 0.25);
      addFeed('Red Bull picked up — press Q to drink');
      scene.remove(c.mesh);
      canPickups.splice(canPickups.indexOf(c), 1);
      setTimeout(spawnCanPickup, 100);
    }
  }
  if (energy.boostT > 0) energy.boostT -= dt;
  if (energy.drinkT > 0) energy.drinkT -= dt;
  if (boostfxEl) boostfxEl.style.opacity = Math.min(0.75, Math.max(0, energy.boostT) / 3);
  // drink animation: bottle raises and tips toward the mouth
  const drinking = energy.drinkT > 0;
  bottle.visible = drinking;
  if (drinking) {
    const p = 1 - energy.drinkT / 0.9;
    const lift = Math.sin(p * Math.PI);
    bottle.position.set(0.16 - lift * 0.12, -0.18 + lift * 0.13, -0.32);
    bottle.rotation.x = lift * 1.1;
  }
}
// bottle view model
const bottle = new THREE.Group();
{
  const silver = new THREE.MeshStandardMaterial({ color: 0xd2d6dc, roughness: 0.2, metalness: 0.9 });
  const blue = new THREE.MeshStandardMaterial({ color: 0x1c4fd0, roughness: 0.35, metalness: 0.4 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.17, 10), silver);
  bottle.add(body);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.037, 0.041, 0.06, 10), blue);
  bottle.add(band);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.04, 8),
    new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.5 }));
  cap.position.y = 0.1;
  bottle.add(cap);
  bottle.add(canLabel(0.065, 0.05, 0.042));     // real logo on the bottle
  bottle.visible = false;
  camera.add(bottle);
}

// ---------------------------------------------------------------------------
// Delivery mode — take orders from place to place; robbers may try to hit you
// ---------------------------------------------------------------------------
let mode = localStorage.getItem('streetops.mode') || 'delivery';
const order = { active: false, stage: 'pickup', fx: 0, fz: 0, tx: 0, tz: 0, name: '', reward: 0, cooldown: 1 };
let beacon = null;
const orderTaskEl = document.getElementById('order-task');
const orderDistEl = document.getElementById('order-dist');
const orderPayEl = document.getElementById('order-pay');
const orderAppEl = document.getElementById('order-app');

function makeBeacon() {
  const g = new THREE.Group();
  const cyl = new THREE.Mesh(
    new THREE.CylinderGeometry(1.3, 1.3, 18, 16, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x41d8ff, transparent: true, opacity: 0.2,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  cyl.position.y = 9;
  g.add(cyl);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.09, 8, 24),
    new THREE.MeshBasicMaterial({ color: 0x41d8ff }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.3;
  g.add(ring);
  scene.add(g);
  return { group: g, cyl, ring };
}
function setBeacon(x, z, color) {
  if (!beacon) beacon = makeBeacon();
  beacon.group.position.set(x, 0, z);
  beacon.cyl.material.color.set(color);
  beacon.ring.material.color.set(color);
  beacon.group.visible = true;
}
function newOrder() {
  const from = streetPointNear(player.pos, 35, 110);
  const to = streetPointNear(from, 70, 190);
  const names = CITY.sponsors.map(s => s.name).concat(SHOP_NAMES);
  order.active = true;
  order.stage = 'pickup';
  order.name = names[Math.floor(Math.random() * names.length)];
  order.fx = from.x; order.fz = from.z;
  order.tx = to.x; order.tz = to.z;
  order.reward = Math.round((12 + Math.hypot(to.x - from.x, to.z - from.z) * 0.15) * (1 + prog.level * 0.02));
  // every third order is a VIP rush: 2.5x pay, deadline after pickup
  order.vip = game.deliveries > 0 && game.deliveries % 3 === 2;
  order.timeLeft = 0;
  if (order.vip) order.reward = Math.round(order.reward * 2.5);
  setBeacon(from.x, from.z, order.vip ? 0xffd23f : 0x41d8ff);
  showBanner(order.vip ? '⭐ VIP RUSH ORDER' : 'New order');
  addFeed(order.vip ? `⭐ VIP order from ${order.name} — 2.5× pay!` : `Order from ${order.name}`);
  playClick(1700, 0.2);
}
function updateDelivery(dt) {
  if (!order.active) {
    order.cooldown -= dt;
    if (order.cooldown <= 0) newOrder();
    return;
  }
  const tx = order.stage === 'pickup' ? order.fx : order.tx;
  const tz = order.stage === 'pickup' ? order.fz : order.tz;
  const d = Math.hypot(player.pos.x - tx, player.pos.z - tz);
  orderTaskEl.textContent = (order.vip ? '⭐ VIP — ' : '') + (order.stage === 'pickup'
    ? `Pick up: ${order.name} — ${locationName(order.fx, order.fz)}`
    : `Deliver to customer — ${locationName(order.tx, order.tz)}`);
  if (order.vip && order.stage === 'dropoff' && order.timeLeft > 0) {
    order.timeLeft -= dt;
    if (order.timeLeft <= 0) {
      order.vip = false;
      order.reward = Math.round(order.reward / 2.5);
      addFeed('⏱ VIP deadline missed — normal pay');
      setBeacon(order.tx, order.tz, 0x7dff8a);
    }
  }
  const mult = 1 + Math.min(game.streak * 0.1, 1);
  orderDistEl.textContent = Math.round(d) + ' m' +
    (order.vip && order.stage === 'dropoff' ? ` · ⏱ ${Math.max(0, Math.ceil(order.timeLeft))}s` : '');
  orderPayEl.textContent = `Payout: $${Math.round(order.reward * mult)}` +
    (game.streak > 0 ? ` (streak ×${mult.toFixed(1)})` : '');
  if (beacon) {
    beacon.ring.rotation.z += dt * 2;
    beacon.cyl.material.opacity = 0.16 + Math.sin(game.time * 3) * 0.06;
  }
  if (d < 4.5) {
    if (order.stage === 'pickup') {
      order.stage = 'dropoff';
      if (order.vip)
        order.timeLeft = 14 + Math.hypot(order.tx - player.pos.x, order.tz - player.pos.z) * 0.55;
      setBeacon(order.tx, order.tz, order.vip ? 0xffd23f : 0x7dff8a);
      showBanner(order.vip ? `Picked up — ⏱ beat the clock!` : 'Picked up — go deliver!');
      playClick(1900, 0.25);
      if (Math.random() < Math.min(0.35 + prog.level * 0.008, 0.85)) {
        const n = 2 + Math.floor(Math.random() * 2) + Math.min(Math.floor(prog.level / 12), 3);
        for (let i = 0; i < n; i++) {
          const p = streetPointNear(player.pos, 25, 45);
          spawnEnemy(p.x, p.z);
        }
        showBanner('Robbers want your order!');
        addFeed('⚠ Robbers incoming — defend the delivery');
      }
    } else {
      order.active = false;
      order.cooldown = 3;
      const mult2 = 1 + Math.min(game.streak * 0.1, 1);
      const pay = Math.round(order.reward * mult2);
      game.money += pay;
      game.deliveries++;
      game.streak++;
      prog.bank += pay;
      addXP(16 + pay / 2);
      if (energy.cans < 3) energy.cans++;
      for (const w2 of WEAPONS) w2.reserve = Math.max(w2.reserve, w2.magSize * 4);
      player.health = Math.min(100, player.health + 25);
      if (beacon) beacon.group.visible = false;
      showBanner(`Delivered! +$${pay}${game.streak > 1 ? ` · STREAK ×${mult2.toFixed(1)}` : ''}`);
      addFeed(`${playerName()} +$${pay} — total $${game.money}`);
      playClick(2400, 0.3);
      progressMission('delivery', 1);
      progressMission('cash', pay);
      if (order.vip) progressMission('vip', 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Minimap
// ---------------------------------------------------------------------------
const mmCanvas = document.getElementById('minimap');
const mmCtx = mmCanvas.getContext('2d');
function drawMinimap() {
  const S = mmCanvas.width, k = S / (CITY_HALF * 2);
  const M = v => (v + CITY_HALF) * k;
  mmCtx.fillStyle = 'rgba(8,12,18,.82)';
  mmCtx.fillRect(0, 0, S, S);
  mmCtx.fillStyle = 'rgba(120,130,145,.5)';
  for (const s of STREETS) {
    mmCtx.fillRect(M(s - ROAD_HALF), 0, ROAD_HALF * 2 * k, S);
    mmCtx.fillRect(0, M(s - ROAD_HALF), S, ROAD_HALF * 2 * k);
  }
  mmCtx.fillStyle = 'rgba(90,190,255,.7)';
  for (const v of vehicles)
    mmCtx.fillRect(M(v.group.position.x) - 1, M(v.group.position.z) - 1, 2, 2);
  mmCtx.fillStyle = 'rgba(200,200,200,.55)';
  for (const c of traffic)
    mmCtx.fillRect(M(c.group.position.x) - 1, M(c.group.position.z) - 1, 2, 2);
  // gym marker + label
  mmCtx.fillStyle = '#ffb02a';
  mmCtx.fillRect(M(clubPos.x) - 2, M(clubPos.z) - 2, 4, 4);
  mmCtx.font = '7px Arial';
  mmCtx.fillText('GYM', M(clubPos.x) + 4, M(clubPos.z) + 3);
  if (mode === 'delivery' && order.active) {
    const tx = order.stage === 'pickup' ? order.fx : order.tx;
    const tz = order.stage === 'pickup' ? order.fz : order.tz;
    mmCtx.fillStyle = order.stage === 'pickup' ? '#41d8ff' : '#7dff8a';
    mmCtx.beginPath();
    mmCtx.arc(M(tx), M(tz), 3.6, 0, Math.PI * 2);
    mmCtx.fill();
  }
  mmCtx.fillStyle = '#ff4d4d';
  for (const en of enemies) {
    if (en.dead) continue;
    mmCtx.beginPath();
    mmCtx.arc(M(en.pos.x), M(en.pos.z), 2.4, 0, Math.PI * 2);
    mmCtx.fill();
  }
  // player arrow
  mmCtx.save();
  mmCtx.translate(M(player.pos.x), M(player.pos.z));
  mmCtx.rotate(-player.yaw);
  mmCtx.fillStyle = '#ffffff';
  mmCtx.beginPath();
  mmCtx.moveTo(0, -5);
  mmCtx.lineTo(3.5, 4);
  mmCtx.lineTo(-3.5, 4);
  mmCtx.closePath();
  mmCtx.fill();
  mmCtx.restore();
}

// ---------------------------------------------------------------------------
// Intro cinematic
// ---------------------------------------------------------------------------
const cine = { active: false, t: 0, dur: 8 };
const cineEl = document.getElementById('cine');
const grainEl = document.getElementById('grain');
function startCinematic() {
  cine.active = true;
  cine.t = 0;
  cine.start = performance.now();
  gun.visible = false;
  document.getElementById('cine-city').textContent = CITY.name + ' — 02:47 AM';
  cineEl.style.display = 'block';
  requestAnimationFrame(() => cineEl.classList.add('on'));
}
function finishCinematic() {
  cine.active = false;
  gun.visible = true;
  cineEl.classList.remove('on');
  cineEl.style.display = 'none';
  hudEl.style.display = 'block';
  grainEl.style.display = 'block';
  player.yaw = 0;
  player.pitch = 0;
  const del = mode === 'delivery';
  document.getElementById('tb-wave').style.display = del ? 'none' : 'block';
  document.getElementById('tb-cash').style.display = del ? 'block' : 'none';
  document.getElementById('tb-del').style.display = del ? 'block' : 'none';
  document.getElementById('orderpanel').style.display = del ? 'block' : 'none';
  if (del) orderAppEl.textContent = CITY.sponsors[0].name + ' DRIVER';
  document.getElementById('missions').style.display = del ? 'block' : 'none';
  renderMissions();
}
const _cineA = new THREE.Vector3(-44, 90, -100);
const _cineB = new THREE.Vector3(30, 26, -32);
const _cineC = new THREE.Vector3(4, EYE, 26);
const _cinePos = new THREE.Vector3();
const _cineLook = new THREE.Vector3();
function updateCinematic() {
  // absolute wall-clock so the flyover lasts ~8s on any frame rate
  cine.t = (performance.now() - cine.start) / 1000;
  const t = Math.min(cine.t / cine.dur, 1);
  const s = t * t * (3 - 2 * t);
  const u = 1 - s;
  _cinePos.set(0, 0, 0)
    .addScaledVector(_cineA, u * u)
    .addScaledVector(_cineB, 2 * u * s)
    .addScaledVector(_cineC, s * s);
  camera.position.copy(_cinePos);
  _cineLook.lerpVectors(new THREE.Vector3(4, 8, -70), new THREE.Vector3(4, EYE, 16), s);
  camera.lookAt(_cineLook);
  if (t >= 1) finishCinematic();
}

{
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  grainEl.style.backgroundImage = `url(${cv.toDataURL()})`;
}

// ---------------------------------------------------------------------------
// Player profile — username + man/woman avatar, persisted
// ---------------------------------------------------------------------------
const profile = (() => {
  try { return Object.assign({ name: '', gender: 'm', seed: Math.floor(Math.random() * 100000) },
    JSON.parse(localStorage.getItem('streetops.profile'))); }
  catch { return { name: '', gender: 'm', seed: Math.floor(Math.random() * 100000) }; }
})();
function saveProfile() { localStorage.setItem('streetops.profile', JSON.stringify(profile)); }
function seededRnd(i) {
  const x = Math.sin(profile.seed * 127.1 + i * 311.7) * 43758.5453;
  return x - Math.floor(x);
}
function lookFromProfile() {
  const f = profile.gender === 'f';
  return {
    gender: profile.gender,
    skin: SKINS[Math.floor(seededRnd(1) * SKINS.length)],
    shirtHue: seededRnd(2),
    pantsHue: seededRnd(3),
    hairColor: HAIRS[Math.floor(seededRnd(4) * HAIRS.length)],
    hairLong: f ? seededRnd(5) < 0.8 : seededRnd(5) < 0.1,
    skirt: false, // drivers ride in pants
  };
}
// the player's look in full courier uniform (the selected city's app brand)
function driverLook() {
  const l = lookFromProfile();
  l.uniform = new THREE.Color(selectedCity().sponsors[0].colorA).getHex();
  return l;
}
// seated, headless copy of the player's avatar shown on scooters/bicycles
function makeRider() {
  const c = makeCharacter(driverLook(), { head: false });
  c.group.position.set(0, 0.42, -0.3);
  c.legs[0].rotation.x = c.legs[1].rotation.x = -1.2;
  c.arms[0].rotation.x = c.arms[1].rotation.x = -0.85;
  return c;
}

// live rotating 3D preview of the avatar on the menu
let pv = null;
function initPreview() {
  const cv = document.getElementById('charpreview');
  if (!cv) return;
  pv = {
    renderer: new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true }),
    scene: new THREE.Scene(),
    cam: new THREE.PerspectiveCamera(35, cv.width / cv.height, 0.1, 10),
    char: null,
  };
  pv.renderer.setSize(cv.width, cv.height, false);
  pv.cam.position.set(0, 1.0, 3.2);
  pv.cam.lookAt(0, 0.88, 0);
  pv.scene.add(new THREE.HemisphereLight(0xcfe0f0, 0x443f38, 2.4));
  const d = new THREE.DirectionalLight(0xffffff, 2.2);
  d.position.set(2, 3, 2);
  pv.scene.add(d);
  refreshPreview();
}
function refreshPreview() {
  if (!pv) return;
  if (pv.char) pv.scene.remove(pv.char.group);
  pv.char = makeCharacter(driverLook());
  pv.scene.add(pv.char.group);
}

// ---------------------------------------------------------------------------
// City select menu
// ---------------------------------------------------------------------------
let selectedId = localStorage.getItem('streetops.city') || CITIES[0].id;
function selectedCity() { return CITIES.find(c => c.id === selectedId) || CITIES[0]; }
{
  const wrap = document.getElementById('cities');
  for (const city of CITIES) {
    const card = document.createElement('div');
    card.className = 'citycard' + (city.id === selectedId ? ' sel' : '');
    card.style.setProperty('--accent', city.accent);
    card.innerHTML = `<h3>${city.name}</h3><p>${city.blurb}</p>` +
      `<div class="sp">Sponsors: ${city.sponsors.map(s => s.name).join(' · ')}</div>`;
    card.addEventListener('click', e => {
      e.stopPropagation();
      selectedId = city.id;
      localStorage.setItem('streetops.city', selectedId);
      for (const el of wrap.children) el.classList.remove('sel');
      card.classList.add('sel');
      refreshPreview(); // uniform matches the selected city's app brand
    });
    wrap.appendChild(card);
  }
  const pl = document.getElementById('progressline');
  if (pl) {
    const nu = nextUnlock();
    pl.textContent = `DRIVER LEVEL ${prog.level} / 100` +
      (prog.bank > 0 ? ` · LIFETIME EARNINGS $${prog.bank}` : '') +
      (nu ? ` · NEXT UNLOCK: ${nu.what} (LVL ${nu.level})` : '');
  }
  // game mode buttons
  document.querySelectorAll('.modebtn').forEach(btn => {
    btn.classList.toggle('sel', btn.dataset.mode === mode);
    btn.addEventListener('click', e => {
      e.stopPropagation();
      mode = btn.dataset.mode;
      localStorage.setItem('streetops.mode', mode);
      document.querySelectorAll('.modebtn').forEach(b => b.classList.toggle('sel', b === btn));
    });
  });

  // driver profile: username + avatar
  const profileBox = document.getElementById('profile');
  if (profileBox) {
    profileBox.addEventListener('click', e => e.stopPropagation());
    const nameInput = document.getElementById('username');
    nameInput.value = profile.name;
    nameInput.addEventListener('input', () => {
      profile.name = nameInput.value.slice(0, 14);
      saveProfile();
    });
    document.querySelectorAll('.charbtn[data-g]').forEach(btn => {
      btn.classList.toggle('sel', btn.dataset.g === profile.gender);
      btn.addEventListener('click', () => {
        profile.gender = btn.dataset.g;
        saveProfile();
        document.querySelectorAll('.charbtn[data-g]').forEach(b => b.classList.toggle('sel', b === btn));
        refreshPreview();
      });
    });
    document.getElementById('lookbtn').addEventListener('click', () => {
      profile.seed = Math.floor(Math.random() * 100000);
      saveProfile();
      refreshPreview();
    });
    initPreview();
  }
}
function playerName() { return (profile.name || '').trim().toUpperCase() || 'DRIVER'; }

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let bobPhase = 0, shake = 0, slowmo = 0, deathT = 0, frameNo = 0, wasArmed = false;
let perfAccum = 0, perfFrames = 0, perfChecked = false;

// 3D navigation arrow pointing to the active delivery target
const navArrow = new THREE.Mesh(
  new THREE.ConeGeometry(0.1, 0.32, 8),
  new THREE.MeshBasicMaterial({ color: 0x41d8ff, transparent: true, opacity: 0.9, depthTest: false }));
navArrow.renderOrder = 5;
navArrow.visible = false;
scene.add(navArrow);
const _navDir = new THREE.Vector3(), _navFwd = new THREE.Vector3();
function updateNavArrow() {
  const show = mode === 'delivery' && order.active && !cine.active && !player.dead;
  navArrow.visible = show;
  if (!show) return;
  const tx = order.stage === 'pickup' ? order.fx : order.tx;
  const tz = order.stage === 'pickup' ? order.fz : order.tz;
  camera.getWorldDirection(_navFwd);
  _navFwd.y = 0;
  _navFwd.normalize();
  navArrow.position.copy(camera.position).addScaledVector(_navFwd, 2.4);
  navArrow.position.y = camera.position.y - 0.75;
  _navDir.set(tx - player.pos.x, 0, tz - player.pos.z).normalize();
  navArrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _navDir);
  navArrow.material.color.set(order.stage === 'pickup' ? 0x41d8ff : 0x7dff8a);
}

function tick() {
  requestAnimationFrame(tick);
  const dtRaw = clock.getDelta();
  const dtReal = Math.min(dtRaw, 0.05);
  if (!started) {
    if (pv && pv.char) {
      pv.char.group.rotation.y += dtRaw * 1.2;
      pv.renderer.render(pv.scene, pv.cam);
    }
    doRender();
    return;
  }
  if (!locked && !player.dead) { doRender(); return; }

  if (cine.active) {
    game.time += dtReal;
    updateCinematic();
    updateAtmosphere(dtReal);
    updateClub(dtReal);
    updateMusic();
    updateEffects(dtReal);
    doRender();
    return;
  }

  if (slowmo > 0) slowmo -= dtReal;
  const dt = dtReal * (slowmo > 0 ? 0.35 : 1);
  game.time += dt;
  updateAtmosphere(dt);
  shake = Math.max(0, shake - dt * 2.2);

  // adaptive quality: if the device can't hold ~25fps, drop bloom
  if (!perfChecked) {
    perfAccum += dtRaw; perfFrames++;
    if (perfFrames >= 120) {
      perfChecked = true;
      if (perfAccum / perfFrames > 0.042) {
        bloomPass.enabled = false;
        addFeed('⚙ Performance mode — glow effects reduced');
      }
    }
  }

  if (grainEl.style.display === 'block' && ++frameNo % 3 === 0)
    grainEl.style.transform = `translate(${(Math.random() * 64) | 0}px, ${(Math.random() * 64) | 0}px)`;

  // ---- player movement / driving ----
  if (!player.dead && driving) {
    updateDriving(dt);
    drivehintEl.style.display = 'none';
  } else if (!player.dead) {
    const sprinting = (keys['ShiftLeft'] || keys['ShiftRight']) && keys['KeyW'] && !aiming;
    const boost = energy.boostT > 0 ? 1.45 : 1;
    const speed = (aiming ? 2.6 : sprinting ? 8.2 : 5.2) * boost;
    const fwd = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const wish = new THREE.Vector3();
    if (keys['KeyW']) wish.add(fwd);
    if (keys['KeyS']) wish.sub(fwd);
    if (keys['KeyD']) wish.add(right);
    if (keys['KeyA']) wish.sub(right);
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
    player.vel.x += (wish.x - player.vel.x) * Math.min(1, dt * 12);
    player.vel.z += (wish.z - player.vel.z) * Math.min(1, dt * 12);
    player.vel.y -= 22 * dt;
    if (keys['Space'] && player.onGround) { player.vel.y = 7.2; player.onGround = false; }
    player.pos.addScaledVector(player.vel, dt);
    if (player.pos.y <= 0) { player.pos.y = 0; player.vel.y = 0; player.onGround = true; }
    resolveCollisions(player.pos, 1.75);

    const planarSpeed = Math.hypot(player.vel.x, player.vel.z);
    if (planarSpeed > 0.5 && player.onGround) bobPhase += dt * planarSpeed * 1.6;
    const bob = Math.sin(bobPhase) * 0.017 * Math.min(planarSpeed / 5, 1) * (aiming ? 0.3 : 1);

    camera.position.set(player.pos.x, player.pos.y + EYE + bob, player.pos.z);
    camera.rotation.order = 'YXZ';
    const strafeRoll = ((keys['KeyA'] ? 1 : 0) - (keys['KeyD'] ? 1 : 0)) * 0.014;
    const sway = Math.cos(bobPhase * 0.5) * 0.0022 * Math.min(planarSpeed / 5, 1);
    camera.rotation.set(
      player.pitch + weapon.recoil * 0.012 + (Math.random() - 0.5) * shake * 0.05,
      player.yaw,
      strafeRoll + sway + (Math.random() - 0.5) * shake * 0.05);

    if (player.health < 100 && game.time - player.lastHurt > 4)
      player.health = Math.min(100, player.health + dt * 22);

    // ---- weapon: couriers stay unarmed until robbers attack ----
    const armed = mode === 'waves' || enemies.some(e => !e.dead);
    if (armed !== wasArmed) {
      wasArmed = armed;
      if (mode === 'delivery') {
        addFeed(armed ? '⚠ Weapon drawn — defend your delivery!' : 'Weapon holstered');
        playClick(armed ? 700 : 1200, 0.2);
      }
    }
    gun.visible = armed;
    document.getElementById('crosshair').style.display = armed ? 'block' : 'none';
    document.getElementById('ammo').style.opacity = armed ? 1 : 0.25;
    weapon.cooldown -= dt;
    weapon.recoil = Math.max(0, weapon.recoil - dt * 10);
    const w = W();
    if (weapon.reloading > 0) {
      weapon.reloading -= dt;
      if (weapon.reloading <= 0) {
        const take = Math.min(w.magSize - w.mag, w.reserve);
        w.mag += take;
        w.reserve -= take;
        playClick(1600, 0.2);
        document.getElementById('reloadmsg').style.display = 'none';
      }
    } else if (armed && (w.auto ? firing : pendingShot) && weapon.cooldown <= 0) {
      if (w.mag > 0) fireBullet();
      else { playClick(2100, 0.12); weapon.cooldown = 0.25; if (w.reserve > 0) startReload(); }
      pendingShot = false;
    }

    const targetPos = aiming ? ADS_POS : HIP_POS;
    gun.position.lerp(targetPos, Math.min(1, dt * 12));
    gun.position.y += bob * 0.5;
    gun.position.z += weapon.recoil * 0.006;
    gun.rotation.x = weapon.recoil * 0.02;
    const targetFov = (aiming ? ADS_FOV : sprinting ? BASE_FOV + 7 : BASE_FOV)
      + (energy.boostT > 0 && !aiming ? 5 : 0);
    if (Math.abs(camera.fov - targetFov) > 0.1) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 14);
      camera.updateProjectionMatrix();
    }

    drivehintEl.style.display = nearestVehicle(3.8) ? 'block' : 'none';
  } else {
    deathT += dt;
    const k = Math.min(deathT / 1.3, 1);
    const e = k * k * (3 - 2 * k);
    camera.position.set(player.pos.x, player.pos.y + EYE - e * (EYE - 0.35), player.pos.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(player.pitch * (1 - e) - e * 0.15, player.yaw, e * 0.55);
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
    if (mode === 'waves') {
      if (game.wave === 0) startWave();
      else if (alive === 0 && enemies.length === 0) {
        game.intermission += dt;
        if (game.intermission > 4) { game.intermission = 0; startWave(); }
        else if (game.intermission > 3.9) showBanner('Get ready…');
      }
    } else {
      updateDelivery(dt);
    }
  }

  updateTraffic(dt);
  updatePeds(dt);
  updateEnergy(dt);
  updateClub(dt);
  updateMusic();
  updateNavArrow();
  trackDistance();
  updateEffects(dt);

  // ---- HUD ----
  waveEl.textContent = game.wave;
  aliveEl.textContent = alive;
  killsEl.textContent = game.kills;
  document.getElementById('cash').textContent = '$' + game.money;
  document.getElementById('deliveries').textContent = game.deliveries;
  document.getElementById('lvl').textContent = playerName() + ' · LVL ' + prog.level;
  document.getElementById('cans').textContent = '⚡ ×' + energy.cans;
  if (++frameNo % 20 === 0)
    document.getElementById('location').textContent =
      '📍 ' + locationName(player.pos.x, player.pos.z) + ' · ' + CITY.name;
  document.getElementById('boostfill').style.width = Math.max(0, energy.boostT / BOOST_DUR * 100) + '%';
  document.getElementById('xpfill').style.width =
    (prog.level >= 100 ? 100 : Math.min(100, prog.xp / xpNeed(prog.level) * 100)) + '%';
  magEl.textContent = W().mag;
  reserveEl.textContent = W().reserve;
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
  drawMinimap();

  doRender();
}
tick();

// debug/testing handle
window.__so = {
  get cineT() { return cine.t; },
  get state() {
    return {
      cine: cine.active, driving: !!driving, firing, locked, started, mode,
      mag: W().mag, cooldown: weapon.cooldown, reloading: weapon.reloading,
      dead: player.dead, wave: game.wave, enemies: enemies.length,
      money: game.money, order: order.active ? order.stage : null,
      peds: peds.length, traffic: traffic.length, nf: NF,
      pos: [player.pos.x, player.pos.z],
    };
  },
};
