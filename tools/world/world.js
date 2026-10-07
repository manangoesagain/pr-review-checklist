// The miniature world the landing page flies through: a pull request (a little
// glowing card) travels a road past five checkpoint islands, one per review area,
// and arrives at a giant checklist. Everything is plain three.js shapes in a matte
// clay style, and every movement is a pure function of time, so any frame can be
// rendered again exactly. tools/world/render.mjs records it into the scroll clips.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---- timeline ---------------------------------------------------------------
export const FPS = 30;
export const DIVE_SECONDS = 6;
export const CONNECTOR_SECONDS = 4;
export const SCENES = ['start', 'security', 'tests', 'breaking', 'docs', 'performance', 'checklist'];

/** The clips in play order: dive0, conn0, dive1, … dive6, each with its start and length in seconds. */
export function segments() {
  const list = [];
  let start = 0;
  SCENES.forEach((id, i) => {
    list.push({ kind: 'dive', index: i, name: id, start, seconds: DIVE_SECONDS });
    start += DIVE_SECONDS;
    if (i < SCENES.length - 1) {
      list.push({ kind: 'conn', index: i, name: `${id}-to-${SCENES[i + 1]}`, start, seconds: CONNECTOR_SECONDS });
      start += CONNECTOR_SECONDS;
    }
  });
  return list;
}

export const TOTAL_SECONDS = segments().at(-1).start + DIVE_SECONDS;

// ---- palette ----------------------------------------------------------------
export const PALETTE = {
  skyTop: '#5fa8f5',
  sky: '#ffe3c4',
  water: '#3fb0c9',
  waterDeep: '#2b8db0',
  grass: '#8cd068',
  grassDark: '#64b552',
  earth: '#e6a86f',
  road: '#fff3dc',
  wall: '#fffaf1',
  roof: '#ff7b5c',
  wood: '#c4844f',
  stone: '#ddd4c6',
  dark: '#33384a',
  brand: '#3b6fe0',
  security: '#ff5f5a',
  tests: '#2fc58c',
  breaking: '#ffad1f',
  docs: '#4d8dff',
  performance: '#a36bff',
  white: '#fffaf2',
};

const clay = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.88, metalness: 0, flatShading: true, ...extra });
const glow = (color, strength = 1) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: strength, roughness: 0.6 });

// ---- small math helpers -----------------------------------------------------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smoother = (x) => { x = clamp(x); return x * x * x * (x * (x * 6 - 15) + 10); };
const smooth = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
const lerp = (a, b, t) => a + (b - a) * t;
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mesh(geometry, material, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1, shadow = true } = {}) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  if (typeof s === 'number') m.scale.setScalar(s); else m.scale.set(...s);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

const box = (w, h, d, r = 0.08) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2) * 0.999);

// ---- the layout of the world ------------------------------------------------
// Island centres along a gentle zig-zag; the road joins them.
const ISLANDS = [
  { id: 'start', c: v3(0, 0, 0), r: 7.2 },
  { id: 'security', c: v3(17, 0, -7), r: 6.4 },
  { id: 'tests', c: v3(33, 0, 1), r: 6.8 },
  { id: 'breaking', c: v3(48, 0, -8), r: 0 }, // a bridge between two islets, no main island
  { id: 'docs', c: v3(63, 0, 0), r: 6.4 },
  { id: 'performance', c: v3(78, 0, -7), r: 6.8 },
  { id: 'checklist', c: v3(94, 0, 0), r: 7.8 },
];
const TOP = 0.6; // height of the grass on every island
const ROAD_Y = TOP + 0.03;

// Where the road goes. The PR stops at STOPS[i] while the camera dives into scene i.
const ROAD_POINTS = [
  v3(-3.5, ROAD_Y, 2.5), v3(1.5, ROAD_Y, 0.5), v3(6.5, ROAD_Y, -2.5),
  v3(12, ROAD_Y, -6.5), v3(17, ROAD_Y, -7), v3(22, ROAD_Y, -5.5),
  v3(28, ROAD_Y, 0.5), v3(33, ROAD_Y, 1), v3(38.5, ROAD_Y, -1.5),
  v3(43, ROAD_Y, -7.6), v3(48, ROAD_Y, -8), v3(53, ROAD_Y, -6.5),
  v3(58, ROAD_Y, 0.4), v3(63, ROAD_Y, 0.5), v3(68, ROAD_Y, -2),
  v3(73, ROAD_Y, -6.8), v3(78, ROAD_Y, -7), v3(83, ROAD_Y, -5),
  v3(89, ROAD_Y, 0.2), v3(92.2, ROAD_Y, 0.6),
];
const road = new THREE.CatmullRomCurve3(ROAD_POINTS, false, 'centripetal');
// Fraction along the road where the PR waits at each scene.
const STOP_POINTS = [ROAD_POINTS[1], ROAD_POINTS[4], ROAD_POINTS[7], ROAD_POINTS[10], ROAD_POINTS[13], ROAD_POINTS[16], ROAD_POINTS[19]];
const STOPS = STOP_POINTS.map((p) => nearestU(p));

function nearestU(point) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i <= 2000; i++) {
    const u = i / 2000;
    const d = road.getPointAt(u).distanceToSquared(point);
    if (d < bestD) { bestD = d; best = u; }
  }
  return best;
}

function onAnyIsland(x, z) {
  return ISLANDS.some((isl) => isl.r > 0 && Math.hypot(x - isl.c.x, z - isl.c.z) < isl.r - 0.2)
    || EXTRA_ISLETS.some((isl) => Math.hypot(x - isl.c.x, z - isl.c.z) < isl.r - 0.2);
}
const EXTRA_ISLETS = [
  { c: v3(41.5, 0, -6.4), r: 3.2 },
  { c: v3(54.8, 0, -5.6), r: 3.2 },
];

// ---- building blocks ----------------------------------------------------------
function island(group, c, r, seed) {
  const random = rng(seed);
  const sides = 9;
  const earth = mesh(new THREE.CylinderGeometry(r * 0.97, r * 0.82, 1.6, sides), clay(PALETTE.earth), { x: c.x, y: TOP - 0.95, z: c.z, ry: random() * 3 });
  const grass = mesh(new THREE.CylinderGeometry(r, r * 0.98, 0.4, sides), clay(PALETTE.grass), { x: c.x, y: TOP - 0.2, z: c.z, ry: earth.rotation.y });
  group.add(earth, grass);
  // A rim of rocks where the island meets the water.
  for (let i = 0; i < 9; i++) {
    const a = random() * Math.PI * 2;
    const rr = r * (0.9 + random() * 0.12);
    group.add(mesh(new THREE.DodecahedronGeometry(0.35 + random() * 0.35, 0), clay(PALETTE.stone), { x: c.x + Math.cos(a) * rr, y: -0.1, z: c.z + Math.sin(a) * rr, ry: random() * 3 }));
  }
}

function tree(group, x, z, random, scale = 1) {
  const s = scale * (0.75 + random() * 0.5);
  group.add(mesh(new THREE.CylinderGeometry(0.09 * s, 0.13 * s, 0.6 * s, 6), clay(PALETTE.wood), { x, y: TOP + 0.3 * s, z }));
  const tone = random() > 0.5 ? PALETTE.grassDark : '#4fa45a';
  if (random() > 0.45) {
    group.add(mesh(new THREE.ConeGeometry(0.55 * s, 1.3 * s, 7), clay(tone), { x, y: TOP + 1.15 * s, z, ry: random() * 3 }));
  } else {
    group.add(mesh(new THREE.IcosahedronGeometry(0.62 * s, 0), clay(tone), { x, y: TOP + 1.05 * s, z, ry: random() * 3 }));
  }
}

function scatterTrees(group, c, r, count, seed, keepClear) {
  const random = rng(seed);
  let placed = 0;
  for (let tries = 0; tries < 400 && placed < count; tries++) {
    const a = random() * Math.PI * 2;
    const d = Math.sqrt(random()) * (r - 1);
    const x = c.x + Math.cos(a) * d;
    const z = c.z + Math.sin(a) * d;
    if (nearRoad(x, z, 1.5) || keepClear.some((k) => Math.hypot(x - k[0], z - k[1]) < k[2])) continue;
    tree(group, x, z, random);
    placed++;
  }
}

const ROAD_SAMPLES = Array.from({ length: 600 }, (_, i) => road.getPointAt(i / 599));
function nearRoad(x, z, dist) {
  return ROAD_SAMPLES.some((p) => Math.hypot(p.x - x, p.z - z) < dist);
}

function house(group, x, z, { w = 2, d = 1.8, h = 1.4, roof = PALETTE.roof, wall = PALETTE.wall, ry = 0 } = {}) {
  const g = new THREE.Group();
  g.position.set(x, TOP, z);
  g.rotation.y = ry;
  g.add(mesh(box(w, h, d, 0.12), clay(wall), { y: h / 2 }));
  const roofGeo = new THREE.CylinderGeometry(0.01, d * 0.78, 0.9, 4, 1);
  roofGeo.rotateY(Math.PI / 4);
  g.add(mesh(roofGeo, clay(roof), { y: h + 0.45, s: [w / d * 1.05, 1, 1.05] }));
  g.add(mesh(box(0.42, 0.7, 0.06, 0.04), clay(PALETTE.wood), { y: 0.35, z: d / 2 + 0.01 }));
  for (const sx of [-1, 1]) g.add(mesh(box(0.38, 0.34, 0.05, 0.04), glow('#ffe7a8', 0.35), { x: sx * w * 0.28, y: h * 0.62, z: d / 2 + 0.01, shadow: false }));
  group.add(g);
  return g;
}

function lamp(group, x, z, color, height = 1.6) {
  group.add(mesh(new THREE.CylinderGeometry(0.06, 0.08, height, 6), clay(PALETTE.dark), { x, y: TOP + height / 2, z }));
  const bulb = mesh(new THREE.SphereGeometry(0.18, 10, 8), glow(color, 0.2), { x, y: TOP + height + 0.12, z, shadow: false });
  group.add(bulb);
  return bulb;
}

function flag(group, x, z, color, height = 2.6) {
  group.add(mesh(new THREE.CylinderGeometry(0.05, 0.05, height, 6), clay(PALETTE.wall), { x, y: TOP + height / 2, z }));
  const cloth = mesh(new THREE.PlaneGeometry(0.9, 0.55, 6, 1), clay(color, { side: THREE.DoubleSide }), { x: x + 0.47, y: TOP + height - 0.3, z });
  group.add(cloth);
  return cloth;
}

// A green or coloured tick made of two rounded bars.
function tick(color) {
  const g = new THREE.Group();
  const m = clay(color);
  g.add(mesh(box(0.22, 0.5, 0.16, 0.06), m, { x: -0.16, y: -0.06, rz: 0.75 }));
  g.add(mesh(box(0.22, 0.95, 0.16, 0.06), m, { x: 0.16, y: 0.1, rz: -0.6 }));
  return g;
}

// ---- the scenes ------------------------------------------------------------------
// Each builder adds its models and returns update(T) for its moving parts, plus the
// point the camera dives toward.

function buildStart(group) {
  const c = ISLANDS[0].c;
  island(group, c, ISLANDS[0].r, 11);
  const studio = house(group, c.x - 2.6, c.z - 2.4, { w: 3.2, d: 2.4, h: 1.7, roof: PALETTE.brand, ry: 0.3 });
  house(group, c.x + 3.2, c.z - 3.4, { w: 1.6, d: 1.5, h: 1.1, roof: PALETTE.roof, ry: -0.4 });
  // Outdoor desk with a laptop showing a diff: where every PR starts.
  const desk = new THREE.Group();
  desk.position.set(c.x - 0.6, TOP, c.z + 2.6);
  desk.rotation.y = -0.5;
  desk.add(mesh(box(2.2, 0.12, 1.1, 0.04), clay(PALETTE.wood), { y: 0.8 }));
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) desk.add(mesh(box(0.1, 0.8, 0.1, 0.03), clay(PALETTE.wood), { x: sx * 0.95, y: 0.4, z: sz * 0.42 }));
  desk.add(mesh(box(1.0, 0.05, 0.7, 0.02), clay(PALETTE.dark), { y: 0.89 }));
  const screen = new THREE.Group();
  screen.position.set(0, 0.9, -0.33);
  screen.rotation.x = -0.25;
  screen.add(mesh(box(1.0, 0.68, 0.05, 0.02), clay(PALETTE.dark), { y: 0.34 }));
  // Diff lines: green added, red removed.
  const lineColors = ['#9aa4b1', '#4fb286', '#4fb286', '#e0685f', '#9aa4b1', '#4fb286'];
  lineColors.forEach((col, k) => screen.add(mesh(box(0.25 + ((k * 37) % 50) / 100, 0.045, 0.01, 0.01), glow(col, 0.8), { x: -0.05, y: 0.56 - k * 0.08, z: 0.03, shadow: false })));
  desk.add(screen);
  desk.add(mesh(new THREE.CylinderGeometry(0.1, 0.08, 0.2, 10), clay(PALETTE.white), { x: 0.75, y: 0.96, z: 0.15 }));
  group.add(desk);
  // A launch pad on the road where the PR waits.
  group.add(mesh(new THREE.CylinderGeometry(1.0, 1.05, 0.12, 20), clay(PALETTE.white), { x: ROAD_POINTS[1].x, y: TOP + 0.06, z: ROAD_POINTS[1].z }));
  group.add(mesh(new THREE.TorusGeometry(0.85, 0.05, 6, 28), glow(PALETTE.brand, 0.7), { x: ROAD_POINTS[1].x, y: TOP + 0.14, z: ROAD_POINTS[1].z, rx: Math.PI / 2, shadow: false }));
  // A little dock with a boat.
  group.add(mesh(box(2.4, 0.15, 0.9, 0.04), clay(PALETTE.wood), { x: c.x - 6.6, y: 0.2, z: c.z + 2.2, ry: 0.3 }));
  const boat = mesh(box(1.4, 0.35, 0.6, 0.15), clay(PALETTE.white), { x: c.x - 7.3, y: 0.05, z: c.z + 3.4, ry: 0.4 });
  group.add(boat);
  scatterTrees(group, c, ISLANDS[0].r, 9, 101, [[c.x - 2.6, c.z - 2.4, 2.4], [c.x + 3.2, c.z - 3.4, 1.4], [c.x - 0.6, c.z + 2.6, 1.8], [ROAD_POINTS[1].x, ROAD_POINTS[1].z, 1.6]]);
  void studio;
  return {
    focus: v3(c.x - 0.4, TOP + 1.1, c.z + 1.6),
    update(T) { boat.position.y = 0.05 + Math.sin(T * 1.6) * 0.04; boat.rotation.z = Math.sin(T * 1.3) * 0.04; },
  };
}

function buildSecurity(group) {
  const c = ISLANDS[1].c;
  island(group, c, ISLANDS[1].r, 22);
  const p = ROAD_POINTS[4];
  const dir = road.getTangentAt(STOPS[1]);
  const ry = Math.atan2(dir.x, dir.z);
  // A castle gate the road runs through, with a padlock over the arch.
  const gate = new THREE.Group();
  gate.position.set(p.x, TOP, p.z);
  gate.rotation.y = ry;
  for (const sx of [-1, 1]) {
    gate.add(mesh(box(1.1, 2.8, 1.1, 0.1), clay(PALETTE.stone), { x: sx * 1.45, y: 1.4 }));
    for (const k of [-1, 1]) gate.add(mesh(box(0.32, 0.36, 0.32, 0.05), clay(PALETTE.stone), { x: sx * 1.45 + k * 0.36, y: 2.95, z: 0.36 }));
    for (const k of [-1, 1]) gate.add(mesh(box(0.32, 0.36, 0.32, 0.05), clay(PALETTE.stone), { x: sx * 1.45 + k * 0.36, y: 2.95, z: -0.36 }));
  }
  gate.add(mesh(box(4.0, 0.6, 1.0, 0.1), clay(PALETTE.stone), { y: 2.5 }));
  // The scanner: a light bar under the arch that sweeps down over the PR.
  const beam = mesh(box(1.7, 0.06, 0.9, 0.03), glow(PALETTE.security, 1.2), { y: 2.1, shadow: false });
  beam.material.transparent = true;
  beam.material.opacity = 0.85;
  gate.add(beam);
  const lockBody = mesh(box(0.9, 0.75, 0.3, 0.12), clay(PALETTE.security), { y: 3.35, z: 0.55 });
  const shackle = mesh(new THREE.TorusGeometry(0.28, 0.08, 8, 16, Math.PI), clay(PALETTE.stone), { y: 3.75, z: 0.55 });
  gate.add(lockBody, shackle);
  const keyhole = mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.05, 10), clay(PALETTE.dark), { y: 3.38, z: 0.72, rx: Math.PI / 2, shadow: false });
  gate.add(keyhole);
  group.add(gate);
  // Walls around the gate and a watch tower.
  for (const sx of [-1, 1]) {
    const wall = mesh(box(3.2, 1.2, 0.5, 0.08), clay(PALETTE.stone), { x: 0, y: TOP + 0.6, z: 0 });
    wall.position.copy(new THREE.Vector3(sx * 3.4, 0, 0).applyAxisAngle(v3(0, 1, 0), ry).add(v3(p.x, TOP + 0.6, p.z)));
    wall.rotation.y = ry;
    group.add(wall);
  }
  const tower = new THREE.Group();
  tower.position.set(c.x - 3.6, TOP, c.z - 2.6);
  tower.add(mesh(new THREE.CylinderGeometry(0.75, 0.85, 3.2, 8), clay(PALETTE.stone), { y: 1.6 }));
  tower.add(mesh(new THREE.ConeGeometry(1.0, 1.1, 8), clay(PALETTE.security), { y: 3.75 }));
  group.add(tower);
  const shield = new THREE.Group();
  shield.position.set(c.x - 3.4, TOP, c.z + 2.4);
  shield.add(mesh(box(1.3, 1.5, 0.25, 0.3), clay(PALETTE.white), { y: 1.3 }));
  shield.add(mesh(box(0.9, 1.1, 0.12, 0.22), clay(PALETTE.security), { y: 1.3, z: 0.1 }));
  shield.add(mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.6, 6), clay(PALETTE.dark), { y: 0.3 }));
  group.add(shield);
  const light = lamp(group, p.x + 2.2, p.z + 1.8, PALETTE.security);
  scatterTrees(group, c, ISLANDS[1].r, 7, 202, [[p.x, p.z, 4.2], [c.x - 3.6, c.z - 2.6, 1.4], [c.x - 3.4, c.z + 2.4, 1.3]]);
  return {
    focus: v3(p.x, TOP + 1.6, p.z),
    update(T, local) {
      // During the dive the beam sweeps down twice, then everything turns green-lit (passed).
      const sweep = local < 0 ? 0 : (local * 2) % 1;
      beam.position.y = 2.1 - smooth(sweep) * 1.85;
      const passed = local > 0.82;
      beam.material.color.set(passed ? PALETTE.tests : PALETTE.security);
      beam.material.emissive.set(passed ? PALETTE.tests : PALETTE.security);
      light.material.emissiveIntensity = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(T * 6));
      shackle.position.y = 3.75 + (passed ? 0.18 * smooth((local - 0.82) / 0.1) : 0);
    },
  };
}

function buildTests(group) {
  const c = ISLANDS[2].c;
  island(group, c, ISLANDS[2].r, 33);
  // The lab, with beakers on the roof terrace.
  const lab = house(group, c.x + 0.6, c.z - 3.4, { w: 3.6, d: 2.2, h: 1.6, roof: PALETTE.tests, ry: -0.1 });
  void lab;
  const bubbles = [];
  const beakers = new THREE.Group();
  beakers.position.set(c.x - 3.4, TOP, c.z - 1.6);
  ['#7fd3a8', '#9ec8ff', '#ffd68a'].forEach((col, k) => {
    beakers.add(mesh(new THREE.CylinderGeometry(0.35, 0.42, 1.0, 10), new THREE.MeshStandardMaterial({ color: '#e8f4ff', transparent: true, opacity: 0.55, roughness: 0.2 }), { x: k * 0.95, y: 0.5 }));
    beakers.add(mesh(new THREE.CylinderGeometry(0.33, 0.4, 0.55, 10), clay(col), { x: k * 0.95, y: 0.3 }));
    for (let b = 0; b < 3; b++) {
      const bubble = mesh(new THREE.SphereGeometry(0.07, 8, 6), clay(PALETTE.white), { x: k * 0.95 + (b - 1) * 0.1, y: 0.6, shadow: false });
      bubble.userData = { k, b };
      beakers.add(bubble);
      bubbles.push(bubble);
    }
  });
  group.add(beakers);
  // Three test gates along the road; each lamp turns green as the PR passes.
  const lamps = [];
  for (let k = 0; k < 3; k++) {
    const u = STOPS[2] - 0.012 + k * 0.012;
    const p = road.getPointAt(u);
    const t = road.getTangentAt(u);
    const side = v3(t.z, 0, -t.x).normalize();
    const g = new THREE.Group();
    g.position.copy(p).setY(TOP);
    g.rotation.y = Math.atan2(t.x, t.z);
    for (const sx of [-1, 1]) g.add(mesh(box(0.2, 1.7, 0.2, 0.06), clay(PALETTE.white), { x: sx * 0.95, y: 0.85 }));
    g.add(mesh(box(2.1, 0.22, 0.24, 0.08), clay(PALETTE.white), { y: 1.72 }));
    const bulb = mesh(new THREE.SphereGeometry(0.2, 12, 8), glow('#c7ccd3', 0.1), { y: 2.02, shadow: false });
    g.add(bulb);
    lamps.push(bulb);
    group.add(g);
    void side;
  }
  // A big tick sign on the hill.
  const sign = tick(PALETTE.tests);
  sign.position.set(c.x + 3.6, TOP + 1.3, c.z + 2.4);
  sign.scale.setScalar(1.5);
  sign.rotation.y = -0.6;
  group.add(sign);
  scatterTrees(group, c, ISLANDS[2].r, 8, 303, [[c.x + 0.6, c.z - 3.4, 2.6], [c.x - 2.5, c.z - 1.6, 2.0], [c.x + 3.6, c.z + 2.4, 1.3]]);
  const green = new THREE.Color(PALETTE.tests);
  const grey = new THREE.Color('#c7ccd3');
  return {
    focus: v3(c.x, TOP + 1.2, c.z + 0.6),
    update(T, local) {
      lamps.forEach((bulb, k) => {
        const on = smooth((local - (0.25 + k * 0.2)) / 0.08);
        bulb.material.color.copy(grey).lerp(green, on);
        bulb.material.emissive.copy(grey).lerp(green, on);
        bulb.material.emissiveIntensity = 0.1 + on * 1.1;
      });
      for (const bubble of bubbles) {
        const { k, b } = bubble.userData;
        const phase = (T * 0.6 + b / 3 + k * 0.17) % 1;
        bubble.position.y = 0.6 + phase * 0.7;
        bubble.scale.setScalar(phase < 0.9 ? 1 : 1 - (phase - 0.9) * 10);
      }
      sign.rotation.y = -0.6 + Math.sin(T * 0.8) * 0.15;
    },
  };
}

function buildBreaking(group) {
  // Two islets joined by a long bridge; a barrier on the bridge flags the breaking change.
  EXTRA_ISLETS.forEach((isl, k) => island(group, isl.c, isl.r, 44 + k));
  tree(group, EXTRA_ISLETS[0].c.x - 1.2, EXTRA_ISLETS[0].c.z + 1.0, rng(7));
  tree(group, EXTRA_ISLETS[0].c.x - 0.4, EXTRA_ISLETS[0].c.z - 1.6, rng(8));
  tree(group, EXTRA_ISLETS[1].c.x + 1.4, EXTRA_ISLETS[1].c.z - 1.0, rng(9));
  house(group, EXTRA_ISLETS[1].c.x + 0.6, EXTRA_ISLETS[1].c.z + 1.6, { w: 1.4, d: 1.3, h: 1.0, roof: PALETTE.breaking, ry: 0.5 });
  const p = ROAD_POINTS[10];
  const t = road.getTangentAt(STOPS[3]);
  const ry = Math.atan2(t.x, t.z);
  const barrier = new THREE.Group();
  barrier.position.set(p.x, ROAD_Y, p.z);
  barrier.rotation.y = ry;
  barrier.add(mesh(box(0.35, 1.2, 0.35, 0.08), clay(PALETTE.dark), { x: 1.15, y: 0.6 }));
  const arm = new THREE.Group();
  arm.position.set(1.15, 1.05, 0);
  for (let k = 0; k < 5; k++) arm.add(mesh(box(0.46, 0.18, 0.12, 0.04), clay(k % 2 ? PALETTE.white : PALETTE.breaking), { x: -0.25 - k * 0.46 }));
  barrier.add(arm);
  const warn = mesh(new THREE.SphereGeometry(0.17, 12, 8), glow(PALETTE.breaking, 1), { x: 1.15, y: 1.38, shadow: false });
  barrier.add(warn);
  // Cones and a cracked plank just past the barrier.
  for (const [cx, cz] of [[-1.4, 0.9], [-1.0, 1.4], [1.6, -1.2]]) {
    barrier.add(mesh(new THREE.ConeGeometry(0.2, 0.5, 8), clay(PALETTE.breaking), { x: cx * 0.6, y: 0.25, z: cz }));
  }
  const plank = mesh(box(1.5, 0.08, 0.5, 0.03), clay(PALETTE.wood), { x: 0, y: 0.07, z: -1.1, rx: 0.18, rz: 0.06 });
  barrier.add(plank);
  group.add(barrier);
  // A warning sign on the far islet.
  const sign = new THREE.Group();
  sign.position.set(EXTRA_ISLETS[0].c.x + 1.0, TOP, EXTRA_ISLETS[0].c.z + 1.4);
  sign.add(mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.2, 6), clay(PALETTE.dark), { y: 0.6 }));
  const tri = new THREE.CylinderGeometry(0.6, 0.6, 0.1, 3);
  sign.add(mesh(tri, clay(PALETTE.breaking), { y: 1.5, rx: Math.PI / 2, rz: Math.PI / 2 }));
  group.add(sign);
  return {
    focus: v3(p.x, ROAD_Y + 0.8, p.z),
    update(T, local) {
      // The arm drops as the PR arrives, then lifts once the change is understood.
      const down = smooth((local - 0.1) / 0.2) * (1 - smooth((local - 0.78) / 0.15));
      arm.rotation.z = lerp(1.25, 0, down);
      warn.material.emissiveIntensity = 0.3 + 0.9 * (Math.sin(T * 7) > 0 ? 1 : 0.15);
    },
  };
}

function buildDocs(group) {
  const c = ISLANDS[4].c;
  island(group, c, ISLANDS[4].r, 55);
  // A tower of stacked books.
  const tower = new THREE.Group();
  tower.position.set(c.x - 3.0, TOP, c.z - 2.4);
  const bookColors = [PALETTE.docs, '#e9b44c', PALETTE.security, '#5fb3a1', PALETTE.white, PALETTE.docs];
  bookColors.forEach((col, k) => {
    tower.add(mesh(box(2.0 - (k % 2) * 0.25, 0.42, 1.4 - (k % 3) * 0.1, 0.06), clay(col), { y: 0.21 + k * 0.43, ry: (k * 0.37) % 0.5 - 0.25 }));
    tower.add(mesh(box(1.86 - (k % 2) * 0.25, 0.32, 1.42 - (k % 3) * 0.1, 0.04), clay(PALETTE.white), { x: 0.08, y: 0.21 + k * 0.43, ry: (k * 0.37) % 0.5 - 0.25 }));
  });
  tower.add(mesh(new THREE.ConeGeometry(0.9, 1.0, 4), clay(PALETTE.docs), { y: 3.1, ry: Math.PI / 4 }));
  group.add(tower);
  // An open book on a stand, with turning pages.
  const stand = new THREE.Group();
  const p = ROAD_POINTS[13];
  stand.position.set(p.x + 1.9, TOP, p.z + 1.2);
  stand.rotation.y = -0.5;
  stand.add(mesh(box(0.25, 1.0, 0.25, 0.06), clay(PALETTE.wood), { y: 0.5 }));
  stand.add(mesh(box(2.4, 0.12, 1.4, 0.04), clay(PALETTE.docs), { y: 1.05, rx: -0.35 }));
  const pagesBase = new THREE.Group();
  pagesBase.position.set(0, 1.14, 0);
  pagesBase.rotation.x = -0.35;
  for (const sx of [-1, 1]) pagesBase.add(mesh(box(1.1, 0.06, 1.25, 0.03), clay(PALETTE.white), { x: sx * 0.58 }));
  const pages = [];
  for (let k = 0; k < 3; k++) {
    const pivot = new THREE.Group();
    pivot.position.y = 0.05 + k * 0.01;
    const page = mesh(new THREE.PlaneGeometry(1.08, 1.2), clay('#fffdf8', { side: THREE.DoubleSide }), { x: 0.56, rx: -Math.PI / 2, shadow: false });
    pivot.add(page);
    pagesBase.add(pivot);
    pages.push(pivot);
  }
  stand.add(pagesBase);
  group.add(stand);
  // Signposts at the fork.
  const post = new THREE.Group();
  post.position.set(p.x - 1.8, TOP, p.z + 1.6);
  post.add(mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.9, 6), clay(PALETTE.wood), { y: 0.95 }));
  [[0.3, 1.6, PALETTE.docs], [-0.5, 1.2, PALETTE.white], [0.9, 0.85, '#e9b44c']].forEach(([r, y, col]) => post.add(mesh(box(1.1, 0.26, 0.08, 0.05), clay(col), { y, x: 0.35, ry: r })));
  group.add(post);
  scatterTrees(group, c, ISLANDS[4].r, 8, 505, [[c.x - 3.0, c.z - 2.4, 1.9], [p.x + 1.9, p.z + 1.2, 1.6], [p.x - 1.8, p.z + 1.6, 1.0]]);
  return {
    focus: v3(p.x + 1.0, TOP + 1.1, p.z + 0.8),
    update(T, local) {
      pages.forEach((pivot, k) => {
        const turn = smoother((local * 1.4 - 0.15 - k * 0.22) / 0.3);
        pivot.rotation.z = turn * Math.PI * 0.98;
      });
    },
  };
}

function gear(radius, teeth, color) {
  const g = new THREE.Group();
  const m = clay(color);
  g.add(mesh(new THREE.CylinderGeometry(radius, radius, 0.3, Math.max(12, teeth * 2)), m, { rx: Math.PI / 2 }));
  for (let k = 0; k < teeth; k++) {
    const a = (k / teeth) * Math.PI * 2;
    g.add(mesh(box(0.34, 0.3, 0.3, 0.05), m, { x: Math.cos(a) * (radius + 0.12), y: Math.sin(a) * (radius + 0.12), rz: a }));
  }
  g.add(mesh(new THREE.CylinderGeometry(radius * 0.3, radius * 0.3, 0.36, 10), clay(PALETTE.white), { rx: Math.PI / 2 }));
  return g;
}

function buildPerformance(group) {
  const c = ISLANDS[5].c;
  island(group, c, ISLANDS[5].r, 66);
  // A clock tower with moving hands.
  const tower = new THREE.Group();
  tower.position.set(c.x + 2.6, TOP, c.z - 2.4);
  tower.add(mesh(box(1.6, 4.2, 1.6, 0.12), clay(PALETTE.wall), { y: 2.1 }));
  tower.add(mesh(new THREE.ConeGeometry(1.35, 1.3, 4), clay(PALETTE.performance), { y: 4.85, ry: Math.PI / 4 }));
  tower.add(mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.08, 24), clay(PALETTE.white), { y: 3.3, z: 0.82, rx: Math.PI / 2 }));
  const hour = mesh(box(0.08, 0.36, 0.04, 0.02), clay(PALETTE.dark), { shadow: false });
  const minute = mesh(box(0.06, 0.52, 0.04, 0.02), clay(PALETTE.dark), { shadow: false });
  const hourPivot = new THREE.Group(); hourPivot.position.set(0, 3.3, 0.88); hour.position.y = 0.14; hourPivot.add(hour);
  const minutePivot = new THREE.Group(); minutePivot.position.set(0, 3.3, 0.9); minute.position.y = 0.22; minutePivot.add(minute);
  tower.add(hourPivot, minutePivot);
  group.add(tower);
  // Two big meshing gears by the road.
  const p = ROAD_POINTS[16];
  const gearA = gear(0.95, 10, PALETTE.performance);
  const gearB = gear(0.62, 7, '#e9b44c');
  const holder = new THREE.Group();
  holder.position.set(p.x - 1.0, TOP, p.z - 2.0);
  holder.rotation.y = 0.35;
  gearA.position.set(0, 1.5, 0);
  gearB.position.set(1.72, 1.18, 0);
  holder.add(gearA, gearB);
  holder.add(mesh(box(3.2, 0.3, 0.8, 0.08), clay(PALETTE.stone), { x: 0.7, y: 0.15 }));
  for (const gx of [0, 1.72]) holder.add(mesh(box(0.2, gx ? 1.1 : 1.4, 0.2, 0.05), clay(PALETTE.stone), { x: gx, y: gx ? 0.6 : 0.75, z: -0.25 }));
  group.add(holder);
  // A small race track with a cart doing laps.
  const track = new THREE.Group();
  track.position.set(c.x - 2.4, TOP + 0.02, c.z + 2.4);
  const ring = mesh(new THREE.TorusGeometry(1.5, 0.28, 4, 32), clay(PALETTE.dark), { rx: Math.PI / 2, s: [1.3, 1, 1] });
  ring.scale.set(1.3, 1, 0.12);
  track.add(ring);
  const cart = new THREE.Group();
  cart.add(mesh(box(0.55, 0.22, 0.32, 0.08), clay(PALETTE.security)));
  cart.add(mesh(box(0.22, 0.16, 0.26, 0.06), clay(PALETTE.white), { x: -0.06, y: 0.16 }));
  track.add(cart);
  group.add(track);
  scatterTrees(group, c, ISLANDS[5].r, 7, 606, [[c.x + 2.6, c.z - 2.4, 1.8], [p.x - 0.4, p.z - 2.0, 2.2], [c.x - 2.4, c.z + 2.4, 2.4]]);
  return {
    focus: v3(p.x - 0.2, TOP + 1.3, p.z - 1.0),
    update(T) {
      gearA.rotation.z = T * 0.9;
      gearB.rotation.z = -T * 0.9 * (10 / 7) + 0.2;
      minutePivot.rotation.z = -T * 1.2;
      hourPivot.rotation.z = -T * 0.1;
      const a = T * 1.6;
      cart.position.set(Math.cos(a) * 1.95, 0.12, Math.sin(a) * 1.5);
      cart.rotation.y = -a - Math.PI / 2;
    },
  };
}

function buildChecklist(group) {
  const c = ISLANDS[6].c;
  island(group, c, ISLANDS[6].r, 77);
  // The giant clipboard the PR arrives at; a tick pops into each row in turn.
  const board = new THREE.Group();
  board.position.set(c.x + 1.2, TOP, c.z - 1.6);
  board.rotation.y = -0.45;
  board.add(mesh(box(3.6, 4.6, 0.3, 0.2), clay(PALETTE.wood), { y: 2.7 }));
  board.add(mesh(box(3.2, 4.0, 0.06, 0.06), clay(PALETTE.white), { y: 2.6, z: 0.17 }));
  board.add(mesh(box(1.4, 0.45, 0.4, 0.14), clay(PALETTE.stone), { y: 4.95, z: 0.1 }));
  board.add(mesh(box(0.25, 0.7, 0.25, 0.06), clay(PALETTE.wood), { x: -1.0, y: 0.35, z: -0.6 }));
  board.add(mesh(box(0.25, 0.7, 0.25, 0.06), clay(PALETTE.wood), { x: 1.0, y: 0.35, z: -0.6 }));
  const rowColors = [PALETTE.security, PALETTE.tests, PALETTE.breaking, PALETTE.docs, PALETTE.performance];
  const ticks = [];
  rowColors.forEach((col, k) => {
    const y = 3.95 - k * 0.68;
    board.add(mesh(box(0.42, 0.42, 0.08, 0.06), clay('#e9e4dc'), { x: -1.1, y, z: 0.22 }));
    board.add(mesh(box(1.7 - (k % 2) * 0.35, 0.14, 0.04, 0.04), clay('#d9d2c7'), { x: 0.15 - (k % 2) * 0.17, y, z: 0.21 }));
    const t = tick(col);
    t.position.set(-1.08, y + 0.05, 0.35);
    t.scale.setScalar(0.001);
    board.add(t);
    ticks.push(t);
  });
  group.add(board);
  const flags = [];
  [[-4.6, -2.8, PALETTE.security], [-3.2, -4.6, PALETTE.tests], [4.8, 1.6, PALETTE.docs], [3.6, 3.8, PALETTE.performance], [-4.4, 2.6, PALETTE.breaking]]
    .forEach(([dx, dz, col]) => flags.push(flag(group, c.x + dx, c.z + dz, col)));
  // A fountain of confetti-coloured stars around the dock where the PR lands.
  const dock = mesh(new THREE.CylinderGeometry(1.2, 1.25, 0.14, 24), clay(PALETTE.white), { x: ROAD_POINTS[19].x, y: TOP + 0.07, z: ROAD_POINTS[19].z });
  group.add(dock);
  const ringGlow = mesh(new THREE.TorusGeometry(1.0, 0.06, 6, 30), glow(PALETTE.tests, 0.9), { x: dock.position.x, y: TOP + 0.16, z: dock.position.z, rx: Math.PI / 2, shadow: false });
  group.add(ringGlow);
  scatterTrees(group, c, ISLANDS[6].r, 7, 707, [[c.x + 1.2, c.z - 1.6, 2.8], [dock.position.x, dock.position.z, 1.8]]);
  return {
    faces: board,
    focus: v3(c.x + 0.6, TOP + 2.3, c.z - 0.6),
    update(T, local) {
      ticks.forEach((t, k) => {
        const pop = clamp((local - 0.18 - k * 0.12) / 0.1);
        const s = pop <= 0 ? 0.001 : pop < 1 ? 1.25 * Math.sin(pop * Math.PI * 0.75) / Math.sin(Math.PI * 0.75) : 1;
        t.scale.setScalar(Math.max(0.001, s * 0.55));
      });
      flags.forEach((cloth, k) => { cloth.rotation.y = Math.sin(T * 2.2 + k) * 0.25; });
      ringGlow.material.emissiveIntensity = 0.5 + 0.5 * Math.sin(T * 3);
    },
  };
}

// The PR itself: a white card with a blue band and a soft glow ring, hovering on the road.
function buildParcel(group) {
  const g = new THREE.Group();
  const card = new THREE.Group();
  card.add(mesh(box(1.0, 0.16, 0.74, 0.07), clay(PALETTE.white)));
  card.add(mesh(box(1.02, 0.06, 0.2, 0.03), glow(PALETTE.brand, 0.6), { y: 0.06, z: -0.2, shadow: false }));
  for (let k = 0; k < 3; k++) card.add(mesh(box(0.5 - k * 0.1, 0.02, 0.05, 0.01), clay('#c9d4e8'), { x: -0.12, y: 0.09, z: 0.02 + k * 0.12, shadow: false }));
  card.position.y = 0.55;
  g.add(card);
  const shadowDisk = mesh(new THREE.CircleGeometry(0.5, 20), new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.12 }), { rx: -Math.PI / 2, y: 0.02, shadow: false });
  g.add(shadowDisk);
  const halo = mesh(new THREE.TorusGeometry(0.62, 0.035, 6, 32), glow(PALETTE.brand, 1.0), { rx: Math.PI / 2, y: 0.12, shadow: false });
  g.add(halo);
  group.add(g);
  return { g, card, halo };
}

// Where along the road the PR is at global time T: parked during each dive,
// travelling during each connector.
function parcelU(T) {
  for (const seg of segments()) {
    if (T < seg.start + seg.seconds || seg === segments().at(-1)) {
      const local = clamp((T - seg.start) / seg.seconds);
      if (seg.kind === 'dive') {
        // Creep forward a little through the stop so it never looks frozen.
        const prev = STOPS[seg.index];
        const drift = 0.006;
        return seg.index === SCENES.length - 1 ? prev : prev - drift + drift * 2 * local;
      }
      // Leave and arrive at the same creeping speed as the stops, so it never jolts.
      const from = STOPS[seg.index] + 0.006;
      const to = STOPS[seg.index + 1] - 0.006;
      const v = (0.012 / DIVE_SECONDS) * seg.seconds;
      const x = local;
      return (2 * x ** 3 - 3 * x ** 2 + 1) * from + (x ** 3 - 2 * x ** 2 + x) * v + (-2 * x ** 3 + 3 * x ** 2) * to + (x ** 3 - x ** 2) * v;
    }
  }
  return STOPS.at(-1);
}

// ---- camera ----------------------------------------------------------------------
function spherical(focus, dist, elev, az) {
  return v3(
    focus.x + dist * Math.cos(elev) * Math.sin(az),
    focus.y + dist * Math.sin(elev),
    focus.z + dist * Math.cos(elev) * Math.cos(az),
  );
}

// The close-up angle for each scene is picked automatically: of the angles near the
// usual one, the first whose view of the focus isn't blocked by a tree or a building.
function clearAngle(focus, near, elev, preferred, blockers) {
  const ray = new THREE.Raycaster();
  let best = preferred;
  let bestHits = Infinity;
  for (let step = 0; step <= 16; step++) {
    const az = preferred + (step % 2 ? 1 : -1) * Math.ceil(step / 2) * 0.16;
    const cam = spherical(focus, near, elev, az);
    let hits = 0;
    for (const dy of [-0.6, 0, 0.6]) {
      for (const side of [-0.7, 0, 0.7]) {
        const offset = v3(Math.cos(az) * side, dy, -Math.sin(az) * side);
        const from = focus.clone().add(offset);
        const dir = cam.clone().sub(from);
        const length = dir.length();
        ray.set(from, dir.normalize());
        ray.near = 1.4;
        ray.far = length;
        if (ray.intersectObjects(blockers, false).length) hits++;
      }
    }
    if (hits < bestHits) { bestHits = hits; best = az; }
    if (hits === 0) break;
  }
  return best;
}

function cameraPoses(focuses, portrait, blockers) {
  const far = portrait ? 46 : 32;
  const near = portrait ? 15 : 10.5;
  const nearElev = 0.42;
  return focuses.map((focus, i) => {
    const centre = ISLANDS[i].c.clone().setY(TOP);
    const az = 0.55 + (i % 2 ? 0.25 : -0.1);
    const lowAz = clearAngle(focus, near, nearElev, az + 0.45, blockers);
    return {
      focus,
      centre,
      high: spherical(centre, far, 0.86, az),
      low: spherical(focus, near, nearElev, lowAz),
    };
  });
}

// The camera follows one smooth path through every scene instead of stopping at each
// clip boundary: key points (high above an island, partway down, the close-up, and the
// hop to the next island) are joined by a centripetal Catmull-Rom curve, and time maps to
// the curve with a monotone cubic, so speed changes gently and never drops to zero
// between clips. The clips are still cut from this one path, so their seams match.
let path = null;
function cameraPath(poses) {
  if (path && path.poses === poses) return path;
  const pos = [];
  const look = [];
  const knots = [];
  const list = segments();
  poses.forEach((p, i) => {
    const dive = list.find((s) => s.kind === 'dive' && s.index === i);
    pos.push(p.high, p.high.clone().lerp(p.low, 0.55).add(v3(0, 2.2, 0)), p.low);
    look.push(p.centre, p.centre.clone().lerp(p.focus, 0.8), p.focus);
    knots.push(dive.start, dive.start + dive.seconds * 0.5, dive.start + dive.seconds);
    const conn = list.find((s) => s.kind === 'conn' && s.index === i);
    if (conn) {
      const b = poses[i + 1];
      pos.push(p.low.clone().lerp(b.high, 0.5).setY(Math.max(p.low.y, b.high.y) + 4));
      look.push(p.focus.clone().lerp(b.centre, 0.5));
      knots.push(conn.start + conn.seconds * 0.5);
    }
  });
  path = {
    poses,
    pos: new THREE.CatmullRomCurve3(pos, false, 'centripetal'),
    look: new THREE.CatmullRomCurve3(look, false, 'centripetal'),
    knots,
    slopes: monotoneSlopes(knots),
  };
  return path;
}

// Fritsch-Carlson slopes for the time -> key point index curve (index k at knots[k]).
function monotoneSlopes(t) {
  const n = t.length;
  const d = [];
  for (let k = 0; k < n - 1; k++) d.push(1 / (t[k + 1] - t[k]));
  const m = [d[0]];
  for (let k = 1; k < n - 1; k++) m.push((2 * d[k - 1] * d[k]) / (d[k - 1] + d[k]));
  m.push(d[n - 2]);
  // Ease in at the very start and out at the very end of the whole flight.
  m[0] = 0;
  m[n - 1] = 0;
  return m;
}

function pathIndex(T, { knots, slopes }) {
  const n = knots.length;
  if (T <= knots[0]) return 0;
  if (T >= knots[n - 1]) return n - 1;
  let k = 0;
  while (T > knots[k + 1]) k++;
  const h = knots[k + 1] - knots[k];
  const x = (T - knots[k]) / h;
  const h00 = 2 * x ** 3 - 3 * x ** 2 + 1, h10 = x ** 3 - 2 * x ** 2 + x;
  const h01 = -2 * x ** 3 + 3 * x ** 2, h11 = x ** 3 - x ** 2;
  return h00 * k + h10 * h * slopes[k] + h01 * (k + 1) + h11 * h * slopes[k + 1];
}

/** Camera position and look target at global time T. */
function cameraAt(T, poses) {
  const conn = segments().find((s) => s.kind === 'conn' && T > s.start && T < s.start + s.seconds);
  return conn ? bridgeAt(T, conn, poses) : pathAt(T, poses);
}

function pathAt(T, poses) {
  const p = cameraPath(poses);
  const u = pathIndex(T, p) / (p.knots.length - 1);
  return { pos: p.pos.getPoint(u), target: p.look.getPoint(u) };
}

// Between two islands the camera flies its own arc, joined to the dives on either side
// with the same position, speed and direction, so it never jolts at a clip seam.
const bridges = new Map();
function bridgeAt(T, seg, poses) {
  let b = bridges.get(seg.index);
  if (!b || b.poses !== poses) {
    const a = seg.start;
    const z = seg.start + seg.seconds;
    const h = 1e-3;
    const D = seg.seconds;
    const A = pathAt(a, poses), A0 = pathAt(a - h, poses);
    const Z = pathAt(z, poses), Z1 = pathAt(z + h, poses);
    const vA = A.pos.clone().sub(A0.pos).divideScalar(h);
    const vZ = Z1.pos.clone().sub(Z.pos).divideScalar(h);
    const top = Math.max(A.pos.y, Z.pos.y) + 2;
    const ctrl = [
      A.pos,
      A.pos.clone().addScaledVector(vA, D / 5),
      A.pos.clone().lerp(Z.pos, 0.4).setY(top),
      A.pos.clone().lerp(Z.pos, 0.6).setY(top),
      Z.pos.clone().addScaledVector(vZ, -D / 5),
      Z.pos,
    ];
    const tA = A.target.clone().sub(A0.target).divideScalar(h).multiplyScalar(D);
    const tZ = Z1.target.clone().sub(Z.target).divideScalar(h).multiplyScalar(D);
    b = { poses, ctrl, look: [A.target, tA, Z.target, tZ] };
    bridges.set(seg.index, b);
  }
  const x = (T - seg.start) / seg.seconds;
  return { pos: bezier5(b.ctrl, x), target: hermite(...b.look, x) };
}

function bezier5(p, t) {
  const u = 1 - t;
  const w = [u ** 5, 5 * u ** 4 * t, 10 * u ** 3 * t ** 2, 10 * u ** 2 * t ** 3, 5 * u * t ** 4, t ** 5];
  const out = v3(0, 0, 0);
  p.forEach((q, k) => out.addScaledVector(q, w[k]));
  return out;
}

function hermite(p0, m0, p1, m1, x) {
  const x2 = x * x, x3 = x2 * x;
  return p0.clone().multiplyScalar(2 * x3 - 3 * x2 + 1).addScaledVector(m0, x3 - 2 * x2 + x)
    .addScaledVector(p1, -2 * x3 + 3 * x2).addScaledVector(m1, x3 - x2);
}

// ---- clouds and water ---------------------------------------------------------
function buildClouds(group) {
  const random = rng(909);
  const clouds = [];
  for (let k = 0; k < 16; k++) {
    const cloud = new THREE.Group();
    const parts = 3 + Math.floor(random() * 3);
    for (let j = 0; j < parts; j++) {
      cloud.add(mesh(new THREE.IcosahedronGeometry(0.9 + random() * 0.9, 1), clay('#ffffff', { roughness: 1 }), { x: j * 1.1 - parts * 0.5, y: random() * 0.5, z: random() * 0.8, shadow: false }));
    }
    cloud.position.set(-10 + k * 7.5 + random() * 4, 11 + random() * 6, -16 + random() * 30);
    cloud.userData.speed = 0.15 + random() * 0.2;
    cloud.userData.x = cloud.position.x;
    clouds.push(cloud);
    group.add(cloud);
  }
  // While flying between islands, a cloud close to the camera fades out instead of
  // filling the screen. The fade is zero at each clip seam, so the seams still match.
  return (T, eye) => {
    const seg = segments().find((s) => s.kind === 'conn' && T > s.start && T < s.start + s.seconds);
    const away = seg ? Math.sin(Math.PI * (T - seg.start) / seg.seconds) : 0;
    clouds.forEach((cl) => {
      cl.position.x = cl.userData.x + T * cl.userData.speed;
      const near = clamp((cl.position.distanceTo(eye) - 6) / 10);
      const opacity = 1 - away * (1 - near);
      cl.visible = opacity > 0.02;
      cl.traverse((o) => { if (o.material) { o.material.opacity = opacity; o.material.transparent = opacity < 1; } });
    });
  };
}

function buildRoad(group) {
  // A flat ribbon along the road curve; on water it becomes a bridge on posts.
  const samples = 900;
  const positions = [];
  const indices = [];
  const width = 1.15;
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    const p = road.getPointAt(u);
    const t = road.getTangentAt(u);
    const side = v3(t.z, 0, -t.x).normalize().multiplyScalar(width / 2);
    positions.push(p.x + side.x, p.y, p.z + side.z, p.x - side.x, p.y, p.z - side.z);
    if (i < samples) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const ribbon = new THREE.Mesh(geo, clay(PALETTE.road, { side: THREE.DoubleSide }));
  ribbon.receiveShadow = true;
  group.add(ribbon);
  // Bridge sides and posts wherever the road is over water.
  for (let i = 0; i <= 240; i++) {
    const u = i / 240;
    const p = road.getPointAt(u);
    if (onAnyIsland(p.x, p.z)) continue;
    const t = road.getTangentAt(u);
    const side = v3(t.z, 0, -t.x).normalize();
    const ry = Math.atan2(t.x, t.z);
    group.add(mesh(box(1.25, 0.18, 0.42, 0.04), clay(PALETTE.wood), { x: p.x, y: p.y - 0.1, z: p.z, ry: ry + Math.PI / 2 }));
    if (i % 3 === 0) {
      for (const s of [-1, 1]) {
        group.add(mesh(new THREE.CylinderGeometry(0.07, 0.09, 1.3, 6), clay(PALETTE.wood), { x: p.x + side.x * 0.62 * s, y: p.y - 0.35, z: p.z + side.z * 0.62 * s }));
      }
    }
  }
}

// ---- the whole world ------------------------------------------------------------------
export function createWorld(canvas, { width, height, portrait = false, pixelRatio = 1 }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  // A sky dome that fades from blue overhead to a warm haze at the horizon; the fog
  // uses the haze colour, so far islands melt into it.
  scene.background = new THREE.Color(PALETTE.sky);
  scene.fog = new THREE.Fog(PALETTE.sky, portrait ? 70 : 55, portrait ? 170 : 140);
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(PALETTE.skyTop) }, horizon: { value: new THREE.Color(PALETTE.sky) } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 horizon; varying vec3 vDir; void main() { float h = smoothstep(-0.05, 0.55, vDir.y); gl_FragColor = vec4(mix(horizon, top, h), 1.0); }',
  }));
  scene.add(skyDome);

  const camera = new THREE.PerspectiveCamera(portrait ? 40 : 30, width / height, 0.5, 400);

  scene.add(new THREE.HemisphereLight('#fff6ea', '#b4a690', 1.5));
  const sun = new THREE.DirectionalLight('#ffe4c4', 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -22; sun.shadow.camera.right = 22;
  sun.shadow.camera.top = 22; sun.shadow.camera.bottom = -22;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 90;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 4;
  scene.add(sun, sun.target);

  const world = new THREE.Group();
  scene.add(world);
  const water = mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshStandardMaterial({ color: PALETTE.water, roughness: 0.35, metalness: 0.05 }), { rx: -Math.PI / 2, x: 45, y: -0.15, shadow: false });
  world.add(water);
  // Soft ripples: rings around each island.
  const ripples = [];
  for (const isl of [...ISLANDS.filter((i) => i.r > 0), ...EXTRA_ISLETS]) {
    const ring = mesh(new THREE.RingGeometry(isl.r + 0.4, isl.r + 0.75, 48), new THREE.MeshBasicMaterial({ color: '#e9fbff', transparent: true, opacity: 0.5 }), { rx: -Math.PI / 2, x: isl.c.x, y: -0.12, z: isl.c.z, shadow: false });
    ripples.push({ ring, r: isl.r });
    world.add(ring);
  }

  buildRoad(world);
  const builders = [buildStart, buildSecurity, buildTests, buildBreaking, buildDocs, buildPerformance, buildChecklist];
  const scenes = builders.map((build) => build(world));
  const moveClouds = buildClouds(world);
  const parcel = buildParcel(world);
  world.updateMatrixWorld(true);
  const blockers = [];
  world.traverse((o) => { if (o.isMesh && o.castShadow && o.geometry.type !== 'PlaneGeometry') blockers.push(o); });
  const poses = cameraPoses(scenes.map((s) => s.focus), portrait, blockers);
  // Signs that should face the close-up camera turn toward it.
  scenes.forEach((s, i) => {
    if (!s.faces) return;
    const cam = poses[i].low;
    s.faces.rotation.y = Math.atan2(cam.x - s.faces.position.x, cam.z - s.faces.position.z) - 0.25;
  });

  // Post: multisampled render, then tone mapping. (No blur, so every frame stays sharp.)
  const target = new THREE.WebGLRenderTarget(width * pixelRatio, height * pixelRatio, { samples: 4, type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(width, height);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass());

  // Shift the picture so the scene sits beside the page's text, not under it.
  if (portrait) camera.setViewOffset(width, height, 0, height * 0.1, width, height);
  else camera.setViewOffset(width, height, -width * 0.1, 0, width, height);

  function localFor(T, index) {
    const seg = segments().find((s) => s.kind === 'dive' && s.index === index);
    return (T - seg.start) / seg.seconds;
  }

  function renderAt(T) {
    const { pos, target: look } = cameraAt(T, poses);
    camera.position.copy(pos);
    camera.lookAt(look);
    sun.position.copy(look).add(v3(-14, 26, 12));
    sun.target.position.copy(look);
    scenes.forEach((s, i) => s.update(T, localFor(T, i)));
    moveClouds(T, camera.position);
    const u = parcelU(T);
    const p = road.getPointAt(clamp(u));
    const tan = road.getTangentAt(clamp(u));
    parcel.g.position.copy(p);
    parcel.g.rotation.y = Math.atan2(tan.x, tan.z) + Math.PI / 2;
    parcel.card.position.y = 0.55 + Math.sin(T * 2.4) * 0.06;
    parcel.card.rotation.z = Math.sin(T * 1.7) * 0.05;
    parcel.halo.scale.setScalar(1 + 0.08 * Math.sin(T * 3));
    ripples.forEach(({ ring }, k) => { ring.material.opacity = 0.35 + 0.2 * Math.sin(T * 1.2 + k); });
    composer.render();
  }

  return { renderAt, renderer };
}
