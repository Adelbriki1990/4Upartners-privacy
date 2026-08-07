// Street Ops — cinematic 3D urban combat in the browser (Three.js, no assets).
// Three selectable cities, sponsor advertising, drivable cars, wave combat.
import * as THREE from './lib/three.module.min.js';
import { EffectComposer } from './lib/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './lib/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './lib/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './lib/jsm/postprocessing/OutputPass.js';
import { RoundedBoxGeometry } from './lib/jsm/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from './lib/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from './lib/jsm/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from './lib/jsm/utils/SkeletonUtils.js';
import { CITIES } from './sponsors.js?v=61';

// Clean-brand mode: the portal build (CrazyGames etc.) must carry no real
// trademarks. window.CLEAN_BUILD is injected by the build script; ?clean=1
// previews the same thing on the normal deployment.
const CLEAN = !!window.CLEAN_BUILD || new URLSearchParams(location.search).has('clean');
const EN_BRAND = CLEAN ? 'Bolt Energy' : 'Red Bull';
const EN_BRAND_U = CLEAN ? 'BOLT ENERGY' : 'RED BULL';

// ---------------------------------------------------------------------------
// Portal adapter — the same game ships to several sites, each with its own ad
// SDK. window.PORTAL_SDK is injected by the build script ('crazygames', 'poki',
// 'gd'); empty means no ad network (own site, itch.io, Y8) and every ad button
// stays hidden. ?portal=<name> previews a portal build locally.
// ---------------------------------------------------------------------------
const PORTAL = window.PORTAL_SDK || new URLSearchParams(location.search).get('portal') || '';
const ADS = !!PORTAL; // is there a real ad network behind the buttons?
// Every portal requires the game to go quiet AND stop simulating while an ad
// plays (GameDistribution's SDK drives this from its own events too, via the
// window hooks below). Idempotent: two pause calls still restore once.
let adPaused = false, adPrevGain = null;
function pauseForAd() {
  if (adPaused) return;
  adPaused = true;
  if (typeof MASTER !== 'undefined' && MASTER) {
    adPrevGain = MASTER.gain.value;
    MASTER.gain.value = 0;
  }
}
function resumeAfterAd() {
  if (!adPaused) return;
  adPaused = false;
  if (adPrevGain !== null && typeof MASTER !== 'undefined' && MASTER) MASTER.gain.value = adPrevGain;
  adPrevGain = null;
}
window.__adPause = pauseForAd;
window.__adResume = resumeAfterAd;
async function portalInit() {
  if (!ADS) return;
  // give the platform script time to land before we call into it
  const ready = () => (PORTAL === 'crazygames' && window.CrazyGames && window.CrazyGames.SDK)
    || (PORTAL === 'poki' && window.PokiSDK) || (PORTAL === 'gd' && window.gdsdk);
  for (let i = 0; i < 20 && !ready(); i++) await new Promise(r => setTimeout(r, 500));
  try {
    if (PORTAL === 'crazygames') await window.CrazyGames.SDK.init();
    else if (PORTAL === 'poki') {
      await window.PokiSDK.init();
      window.PokiSDK.gameLoadingFinished();
    }
  } catch (e) { /* offline preview — the game runs fine without the network */ }
}
portalInit();
// Rewarded video: the player CHOOSES to watch, we grant the prize.
function showRewardedAd(onReward) {
  pauseForAd();
  const ok = () => { resumeAfterAd(); onReward(); };
  const fail = () => { resumeAfterAd(); addFeed('📺 No ad available right now'); };
  try {
    if (PORTAL === 'crazygames' && window.CrazyGames?.SDK?.ad) {
      window.CrazyGames.SDK.ad.requestAd('rewarded',
        { adStarted: () => {}, adFinished: ok, adError: fail });
      return;
    }
    if (PORTAL === 'poki' && window.PokiSDK) {
      window.PokiSDK.rewardedBreak().then(w => (w ? ok() : fail())).catch(fail);
      return;
    }
    if (PORTAL === 'gd' && window.gdsdk) {
      window.gdsdk.showAd('rewarded').then(ok).catch(fail);
      return;
    }
  } catch (e) { /* fall through to the preview path */ }
  ok(); // no network attached (local preview) — grant directly so the flow is testable
}
function showMidgameAd() {
  if (!ADS) return;
  pauseForAd();
  const done = resumeAfterAd;
  try {
    if (PORTAL === 'crazygames' && window.CrazyGames?.SDK?.ad) {
      window.CrazyGames.SDK.ad.requestAd('midgame',
        { adStarted: () => {}, adFinished: done, adError: done });
      return;
    }
    if (PORTAL === 'poki' && window.PokiSDK) {
      window.PokiSDK.commercialBreak().then(done).catch(done);
      return;
    }
    if (PORTAL === 'gd' && window.gdsdk) {
      window.gdsdk.showAd().then(done).catch(done);
      return;
    }
  } catch (e) { /* ads are optional */ }
  done();
}
// Every portal wants to know when real gameplay is running (ad pacing, metrics)
function cgGame(ev) {
  if (!ADS) return;
  try {
    if (PORTAL === 'crazygames' && window.CrazyGames?.SDK?.game) {
      if (ev === 'start') window.CrazyGames.SDK.game.gameplayStart();
      else window.CrazyGames.SDK.game.gameplayStop();
    } else if (PORTAL === 'poki' && window.PokiSDK) {
      if (ev === 'start') window.PokiSDK.gameplayStart();
      else window.PokiSDK.gameplayStop();
    }
  } catch (e) { /* sdk optional */ }
}

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const canvas = document.getElementById('c');
// Some iPhones refuse the first WebGL context (low memory, Lockdown Mode,
// old iOS). Try progressively simpler settings, and if 3D is blocked
// completely, explain exactly how to unblock it instead of dying silently.
function makeRenderer() {
  for (const opts of [
    { antialias: true },
    { antialias: false },
    { antialias: false, powerPreference: 'low-power' },
  ]) {
    try { return new THREE.WebGLRenderer({ canvas, ...opts }); }
    catch (e) { /* try simpler settings */ }
  }
  let gl1 = false;
  try { gl1 = !!document.createElement('canvas').getContext('webgl'); } catch (e) {}
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:0;z-index:200;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;background:#0a0f18;color:#e8eef5;' +
    'font:600 16px Arial;text-align:center;padding:28px;gap:14px;line-height:1.5';
  d.innerHTML = gl1
    ? '<div style="font-size:44px">📱</div>' +
      '<div>This game needs <b>iOS 15 or newer</b> for its 3D graphics (WebGL2).</div>' +
      '<div style="color:#9fb2c4;font-size:13px">iPhone Settings → General → Software Update</div>'
    : '<div style="font-size:44px">🔒</div>' +
      '<div><b>3D graphics are blocked on this device.</b></div>' +
      '<div style="color:#cfd8e2;font-size:14px">If you use <b>Lockdown Mode</b>: tap the <b>ᴀA</b> button in the Safari address bar → <b>Website Settings</b> → turn OFF Lockdown Mode for this site → reload.</div>' +
      '<div style="color:#9fb2c4;font-size:13px">Otherwise update iOS, or try another browser/device.</div>';
  document.body.appendChild(d);
  throw new Error('WebGL unavailable — help screen shown');
}
// Phones get a light build; a phone that just crash-looped gets SAFE MODE
// (no optional 3D models at all) so it always recovers instead of dying.
const CRASHED_LAST_BOOT = (() => {
  try { return sessionStorage.getItem('so.booting') === '1'; } catch (e) { return false; }
})();
try {
  sessionStorage.setItem('so.booting', '1');
  setTimeout(() => { try { sessionStorage.removeItem('so.booting'); } catch (e) {} }, 12000);
} catch (e) {}
const LOWMEM = CRASHED_LAST_BOOT ||
  matchMedia('(pointer: coarse)').matches || /iPhone|iPad|Android/i.test(navigator.userAgent);
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
// iPhones skip ALL optional 3D models unless the player turns on HQ —
// guaranteed to fit in Safari's memory cap; procedural stand-ins cover it
const HQ_ON = (() => { try { return localStorage.getItem('streetops.hq') === '1'; } catch (e) { return false; } })();
const SAFEMODE = CRASHED_LAST_BOOT || (IS_IOS && !HQ_ON);
const renderer = makeRenderer();
renderer.setPixelRatio(Math.min(window.devicePixelRatio, SAFEMODE ? 1 : LOWMEM ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;

const scene = new THREE.Scene();
const BASE_FOV = 75, ADS_FOV = 42; // aim = real 1.8x zoom
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.08, 500);

// post-processing: bloom makes the neon actually glow (MSAA target = clean edges)
const composer = new EffectComposer(renderer,
  new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight,
    { samples: LOWMEM ? 0 : 4 })); // 4x MSAA at retina size is an OOM killer on iPhone
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
    landmark: { x: 90, z: 90, kind: 'spire' }, // holo-spire block
  },
  marina: {
    sky: 0x141824, fog: 0.008, hemi: [0x5a6a8a, 0x2a2318, 1.6],
    moonColor: 0xbcccff, lamp: 0xffc37a,
    wall: { h: 38, s: 16, l: 33 }, windowHues: [45, 48, 52, 42, 200, 46],
    neon: ['#ffd23f', '#ff9c41', '#41d8ff', '#ff5f6d', '#7dff8a'],
    rain: 0, thunder: false, hMin: 16, hMax: 42,
    styles: { curtain: 0.45, brick: 0.08 }, tree: { color: 0x2a4530, every: 20, chance: 0.65 },
    waterfront: 'east', // corniche, palms, yachts along +x
  },
  sahara: {
    noGuns: true, // family-friendly: no firearms in the Arabic cities
    sky: 0x1a140c, fog: 0.009, hemi: [0x8a6f4a, 0x3a2c18, 1.5],
    moonColor: 0xd8c8a8, lamp: 0xffb35c,
    wall: { h: 36, s: 30, l: 46 }, windowHues: [38, 42, 34, 46, 40, 36],
    neon: ['#e8c06a', '#ff9c41', '#7dff8a', '#ff5f6d', '#41d8ff'],
    rain: 0, thunder: false, hMin: 6, hMax: 13,
    styles: { curtain: 0, brick: 0.15, adobe: 0.8 },
    tree: { color: 0x3a5a2a, every: 30, chance: 0.4, palm: true },
    ground: { base: '#b89a6a', road: '#7a6a50', line: '#e8dcc0' },
    arch: 'arabic', dress: 'arabic', camels: true,
    landmark: { x: -90, z: 90, kind: 'watchtower' }, // kasbah block
    gates: true,                 // adobe city gates over the main avenues
  },
  nyc: {
    sky: 0x10131c, fog: 0.0095, hemi: [0x56607a, 0x24201a, 1.5],
    moonColor: 0xaebbdd, lamp: 0xffd9a0,
    wall: { h: 215, s: 8, l: 30 }, windowHues: [45, 50, 42, 205, 48, 40],
    neon: ['#ffd23f', '#ff5f6d', '#41d8ff', '#f2f2f2', '#ff9c41'],
    rain: 500, thunder: false, hMin: 22, hMax: 58,
    styles: { curtain: 0.4, brick: 0.45 }, tree: { color: 0x2e4a26, every: 24, chance: 0.5 },
    landmark: { x: 90, z: -90, kind: 'deco' }, // art-deco giant
    taxis: true,
  },
  dubai: {
    noGuns: true, // family-friendly: no firearms in the Arabic cities
    sky: 0x121826, fog: 0.0075, hemi: [0x6a7a95, 0x3a2c18, 1.6],
    moonColor: 0xcdd8ff, lamp: 0xffe0b0,
    wall: { h: 40, s: 18, l: 38 }, windowHues: [200, 205, 45, 210, 48, 195],
    neon: ['#ffd700', '#41d8ff', '#f2f2f2', '#ff9c41', '#7dff8a'],
    rain: 0, thunder: false, hMin: 24, hMax: 70,
    styles: { curtain: 0.85, brick: 0 },
    tree: { color: 0x2f5c33, every: 22, chance: 0.55, palm: true },
    waterfront: 'east',
    landmark: { x: -90, z: 30, kind: 'burj' }, // the real Burj Khalifa model
    sail: { x: 152, z: -55 },                  // sail hotel on the shore
    luxCars: true,
  },
  doha: {
    noGuns: true, // family-friendly: no firearms in the Arabic cities
    sky: 0x131722, fog: 0.008, hemi: [0x64708a, 0x2f2718, 1.55],
    moonColor: 0xc8d4f0, lamp: 0xffcf8a,
    wall: { h: 42, s: 20, l: 40 }, windowHues: [190, 200, 45, 210, 35, 205],
    neon: ['#e05a7a', '#41d8ff', '#ffd23f', '#f2f2f2', '#7dff8a'],
    rain: 0, thunder: false, hMin: 18, hMax: 55,
    styles: { curtain: 0.7, brick: 0.05 },
    tree: { color: 0x2f5c33, every: 22, chance: 0.55, palm: true },
    waterfront: 'east',
    landmark: { x: -90, z: 30, kind: 'museum' }, // stepped stone museum
    pearl: { x: 126, z: 20 },                    // pearl-in-oyster monument
    dress: 'arabic',
  },
  harbor: {
    sky: 0x14100e, fog: 0.0125, hemi: [0x6a5648, 0x241c14, 1.4],
    moonColor: 0xd8c8b0, lamp: 0xffa04a,
    wall: { h: 14, s: 30, l: 26 }, windowHues: [35, 40, 30, 45, 38, 25],
    neon: ['#ff8a5f', '#ffd23f', '#ff5f6d', '#7dff8a', '#41d8ff'],
    rain: 750, thunder: true, hMin: 9, hMax: 24,
    styles: { curtain: 0.06, brick: 0.6 }, tree: { color: 0x2c3620, every: 22, chance: 0.55 },
    docks: 'west', // container port, cranes, cargo ship along -x
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
  neon:   { sky: 0xa4b8cf, fogMul: 0.5 },    // bright broken clouds
  marina: { sky: 0xa7c9e8, fogMul: 0.4 },    // clear blue
  sahara: { sky: 0xe2c69a, fogMul: 0.55 },   // sandy haze
  harbor: { sky: 0xacbdcc, fogMul: 0.55 },
  nyc:    { sky: 0xa9c2e2, fogMul: 0.45 },   // crisp east-coast blue
  dubai:  { sky: 0xb2d4f0, fogMul: 0.35 },   // blazing clear gulf sky
  doha:   { sky: 0xb4d6ee, fogMul: 0.35 },   // bright corniche morning
};
const lampLights = [];   // point lights that dim at day
const dayGlowMats = []; // additive glow cones that must vanish in daylight
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
moon.shadow.mapSize.set(LOWMEM ? 1024 : 2048, LOWMEM ? 1024 : 2048);
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

// daytime sky: a blazing sun sprite + soft cumulus puffs around the horizon
let sunSprite = null, cloudGrp = null;
{
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 10, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,252,240,1)');
  grad.addColorStop(0.18, 'rgba(255,244,200,.95)');
  grad.addColorStop(0.45, 'rgba(255,228,155,.35)');
  grad.addColorStop(1, 'rgba(255,215,130,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cv), transparent: true, fog: false, depthWrite: false }));
  sunSprite.scale.setScalar(95);
  sunSprite.position.set(165, 195, -150);
  scene.add(sunSprite);

  const ccv = document.createElement('canvas');
  ccv.width = 256; ccv.height = 128;
  const cg = ccv.getContext('2d');
  for (let i = 0; i < 26; i++) {
    const x = 34 + Math.random() * 188, y = 48 + Math.random() * 44, r = 14 + Math.random() * 26;
    const pg = cg.createRadialGradient(x, y, 2, x, y, r);
    pg.addColorStop(0, 'rgba(255,255,255,.78)');
    pg.addColorStop(0.7, 'rgba(248,250,255,.28)');
    pg.addColorStop(1, 'rgba(245,248,255,0)');
    cg.fillStyle = pg; cg.beginPath(); cg.arc(x, y, r, 0, 6.29); cg.fill();
  }
  const ctex = new THREE.CanvasTexture(ccv);
  cloudGrp = new THREE.Group();
  for (let i = 0; i < 14; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: ctex, transparent: true, fog: false, depthWrite: false,
      opacity: 0.45 + Math.random() * 0.35 }));
    const a = Math.random() * Math.PI * 2, rr = 130 + Math.random() * 180;
    sp.position.set(Math.cos(a) * rr, 115 + Math.random() * 95, Math.sin(a) * rr);
    sp.scale.set(95 + Math.random() * 85, 26 + Math.random() * 18, 1);
    cloudGrp.add(sp);
  }
  scene.add(cloudGrp);
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
  const top = new THREE.Color(day.sky).multiplyScalar(0.88 - 0.16 * NF).lerp(new THREE.Color(0x03040a), NF);
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
let MASTER = null; // loudness bus: boosted gain into a limiter so it never clips
function audioInit() {
  if (AC) return;
  AC = new (window.AudioContext || window.webkitAudioContext)();
  const comp = AC.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.knee.value = 18;
  comp.ratio.value = 14;
  comp.attack.value = 0.002;
  comp.release.value = 0.2;
  MASTER = AC.createGain();
  MASTER.gain.value = 1.9;
  MASTER.connect(comp).connect(AC.destination);
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
  src.connect(lp).connect(g).connect(MASTER);
  src.start(); lfo.start();
  initAmbient();
  renderMusic(); // async: loops fade in once rendered
}
// ---------------------------------------------------------------------------
// Ambient city sound — horns in the distance, birds by day, crickets at
// night, crowd murmur near venues, waves at the shore, rain patter.
// All generated, nothing downloaded.
// ---------------------------------------------------------------------------
let AMB = null;
function initAmbient() {
  if (AMB || !AC) return;
  AMB = { hornT: 5 + Math.random() * 8, birdT: 2 + Math.random() * 5 };
  const bed = (dur, type, freq, q) => {
    const src = AC.createBufferSource();
    src.buffer = noiseBuffer(dur);
    src.loop = true;
    const f = AC.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    if (q) f.Q.value = q;
    const gn = AC.createGain();
    gn.gain.value = 0;
    src.connect(f).connect(gn).connect(MASTER);
    src.start();
    return gn;
  };
  AMB.crowdG = bed(3, 'bandpass', 420, 0.8); // murmur of people
  AMB.waveG = bed(4, 'lowpass', 520);        // surf at the shore
  AMB.rainG = bed(2, 'highpass', 2600);      // rain patter
  // crickets: a pulsing high chirp bed for desert and park nights
  const cr = AC.createOscillator();
  cr.type = 'sine'; cr.frequency.value = 4300;
  const crG = AC.createGain(); crG.gain.value = 0;
  const lfo2 = AC.createOscillator(); lfo2.frequency.value = 26;
  const lfoG2 = AC.createGain(); lfoG2.gain.value = 0;
  lfo2.connect(lfoG2).connect(crG.gain);
  cr.connect(crG).connect(MASTER);
  cr.start(); lfo2.start();
  AMB.cricketG = crG; AMB.cricketLfoG = lfoG2;
}
function playHorn() {
  // a distant double-beep from somewhere in traffic
  const pan = AC.createStereoPanner ? AC.createStereoPanner() : null;
  const g = AC.createGain();
  const f0 = 340 + Math.random() * 180;
  const t0 = AC.currentTime;
  const dur = 0.14 + Math.random() * 0.2;
  const twice = Math.random() < 0.5;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(0.05 + Math.random() * 0.04, t0 + 0.02);
  g.gain.setValueAtTime(twice ? 0 : 0.05, t0 + dur);
  if (twice) {
    g.gain.linearRampToValueAtTime(0.06, t0 + dur + 0.09);
    g.gain.linearRampToValueAtTime(0, t0 + dur * 2 + 0.09);
  } else g.gain.linearRampToValueAtTime(0, t0 + dur + 0.05);
  for (const mult of [1, 1.26]) {
    const o = AC.createOscillator();
    o.type = 'square';
    o.frequency.value = f0 * mult;
    o.connect(g);
    o.start(t0); o.stop(t0 + dur * 2 + 0.3);
  }
  if (pan) { pan.pan.value = Math.random() * 1.6 - 0.8; g.connect(pan).connect(MASTER); }
  else g.connect(MASTER);
}
function playChirp() {
  // a little run of birdsong
  const n = 1 + Math.floor(Math.random() * 3);
  let t = AC.currentTime;
  for (let i = 0; i < n; i++) {
    const o = AC.createOscillator();
    const g = AC.createGain();
    const f0 = 3200 + Math.random() * 1200;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.72, t + 0.09);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.035, t + 0.015);
    g.gain.linearRampToValueAtTime(0, t + 0.1);
    o.connect(g).connect(MASTER);
    o.start(t); o.stop(t + 0.14);
    t += 0.13 + Math.random() * 0.1;
  }
}
const AF = v => (Number.isFinite(v) ? v : 0); // never feed NaN to WebAudio

// ---------------------------------------------------------------------------
// Dynamic action soundtrack — a live WebAudio sequencer that reacts to the
// game: chill cruise groove on quiet streets, driving chase beat when police,
// robbers or a street race light things up. No audio files, pure synthesis.
// ---------------------------------------------------------------------------
const MUSIC = { bus: null, next: 0, step: 0, i: 0 };
const MUSIC_RIFF = [0, 0, 12, 0, 3, 3, 15, 3, 5, 17, 5, 3, 8, 7, 5, 3];
let NOISE_BUF = null;
function noiseBuf() {
  if (!NOISE_BUF) {
    NOISE_BUF = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
    const d = NOISE_BUF.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return NOISE_BUF;
}
function mKick(t, I) {
  const o = AC.createOscillator(), g = AC.createGain();
  o.frequency.setValueAtTime(AF(115 + 45 * I), t);
  o.frequency.exponentialRampToValueAtTime(36, t + 0.1);
  g.gain.setValueAtTime(0.5, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
  o.connect(g).connect(MUSIC.bus);
  o.start(t); o.stop(t + 0.17);
}
function mSnap(t, freq, q, vol, dur) {
  const src = AC.createBufferSource();
  src.buffer = noiseBuf();
  src.loop = true;
  src.playbackRate.value = 1;
  const f = AC.createBiquadFilter();
  f.type = freq > 4000 ? 'highpass' : 'bandpass';
  f.frequency.value = AF(freq); f.Q.value = q;
  const g = AC.createGain();
  g.gain.setValueAtTime(AF(vol), t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f).connect(g).connect(MUSIC.bus);
  src.start(t, Math.random()); src.stop(t + dur + 0.02);
}
function mBass(t, semi, dur, I) {
  const o = AC.createOscillator(), f = AC.createBiquadFilter(), g = AC.createGain();
  o.type = 'sawtooth';
  o.frequency.value = AF(55 * Math.pow(2, semi / 12));
  f.type = 'lowpass';
  f.frequency.value = AF(280 + 900 * I);
  f.Q.value = 6;
  g.gain.setValueAtTime(0.22, t);
  g.gain.setValueAtTime(0.22, t + dur * 0.6);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(f).connect(g).connect(MUSIC.bus);
  o.start(t); o.stop(t + dur + 0.02);
}
function musicTick() {
  if (!AC || !started) return;
  if (!MUSIC.bus) {
    MUSIC.bus = AC.createGain();
    MUSIC.bus.gain.value = 0;
    MUSIC.bus.connect(MASTER);
    MUSIC.next = AC.currentTime + 0.1;
  }
  // how hot is the moment? police heat, live robbers or an active race
  const danger = heat.level > 0 || race.active || enemies.some(e => !e.dead);
  const target = player.dead ? 0 : danger ? 1 : 0.32;
  MUSIC.i += (target - MUSIC.i) * 0.02;
  const I = MUSIC.i;
  // duck the street soundtrack near venues that play their own music
  let dmin = 1e9;
  for (const z of musicZones)
    dmin = Math.min(dmin, Math.hypot(z.x - player.pos.x, z.z - player.pos.z));
  const duck = Math.max(0.15, Math.min(1, (dmin - 16) / 26));
  MUSIC.bus.gain.value = AF((0.05 + 0.13 * I) * duck);
  const spb = 60 / (98 + 34 * I) / 4; // sixteenth-note length
  while (MUSIC.next < AC.currentTime + 0.15) {
    const t = Math.max(MUSIC.next, AC.currentTime);
    const s = MUSIC.step % 16;
    if (s % 4 === 0 || (I > 0.7 && s === 14)) mKick(t, I);
    if (I > 0.5 && (s === 4 || s === 12)) mSnap(t, 1900, 1.1, 0.3, 0.12);   // snare
    if (s % 2 === 0 || I > 0.7) mSnap(t, 7800, 1, s % 4 === 2 ? 0.12 : 0.07, 0.05); // hats
    if (s % 2 === 0 || I > 0.6) mBass(t, MUSIC_RIFF[s] + (I > 0.85 ? 12 : 0), spb * 1.9, I);
    MUSIC.next += spb;
    MUSIC.step++;
  }
}
// crowd-goes-wild stinger for wins: delivery streaks, race wins, boss kills
function playCheer() {
  if (!AC) return;
  const src = AC.createBufferSource();
  src.buffer = noiseBuf();
  src.loop = true;
  const f = AC.createBiquadFilter();
  f.type = 'bandpass'; f.Q.value = 0.8;
  const g = AC.createGain();
  const t = AC.currentTime;
  f.frequency.setValueAtTime(700, t);
  f.frequency.linearRampToValueAtTime(1500, t + 0.5);
  g.gain.setValueAtTime(0.001, t);
  g.gain.exponentialRampToValueAtTime(0.3, t + 0.16);
  g.gain.exponentialRampToValueAtTime(0.001, t + 1.15);
  src.connect(f).connect(g).connect(MASTER);
  src.start(t, Math.random()); src.stop(t + 1.2);
  playChirp();
}
function updateAmbient(dt) {
  if (!AMB) return;
  AMB.hornT -= dt;
  if (AMB.hornT <= 0) { AMB.hornT = 7 + Math.random() * 16; playHorn(); }
  if (NF < 0.4) {
    AMB.birdT -= dt;
    if (AMB.birdT <= 0) { AMB.birdT = 2.5 + Math.random() * 7; playChirp(); }
  }
  // crowd murmur swells near any venue
  let prox = 0;
  for (const v of venues)
    prox = Math.max(prox, 1 - Math.hypot(v.x - player.pos.x, v.z - player.pos.z) / 45);
  AMB.crowdG.gain.value = AF(0.05 * Math.max(0, prox) * (0.75 + 0.25 * Math.sin(game.time * 0.6)));
  // surf grows as you approach the shore
  let waveAmt = 0;
  if (THEME && (THEME.waterfront || THEME.docks)) {
    const shoreX = THEME.waterfront ? 134 : -134;
    waveAmt = Math.max(0, 1 - Math.abs(player.pos.x - shoreX) / 60);
  }
  AMB.waveG.gain.value = AF(0.06 * waveAmt * (0.6 + 0.4 * Math.sin(game.time * 0.55)));
  // rain patter follows the live weather
  AMB.rainG.gain.value = AF(0.05 * Math.min(1, weather.amount / 900));
  // crickets after dark
  const cricket = NF > 0.6 ? 0.011 : 0;
  AMB.cricketG.gain.value = AF(cricket);
  AMB.cricketLfoG.gain.value = AF(cricket);
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
  const vol = Math.min(1, volume * 1.5); // punchier overall
  // crack
  const src = AC.createBufferSource();
  src.buffer = noiseBuffer(0.2);
  const lp = AC.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.setValueAtTime(freq * 5, t);
  lp.frequency.exponentialRampToValueAtTime(160, t + 0.18);
  const gain = AC.createGain();
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  src.connect(lp).connect(gain).connect(MASTER);
  src.start(t);
  // body
  const osc = AC.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(60, t + 0.09);
  const og = AC.createGain();
  og.gain.setValueAtTime(vol * 0.7, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  osc.connect(og).connect(MASTER);
  osc.start(t); osc.stop(t + 0.11);
  // sub-bass thump you feel in the chest
  const sub = AC.createOscillator();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(90, t);
  sub.frequency.exponentialRampToValueAtTime(38, t + 0.14);
  const sg = AC.createGain();
  sg.gain.setValueAtTime(vol * 0.9, t);
  sg.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  sub.connect(sg).connect(MASTER);
  sub.start(t); sub.stop(t + 0.18);
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
  osc.connect(g).connect(MASTER);
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
  osc.connect(g).connect(MASTER);
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
  src.connect(lp).connect(g).connect(MASTER);
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
    src.connect(filt).connect(g).connect(MASTER);
    src.start();
    return { src, g, filt };
  };
  musicNodes = { city: mkNode(cityBuf), club: mkNode(clubBuf) };
}
function updateMusic() {
  if (!musicNodes) return;
  let prox = 0;
  for (const zone of (musicZones.length ? musicZones : [clubPos])) {
    const d = Math.hypot(player.pos.x - zone.x, player.pos.z - zone.z);
    prox = Math.max(prox, 1 - d / 52);
  }
  prox = Math.max(0, prox);
  musicNodes.club.g.gain.value = AF(musicOn ? 0.5 * Math.pow(prox, 1.6) : 0);
  musicNodes.club.filt.frequency.value = AF(320 + Math.pow(prox, 2) * 11000) || 320;
  musicNodes.city.g.gain.value = AF(musicOn ? 0.05 * (1 - prox * 0.85) : 0);
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
  src.connect(lp).connect(g).connect(MASTER);
  src.start(t);
  const osc = AC.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(170, t);
  osc.frequency.exponentialRampToValueAtTime(55, t + 0.18);
  const og = AC.createGain();
  og.gain.setValueAtTime(0.3 * k, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  osc.connect(og).connect(MASTER);
  osc.start(t); osc.stop(t + 0.22);
}

let engineNodes = null;
function engineStart() {
  if (!AC || engineNodes) return;
  const osc = AC.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = 55;
  const osc2 = AC.createOscillator();      // detuned growl layer
  osc2.type = 'square';
  osc2.frequency.value = 27.5;
  const lp = AC.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 320;
  const g = AC.createGain();
  g.gain.value = 0.12;
  osc.connect(lp);
  osc2.connect(lp);
  lp.connect(g).connect(MASTER);
  osc.start(); osc2.start();
  engineNodes = { osc, osc2, g };
}
function engineUpdate(speed) {
  if (engineNodes) engineNodes.osc.frequency.value = 55 + Math.abs(speed) * 5.5;
}
function engineStop() {
  if (!engineNodes) return;
  engineNodes.osc.stop();
  if (engineNodes.osc2) engineNodes.osc2.stop();
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
    // vertical sky-reflection sheen sweeping across the glass
    const sheen = m.createLinearGradient(0, 0, S, 0);
    sheen.addColorStop(0, 'rgba(160,190,230,0)');
    sheen.addColorStop(0.42, 'rgba(160,190,230,.09)');
    sheen.addColorStop(0.55, 'rgba(205,225,248,.15)');
    sheen.addColorStop(0.72, 'rgba(160,190,230,0)');
    m.fillStyle = sheen; m.fillRect(0, 0, S, S);
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
        if (f > 0 && Math.random() < 0.3) {
          // balcony: concrete slab + iron railing in front of the window
          m.fillStyle = 'rgba(185,180,168,.6)';
          m.fillRect(wx - 6, wy + wh + 2, ww + 12, 4);
          m.fillStyle = 'rgba(24,26,30,.9)';
          m.fillRect(wx - 5, wy + wh * 0.5, ww + 10, 2); // top rail
          for (let px = wx - 5; px <= wx + ww + 5; px += 6)
            m.fillRect(px, wy + wh * 0.5, 2, wh * 0.5 + 4); // posts
        }
      }
    }
  } else if (style === 'adobe') {
    // desert plaster: warm sand walls, small arched windows, wooden lintels
    m.fillStyle = `hsl(${wall.h + Math.random() * 6}, ${wall.s}%, ${wall.l + Math.random() * 8}%)`;
    m.fillRect(0, 0, S, S);
    for (let i = 0; i < 2600; i++) {
      m.fillStyle = `rgba(${Math.random() < 0.5 ? '255,240,210' : '60,40,20'},${0.02 + Math.random() * 0.05})`;
      m.fillRect(Math.random() * S, Math.random() * S, 3, 2);
    }
    const BAYS = 6, bw = S / BAYS;
    for (let f = 0; f < FLOORS; f++) {
      // subtle weathering line between floors
      m.fillStyle = 'rgba(80,55,25,.14)';
      m.fillRect(0, f * fh + fh - 3, S, 3);
      for (let b = 0; b < BAYS; b++) {
        if (Math.random() < 0.25) continue; // plain wall bay
        const wx = b * bw + bw * 0.3, wy = f * fh + fh * 0.3;
        const ww = bw * 0.4, wh = fh * 0.48;
        // wooden lintel
        m.fillStyle = 'rgba(90,60,30,.85)';
        m.fillRect(wx - 4, wy - 5, ww + 8, 5);
        // arched window: rectangle with a rounded dome top
        const lit = Math.random() < 0.4 - f * 0.02;
        const col = lit ? `hsl(${hue}, 70%, ${55 + Math.random() * 20}%)` : '#241a10';
        m.fillStyle = col;
        m.fillRect(wx, wy + wh * 0.25, ww, wh * 0.75);
        m.beginPath();
        m.arc(wx + ww / 2, wy + wh * 0.25, ww / 2, Math.PI, 0);
        m.fill();
        if (lit) {
          e.fillStyle = col;
          e.fillRect(wx, wy + wh * 0.25, ww, wh * 0.75);
          e.beginPath();
          e.arc(wx + ww / 2, wy + wh * 0.25, ww / 2, Math.PI, 0);
          e.fill();
          // wooden mashrabiya bars
          m.fillStyle = 'rgba(60,40,20,.55)';
          m.fillRect(wx + ww / 2 - 1, wy, 2, wh);
          m.fillRect(wx, wy + wh * 0.55, ww, 2);
        }
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
const FACADE_STYLES = {}; // per-style pools so districts can look different
// Four distinct districts per city: glass financial towers NE, low warm
// old town NW, mixed market SE, residential blocks with balconies SW.
function districtOf(x, z) {
  const strong = THEME.hMax > 26 ? 1 : 0.45; // flat desert cities vary less
  if (x >= 0 && z >= 0) return { style: 'curtain', hMul: 1 + 0.85 * strong };
  if (x < 0 && z >= 0) return { style: THEME.styles.adobe ? 'adobe' : 'brick', hMul: 1 - 0.45 * strong };
  if (x >= 0 && z < 0) return { style: 'punched', hMul: 1 };
  return { style: 'brick', hMul: 1 - 0.3 * strong };
}

const SHOP_NAMES = ['LE ROYAL CAFÉ', 'GRAND GALLERIA', 'CROWN PIZZA', 'VELVET BARBER', 'PLATINUM GYM', 'LUXE MOBILE', 'DIAMOND BISTRO', 'IVORY PHARMACY'];
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
  if (!sponsor.logo) {
    g.fillStyle = '#ffffff';
    g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 12;
    g.font = '800 58px Arial';
    g.fillText(sponsor.name, 256, 130, 470);
    g.font = '400 30px Arial';
    g.fillStyle = 'rgba(255,255,255,.85)';
    g.fillText(sponsor.tagline, 256, 180, 470);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (sponsor.logo) {
    const img = new Image();
    img.onload = () => {
      // the logo IS the billboard — no duplicate text, near full-bleed
      const s = Math.min(480 / img.width, 220 / img.height);
      g.drawImage(img, 256 - img.width * s / 2, 128 - img.height * s / 2, img.width * s, img.height * s);
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
const trafficLamps = [];   // intersection signals cycling red/green
const billboardRoofs = []; // flat roofs suitable for a lit sponsor board
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
function towerSection(x, yBase, z, w, d, h, fac, style) {
  const pool = style && FACADE_STYLES[style] && FACADE_STYLES[style].length && Math.random() < 0.75
    ? FACADE_STYLES[style] : FACADES;
  fac = fac || pool[Math.floor(Math.random() * pool.length)];
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
  if (THEME.arch === 'arabic') {
    // traditional roofline: raised parapet, corner posts, domes, wind towers
    const mSand = new THREE.MeshStandardMaterial({ color: 0xc4a670, roughness: 0.9 });
    const lip2 = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, 0.8, d + 0.4), mSand);
    lip2.position.set(x, yTop + 0.4, z);
    scene.add(lip2);
    for (const [cx2, cz2] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.3, 0.5), mSand);
      post.position.set(x + cx2 * (w / 2 - 0.1), yTop + 0.65, z + cz2 * (d / 2 - 0.1));
      scene.add(post);
    }
    if (Math.random() < 0.3) {
      const dome = new THREE.Mesh(new THREE.SphereGeometry(Math.min(w, d) * 0.22, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0xd8e0e2, roughness: 0.4, metalness: 0.2 }));
      dome.position.set(x, yTop + 0.8, z);
      dome.castShadow = true;
      scene.add(dome);
    } else if (Math.random() < 0.4) {
      // barjeel wind tower
      const tower = new THREE.Mesh(new THREE.BoxGeometry(1.4, 3.2, 1.4), mSand);
      tower.position.set(x + (Math.random() - 0.5) * w * 0.4, yTop + 1.6, z + (Math.random() - 0.5) * d * 0.4);
      tower.castShadow = true;
      scene.add(tower);
      const slot = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.9, 0.3),
        new THREE.MeshStandardMaterial({ color: 0x2a1d10, roughness: 1 }));
      slot.position.copy(tower.position);
      slot.position.y += 0.9;
      scene.add(slot);
    }
    return;
  }
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
  if (yTop > 14 && yTop < 48 && Math.min(w, d) > 8)
    billboardRoofs.push({ x, y: yTop, z, w: Math.min(w, d) });
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
function addBuilding(x, z, w, d, h, face, style) {
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
    fac = towerSection(x, yBase, z, cw, cd, sh, fac, style);
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
  // garage-only collectibles (reuse the base silhouettes with their own stats)
  pickup:  { label: 'TITAN PICKUP', maxF: 30, maxR: -9,  accel: 14, turn: 1.4,  camH: 1.62, size: [2.1, 4.8], engine: true, freq: 42, radius: 1.55, kill: 2.6 },
  muscle:  { label: 'V8 STALLION',  maxF: 41, maxR: -10, accel: 21, turn: 1.6,  camH: 1.2,  size: [2.0, 4.5], engine: true, freq: 62, radius: 1.45, kill: 2.3 },
  offroad: { label: 'DUNE RAIDER',  maxF: 38, maxR: -10, accel: 19, turn: 1.55, camH: 1.62, size: [2.1, 4.6], engine: true, freq: 58, radius: 1.55, kill: 2.6 },
  gtr:     { label: 'APEX GT-R',    maxF: 48, maxR: -10, accel: 26, turn: 1.72, camH: 1.1,  size: [2.0, 4.3], engine: true, freq: 82, radius: 1.4,  kill: 2.2 },
  royal:   { label: 'ROYAL PHANTOM', maxF: 36, maxR: -8, accel: 15, turn: 1.4,  camH: 1.5,  size: [2.1, 5.2], engine: true, freq: 42, radius: 1.55, kill: 2.5 },
};
const CAR_STYLE_COLORS = {
  car:    [0x7a2f2f, 0x2f4a7a, 0x565b60, 0x6d6437, 0x3b4b41, 0x802a48, 0x1d5c66],
  suv:    [0x8a7a5c, 0x4a4a42, 0x2e3438, 0x5c5348, 0x3d4a3a, 0xd8d4c8],
  sports: [0xc41e1e, 0xe0b41e, 0xd84a10, 0x14161a, 0xd8d8d8],
  hyper:  [0xf0a814, 0xf07800, 0x1a1c20, 0xb8bcc4, 0x38c04a],
  luxury: [0x0e1013, 0xe8e8ea, 0xb8bcc2, 0x1c2436, 0x2e2226],
  phantom: [0x101216, 0xe8d8c8, 0xdfe2e6, 0x24182a, 0x2a2018],
  pickup:  [0x8a2a1e, 0x2e3438, 0x5c5348, 0xd8d4c8],
  muscle:  [0x111318, 0xc41e1e, 0x2f4a7a, 0xe0b41e],
  offroad: [0xc46a14, 0x8a7a5c, 0x3d4a3a, 0xe8e8ea],
  gtr:     [0x14161a, 0xd8d8d8, 0x38c04a, 0xc41e1e],
  royal:   [0xd8b21e, 0x101216, 0xe8d8c8],
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
  // collectible types borrow an existing body shape; stats/colors stay their own
  const SILHOUETTE = { pickup: 'suv', muscle: 'sports', offroad: 'suv', gtr: 'sports', royal: 'phantom' };
  style = SILHOUETTE[style] || style;
  const g = new THREE.Group();
  // physical clearcoat = real automotive paint under the environment reflections
  const mBody = new THREE.MeshPhysicalMaterial({
    color: bodyColor, roughness: 0.32, metalness: 0.85,
    clearcoat: 1.0, clearcoatRoughness: 0.06 });
  const mDark = new THREE.MeshStandardMaterial({ color: 0x11151a, roughness: 0.6 });
  const mCab = new THREE.MeshStandardMaterial({ color: 0x0d141c, roughness: 0.08, metalness: 0.85 });
  const mChrome = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.15, metalness: 0.9 });
  const mHub = new THREE.MeshStandardMaterial({ color: 0x8a9099, roughness: 0.25, metalness: 0.85 });
  // rounded panels so bodies read as real sheet metal, not boxes
  const RB = (w, h, d, r) => new RoundedBoxGeometry(w, h, d, 3, r);

  const wheels = [];
  const wheel = (wx, wz, r) => {
    // spin group pivots at the axle so wheels can roll
    const spin = new THREE.Group();
    spin.position.set(wx, r, wz);
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.26, 16), mDark);
    tire.rotation.z = Math.PI / 2;
    spin.add(tire);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, 0.27, 12), mHub);
    hub.rotation.z = Math.PI / 2;
    spin.add(hub);
    g.add(spin);
    wheels.push({ grp: spin, r });
  };
  g.userData.wheels = wheels;
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
  if (THEME && THEME.luxCars) // gulf money: mostly exotics on the road
    return r < 0.2 ? 'luxury' : r < 0.45 ? 'sports' : r < 0.7 ? 'phantom' : r < 0.9 ? 'hyper' : 'suv';
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
    fuel: 70 + Math.random() * 30,
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
  g.userData.wheels = [];
  for (const wz of [0.72, -0.72]) {
    const spin = new THREE.Group();
    spin.position.set(0, 0.26, wz);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.12, 12), mDark);
    wheel.rotation.z = Math.PI / 2;
    spin.add(wheel);
    g.add(spin);
    g.userData.wheels.push({ grp: spin, r: 0.26 });
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
  g.userData.wheels = [];
  for (const wz of [0.62, -0.62]) {
    const spin = new THREE.Group();
    spin.position.set(0, 0.33, wz);
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.03, 6, 16), mDark);
    wheel.rotation.y = Math.PI / 2;
    spin.add(wheel);
    g.add(spin);
    g.userData.wheels.push({ grp: spin, r: 0.33 });
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
// Real 3D assets (models/*.glb): hero cars + real characters
// ---------------------------------------------------------------------------
VEH_STATS.merc = { label: CLEAN ? 'E50 EXECUTIVE' : 'E50 AMG', maxF: 40, maxR: -9, accel: 18, turn: 1.55, camH: 1.3,
  size: [2.0, 4.8], engine: true, freq: 58, radius: 1.5, kill: 2.4 };
VEH_STATS.police = { label: 'POLICE INTERCEPTOR', maxF: 52, maxR: -10, accel: 28, turn: 1.8, camH: 1.05,
  size: [2.0, 4.6], engine: true, freq: 92, radius: 1.4, kill: 2.2 };
const gltfLoader = new GLTFLoader();
gltfLoader.setMeshoptDecoder(MeshoptDecoder);
const MERC_ORIENT = 0; // model-forward correction, tuned visually
function normalizeModel(root, kind, target) {
  const box = new THREE.Box3().setFromObject(root);
  const dim = box.getSize(new THREE.Vector3());
  const s = kind === 'car' ? target / Math.max(dim.x, dim.z) : target / dim.y;
  root.scale.setScalar(s);
  root.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(root);
  const c = box2.getCenter(new THREE.Vector3());
  root.position.x -= c.x;
  root.position.z -= c.z;
  root.position.y -= box2.min.y;
  root.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return root;
}
let mercTemplate = null;
let camelTemplate = null;
let policeTemplate = null;
let dobermanTemplate = null;
let skylineTemplate = null;
const personTemplates = [];
function loadRealAssets() {
  if (SAFEMODE) {
    addFeed(IS_IOS && !HQ_ON ? '⚡ PHONE MODE — light graphics (HIGH QUALITY toggle on the menu)'
      : '⚡ SAFE MODE — light graphics after a crash; reload once to try full quality');
    return;
  }
  gltfLoader.load('models/car_mercedes.glb', g => {
    mercTemplate = normalizeModel(g.scene, 'car', 4.8);
    spawnMercFleet();
  }, undefined, () => {});
  gltfLoader.load('models/car_police.glb', g => {
    policeTemplate = normalizeModel(g.scene, 'car', 4.6);
    spawnPolice();
  }, undefined, () => {});
  loadHeroCars();
  gltfLoader.load('models/dog_doberman.glb', g => {
    dobermanTemplate = normalizeModel(g.scene, 'person', 0.85);
    placeGuardDogs();
  }, undefined, () => {});
  // real textured skyline panoramas ring the modern cities
  if (!THEME.camels)
    if (!LOWMEM) gltfLoader.load('models/city_buildings.glb', g => {
      skylineTemplate = normalizeModel(g.scene, 'car', 165);
      placeSkyline();
    }, undefined, () => {});
  // the real Burj Khalifa rises over Dubai (needle tower as fallback)
  if (THEME.landmark && THEME.landmark.kind === 'burj' && !LOWMEM)
    gltfLoader.load('models/burj_khalifa.glb', g => {
      stripBaseDiscs(g.scene);
      const root = normalizeModel(g.scene, 'person', 135);
      root.position.x += THEME.landmark.x;
      root.position.z += THEME.landmark.z;
      scene.add(root);
      const { x, z } = THEME.landmark;
      addCollider(new THREE.Box3(
        new THREE.Vector3(x - 9, 0, z - 9), new THREE.Vector3(x + 9, 135, z + 9)));
      addFeed('🏙 The tallest tower in the world pierces the sky');
    }, undefined, () => addNeedleTower(THEME.landmark.x, THEME.landmark.z));
  for (const url of ['models/person_cool.glb', 'models/person_suit.glb'])
    gltfLoader.load(url, g => {
      stripBaseDiscs(g.scene);
      lockWalkRoot(g.animations || []);
      personTemplates.push({ root: normalizeModel(g.scene, 'person', 1.78), clips: g.animations || [] });
      placeRealPeople();
    }, undefined, () => {});
  // Real animated characters. These skinned models don't all survive
  // SkeletonUtils.clone, so each instance parses its own browser-cached
  // copy of the file.
  // androids in colored streetwear walk the avenues (the military patrol
  // that used to sprint everywhere never fit a delivery city)
  const XBOT_TINTS = [0x4a86d8, 0x35a061, 0xd8823a, 0x9455d8];
  for (let i = 0; i < 4; i++)
    loadWalker('models/person_xbot.glb', {
      height: 1.75, clip: /^walk/i, tint: XBOT_TINTS[i],
      walker: { s: STREETS[(i * 2 + 1) % STREETS.length], alongX: i % 2 === 0,
        dir: Math.random() < 0.5 ? 1 : -1, side: (i % 3 - 1 || 1) * (ROAD_HALF + 2.0),
        v: -100 + Math.random() * 200, speed: 1.4 },
    });
  // charming delivery bots carrying pizza boxes on their routes
  for (let i = 0; i < 3; i++)
    loadWalker('models/robot_courier.glb', {
      height: 1.5, clip: /^walking/i,
      attach: root => {
        // counter the root scale so the box stays pizza-sized
        const inv = 1 / root.scale.x;
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.075, 0.34),
          new THREE.MeshStandardMaterial({ color: 0xf2ece0, roughness: 0.8 }));
        box.scale.setScalar(inv);
        box.position.set(0, 0.98 * inv, 0.32 * inv);
        root.add(box);
      },
      walker: { s: STREETS[(i * 2) % STREETS.length], alongX: i % 2 === 1,
        dir: Math.random() < 0.5 ? 1 : -1, side: (i % 2 ? 1 : -1) * (ROAD_HALF + 1.5),
        v: -90 + Math.random() * 180, speed: 1.2 },
    });
  // one bot waves customers into the restaurant strip
  loadWalker('models/robot_courier.glb', {
    height: 1.5, clip: /^wave/i, place: { pos: [51.2, 0, 30], ry: -Math.PI / 2 } });
  // clean android pedestrians with proper walk cycles
  for (let i = 0; i < 3; i++)
    loadWalker('models/person_xbot.glb', {
      height: 1.75, clip: /^walk/i,
      walker: { s: STREETS[(i * 2 + 1) % STREETS.length], alongX: i % 2 === 1,
        dir: Math.random() < 0.5 ? 1 : -1, side: (i % 2 ? 1 : -1) * (ROAD_HALF + 2.6),
        v: -90 + Math.random() * 180, speed: 1.4 },
    });
  // real samba dancers at the club and the live stage
  loadWalker('models/person_dancer.glb', {
    height: 1.7, clip: /samba/i, place: { pos: [-9.9, 0, -41.5], ry: Math.PI / 2 } });
  loadWalker('models/person_dancer.glb', {
    height: 1.7, clip: /samba/i, place: { pos: [-31.6, 0, 71], ry: Math.PI } });
  // horses gallop through the desert medina
  if (THEME.camels)
    for (let i = 0; i < 2; i++)
      loadWalker('models/horse.glb', {
        height: 1.6, faceOffset: Math.PI / 2, clip: /./,
        walker: { s: STREETS[(i * 3) % STREETS.length], alongX: i % 2 === 0,
          dir: 1, side: (i % 2 ? 1 : -1) * (ROAD_HALF + 1.8), v: -80 + i * 60, speed: 6 },
      });
  // ---- the sky is alive: flocks of real animated birds over the rooftops ----
  for (let i = 0; i < (LOWMEM ? 1 : 2); i++) {
    loadGlider('models/bird_parrot.glb', { size: 0.9, alt: 18 + i * 6, r: 42 + i * 22,
      cx: -30 + i * 60, cz: 20 - i * 60, speed: 5, bob: 1.2, off: Math.PI / 2 });
    if (!LOWMEM)
      loadGlider('models/bird_stork.glb', { size: 1.5, alt: 28 + i * 7, r: 58 + i * 26,
        cx: 20 - i * 50, cz: -30 + i * 70, speed: 6.5, bob: 1.5, off: Math.PI / 2 });
  }
  // flamingos glide low along the waterfront
  if (THEME.waterfront === 'east')
    for (let i = 0; i < 2; i++)
      loadGlider('models/bird_flamingo.glb', { size: 1.1, alt: 13 + i * 4, r: 34,
        cx: 105, cz: -40 + i * 80, speed: 4.5, bob: 1, off: Math.PI / 2 });
  // a stunt plane loops high above every city
  loadGlider('models/plane_stunt.glb', { size: 7, alt: 76, r: 112, speed: 16,
    bob: 2.5, off: Math.PI / 2, bank: -0.22 });
  // a shark patrols the bay, fin cutting the surface
  if (THEME.waterfront === 'east')
    loadGlider('models/shark.glb', { size: 3.4, alt: -0.35, r: 16, cx: 165, cz: 25,
      speed: 2.2, off: Math.PI / 2 });
  // ...and something unexplained circles the desert sky
  if (THEME.camels)
    loadGlider('models/ufo.glb', { size: 6, alt: 55, r: 70, speed: 4, bob: 3 });
  // a courier robot breaks into dance at the park — same family as the
  // delivery bots so the robot cast stays consistent
  loadWalker('models/robot_courier.glb', {
    height: 1.5, clip: /dance/i, place: { pos: [-33.8, 0, 71], ry: Math.PI } });
  // a third samba dancer works the club queue (same dancer family)
  loadWalker('models/person_dancer.glb', {
    height: 1.7, clip: /samba/i, place: { pos: [-12.2, 0, -43], ry: Math.PI / 2 } });
  // a fox lives in the park
  gltfLoader.load('models/fox.glb', g => {
    const root = g.scene;
    const fbox = new THREE.Box3().setFromObject(root);
    root.scale.setScalar(0.65 / fbox.getSize(new THREE.Vector3()).y);
    root.traverse(o => { if (o.isMesh) o.castShadow = true; });
    scene.add(root);
    const clips = g.animations || [];
    const walk = clips.find(c => /walk/i.test(c.name)) || clips[0];
    const mixer = new THREE.AnimationMixer(root);
    if (walk) mixer.clipAction(walk).play();
    modelMixers.push(mixer);
    modelWanderers.push({ obj: root, off: -Math.PI / 2, cx: PLAZAS[2].x, cz: PLAZAS[2].z,
      ang: Math.random() * 6, r: 10, speed: 0.9 });
  }, undefined, () => {});
  // desert-city assets load only where the theme wants them
  if (THEME.camels)
    gltfLoader.load('models/camel.glb', g => {
      const root = g.scene;
      // The raw bounding box of this model is thrown far off by bind-pose
      // offsets (it floated in mid-air). Measure the posed skeleton instead:
      // its foot IK bones sit exactly at ground level.
      const clips = g.animations || [];
      const walk = clips.find(a => /walk/i.test(a.name)) || clips[0];
      if (walk) {
        const mx = new THREE.AnimationMixer(root);
        mx.clipAction(walk).play();
        mx.update(0);
      }
      root.rotation.y = Math.PI; // model faces -Z; game forward is +Z
      const box = boneBounds(root);
      const dim = box.getSize(new THREE.Vector3());
      const s = 1.85 / dim.y; // bone height; the hump tops out around 2m
      root.scale.setScalar(s);
      const c = box.getCenter(new THREE.Vector3());
      root.position.set(-c.x * s, -box.min.y * s, -c.z * s);
      root.traverse(o => { if (o.isMesh) o.castShadow = true; });
      camelTemplate = { root, clips };
      upgradeCamels();
    }, undefined, () => {});
  // (the arabic-man model was retired — it never posed cleanly; the robed
  // procedural locals in desert cities carry the look instead)
}
function boneBounds(root) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse(o => { if (o.isBone) box.expandByPoint(o.getWorldPosition(v)); });
  return box;
}
// Mixamo-style walk clips move the hips forward then snap back at the loop
// point, which reads as the character "cutting" his walk. Lock the hips to
// their starting x/z (keeping the vertical bob) so patrol movement is smooth.
function lockWalkRoot(clips) {
  for (const c of clips)
    for (const t of c.tracks)
      if (/hips/i.test(t.name) && /\.position$/.test(t.name)) {
        const v = t.values;
        for (let i = 3; i < v.length; i += 3) { v[i] = v[0]; v[i + 2] = v[2]; }
      }
}
// Some character exports ship with a flat pedestal disc under the feet —
// looks like a black puddle on the sidewalk. Detect and drop those meshes.
function stripBaseDiscs(root) {
  root.updateMatrixWorld(true);
  const whole = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  const drop = [];
  root.traverse(o => {
    if (!o.isMesh) return;
    const size = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
    const wide = Math.max(size.x, size.z);
    if (size.y < 0.06 * wide && wide > 0.25 * whole.y) drop.push(o);
  });
  for (const m of drop) m.parent.remove(m);
}
// Swap the procedural camels for the real scanned model once it arrives,
// keeping each caravan's route and pacing.
function upgradeCamels() {
  if (!camelTemplate) return;
  const picks = pickClips(camelTemplate.clips);
  for (const c of camels) {
    scene.remove(c.rig.group);
    const wrap = new THREE.Group();
    const m = SkeletonUtils.clone(camelTemplate.root);
    wrap.add(m);
    scene.add(wrap);
    c.rig = { group: wrap, legs: null };
    const clip = picks.walk || picks.any;
    if (clip) {
      const mixer = new THREE.AnimationMixer(m);
      const a = mixer.clipAction(clip);
      a.time = Math.random() * clip.duration; // desync the caravan
      a.play();
      modelMixers.push(mixer);
    }
  }
  addFeed('🐪 Camel caravans crossing the medina');
}
const realWalkers = []; // animated characters walking the sidewalk lanes
// Generic loader for animated characters that must not be cloned: each
// instance parses its own copy (browser-cached). Mirrors the verified
// viewer flow exactly: the scene root is scaled and positioned directly
// (no wrapper group — some skinned rigs explode inside one). The
// model's authored facing is handled as a per-frame yaw offset.
// opts: height, faceOffset, clip (regex), attach(root),
//       walker {lane fields} or place {pos, ry}.
const walkerFiles = {}; // one fetch per url; each instance parses its own copy
function loadWalker(url, opts) {
  (walkerFiles[url] = walkerFiles[url] || fetch(url).then(r => r.arrayBuffer()))
    .then(buf => {
      // a FRESH loader per parse: sharing one GLTFLoader across parses of
      // the same file corrupts the skinned rigs (the giant-blob bug)
      const l = new GLTFLoader();
      l.setMeshoptDecoder(MeshoptDecoder);
      l.parse(buf.slice(0), '', g => onWalkerLoaded(g, opts), () => {});
    })
    .catch(() => {});
}
// Circling movers — birds, aircraft, sharks: unskinned animated models that
// patrol a circle at a given altitude via the modelWanderers update
function loadGlider(url, o) {
  (walkerFiles[url] = walkerFiles[url] || fetch(url).then(r => r.arrayBuffer()))
    .then(buf => {
      const l = new GLTFLoader();
      l.setMeshoptDecoder(MeshoptDecoder);
      l.parse(buf.slice(0), '', g => {
        const root = g.scene;
        const dim = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
        const span = Math.max(dim.x, dim.y, dim.z, 0.001);
        root.scale.setScalar(o.size / span);
        root.traverse(m => { if (m.isMesh) m.castShadow = true; });
        scene.add(root);
        if (g.animations && g.animations.length) {
          const mixer = new THREE.AnimationMixer(root);
          const act = mixer.clipAction(g.animations[0]);
          act.time = Math.random() * g.animations[0].duration;
          act.play();
          modelMixers.push(mixer);
        }
        modelWanderers.push({ obj: root, off: o.off || 0,
          cx: o.cx || 0, cz: o.cz || 0, ang: Math.random() * 6.28,
          r: o.r * (0.85 + Math.random() * 0.3), alt: o.alt || 0,
          bob: o.bob, bank: o.bank, speed: o.speed });
      }, () => {});
    })
    .catch(() => {});
}
function onWalkerLoaded(g, opts) {
  {
    lockWalkRoot(g.animations || []);
    const root = g.scene;
    // rig exports disagree about size: mixamo rigs report a broken tiny
    // mesh box but true bone bounds, the robot rig reports the opposite.
    // The larger of the two is always the real displayed height.
    const rawY = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).y;
    const boneY = boneBounds(root).getSize(new THREE.Vector3()).y;
    const trueY = Math.max(
      Number.isFinite(rawY) ? rawY : 0,
      Number.isFinite(boneY) ? boneY : 0);
    if (trueY <= 0.001) return; // bad parse — drop it
    root.scale.setScalar(opts.height / trueY);
    root.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true;
      if (opts.tint && o.material && o.material.color) {
        o.material = o.material.clone();
        o.material.color.multiply(new THREE.Color(opts.tint));
      }
    });
    scene.add(root);
    const clips = g.animations || [];
    const clip = clips.find(c => opts.clip.test(c.name)) || clips[0];
    const mixer = new THREE.AnimationMixer(root);
    if (clip) {
      const a = mixer.clipAction(clip);
      a.time = Math.random() * clip.duration;
      a.play();
    }
    modelMixers.push(mixer);
    if (opts.attach) opts.attach(root);
    if (opts.walker) realWalkers.push({ obj: root, off: opts.faceOffset || 0, jit: 0,
      ...opts.walker, side: opts.walker.side + (Math.random() - 0.5) * 1.2 });
    else if (opts.place) {
      root.position.set(opts.place.pos[0], opts.place.pos[1], opts.place.pos[2]);
      root.rotation.y = opts.place.ry + (opts.faceOffset || 0);
    }
  }
}
const modelMixers = [];   // animation players for real character models
const modelBobbers = [];  // fallback idle for models without animations
const modelWanderers = []; // characters walking a patrol with their walk clip
const gestureCyclers = []; // characters cycling through gesture clips
function pickClips(clips) {
  const usable = clips.filter(c => !/pose|bind|t-?pose/i.test(c.name));
  return {
    walk: usable.find(c => /walk|run/i.test(c.name)) || null,
    gestures: usable.filter(c => !/walk|run|sit/i.test(c.name)),
    any: usable[0] || clips[0] || null,
  };
}
function spinWheels(group, dist) {
  const ws = group.userData.wheels;
  if (ws) for (const w of ws) w.grp.rotation.x += dist / w.r;
  const nodes = group.userData.wheelNodes;
  if (nodes) for (const n of nodes) n.rotation.x += dist / 0.33;
}
function collectWheelNodes(root) {
  // GLB wheel meshes often pivot at the car origin — spinning them there
  // makes wheels orbit the body. Re-pivot each wheel at its own center.
  const nodes = [];
  root.updateMatrixWorld(true);
  const candidates = [];
  root.traverse(o => { if (o.isMesh && /wheel|tyre|tire|rim/i.test(o.name)) candidates.push(o); });
  for (const mesh of candidates) {
    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    if (Math.max(size.x, size.y, size.z) > 1.4 || Math.max(size.x, size.y, size.z) < 0.05) continue;
    const center = box.getCenter(new THREE.Vector3());
    const parent = mesh.parent;
    const pivot = new THREE.Group();
    parent.add(pivot);
    pivot.position.copy(parent.worldToLocal(center.clone()));
    pivot.updateMatrixWorld(true);
    pivot.attach(mesh); // keeps the wheel exactly where it was
    nodes.push(pivot);
  }
  return nodes;
}

let mercSpawned = false;
function spawnMercFleet() {
  if (mercSpawned || !mercTemplate || !CITY) return;
  mercSpawned = true;
  const spots = [[5.1, 12, 0], [-5.1, -12, Math.PI], [65.1, 22, 0], [-54.9, 58, Math.PI], [5.1, -58, 0]];
  for (const [x, z, ry] of spots) {
    const wrap = new THREE.Group();
    const m = SkeletonUtils.clone(mercTemplate);
    m.rotation.y = MERC_ORIENT;
    wrap.add(m);
    wrap.userData.wheelNodes = collectWheelNodes(m);
    registerVehicle(wrap, x, z, ry, 'merc');
  }
  // parked procedural sedans get upgraded to the real car too — the
  // boxy ones read cheap next to it
  let parked = 0;
  for (const v of vehicles) {
    if (parked >= 6) break;
    if ((v.type === 'car' || v.type === 'luxury') && Math.random() < 0.5) {
      const g3 = new THREE.Group();
      const m3 = SkeletonUtils.clone(mercTemplate);
      m3.rotation.y = MERC_ORIENT;
      g3.add(m3);
      g3.userData.wheelNodes = collectWheelNodes(m3);
      g3.position.copy(v.group.position);
      g3.rotation.y = v.yaw;
      scene.remove(v.group);
      v.group = g3;
      scene.add(g3);
      parked++;
    }
  }
  // and put more E50s into moving traffic
  let converted = 0;
  for (const c of traffic) {
    if (converted >= 8) break;
    if (Math.random() < 0.6) {
      const g2 = new THREE.Group();
      const m2 = SkeletonUtils.clone(mercTemplate);
      m2.rotation.y = MERC_ORIENT;
      g2.add(m2);
      g2.userData.wheelNodes = collectWheelNodes(m2);
      g2.position.copy(c.group.position);
      g2.rotation.y = c.group.rotation.y;
      scene.remove(c.group);
      c.group = g2;
      scene.add(g2);
      converted++;
    }
  }
  addFeed(CLEAN ? '🏎 E50 EXECUTIVE fleet spotted around the city' : '🏎 E50 AMG fleet spotted around the city');
}
// Hero cars — every real car model uploaded to models/ becomes a drivable
// showpiece parked around the city (plus feed announcements)
const HERO_CARS = [
  // BMW X7 removed: its export has a door welded open in every pose
  // Challenger removed too — the export sat tilted and read badly
  { file: 'models/car_concept.glb', key: 'hero_concept', base: 'hyper', len: 4.7, label: 'CONCEPT X',
    spots: [[125.1, 40, 0], [5.1, 84, 0], [-65.1, -20, Math.PI]] },
  { file: 'models/car_lambo.glb', key: 'hero_lambo', base: 'hyper', len: 4.6, label: 'TORO SV',
    tint: 0xf07800, spots: [[-125.1, 62, 0], [65.1, 100, Math.PI], [65.1, 14, 0]] },
];
function loadHeroCars() {
  for (const hc of HERO_CARS) {
    VEH_STATS[hc.key] = { ...VEH_STATS[hc.base], label: hc.label };
    gltfLoader.load(hc.file, g => {
      const root = g.scene;
      // untextured models get a hot metallic paint job
      if (hc.tint)
        root.traverse(o => {
          if (o.isMesh && o.material) {
            o.material = o.material.clone();
            o.material.color = new THREE.Color(hc.tint);
            o.material.metalness = 0.6;
            o.material.roughness = 0.35;
          }
        });
      // never play built-in clips (door-opening animations etc.) — the
      // authored rest pose has everything closed
      if (hc.rotY) root.rotation.y = hc.rotY;
      const tpl = normalizeModel(root, 'car', hc.len);
      for (const [x, z, ry] of hc.spots) {
        const wrap = new THREE.Group();
        const m = SkeletonUtils.clone(tpl);
        wrap.add(m);
        wrap.userData.wheelNodes = collectWheelNodes(m);
        registerVehicle(wrap, x, z, ry, hc.key);
      }
      addFeed(`🚗 ${hc.label} spotted around the city`);
    }, undefined, () => {});
  }
}
// Police supercars parked on patrol — real Dubai Police Aventador model,
// drivable at high level, light bars strobing red/blue
const policeLights = [];
let policeSpawned = false;
function spawnPolice() {
  if (policeSpawned || !policeTemplate || !CITY) return;
  policeSpawned = true;
  const spots = [[-5.1, 44, Math.PI], [65.1, -36, 0], [-65.1, 96, Math.PI]];
  for (const [x, z, ry] of spots) {
    const wrap = new THREE.Group();
    const m = SkeletonUtils.clone(policeTemplate);
    wrap.add(m);
    wrap.userData.wheelNodes = collectWheelNodes(m);
    // strobing light bar
    const red = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.09, 0.22),
      new THREE.MeshBasicMaterial({ color: 0xff2222 }));
    red.position.set(-0.22, 1.18, -0.3);
    const blue = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.09, 0.22),
      new THREE.MeshBasicMaterial({ color: 0x2266ff }));
    blue.position.set(0.22, 1.18, -0.3);
    wrap.add(red); wrap.add(blue);
    policeLights.push({ red, blue, phase: Math.random() });
    registerVehicle(wrap, x, z, ry, 'police');
  }
  addFeed('🚓 Police interceptors on patrol');
}
// Distant downtown skylines built from the real building pack, one along
// each open edge of the map — the city no longer ends at the perimeter
let skylinePlaced = false;
function placeSkyline() {
  if (skylinePlaced || !skylineTemplate || !CITY) return;
  skylinePlaced = true;
  const spots = [[0, -235, 0], [0, 235, Math.PI]];
  if (THEME.waterfront !== 'east') spots.push([235, 0, -Math.PI / 2]);
  if (THEME.docks !== 'west') spots.push([-235, 0, Math.PI / 2]);
  for (const [x, z, ry] of spots) {
    const wrap = new THREE.Group();
    wrap.add(SkeletonUtils.clone(skylineTemplate));
    wrap.position.set(x, 0, z);
    wrap.rotation.y = ry;
    scene.add(wrap);
  }
}
// Doberman guard dogs watching the doors of the busiest venues
let dogsPlaced = false;
function placeGuardDogs() {
  if (dogsPlaced || !dobermanTemplate) return;
  dogsPlaced = true;
  const posts = [[-9.4, -48.5, Math.PI / 2], [9.4, 50.5, -Math.PI / 2], [-28, 73.5, Math.PI]];
  for (const [x, z, ry] of posts) {
    const d = SkeletonUtils.clone(dobermanTemplate);
    const pos = new THREE.Vector3(x, 0, z);
    resolveCollisions(pos, 0.8, 0.4);
    d.position.set(pos.x, 0, pos.z);
    d.rotation.y = ry;
    scene.add(d);
    modelBobbers.push({ obj: d, phase: Math.random() * 6, baseY: 0, baseRot: ry, amp: 0.22 });
  }
}
let realPeoplePlaced = false;
function placeRealPeople() {
  if (realPeoplePlaced || personTemplates.length < 1 || !CITY) return;
  realPeoplePlaced = true;
  // doormen and regulars at the venues
  const posts = [[-10.2, -41, Math.PI / 2], [-9.8, 17.5, Math.PI / 2], [10.2, -13, -Math.PI / 2], [9.9, 47, -Math.PI / 2]];
  posts.forEach(([x, z, ry], i) => {
    const t = personTemplates[i % personTemplates.length];
    const p = SkeletonUtils.clone(t.root);
    p.position.set(x, 0, z);
    p.rotation.y = ry;
    scene.add(p);
    const picks = pickClips(t.clips);
    if (picks.walk && i % 2 === 0) {
      // walk a patrol loop around the post using the model's own walk cycle
      const mixer = new THREE.AnimationMixer(p);
      mixer.clipAction(picks.walk).play();
      modelMixers.push(mixer);
      modelWanderers.push({ obj: p, cx: x + 2, cz: z, ang: Math.random() * 6, r: 2.5 + Math.random() * 1.5, speed: 0.55 });
    } else if (picks.gestures.length) {
      // stand at the post cycling through its gesture animations
      const mixer = new THREE.AnimationMixer(p);
      const actions = picks.gestures.map(c => mixer.clipAction(c));
      actions[0].play();
      modelMixers.push(mixer);
      gestureCyclers.push({ actions, cur: 0, t: 4 + Math.random() * 4 });
    } else if (picks.any) {
      const mixer = new THREE.AnimationMixer(p);
      mixer.clipAction(picks.any).play();
      modelMixers.push(mixer);
    } else {
      // no animation data at all: visible natural idle (sway, breathe, look around)
      modelBobbers.push({ obj: p, phase: Math.random() * 6, baseY: 0, baseRot: ry });
    }
  });
}

// ---------------------------------------------------------------------------
// AI traffic — cars cruising the lanes, braking for the player
// ---------------------------------------------------------------------------
const traffic = [];
function spawnTraffic() {
  for (let i = 0; i < 20; i++) {
    const s = STREETS[Math.floor(Math.random() * STREETS.length)];
    const alongX = Math.random() < 0.5;
    const dir = Math.random() < 0.5 ? 1 : -1;
    const lane = 3.5 * dir; // right-hand side of travel direction
    const v = -120 + Math.random() * 240;
    const style = randomCarStyle();
    const taxi = THEME.taxis && Math.random() < 0.55;
    const g = taxi ? buildCarMesh(0xf7c500, 'car') : buildCarMesh(carColorFor(style), style);
    if (taxi) { // rooftop TAXI sign
      const sign = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.28, 0.35),
        new THREE.MeshBasicMaterial({ color: 0xfff0b0 }));
      sign.position.set(0, 1.52, -0.2);
      g.add(sign);
    }
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
    // rear-ended: stopped dead for a moment
    if (c.stunT > 0) { c.stunT -= dt; continue; }
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
    spinWheels(c.group, c.cur * dt);
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
  if (cfg.pantsColor !== undefined && cfg.pantsColor !== null) pants.color.set(cfg.pantsColor);
  const hairM = new THREE.MeshStandardMaterial({ color: cfg.hairColor, roughness: 0.95 });
  const mDarkC = new THREE.MeshStandardMaterial({ color: 0x181a1e, roughness: 0.8 });

  const uniformed = cfg.uniform !== undefined;
  if (uniformed) shirt.color.set(cfg.uniform);
  if (cfg.team !== undefined) shirt.color.set(cfg.team); // sports kit, no courier gear
  if (cfg.robe !== undefined) shirt.color.set(cfg.robe); // traditional dress

  // torso + hips (capsules, squashed for shoulders)
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(female ? 0.14 : 0.16, 0.34, 4, 10), shirt);
  torso.scale.set(1.14, 1, 0.72);
  torso.position.y = 1.16; g.add(torso);
  const hips = new THREE.Mesh(new THREE.CapsuleGeometry(female ? 0.135 : 0.145, 0.08, 4, 10), pants);
  hips.scale.set(1.08, 1, 0.78);
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
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.42, 0.2), mPack);
    pack.position.set(0, 1.18, -0.25); g.add(pack);
    const packBand = new THREE.Mesh(new THREE.BoxGeometry(0.37, 0.09, 0.21),
      new THREE.MeshStandardMaterial({ color: 0xf0f2f4, roughness: 0.5 }));
    packBand.position.set(0, 1.35, -0.25); g.add(packBand);
  }

  if (opts.head !== false) {
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.09, 8), mSkinC);
    neck.position.y = 1.47; g.add(neck);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.135, 12, 10), mSkinC);
    head.scale.set(0.95, 1.12, 0.98);
    head.position.y = 1.63; g.add(head);
    // face: eyes, brows, nose and mouth so people read as people up close
    for (const ex of [-0.05, 0.05]) {
      const white = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 6),
        new THREE.MeshStandardMaterial({ color: 0xf2f0ec, roughness: 0.35 }));
      white.position.set(ex, 1.65, 0.115); g.add(white);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.011, 6, 6), mDarkC);
      eye.position.set(ex, 1.65, 0.132); g.add(eye);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.012, 0.02), hairM);
      brow.position.set(ex, 1.695, 0.125); g.add(brow);
    }
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 6), mSkinC);
    nose.scale.set(0.8, 1, 1.1);
    nose.position.set(0, 1.625, 0.135); g.add(nose);
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.011, 0.015),
      new THREE.MeshStandardMaterial({ color: 0x8a4a42, roughness: 0.7 }));
    mouth.position.set(0, 1.575, 0.126); g.add(mouth);
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
    if (cfg.headwrap !== undefined) {
      // ghutra (with black agal) for men, hijab for women
      const mWrap = new THREE.MeshStandardMaterial({ color: cfg.headwrap, roughness: 0.9 });
      const wrapCap = new THREE.Mesh(new THREE.SphereGeometry(0.152, 12, 8), mWrap);
      wrapCap.scale.set(1.02, female ? 1.0 : 0.8, 1.05);
      wrapCap.position.y = female ? 1.64 : 1.7;
      g.add(wrapCap);
      if (!female) {
        const drape = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, 0.06), mWrap);
        drape.position.set(0, 1.5, -0.14); g.add(drape);
        const agal = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.022, 8, 16),
          new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 }));
        agal.rotation.x = Math.PI / 2;
        agal.position.y = 1.73;
        g.add(agal);
      } else {
        const drape = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.34, 0.07), mWrap);
        drape.position.set(0, 1.46, -0.13); g.add(drape);
      }
    }
  }

  // legs: hip pivots so the walk cycle bends at the joint
  if (cfg.robe !== undefined) {
    // flowing thobe/abaya from the shoulders to the ground
    const robe = new THREE.Mesh(new THREE.CylinderGeometry(female ? 0.17 : 0.19, 0.3, 1.2, 12),
      new THREE.MeshStandardMaterial({ color: cfg.robe, roughness: 0.92 }));
    robe.position.y = 0.62;
    g.add(robe);
  }
  const legs = [];
  const sporty = cfg.shorts;
  const legMat = (cfg.skirt || sporty) ? mSkinC : pants;
  const legLen = cfg.skirt ? 0.34 : sporty ? 0.4 : 0.42;
  if (cfg.skirt) {
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 0.3, 10), pants);
    skirt.position.y = 0.68; g.add(skirt);
  }
  if (sporty) { // athletic shorts in kit color
    const shorts = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.24, 10),
      new THREE.MeshStandardMaterial({ color: cfg.shorts, roughness: 0.85 }));
    shorts.position.y = 0.72; g.add(shorts);
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
    pivot.position.set(sx * (female ? 0.205 : 0.235), 1.36, 0);
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
  if (THEME && THEME.dress === 'arabic' && Math.random() < 0.8) {
    // traditional dress: white/cream thobes + ghutra, abayas + hijab
    const menRobes = [0xf2f0ea, 0xe8e2d2, 0xd8d4c8, 0xb8b4a8];
    const womenRobes = [0x16161a, 0x2a1a2e, 0x3a1518, 0x1a2038, 0x4a3a20];
    return {
      gender: f ? 'f' : 'm',
      skin: SKINS[Math.floor(Math.random() * SKINS.length)],
      shirtHue: Math.random(), pantsHue: Math.random(),
      hairColor: HAIRS[0], hairLong: false, skirt: false,
      robe: f ? womenRobes[Math.floor(Math.random() * womenRobes.length)]
              : menRobes[Math.floor(Math.random() * menRobes.length)],
      headwrap: f ? [0x16161a, 0x3a2a40, 0x4a2028][Math.floor(Math.random() * 3)] : 0xf4f2ec,
      height: (f ? 0.92 : 0.97) + Math.random() * 0.12,
    };
  }
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
// Camels — desert caravans strolling the medina lanes (Sahara city)
// ---------------------------------------------------------------------------
const camels = [];
function makeCamel() {
  const g = new THREE.Group();
  const mHide = new THREE.MeshStandardMaterial({ color: 0xb08a55, roughness: 0.95 });
  const mDarkC = new THREE.MeshStandardMaterial({ color: 0x6a5638, roughness: 0.9 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 1.0, 4, 10), mHide);
  body.rotation.x = Math.PI / 2;
  body.position.y = 1.2;
  g.add(body);
  const hump = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), mHide);
  hump.scale.set(1, 0.9, 1.2);
  hump.position.set(0, 1.68, -0.1);
  g.add(hump);
  const neck = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.7, 4, 8), mHide);
  neck.position.set(0, 1.72, 0.78);
  neck.rotation.x = -0.5;
  g.add(neck);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.22, 0.4), mHide);
  head.position.set(0, 2.12, 1.06);
  g.add(head);
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.02, 0.5, 6), mDarkC);
  tail.position.set(0, 1.25, -0.85);
  tail.rotation.x = 0.4;
  g.add(tail);
  const legs = [];
  for (const [lx, lz] of [[-0.22, 0.45], [0.22, 0.45], [-0.22, -0.45], [0.22, -0.45]]) {
    const pivot = new THREE.Group();
    pivot.position.set(lx, 1.05, lz);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 1.05, 8), mHide);
    leg.position.y = -0.52;
    pivot.add(leg);
    g.add(pivot);
    legs.push(pivot);
  }
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return { group: g, legs };
}
function spawnCamels() {
  if (!THEME.camels) return;
  for (let c = 0; c < 4; c++) {                 // four caravans
    const s = STREETS[(c * 2) % STREETS.length];
    const alongX = c % 2 === 0;
    const dir = Math.random() < 0.5 ? 1 : -1;
    let v = -100 + Math.random() * 200;
    for (let i = 0; i < 3; i++) {               // three camels each, in a line
      const rig = makeCamel();
      scene.add(rig.group);
      camels.push({ rig, s, alongX, dir, v: v - i * 3.2 * dir, side: (ROAD_HALF - 2) * (c % 2 ? 1 : -1),
        speed: 1.1 + Math.random() * 0.2, phase: Math.random() * 6 });
    }
  }
}
function updateCamels(dt) {
  for (const c of camels) {
    c.v += c.speed * c.dir * dt;
    if (c.v > 126 || c.v < -126) c.dir *= -1;
    if (c.alongX) {
      c.rig.group.position.set(c.v, 0, c.s + c.side);
      c.rig.group.rotation.y = c.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    } else {
      c.rig.group.position.set(c.s + c.side, 0, c.v);
      c.rig.group.rotation.y = c.dir > 0 ? 0 : Math.PI;
    }
    if (c.rig.legs) {
      // procedural rig: swing the leg pivots ourselves
      c.phase += dt * 3.2;
      const sw = Math.sin(c.phase) * 0.4;
      c.rig.legs[0].rotation.x = sw;
      c.rig.legs[3].rotation.x = sw;
      c.rig.legs[1].rotation.x = -sw;
      c.rig.legs[2].rotation.x = -sw;
      c.rig.group.position.y = Math.abs(Math.sin(c.phase)) * 0.04;
    }
  }
}

// ---------------------------------------------------------------------------
// Street animals — dogs trotting the sidewalks, cats slinking along walls
// ---------------------------------------------------------------------------
const animals = [];
function makeAnimal(kind) {
  const g = new THREE.Group();
  const dog = kind === 'dog';
  const cols = dog ? [0x8a6a3e, 0x3a2f24, 0xd8cfc0, 0x6a5a48] : [0x2a2a2e, 0xc9c3b8, 0xb8823e, 0x7a7a80];
  const mFur = new THREE.MeshStandardMaterial({ color: cols[Math.floor(Math.random() * cols.length)], roughness: 0.95 });
  const s = dog ? 1 : 0.62; // cats are small
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.11 * s, 0.3 * s, 4, 8), mFur);
  body.rotation.x = Math.PI / 2;
  body.position.y = 0.3 * s;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.09 * s, 8, 6), mFur);
  head.position.set(0, 0.4 * s, 0.26 * s);
  g.add(head);
  const snout = new THREE.Mesh(new THREE.BoxGeometry(0.05 * s, 0.045 * s, 0.08 * s), mFur);
  snout.position.set(0, 0.37 * s, 0.34 * s);
  g.add(snout);
  for (const ex of [-1, 1]) { // pointy ears
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.03 * s, 0.06 * s, 4), mFur);
    ear.position.set(ex * 0.055 * s, 0.49 * s, 0.24 * s);
    g.add(ear);
  }
  const legs = [];
  for (const [lx, lz] of [[-0.07, 0.12], [0.07, 0.12], [-0.07, -0.12], [0.07, -0.12]]) {
    const pivot = new THREE.Group();
    pivot.position.set(lx * s, 0.24 * s, lz * s);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.022 * s, 0.02 * s, 0.24 * s, 6), mFur);
    leg.position.y = -0.12 * s;
    pivot.add(leg);
    g.add(pivot);
    legs.push(pivot);
  }
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.02 * s, 0.008 * s, 0.26 * s, 6), mFur);
  tail.position.set(0, 0.38 * s, -0.26 * s);
  tail.rotation.x = dog ? 0.8 : 0.35;
  g.add(tail);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return { group: g, legs, tail, s };
}
function spawnAnimals() {
  const nDogs = 5, nCats = 4;
  for (let i = 0; i < nDogs + nCats; i++) {
    const kind = i < nDogs ? 'dog' : 'cat';
    const rig = makeAnimal(kind);
    scene.add(rig.group);
    const s = STREETS[Math.floor(Math.random() * STREETS.length)];
    animals.push({
      rig, kind,
      s, alongX: Math.random() < 0.5, dir: Math.random() < 0.5 ? 1 : -1,
      v: -100 + Math.random() * 200,
      side: (Math.random() < 0.5 ? 1 : -1) * (ROAD_HALF + 1.2 + Math.random() * 2),
      speed: kind === 'dog' ? 1.6 + Math.random() * 0.7 : 1.1 + Math.random() * 0.5,
      phase: Math.random() * 6, restT: 0, fleeT: 0,
    });
  }
}
function updateAnimals(dt) {
  for (const a of animals) {
    const gp = a.rig.group.position;
    if (game.time - lastShot.t < 0.3 && Math.hypot(gp.x - lastShot.x, gp.z - lastShot.z) < 25) a.fleeT = 4;
    const fleeing = a.fleeT > 0;
    if (fleeing) a.fleeT -= dt;
    if (a.restT > 0 && !fleeing) { // sitting, tail slowly swishing
      a.restT -= dt;
      a.rig.tail.rotation.z = Math.sin(game.time * 2) * 0.25;
      continue;
    }
    if (!fleeing && Math.random() < dt * 0.02) { a.restT = 3 + Math.random() * 4; continue; }
    const sp = a.speed * (fleeing ? 2.6 : 1);
    a.v += sp * a.dir * dt;
    if (a.v > 126 || a.v < -126) a.dir *= -1;
    if (a.alongX) {
      gp.set(a.v, 0, a.s + a.side);
      a.rig.group.rotation.y = a.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    } else {
      gp.set(a.s + a.side, 0, a.v);
      a.rig.group.rotation.y = a.dir > 0 ? 0 : Math.PI;
    }
    a.phase += dt * sp * 5.5;
    const sw = Math.sin(a.phase) * 0.55;
    a.rig.legs[0].rotation.x = sw;
    a.rig.legs[3].rotation.x = sw;
    a.rig.legs[1].rotation.x = -sw;
    a.rig.legs[2].rotation.x = -sw;
    a.rig.tail.rotation.z = Math.sin(a.phase * 0.7) * (a.kind === 'dog' ? 0.5 : 0.2);
  }
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
  const n = Math.round(48 + 18 * (1 - NF)); // busier by day
  for (let i = 0; i < n; i++) spawnPed(false);
}
function updatePeds(dt) {
  for (const p of peds) {
    // knocked down: lie there a moment, then get up and run
    if (p.downT > 0) {
      p.downT -= dt;
      if (p.downT <= 0) {
        p.rig.group.rotation.z = 0;
        p.rig.group.position.y = 0;
        p.fleeT = 5;
      }
      continue;
    }
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
  hemi.intensity = 2.7 + (THEME.hemi[2] - 2.7) * NF;
  moon.color.set(new THREE.Color(0xfff1d2).lerp(new THREE.Color(THEME.moonColor), NF));
  MOON_BASE = 3.6 - (3.6 - 1.6) * NF;
  moon.intensity = MOON_BASE;
  renderer.toneMappingExposure = 1.25 - (1 - NF) * 0.05;
  bloomPass.strength = 0.3 + 0.35 * NF; // day stays crisp, night neon glows
  if (starsObj) starsObj.visible = NF > 0.45;
  if (moonSprite) moonSprite.visible = NF > 0.45;
  if (sunSprite) sunSprite.visible = NF < 0.45;
  if (cloudGrp) cloudGrp.visible = NF < 0.6;

  FACADES = [];
  for (const k in FACADE_STYLES) FACADE_STYLES[k] = [];
  for (let i = 0; i < 12; i++) {
    const hue = THEME.windowHues[i % THEME.windowHues.length];
    const r = Math.random();
    const st = THEME.styles;
    const style = r < st.curtain ? 'curtain'
      : r < st.curtain + st.brick ? 'brick'
      : r < st.curtain + st.brick + (st.adobe || 0) ? 'adobe' : 'punched';
    const fac = makeFacadeCanvases(THEME.wall, hue, style);
    FACADES.push(fac);
    (FACADE_STYLES[style] = FACADE_STYLES[style] || []).push(fac);
  }
  STOREFRONTS = [0, 1, 2, 3, 4, 5].map(makeStorefrontCanvas);

  // ---- ground: whole road network painted into one texture ----
  {
    const T = LOWMEM ? 2048 : 4096, sc = T / (CITY_HALF * 2);
    const cv = document.createElement('canvas');
    cv.width = cv.height = T;
    const g = cv.getContext('2d');
    const W = v => (v + CITY_HALF) * sc;

    const GC = THEME.ground || { base: '#3d4046', road: '#25282d', line: '#c9c5aa' };
    // sidewalk/ground with paving joints and grime
    g.fillStyle = GC.base; g.fillRect(0, 0, T, T);
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
    g.fillStyle = GC.road;
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
    g.fillStyle = GC.line;
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
        const lcx = x0 + lotW * qx + lotW / 2, lcz = z0 + lotD * qz + lotD / 2;
        if (PLAZAS.some(p => Math.hypot(lcx - p.x, lcz - p.z) < 27)) continue; // venue plaza
        if (THEME.landmark && Math.hypot(lcx - THEME.landmark.x, lcz - THEME.landmark.z) < 22) continue;
        if (Math.random() < 0.12) continue; // empty lot
        const w = lotW * (0.62 + Math.random() * 0.28);
        const d = lotD * (0.62 + Math.random() * 0.28);
        const cx = x0 + lotW * qx + lotW / 2 + (Math.random() - 0.5) * 2;
        const cz = z0 + lotD * qz + lotD / 2 + (Math.random() - 0.5) * 2;
        const centerBoost = 1 + Math.max(0, 1 - Math.hypot(cx, cz) / 240) * 0.7;
        const dist = districtOf(cx, cz);
        const h = Math.max(THEME.hMin * 0.8,
          (THEME.hMin + Math.random() * (THEME.hMax - THEME.hMin)) * centerBoost * dist.hMul);
        const face = Math.random() < 0.5
          ? { ax: 'x', dir: qx === 0 ? -1 : 1 }
          : { ax: 'z', dir: qz === 0 ? -1 : 1 };
        addBuilding(cx, cz, w, d, h, face, dist.style);
      }
    }

  // ---- perimeter ring so the city feels endless ----
  // (the waterfront/dock edge stays open so you can see the sea)
  for (let p = -120; p <= 120; p += 48) {
    const h = 30 + Math.random() * 22;
    addBuilding(p, -(CITY_HALF - 8), 34, 15, h, { ax: 'z', dir: 1 });
    addBuilding(p, CITY_HALF - 8, 34, 15, h, { ax: 'z', dir: -1 });
    if (THEME.docks !== 'west') addBuilding(-(CITY_HALF - 8), p, 15, 34, h, { ax: 'x', dir: 1 });
    if (THEME.waterfront !== 'east') addBuilding(CITY_HALF - 8, p, 15, 34, h, { ax: 'x', dir: -1 });
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
        dayGlowMats.push({ mat: cone.material, base: 0.05 });
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
    for (let v = -110; v <= 110; v += 20) {
      if (STREETS.some(t => Math.abs(v - t) < 13)) continue;
      if (Math.random() < 0.55)
        addCar(s + (Math.random() < 0.5 ? ROAD_HALF - 1.9 : -(ROAD_HALF - 1.9)), v + Math.random() * 6, Math.random() < 0.1 ? 0.06 : 0, randomCarStyle());
      if (Math.random() < 0.55)
        addCar(v + Math.random() * 6, s + (Math.random() < 0.5 ? ROAD_HALF - 1.9 : -(ROAD_HALF - 1.9)), Math.PI / 2, randomCarStyle());
    }

  // ---- delivery scooters + bicycles parked on the sidewalks ----
  {
    let nScooter = 0, nBike = 0;
    const boxCol = new THREE.Color(CITY.sponsors[0].colorA);
    // one guaranteed scooter right at the spawn point so a new player can
    // ride within seconds of deploying
    registerVehicle(buildScooterMesh(boxCol), 8.6, 22, 0.4, 'scooter');
    for (const s of STREETS)
      for (let v = -116; v <= 116; v += 18) {
        if (STREETS.some(t => Math.abs(v - t) < 11)) continue;
        const side = Math.random() < 0.5 ? 1 : -1;
        const r = Math.random();
        if (r < 0.24 && nScooter < 26) {
          nScooter++;
          registerVehicle(buildScooterMesh(boxCol),
            s + side * (ROAD_HALF + 1.0), v + Math.random() * 5, Math.random() * 6.28, 'scooter');
        } else if (r < 0.4 && nBike < 18) {
          nBike++;
          registerVehicle(buildBicycleMesh(),
            v + Math.random() * 5, s + side * (ROAD_HALF + 1.0), Math.random() * 6.28, 'bicycle');
        }
      }
  }

  // ---- souq market stalls: striped canopies + goods along the medina lanes ----
  if (THEME.camels) {
    const stallCols = [0xb9382e, 0x2e6db9, 0xb9902e, 0x3e8a4e];
    const mWood = new THREE.MeshStandardMaterial({ color: 0x6a4a26, roughness: 0.9 });
    const mGoods = new THREE.MeshStandardMaterial({ color: 0x9a7434, roughness: 0.95 });
    for (let i = 0; i < 14; i++) {
      const s = STREETS[i % STREETS.length];
      const along = -104 + (i * 37) % 208;
      if (STREETS.some(t => Math.abs(along - t) < 12)) continue;
      const side = (i % 2 ? 1 : -1) * (ROAD_HALF + 2.7);
      const onX = i % 3 !== 0;
      const x = onX ? along : s + side, z = onX ? s + side : along;
      const stall = new THREE.Group();
      for (const [px, pz] of [[-1.1, -0.8], [1.1, -0.8], [-1.1, 0.8], [1.1, 0.8]]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 6), mWood);
        post.position.set(px, 1.1, pz);
        stall.add(post);
      }
      const cnv = document.createElement('canvas');
      cnv.width = 64; cnv.height = 64;
      const cx = cnv.getContext('2d');
      const col = stallCols[i % stallCols.length];
      for (let st = 0; st < 8; st++) {
        cx.fillStyle = st % 2 ? '#f2e6cf' : '#' + col.toString(16).padStart(6, '0');
        cx.fillRect(st * 8, 0, 8, 64);
      }
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.06, 2.1),
        new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(cnv), roughness: 0.85 }));
      canopy.position.y = 2.24;
      canopy.rotation.z = 0.06;
      stall.add(canopy);
      const table = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.75, 1.2), mWood);
      table.position.y = 0.38;
      stall.add(table);
      for (let gI = 0; gI < 4; gI++) {
        const sack = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), mGoods);
        sack.scale.y = 0.7;
        sack.position.set(-0.8 + gI * 0.55, 0.86, (gI % 2 ? 0.25 : -0.2));
        stall.add(sack);
      }
      stall.position.set(x, 0, z);
      stall.rotation.y = onX ? 0 : Math.PI / 2;
      stall.traverse(o => { if (o.isMesh) o.castShadow = true; });
      scene.add(stall);
      addCollider(new THREE.Box3(
        new THREE.Vector3(x - 1.4, 0, z - 1.2), new THREE.Vector3(x + 1.4, 2.3, z + 1.2)));
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
      const palm = !!t.palm;
      const trunks = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(palm ? 0.07 : 0.09, palm ? 0.13 : 0.16, palm ? 4.4 : 2.6, 6),
        new THREE.MeshStandardMaterial({ color: palm ? 0x6a5638 : 0x3a2c1c, roughness: 0.95 }), spots.length);
      const cans = new THREE.InstancedMesh(
        new THREE.SphereGeometry(1, 8, 6),
        new THREE.MeshStandardMaterial({ color: t.color, roughness: 0.95 }), spots.length);
      const m4 = new THREE.Matrix4();
      spots.forEach(([x, z], i) => {
        m4.makeTranslation(x, palm ? 2.2 : 1.3, z);
        trunks.setMatrixAt(i, m4);
        const s = 1.2 + Math.random() * 0.9;
        if (palm) m4.makeScale(s * 1.8, s * 0.4, s * 1.8).setPosition(x, 4.5, z); // frond crown
        else m4.makeScale(s * 1.25, s, s * 1.25).setPosition(x, 2.9 + s * 0.4, z);
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

  // ---- street furniture: planters and benches along every avenue ----
  {
    const spots = [];
    for (const s of STREETS)
      for (let v = -118; v <= 118; v += 34) {
        if (STREETS.some(q => Math.abs(v - q) < ROAD_HALF + 5)) continue;
        for (const side of [-1, 1]) {
          if (Math.random() < 0.45) spots.push([s + side * (ROAD_HALF + 3.1), v + (Math.random() - 0.5) * 6, side, 'x']);
          if (Math.random() < 0.45) spots.push([v + (Math.random() - 0.5) * 6, s + side * (ROAD_HALF + 3.1), side, 'z']);
        }
      }
    if (spots.length) {
      const boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(1.5, 0.5, 0.6),
        new THREE.MeshStandardMaterial({ color: 0x707478, roughness: 0.9 }), spots.length);
      const bushes = new THREE.InstancedMesh(new THREE.SphereGeometry(0.42, 8, 6),
        new THREE.MeshStandardMaterial({ color: THEME.tree.color, roughness: 0.95 }), spots.length);
      const m4 = new THREE.Matrix4();
      const rot = new THREE.Matrix4();
      spots.forEach(([x, z, side, ax], i) => {
        const ry = ax === 'x' ? 0 : Math.PI / 2;
        rot.makeRotationY(ry);
        m4.copy(rot).setPosition(x, 0.25, z);
        boxes.setMatrixAt(i, m4);
        m4.makeScale(1.3, 0.8, 1.3).premultiply(rot).setPosition(x, 0.75, z);
        bushes.setMatrixAt(i, m4);
      });
      boxes.castShadow = bushes.castShadow = true;
      scene.add(boxes);
      scene.add(bushes);
    }
  }

  // ---- traffic lights on the central avenues (live red/green cycles) ----
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
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0x35e06a }));
        lamp.position.set(px, 4.34, pz);
        scene.add(lamp);
        trafficLamps.push({ lamp, off: (ox > 0 ? 0 : 0.5), green: true });
      }
    }
  }

  // ---- bus shelters with lit sponsor ad panels ----
  {
    const mFrame = new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.5, metalness: 0.6 });
    const mGlass = new THREE.MeshStandardMaterial({ color: 0x9fc4d8, roughness: 0.15,
      metalness: 0.3, transparent: true, opacity: 0.3 });
    const mSeat = new THREE.MeshStandardMaterial({ color: 0x5a4a38, roughness: 0.85 });
    let bi = 0;
    for (const s of STREETS)
      for (const v of [-88, 42]) {
        if (bi >= 10) break;
        const side = bi % 2 ? 1 : -1;
        const alongZ = bi % 3 !== 0; // mix roads running north-south and east-west
        const g = new THREE.Group();
        for (const dz of [-1.7, 1.7]) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.6, 6), mFrame);
          post.position.set(0.4, 1.3, dz);
          g.add(post);
        }
        const roof = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.09, 4.2), mFrame);
        roof.position.set(0.1, 2.62, 0);
        roof.castShadow = true;
        g.add(roof);
        const back = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 2.2), mGlass);
        back.rotation.y = -Math.PI / 2;
        back.position.set(0.78, 1.35, 0);
        g.add(back);
        const sp = CITY.sponsors[sponsorIdx++ % CITY.sponsors.length];
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.35),
          new THREE.MeshBasicMaterial({ map: makeBillboardTexture(sp), side: THREE.DoubleSide }));
        panel.rotation.y = -Math.PI / 2;
        panel.position.set(0.74, 1.42, 0);
        g.add(panel);
        const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 3.0), mSeat);
        seat.position.set(0.42, 0.55, 0);
        g.add(seat);
        for (const dz of [-1.3, 0, 1.3]) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.55, 0.08), mSeat);
          leg.position.set(0.42, 0.27, dz);
          g.add(leg);
        }
        if (alongZ) {
          g.position.set(s + side * (ROAD_HALF + 2.5), 0, v + (bi % 2) * 9);
          g.rotation.y = side > 0 ? 0 : Math.PI;
        } else {
          g.position.set(v + (bi % 2) * 9, 0, s + side * (ROAD_HALF + 2.5));
          g.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
        }
        scene.add(g);
        bi++;
      }
  }

  // ---- hydrants and trash bins along the sidewalks (instanced) ----
  {
    const spots = [];
    for (const s of STREETS)
      for (let v = -110; v <= 110; v += 26) {
        if (STREETS.some(q => Math.abs(v - q) < ROAD_HALF + 4)) continue;
        const side = Math.random() < 0.5 ? 1 : -1;
        if (Math.random() < 0.5) spots.push([s + side * (ROAD_HALF + 1.6), v + Math.random() * 8]);
        else spots.push([v + Math.random() * 8, s + side * (ROAD_HALF + 1.6)]);
      }
    const half = Math.ceil(spots.length / 2);
    const hyd = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.14, 0.4, 4, 8),
      new THREE.MeshStandardMaterial({ color: 0xc22a20, roughness: 0.55, metalness: 0.2 }), half);
    const bins = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.26, 0.22, 0.75, 10),
      new THREE.MeshStandardMaterial({ color: 0x2e4636, roughness: 0.8, metalness: 0.3 }),
      spots.length - half);
    const m4 = new THREE.Matrix4();
    spots.forEach(([x, z], i) => {
      if (i < half) { m4.makeTranslation(x, 0.32, z); hyd.setMatrixAt(i, m4); }
      else { m4.makeTranslation(x, 0.38, z); bins.setMatrixAt(i - half, m4); }
    });
    hyd.castShadow = bins.castShadow = true;
    scene.add(hyd);
    scene.add(bins);
  }

  // ---- rooftop billboards: lit sponsor boards crowning mid-rise towers ----
  {
    let placed = 0;
    for (const b of billboardRoofs) {
      if (placed >= 8) break;
      if (Math.random() < 0.55) continue;
      const sp = CITY.sponsors[sponsorIdx++ % CITY.sponsors.length];
      const w = Math.min(b.w * 0.85, 13);
      const g = new THREE.Group();
      const mFrame2 = new THREE.MeshStandardMaterial({ color: 0x33373d, roughness: 0.6, metalness: 0.6 });
      for (const dx of [-w * 0.35, w * 0.35]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.2, 0.3), mFrame2);
        leg.position.set(dx, 1.1, 0);
        g.add(leg);
      }
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.42),
        new THREE.MeshBasicMaterial({ map: makeBillboardTexture(sp), side: THREE.DoubleSide }));
      panel.position.y = 2.2 + w * 0.21;
      g.add(panel);
      g.position.set(b.x, b.y, b.z);
      g.rotation.y = Math.abs(b.x) > Math.abs(b.z) ? (b.x > 0 ? -Math.PI / 2 : Math.PI / 2)
        : (b.z > 0 ? Math.PI : 0);
      scene.add(g);
      placed++;
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

  // live forecast: rain-prone cities shower often, the desert almost never
  weather.prob = THEME.rain > 0 ? 0.6 : THEME.camels ? 0.08 : 0.3;
  weather.state = THEME.rain > 0 ? 'rain' : 'sun';
  weather.amount = THEME.rain;
  weather.t = 50 + Math.random() * 70;
  rainPts.visible = weather.amount > 0;
  rainPts.geometry.setDrawRange(0, weather.amount | 0);

  // day/night dimming: window glow and street lamps fade out in daylight
  const glow = 0.12 + 0.88 * NF;
  // facades brighten in sunlight so daytime towers read concrete-and-glass,
  // not the same near-black slabs as midnight
  for (const e of EMI_MATS) {
    e.mat.emissiveIntensity = e.base * glow;
    e.mat.color.setScalar(1 + 0.5 * (1 - NF));
  }
  for (const l of lampLights) l.intensity = 20 * NF;
  for (const m of dayGlowMats) m.mat.opacity = m.base * NF;

  document.getElementById('ammo').style.display = THEME.noGuns ? 'none' : '';
  document.getElementById('crosshair').style.display = THEME.noGuns ? 'none' : '';
  for (const gid of ['btnFire', 'btnAim']) {
    const gel = document.getElementById(gid);
    if (gel) gel.style.opacity = THEME.noGuns ? '0.15' : '';
    if (gel && THEME.noGuns) gel.style.pointerEvents = 'none';
  }
  buildFuelStations();
  buildCarWash();
  setupCityActivities();
  buildClub();
  buildVenues();
  buildRaceCourse();
  addLandmarks();
  spawnTraffic();
  spawnPeds();
  spawnCamels();
  spawnAnimals();
  for (let i = 0; i < 10; i++) spawnCanPickup();
  loadRealAssets();
  spawnMercFleet();   // in case the model finished loading before the city
  spawnPolice();
  placeRealPeople();

  // career: remember every city the driver has worked in
  prog.stats.cities[city.id] = 1;
  checkAchs();
  saveProg();

  // capture the finished city as the environment map (deferred so the page
  // stays responsive; skipped on software renderers where it would stall)
  setTimeout(() => {
    try {
      const dbg = renderer.getContext().getExtension('WEBGL_debug_renderer_info');
      const gpu = dbg ? renderer.getContext().getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
      if (/swiftshader|llvmpipe|software/i.test(gpu)) return;
      const pmrem = new THREE.PMREMGenerator(renderer);
      const env = pmrem.fromScene(scene, 0, 0.5, 420);
      scene.environment = env.texture;
      pmrem.dispose();
    } catch (e) { /* reflections are an enhancement, never fatal */ }
  }, 1500);
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
    dayGlowMats.push({ mat: beam.material, base: 0.08 });
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

  // people training outside — real gym wear: bright tanks + athletic shorts
  for (let i = 0; i < 5; i++) {
    const look = randomLook();
    look.team = new THREE.Color().setHSL((i * 0.19 + 0.05) % 1, 0.75, 0.5).getHex();
    look.shorts = [0x14161a, 0x2a2e34, 0xd83030][i % 3];
    look.skirt = false;
    const c = makeCharacter(look);
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
// City landmarks — each city gets a signature so no two feel the same:
// Marina Bay opens onto the sea with a palm corniche and yachts, Red Harbor
// gets a working container port, Neon District a glowing holo-spire, and
// Old Sahara fortified city gates and a kasbah watchtower.
// ---------------------------------------------------------------------------
const seaBits = []; // boats and buoys that bob on the water
function addLandmarks() {
  if (THEME.waterfront === 'east') addSea(1, 0x0d4a66, true);
  if (THEME.docks === 'west') { addSea(-1, 0x11333f, false); addDocks(); }
  if (THEME.landmark) {
    const { x, z, kind } = THEME.landmark;
    if (kind === 'watchtower') addWatchtower(x, z);
    else if (kind === 'deco') addDecoTower(x, z);
    else if (kind === 'needle') addNeedleTower(x, z);
    else if (kind === 'museum') addMuseum(x, z);
    else if (kind === 'burj') { /* real model loads async in loadRealAssets */ }
    else addHoloSpire(x, z);
  }
  if (THEME.sail) addSailHotel(THEME.sail.x, THEME.sail.z);
  if (THEME.pearl) addPearlMonument(THEME.pearl.x, THEME.pearl.z);
  if (THEME.gates) addCityGates();
}
// NEW YORK: limestone art-deco giant with setbacks and a lit crown
function addDecoTower(x, z) {
  const mStone = new THREE.MeshStandardMaterial({ color: 0xcfc4ae, roughness: 0.8 });
  const tower = new THREE.Group();
  let y = 0;
  for (const [w, h] of [[21, 20], [16.5, 17], [12.5, 15], [8.5, 13], [5.5, 10]]) {
    const tier = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), mStone);
    tier.position.y = y + h / 2; tower.add(tier);
    y += h;
  }
  const crown = new THREE.Mesh(new THREE.BoxGeometry(6.3, 1.2, 6.3),
    new THREE.MeshBasicMaterial({ color: 0xfff2cc }));
  crown.position.y = y + 0.4; tower.add(crown);
  const spike = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.5, 14, 6), mStone);
  spike.position.y = y + 7.5; tower.add(spike);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff4444 }));
  beacon.position.y = y + 14.5; tower.add(beacon);
  blinkers.push({ mesh: beacon, phase: 0.7 });
  tower.position.set(x, 0, z);
  tower.traverse(o => { if (o.isMesh) o.castShadow = true; });
  scene.add(tower);
  addCollider(new THREE.Box3(
    new THREE.Vector3(x - 10.5, 0, z - 10.5), new THREE.Vector3(x + 10.5, y, z + 10.5)));
}
// DUBAI: tapering supertall needle — tallest thing in any city
function addNeedleTower(x, z) {
  const mGlass = new THREE.MeshStandardMaterial({ color: 0xaec8dd, roughness: 0.35, metalness: 0.15 });
  const tower = new THREE.Group();
  let y = 0;
  for (const [r, h] of [[8.5, 20], [7, 18], [5.7, 16], [4.5, 14], [3.4, 12], [2.4, 10], [1.5, 8]]) {
    const tier = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.88, r, h, 10), mGlass);
    tier.position.y = y + h / 2; tower.add(tier);
    const band = new THREE.Mesh(new THREE.TorusGeometry(r * 0.9, 0.22, 6, 20),
      new THREE.MeshBasicMaterial({ color: 0xffe9b0 }));
    band.rotation.x = Math.PI / 2;
    band.position.y = y + h; tower.add(band);
    y += h;
  }
  const needle = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.5, 18, 6), mGlass);
  needle.position.y = y + 9; tower.add(needle);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff4444 }));
  beacon.position.y = y + 18; tower.add(beacon);
  blinkers.push({ mesh: beacon, phase: 1.4 });
  tower.position.set(x, 0, z);
  tower.traverse(o => { if (o.isMesh) o.castShadow = true; });
  scene.add(tower);
  addCollider(new THREE.Box3(
    new THREE.Vector3(x - 8.5, 0, z - 8.5), new THREE.Vector3(x + 8.5, y, z + 8.5)));
}
// DUBAI: white sail-shaped hotel standing in the shallows
function addSailHotel(x, z) {
  const hotel = new THREE.Group();
  const mWhite = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.4, side: THREE.DoubleSide });
  const sail = new THREE.Mesh(
    new THREE.CylinderGeometry(11, 13, 52, 14, 1, true, 0, Math.PI), mWhite);
  sail.position.y = 26; hotel.add(sail);
  const mast = new THREE.Mesh(new THREE.BoxGeometry(2.4, 58, 2.4), mWhite);
  mast.position.set(0, 29, -11); hotel.add(mast);
  const glow = new THREE.Mesh(new THREE.BoxGeometry(2.5, 52, 0.4),
    new THREE.MeshBasicMaterial({ color: 0x9fd8ff }));
  glow.position.set(0, 26, -12.3); hotel.add(glow);
  hotel.position.set(x, 0, z);
  hotel.rotation.y = -Math.PI / 2; // sail faces the city
  hotel.traverse(o => { if (o.isMesh) o.castShadow = true; });
  scene.add(hotel);
}
// DOHA: stepped stone museum on its own block, like a stack of carved cubes
function addMuseum(x, z) {
  const mCream = new THREE.MeshStandardMaterial({ color: 0xe8e0d0, roughness: 0.85 });
  const museum = new THREE.Group();
  const tiers = [[24, 7, 0], [18, 6, Math.PI / 8], [12.5, 6, Math.PI / 4], [8, 5, Math.PI / 8]];
  let y = 0;
  for (const [w, h, rot] of tiers) {
    const tier = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), mCream);
    tier.position.y = y + h / 2;
    tier.rotation.y = rot;
    museum.add(tier);
    y += h;
  }
  // slotted window band on the top tier, like the carved lantern
  const slot = new THREE.Mesh(new THREE.BoxGeometry(8.3, 0.9, 8.3),
    new THREE.MeshBasicMaterial({ color: 0xffe9c0 }));
  slot.rotation.y = Math.PI / 8;
  slot.position.y = y - 2.2; museum.add(slot);
  museum.position.set(x, 0, z);
  museum.traverse(o => { if (o.isMesh) o.castShadow = true; });
  scene.add(museum);
  addCollider(new THREE.Box3(
    new THREE.Vector3(x - 12, 0, z - 12), new THREE.Vector3(x + 12, y, z + 12)));
}
// DOHA: giant open oyster holding a pearl, on the corniche roundabout
function addPearlMonument(x, z) {
  const mon = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 4.2, 0.8, 16),
    new THREE.MeshStandardMaterial({ color: 0xbfb5a0, roughness: 0.9 }));
  base.position.y = 0.4; mon.add(base);
  const mShell = new THREE.MeshStandardMaterial({ color: 0xdcd4c2, roughness: 0.55, side: THREE.DoubleSide });
  const lower = new THREE.Mesh(new THREE.SphereGeometry(2.6, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), mShell);
  lower.rotation.x = Math.PI; lower.position.y = 3.1; mon.add(lower);
  const upper = new THREE.Mesh(new THREE.SphereGeometry(2.6, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), mShell);
  upper.position.y = 3.3; upper.rotation.x = -0.9; upper.position.z = -1.1; mon.add(upper);
  const pearl = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xf6f2ea, roughness: 0.15, metalness: 0.1 }));
  pearl.position.y = 3.6; mon.add(pearl);
  mon.position.set(x, 0, z);
  mon.traverse(o => { if (o.isMesh) o.castShadow = true; });
  scene.add(mon);
  addCollider(new THREE.Box3(
    new THREE.Vector3(x - 4.2, 0, z - 4.2), new THREE.Vector3(x + 4.2, 6, z + 4.2)));
}
function addSea(side, color, fancy) {
  const water = new THREE.Mesh(new THREE.PlaneGeometry(330, 660),
    new THREE.MeshStandardMaterial({ color, roughness: 0.12, metalness: 0.55 }));
  water.rotation.x = -Math.PI / 2;
  water.position.set(side * 303, 0.04, 0);
  scene.add(water);
  // quay apron along the shore
  const mStone = new THREE.MeshStandardMaterial({ color: fancy ? 0xcdbFa2 : 0x74767a, roughness: 0.9 });
  const quay = new THREE.Mesh(new THREE.BoxGeometry(9, 0.5, 300), mStone);
  quay.position.set(side * 137, 0.25, 0);
  scene.add(quay);
  if (fancy) {
    // corniche railing + palm walk
    const mRail = new THREE.MeshStandardMaterial({ color: 0xe8e2d2, roughness: 0.5, metalness: 0.3 });
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 296), mRail);
    rail.position.set(side * 140.6, 1.05, 0);
    scene.add(rail);
    for (let z = -145; z <= 145; z += 9) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.05, 0.1), mRail);
      post.position.set(side * 140.6, 0.52, z);
      scene.add(post);
    }
    const mTrunk = new THREE.MeshStandardMaterial({ color: 0x6a5638, roughness: 0.95 });
    const mFrond = new THREE.MeshStandardMaterial({ color: 0x2a5a30, roughness: 0.95 });
    for (let z = -140; z <= 140; z += 20) {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.14, 4.6, 6), mTrunk);
      trunk.position.set(side * 135, 2.3, z);
      const crown = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), mFrond);
      crown.scale.set(2.1, 0.5, 2.1);
      crown.position.set(side * 135, 4.7, z);
      trunk.castShadow = crown.castShadow = true;
      scene.add(trunk); scene.add(crown);
    }
    // white yachts moored off the corniche
    const mHull = new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.35 });
    const mGlass2 = new THREE.MeshStandardMaterial({ color: 0x18242e, roughness: 0.15, metalness: 0.6 });
    for (const [wx, wz, ry] of [[168, -75, 0.4], [178, 5, -0.2], [163, 88, 0.1], [195, -20, 0.7]]) {
      const boat = new THREE.Group();
      const hull = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.1, 11, 8), mHull);
      hull.rotation.x = Math.PI / 2; hull.rotation.z = Math.PI / 2;
      hull.scale.y = 0.55;
      hull.position.y = 0.7;
      boat.add(hull);
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.1, 4), mHull);
      cabin.position.set(0, 1.7, -0.6); boat.add(cabin);
      const wind = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.55, 1.2), mGlass2);
      wind.position.set(0, 1.85, 1.6); boat.add(wind);
      boat.position.set(side * wx, 0, wz);
      boat.rotation.y = ry;
      boat.traverse(o => { if (o.isMesh) o.castShadow = true; });
      scene.add(boat);
      seaBits.push({ obj: boat, baseY: 0, phase: Math.random() * 6 });
    }
  }
}
function addDocks() {
  const side = -1;
  // container stacks you can drive between
  const boxCols = [0xb63a2e, 0x2e6db9, 0x3e8a4e, 0xb9902e, 0x7a4a8a];
  for (let i = 0; i < 14; i++) {
    const z = -115 + i * 17 + (Math.random() - 0.5) * 5;
    if (STREETS.some(s => Math.abs(z - s) < ROAD_HALF + 5)) continue;
    const x = side * (124 + Math.random() * 5);
    const stackH = 1 + (Math.random() < 0.45 ? 1 : 0);
    for (let hI = 0; hI < stackH; hI++) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.6, 6.2),
        new THREE.MeshStandardMaterial({ color: boxCols[(i + hI) % boxCols.length], roughness: 0.7, metalness: 0.25 }));
      box.position.set(x, 1.3 + hI * 2.6, z);
      box.castShadow = true;
      scene.add(box);
    }
    addCollider(new THREE.Box3(
      new THREE.Vector3(x - 1.3, 0, z - 3.2), new THREE.Vector3(x + 1.3, stackH * 2.6, z + 3.2)));
  }
  // gantry cranes over the quay
  const mCrane = new THREE.MeshStandardMaterial({ color: 0xd8a018, roughness: 0.55, metalness: 0.4 });
  for (const cz of [-55, 62]) {
    const crane = new THREE.Group();
    for (const [lx, lz] of [[-4, -5], [4, -5], [-4, 5], [4, 5]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.9, 21, 0.9), mCrane);
      leg.position.set(lx, 10.5, lz); crane.add(leg);
    }
    const beamA = new THREE.Mesh(new THREE.BoxGeometry(30, 1.4, 1.2), mCrane);
    beamA.position.set(-8, 21.5, -5); crane.add(beamA);
    const beamB = beamA.clone(); beamB.position.z = 5; crane.add(beamB);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.2, 2.6), mCrane);
    cab.position.set(-14, 19.6, 0); crane.add(cab);
    const cable = new THREE.Mesh(new THREE.BoxGeometry(0.12, 9, 0.12), mCrane);
    cable.position.set(-14, 14, 0); crane.add(cable);
    crane.position.set(side * 137, 0, cz);
    crane.traverse(o => { if (o.isMesh) o.castShadow = true; });
    scene.add(crane);
    addCollider(new THREE.Box3(
      new THREE.Vector3(side * 137 - 5, 0, cz - 6), new THREE.Vector3(side * 137 + 5, 21, cz + 6)));
  }
  // cargo ship moored offshore, deck stacked with containers
  const ship = new THREE.Group();
  const mShipHull = new THREE.MeshStandardMaterial({ color: 0x6e2a20, roughness: 0.7, metalness: 0.3 });
  const hull = new THREE.Mesh(new THREE.BoxGeometry(13, 7, 62), mShipHull);
  hull.position.y = 3.5; ship.add(hull);
  const bow = new THREE.Mesh(new THREE.CylinderGeometry(6.5, 4.5, 7, 3), mShipHull);
  bow.position.set(0, 3.5, 34); bow.rotation.y = Math.PI; ship.add(bow);
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(11, 9, 7),
    new THREE.MeshStandardMaterial({ color: 0xe8e6e0, roughness: 0.6 }));
  bridge.position.set(0, 11.5, -24); ship.add(bridge);
  for (let cI = 0; cI < 8; cI++) {
    const cont = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.5, 6),
      new THREE.MeshStandardMaterial({ color: boxCols[cI % boxCols.length], roughness: 0.7 }));
    cont.position.set((cI % 2 ? 3 : -3), 8.25 + Math.floor(cI / 4) * 2.5, -8 + (cI % 4) * 8);
    ship.add(cont);
  }
  ship.position.set(side * 172, 0, 15);
  ship.rotation.y = 0.06;
  ship.traverse(o => { if (o.isMesh) o.castShadow = true; });
  scene.add(ship);
  seaBits.push({ obj: ship, baseY: 0, phase: 2.2 });
  // harbor buoys
  for (const [bx, bz] of [[150, -90], [158, 40], [147, 110]]) {
    const buoy = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xd82a1e, roughness: 0.5 }));
    buoy.position.set(side * bx, 0.3, bz);
    scene.add(buoy);
    seaBits.push({ obj: buoy, baseY: 0.3, phase: Math.random() * 6 });
  }
}
function addHoloSpire(x, z) {
  const spire = new THREE.Group();
  const mDark = new THREE.MeshStandardMaterial({ color: 0x55637a, roughness: 0.55, metalness: 0.12 });
  const podium = new THREE.Mesh(new THREE.BoxGeometry(17, 5, 17), mDark);
  podium.position.y = 2.5; spire.add(podium);
  let y = 5;
  const tiers = [[13, 16], [10.5, 15], [8, 14], [5.8, 13], [3.8, 11]];
  tiers.forEach(([w, h], i) => {
    const tier = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), mDark);
    tier.position.y = y + h / 2; spire.add(tier);
    const band = new THREE.Mesh(new THREE.BoxGeometry(w + 0.7, 1.1, w + 0.7),
      new THREE.MeshBasicMaterial({ color: THEME.neon[i % THEME.neon.length] }));
    band.position.y = y + h; spire.add(band);
    y += h;
  });
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.3, 13, 6), mDark);
  antenna.position.y = y + 6.5; spire.add(antenna);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff4444 }));
  tip.position.y = y + 13; spire.add(tip);
  blinkers.push({ mesh: tip, phase: Math.random() * 2 });
  spire.position.set(x, 0, z);
  spire.traverse(o => { if (o.isMesh) o.castShadow = true; });
  scene.add(spire);
  addCollider(new THREE.Box3(
    new THREE.Vector3(x - 8.5, 0, z - 8.5), new THREE.Vector3(x + 8.5, y, z + 8.5)));
}
function addWatchtower(x, z) {
  const mAdobe = new THREE.MeshStandardMaterial({ color: 0xa8895c, roughness: 0.95 });
  const tower = new THREE.Group();
  let y = 0;
  for (const [w, h] of [[8, 9], [6.6, 8], [5.2, 7]]) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), mAdobe);
    t.position.y = y + h / 2; tower.add(t);
    y += h;
  }
  // crenellated crown
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const merlon = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.2, 0.9), mAdobe);
    merlon.position.set(Math.cos(a) * 2.3, y + 0.6, Math.sin(a) * 2.3);
    tower.add(merlon);
  }
  // warm lit windows up the shaft
  const mWin = new THREE.MeshBasicMaterial({ color: 0xffc37a });
  for (let wy = 5; wy < y - 2; wy += 5) {
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 1.3), mWin);
    win.position.set(0, wy, 4.05 - (wy / y) * 1.4);
    tower.add(win);
  }
  tower.position.set(x, 0, z);
  tower.traverse(o => { if (o.isMesh) o.castShadow = true; });
  scene.add(tower);
  addCollider(new THREE.Box3(
    new THREE.Vector3(x - 4.2, 0, z - 4.2), new THREE.Vector3(x + 4.2, y, z + 4.2)));
  // low kasbah wall around the tower yard, with an open gate to the south
  for (const [wx, wz, ww, wd, skip] of [
    [0, -13, 28, 1.4, true], [0, 13, 28, 1.4, false], [-13, 0, 1.4, 28, false], [13, 0, 1.4, 28, false]]) {
    if (skip) { // south side: two wall stubs leaving a gate opening
      for (const gx of [-9.5, 9.5]) {
        const stub = new THREE.Mesh(new THREE.BoxGeometry(9, 3, 1.4), mAdobe);
        stub.position.set(x + gx, 1.5, z + wz);
        stub.castShadow = true;
        scene.add(stub);
        addCollider(new THREE.Box3(
          new THREE.Vector3(x + gx - 4.5, 0, z + wz - 0.7), new THREE.Vector3(x + gx + 4.5, 3, z + wz + 0.7)));
      }
      continue;
    }
    const wall = new THREE.Mesh(new THREE.BoxGeometry(ww, 3, wd), mAdobe);
    wall.position.set(x + wx, 1.5, z + wz);
    wall.castShadow = true;
    scene.add(wall);
    addCollider(new THREE.Box3(
      new THREE.Vector3(x + wx - ww / 2, 0, z + wz - wd / 2), new THREE.Vector3(x + wx + ww / 2, 3, z + wz + wd / 2)));
  }
}
function addCityGates() {
  const mAdobe = new THREE.MeshStandardMaterial({ color: 0x9a7f54, roughness: 0.95 });
  const gates = [[0, -118, 0], [0, 118, 0], [-118, 0, Math.PI / 2], [118, 0, Math.PI / 2]];
  for (const [gx, gz, ry] of gates) {
    const gate = new THREE.Group();
    for (const tside of [-1, 1]) {
      const tx = tside * (ROAD_HALF + 3.2);
      const towr = new THREE.Mesh(new THREE.BoxGeometry(5.5, 13, 5.5), mAdobe);
      towr.position.set(tx, 6.5, 0); gate.add(towr);
      for (let mI = 0; mI < 4; mI++) {
        const merlon = new THREE.Mesh(new THREE.BoxGeometry(1, 1.1, 1), mAdobe);
        merlon.position.set(tx - 2 + mI * 1.33, 13.55, 2.2); gate.add(merlon);
        const merlon2 = merlon.clone(); merlon2.position.z = -2.2; gate.add(merlon2);
      }
    }
    // lintel spanning the road — traffic passes underneath
    const lintel = new THREE.Mesh(new THREE.BoxGeometry((ROAD_HALF + 3.2) * 2 + 5.5, 3.4, 4.6), mAdobe);
    lintel.position.set(0, 10.6, 0); gate.add(lintel);
    // warm lantern strip under the arch so the gate glows at any hour
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(ROAD_HALF * 2, 0.35, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xffb35c }));
    lamp.position.set(0, 8.85, 0); gate.add(lamp);
    for (let mI = 0; mI < 9; mI++) {
      const merlon = new THREE.Mesh(new THREE.BoxGeometry(1, 1.1, 1), mAdobe);
      merlon.position.set(-8 + mI * 2, 12.85, 1.6); gate.add(merlon);
    }
    gate.position.set(gx, 0, gz);
    gate.rotation.y = ry;
    gate.traverse(o => { if (o.isMesh) o.castShadow = true; });
    scene.add(gate);
    // collide only with the two towers, keeping the road open
    for (const tside of [-1, 1]) {
      const c = new THREE.Vector3(ROAD_HALF + 3.2, 0, 0).multiplyScalar(tside);
      c.applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
      addCollider(new THREE.Box3(
        new THREE.Vector3(gx + c.x - 2.8, 0, gz + c.z - 2.8),
        new THREE.Vector3(gx + c.x + 2.8, 13, gz + c.z + 2.8)));
    }
  }
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
// live weather that changes while you play, like a real forecast
const weather = { state: 'sun', amount: 0, prob: 0.3, t: 60 };
function updateAtmosphere(dt) {
  weather.t -= dt;
  if (weather.t <= 0) {
    weather.t = 60 + Math.random() * 90;
    const wantRain = Math.random() < weather.prob;
    if (wantRain !== (weather.state === 'rain')) {
      weather.state = wantRain ? 'rain' : 'sun';
      if (started && !cine.active) {
        addFeed(weather.state === 'rain' ? '🌧 Rain shower rolling in' : '☀ Skies clearing up');
        showBanner(weather.state === 'rain' ? 'RAIN SHOWER' : 'SUNNY SKIES');
      }
    }
  }
  const targetRain = weather.state === 'rain' ? Math.max(THEME ? THEME.rain : 0, 900) : 0;
  weather.amount += (targetRain - weather.amount) * Math.min(1, dt * 0.3);
  const n = weather.amount | 0;
  rainPts.visible = n > 4;
  rainPts.geometry.setDrawRange(0, n);
  if (n > 4) {
    const p = rainPts.geometry.attributes.position.array;
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
  // traffic signals: opposite corners alternate green/red on a 12s cycle
  for (const t of trafficLamps) {
    const green = ((game.time / 12 + t.off) % 1) < 0.5;
    if (green !== t.green) {
      t.green = green;
      t.lamp.material.color.set(green ? 0x35e06a : 0xff3b30);
      t.lamp.position.y = green ? 4.34 : 4.86;
    }
  }

  // police light bars strobe red/blue
  for (const pl of policeLights) {
    const t = (game.time + pl.phase) % 0.7;
    pl.red.visible = t < 0.35;
    pl.blue.visible = t >= 0.35;
  }

  // boats, ships and buoys ride a gentle swell
  for (const b of seaBits) {
    const t = game.time + b.phase;
    b.obj.position.y = b.baseY + Math.sin(t * 0.8) * 0.14;
    b.obj.rotation.z = Math.sin(t * 0.6) * 0.025;
    b.obj.rotation.x = Math.sin(t * 0.45 + 1.3) * 0.018;
  }

  if (THEME && THEME.thunder && weather.state === 'rain') {
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
  if (e.code === 'KeyC' && driving) cycleCam();
  if (e.code === 'KeyB' && (locked || shopOpen)) toggleShop();
  if (e.code === 'KeyF') {
    if (locked && actSpot && !cafeOpen && !nearRest) actSpot.cb();
    else if (locked || cafeOpen) toggleCafe();
  }
  if (e.code === 'KeyV' && locked) toggleRecord();
  if (e.code === 'KeyG' && locked) spawnRide();
  if (e.code === 'KeyX' && locked) launchDrone();
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
  if (e.button === 0 && !(THEME && THEME.noGuns)) { firing = true; pendingShot = true; }
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

// ---------------------------------------------------------------------------
// Touch controls — phones and tablets play with a virtual joystick,
// drag-to-look, and on-screen action buttons
// ---------------------------------------------------------------------------
const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const touchMove = { x: 0, y: 0, hard: false };
let joyTouchId = null, lookTouchId = null, lastLook = null;
if (isTouch) {
  const ui = document.getElementById('touchui');
  ui.style.display = 'block';
  const joy = document.getElementById('joy');
  const knob = document.getElementById('joyknob');
  const setKnob = (dx, dy) => { knob.style.transform = `translate(${dx}px, ${dy}px)`; };
  const joyCenter = () => {
    const r = joy.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  document.addEventListener('touchstart', e => {
    if (!started || player.dead) return;
    if (cine.active) { if (cine.t > 0.5) finishCinematic(); return; }
    for (const t of e.changedTouches) {
      if (t.target.closest && t.target.closest('.tbtn, #shop, .overlay')) continue;
      if (t.clientX < window.innerWidth * 0.42 && t.clientY > window.innerHeight * 0.4 && joyTouchId === null) {
        joyTouchId = t.identifier;
      } else if (lookTouchId === null) {
        lookTouchId = t.identifier;
        lastLook = { x: t.clientX, y: t.clientY };
      }
    }
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === joyTouchId) {
        const c = joyCenter();
        let dx = t.clientX - c.x, dy = t.clientY - c.y;
        const len = Math.hypot(dx, dy), max = 55;
        if (len > max) { dx = dx / len * max; dy = dy / len * max; }
        setKnob(dx, dy);
        touchMove.x = dx / max;
        touchMove.y = dy / max;
        touchMove.hard = len > max * 0.9;
      } else if (t.identifier === lookTouchId && lastLook) {
        player.yaw -= (t.clientX - lastLook.x) * 0.005;
        player.pitch -= (t.clientY - lastLook.y) * 0.005;
        player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch));
        lastLook = { x: t.clientX, y: t.clientY };
      }
    }
  }, { passive: true });
  document.addEventListener('touchend', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === joyTouchId) {
        joyTouchId = null;
        touchMove.x = touchMove.y = 0;
        touchMove.hard = false;
        setKnob(0, 0);
      }
      if (t.identifier === lookTouchId) { lookTouchId = null; lastLook = null; }
    }
  }, { passive: true });

  const hold = (id, down, up) => {
    const el = document.getElementById(id);
    el.addEventListener('touchstart', e => { e.preventDefault(); el.classList.add('on'); down(); }, { passive: false });
    el.addEventListener('touchend', e => { e.preventDefault(); el.classList.remove('on'); if (up) up(); }, { passive: false });
  };
  hold('btnFire', () => { if (THEME && THEME.noGuns) return; firing = true; pendingShot = true; }, () => { firing = false; });
  hold('btnAim', () => { aiming = !aiming; document.getElementById('btnAim').classList.toggle('on', aiming); }, () => {
    document.getElementById('btnAim').classList.toggle('on', aiming); });
  hold('btnJump', () => { keys['Space'] = true; }, () => { keys['Space'] = false; });
  hold('btnAct', () => toggleDrive(), null);
  hold('btnQ', () => drinkEnergy(), null);
  hold('btnShop', () => toggleShop(), null);
  hold('btnRec', () => toggleRecord(), null);
  hold('btnRide', () => spawnRide(), null);
  hold('btnDrone', () => launchDrone(), null);
  hold('btnCam', () => { if (driving) cycleCam(); }, null);
}

const menuEl = document.getElementById('menu');
const pausedEl = document.getElementById('paused');
const gameoverEl = document.getElementById('gameover');
const hudEl = document.getElementById('hud');

function requestLock() { canvas.requestPointerLock(); }
menuEl.addEventListener('click', () => {
  audioInit();
  // real-game presentation: take the whole screen
  try { document.documentElement.requestFullscreen?.()?.catch(() => {}); } catch {}
  if (!CITY) buildCity(selectedCity());
  if (isTouch) {
    // phones have no pointer lock — start the game directly
    locked = true;
    menuEl.style.display = 'none';
    pausedEl.style.display = 'none';
    if (!started) { started = true; cgGame('start'); startCinematic(); }
    else if (!cine.active) hudEl.style.display = 'block';
    if (AC && AC.state === 'suspended') AC.resume();
  } else {
    requestLock();
  }
});
pausedEl.addEventListener('click', () => {
  if (isTouch) { locked = true; pausedEl.style.display = 'none'; hudEl.style.display = 'block'; }
  else requestLock();
});
gameoverEl.addEventListener('click', () => location.reload());

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (locked) {
    menuEl.style.display = 'none';
    pausedEl.style.display = 'none';
    if (!started) { started = true; cgGame('start'); startCinematic(); }
    else if (!cine.active) hudEl.style.display = 'block';
    if (AC && AC.state === 'suspended') AC.resume();
  } else if (started && !player.dead && !shopOpen && !cafeOpen
      && document.getElementById('clip').style.display === 'none') {
    pausedEl.style.display = 'flex';
    firing = false; aiming = false;
    for (const k in keys) keys[k] = false;
  }
});
document.getElementById('shopclose').addEventListener('click', () => { if (shopOpen) toggleShop(); });

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

// the order you're carrying: a branded pizza box in your off hand
const carryBox = new THREE.Group();
{
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.07, 0.34),
    new THREE.MeshStandardMaterial({ color: 0xf2ece0, roughness: 0.8 }));
  carryBox.add(box);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.345, 0.025, 0.345),
    new THREE.MeshStandardMaterial({ color: 0xd8352a, roughness: 0.7 }));
  stripe.position.y = 0.012;
  carryBox.add(stripe);
  carryBox.position.set(-0.3, -0.26, -0.5);
  carryBox.rotation.set(0.15, 0.3, 0.05);
  carryBox.visible = false;
  camera.add(carryBox);
}
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
    const dmg = (headshot ? w.damage * 2 : w.damage) * (1 + 0.08 * upgLvl('weap'));
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

function spawnEnemy(x, z, boss = false) {
  const rig = makeSoldier();
  rig.group.position.set(x, 0, z);
  if (boss) rig.group.scale.setScalar(1.45);
  scene.add(rig.group);
  enemies.push({
    rig,
    boss,
    pos: rig.group.position,
    health: (100 + Math.min(prog.level * 2, 120)) * (boss ? 6 : 1),
    dead: false,
    deathT: 0,
    fireCooldown: 1 + Math.random() * 1.5,
    strafe: Math.random() < 0.5 ? 1 : -1,
    strafeT: 1 + Math.random() * 2,
    walkPhase: Math.random() * 6,
    speed: boss ? 2.3 : 3.0 + Math.random() * 1.2,
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
    bumpStat('kills');
    if (en.boss) {
      game.money += 150;
      prog.bank += 150;
      saveProg();
      playCheer();
      showBanner('💀 BOSS DOWN +$150');
      addFeed('💀 Gang boss eliminated — +$150 bounty');
      addXP(40);
    } else addFeed('Hostile down');
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
const CAM_MODES = ['chase', 'far', 'hood', 'top'];
let camMode = 'chase'; // C or the 📷 button cycles all four
function cycleCam() {
  camMode = CAM_MODES[(CAM_MODES.indexOf(camMode) + 1) % CAM_MODES.length];
  showBanner('📷 ' + { chase: 'CHASE CAM', far: 'FAR CAM', hood: 'DRIVER CAM', top: 'TOP CAM' }[camMode]);
}
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
    gun.visible = !(THEME && THEME.noGuns);
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
    if (need && prog.level < need && !v.owned) {
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
  const touchAccel = -touchMove.y; // joystick up = throttle, down = reverse
  const noFuel = st.engine && v.fuel <= 0;
  const accel = wrecked || noFuel ? 0
    : keys['KeyW'] ? st.accel * boost
    : keys['KeyS'] ? -st.accel * 0.65
    : touchAccel > 0.15 ? st.accel * boost * touchAccel
    : touchAccel < -0.15 ? st.accel * 0.65 * touchAccel
    : 0;
  v.speed += accel * dt;
  v.speed -= v.speed * 0.55 * dt;
  // real brakes on Space
  if (keys['Space']) v.speed -= Math.sign(v.speed) * Math.min(Math.abs(v.speed), 26 * dt);
  v.speed = Math.max(st.maxR, Math.min(st.maxF * boost * (1 + 0.05 * upgLvl('engine')), v.speed));
  if (st.engine) {
    v.fuel = Math.max(0, v.fuel - (0.15 + Math.abs(v.speed) / st.maxF * 1.1) * dt * (accel ? 1 : 0.3));
    if (v.fuel < 20 && !v.fuelWarned) {
      v.fuelWarned = true;
      say('Low fuel. Find a petrol station.');
      const fs = FUEL_STATIONS[0] || { x: 0, z: 0 };
      phoneNotify('⛽ LOW FUEL', 'Refuel at a petrol station — orange on the map', fs.x, fs.z);
    }
    if (v.fuel > 40) v.fuelWarned = false;
    if (v.fuel <= 0 && !v.fuelDead) {
      v.fuelDead = true;
      showBanner('⛽ OUT OF FUEL — roll it to a petrol station!');
    }
    if (v.fuel > 1) v.fuelDead = false;
    // refuel while parked at a station: 10 fuel costs $1
    let atPump = false;
    for (const fs of FUEL_STATIONS) {
      if (Math.abs(v.group.position.x - fs.x) < 9 && Math.abs(v.group.position.z - fs.z) < 9
          && Math.abs(v.speed) < 1 && v.fuel < 100) {
        const wallet = game.money + prog.bank;
        if (wallet <= 0.05) break;
        const add = Math.min(16 * dt, 100 - v.fuel, wallet * 10);
        v.fuel += add;
        const cost = add * 0.1;
        const fromMoney = Math.min(cost, game.money);
        game.money -= fromMoney;
        prog.bank -= cost - fromMoney;
        atPump = true;
        if (!v.refueling) {
          v.refueling = true;
          showBanner('⛽ Refuelling — stay parked');
          playClick(1100, 0.12);
        }
        break;
      }
    }
    if (!atPump && v.refueling) { v.refueling = false; saveProg(); }
    // car wash: park between the brushes to repair the bodywork ($8)
    for (const ws of WASH_STATIONS) {
      if (Math.abs(v.group.position.x - ws.x) < 8 && Math.abs(v.group.position.z - ws.z) < 8
          && Math.abs(v.speed) < 1 && v.health < 100) {
        if (game.money + prog.bank < 8) break;
        v.washT = (v.washT || 0) + dt;
        if (!v.washing) { v.washing = true; showBanner('🧼 Washing — stay parked'); }
        if (v.washT > 2.5) {
          v.health = 100;
          v.washT = 0; v.washing = false;
          const fromMoney = Math.min(8, game.money);
          game.money -= fromMoney;
          prog.bank -= 8 - fromMoney;
          saveProg();
          showBanner('✨ CAR WASHED — LIKE NEW');
          playChirp();
        }
      } else if (v.washing && Math.abs(v.speed) >= 1) { v.washing = false; v.washT = 0; }
    }
  }
  const steer = (keys['KeyA'] ? 1 : 0) - (keys['KeyD'] ? 1 : 0)
    - (Math.abs(touchMove.x) > 0.15 ? touchMove.x : 0);
  v.yaw += steer * Math.min(Math.abs(v.speed) / 6, 1) * st.turn * dt * Math.sign(v.speed || 1);
  v.group.rotation.y = v.yaw;
  // scooters and bikes lean into turns
  if (v.type !== 'car') v.group.rotation.z = -steer * Math.min(Math.abs(v.speed) / st.maxF, 1) * 0.25;
  v.group.position.addScaledVector(fwd, v.speed * dt);
  spinWheels(v.group, v.speed * dt);
  const preSpeed = v.speed;
  if (resolveCollisions(v.group.position, 1.5, st.radius)) {
    const impact = Math.abs(preSpeed);
    if (impact > 6) {
      // crash: damage, sparks, crunch, shake
      v.health = Math.max(0, v.health - (impact - 5) * 3.2);
      playCrash(Math.min(1, impact / 30));
      if (impact > 15) addHeat(1, 'Reckless crash');
      if (prog.quest === 8 && order.active && impact > 8 && prog.q8clean) {
        prog.q8clean = 0;
        showBanner('📜 Crash! The clean-hands count resets…');
        refreshQuestbar();
      }
      if (impact > 10 && order.active && order.stage === 'dropoff' && order.fragile && !order.dropped) {
        order.dropped = true;
        order.reward = Math.round(order.reward / 2);
        showBanner('📦 Package damaged — payout halved!');
        addFeed('📦 The fragile order got crushed in that crash');
      }
      const nose = v.group.position.clone().addScaledVector(fwd, Math.sign(preSpeed) * st.size[1] / 2);
      nose.y = 0.7;
      spawnImpact(nose);
      spawnSmoke(nose);
      shake = Math.min(shake + 0.15 + impact * 0.015, 0.9);
      // crash damage transfers to whichever parked car you hit
      for (const v2 of vehicles) {
        if (v2 === v) continue;
        if (Math.hypot(v2.group.position.x - nose.x, v2.group.position.z - nose.z) < 3.4) {
          const wasAlive = v2.health > 0;
          v2.health = Math.max(0, v2.health - (impact - 4) * 2.5);
          addFeed(v2.health <= 0 && wasAlive
            ? `💥 Wrecked a parked ${v2.stats.label}!`
            : `💥 Damaged a parked ${v2.stats.label}`);
          if (v2.type === 'police') addHeat(2, 'Smashed a police car');
          else if (impact > 12) addHeat(1, 'Smashed a parked car');
          break;
        }
      }
      if (v.health <= 0 && !v.wrecked) {
        v.wrecked = true;
        engineStop();
        addFeed('🚗 Vehicle wrecked — press E and find another ride');
        showBanner('VEHICLE WRECKED');
      }
    } else if (impact > 2) playClick(260, 0.2);
    v.speed *= -0.25;
  }
  // moving traffic: real collisions instead of ghosting through
  for (const c of traffic) {
    const dx = c.group.position.x - v.group.position.x;
    const dz = c.group.position.z - v.group.position.z;
    if (Math.hypot(dx, dz) < 3.0) {
      const impact = Math.abs(v.speed);
      if (impact > 3) {
        v.health = Math.max(0, v.health - (impact - 3) * 2.2);
        playCrash(Math.min(1, impact / 28));
        const mid = v.group.position.clone().lerp(c.group.position, 0.5);
        mid.y = 0.8;
        spawnImpact(mid);
        spawnSmoke(mid);
        shake = Math.min(shake + 0.12 + impact * 0.012, 0.9);
        c.stunT = 3.5; // the other driver slams the brakes
        c.v += Math.sign(c.alongX ? dx : dz) * 2.5;
        placeTrafficCar(c);
        v.speed *= -0.25;
        if (impact > 10) addHeat(1, 'Crashed into traffic');
        if (v.health <= 0 && !v.wrecked) {
          v.wrecked = true;
          engineStop();
          addFeed('🚗 Vehicle wrecked — press E and find another ride');
          showBanner('VEHICLE WRECKED');
        }
      }
      break;
    }
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
  // knocking pedestrians down is a crime — the police notice
  if (Math.abs(v.speed) > 8)
    for (const pd of peds) {
      if (pd.downT > 0) continue;
      const gp2 = pd.rig.group.position;
      if (Math.hypot(gp2.x - v.group.position.x, gp2.z - v.group.position.z) < st.kill) {
        pd.downT = 6;
        pd.rig.group.rotation.z = Math.PI / 2;
        pd.rig.group.position.y = 0.35;
        v.speed *= 0.9;
        shake = Math.min(shake + 0.2, 0.6);
        playClick(180, 0.3);
        addHeat(1, 'Hit a pedestrian');
      }
    }

  player.pos.set(v.group.position.x, 0, v.group.position.z);
  if (camMode === 'top') {
    // bird's-eye: straight down, road ahead pointing up the screen
    camera.up.set(Math.sin(player.yaw), 0, Math.cos(player.yaw));
    camera.position.set(v.group.position.x, 34, v.group.position.z);
    camera.lookAt(v.group.position.x, 0, v.group.position.z);
  } else if (camMode === 'hood') {
    camera.up.set(0, 1, 0);
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
    camera.up.set(0, 1, 0);
    // third-person chase camera: behind the car, mouse orbits, walls pull it in
    const far = camMode === 'far';
    const dist = (6.2 + st.size[1] * 0.4) * (far ? 1.9 : 1);
    const orbit = new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw));
    const from = v.group.position.clone().setY(1.5);
    const want = from.clone().addScaledVector(orbit, -dist);
    want.y = far ? Math.min(11, Math.max(4, 6.5 - player.pitch * 4))
      : Math.min(6, Math.max(1.6, 2.8 - player.pitch * 4));
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
  if (st.engine && engineNodes) {
    const f = st.freq + Math.abs(v.speed) * 5.5;
    engineNodes.osc.frequency.value = f;
    if (engineNodes.osc2) engineNodes.osc2.frequency.value = f / 2;
    engineNodes.g.gain.value = 0.09 + Math.min(0.09, Math.abs(v.speed) * 0.003);
  }
  speedoEl.textContent = st.label + ' · ' + Math.round(Math.abs(v.speed) * 3.6) + ' KM/H'
    + (st.engine ? (v.refueling ? ' · ⛽ REFUELLING…' : ` · ⛽${Math.round(v.fuel)}%`) : '')
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
  if (player.dead || game.time < reviveSafeT) return;
  player.health -= dmg * (1 - 0.06 * upgLvl('vest'));
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
  cgGame('stop');
  // first death offers a rewarded CONTINUE instead; midgame only after it's used
  if (revivedThisRun) setTimeout(showMidgameAd, 1200);
  firing = false;
  slowmo = 1.6;
  shake = 0.9;
  streakAtDeath = game.streak;
  game.streak = 0;
  // personal records
  prog.best = prog.best || {};
  let newRec = false;
  for (const [k, v] of [['deliveries', game.deliveries], ['cash', game.money], ['wave', game.wave], ['kills', game.kills]]) {
    if (v > (prog.best[k] || 0)) { prog.best[k] = v; newRec = true; }
  }
  saveProg();
  if (newRec) setTimeout(() => showBanner('🏆 NEW PERSONAL RECORD'), 300);
  if (driving) { engineStop(); speedoEl.style.display = 'none'; driving = null; gun.visible = !(THEME && THEME.noGuns); }
  canvas.style.filter = 'grayscale(0.85) brightness(0.75)';
  document.querySelector('#gameover .stats').innerHTML = `<b>${playerName()}</b><br>` + (mode === 'delivery'
    ? `Deliveries completed: <b>${game.deliveries}</b><br>Cash earned: <b>$${game.money}</b><br>Eliminations: <b>${game.kills}</b>`
    : `Waves survived: <b>${game.wave}</b><br>Eliminations: <b>${game.kills}</b>`)
    + `<br>Driver level: <b>${prog.level} / 100</b>`
    + `<br><span style="font-size:14px;color:#9fb2c4">Records — deliveries ${prog.best.deliveries || 0} · cash $${prog.best.cash || 0} · wave ${prog.best.wave || 0}</span>`;
  saveProg();
  document.exitPointerLock();
  pausedEl.style.display = 'none';
  recordScore();
  const rv = document.getElementById('gorevive');
  rv.style.display = revivedThisRun ? 'none' : '';
  rv.textContent = ADS ? '📺 WATCH AD → CONTINUE YOUR RUN' : '💪 SECOND CHANCE → CONTINUE YOUR RUN';
  const cost = reviveCost();
  const buy = document.getElementById('gobuy');
  buy.style.display = game.money >= cost ? '' : 'none';
  buy.textContent = `💵 PAY $${cost} → CONTINUE YOUR RUN`;
  setTimeout(() => { gameoverEl.style.display = 'flex'; }, 1400);
}

// Second chances: one free per run for watching an ad, or pay with the cash
// earned this run (the price doubles each time). The player keeps money,
// deliveries and streak, wakes with full health, and the danger is cleared.
let revivedThisRun = false, reviveBuys = 0, streakAtDeath = 0, reviveSafeT = 0;
function reviveCost() { return 300 * Math.pow(2, reviveBuys); }
function revivePlayer() {
  player.dead = false;
  player.health = 100;
  game.streak = streakAtDeath;
  reviveSafeT = game.time + 4;
  slowmo = 0;
  shake = 0;
  canvas.style.filter = '';
  clearPursuit(false);
  for (let i = enemies.length - 1; i >= 0; i--) {
    const en = enemies[i];
    if (!en.dead) { scene.remove(en.rig.group); enemies.splice(i, 1); }
  }
  gameoverEl.style.display = 'none';
  cgGame('start');
  celebrate('BACK ON YOUR FEET', '💪');
  addFeed('📺 Second chance — your run continues!');
  if (isTouch) { locked = true; hudEl.style.display = 'block'; }
  else pausedEl.style.display = 'flex';
}
document.getElementById('gorevive').addEventListener('click', e => {
  e.stopPropagation();
  if (revivedThisRun || !player.dead) return;
  showRewardedAd(() => { revivedThisRun = true; revivePlayer(); });
});
document.getElementById('gobuy').addEventListener('click', e => {
  e.stopPropagation();
  const cost = reviveCost();
  if (!player.dead || game.money < cost) return;
  game.money -= cost;
  reviveBuys++;
  addFeed(`💵 Paid $${cost} for a second chance`);
  revivePlayer();
});

// ---------------------------------------------------------------------------
// Celebration burst — confetti + a big popping title for every win moment
// (level up, new car, new outfit, career goal, spin prize, second chance)
// ---------------------------------------------------------------------------
const celebRoot = document.createElement('div');
celebRoot.id = 'celebrate';
document.body.appendChild(celebRoot);
const celebCss = document.createElement('style');
celebCss.textContent = `
#celebrate { position: fixed; inset: 0; pointer-events: none; z-index: 55; }
#celebrate .celeb { position: absolute; left: 50%; top: 38%; }
#celebrate .ctext { position: absolute; transform: translate(-50%,-50%); white-space: nowrap;
  font-weight: 800; font-size: 30px; letter-spacing: 2px; color: #ffd479;
  text-shadow: 0 2px 14px rgba(0,0,0,.9), 0 0 26px rgba(255,212,121,.45);
  animation: cpop 2s ease-out forwards; }
#celebrate .cemoji { font-size: 40px; margin-right: 10px; vertical-align: -6px; }
#celebrate i { position: absolute; width: 9px; height: 14px; border-radius: 2px;
  animation: cfly 1.6s cubic-bezier(.16,.84,.44,1) forwards; }
@keyframes cpop { 0% { transform: translate(-50%,-50%) scale(.2); opacity: 0; }
  14% { transform: translate(-50%,-50%) scale(1.28); opacity: 1; }
  24% { transform: translate(-50%,-50%) scale(1); }
  78% { opacity: 1; } 100% { transform: translate(-50%,-90%) scale(1); opacity: 0; } }
@keyframes cfly { 0% { transform: translate(0,0) rotate(0deg); opacity: 1; }
  100% { transform: translate(var(--dx), var(--dy)) rotate(560deg); opacity: 0; } }`;
document.head.appendChild(celebCss);
function celebrate(title, emoji = '🎉') {
  const wrap = document.createElement('div');
  wrap.className = 'celeb';
  const cols = ['#ffd23f', '#41c9ff', '#ff5f8f', '#3ddc84', '#c98bff', '#ff9d3f'];
  let inner = `<div class="ctext"><span class="cemoji">${emoji}</span>${title}</div>`;
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2, d = 90 + Math.random() * 170;
    inner += `<i style="background:${cols[i % cols.length]};` +
      `--dx:${(Math.cos(a) * d).toFixed(0)}px;--dy:${(Math.sin(a) * d - 70).toFixed(0)}px;` +
      `animation-delay:${(Math.random() * 0.14).toFixed(2)}s"></i>`;
  }
  wrap.innerHTML = inner;
  celebRoot.appendChild(wrap);
  playCheer();
  setTimeout(() => wrap.remove(), 2100);
}

// ---------------------------------------------------------------------------
// Waves + HUD
// ---------------------------------------------------------------------------
const game = { wave: 0, kills: 0, money: 0, deliveries: 0, streak: 0, time: 0, intermission: 0 };

// ---------------------------------------------------------------------------
// Driver progression — 100 levels, persistent across sessions
// ---------------------------------------------------------------------------
const prog = (() => {
  try { return Object.assign({ level: 1, xp: 0, bank: 0, upg: {} }, JSON.parse(localStorage.getItem('streetops.prog'))); }
  catch { return { level: 1, xp: 0, bank: 0, upg: {} }; }
})();
prog.upg = prog.upg || {};
prog.garage = prog.garage || {};
prog.wardrobe = prog.wardrobe || { street: true };
prog.outfit = prog.outfit || 'street';
prog.stats = prog.stats || {};
prog.achs = prog.achs || {};
prog.stats.cities = prog.stats.cities || {};

// ---------------------------------------------------------------------------
// Career ranks — a new title every 10 driver levels
// ---------------------------------------------------------------------------
const RANKS = ['ROOKIE', 'RUNNER', 'COURIER', 'PRO', 'HUSTLER',
  'VETERAN', 'ACE', 'BOSS', 'ELITE', 'LEGEND'];
function rankName() {
  return RANKS[Math.min(Math.floor((prog.level - 1) / 10), RANKS.length - 1)];
}

// ---------------------------------------------------------------------------
// Garage — buy vehicles with bank money and own them forever; G calls
// your selected ride to the nearest street
// ---------------------------------------------------------------------------
const GARAGE = [
  { type: 'car',     icon: '🚗', price: 600,   desc: 'Reliable city sedan' },
  { type: 'suv',     icon: '🚙', price: 900,   desc: 'Big 4x4 — shrugs off crashes' },
  { type: 'pickup',  icon: '🛻', price: 1500,  desc: 'Workhorse truck — tough as nails' },
  { type: 'sports',  icon: '🏎', price: 2500,  desc: 'Low, loud and fast' },
  { type: 'luxury',  icon: '🚘', price: 3200,  desc: 'Long executive sedan' },
  { type: 'muscle',  icon: '🐎', price: 4200,  desc: 'Old-school V8 muscle' },
  { type: 'phantom', icon: '🕴', price: 5000,  desc: 'The VIP limousine' },
  { type: 'offroad', icon: '🏜', price: 6500,  desc: 'Desert rally beast' },
  { type: 'hyper',   icon: '⚡', price: 9000,  desc: 'The fastest thing on wheels' },
  { type: 'gtr',     icon: '🏁', price: 14000, desc: 'Track legend — pure speed' },
  { type: 'royal',   icon: '👑', price: 25000, desc: 'The golden royal limousine' },
];
let myRide = null;
function spawnRide() {
  if (!started || player.dead || cine.active || driving) return;
  const t = prog.ride;
  if (!t || !prog.garage[t]) {
    addFeed('🔒 No car owned yet — buy one in the DRIVER SHOP (B)');
    playClick(320, 0.15);
    return;
  }
  if (myRide) {
    const i = vehicles.indexOf(myRide);
    if (i >= 0) vehicles.splice(i, 1);
    const ci = colliders.indexOf(myRide.box);
    if (ci >= 0) colliders.splice(ci, 1);
    scene.remove(myRide.group);
    myRide = null;
  }
  // deliver the car onto the NEAREST road, a few metres along it — never
  // into a building (random street points can be far away or off-road)
  let bestS = STREETS[0], bestD = 1e9, axis = 'x';
  for (const s of STREETS) {
    if (Math.abs(player.pos.x - s) < bestD) { bestD = Math.abs(player.pos.x - s); bestS = s; axis = 'x'; }
    if (Math.abs(player.pos.z - s) < bestD) { bestD = Math.abs(player.pos.z - s); bestS = s; axis = 'z'; }
  }
  const clamp = n => Math.max(-BOUND, Math.min(BOUND, n));
  const p = axis === 'x'
    ? { x: bestS + 3, z: clamp(player.pos.z + 7) }
    : { x: clamp(player.pos.x + 7), z: bestS + 3 };
  const colors = CAR_STYLE_COLORS[t] || CAR_STYLE_COLORS.car;
  const v = registerVehicle(buildCarMesh(colors[Math.floor(Math.random() * colors.length)], t),
    p.x, p.z, axis === 'x' ? 0 : Math.PI / 2, t);
  v.owned = true;
  v.fuel = 100;
  myRide = v;
  showBanner(`${v.stats.label} DELIVERED 🔑`);
  addFeed(`🚗 Your ${v.stats.label} just pulled up — press E next to it`);
  playClick(1500, 0.25);
}
function renderGarage() {
  const box = document.getElementById('garageitems');
  box.innerHTML = '';
  for (const gcar of GARAGE) {
    const owned = !!prog.garage[gcar.type];
    const active = prog.ride === gcar.type;
    const st = VEH_STATS[gcar.type];
    const row = document.createElement('div');
    row.className = 'shopitem' + (owned ? ' done' : '');
    row.innerHTML = `<div class="ic">${gcar.icon}</div><div class="info">` +
      `<div class="nm">${st.label}${active ? ' · <span style="color:#7dff8a">YOUR RIDE</span>' : ''}</div>` +
      `<div class="ds">${gcar.desc} · top speed ${Math.round(st.maxF * 3.6)} km/h</div></div>`;
    const btn = document.createElement('button');
    btn.className = 'buybtn';
    btn.textContent = owned ? (active ? 'SELECTED' : 'USE') : `BUY $${gcar.price}`;
    btn.disabled = active || (!owned && prog.bank < gcar.price);
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (!owned) {
        if (prog.bank < gcar.price) return;
        prog.bank -= gcar.price;
        prog.garage[gcar.type] = true;
        prog.stats.cars = Object.keys(prog.garage).length;
        addFeed(`🔑 You now OWN the ${st.label} — press G to call it`);
        celebrate(`${st.label} IS YOURS!`, '🔑');
        checkAchs();
      }
      prog.ride = gcar.type;
      saveProg();
      playClick(2000, 0.25);
      renderShop();
    });
    row.appendChild(btn);
    box.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Career goals — lifetime achievements with cash rewards
// ---------------------------------------------------------------------------
const ACHS = [
  { id: 'd1',   icon: '🍕', name: 'FIRST DROP',       desc: 'Complete 1 delivery',         need: 1,     key: 'deliv',   reward: 50 },
  { id: 'd10',  icon: '📦', name: 'REGULAR RUNNER',   desc: 'Complete 10 deliveries',      need: 10,    key: 'deliv',   reward: 150 },
  { id: 'd50',  icon: '🚀', name: 'DELIVERY MACHINE', desc: 'Complete 50 deliveries',      need: 50,    key: 'deliv',   reward: 500 },
  { id: 'd200', icon: '👑', name: 'CITY LEGEND',      desc: 'Complete 200 deliveries',     need: 200,   key: 'deliv',   reward: 2000 },
  { id: 'k10',  icon: '🥊', name: 'DEFENDER',         desc: 'Stop 10 robbers',             need: 10,    key: 'kills',   reward: 100 },
  { id: 'k100', icon: '💀', name: 'STREET SOLDIER',   desc: 'Stop 100 robbers',            need: 100,   key: 'kills',   reward: 800 },
  { id: 'e1',   icon: '🚓', name: 'CLEAN GETAWAY',    desc: 'Escape the police once',      need: 1,     key: 'escapes', reward: 100 },
  { id: 'e10',  icon: '🏁', name: 'UNCATCHABLE',      desc: 'Escape the police 10 times',  need: 10,    key: 'escapes', reward: 600 },
  { id: 'c3',   icon: '🌍', name: 'TRAVELER',         desc: 'Play in 3 different cities',  need: 3,     key: 'cityN',   reward: 200 },
  { id: 'c7',   icon: '🧭', name: 'WORLD TOUR',       desc: 'Play in all 7 cities',        need: 7,     key: 'cityN',   reward: 700 },
  { id: 'g1',   icon: '🚗', name: 'CAR OWNER',        desc: 'Buy your first car',          need: 1,     key: 'cars',    reward: 150 },
  { id: 'g3',   icon: '🏎', name: 'COLLECTOR',        desc: 'Own 3 vehicles',              need: 3,     key: 'cars',    reward: 500 },
  { id: 'g6',   icon: '🏆', name: 'FULL GARAGE',      desc: 'Own all 6 vehicles',          need: 6,     key: 'cars',    reward: 1500 },
  { id: 'm1k',  icon: '💰', name: 'FIRST GRAND',      desc: 'Earn $1,000 lifetime',        need: 1000,  key: 'earned',  reward: 200 },
  { id: 'm10k', icon: '🏦', name: 'HIGH ROLLER',      desc: 'Earn $10,000 lifetime',       need: 10000, key: 'earned',  reward: 1000 },
  { id: 'l10',  icon: '⭐', name: 'RISING STAR',      desc: 'Reach driver level 10',       need: 10,    key: 'level',   reward: 200 },
  { id: 'l25',  icon: '🌟', name: 'TOP DRIVER',       desc: 'Reach driver level 25',       need: 25,    key: 'level',   reward: 600 },
  { id: 'l50',  icon: '💫', name: 'HALF CENTURY',     desc: 'Reach driver level 50',       need: 50,    key: 'level',   reward: 1500 },
  { id: 's3',   icon: '📣', name: 'INFLUENCER',       desc: 'Share the game 3 times',      need: 3,     key: 'shares',  reward: 300 },
  { id: 'r1',   icon: '🏁', name: 'FIRST PODIUM',     desc: 'Win a street race',           need: 1,     key: 'races',   reward: 200 },
  { id: 'r10',  icon: '🏎', name: 'STREET KING',      desc: 'Win 10 street races',         need: 10,    key: 'races',   reward: 1000 },
  { id: 'x10',  icon: '🚕', name: 'TAXI VETERAN',     desc: 'Complete 10 taxi fares',      need: 10,    key: 'taxi',    reward: 300 },
  { id: 'f10',  icon: '🎣', name: 'ANGLER',           desc: 'Catch 10 fish',               need: 10,    key: 'fish',    reward: 250 },
  { id: 'home', icon: '🏠', name: 'HOMEOWNER',        desc: 'Buy the apartment',           need: 1,     key: 'home',    reward: 300 },
  { id: 'gold', icon: '🕵️', name: 'THE GOLDEN COURIER', desc: 'Finish the adventure',      need: 1,     key: 'story',   reward: 1000 },
  { id: 'gold2', icon: '🌑', name: 'LEGEND II',          desc: 'Finish ACT II of the story',  need: 1,     key: 'story2',  reward: 1500 },
];
function statVal(key) {
  if (key === 'level') return prog.level;
  if (key === 'cityN') return Object.keys(prog.stats.cities).length;
  return prog.stats[key] || 0;
}
function bumpStat(key, n = 1) {
  prog.stats[key] = (prog.stats[key] || 0) + n;
  checkAchs();
  saveProg();
}
function checkAchs() {
  for (const a of ACHS) {
    if (prog.achs[a.id]) continue;
    if (statVal(a.key) >= a.need) {
      prog.achs[a.id] = true;
      prog.bank += a.reward;
      celebrate(`${a.name} · +$${a.reward}`, '🏅');
      addFeed(`🏅 Career goal complete: ${a.name} (+$${a.reward})`);
      playClick(2600, 0.3);
    }
  }
}
function renderAchs() {
  const done = ACHS.filter(a => prog.achs[a.id]).length;
  document.getElementById('achsum').textContent =
    `${done} / ${ACHS.length} COMPLETE · RANK: ${rankName()} · LIFETIME DELIVERIES: ${statVal('deliv')}`;
  const box = document.getElementById('achitems');
  box.innerHTML = '';
  for (const a of ACHS) {
    const got = !!prog.achs[a.id];
    const cur = Math.min(statVal(a.key), a.need);
    const row = document.createElement('div');
    row.className = 'shopitem' + (got ? ' done' : '');
    row.innerHTML = `<div class="ic">${got ? '✅' : a.icon}</div><div class="info">` +
      `<div class="nm">${a.name}</div><div class="ds">${a.desc}</div>` +
      `<div class="lv">${got ? 'COMPLETE' : `${cur} / ${a.need}`}</div></div>` +
      `<div class="pr">+$${a.reward}</div>`;
    box.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Driver Shop — spend earned cash on permanent upgrades (B)
// ---------------------------------------------------------------------------
const UPGRADES = [
  { id: 'fit',  icon: '🏋', name: 'GYM TRAINING',  desc: '+8% sprint speed per level',   base: 120, max: 5 },
  { id: 'meal', icon: '🍔', name: 'GYM MEAL PLAN', desc: '+10 max health per level',     base: 100, max: 5 },
  { id: 'bag',  icon: '🎒', name: 'BIGGER BAG',    desc: '+1 energy can capacity',         base: 150, max: 3 },
  { id: 'vest', icon: '🦺', name: 'COURIER VEST',  desc: '-6% damage taken per level',   base: 140, max: 5 },
  { id: 'weap', icon: '🔧', name: 'WEAPON TUNING', desc: '+8% weapon damage per level',  base: 160, max: 5 },
  { id: 'engine', icon: '🏎', name: 'ENGINE TUNING', desc: '+5% vehicle top speed per level', base: 250, max: 5 },
  { id: 'rep',  icon: '⭐', name: 'STREET REPUTATION', desc: '+7% delivery pay per level', base: 220, max: 5 },
];
// wardrobe — dress your driver, seen in the menu preview and on the scooter
const OUTFITS = [
  { id: 'street', name: 'STREET KIT',    price: 0,     shirt: null,     pants: null },
  { id: 'sport',  name: 'SPORT SET',     price: 300,   shirt: 0x35a061, pants: 0xf0f2f4 },
  { id: 'desert', name: 'DESERT NOMAD',  price: 500,   shirt: 0xc8a86a, pants: 0x6a4a2a },
  { id: 'biz',    name: 'BUSINESS SUIT', price: 800,   shirt: 0x1c2a48, pants: 0x10141c },
  { id: 'medic',  name: 'NIGHT MEDIC',   price: 1200,  shirt: 0xe8e8ea, pants: 0x1c2a48 },
  { id: 'racer',  name: 'NEON RACER',    price: 1500,  shirt: 0x11c8e8, pants: 0x10141c },
  { id: 'pilot',  name: 'SKY PILOT',     price: 2200,  shirt: 0x2a3a55, pants: 0xe8e8ea },
  { id: 'royal',  name: 'ROYAL GOLD',    price: 3000,  shirt: 0xd8b21e, pants: 0x2a1c08 },
  { id: 'chrome', name: 'CHROME RUNNER', price: 4500,  shirt: 0xb8bcc4, pants: 0x14161a },
  { id: 'dragon', name: 'CRIMSON DRAGON', price: 6500, shirt: 0xc41e1e, pants: 0x14161a },
  { id: 'ghost',  name: 'GOLD PHANTOM',  price: 10000, shirt: 0xd8b21e, pants: 0x101216 },
  { id: 'shadow', name: 'SHADOW SKIN',   price: 0,     shirt: 0x16161c, pants: 0x5e1420, questReward: true },
];
function upgLvl(id) { return prog.upg[id] || 0; }
function upgCost(u) { return u.base * (upgLvl(u.id) + 1); }
function maxHealth() { return 100 + 10 * upgLvl('meal'); }
function energyCap() { return 3 + upgLvl('bag'); }
let shopOpen = false;
function renderShop() {
  document.getElementById('wallet').textContent = `WALLET $${prog.bank}`;
  const box = document.getElementById('shopitems');
  box.innerHTML = '';
  for (const u of UPGRADES) {
    const lvl = upgLvl(u.id), maxed = lvl >= u.max, cost = upgCost(u);
    const row = document.createElement('div');
    row.className = 'shopitem';
    row.innerHTML = `<div class="ic">${u.icon}</div><div class="info">` +
      `<div class="nm">${u.name}</div><div class="ds">${u.desc}</div>` +
      `<div class="lv">LEVEL ${lvl} / ${u.max}</div></div>`;
    const btn = document.createElement('button');
    btn.className = 'buybtn';
    btn.textContent = maxed ? 'MAXED' : `BUY $${cost}`;
    btn.disabled = maxed || prog.bank < cost;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (upgLvl(u.id) >= u.max || prog.bank < upgCost(u)) return;
      prog.bank -= upgCost(u);
      prog.upg[u.id] = upgLvl(u.id) + 1;
      saveProg();
      playClick(2000, 0.25);
      addFeed(`🛒 ${u.name} → level ${upgLvl(u.id)}`);
      renderShop();
    });
    row.appendChild(btn);
    box.appendChild(row);
  }
  renderGarage();
  renderWardrobe();
}
function renderWardrobe() {
  const box = document.getElementById('wardrobeitems');
  box.innerHTML = '';
  for (const o of OUTFITS) {
    if (o.questReward && !prog.wardrobe[o.id]) continue; // story rewards stay hidden until earned
    const owned = !!prog.wardrobe[o.id];
    const worn = prog.outfit === o.id;
    const row = document.createElement('div');
    row.className = 'shopitem' + (owned ? ' done' : '');
    row.innerHTML = `<div class="ic">👔</div><div class="info">` +
      `<div class="nm">${o.name}${worn ? ' · <span style="color:#7dff8a">WEARING</span>' : ''}</div>` +
      `<div class="ds">${o.price ? 'Fresh look for the streets' : 'The classic courier fit'}</div></div>`;
    const btn = document.createElement('button');
    btn.className = 'buybtn';
    btn.textContent = worn ? 'WORN' : owned ? 'WEAR' : `BUY $${o.price}`;
    btn.disabled = worn || (!owned && prog.bank < o.price);
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (!owned) {
        if (prog.bank < o.price) return;
        prog.bank -= o.price;
        prog.wardrobe[o.id] = true;
        addFeed(`👔 New outfit: ${o.name}`);
        celebrate(`NEW OUTFIT: ${o.name}`, '👔');
      }
      prog.outfit = o.id;
      saveProg();
      playClick(2000, 0.25);
      refreshPreview();
      renderShop();
    });
    row.appendChild(btn);
    box.appendChild(row);
  }
}
function toggleShop() {
  if (!started || player.dead || cine.active) return;
  shopOpen = !shopOpen;
  const el = document.getElementById('shop');
  if (shopOpen) {
    renderShop();
    el.style.display = 'flex';
    if (!isTouch) document.exitPointerLock();
  } else {
    el.style.display = 'none';
    if (!isTouch) requestLock();
  }
}
// ---------------------------------------------------------------------------
// Restaurants you can walk into: spend your cash on real food and drinks
// ---------------------------------------------------------------------------
let cafeOpen = false, nearRest = null;
const cafehintEl = document.getElementById('cafehint');
const CAFE_MENU = [
  { ic: '🍕', nm: 'PIZZA',     fx: 'Restores 40 health',            price: 8,  heal: 40 },
  { ic: '🍔', nm: 'BURGER',    fx: 'Restores 30 health',            price: 6,  heal: 30 },
  { ic: '🌯', nm: 'SHAWARMA',  fx: 'Restores 25 health',            price: 5,  heal: 25 },
  { ic: '☕', nm: 'COFFEE',    fx: 'Small speed boost + 5 health',  price: 3,  heal: 5, boost: 5 },
  { ic: '🫖', nm: 'KARAK TEA', fx: 'Restores 12 health',            price: 2,  heal: 12 },
  { ic: '🍰', nm: 'CAKE',      fx: 'Restores 18 health',            price: 4,  heal: 18 },
];
function renderCafe() {
  document.getElementById('cafename').textContent = nearRest ? nearRest.name : 'CAFE';
  document.getElementById('cafewallet').textContent = `WALLET $${Math.floor(game.money + prog.bank)}`;
  const box = document.getElementById('cafeitems');
  box.innerHTML = '';
  for (const item of CAFE_MENU) {
    const row = document.createElement('div');
    row.className = 'cafeitem';
    row.innerHTML = `<div class="ic">${item.ic}</div>
      <div class="info"><div class="nm">${item.nm}</div><div class="fx">${item.fx}</div></div>
      <div class="pr">$${item.price}</div>`;
    row.addEventListener('click', () => buyFood(item));
    box.appendChild(row);
  }
}
function buyFood(item) {
  if (game.money + prog.bank < item.price) {
    addFeed('💸 Not enough cash — deliver more orders!');
    playClick(300, 0.15);
    return;
  }
  // spend wallet first, then savings
  const fromWallet = Math.min(game.money, item.price);
  game.money -= fromWallet;
  prog.bank -= item.price - fromWallet;
  saveProg();
  player.health = Math.min(maxHealth(), player.health + item.heal);
  if (item.boost) energy.boostT = Math.max(energy.boostT, item.boost);
  addFeed(`${item.ic} ${item.nm} at ${nearRest ? nearRest.name : 'the cafe'} — +${item.heal} HP`);
  playClick(1800, 0.25);
  renderCafe();
}
function toggleCafe() {
  if (!started || player.dead || cine.active || driving) return;
  if (!cafeOpen && !nearRest) return;
  cafeOpen = !cafeOpen;
  const el = document.getElementById('cafe');
  if (cafeOpen) {
    renderCafe();
    el.style.display = 'flex';
    cafehintEl.style.display = 'none';
    if (!isTouch) document.exitPointerLock();
  } else {
    el.style.display = 'none';
    if (!isTouch) requestLock();
  }
}
document.getElementById('cafeclose').addEventListener('click', () => { if (cafeOpen) toggleCafe(); });
cafehintEl.addEventListener('click', () => { if (!cafeOpen && nearRest) toggleCafe(); });
cafehintEl.addEventListener('touchstart', e => { e.preventDefault(); if (!cafeOpen && nearRest) toggleCafe(); }, { passive: false });

// ---------------------------------------------------------------------------
// WANTED system — drive recklessly and the police interceptors come for
// you: sirens, stars, chases, fines. Escape by outrunning them.
// ---------------------------------------------------------------------------
const heat = { level: 0, escapeT: 0, bustT: 0, crimeCd: 0 };
const pursuers = [];
let sirenNodes = null;
const starsEl = document.getElementById('stars');
function addHeat(n, why) {
  if (mode !== 'delivery' || player.dead) return;
  if (heat.crimeCd > 0) return;
  heat.crimeCd = 1.5;
  const was = heat.level;
  heat.level = Math.min(3, heat.level + n);
  heat.escapeT = 0;
  if (heat.level > was) {
    showBanner('★'.repeat(heat.level) + ' WANTED');
    addFeed(`🚓 ${why} — police alerted!`);
    if (was === 0) {
      phoneNotify('🚨 POLICE ALERT', 'You are wanted — lose the heat!', player.pos.x, player.pos.z);
      say('Warning. Police alerted.');
    }
    playClick(500, 0.3);
  }
}
function spawnPursuer() {
  const wrap = new THREE.Group();
  if (policeTemplate) {
    const m = SkeletonUtils.clone(policeTemplate);
    wrap.add(m);
    wrap.userData.wheelNodes = collectWheelNodes(m);
  } else {
    wrap.add(buildCarMesh(0xf0f2f4, 'sports'));
  }
  const red = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.09, 0.22),
    new THREE.MeshBasicMaterial({ color: 0xff2222 }));
  red.position.set(-0.22, 1.18, -0.3);
  const blue = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.09, 0.22),
    new THREE.MeshBasicMaterial({ color: 0x2266ff }));
  blue.position.set(0.22, 1.18, -0.3);
  wrap.add(red); wrap.add(blue);
  policeLights.push({ red, blue, phase: Math.random() });
  const sx = STREETS.reduce((a, b) => Math.abs(b - player.pos.x) < Math.abs(a - player.pos.x) ? b : a);
  const sz = STREETS.reduce((a, b) => Math.abs(b - player.pos.z) < Math.abs(a - player.pos.z) ? b : a);
  if (Math.abs(player.pos.x - sx) < Math.abs(player.pos.z - sz))
    wrap.position.set(sx + 3.5, 0,
      Math.max(-126, Math.min(126, player.pos.z + (Math.random() < 0.5 ? -70 : 70))));
  else
    wrap.position.set(
      Math.max(-126, Math.min(126, player.pos.x + (Math.random() < 0.5 ? -70 : 70))), 0, sz + 3.5);
  scene.add(wrap);
  pursuers.push({ group: wrap,
    yaw: Math.atan2(player.pos.x - wrap.position.x, player.pos.z - wrap.position.z),
    speed: 12, red, blue });
}
function clearPursuit(escaped) {
  for (const p of pursuers) {
    scene.remove(p.group);
    const li = policeLights.findIndex(l => l.red === p.red);
    if (li >= 0) policeLights.splice(li, 1);
  }
  pursuers.length = 0;
  heat.level = 0; heat.escapeT = 0; heat.bustT = 0;
  stopSiren();
  if (starsEl) starsEl.style.display = 'none';
  if (escaped) {
    showBanner('YOU LOST THE POLICE');
    addFeed('✅ Escaped — heat cleared');
    bumpStat('escapes');
  }
}
function startSiren() {
  if (sirenNodes || !AC) return;
  const osc = AC.createOscillator();
  const g = AC.createGain();
  g.gain.value = 0;
  osc.type = 'triangle';
  osc.frequency.value = 700;
  osc.connect(g).connect(MASTER);
  osc.start();
  sirenNodes = { osc, g };
}
function stopSiren() {
  if (!sirenNodes) return;
  try { sirenNodes.osc.stop(); } catch {}
  sirenNodes = null;
}
function updateHeat(dt) {
  if (heat.crimeCd > 0) heat.crimeCd -= dt;
  if (heat.level === 0) return;
  if (player.dead || mode !== 'delivery') { clearPursuit(false); return; }
  while (pursuers.length < Math.min(2, heat.level)) spawnPursuer();
  startSiren();
  let nearest = 1e9;
  for (const p of pursuers) {
    const dx = player.pos.x - p.group.position.x;
    const dz = player.pos.z - p.group.position.z;
    const d = Math.hypot(dx, dz);
    nearest = Math.min(nearest, d);
    const targetYaw = Math.atan2(dx, dz);
    let dy = targetYaw - p.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    p.yaw += Math.max(-2.2 * dt, Math.min(2.2 * dt, dy));
    const want = d > 6 ? 44 : 2; // corner hard, then creep in for the arrest
    p.speed += (want - p.speed) * Math.min(1, dt * 1.6);
    p.group.position.x += Math.sin(p.yaw) * p.speed * dt;
    p.group.position.z += Math.cos(p.yaw) * p.speed * dt;
    p.group.rotation.y = p.yaw;
    spinWheels(p.group, p.speed * dt);
    if (resolveCollisions(p.group.position, 1.5, 1.4)) p.speed *= 0.4;
    p.group.position.x = Math.max(-BOUND, Math.min(BOUND, p.group.position.x));
    p.group.position.z = Math.max(-BOUND, Math.min(BOUND, p.group.position.z));
    // wedged against a building: radio ahead and cut the player off instead
    p.stuckT = (p.speed < 6 && d > 15) ? (p.stuckT || 0) + dt : 0;
    if (p.stuckT > 2.5) {
      p.stuckT = 0;
      const sx = STREETS.reduce((a, b) => Math.abs(b - player.pos.x) < Math.abs(a - player.pos.x) ? b : a);
      const sz = STREETS.reduce((a, b) => Math.abs(b - player.pos.z) < Math.abs(a - player.pos.z) ? b : a);
      if (Math.abs(player.pos.x - sx) < Math.abs(player.pos.z - sz))
        p.group.position.set(sx + 3.5, 0,
          Math.max(-126, Math.min(126, player.pos.z + (Math.random() < 0.5 ? -45 : 45))));
      else
        p.group.position.set(
          Math.max(-126, Math.min(126, player.pos.x + (Math.random() < 0.5 ? -45 : 45))), 0, sz + 3.5);
      p.speed = 20;
    }
  }
  if (sirenNodes) {
    sirenNodes.osc.frequency.value = AF(640 + (Math.sin(game.time * 9) > 0 ? 320 : 0)) || 640;
    sirenNodes.g.gain.value = AF(0.12 * Math.max(0.15, 1 - nearest / 120));
  }
  const mySpeed = driving ? Math.abs(driving.speed) : Math.hypot(player.vel.x, player.vel.z);
  if (nearest < 6 && mySpeed < 4) {
    heat.bustT += dt;
    if (heat.bustT > 1.3) {
      const fine = Math.min(150, Math.floor((game.money + prog.bank) * 0.25));
      const fromWallet = Math.min(game.money, fine);
      game.money -= fromWallet;
      prog.bank -= fine - fromWallet;
      saveProg();
      showBanner(`BUSTED — FINED $${fine}`);
      addFeed(`🚓 Busted! Paid a $${fine} fine`);
      playCrash(0.5);
      clearPursuit(false);
      return;
    }
  } else heat.bustT = 0;
  if (nearest > 75) {
    heat.escapeT += dt;
    if (heat.escapeT > 8) { clearPursuit(true); return; }
  } else heat.escapeT = 0;
  if (starsEl) {
    starsEl.textContent = '★'.repeat(heat.level) + '☆'.repeat(3 - heat.level);
    starsEl.style.display = 'block';
  }
}

// ---------------------------------------------------------------------------
// Clip recording — press V (or tap 🎬) to record gameplay off the canvas,
// preview it, then share it straight to WhatsApp/TikTok or download it
// ---------------------------------------------------------------------------
let recorder = null, recChunks = [], recording = false, recTimer = 0;
const REC_MAX = 30; // seconds
function toggleRecord() {
  if (!started || cine.active) return;
  if (!window.MediaRecorder || !canvas.captureStream) {
    addFeed('🎬 Recording not supported in this browser');
    return;
  }
  if (!recording) {
    try {
      const stream = canvas.captureStream(30);
      if (AC && MASTER) { // include the game audio in the clip
        const dest = AC.createMediaStreamDestination();
        MASTER.connect(dest);
        for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
      }
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9' : 'video/webm';
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5e6 });
    } catch {
      addFeed('🎬 Recording not supported in this browser');
      return;
    }
    recChunks = [];
    recorder.ondataavailable = e => { if (e.data.size) recChunks.push(e.data); };
    recorder.onstop = showClipPanel;
    recorder.start(1000);
    recording = true;
    recTimer = 0;
    document.getElementById('recdot').style.display = 'flex';
    addFeed(`🎬 Recording (max ${REC_MAX}s) — ${isTouch ? 'tap 🎬' : 'press V'} to stop`);
  } else {
    recording = false;
    document.getElementById('recdot').style.display = 'none';
    try { recorder.stop(); } catch {}
  }
}
function updateRecording(dt) {
  if (!recording) return;
  recTimer += dt;
  document.getElementById('rectime').textContent = Math.floor(recTimer) + 's';
  if (recTimer >= REC_MAX) toggleRecord();
}
let clipBlob = null;
function showClipPanel() {
  clipBlob = new Blob(recChunks, { type: 'video/webm' });
  recChunks = [];
  const vid = document.getElementById('clipvideo');
  vid.src = URL.createObjectURL(clipBlob);
  document.getElementById('clip').style.display = 'flex';
  if (!isTouch) document.exitPointerLock();
}
function closeClipPanel() {
  document.getElementById('clip').style.display = 'none';
  const vid = document.getElementById('clipvideo');
  vid.pause();
  if (vid.src) { URL.revokeObjectURL(vid.src); vid.removeAttribute('src'); }
  clipBlob = null;
  if (!isTouch && started && !player.dead) requestLock();
}
async function shareClip() {
  if (!clipBlob) return;
  const file = new File([clipBlob], 'streetops-clip.webm', { type: 'video/webm' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'STREET OPS',
        text: `My delivery run in STREET OPS 🛵🔥 Play free: ${location.origin}${location.pathname}` });
      grantShareReward();
      return;
    } catch {}
  }
  downloadClip(); // no share sheet on this device: save the file instead
}
function downloadClip() {
  if (!clipBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(clipBlob);
  a.download = 'streetops-clip.webm';
  a.click();
  addFeed('🎬 Clip saved — post it anywhere!');
}

// ---------------------------------------------------------------------------
// Share & earn — sharing the game pays in-game cash (capped per day)
// ---------------------------------------------------------------------------
function grantShareReward() {
  const today = new Date().toDateString();
  let d;
  try { d = JSON.parse(localStorage.getItem('streetops.shares')) || {}; } catch { d = {}; }
  if (d.day !== today) { d.day = today; d.n = 0; }
  if (d.n >= 3) { addFeed('📣 Thanks for sharing! Daily bonus comes back tomorrow'); return; }
  d.n++;
  localStorage.setItem('streetops.shares', JSON.stringify(d));
  game.money += 100;
  prog.bank += 100;
  bumpStat('shares');
  saveProg();
  showBanner('SHARE BONUS +$100');
  addFeed(`📣 Share bonus +$100 (${d.n}/3 today)`);
  playClick(2200, 0.3);
}
function shareGame() {
  const text = `I'm a level ${prog.level} driver in STREET OPS 🛵 — deliveries, police chases, 7 cities. Play free in your browser: ${location.origin}${location.pathname}`;
  if (navigator.share) {
    navigator.share({ title: 'STREET OPS', text, url: location.origin + location.pathname })
      .then(grantShareReward).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => {
      addFeed('🔗 Invite copied — paste it to a friend!');
      grantShareReward();
    }).catch(() => {});
  }
}
document.getElementById('sharebtn').addEventListener('click', e => { e.stopPropagation(); shareGame(); });
document.getElementById('goshare').addEventListener('click', e => { e.stopPropagation(); shareGame(); });
if (ADS) document.getElementById('goad').style.display = '';
document.getElementById('goad').addEventListener('click', e => {
  e.stopPropagation();
  showRewardedAd(() => {
    prog.bank += 200;
    saveProg();
    showBanner('📺 AD REWARD +$200');
    addFeed('📺 Thanks for watching — +$200 banked');
    document.getElementById('goad').style.display = 'none';
    setTimeout(() => { if (ADS) document.getElementById('goad').style.display = ''; }, 60000);
  });
});
document.getElementById('clipshare').addEventListener('click', shareClip);
document.getElementById('clipsave').addEventListener('click', downloadClip);
document.getElementById('clipclose').addEventListener('click', closeClipPanel);

// ---------------------------------------------------------------------------
// Leaderboard — named top-10 by best shift (local; LB_REMOTE enables sync
// with an online backend when one is configured)
// ---------------------------------------------------------------------------
const LB_REMOTE = ''; // set to a backend endpoint to sync scores online
function loadBoard() {
  try { return JSON.parse(localStorage.getItem('streetops.board')) || []; } catch { return []; }
}
function recordScore() {
  const name = playerName();
  const b = loadBoard();
  let e2 = b.find(r => r.name === name);
  if (!e2) { e2 = { name, city: '', del: 0, cash: 0 }; b.push(e2); }
  e2.del = Math.max(e2.del, game.deliveries);
  e2.cash = Math.max(e2.cash, Math.floor(prog.bank + game.money));
  if (CITY) e2.city = CITY.name;
  localStorage.setItem('streetops.board', JSON.stringify(b));
  if (LB_REMOTE) fetch(LB_REMOTE, { method: 'POST', body: JSON.stringify(e2) }).catch(() => {});
}
function renderBoard() {
  recordScore();
  const box = document.getElementById('boarditems');
  const rows = loadBoard().sort((a, c) => c.del - a.del || c.cash - a.cash).slice(0, 10);
  const me = playerName();
  box.innerHTML = rows.length ? '' : '<div style="color:#8fa2b6">No drivers yet — complete a delivery!</div>';
  rows.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'boardrow' + (r.name === me ? ' me' : '');
    row.innerHTML = `<div class="rk">#${i + 1}</div>
      <div class="nm">${r.name}<div class="ct">${r.city || ''}</div></div>
      <div class="sc">${r.del} 📦</div><div class="sc">$${r.cash}</div>`;
    box.appendChild(row);
  });
}
document.getElementById('lbbtn').addEventListener('click', e => {
  e.stopPropagation();
  renderBoard();
  document.getElementById('board').style.display = 'flex';
});
document.getElementById('boardclose').addEventListener('click', () => {
  document.getElementById('board').style.display = 'none';
});
document.getElementById('board').addEventListener('click', e => e.stopPropagation());
// ---------------------------------------------------------------------------
// Daily spin — one free wheel spin per day for a gift
// ---------------------------------------------------------------------------
const SPIN_PRIZES = [
  { t: '$25',   cash: 25,  c: '#3a7bd5' },
  { t: '$75',   cash: 75,  c: '#2e9e5b' },
  { t: '⚡×2',  cans: 2,   c: '#b8952e' },
  { t: '$150',  cash: 150, c: '#d5702a' },
  { t: '$50',   cash: 50,  c: '#8a4ad5' },
  { t: '$300',  cash: 300, c: '#c94a68' },
  { t: '⚡×3',  cans: 3,   c: '#2ea89e' },
  { t: '$500',  cash: 500, c: '#d8b21e' },
];
const spinCv = document.getElementById('spinwheel');
const spinCtx = spinCv.getContext('2d');
let spinAngle = 0, spinning = false, bonusSpin = false;
function adSpinsToday() {
  try {
    const d = JSON.parse(localStorage.getItem('streetops.spinad')) || {};
    return d.day === new Date().toDateString() ? d.n || 0 : 0;
  } catch (e) { return 0; }
}
function noteAdSpin() {
  try {
    localStorage.setItem('streetops.spinad',
      JSON.stringify({ day: new Date().toDateString(), n: adSpinsToday() + 1 }));
  } catch (e) {}
}
function spinDoneToday() {
  try { return JSON.parse(localStorage.getItem('streetops.spin')).day === new Date().toDateString(); }
  catch { return false; }
}
function drawWheel() {
  const S = spinCv.width, C = S / 2, R = C - 8;
  spinCtx.clearRect(0, 0, S, S);
  const seg = Math.PI * 2 / SPIN_PRIZES.length;
  for (let i = 0; i < SPIN_PRIZES.length; i++) {
    const a0 = spinAngle + i * seg;
    spinCtx.fillStyle = SPIN_PRIZES[i].c;
    spinCtx.beginPath();
    spinCtx.moveTo(C, C);
    spinCtx.arc(C, C, R, a0, a0 + seg);
    spinCtx.closePath();
    spinCtx.fill();
    spinCtx.strokeStyle = 'rgba(0,0,0,.35)';
    spinCtx.lineWidth = 2;
    spinCtx.stroke();
    spinCtx.save();
    spinCtx.translate(C, C);
    spinCtx.rotate(a0 + seg / 2);
    spinCtx.textAlign = 'right';
    spinCtx.font = '800 22px Arial';
    spinCtx.fillStyle = 'rgba(0,0,0,.45)';
    spinCtx.fillText(SPIN_PRIZES[i].t, R - 13, 9.5);
    spinCtx.fillStyle = '#fff';
    spinCtx.fillText(SPIN_PRIZES[i].t, R - 14, 8);
    spinCtx.restore();
  }
  spinCtx.fillStyle = '#10141c';
  spinCtx.beginPath(); spinCtx.arc(C, C, 34, 0, Math.PI * 2); spinCtx.fill();
  spinCtx.strokeStyle = '#ffd479'; spinCtx.lineWidth = 3;
  spinCtx.beginPath(); spinCtx.arc(C, C, 34, 0, Math.PI * 2); spinCtx.stroke();
  spinCtx.font = '26px Arial'; spinCtx.textAlign = 'center';
  spinCtx.fillStyle = '#ffd479';
  spinCtx.fillText('🎡', C, C + 9);
  // pointer at the top
  spinCtx.fillStyle = '#ffffff';
  spinCtx.beginPath();
  spinCtx.moveTo(C - 12, 2);
  spinCtx.lineTo(C + 12, 2);
  spinCtx.lineTo(C, 26);
  spinCtx.closePath();
  spinCtx.fill();
}
function refreshSpinBtn() {
  const btn = document.getElementById('spingo');
  const done = spinDoneToday();
  btn.textContent = done ? '✅ COME BACK TOMORROW' : 'SPIN!';
  btn.classList.toggle('done', done);
  // portal build: trade an ad view for up to 2 extra spins a day
  document.getElementById('spinad').style.display =
    ADS && done && adSpinsToday() < 2 ? '' : 'none';
}
function runSpin() {
  if (spinning || (spinDoneToday() && !bonusSpin)) return;
  bonusSpin = false;
  spinning = true;
  const target = Math.floor(Math.random() * SPIN_PRIZES.length);
  const seg = Math.PI * 2 / SPIN_PRIZES.length;
  // the pointer sits at -90°; land the middle of the target segment under it
  const final = Math.PI * 2 * (5 + Math.random() * 2)
    - (target * seg + seg / 2) - Math.PI / 2;
  const start = spinAngle % (Math.PI * 2);
  const t0 = performance.now(), DUR = 3400;
  playClick(900, 0.15);
  (function anim() {
    const k = Math.min(1, (performance.now() - t0) / DUR);
    const ease = 1 - Math.pow(1 - k, 3);
    spinAngle = start + (final - start) * ease;
    drawWheel();
    if (k < 1) requestAnimationFrame(anim);
    else {
      spinning = false;
      localStorage.setItem('streetops.spin', JSON.stringify({ day: new Date().toDateString() }));
      const p = SPIN_PRIZES[target];
      if (p.cash) { prog.bank += p.cash; saveProg(); }
      if (p.cans) energy.cans = Math.min(energyCap(), energy.cans + p.cans);
      document.getElementById('spinsum').textContent =
        p.cash ? `🎉 YOU WON $${p.cash} — ADDED TO YOUR WALLET!` : `🎉 YOU WON ${p.cans} ${EN_BRAND_U}S!`;
      celebrate(p.cash ? `YOU WON $${p.cash}!` : `${p.cans} ENERGY DRINKS!`, '🎡');
      refreshSpinBtn();
    }
  })();
}
// phone quality toggle: light (guaranteed to load) vs full 3D models
{
  const hqBtn = document.getElementById('hqbtn');
  if (IS_IOS || LOWMEM) {
    hqBtn.style.display = '';
    hqBtn.textContent = HQ_ON ? '✨ QUALITY: HIGH (tap for LIGHT)' : '✨ QUALITY: LIGHT (tap for HIGH)';
    hqBtn.addEventListener('click', e => {
      e.stopPropagation();
      try { localStorage.setItem('streetops.hq', HQ_ON ? '0' : '1'); } catch (err) {}
      location.reload();
    });
  }
}
document.getElementById('spinbtn').addEventListener('click', e => {
  e.stopPropagation();
  document.getElementById('spinsum').textContent = 'ONE FREE SPIN EVERY DAY — WIN UP TO $500';
  drawWheel();
  refreshSpinBtn();
  document.getElementById('spin').style.display = 'flex';
});
document.getElementById('spingo').addEventListener('click', e => { e.stopPropagation(); runSpin(); });
document.getElementById('spinad').addEventListener('click', e => {
  e.stopPropagation();
  if (spinning || adSpinsToday() >= 2) return;
  showRewardedAd(() => {
    noteAdSpin();
    bonusSpin = true;
    document.getElementById('spinsum').textContent = '📺 BONUS SPIN UNLOCKED — SPIN AGAIN!';
    refreshSpinBtn();
    runSpin();
  });
});
document.getElementById('spinclose').addEventListener('click', () => {
  if (!spinning) document.getElementById('spin').style.display = 'none';
});
document.getElementById('spin').addEventListener('click', e => e.stopPropagation());

document.getElementById('achbtn').addEventListener('click', e => {
  e.stopPropagation();
  renderAchs();
  document.getElementById('achs').style.display = 'flex';
});
document.getElementById('achclose').addEventListener('click', () => {
  document.getElementById('achs').style.display = 'none';
});
document.getElementById('achs').addEventListener('click', e => e.stopPropagation());

// ---------------------------------------------------------------------------
// First-shift tutorial — walks a brand-new driver through their first
// delivery in about 30 seconds, then gets out of the way forever
// ---------------------------------------------------------------------------
const tut = { step: localStorage.getItem('streetops.tut') ? 4 : 0, t: 0 };
const tutbarEl = document.getElementById('tutbar');
const TUT_STEPS = [
  () => `Welcome, <b>${playerName()}</b>! ${isTouch
    ? 'Walk with the <b>left joystick</b>, drag the right side of the screen to look around'
    : 'Move with <b>W A S D</b>, look around with the <b>mouse</b>'}`,
  () => 'Follow the <b>yellow order marker</b> — pick up the order at the restaurant',
  () => 'Got it! Now <b>deliver the order</b> to the waiting customer — follow the marker',
  () => `🎉 <b>FIRST DELIVERY COMPLETE!</b> +$40 bonus · ${isTouch
    ? 'Tap 🚗 near a vehicle to drive · ⚡ energy cans · 🛒 upgrades'
    : '<b>E</b> drive · <b>Q</b> energy can · <b>F</b> eat · <b>B</b> shop'}`,
];
function updateTutorial(dt) {
  if (tut.step >= 4) return;
  if (mode !== 'delivery' || !started || cine.active || player.dead) {
    tutbarEl.style.display = 'none';
    return;
  }
  if (tut.step === 0 && Math.hypot(player.pos.x - 4, player.pos.z - 26) > 4) tut.step = 1;
  else if (tut.step === 1 && order.active && order.stage === 'dropoff') tut.step = 2;
  else if (tut.step === 2 && game.deliveries > 0) {
    tut.step = 3;
    tut.t = 9;
    game.money += 40; prog.bank += 40; saveProg();
    showBanner('TUTORIAL COMPLETE +$40');
  } else if (tut.step === 3) {
    tut.t -= dt;
    if (tut.t <= 0) {
      tut.step = 4;
      localStorage.setItem('streetops.tut', '1');
      tutbarEl.style.display = 'none';
      return;
    }
  }
  tutbarEl.style.display = 'block';
  tutbarEl.querySelector('.step').textContent = `FIRST SHIFT · STEP ${Math.min(tut.step + 1, 4)} / 4`;
  tutbarEl.querySelector('.txt').innerHTML = TUT_STEPS[Math.min(tut.step, 3)]();
}

function xpNeed(l) { return 40 + l * 12; }
function saveProg() { localStorage.setItem('streetops.prog', JSON.stringify(prog)); }
function addXP(n) {
  if (prog.level >= 100) { saveProg(); return; }
  prog.xp += Math.round(n);
  while (prog.level < 100 && prog.xp >= xpNeed(prog.level)) {
    prog.xp -= xpNeed(prog.level);
    prog.level++;
    celebrate((prog.level - 1) % 10 === 0 ? `NEW RANK: ${rankName()}` : `LEVEL ${prog.level}!`, '⭐');
    addFeed(`⭐ Level up — ${prog.level} / 100 · ${rankName()}`);
    checkAchs();
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
const VEH_UNLOCK = { sports: 8, phantom: 10, hyper: 12, police: 14,
  hero_concept: 12, hero_lambo: 12 };
const UNLOCK_LADDER = [
  { level: 3, what: 'P9 SIDEARM' },
  { level: 6, what: 'VIPER SMG' },
  { level: 8, what: 'ROSSO GT' },
  { level: 10, what: 'PHANTOM LIMO' },
  { level: 12, what: 'TORO HYPER' },
  { level: 14, what: 'POLICE INTERCEPTOR' },
];
function nextUnlock() {
  return UNLOCK_LADDER.find(u => u.level > prog.level);
}

const MISSION_DEFS = [
  { id: 'del5', txt: 'Complete 5 deliveries', n: 5, ev: 'delivery', reward: 60 },
  { id: 'earn150', txt: 'Earn $150 in fares', n: 150, ev: 'cash', reward: 50 },
  { id: 'rob6', txt: 'Stop 6 robbers', n: 6, ev: 'kill', reward: 55 },
  { id: 'dist2k', txt: 'Travel 2,000 m', n: 2000, ev: 'dist', reward: 40 },
  { id: 'boost3', txt: 'Drink 3 ' + EN_BRAND + 's', n: 3, ev: 'drink', reward: 35 },
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
  const bossWave = game.wave % 5 === 0;
  if (bossWave) {
    const p = streetPointNear(player.pos, 25, 60);
    spawnEnemy(p.x, p.z, true);
  }
  showBanner(bossWave ? `⚠ WAVE ${game.wave} — GANG BOSS!` : `Wave ${game.wave}`);
  addFeed(`Wave ${game.wave} — ${count} hostiles inbound${bossWave ? ' + a GANG BOSS' : ''}`);
}

// ---------------------------------------------------------------------------
// Street racing — drive through the 🏁 arch to start a checkpoint sprint
// around the whole city; beat the par time for a bigger payout
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Petrol stations — park under the canopy to refuel ($1 per 10 fuel)
// ---------------------------------------------------------------------------
const FUEL_STATIONS = [];
function buildFuelStations() {
  FUEL_STATIONS.length = 0;
  const mPost = new THREE.MeshStandardMaterial({ color: 0xd8dade, roughness: 0.4, metalness: 0.5 });
  const mRoofF = new THREE.MeshStandardMaterial({ color: 0xe84a2a, roughness: 0.5 });
  const mPad = new THREE.MeshStandardMaterial({ color: 0x4a4e55, roughness: 0.95 });
  const mPump = new THREE.MeshStandardMaterial({ color: 0xc42a20, roughness: 0.5 });
  const mPumpTop = new THREE.MeshStandardMaterial({ color: 0xf0f2f4, roughness: 0.4,
    emissive: 0xf0f2f4, emissiveIntensity: 0.25 });
  for (const [x, z, ry] of [[90, -70.5, 0], [-90, 70.5, Math.PI]]) {
    const g = new THREE.Group();
    const pad = new THREE.Mesh(new THREE.BoxGeometry(12, 0.14, 8), mPad);
    pad.position.y = 0.07;
    g.add(pad);
    for (const [dx, dz] of [[-5, -3], [5, -3], [-5, 3], [5, 3]]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 4.4, 8), mPost);
      post.position.set(dx, 2.2, dz);
      g.add(post);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(12.6, 0.5, 8.6), mRoofF);
    roof.position.y = 4.6;
    roof.castShadow = true;
    g.add(roof);
    for (const dx of [-2.2, 2.2]) {
      const pump = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.3, 0.55), mPump);
      pump.position.set(dx, 0.75, 0);
      pump.castShadow = true;
      g.add(pump);
      const top = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.32, 0.57), mPumpTop);
      top.position.set(dx, 1.5, 0);
      g.add(top);
    }
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    scene.add(g);
    marquee('VOLT FUEL', '#ff8a2a', x, z + (ry === 0 ? -4.4 : 4.4), ry, 7, 5.6);
    FUEL_STATIONS.push({ x, z });
  }
}

// ---------------------------------------------------------------------------
// City activities — taxi fares, car wash, apartment, fishing, airport
// ---------------------------------------------------------------------------
const WASH_STATIONS = [];
function buildCarWash() {
  WASH_STATIONS.length = 0;
  const mPostW = new THREE.MeshStandardMaterial({ color: 0xd8dade, roughness: 0.4, metalness: 0.5 });
  const mRoofW = new THREE.MeshStandardMaterial({ color: 0x2a7ae8, roughness: 0.5 });
  const mPadW = new THREE.MeshStandardMaterial({ color: 0x4a5560, roughness: 0.9 });
  const mBrush = new THREE.MeshStandardMaterial({ color: 0x41c9ff, roughness: 0.85 });
  const [x, z] = [-90, -70.5];
  const g = new THREE.Group();
  const pad = new THREE.Mesh(new THREE.BoxGeometry(11, 0.14, 8), mPadW);
  pad.position.y = 0.07;
  g.add(pad);
  for (const [dx, dz] of [[-4.5, -3], [4.5, -3], [-4.5, 3], [4.5, 3]]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 4.2, 8), mPostW);
    post.position.set(dx, 2.1, dz);
    g.add(post);
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(11.6, 0.5, 8.6), mRoofW);
  roof.position.y = 4.4;
  roof.castShadow = true;
  g.add(roof);
  for (const dx of [-2.6, 2.6]) {
    const brush = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 3.2, 10), mBrush);
    brush.position.set(dx, 1.9, 0);
    g.add(brush);
  }
  g.position.set(x, 0, z);
  scene.add(g);
  marquee('SPARKLE WASH', '#41c9ff', x, z - 4.4, 0, 7, 5.4);
  WASH_STATIONS.push({ x, z });
}

// --- delivery drone: send the package by air over the traffic (45% fee) ---
const drone = { active: false, obj: null, rotors: [], tx: 0, tz: 0 };
function buildDroneMesh() {
  const g = new THREE.Group();
  const mBody = new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.4, metalness: 0.6 });
  const mArm = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.5, metalness: 0.5 });
  const mRotor = new THREE.MeshStandardMaterial({ color: 0x9fb2c4, roughness: 0.3,
    transparent: true, opacity: 0.55 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.2, 0.55), mBody);
  g.add(body);
  drone.rotors = [];
  for (const [dx, dz] of [[-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45]]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.08), mArm);
    arm.position.set(dx * 0.55, 0.05, dz * 0.55);
    arm.rotation.y = Math.atan2(dz, dx);
    g.add(arm);
    const rotor = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.02, 0.07), mRotor);
    rotor.position.set(dx, 0.14, dz);
    g.add(rotor);
    drone.rotors.push(rotor);
  }
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.28, 0.4),
    new THREE.MeshStandardMaterial({ color: 0xd8352a, roughness: 0.7 }));
  box.position.y = -0.3;
  g.add(box);
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6),
    new THREE.MeshBasicMaterial({ color: 0x35e06a }));
  led.position.y = 0.14;
  g.add(led);
  return g;
}
function launchDrone() {
  if (drone.active) return;
  if (!(order.active && order.stage === 'dropoff')) {
    addFeed('🚁 The drone can only carry a picked-up order');
    playClick(320, 0.15);
    return;
  }
  drone.active = true;
  drone.tx = order.tx; drone.tz = order.tz;
  order.reward = Math.round(order.reward * 0.55); // the drone takes its cut
  order.droneDone = false;
  drone.obj = buildDroneMesh();
  drone.obj.position.set(player.pos.x, 2.2, player.pos.z);
  scene.add(drone.obj);
  showBanner('🚁 DRONE LAUNCHED — flying over the traffic (45% fee)');
  say('Drone launched. Package en route.');
  addFeed('🚁 Drone took the package — it skips every traffic jam');
  playClick(1500, 0.2);
}
function updateDrone(dt) {
  if (!drone.active || !drone.obj) return;
  for (const r of drone.rotors) r.rotation.y += dt * 40;
  const p = drone.obj.position;
  const dx = drone.tx - p.x, dz = drone.tz - p.z;
  const d = Math.hypot(dx, dz);
  const cruise = d > 14 ? 26 : 3.5; // climb high mid-route, descend at the end
  p.y += (cruise - p.y) * Math.min(1, dt * 1.2);
  const sp = 24 * dt;
  if (d > 1) { p.x += (dx / d) * Math.min(sp, d); p.z += (dz / d) * Math.min(sp, d); }
  drone.obj.rotation.y = Math.atan2(dx, dz);
  drone.obj.rotation.x = d > 8 ? 0.18 : 0;
  if (d < 2.5 && p.y < 5) {
    order.droneDone = true; // updateDelivery completes and pays the reduced fare
    scene.remove(drone.obj);
    drone.obj = null;
    drone.active = false;
  }
}

// --- taxi side-hustle: pick up waving passengers while driving ---
const taxi = { state: 'idle', cd: 18, ped: null, hand: null, px: 0, pz: 0,
  tx: 0, tz: 0, reward: 0, offCarT: 0 };
function emojiSprite(emoji, scale) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const c = cv.getContext('2d');
  c.font = '96px serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(emoji, 64, 70);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false }));
  sp.scale.setScalar(scale);
  return sp;
}
function updateTaxi(dt) {
  if (mode !== 'delivery' || !started || player.dead) return;
  if (taxi.state === 'idle') {
    taxi.cd -= dt;
    if (taxi.cd <= 0) {
      const p = streetPointNear(player.pos, 45, 110);
      taxi.px = p.x; taxi.pz = p.z;
      taxi.ped = makeCharacter(randomLook());
      taxi.ped.group.position.set(p.x, 0, p.z);
      taxi.ped.arms[1].rotation.x = -2.9; // hailing arm up
      scene.add(taxi.ped.group);
      taxi.hand = emojiSprite('🙋', 1.6);
      taxi.hand.position.set(p.x, 2.6, p.z);
      scene.add(taxi.hand);
      taxi.state = 'wait';
      addFeed('🚕 Someone is hailing a ride — pick them up for cash');
    }
    return;
  }
  if (taxi.state === 'wait') {
    taxi.hand.position.y = 2.6 + Math.sin(game.time * 3) * 0.2;
    taxi.ped.group.rotation.y = Math.atan2(player.pos.x - taxi.px, player.pos.z - taxi.pz);
    if (driving && Math.abs(driving.speed) < 2.5 &&
        Math.hypot(player.pos.x - taxi.px, player.pos.z - taxi.pz) < 6.5) {
      scene.remove(taxi.ped.group);
      scene.remove(taxi.hand);
      taxi.ped = null; taxi.hand = null;
      const d = streetPointNear(player.pos, 60, 150);
      taxi.tx = d.x; taxi.tz = d.z;
      taxi.reward = Math.round(14 + Math.hypot(d.x - player.pos.x, d.z - player.pos.z) * 0.14);
      taxi.state = 'ride';
      taxi.offCarT = 0;
      taxi.mark = emojiSprite('📍', 3.2);
      taxi.mark.position.set(d.x, 3.4, d.z);
      scene.add(taxi.mark);
      showBanner('🚕 PASSENGER ON BOARD');
      say('Passenger picked up. Follow the purple marker.');
      phoneNotify('🚕 TAXI FARE', `Drop-off pays $${taxi.reward}`, d.x, d.z);
    }
    return;
  }
  // riding
  if (!driving) {
    taxi.offCarT += dt;
    if (taxi.offCarT > 18) {
      taxi.state = 'idle'; taxi.cd = 25;
      if (taxi.mark) { scene.remove(taxi.mark); taxi.mark = null; }
      showBanner('🚕 Passenger left — fare lost');
      return;
    }
  } else taxi.offCarT = 0;
  if (taxi.mark) taxi.mark.position.y = 3.4 + Math.sin(game.time * 2.5) * 0.35;
  if (Math.hypot(player.pos.x - taxi.tx, player.pos.z - taxi.tz) < 8) {
    game.money += taxi.reward;
    prog.bank += taxi.reward;
    bumpStat('taxi');
    addXP(12);
    showBanner(`🚕 FARE COMPLETE +$${taxi.reward}`);
    addFeed(`🚕 Passenger delivered — +$${taxi.reward}`);
    playClick(2200, 0.25);
    if (taxi.mark) { scene.remove(taxi.mark); taxi.mark = null; }
    taxi.state = 'idle';
    taxi.cd = 22;
  }
}

// --- fishing on the corniche ---
const fish = { on: false, state: 'cast', t: 0, x: 0, z: 0 };
const FISH_TABLE = [
  { n: 'sardine', v: 3, p: 0.45 }, { n: 'seabream', v: 8, p: 0.3 },
  { n: 'hamour', v: 15, p: 0.19 }, { n: 'GOLDEN FISH', v: 40, p: 0.06 },
];
function fishAction() {
  if (!fish.on) {
    fish.on = true;
    fish.state = 'cast';
    fish.t = 2 + Math.random() * 4;
    fish.x = player.pos.x; fish.z = player.pos.z;
    showBanner('🎣 Line cast — wait for the bite…');
    return;
  }
  if (fish.state === 'bite') {
    const r = Math.random();
    let acc = 0, caught = FISH_TABLE[0];
    for (const f of FISH_TABLE) { acc += f.p; if (r <= acc) { caught = f; break; } }
    game.money += caught.v;
    prog.bank += caught.v;
    bumpStat('fish');
    showBanner(`🐟 Caught a ${caught.n} +$${caught.v}!`);
    playClick(2400, 0.25);
    fish.state = 'cast';
    fish.t = 2 + Math.random() * 4;
  }
}
function updateFishing(dt) {
  if (!fish.on) return;
  if (Math.hypot(player.pos.x - fish.x, player.pos.z - fish.z) > 5 || driving) {
    fish.on = false;
    return;
  }
  fish.t -= dt;
  if (fish.state === 'cast' && fish.t <= 0) {
    fish.state = 'bite';
    fish.t = 1.4;
    showBanner('❗ BITE — press F NOW!');
    playClick(1800, 0.3);
  } else if (fish.state === 'bite' && fish.t <= 0) {
    fish.state = 'cast';
    fish.t = 2.5 + Math.random() * 4;
    showBanner('💧 It got away… line cast again');
  }
}

// ---------------------------------------------------------------------------
// THE GOLDEN COURIER — a five-chapter adventure. A hooded stranger, a
// mystery package, a rival race, hidden golden boxes, a legendary reward.
// ---------------------------------------------------------------------------
const STRANGER_POS = { x: -18, z: 84 };   // park edge, every city
const MYSTERY_DROP = { x: -30, z: 90 };   // the park fountain
const GOLD_SPOTS = [[120, 15], [-120, 45], [30, 117], [-30, -117], [90, -87]];
const quest = { boxes: [], got: 0, mark: null, npc: null, talking: 0 };
prog.quest = prog.quest || 0; // 0..5 = chapters, 6 = legend complete
function questText() {
  switch (prog.quest) {
    case 0: return '📜 A hooded stranger waits near the park…';
    case 1: return '📜 CH.1 — Deliver the mystery package to the fountain';
    case 2: return '📜 CH.2 — The DJ at the club wants 2 energy cans';
    case 3: return '📜 CH.3 — Beat the rival: WIN a street race';
    case 4: return `📜 CH.4 — Find the 5 GOLDEN BOXES (${quest.got}/5)`;
    case 5: return '📜 CH.5 — Return to the stranger at the park';
    case 6: return '📜 ACT II — The stranger has returned… visit the park';
    case 7: return `📜 ACT II — Draw out the SHADOW COURIER: win 2 races (${Math.max(0, (prog.stats.races || 0) - (prog.q7base || 0))}/2)`;
    case 8: return `📜 ACT II — Prove your hands: 5 deliveries with NO crash (${prog.q8clean || 0}/5)`;
    case 9: return '📜 ACT II — Return to the stranger for the truth';
    default: return null;
  }
}
function questSay(lines) {
  // deliver story dialogue as a timed banner sequence + voice
  quest.talking = 1;
  lines.forEach((l, i) => setTimeout(() => { showBanner(l); if (i === 0) say(l.replace(/[“”"]/g, '')); }, i * 2600));
  setTimeout(() => { quest.talking = 0; }, lines.length * 2600);
}
function questAdvance(ch) {
  prog.quest = ch;
  saveProg();
  refreshQuestbar();
}
function refreshQuestbar() {
  const el = document.getElementById('questbar');
  const t = questText();
  if (t) { el.textContent = t; el.style.display = 'block'; }
  else el.style.display = 'none';
}
function spawnGoldBoxes() {
  for (const b of quest.boxes) scene.remove(b.mesh);
  quest.boxes.length = 0;
  quest.got = 0;
  const mGold = new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.2,
    metalness: 0.7, emissive: 0xa87b10, emissiveIntensity: 0.5 });
  for (const [x, z] of GOLD_SPOTS) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.16, 0.6), mGold);
    mesh.position.set(x, 1.1, z);
    const halo = emojiSprite('✨', 1.6);
    halo.position.y = 0.9;
    mesh.add(halo);
    scene.add(mesh);
    quest.boxes.push({ mesh, x, z, got: false });
  }
  addFeed('✨ Five golden boxes are hidden around the city — check the gold dots');
}
function updateQuest(dt) {
  if (!started || player.dead) return;
  // stranger exclamation bob
  if (quest.npc && quest.mark) {
    quest.mark.position.y = 2.7 + Math.sin(game.time * 2.5) * 0.2;
    quest.npc.group.rotation.y = Math.atan2(player.pos.x - STRANGER_POS.x, player.pos.z - STRANGER_POS.z);
  }
  if (prog.quest === 1 &&
      Math.hypot(player.pos.x - MYSTERY_DROP.x, player.pos.z - MYSTERY_DROP.z) < 6) {
    questSay(['📦 Package delivered to the fountain…',
      '📱 Unknown: “Good. The DJ at the CLUB has your next clue.”']);
    playCheer();
    game.money += 100; prog.bank += 100;
    addFeed('📜 Chapter 1 complete — +$100');
    questAdvance(2);
  }
  if (prog.quest === 4) {
    for (const b of quest.boxes) {
      if (b.got) continue;
      if (Math.hypot(player.pos.x - b.x, player.pos.z - b.z) < 3.5) {
        b.got = true;
        quest.got++;
        scene.remove(b.mesh);
        playClick(2500, 0.3);
        game.money += 50; prog.bank += 50;
        showBanner(`✨ GOLDEN BOX ${quest.got} / 5 (+$50)`);
        refreshQuestbar();
        if (quest.got >= 5) {
          questSay(['📱 Unknown: “All five. You are the one.”',
            '📜 Return to the stranger at the park…']);
          questAdvance(5);
        }
      }
    }
  }
}
function strangerInteract() {
  if (quest.talking) return;
  if (prog.quest === 0) {
    questSay(['🕵️ Stranger: “You. Courier. I have watched you ride…”',
      '🕵️ “Take this package to the FOUNTAIN. Ask nothing.”',
      '📜 THE GOLDEN COURIER — Chapter 1 begins']);
    questAdvance(1);
  } else if (prog.quest === 5) {
    questSay(['🕵️ Stranger: “The city is yours now, GOLDEN COURIER.”',
      '🏆 +$1,500 · GOLDEN HELMET UNLOCKED',
      '⭐ Adventure complete — you are a LEGEND']);
    game.money += 1500; prog.bank += 1500;
    prog.goldRider = true;
    prog.stats.story = 1;
    checkAchs();
    saveProg();
    playCheer();
    questAdvance(6);
    if (quest.npc) { scene.remove(quest.npc.group); quest.npc = null; }
    if (quest.mark) { scene.remove(quest.mark); quest.mark = null; }
  } else if (prog.quest === 6) {
    questSay(['🕵️ Stranger: “The SHADOW COURIER stole my last box…”',
      '🕵️ “He only races the best. WIN TWO RACES to draw him out.”',
      '📜 ACT II — THE SHADOW COURIER begins']);
    prog.q7base = prog.stats.races || 0;
    questAdvance(7);
  } else if (prog.quest === 9) {
    questSay(['🕵️ Stranger: “You beat his time. You never dropped a box.”',
      '🕵️ “The truth: there is no Shadow Courier. It was always YOU.”',
      '🏆 +$2,500 · SHADOW SKIN UNLOCKED · LEGEND II']);
    game.money += 2500; prog.bank += 2500;
    prog.wardrobe.shadow = true;
    prog.stats.story2 = 1;
    checkAchs();
    saveProg();
    playCheer();
    questAdvance(10);
    if (quest.npc) { scene.remove(quest.npc.group); quest.npc = null; }
    if (quest.mark) { scene.remove(quest.mark); quest.mark = null; }
  } else {
    questSay(['🕵️ Stranger: “Not yet. Finish what you started…”']);
  }
}
function djInteract() {
  if (quest.talking || prog.quest !== 2) return;
  if (energy.cans >= 2) {
    energy.cans -= 2;
    questSay(['🎧 DJ: “Ha! My fuel. Here is your clue…”',
      '🎧 “The rival courier races at the ARCH. BEAT HIM.”',
      '📜 Chapter 3 — win a street race']);
    questAdvance(3);
  } else {
    questSay(['🎧 DJ: “Bring me 2 ' + EN_BRAND_U + 'S and we talk.”',
      '⚡ Grab cans on the street or buy at a café']);
  }
}
function setupQuest() {
  if (prog.quest >= 10 || (prog.quest >= 6 && !prog.goldRider)) { refreshQuestbar(); return; }
  // the hooded stranger waits at the park in every city
  quest.npc = makeCharacter({ gender: 'm', skin: 0x8a6248, shirtHue: 0.6, pantsHue: 0.6,
    hairColor: 0x1c1712, robe: 0x1a1a24 });
  quest.npc.group.position.set(STRANGER_POS.x, 0, STRANGER_POS.z);
  scene.add(quest.npc.group);
  quest.mark = emojiSprite('❗', 1.7);
  quest.mark.position.set(STRANGER_POS.x, 2.7, STRANGER_POS.z);
  scene.add(quest.mark);
  INTERACT_SPOTS.push({
    x: STRANGER_POS.x, z: STRANGER_POS.z, r: 5,
    label: () => prog.quest === 0 ? '🕵️ TALK TO THE STRANGER (F)'
      : prog.quest === 5 ? '🕵️ CLAIM YOUR REWARD (F)' : '🕵️ STRANGER (F)',
    cb: strangerInteract,
  });
  INTERACT_SPOTS.push({
    x: -9.9, z: -41.5, r: 6,
    label: () => prog.quest === 2 ? '🎧 TALK TO THE DJ (F)' : null,
    cb: djInteract,
  });
  if (prog.quest === 4) spawnGoldBoxes();
  refreshQuestbar();
}

// --- generic walk-up interactions (F key or tap the hint) ---
const INTERACT_SPOTS = [];
const acthintEl = document.getElementById('acthint');
let actSpot = null;
function setupCityActivities() {
  INTERACT_SPOTS.length = 0;
  // estate office — buy the apartment
  marquee('HOME ESTATE', '#ffd479', 49.1, -30, Math.PI / 2, 4.5, 3.6);
  INTERACT_SPOTS.push({
    x: 49.1, z: -30, r: 5.5,
    label: () => prog.apartment ? null : '🏠 BUY THIS APARTMENT — $2,500 (F)',
    cb: () => {
      if (prog.apartment) return;
      if (game.money + prog.bank < 2500) { showBanner('🏠 Need $2,500 for the apartment'); return; }
      const fromMoney = Math.min(2500, game.money);
      game.money -= fromMoney;
      prog.bank -= 2500 - fromMoney;
      prog.apartment = true;
      prog.stats.home = 1;
      checkAchs();
      saveProg();
      showBanner('🏠 APARTMENT YOURS — $50 rent every day!');
      addFeed('🏠 You bought an apartment — rent pays $50 daily');
      playCheer();
    },
  });
  // fishing on the corniche in sea cities
  if (THEME.waterfront === 'east') {
    marquee('FISHING PIER', '#41d8ff', 133.5, 40, -Math.PI / 2, 4.5, 3.2);
    INTERACT_SPOTS.push({
      x: 134.5, z: 40, r: 5,
      label: () => fish.on ? (fish.state === 'bite' ? '❗ PRESS F — REEL IN!' : '🎣 waiting for a bite…')
        : '🎣 FISH HERE (F)',
      cb: fishAction,
    });
  }
  // airport — fly between the seven cities mid-game
  marquee('CITY AIRPORT ✈', '#f2f2f2', 14, -123.5, 0, 8, 4.6);
  INTERACT_SPOTS.push({
    x: 14, z: -121, r: 6.5,
    label: () => '✈️ FLY TO ANOTHER CITY — $100 (F)',
    cb: openTravel,
  });
  // daily rent lands when the shift starts
  if (prog.apartment) {
    const today = new Date().toDateString();
    if (prog.lastRent !== today) {
      prog.lastRent = today;
      prog.bank += 50;
      saveProg();
      setTimeout(() => { showBanner('🏠 RENT COLLECTED +$50'); addFeed('🏠 Your tenant paid $50 rent'); }, 12000);
    }
  }
  setupQuest();
}
function updateInteractions() {
  let best = null, bd = 1e9;
  for (const s of INTERACT_SPOTS) {
    const d = Math.hypot(player.pos.x - s.x, player.pos.z - s.z);
    if (d < s.r && d < bd) { bd = d; best = s; }
  }
  actSpot = best;
  const label = best && !driving ? best.label() : null;
  if (label) {
    acthintEl.textContent = label;
    acthintEl.style.display = 'block';
  } else acthintEl.style.display = 'none';
}
acthintEl.addEventListener('click', () => { if (actSpot) actSpot.cb(); });
function openTravel() {
  if (game.money + prog.bank < 100) { showBanner('✈️ A ticket costs $100'); return; }
  const box = document.getElementById('travelbtns');
  box.innerHTML = '';
  for (const c of CITIES) {
    if (CITY && c.id === CITY.id) continue;
    const b = document.createElement('div');
    b.className = 'modebtn';
    b.textContent = `${c.name}`;
    b.addEventListener('click', e => {
      e.stopPropagation();
      const fromMoney = Math.min(100, game.money);
      game.money -= fromMoney;
      prog.bank -= 100 - fromMoney;
      prog.bank += Math.floor(game.money); // bank the shift cash before takeoff
      saveProg();
      localStorage.setItem('streetops.city', c.id);
      location.reload();
    });
    box.appendChild(b);
  }
  document.getElementById('travel').style.display = 'flex';
  if (!isTouch) document.exitPointerLock();
}
document.getElementById('travelclose').addEventListener('click', () => {
  document.getElementById('travel').style.display = 'none';
  if (!isTouch) requestLock();
});
document.getElementById('travel').addEventListener('click', e => e.stopPropagation());

const race = { active: false, cp: 0, t: 0, cooldown: 0 };
const RACE_START = { x: 60, z: 30 };
const RACE_CPS = [
  [60, 100], [0, 120], [-60, 60], [-120, 0], [-60, -90], [0, -120], [90, -60], [60, 30],
];
const RACE_PAR = 60;
let raceRing = null, raceHudEl = null;
function buildRaceCourse() {
  const mPost = new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.4, metalness: 0.3 });
  for (const dx of [-7, 7]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 6, 8), mPost);
    post.position.set(RACE_START.x + dx, 3, RACE_START.z);
    post.castShadow = true;
    scene.add(post);
  }
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 96;
  const g = cv.getContext('2d');
  g.fillStyle = '#101216'; g.fillRect(0, 0, 512, 96);
  // checkered border
  for (let i = 0; i < 16; i++) {
    g.fillStyle = i % 2 ? '#fff' : '#111';
    g.fillRect(i * 32, 0, 32, 14);
    g.fillStyle = i % 2 ? '#111' : '#fff';
    g.fillRect(i * 32, 82, 32, 14);
  }
  g.font = '800 52px Arial'; g.textAlign = 'center'; g.fillStyle = '#ffd23f';
  g.shadowColor = '#ffd23f'; g.shadowBlur = 14;
  g.fillText('🏁 STREET RACE', 256, 66);
  const bannerTex = new THREE.CanvasTexture(cv);
  bannerTex.colorSpace = THREE.SRGBColorSpace;
  for (const ry of [0, Math.PI]) { // one face each way so the text never mirrors
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(14.4, 2.7),
      new THREE.MeshBasicMaterial({ map: bannerTex }));
    bar.position.set(RACE_START.x, 6.2, RACE_START.z + (ry === 0 ? 0.03 : -0.03));
    bar.rotation.y = ry;
    scene.add(bar);
  }
  raceRing = new THREE.Mesh(new THREE.TorusGeometry(3.6, 0.32, 10, 28),
    new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false }));
  raceRing.visible = false;
  scene.add(raceRing);
  raceHudEl = document.getElementById('racehud');
  addFeed('🏁 Street race: drive through the yellow arch on the east avenue');
}
function placeRaceRing() {
  const c = RACE_CPS[race.cp];
  const prev = race.cp === 0 ? [RACE_START.x, RACE_START.z] : RACE_CPS[race.cp - 1];
  raceRing.position.set(c[0], 3.6, c[1]);
  raceRing.rotation.y = Math.atan2(c[0] - prev[0], c[1] - prev[1]);
  raceRing.visible = true;
}
function endRace(msg) {
  race.active = false;
  race.cooldown = 20;
  raceRing.visible = false;
  raceHudEl.style.display = 'none';
  if (msg) showBanner(msg);
}
function updateRace(dt) {
  if (!raceRing) return;
  race.cooldown = Math.max(0, race.cooldown - dt);
  if (!race.active) {
    if (driving && race.cooldown <= 0 && started && !player.dead &&
        Math.hypot(player.pos.x - RACE_START.x, player.pos.z - RACE_START.z) < 8) {
      race.active = true;
      race.cp = 0;
      race.t = 0;
      placeRaceRing();
      raceHudEl.style.display = 'block';
      showBanner('🏁 RACE — hit every ring!');
      say('Race started. Follow the rings.');
      playChirp();
    }
    return;
  }
  race.t += dt;
  raceRing.scale.setScalar(1 + Math.sin(game.time * 5) * 0.06);
  raceHudEl.textContent = `🏁 RING ${race.cp + 1} / ${RACE_CPS.length} · ${race.t.toFixed(1)}s`;
  if (!driving) { endRace('🏁 Race abandoned — car left'); return; }
  if (race.t > RACE_PAR * 2.5) { endRace('🏁 Too slow — race over'); return; }
  const c = RACE_CPS[race.cp];
  if (Math.hypot(player.pos.x - c[0], player.pos.z - c[1]) < 9) {
    race.cp++;
    playChirp();
    if (race.cp >= RACE_CPS.length) {
      const reward = 250 + Math.max(0, Math.round((RACE_PAR - race.t) * 10));
      game.money += reward;
      prog.bank += reward;
      bumpStat('races');
      addXP(60);
      recordScore();
      addFeed(`🏁 Race won in ${race.t.toFixed(1)}s — +$${reward}`);
      playCheer();
      if (prog.quest === 3) {
        questSay(['🏁 The rival slams his bars — you WON.',
          '📱 Unknown: “Impressive. Now find my five GOLDEN BOXES…”']);
        questAdvance(4);
        spawnGoldBoxes();
      } else if (prog.quest === 7 && (prog.stats.races || 0) - (prog.q7base || 0) >= 2) {
        questSay(['📱 Unknown: “He saw you win. He is FURIOUS.”',
          '🕵️ “Now show clean hands: FIVE deliveries, ZERO crashes.”']);
        prog.q8clean = 0;
        questAdvance(8);
      } else if (prog.quest === 7) refreshQuestbar();
      endRace(`🏁 RACE WON +$${reward}`);
    } else placeRaceRing();
  }
}

// ---------------------------------------------------------------------------
// City venues & activities — gym, nightclub, football court, street market,
// park with fountain, café terrace, arcade. Each lives in its own district.
// ---------------------------------------------------------------------------
const PLAZAS = [
  { x: 90, z: -30, type: 'court' },
  { x: -90, z: 30, type: 'market' },
  { x: -30, z: 90, type: 'park' },
];
const venues = [];      // { name, x, z, color, update? }
const musicZones = [];  // positions where the dance/energy track plays
const venueIdlers = []; // people idling/swaying at venues

function marquee(text, color, x, z, rotY, w = 7, y = 5) {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 192;
  const g = cv.getContext('2d');
  g.fillStyle = '#0a0c10'; g.fillRect(0, 0, 1024, 192);
  g.strokeStyle = color; g.lineWidth = 8; g.strokeRect(10, 10, 1004, 172);
  g.font = '900 96px Arial'; g.textAlign = 'center';
  g.shadowColor = color; g.shadowBlur = 30;
  g.fillStyle = color;
  g.fillText(text, 512, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.19),
    new THREE.MeshBasicMaterial({ map: tex }));
  sign.position.set(x, y, z);
  sign.rotation.y = rotY;
  scene.add(sign);
  sign.userData.repaint = img => { // real brand logo replaces the text
    g.fillStyle = '#0e0f12'; g.fillRect(0, 0, 1024, 192);
    g.strokeStyle = '#f2f2f2'; g.lineWidth = 6; g.strokeRect(8, 8, 1008, 176);
    const s = Math.min(880 / img.width, 156 / img.height);
    g.shadowBlur = 0;
    g.drawImage(img, 512 - img.width * s / 2, 96 - img.height * s / 2, img.width * s, img.height * s);
    tex.needsUpdate = true;
  };
  return sign;
}
// Real food brands: drop a logo into ads/ (e.g. ads/mcdonalds.png,
// ads/burgerking.png) and a restaurant in every city becomes that brand
// with the actual logo on its sign.
const BRAND_SLOTS = [
  { file: 'mcdonalds', name: "MCDONALD'S" },
  { file: 'burgerking', name: 'BURGER KING' },
  { file: 'kfc', name: 'KFC' },
  { file: 'starbucks', name: 'STARBUCKS' },
  { file: 'pizzahut', name: 'PIZZA HUT' },
  { file: 'dominos', name: 'DOMINOS' },
  { file: 'subway', name: 'SUBWAY' },
];
function applyBrandLogos() {
  if (CLEAN) return; // portal build: fictional names only, no logo lookups
  let slot = 0;
  for (const b of BRAND_SLOTS) {
    const img = new Image();
    img.onload = () => {
      // rebrand the next unbranded restaurant with the uploaded logo
      const r = RESTAURANTS.find(r0 => !r0.branded);
      if (!r || !r.sign) return;
      r.branded = true;
      r.name = b.name;
      r.sign.userData.repaint(img);
      slot++;
    };
    img.src = 'ads/' + b.file + '.png';
  }
}
function sitPose(rig) {
  rig.legs[0].rotation.x = rig.legs[1].rotation.x = -1.45;
  rig.group.position.y = -0.3;
}

function buildVenues() {
  // --- CLUB VOLT (west Central Ave) ---
  {
    const z = -45, x = -11.5;
    marquee('★ CLUB VOLT ★', '#ff4fd8', x + 0.3, z, Math.PI / 2, 8);
    const beams = [];
    for (const [dz, col] of [[-2.2, 0xff4fd8], [2.2, 0x41d8ff]]) {
      const beam = new THREE.Mesh(
        new THREE.ConeGeometry(1.1, 9, 12, 1, true),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.12,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      beam.position.set(x + 0.9, 4.5, z + dz);
      scene.add(beam);
      beams.push(beam);
      dayGlowMats.push({ mat: beam.material, base: 0.12 });
    }
    const light = new THREE.PointLight(0xff4fd8, 8, 20, 2);
    light.position.set(x + 1.6, 3.5, z);
    scene.add(light);
    const dancers = [];
    for (let i = 0; i < 4; i++) {
      const c = makeCivilian();
      c.group.position.set(x + 1.6 + Math.random(), 0, z - 3.5 + i * 2.2);
      c.group.rotation.y = -Math.PI / 2;
      scene.add(c.group);
      dancers.push({ rig: c, phase: Math.random() * 6 });
    }
    musicZones.push(new THREE.Vector3(x, 0, z));
    venues.push({ name: 'CLUB', x, z, color: '#ff4fd8', update(dt) {
      const beat = game.time * (126 / 60) * Math.PI * 2;
      light.color.setHSL((game.time * 0.22) % 1, 0.85, 0.55);
      light.intensity = (5 + 4 * Math.max(0, Math.sin(beat))) * (0.3 + 0.7 * NF);
      beams[0].rotation.z = Math.sin(game.time * 1.4) * 0.45;
      beams[1].rotation.z = Math.cos(game.time * 1.2) * 0.45;
      for (const d of dancers) {
        const b = Math.abs(Math.sin(beat / 2 + d.phase));
        d.rig.group.position.y = b * 0.1;
        d.rig.arms[0].rotation.x = -0.6 - b * 1.1;
        d.rig.arms[1].rotation.x = -0.6 - Math.abs(Math.cos(beat / 2 + d.phase)) * 1.1;
      }
    } });
  }

  // --- STREET FOOTBALL COURT (Tower Gardens plaza) — a live match ---
  {
    const { x: px, z: pz } = PLAZAS[0];
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 320;
    const g = cv.getContext('2d');
    g.fillStyle = '#2c6b3a'; g.fillRect(0, 0, 512, 320);
    g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 4;
    g.strokeRect(14, 14, 484, 292);
    g.beginPath(); g.moveTo(256, 14); g.lineTo(256, 306); g.stroke();
    g.beginPath(); g.arc(256, 160, 46, 0, Math.PI * 2); g.stroke();
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const pitch = new THREE.Mesh(new THREE.PlaneGeometry(24, 15),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
    pitch.rotation.x = -Math.PI / 2;
    pitch.rotation.z = Math.PI / 2 * 0; // court runs along x
    pitch.position.set(px, 0.03, pz);
    pitch.receiveShadow = true;
    scene.add(pitch);
    const mGoal = new THREE.MeshStandardMaterial({ color: 0xe8ecf0, roughness: 0.4 });
    for (const gx of [-11.5, 11.5]) {
      for (const dz of [-1.8, 1.8]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 8), mGoal);
        post.position.set(px + gx, 0.8, pz + dz);
        scene.add(post);
      }
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.7, 8), mGoal);
      bar.rotation.x = Math.PI / 2;
      bar.position.set(px + gx, 1.6, pz);
      scene.add(bar);
    }
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 }));
    ball.position.set(px, 0.16, pz);
    ball.castShadow = true;
    scene.add(ball);
    const ballVel = new THREE.Vector3();
    const players = [];
    for (let i = 0; i < 6; i++) {
      const look = randomLook();
      const team = i % 2 === 0 ? 0xd83030 : 0x3050d8;
      look.team = team;
      look.shorts = i % 2 === 0 ? 0xffffff : 0x14161a; // real football kit
      look.skirt = false;
      look.hairLong = false;
      const c = makeCharacter(look);
      c.group.position.set(px + (Math.random() - 0.5) * 16, 0, pz + (Math.random() - 0.5) * 10);
      scene.add(c.group);
      players.push({ rig: c, phase: Math.random() * 6, speed: 4.4 + Math.random() * 1.2 });
    }
    venues.push({ name: 'BALL', x: px, z: pz, color: '#7dff8a', update(dt) {
      ball.position.addScaledVector(ballVel, dt);
      ballVel.multiplyScalar(1 - dt * 0.6);
      ball.rotation.x += ballVel.z * dt * 6;
      if (Math.abs(ball.position.x - px) > 11) { ballVel.x *= -0.8; ball.position.x = px + Math.sign(ball.position.x - px) * 11; }
      if (Math.abs(ball.position.z - pz) > 6.6) { ballVel.z *= -0.8; ball.position.z = pz + Math.sign(ball.position.z - pz) * 6.6; }
      for (const p of players) {
        const gp = p.rig.group.position;
        const d = Math.hypot(ball.position.x - gp.x, ball.position.z - gp.z);
        if (d > 0.9) {
          // sprint: fast stride, forward lean, pumping bent arms
          const dir = Math.atan2(ball.position.x - gp.x, ball.position.z - gp.z);
          p.rig.group.rotation.y = dir;
          p.rig.group.rotation.x = 0.16;
          gp.x += Math.sin(dir) * p.speed * dt;
          gp.z += Math.cos(dir) * p.speed * dt;
          p.phase += dt * 14;
          const sw = Math.sin(p.phase) * 0.95;
          p.rig.legs[0].rotation.x = sw;
          p.rig.legs[1].rotation.x = -sw;
          p.rig.arms[0].rotation.x = -0.5 - sw * 0.7;
          p.rig.arms[1].rotation.x = -0.5 + sw * 0.7;
        } else {
          p.rig.group.rotation.x = 0;
        }
        if (d <= 0.9 && ballVel.length() < 2) {
          // kick toward a goal with some chaos
          const goalX = px + (Math.random() < 0.5 ? -11 : 11);
          const kd = new THREE.Vector3(goalX - ball.position.x, 0, pz + (Math.random() - 0.5) * 8 - ball.position.z).normalize();
          ballVel.copy(kd.multiplyScalar(5 + Math.random() * 5));
        }
        gp.x = Math.max(px - 11, Math.min(px + 11, gp.x));
        gp.z = Math.max(pz - 6.5, Math.min(pz + 6.5, gp.z));
      }
    } });
  }

  // --- STREET MARKET (Old Quarter plaza) ---
  {
    const { x: px, z: pz } = PLAZAS[1];
    const mWood = new THREE.MeshStandardMaterial({ color: 0x5b4630, roughness: 0.9 });
    for (let i = 0; i < 4; i++) {
      const sx = px - 9 + i * 6, sz = pz;
      const counter = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.0, 1.3), mWood);
      counter.position.set(sx, 0.5, sz);
      counter.castShadow = true;
      scene.add(counter);
      addCollider(new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(sx, 0.6, sz), new THREE.Vector3(2.7, 1.2, 1.4)));
      const awn = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.08, 2.2),
        new THREE.MeshStandardMaterial({ color: THEME.neon[i % THEME.neon.length], roughness: 0.85 }));
      awn.position.set(sx, 2.2, sz);
      awn.rotation.x = -0.12;
      awn.castShadow = true;
      scene.add(awn);
      for (const [wx2, wz2] of [[-1.35, -0.9], [1.35, -0.9], [-1.35, 0.9], [1.35, 0.9]]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.2, 6), mWood);
        post.position.set(sx + wx2, 1.1, sz + wz2);
        scene.add(post);
      }
      for (let b = 0; b < 3; b++) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.5),
          new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.55, 0.45), roughness: 0.9 }));
        box.position.set(sx - 0.7 + b * 0.7, 1.16, sz + (Math.random() - 0.5) * 0.4);
        scene.add(box);
      }
      // vendor behind, shopper in front
      const vendor = makeCivilian();
      vendor.group.position.set(sx, 0, sz - 1.4);
      scene.add(vendor.group);
      venueIdlers.push({ rig: vendor, phase: Math.random() * 6 });
      if (Math.random() < 0.8) {
        const shopper = makeCivilian();
        shopper.group.position.set(sx + (Math.random() - 0.5), 0, sz + 1.5);
        shopper.group.rotation.y = Math.PI;
        scene.add(shopper.group);
        venueIdlers.push({ rig: shopper, phase: Math.random() * 6 });
      }
    }
    venues.push({ name: 'SOUQ', x: px, z: pz, color: '#ffd23f' });
  }

  // --- PARK with fountain (plaza) ---
  {
    const { x: px, z: pz } = PLAZAS[2];
    // a real lawn: green grass circle, gravel cross-paths, flower beds, hedges
    const lawn = new THREE.Mesh(new THREE.CircleGeometry(20, 28),
      new THREE.MeshStandardMaterial({ color: THEME.camels ? 0x8a9152 : 0x3e6b3a, roughness: 0.95 }));
    lawn.rotation.x = -Math.PI / 2;
    lawn.position.set(px, 0.015, pz);
    lawn.receiveShadow = true;
    scene.add(lawn);
    const mPath = new THREE.MeshStandardMaterial({ color: 0xb9ab90, roughness: 0.95 });
    for (const rot of [0, Math.PI / 2]) {
      const path = new THREE.Mesh(new THREE.PlaneGeometry(40, 2.4), mPath);
      path.rotation.x = -Math.PI / 2;
      path.rotation.z = rot;
      path.position.set(px, 0.025, pz);
      scene.add(path);
    }
    { // flower beds dotted across the lawn
      const flowerCols = [0xd8385a, 0xe8c33a, 0xd87ae0, 0xe8e8e8, 0xe8703a];
      const flowers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 6, 5),
        new THREE.MeshStandardMaterial({ roughness: 0.8 }), 48);
      const m4 = new THREE.Matrix4();
      const col = new THREE.Color();
      for (let i = 0; i < 48; i++) {
        const a = Math.random() * Math.PI * 2, r = 5 + Math.random() * 13;
        const fx = px + Math.cos(a) * r, fz = pz + Math.sin(a) * r;
        m4.makeTranslation(fx, 0.12, fz);
        flowers.setMatrixAt(i, m4);
        flowers.setColorAt(i, col.setHex(flowerCols[i % flowerCols.length]));
      }
      scene.add(flowers);
    }
    { // hedge ring with gaps at the paths
      const mHedge = new THREE.MeshStandardMaterial({ color: 0x2c4a28, roughness: 0.95 });
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        // leave openings where the gravel paths cross the ring
        if (Math.abs(Math.sin(a)) < 0.22 || Math.abs(Math.cos(a)) < 0.22) continue;
        const hedge = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.9, 1.1), mHedge);
        hedge.position.set(px + Math.cos(a) * 19, 0.45, pz + Math.sin(a) * 19);
        hedge.rotation.y = -a + Math.PI / 2;
        hedge.castShadow = true;
        scene.add(hedge);
      }
    }
    const base = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.6, 0.55, 18),
      new THREE.MeshStandardMaterial({ color: 0x8a8d92, roughness: 0.8 }));
    base.position.set(px, 0.27, pz);
    scene.add(base);
    addCollider(new THREE.Box3().setFromCenterAndSize(
      new THREE.Vector3(px, 0.5, pz), new THREE.Vector3(5, 1, 5)));
    const water = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.1, 0.1, 18),
      new THREE.MeshStandardMaterial({ color: 0x3a6c8c, roughness: 0.1, metalness: 0.3 }));
    water.position.set(px, 0.56, pz);
    scene.add(water);
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.28, 2.0, 10),
      new THREE.MeshBasicMaterial({ color: 0xbfe0ff, transparent: true, opacity: 0.35,
        blending: THREE.AdditiveBlending, depthWrite: false }));
    column.position.set(px, 1.55, pz);
    scene.add(column);
    const drops = [];
    for (let i = 0; i < 12; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexShared, color: 0x9fd0ff, transparent: true, opacity: 0.4,
        blending: THREE.AdditiveBlending, depthWrite: false }));
      s.scale.setScalar(0.35);
      scene.add(s);
      drops.push({ s, phase: i / 12, ang: (i / 12) * Math.PI * 2 });
    }
    const mBench = new THREE.MeshStandardMaterial({ color: 0x6b4f33, roughness: 0.9 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      const bx = px + Math.cos(a) * 6, bz = pz + Math.sin(a) * 6;
      const seat = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.1, 0.55), mBench);
      seat.position.set(bx, 0.48, bz);
      seat.rotation.y = -a + Math.PI / 2;
      seat.castShadow = true;
      scene.add(seat);
      const back = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.5, 0.08), mBench);
      back.position.set(bx - Math.cos(a) * 0.26, 0.78, bz - Math.sin(a) * 0.26);
      back.rotation.y = -a + Math.PI / 2;
      scene.add(back);
      if (i % 2 === 0) {
        const sitter = makeCivilian();
        sitter.group.position.set(bx + Math.cos(a) * 0.1, 0, bz + Math.sin(a) * 0.1);
        sitter.group.rotation.y = -a - Math.PI / 2;
        sitPose(sitter);
        scene.add(sitter.group);
      }
    }
    venues.push({ name: 'PARK', x: px, z: pz, color: '#7dc8ff', update(dt) {
      for (const d of drops) {
        d.phase = (d.phase + dt * 0.55) % 1;
        const t = d.phase;
        const r = 0.3 + t * 1.5;
        d.s.position.set(px + Math.cos(d.ang) * r, 2.45 + 2.6 * t * (1 - t) - t * 1.8, pz + Math.sin(d.ang) * r);
        d.s.material.opacity = 0.45 * (1 - t);
      }
    } });
  }

  // --- CAFÉ TERRACE (west Central Ave) ---
  {
    const x = -11.5, z = 15;
    marquee('LE ROYAL CAFÉ', '#ffd479', x + 0.3, z, Math.PI / 2, 6);
    for (let i = 0; i < 3; i++) {
      const tx = x + 2.2, tz = z - 4 + i * 4;
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.05, 12),
        new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.6 }));
      top.position.set(tx, 0.75, tz);
      scene.add(top);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.75, 8),
        new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.5, metalness: 0.6 }));
      pole.position.set(tx, 0.38, tz);
      scene.add(pole);
      const upole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.1, 6),
        new THREE.MeshStandardMaterial({ color: 0x8a8d92, roughness: 0.5 }));
      upole.position.set(tx, 1.85, tz);
      scene.add(upole);
      const umb = new THREE.Mesh(new THREE.ConeGeometry(1.2, 0.5, 8),
        new THREE.MeshStandardMaterial({ color: i % 2 ? 0xc23b3b : 0xd8d4c8, roughness: 0.85 }));
      umb.position.set(tx, 2.8, tz);
      umb.castShadow = true;
      scene.add(umb);
      addCollider(new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(tx, 0.6, tz), new THREE.Vector3(1.2, 1.2, 1.2)));
      if (i !== 1) {
        const guest = makeCivilian();
        guest.group.position.set(tx + 0.9, 0, tz);
        guest.group.rotation.y = -Math.PI / 2;
        sitPose(guest);
        scene.add(guest.group);
      }
    }
    venues.push({ name: 'CAFE', x, z, color: '#ffd479' });
  }

  // --- ARCADE (east Central Ave) ---
  {
    const x = 11.5, z = -15;
    marquee('ARCADE', '#41d8ff', x - 0.3, z, -Math.PI / 2, 6);
    const winMats = [];
    for (const dz of [-1.6, 1.6]) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.4),
        new THREE.MeshBasicMaterial({ color: 0x41d8ff }));
      win.position.set(x - 0.35, 1.8, z + dz);
      win.rotation.y = -Math.PI / 2;
      scene.add(win);
      winMats.push(win.material);
    }
    for (let i = 0; i < 2; i++) {
      const kid = makeCivilian();
      kid.group.position.set(x - 1.6, 0, z - 1 + i * 2);
      kid.group.rotation.y = Math.PI / 2;
      scene.add(kid.group);
      venueIdlers.push({ rig: kid, phase: Math.random() * 6 });
    }
    venues.push({ name: 'ARC', x, z, color: '#41d8ff', update() {
      winMats[0].color.setHSL((game.time * 0.5) % 1, 0.8, 0.6);
      winMats[1].color.setHSL((game.time * 0.5 + 0.5) % 1, 0.8, 0.6);
    } });
  }

  // register the gym (built separately) for the map
  venues.push({ name: 'GYM', x: clubPos.x, z: clubPos.z, color: '#ffb02a' });
  musicZones.push(clubPos);

  // --- street performers: a singer and dancers draw a small crowd ---
  {
    const bx = -30, bz = 70.5; // sidewalk by the park
    // small stage mat
    const mat = new THREE.Mesh(new THREE.CircleGeometry(2.6, 20),
      new THREE.MeshStandardMaterial({ color: 0x25201c, roughness: 0.95 }));
    mat.rotation.x = -Math.PI / 2;
    mat.position.set(bx, 0.02, bz);
    scene.add(mat);
    // the singer, mic in raised hand
    const singer = makeCivilian();
    singer.group.position.set(bx, 0, bz);
    singer.group.rotation.y = Math.PI;
    singer.arms[1].rotation.x = -1.9; // mic arm up
    const mic = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0x22242a, roughness: 0.4, metalness: 0.5 }));
    mic.position.set(0.24, 1.62, 0.34);
    singer.group.add(mic);
    scene.add(singer.group);
    // two dancers beside the singer
    const dancers = [];
    for (const dx of [-1.5, 1.5]) {
      const d = makeCivilian();
      d.group.position.set(bx + dx, 0, bz + 0.4);
      d.group.rotation.y = Math.PI;
      scene.add(d.group);
      dancers.push({ rig: d, phase: Math.random() * 6 });
    }
    // a small crowd watching and clapping
    const crowd = [];
    for (let i = 0; i < 4; i++) {
      const c = makeCivilian();
      c.group.position.set(bx - 2.2 + i * 1.5, 0, bz + 3.1);
      c.group.rotation.y = Math.PI;
      scene.add(c.group);
      crowd.push({ rig: c, phase: Math.random() * 6 });
    }
    musicZones.push(new THREE.Vector3(bx, 0, bz));
    venues.push({ name: 'LIVE', x: bx, z: bz, color: '#8affa0', update(dt) {
      const beat = game.time * (110 / 60) * Math.PI * 2;
      // singer sways, mic arm held high
      singer.group.rotation.z = Math.sin(game.time * 1.8) * 0.06;
      singer.arms[1].rotation.x = -1.9 + Math.sin(beat / 2) * 0.15;
      singer.arms[0].rotation.x = -0.4 + Math.sin(game.time * 1.3) * 0.4;
      for (const d of dancers) {
        const b = Math.abs(Math.sin(beat / 2 + d.phase));
        d.rig.group.position.y = b * 0.12;
        d.rig.group.rotation.y = Math.PI + Math.sin(game.time * 1.1 + d.phase) * 0.5;
        d.rig.arms[0].rotation.x = -0.8 - b * 1.3;
        d.rig.arms[1].rotation.x = -0.8 - Math.abs(Math.cos(beat / 2 + d.phase)) * 1.3;
      }
      for (const c of crowd) { // clapping in time
        const clap = Math.abs(Math.sin(beat + c.phase));
        c.rig.arms[0].rotation.x = -1.1 - clap * 0.35;
        c.rig.arms[1].rotation.x = -1.1 - clap * 0.35;
        c.rig.group.position.y = Math.abs(Math.sin(beat / 4 + c.phase)) * 0.04;
      }
    } });
  }

  // --- named restaurants: real pickup points with visible signs ---
  {
    const names = [...SHOP_NAMES].concat(CITY.sponsors[0].name);
    const spots = [[60, 33], [-60, -33], [0, -63], [120, 15], [-120, 45], [30, 117], [-30, -117], [90, -87]];
    spots.forEach(([sx, sz], i) => {
      const name = names[i % names.length];
      const alongX = Math.abs(sx) === 60 || sx === 0 || Math.abs(sx) === 120 ? false : true;
      // place at the building line facing the nearest street
      const street = STREETS.reduce((a, b) => Math.abs(b - sx) < Math.abs(a - sx) ? b : a);
      const side = sz > 0 ? 1 : -1;
      const x = street + side * 10.9;
      const z = sz;
      const rotY = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      const color = THEME.neon[i % THEME.neon.length];
      const sign = marquee(name, color, x + side * 0.2, z, rotY, 4.2, 3.4);
      // stack of pizza boxes waiting by the door for pickup
      const mBoxW = new THREE.MeshStandardMaterial({ color: 0xf2ece0, roughness: 0.8 });
      const mBoxR = new THREE.MeshStandardMaterial({ color: 0xd8352a, roughness: 0.7 });
      for (let bI = 0; bI < 3; bI++) {
        const pb = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.085, 0.42), bI === 1 ? mBoxR : mBoxW);
        pb.position.set(x - side * 1.1, 0.34 + bI * 0.085, z + 1.35);
        pb.rotation.y = Math.random() * 0.5;
        pb.castShadow = true;
        scene.add(pb);
      }
      const stand = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.3, 0.6),
        new THREE.MeshStandardMaterial({ color: 0x5a4a34, roughness: 0.9 }));
      stand.position.set(x - side * 1.1, 0.15, z + 1.35);
      scene.add(stand);
      RESTAURANTS.push({ name, x: x - side * 1.6, z, sign });
    });
    applyBrandLogos();
  }
}
const RESTAURANTS = [];
function updateVenues(dt) {
  for (const v of venues) if (v.update) v.update(dt);
  for (const p of venueIdlers) {
    p.phase += dt;
    p.rig.group.rotation.z = Math.sin(p.phase * 0.8) * 0.03;
  }
  // real character models: play their own animations, or idle-sway fallback
  for (const m of modelMixers) m.update(dt);
  for (const w of modelWanderers) {
    w.ang += dt * w.speed / w.r;
    const wy = (w.alt || 0) + (w.bob ? Math.sin(game.time * 0.8 + w.ang * 3) * w.bob : 0);
    w.obj.position.set(w.cx + Math.cos(w.ang) * w.r, wy, w.cz + Math.sin(w.ang) * w.r);
    w.obj.rotation.y = Math.atan2(-Math.sin(w.ang), Math.cos(w.ang)) + (w.off || 0);
    if (w.bank) w.obj.rotation.z = w.bank; // aircraft roll gently into the turn
  }
  for (const w of realWalkers) {
    w.v += w.speed * w.dir * dt;
    if (w.v > 126 || w.v < -126) w.dir *= -1;
    // sidestep other walkers and pedestrians instead of walking through them
    const wx = w.alongX ? w.v : w.s + w.side + w.jit;
    const wz = w.alongX ? w.s + w.side + w.jit : w.v;
    let push = 0;
    for (const o of realWalkers) {
      if (o === w) continue;
      const op = o.obj.position;
      const d = Math.hypot(wx - op.x, wz - op.z);
      if (d < 1.1) push += ((w.alongX ? wz - op.z : wx - op.x) >= 0 ? 1 : -1) * (1.1 - d) || (1.1 - d);
    }
    for (const p of peds) {
      const pp = p.rig.group.position;
      const d = Math.hypot(wx - pp.x, wz - pp.z);
      if (d < 0.9) push += ((w.alongX ? wz - pp.z : wx - pp.x) >= 0 ? 1 : -1) * (0.9 - d) || (0.9 - d);
    }
    if (push !== 0) w.jit += Math.sign(push) * 1.8 * dt;
    else w.jit -= Math.sign(w.jit) * Math.min(Math.abs(w.jit), 0.6 * dt);
    w.jit = Math.max(-1.6, Math.min(1.6, w.jit));
    if (w.alongX) {
      w.obj.position.set(w.v, 0, w.s + w.side + w.jit);
      w.obj.rotation.y = (w.dir > 0 ? Math.PI / 2 : -Math.PI / 2) + w.off;
    } else {
      w.obj.position.set(w.s + w.side + w.jit, 0, w.v);
      w.obj.rotation.y = (w.dir > 0 ? 0 : Math.PI) + w.off;
    }
  }
  for (const gc of gestureCyclers) {
    gc.t -= dt;
    if (gc.t <= 0) {
      const prev = gc.actions[gc.cur];
      gc.cur = (gc.cur + 1) % gc.actions.length;
      prev.fadeOut(0.4);
      gc.actions[gc.cur].reset().fadeIn(0.4).play();
      gc.t = 5 + Math.random() * 4;
    }
  }
  for (const b of modelBobbers) {
    b.phase += dt;
    // clearly visible: weight shifts, breathing bob, slow look-around
    b.obj.rotation.y = b.baseRot + Math.sin(b.phase * 0.35) * (b.amp ?? 0.5);
    b.obj.rotation.z = Math.sin(b.phase * 0.9) * 0.02;
    b.obj.position.y = b.baseY + Math.abs(Math.sin(b.phase * 1.4)) * 0.025;
  }
}

// ---------------------------------------------------------------------------
// Red Bull energy boost — pick up cans around the city, press Q to drink,
// move fast for a few seconds ("gives you wings")
// ---------------------------------------------------------------------------
const energy = { cans: 1, boostT: 0, drinkT: 0 };
const BOOST_DUR = 8;
const canPickups = [];
// real Red Bull label from ads/ (uploaded logo), graceful if missing
function cleanCanTex() {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 128;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, '#1a3a8a'); grad.addColorStop(0.5, '#3a6ad8'); grad.addColorStop(1, '#122a66');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 128);
  g.fillStyle = '#ffd23f'; g.font = '900 64px Arial'; g.textAlign = 'center';
  g.fillText('⚡', 32, 84);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const redbullTex = CLEAN ? cleanCanTex() : new THREE.TextureLoader().load('ads/redbull.png',
  t => { t.colorSpace = THREE.SRGBColorSpace; });
// optional real bottle photo — upload ads/redbull_bottle.png and pickups
// switch from the 3D can to the actual bottle image
let bottleTex = null;
if (!CLEAN) new THREE.TextureLoader().load('ads/redbull_bottle.png', t => {
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
  addFeed('⚡ ' + EN_BRAND_U + ' — speed boost!');
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
    osc.connect(g).connect(MASTER);
    osc.start(t); osc.stop(t + 0.13);
  }
}
const boostfxEl = document.getElementById('boostfx');
function updateEnergy(dt) {
  for (const c of canPickups) {
    c.t += dt;
    c.mesh.position.y = 1.0 + Math.sin(c.t * 2) * 0.15;
    c.mesh.rotation.y += dt * 2.2;
    if (energy.cans < energyCap() &&
        Math.hypot(c.mesh.position.x - player.pos.x, c.mesh.position.z - player.pos.z) < 1.8) {
      energy.cans++;
      playClick(2100, 0.25);
      addFeed(EN_BRAND + ' picked up — press Q to drink');
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
  // slim light beam that fades out with height instead of a fat tube
  const gradCv = document.createElement('canvas');
  gradCv.width = 2; gradCv.height = 64;
  const gctx = gradCv.getContext('2d');
  const grad = gctx.createLinearGradient(0, 64, 0, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  gctx.fillStyle = grad;
  gctx.fillRect(0, 0, 2, 64);
  const gradTex = new THREE.CanvasTexture(gradCv);
  const cyl = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.7, 9, 14, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x41d8ff, map: gradTex, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  cyl.position.y = 4.5;
  g.add(cyl);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.09, 8, 24),
    new THREE.MeshBasicMaterial({ color: 0x41d8ff }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.3;
  g.add(ring);
  // floating icon so you always know what you're heading for
  const iconCv = document.createElement('canvas');
  iconCv.width = iconCv.height = 128;
  const iconTex = new THREE.CanvasTexture(iconCv);
  const icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: iconTex, transparent: true, depthWrite: false }));
  icon.scale.setScalar(2.2);
  icon.position.y = 4.2;
  g.add(icon);
  scene.add(g);
  return { group: g, cyl, ring, icon, iconCv, iconTex };
}
function setBeacon(x, z, color, emoji = '🍕') {
  if (!beacon) beacon = makeBeacon();
  beacon.group.position.set(x, 0, z);
  beacon.cyl.material.color.set(color);
  beacon.ring.material.color.set(color);
  const c = beacon.iconCv.getContext('2d');
  c.clearRect(0, 0, 128, 128);
  c.font = '96px serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(emoji, 64, 70);
  beacon.iconTex.needsUpdate = true;
  beacon.group.visible = true;
}
function newOrder() {
  // collect from a real named restaurant (nearest few, picked at random)
  const sorted = [...RESTAURANTS].sort((a, b) =>
    Math.hypot(a.x - player.pos.x, a.z - player.pos.z) - Math.hypot(b.x - player.pos.x, b.z - player.pos.z));
  // the session's first order is always the closest restaurant with a short
  // drop — action within the first minute, not a hike across the map
  const first = game.deliveries === 0;
  const r = (first ? sorted[0] : sorted[Math.floor(Math.random() * Math.min(4, sorted.length))]) ||
    { name: SHOP_NAMES[0], x: player.pos.x + 40, z: player.pos.z };
  const from = new THREE.Vector3(r.x, 0, r.z);
  const to = streetPointNear(from, first ? 45 : 70, first ? 90 : 190);
  order.active = true;
  order.stage = 'pickup';
  order.name = r.name;
  order.fx = from.x; order.fz = from.z;
  order.tx = to.x; order.tz = to.z;
  // the guest who ordered waits at the drop-off
  if (order.customer) { scene.remove(order.customer.group); order.customer = null; }
  order.customer = makeCivilian();
  order.customer.group.position.set(to.x, 0, to.z);
  scene.add(order.customer.group);
  order.assignT = game.time;
  order.dist0 = Math.hypot(from.x - player.pos.x, from.z - player.pos.z)
    + Math.hypot(to.x - from.x, to.z - from.z);
  order.reward = Math.round((12 + Math.hypot(to.x - from.x, to.z - from.z) * 0.15)
    * (1 + prog.level * 0.02)
    * (1 + Math.min(game.deliveries * 0.04, 1))
    * (1 + 0.07 * upgLvl('rep'))); // street rep: famous drivers charge more
  // every third order is a VIP rush: 2.5x pay, deadline after pickup
  order.vip = game.deliveries > 0 && game.deliveries % 3 === 2;
  order.timeLeft = 0;
  if (order.vip) order.reward = Math.round(order.reward * 2.5);
  // fragile orders: 1.8x pay, but a hard crash while carrying halves it
  order.fragile = !order.vip && Math.random() < 0.25;
  order.dropped = false;
  order.droneDone = false;
  if (order.fragile) order.reward = Math.round(order.reward * 1.8);
  setBeacon(from.x, from.z, order.vip ? 0xffd23f : 0x41d8ff, '🍕');
  phoneNotify(order.vip ? '📳 VIP ORDER' : order.fragile ? '📳 FRAGILE ORDER' : '📳 NEW ORDER',
    `${order.name} — $${order.reward}${order.fragile ? ' · no crashing!' : ''}`, from.x, from.z);
  say(`New order from ${order.name}`);
  showBanner(order.vip ? '⭐ VIP RUSH ORDER' : order.fragile ? '🥡 FRAGILE ORDER — 1.8× pay' : 'New order');
  addFeed(order.vip ? `⭐ VIP order from ${order.name} — 2.5× pay!`
    : order.fragile ? `🥡 Fragile order from ${order.name} — no crashing!`
    : `Order from ${order.name}`);
  playClick(1700, 0.2);
}
let earlyAmbush = false;
function updateDelivery(dt) {
  // scripted first-minute action: robbers jump the new driver ~25s in
  if (!THEME.noGuns && !earlyAmbush && game.time > 25 && !player.dead && !cine.active) {
    earlyAmbush = true;
    for (let i = 0; i < 2; i++) {
      const p = streetPointNear(player.pos, 18, 32);
      spawnEnemy(p.x, p.z);
    }
    showBanner('⚠ Robbers spotted your delivery bag!');
    addFeed('⚠ Two robbers are coming for you — fight back!');
  }
  if (!order.active) {
    order.cooldown -= dt;
    if (order.cooldown <= 0) newOrder();
    return;
  }
  const tx = order.stage === 'pickup' ? order.fx : order.tx;
  const tz = order.stage === 'pickup' ? order.fz : order.tz;
  const d = Math.hypot(player.pos.x - tx, player.pos.z - tz);
  orderTaskEl.textContent = (order.vip ? '⭐ VIP — ' : order.fragile ? '🥡 FRAGILE — ' : '') + (order.stage === 'pickup'
    ? `Pick up: ${order.name} — ${locationName(order.fx, order.fz)}`
    : `Deliver to customer — ${locationName(order.tx, order.tz)}`);
  if (order.vip && order.stage === 'dropoff' && order.timeLeft > 0) {
    order.timeLeft -= dt;
    if (order.timeLeft <= 0) {
      order.vip = false;
      order.reward = Math.round(order.reward / 2.5);
      addFeed('⏱ VIP deadline missed — normal pay');
      setBeacon(order.tx, order.tz, 0x7dff8a, '📦');
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
  // the waiting guest faces you and waves once you carry their order
  if (order.customer) {
    const cg = order.customer.group;
    cg.rotation.y = Math.atan2(player.pos.x - cg.position.x, player.pos.z - cg.position.z);
    if (order.stage === 'dropoff') {
      order.customer.arms[1].rotation.x = -2.6;
      order.customer.arms[1].rotation.z = Math.sin(game.time * 6) * 0.4 - 0.2;
    }
  }
  if (d < 4.5 || (order.stage === 'dropoff' && order.droneDone)) {
    if (order.stage === 'pickup') {
      order.stage = 'dropoff';
      if (order.vip)
        order.timeLeft = 14 + Math.hypot(order.tx - player.pos.x, order.tz - player.pos.z) * 0.55;
      setBeacon(order.tx, order.tz, order.vip ? 0xffd23f : 0x7dff8a, '📦');
      say('Picked up. Deliver to the customer.');
      showBanner(order.vip ? `Picked up — ⏱ beat the clock!` : 'Picked up — go deliver!');
      playClick(1900, 0.25);
      if (!THEME.noGuns && Math.random() < Math.min(0.35 + prog.level * 0.008, 0.85)) {
        const n = 2 + Math.floor(Math.random() * 2) + Math.min(Math.floor(prog.level / 12), 3);
        for (let i = 0; i < n; i++) {
          const p = streetPointNear(player.pos, 25, 45);
          spawnEnemy(p.x, p.z);
        }
        if (prog.level >= 5 && Math.random() < 0.2) {
          const bp = streetPointNear(player.pos, 25, 45);
          spawnEnemy(bp.x, bp.z, true);
          showBanner('💀 A GANG BOSS wants your order!');
          addFeed('💀 Gang boss ambush — $150 bounty on his head');
        } else {
          showBanner('Robbers want your order!');
          addFeed('⚠ Robbers incoming — defend the delivery');
        }
      }
    } else {
      order.active = false;
      order.cooldown = 3;
      const mult2 = 1 + Math.min(game.streak * 0.1, 1);
      let pay = Math.round(order.reward * mult2);
      // the faster the run, the fatter the pay: beat 8 m/s average for +30%
      const elapsed = Math.max(1, game.time - (order.assignT || 0));
      if (order.dist0 && order.dist0 / elapsed > 8) {
        pay = Math.round(pay * 1.3);
        setTimeout(() => showBanner('⚡ SPEED BONUS +30% — fast driver!'), 1400);
      }
      game.money += pay;
      game.deliveries++;
      game.streak++;
      prog.bank += pay;
      prog.stats.deliv = (prog.stats.deliv || 0) + 1;
      prog.stats.earned = (prog.stats.earned || 0) + pay;
      if (prog.quest === 8) {
        prog.q8clean = (prog.q8clean || 0) + 1;
        if (prog.q8clean >= 5) {
          questSay(['📱 Unknown: “Five clean drops. He is waiting at the park…”']);
          questAdvance(9);
        } else refreshQuestbar();
      }
      checkAchs();
      if (game.deliveries % 5 === 0) {
        playCheer();
        setTimeout(() => { showBanner('🔥 RUSH HOUR — payouts increased!'); }, 1800);
      }
      addXP(16 + pay / 2);
      recordScore();
      if (energy.cans < energyCap()) energy.cans++;
      for (const w2 of WEAPONS) w2.reserve = Math.max(w2.reserve, w2.magSize * 4);
      player.health = Math.min(maxHealth(), player.health + 25);
      if (beacon) beacon.group.visible = false;
      showBanner(`Delivered! +$${pay}${game.streak > 1 ? ` · STREAK ×${mult2.toFixed(1)}` : ''}`);
      addFeed(`${playerName()} handed the order to the guest — +$${pay}`);
      if (order.customer) {
        const done = order.customer;
        order.customer = null;
        done.arms[0].rotation.x = done.arms[1].rotation.x = -2.4; // happy arms up
        setTimeout(() => scene.remove(done.group), 4000);
      }
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
// ---------------------------------------------------------------------------
// The driver phone — Waze-style navigation: camera-follow heading-up map,
// live route line, voice guidance, and orders arriving as push notifications
// with a radar ping
// ---------------------------------------------------------------------------
const mmCanvas = document.getElementById('minimap');
const mmCtx = mmCanvas.getContext('2d');
const radarCv = document.getElementById('radar');
const radarCtx = radarCv.getContext('2d');
const nav = { lastSpeak: 0, lastInstr: '', notifT: 0, nx: 0, nz: 0, arrived: false };
let mmFrame = 0;

function say(text, force) {
  const t = performance.now();
  if (!force && t - nav.lastSpeak < 3500) return;
  nav.lastSpeak = t;
  try {
    if (!window.speechSynthesis) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.06; u.volume = 0.9;
    speechSynthesis.speak(u);
  } catch (e) { /* voice is a bonus, never fatal */ }
}
function nearestStreetC(v) {
  return STREETS.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a);
}
function navTarget() {
  if (race.active) {
    const c = RACE_CPS[race.cp];
    return { x: c[0], z: c[1], label: `🏁 RING ${race.cp + 1} / ${RACE_CPS.length}` };
  }
  if (taxi.state === 'ride') return { x: taxi.tx, z: taxi.tz, label: '🚕 DROP THE PASSENGER' };
  if (mode === 'delivery' && order.active) {
    return order.stage === 'pickup'
      ? { x: order.fx, z: order.fz, label: '🍕 ' + order.name }
      : { x: order.tx, z: order.tz, label: '📦 CUSTOMER' };
  }
  if (taxi.state === 'wait') return { x: taxi.px, z: taxi.pz, label: '🚕 PASSENGER WAITING' };
  if (prog.quest === 1) return { x: MYSTERY_DROP.x, z: MYSTERY_DROP.z, label: '📜 MYSTERY DROP' };
  if (prog.quest === 2) return { x: -9.9, z: -41.5, label: '📜 THE DJ AT THE CLUB' };
  if (prog.quest === 4) {
    const nb = quest.boxes.find(b => !b.got);
    if (nb) return { x: nb.x, z: nb.z, label: '📜 GOLDEN BOX' };
  }
  if (prog.quest === 0 || prog.quest === 5)
    return { x: STRANGER_POS.x, z: STRANGER_POS.z, label: '📜 THE STRANGER' };
  return null;
}
// Manhattan route down the street grid: onto my road, along it, across, arrive
function navRoutePts(t) {
  const px = player.pos.x, pz = player.pos.z;
  const vx = nearestStreetC(px);
  const hz = nearestStreetC(t.z);
  const raw = [[px, pz], [vx, pz], [vx, hz], [t.x, hz], [t.x, t.z]];
  const pts = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const prev = pts[pts.length - 1];
    if (Math.hypot(raw[i][0] - prev[0], raw[i][1] - prev[1]) > 2) pts.push(raw[i]);
  }
  return pts;
}
function updateNavPhone(dt) {
  // status bar clock = the player's real time
  const d = new Date();
  document.getElementById('ph-time').textContent =
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const t = navTarget();
  const destEl = document.getElementById('ph-dest');
  const etaEl = document.getElementById('ph-eta');
  if (!t) {
    destEl.textContent = mode === 'delivery' ? 'NO ACTIVE ORDER' : 'SURVIVE THE WAVE';
    etaEl.textContent = mode === 'delivery' ? 'waiting for orders…' : 'hostiles marked in red';
    nav.arrived = false;
  } else {
    const pts = navRoutePts(t);
    let dist = 0;
    for (let i = 1; i < pts.length; i++)
      dist += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    destEl.textContent = t.label;
    etaEl.textContent = `${Math.round(dist)} m · ~${Math.max(1, Math.ceil(dist / 9))}s · follow the blue line`;
    // voice turn guidance: announce the next corner as it approaches
    if (pts.length > 2) {
      const dNext = Math.hypot(pts[1][0] - player.pos.x, pts[1][1] - player.pos.z);
      if (dNext < 24) {
        const a = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]];
        const b = [pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]];
        const cross = a[0] * b[1] - a[1] * b[0];
        if (Math.abs(cross) > 1) {
          const instr = cross > 0 ? 'left' : 'right';
          if (nav.lastInstr !== instr + pts[1][0] + ',' + pts[1][1]) {
            nav.lastInstr = instr + pts[1][0] + ',' + pts[1][1];
            say(`Turn ${instr} ahead`);
          }
        }
      }
    }
    const dHere = Math.hypot(t.x - player.pos.x, t.z - player.pos.z);
    if (dHere < 14 && !nav.arrived) { nav.arrived = true; say('You have arrived'); }
    if (dHere > 25) nav.arrived = false;
  }
  // push notification lifetime + radar sweep
  if (nav.notifT > 0) {
    nav.notifT -= dt;
    if (nav.notifT <= 0) document.getElementById('phonenotif').style.display = 'none';
    else drawRadar();
  }
}
function phoneNotify(title, sub, x, z) {
  nav.notifT = 6.5;
  nav.nx = x; nav.nz = z;
  document.querySelector('#ph-notif-txt b').textContent = title;
  document.getElementById('ph-notif-sub').textContent = sub;
  document.getElementById('phonenotif').style.display = 'flex';
  const ph = document.getElementById('phone');
  ph.classList.remove('ring');
  void ph.offsetWidth;
  ph.classList.add('ring');
  playClick(1240, 0.14);
  setTimeout(() => playClick(1650, 0.14), 140);
  setTimeout(() => playClick(1240, 0.12), 300);
}
function drawRadar() {
  const S = radarCv.width, C = S / 2;
  radarCtx.clearRect(0, 0, S, S);
  radarCtx.fillStyle = '#0a1410';
  radarCtx.beginPath(); radarCtx.arc(C, C, C - 1, 0, Math.PI * 2); radarCtx.fill();
  radarCtx.strokeStyle = 'rgba(60,220,120,.35)';
  for (const r of [0.35, 0.68, 1]) {
    radarCtx.beginPath(); radarCtx.arc(C, C, (C - 2) * r, 0, Math.PI * 2); radarCtx.stroke();
  }
  // rotating sweep
  const a = game.time * 2.6;
  const grd = radarCtx.createLinearGradient(C, C, C + Math.cos(a) * C, C + Math.sin(a) * C);
  grd.addColorStop(0, 'rgba(60,220,120,0)');
  grd.addColorStop(1, 'rgba(60,220,120,.8)');
  radarCtx.strokeStyle = grd; radarCtx.lineWidth = 2;
  radarCtx.beginPath(); radarCtx.moveTo(C, C);
  radarCtx.lineTo(C + Math.cos(a) * (C - 2), C + Math.sin(a) * (C - 2));
  radarCtx.stroke();
  radarCtx.lineWidth = 1;
  // blip at the order's true bearing (heading-up, same frame as the map)
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
  const dx = nav.nx - player.pos.x, dz = nav.nz - player.pos.z;
  const bx = dx * -cy + dz * sy, by = -(dx * -sy + dz * -cy);
  const bd = Math.hypot(bx, by) || 1;
  const rr = Math.min(1, bd / 160) * (C - 6);
  const blink = 0.55 + 0.45 * Math.sin(game.time * 7);
  radarCtx.fillStyle = `rgba(125,255,138,${blink})`;
  radarCtx.beginPath();
  radarCtx.arc(C + (bx / bd) * rr, C + (by / bd) * rr, 3, 0, Math.PI * 2);
  radarCtx.fill();
}

// ---------------------------------------------------------------------------
// Street voices — locals talk to you Zelda-style when you walk up close,
// and some of them hand the driver a little gift
// ---------------------------------------------------------------------------
const TALK_LINES = [
  'Welcome to {city}, driver!',
  'Best pizza in {city} — the place with the neon sign.',
  'I saw the police chase a courier this morning…',
  'The race arch is on the east avenue. You look fast!',
  'Deliver without crashing — fragile boxes pay double.',
  'Somebody said a shark lives in the bay 🦈',
  'The gym makes your legs faster. True story.',
  'Keep your streak going — the app pays extra!',
  'Stay away from the robbers near the club.',
  'Nice helmet!',
  '{city} never sleeps.',
  'They say a UFO circles the desert at night…',
  'My grandmother tips every driver. Be nice!',
  'A gang boss runs this district. Watch yourself.',
  'Rush hour pays the best. Keep riding!',
  'Good luck on your shift, driver!',
  'I ordered coffee an hour ago… is it you?',
  'The bus never comes. I should order a ride.',
];
const npcBubbleEl = document.getElementById('npcbubble');
const _bub = new THREE.Vector3();
let bubbleNpc = null;
function updateNpcTalk() {
  if (!started || player.dead || cine.active || (driving && Math.abs(driving.speed) > 6)) {
    npcBubbleEl.style.display = 'none';
    bubbleNpc = null;
    return;
  }
  let best = null, bd = 4;
  for (const p of peds) {
    if (p.fleeing) continue;
    const g = p.rig.group.position;
    const d = Math.hypot(g.x - player.pos.x, g.z - player.pos.z);
    if (d < bd) { bd = d; best = p; }
  }
  if (best !== bubbleNpc) {
    bubbleNpc = best;
    if (best) {
      if (!best.line) {
        best.line = TALK_LINES[(Math.random() * TALK_LINES.length) | 0].replace('{city}', CITY.name);
        // one in six locals has a gift for their favourite courier
        if (!best.gifted && peds.indexOf(best) % 6 === 2) {
          best.gifted = true;
          const cash = 10 + ((Math.random() * 16) | 0);
          game.money += cash;
          prog.bank += cash;
          saveProg();
          best.line = `🎁 A tip for my favourite driver — take it! +$${cash}`;
          addFeed(`🎁 A local slipped you $${cash}`);
          playClick(2100, 0.2);
        }
      }
      npcBubbleEl.textContent = best.line;
    }
  }
  if (bubbleNpc) {
    const g = bubbleNpc.rig.group.position;
    _bub.set(g.x, 2.15, g.z).project(camera);
    if (_bub.z < 1 && Math.abs(_bub.x) < 1.1) {
      npcBubbleEl.style.display = 'block';
      npcBubbleEl.style.left = ((_bub.x * 0.5 + 0.5) * window.innerWidth) + 'px';
      npcBubbleEl.style.top = ((-_bub.y * 0.5 + 0.5) * window.innerHeight) + 'px';
    } else npcBubbleEl.style.display = 'none';
  } else npcBubbleEl.style.display = 'none';
}

function drawMinimap() {
  const S = mmCanvas.width, H = mmCanvas.height;
  const k = (S / (CITY_HALF * 2)) * 2.7; // zoomed in like a nav app
  // heading-up frame: world forward maps to screen-up
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
  const f0 = -sy, f1 = -cy;        // view direction in world
  const r0 = -cy, r1 = sy;         // right-hand vector
  const P = (x, z) => {
    const dx = x - player.pos.x, dz = z - player.pos.z;
    return [S / 2 + (dx * r0 + dz * r1) * k, H * 0.66 - (dx * f0 + dz * f1) * k];
  };
  mmCtx.fillStyle = '#101923';   // nav-app night ground
  mmCtx.fillRect(0, 0, S, H);
  // roads as thick strokes
  mmCtx.strokeStyle = '#2c3947';
  mmCtx.lineCap = 'butt';
  mmCtx.lineWidth = ROAD_HALF * 2 * k;
  for (const s of STREETS) {
    let p1 = P(s, -CITY_HALF), p2 = P(s, CITY_HALF);
    mmCtx.beginPath(); mmCtx.moveTo(p1[0], p1[1]); mmCtx.lineTo(p2[0], p2[1]); mmCtx.stroke();
    p1 = P(-CITY_HALF, s); p2 = P(CITY_HALF, s);
    mmCtx.beginPath(); mmCtx.moveTo(p1[0], p1[1]); mmCtx.lineTo(p2[0], p2[1]); mmCtx.stroke();
  }
  // centre dashes
  mmCtx.strokeStyle = 'rgba(255,255,255,.14)';
  mmCtx.lineWidth = 1;
  mmCtx.setLineDash([4, 6]);
  for (const s of STREETS) {
    let p1 = P(s, -CITY_HALF), p2 = P(s, CITY_HALF);
    mmCtx.beginPath(); mmCtx.moveTo(p1[0], p1[1]); mmCtx.lineTo(p2[0], p2[1]); mmCtx.stroke();
    p1 = P(-CITY_HALF, s); p2 = P(CITY_HALF, s);
    mmCtx.beginPath(); mmCtx.moveTo(p1[0], p1[1]); mmCtx.lineTo(p2[0], p2[1]); mmCtx.stroke();
  }
  mmCtx.setLineDash([]);
  // the route — a glowing Waze-blue line to the destination
  const target = navTarget();
  if (target) {
    const pts = navRoutePts(target);
    mmCtx.strokeStyle = 'rgba(65,200,255,.28)';
    mmCtx.lineWidth = 7;
    mmCtx.lineJoin = 'round';
    mmCtx.beginPath();
    pts.forEach(([x, z], i) => {
      const p = P(x, z);
      i === 0 ? mmCtx.moveTo(p[0], p[1]) : mmCtx.lineTo(p[0], p[1]);
    });
    mmCtx.stroke();
    mmCtx.strokeStyle = '#41c9ff';
    mmCtx.lineWidth = 3;
    mmCtx.stroke();
    // destination pin
    const tp = P(target.x, target.z);
    mmCtx.fillStyle = race.active ? '#ffd23f' : order.stage === 'pickup' ? '#41d8ff' : '#7dff8a';
    mmCtx.beginPath(); mmCtx.arc(tp[0], tp[1], 5, 0, Math.PI * 2); mmCtx.fill();
    mmCtx.strokeStyle = '#fff'; mmCtx.lineWidth = 1.5;
    mmCtx.beginPath(); mmCtx.arc(tp[0], tp[1], 5, 0, Math.PI * 2); mmCtx.stroke();
  }
  // traffic + hostiles
  mmCtx.fillStyle = 'rgba(200,205,215,.5)';
  for (const c of traffic) {
    const p = P(c.group.position.x, c.group.position.z);
    mmCtx.fillRect(p[0] - 1.5, p[1] - 1.5, 3, 3);
  }
  mmCtx.fillStyle = '#ff4d4d';
  for (const en of enemies) {
    if (en.dead) continue;
    const p = P(en.pos.x, en.pos.z);
    mmCtx.beginPath(); mmCtx.arc(p[0], p[1], 3, 0, Math.PI * 2); mmCtx.fill();
  }
  if (!race.active) {
    const p = P(RACE_START.x, RACE_START.z);
    mmCtx.fillStyle = '#ffd23f';
    mmCtx.fillRect(p[0] - 2.5, p[1] - 2.5, 5, 5);
  }
  // petrol stations glow orange on the nav app
  mmCtx.fillStyle = '#ff8a2a';
  for (const fs of FUEL_STATIONS) {
    const p = P(fs.x, fs.z);
    mmCtx.fillRect(p[0] - 3, p[1] - 3, 6, 6);
  }
  mmCtx.fillStyle = '#41c9ff';
  for (const ws of WASH_STATIONS) {
    const p = P(ws.x, ws.z);
    mmCtx.fillRect(p[0] - 3, p[1] - 3, 6, 6);
  }
  if (prog.quest === 4) {
    mmCtx.fillStyle = '#ffd23f';
    for (const b of quest.boxes) {
      if (b.got) continue;
      const p = P(b.x, b.z);
      mmCtx.beginPath(); mmCtx.arc(p[0], p[1], 3.5, 0, Math.PI * 2); mmCtx.fill();
    }
  }
  if (taxi.state === 'wait') {
    const p = P(taxi.px, taxi.pz);
    mmCtx.fillStyle = '#c86aff';
    mmCtx.beginPath(); mmCtx.arc(p[0], p[1], 4, 0, Math.PI * 2); mmCtx.fill();
  } else if (taxi.state === 'ride') {
    const p = P(taxi.tx, taxi.tz);
    mmCtx.fillStyle = '#c86aff';
    mmCtx.beginPath(); mmCtx.arc(p[0], p[1], 4.5, 0, Math.PI * 2); mmCtx.fill();
  }
  // the driver: fixed chevron, always pointing up
  mmCtx.save();
  mmCtx.translate(S / 2, H * 0.66);
  mmCtx.fillStyle = '#ffffff';
  mmCtx.strokeStyle = 'rgba(65,200,255,.9)';
  mmCtx.lineWidth = 2;
  mmCtx.beginPath();
  mmCtx.moveTo(0, -8);
  mmCtx.lineTo(5.5, 6);
  mmCtx.lineTo(0, 2.5);
  mmCtx.lineTo(-5.5, 6);
  mmCtx.closePath();
  mmCtx.fill();
  mmCtx.stroke();
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
  const hh = Math.floor(localHour()), mm = Math.floor((localHour() % 1) * 60);
  document.getElementById('cine-city').textContent =
    `${CITY.name} — ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const sub = document.querySelector('#cine-title span:last-child');
  if (sub) sub.textContent = mode === 'delivery'
    ? `DRIVER ${playerName()} — SHIFT STARTING`
    : `${playerName()} — HOLD THE BLOCK UNTIL EXTRACTION`;
  cineEl.style.display = 'block';
  requestAnimationFrame(() => cineEl.classList.add('on'));
}
function finishCinematic() {
  cine.active = false;
  gun.visible = !(THEME && THEME.noGuns);
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
  const o = OUTFITS.find(o => o.id === prog.outfit);
  if (o && o.shirt !== null) { l.uniform = o.shirt; l.pantsColor = o.pants; }
  return l;
}
// seated, headless copy of the player's avatar shown on scooters/bicycles
function makeRider() {
  const c = makeCharacter(driverLook(), { head: false });
  c.group.position.set(0, 0.42, -0.3);
  c.legs[0].rotation.x = c.legs[1].rotation.x = -1.2;
  c.arms[0].rotation.x = c.arms[1].rotation.x = -0.85;
  // full-face courier helmet in the brand color with a dark visor
  const brand = new THREE.Color(prog.goldRider ? 0xffd23f : selectedCity().sponsors[0].colorA);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.12, 8),
    new THREE.MeshStandardMaterial({ color: 0x181a1e, roughness: 0.8 }));
  neck.position.y = 1.5; c.group.add(neck);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 12),
    new THREE.MeshStandardMaterial({ color: brand, roughness: 0.22, metalness: 0.15 }));
  helmet.scale.set(0.95, 1.06, 1.0);
  helmet.position.y = 1.63; c.group.add(helmet);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.09, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x0c1016, roughness: 0.12, metalness: 0.5 }));
  visor.position.set(0, 1.64, 0.13); c.group.add(visor);
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
  pv.scene.add(new THREE.HemisphereLight(0xe0ecf8, 0x55504a, 3.2));
  const d = new THREE.DirectionalLight(0xffffff, 3.4);
  d.position.set(2, 3, 2);
  pv.scene.add(d);
  const rim = new THREE.DirectionalLight(0x7fd0ff, 1.6);
  rim.position.set(-2, 2, -2);
  pv.scene.add(rim);
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
      refreshModeAvail();
      refreshMenuText();
      // menu backdrop shows the real city — swap it by reloading into the selection
      if (CITY && CITY.id !== city.id) setTimeout(() => location.reload(), 180);
    });
    wrap.appendChild(card);
  }
  // menu text follows the player: greeting, city, mode
  function refreshMenuText() {
    const city = selectedCity();
    const greet = document.getElementById('greet');
    if (greet) greet.textContent = profile.name.trim()
      ? `WELCOME, ${profile.name.trim().toUpperCase()}` : 'DRIVER PROFILE';
    const dl = document.getElementById('deployline');
    if (dl) {
      dl.textContent = mode === 'delivery'
        ? `CLICK TO START ${profile.name.trim() ? profile.name.trim().toUpperCase() + "'S" : 'YOUR'} SHIFT IN ${city.name}`
        : `CLICK TO DEPLOY INTO ${city.name}`;
      dl.style.color = city.accent;
    }
  }
  window.__refreshMenuText = refreshMenuText;

  const pl = document.getElementById('progressline');
  if (pl) {
    const nu = nextUnlock();
    pl.textContent = `DRIVER LEVEL ${prog.level} / 100` +
      (prog.bank > 0 ? ` · LIFETIME EARNINGS $${prog.bank}` : '') +
      (nu ? ` · NEXT UNLOCK: ${nu.what} (LVL ${nu.level})` : '');
  }
  // combat mode is not offered in the no-guns (Arabic) cities
  function refreshModeAvail() {
    const wavesBtn = document.querySelector('[data-mode="waves"]');
    const banned = THEMES[selectedId] && THEMES[selectedId].noGuns;
    if (wavesBtn) wavesBtn.style.display = banned ? 'none' : '';
    if (banned && mode === 'waves') {
      mode = 'delivery';
      localStorage.setItem('streetops.mode', mode);
      document.querySelectorAll('.modebtn').forEach(b =>
        b.classList.toggle('sel', b.dataset.mode === 'delivery'));
    }
  }
  window.refreshModeAvail = refreshModeAvail;
  refreshModeAvail();
  // game mode buttons
  document.querySelectorAll('.modebtn').forEach(btn => {
    btn.classList.toggle('sel', btn.dataset.mode === mode);
    btn.addEventListener('click', e => {
      if (!btn.dataset.mode) return;
      e.stopPropagation();
      mode = btn.dataset.mode;
      localStorage.setItem('streetops.mode', mode);
      document.querySelectorAll('.modebtn').forEach(b => b.classList.toggle('sel', b === btn));
      refreshMenuText();
    });
  });
  refreshMenuText();

  // driver profile: username + avatar
  const profileBox = document.getElementById('profile');
  if (profileBox) {
    profileBox.addEventListener('click', e => e.stopPropagation());
    const nameInput = document.getElementById('username');
    nameInput.value = profile.name;
    nameInput.addEventListener('input', () => {
      profile.name = nameInput.value.slice(0, 14);
      saveProfile();
      if (window.__refreshMenuText) window.__refreshMenuText();
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
let menuOrbit = Math.random() * 6;
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
  if (beacon && beacon.group.visible) {
    beacon.icon.position.y = 4.2 + Math.sin(game.time * 2.2) * 0.3;
    const pulse = 1 + Math.sin(game.time * 3) * 0.12;
    beacon.ring.scale.setScalar(pulse);
  }
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
    // live menu backdrop: slow cinematic orbit over the glowing city
    if (CITY) {
      game.time += dtReal;
      menuOrbit += dtReal * 0.045;
      const r = 95, h = 52;
      camera.position.set(Math.cos(menuOrbit) * r, h + Math.sin(menuOrbit * 0.7) * 8, Math.sin(menuOrbit) * r);
      camera.lookAt(0, 12, 0);
      updateAtmosphere(dtReal);
      updateClub(dtReal);
      updateVenues(dtReal);
      updateTraffic(dtReal);
      updatePeds(dtReal);
      updateCamels(dtReal);
    }
    doRender();
    return;
  }
  if (adPaused) { doRender(); return; } // an ad is on screen — freeze the world
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
  if (isTouch) {
    // buttons change meaning behind the wheel: jump→brake, enter→exit
    const j = document.getElementById('btnJump'), a = document.getElementById('btnAct');
    const jl = driving ? '🛑' : '⤒', al = driving ? '🚶' : '🚗';
    if (j.textContent !== jl) j.textContent = jl;
    if (a.textContent !== al) a.textContent = al;
  }
  if (!player.dead && driving) {
    updateDriving(dt);
    drivehintEl.style.display = 'none';
    cafehintEl.style.display = 'none';
  } else if (!player.dead) {
    const sprinting = (((keys['ShiftLeft'] || keys['ShiftRight']) && keys['KeyW']) || touchMove.hard) && !aiming;
    const boost = energy.boostT > 0 ? 1.45 : 1;
    const sprintSpd = 8.2 * (1 + 0.08 * upgLvl('fit'));
    const speed = (aiming ? 2.6 : sprinting ? sprintSpd : 5.2) * boost;
    const fwd = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const wish = new THREE.Vector3();
    if (keys['KeyW']) wish.add(fwd);
    if (keys['KeyS']) wish.sub(fwd);
    if (keys['KeyD']) wish.add(right);
    if (keys['KeyA']) wish.sub(right);
    wish.addScaledVector(fwd, -touchMove.y);
    wish.addScaledVector(right, touchMove.x);
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

    if (player.health < maxHealth() && game.time - player.lastHurt > 4)
      player.health = Math.min(maxHealth(), player.health + dt * 22);

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
    nearRest = null;
    for (const r of RESTAURANTS)
      if (Math.hypot(r.x - player.pos.x, r.z - player.pos.z) < 4.5) { nearRest = r; break; }
    cafehintEl.style.display = nearRest && !cafeOpen ? 'block' : 'none';
    if (nearRest) cafehintEl.textContent = isTouch
      ? `🍕 TAP HERE TO EAT AT ${nearRest.name}` : `🍕 PRESS F TO EAT AT ${nearRest.name}`;
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
  updateCamels(dt);
  updateAnimals(dt);
  updateEnergy(dt);
  updateClub(dt);
  updateVenues(dt);
  updateTutorial(dt);
  updateHeat(dt);
  updateAmbient(dt);
  musicTick();
  updateRecording(dt);
  updateRace(dt);
  updateTaxi(dt);
  updateDrone(dt);
  updateFishing(dt);
  updateQuest(dt);
  updateInteractions();
  carryBox.visible = mode === 'delivery' && order.active && order.stage === 'dropoff'
    && !driving && !player.dead && !cine.active;
  // parked cars you damaged keep smoking where they stand
  for (const v2 of vehicles) {
    if (v2 === driving || v2.health >= 45) continue;
    v2.smokeT -= dt;
    if (v2.smokeT <= 0) {
      v2.smokeT = v2.health <= 0 ? 0.15 : 0.3;
      const sp = v2.group.position.clone();
      sp.y = 1.0;
      spawnSmoke(sp);
    }
  }
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
  document.getElementById('lvl').textContent = playerName() + ' · LVL ' + prog.level + ' · '
    + (prog.goldRider ? '⭐ GOLDEN ' : '') + rankName();
  document.getElementById('cans').textContent = '⚡ ×' + energy.cans;
  if (++frameNo % 20 === 0)
    document.getElementById('location').textContent =
      '📍 ' + locationName(player.pos.x, player.pos.z) + ' · ' + CITY.name;
  document.getElementById('boostfill').style.width = Math.max(0, energy.boostT / BOOST_DUR * 100) + '%';
  document.getElementById('xpfill').style.width =
    (prog.level >= 100 ? 100 : Math.min(100, prog.xp / xpNeed(prog.level) * 100)) + '%';
  magEl.textContent = W().mag;
  reserveEl.textContent = W().reserve;
  healthfillEl.style.width = (player.health / maxHealth() * 100) + '%';
  healthfillEl.style.background = player.health > 50
    ? 'linear-gradient(90deg,#3ddc7a,#8bf0b0)'
    : 'linear-gradient(90deg,#e0483a,#f09a5a)';
  vignetteEl.style.opacity = Math.min(1, (maxHealth() - player.health) / 70 + (game.time - player.lastHurt < 0.4 ? 0.5 : 0));
  if (hitmarkerTimer > 0) {
    hitmarkerTimer -= dt;
    if (hitmarkerTimer <= 0) hitmarkerEl.style.opacity = 0;
  }
  if (bannerTimer > 0) {
    bannerTimer -= dt;
    bannerEl.style.opacity = Math.min(1, bannerTimer);
  }
  if (++mmFrame % 3 === 0) { // nav app refreshes at a third of the framerate
    drawMinimap();
    updateNavPhone(dt * 3);
    updateNpcTalk();
  }

  doRender();
}
// build the selected city immediately so the menu floats over the live skyline
buildCity(selectedCity());

tick();

// debug/testing handle
window.__so = {
  get cineT() { return cine.t; },
  tp(x, z, yaw = 0) {
    player.pos.set(x, 0, z); player.yaw = yaw; player.pitch = 0;
    if (driving) { driving.group.position.set(x, 0, z); driving.yaw = yaw; driving.speed = 0; }
  },
  veh(type) {
    const v = vehicles.find(v => v.type === type && v.health > 0);
    return v ? [v.group.position.x, v.group.position.z, v.yaw] : null;
  },
  get ride() {
    return myRide ? [myRide.type, myRide.group.position.x, myRide.group.position.z] : null;
  },
  get race() { return { active: race.active, cp: race.cp, t: race.t }; },
  get cam() { return camMode; },
  navt() { const t = navTarget(); return t ? { x: t.x, z: t.z } : null; },
  get taxi() { return { state: taxi.state, px: taxi.px, pz: taxi.pz, tx: taxi.tx, tz: taxi.tz, reward: taxi.reward }; },
  hail() { taxi.cd = 0; },
  boss() {
    const p = streetPointNear(player.pos, 10, 18);
    spawnEnemy(p.x, p.z, true);
  },
  near(x, z, r = 6) {
    const out = [], v = new THREE.Vector3();
    scene.traverse(o => {
      if (!o.isMesh && !o.isSprite) return;
      o.getWorldPosition(v);
      if (Math.hypot(v.x - x, v.z - z) < r && v.y < 25) {
        let root = o;
        while (root.parent && root.parent !== scene) root = root.parent;
        const col = o.material && o.material.color ? o.material.color.getHexString() : '?';
        out.push(`${o.name || (o.geometry && o.geometry.type) || o.type}#${col}<${root.name || root.type}` +
          `@${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)}`);
      }
    });
    return out.slice(0, 25);
  },
  wanted(n = 1) { heat.crimeCd = 0; addHeat(n, 'Debug'); },
  kill(cash) { if (cash) game.money = cash; reviveSafeT = 0; game.streak = 5; hurtPlayer(9999); },
  giants() {
    const out = [];
    const v = new THREE.Vector3();
    scene.traverse(o => {
      if (o.isMesh) {
        o.getWorldScale(v);
        const s = Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
        if (s > 40) out.push(`${o.name || o.type}|scale=${s.toFixed(1)}`);
      }
      if (o.isBone) {
        o.getWorldPosition(v);
        const p = Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
        if (p > 300) out.push(`${o.name || 'bone'}|pos=${p.toFixed(0)}`);
      }
    });
    return out.slice(0, 15);
  },
  get state() {
    return {
      cine: cine.active, driving: !!driving, firing, locked, started, mode,
      mag: W().mag, cooldown: weapon.cooldown, reloading: weapon.reloading,
      dead: player.dead, wave: game.wave, enemies: enemies.length,
      money: game.money, order: order.active ? order.stage : null,
      peds: peds.length, traffic: traffic.length, nf: NF,
      pos: [player.pos.x, player.pos.z],
      camels: camels.length, realCamels: camels.filter(c => !c.rig.legs).length,
      wanderers: modelWanderers.length, walkers: realWalkers.length,
      music: +MUSIC.i.toFixed(3), musicOn: !!MUSIC.bus,
      ocd: +order.cooldown.toFixed(2), gt: +game.time.toFixed(1),
      weather: weather.state, rain: weather.amount | 0, vehicles: vehicles.length,
      tut: tut.step, tutDisp: tutbarEl.style.display,
      heat: heat.level, pursuers: pursuers.length, adPaused, portal: PORTAL,
      pnear: pursuers.length ? Math.min(...pursuers.map(p =>
        Math.hypot(p.group.position.x - player.pos.x, p.group.position.z - player.pos.z))) | 0 : -1,
    };
  },
};
