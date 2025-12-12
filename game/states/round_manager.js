import { DIFFICULTY_MOD } from "../config.js";

const EDGE_MARGIN = 60;

function randomEdgePoint(canvas, forcedSide = null) {
  const w = canvas.width;
  const h = canvas.height;
  const side = forcedSide ?? Math.floor(Math.random() * 4);
  switch (side) {
    case 0: return { x: Math.random() * w, y: EDGE_MARGIN }; // top
    case 1: return { x: Math.random() * w, y: h - EDGE_MARGIN }; // bottom
    case 2: return { x: EDGE_MARGIN, y: Math.random() * h }; // left
    default: return { x: w - EDGE_MARGIN, y: Math.random() * h }; // right
  }
}

function spawnEdgeBurst(canvas, typeId, count, options = {}) {
  const { delayStep = 0.3, startDelay = 0, forcedSide = null } = options;
  const spawns = [];
  for (let i = 0; i < count; i++) {
    const side = Array.isArray(forcedSide)
      ? forcedSide[i % forcedSide.length]
      : forcedSide;
    const pos = randomEdgePoint(canvas, side);
    spawns.push({
      typeId,
      x: pos.x,
      y: pos.y,
      delay: startDelay + i * delayStep + Math.random() * 0.15
    });
  }
  return spawns;
}

function spawnAt(typeId, x, y, delay = 0) {
  return [{ typeId, x, y, delay }];
}

const LOW_ROUNDS = [
  (ctx) => {
    const multiplier = 4 * ctx.density;
    return [
      ...spawnEdgeBurst(ctx.canvas, "low_grunt1", Math.round(multiplier)),
      ...spawnEdgeBurst(ctx.canvas, "low_grunt2", Math.round(multiplier * 0.8), { delayStep: 0.25 })
    ];
  },
  (ctx) => {
    const multiplier = 5 * ctx.density;
    return [
      ...spawnEdgeBurst(ctx.canvas, "low_grunt3", Math.round(multiplier), { delayStep: 0.2 }),
      ...spawnEdgeBurst(ctx.canvas, "low_miniboss", 1, { forcedSide: [0, 1], startDelay: 1.2 })
    ];
  },
  (ctx) => {
    const bossX = ctx.canvas.width / 2;
    const bossY = ctx.canvas.height * 0.18;
    return [
      ...spawnEdgeBurst(ctx.canvas, "low_grunt2", Math.max(3, Math.round(3 * ctx.density)), { startDelay: 1.5 }),
      ...spawnAt("low_boss", bossX, bossY, 0)
    ];
  }
];

const MID_ROUNDS = [
  (ctx) => {
    const base = 4 * ctx.density;
    return [
      ...spawnEdgeBurst(ctx.canvas, "mid_grunt_skirmisher", Math.round(base)),
      ...spawnEdgeBurst(ctx.canvas, "mid_grunt_laser", Math.round(base * 0.75), { delayStep: 0.35 })
    ];
  },
  (ctx) => {
    const base = 5.5 * ctx.density;
    return [
      ...spawnEdgeBurst(ctx.canvas, "mid_grunt_skirmisher", Math.round(base), { delayStep: 0.2 }),
      ...spawnEdgeBurst(ctx.canvas, "mid_grunt_laser", Math.round(base * 0.9), { delayStep: 0.32 }),
      ...spawnEdgeBurst(ctx.canvas, "mid_miniboss_dual", 1, { forcedSide: [2, 3], startDelay: 1.0 }),
      ...spawnEdgeBurst(ctx.canvas, "mid_miniboss_core", 1, { forcedSide: [0, 1], startDelay: 0.8 })
    ];
  },
  (ctx) => {
    const bossX = ctx.canvas.width / 2;
    const bossY = ctx.canvas.height * 0.15;
    return [
      ...spawnEdgeBurst(ctx.canvas, "mid_grunt_skirmisher", Math.max(4, Math.round(3 * ctx.density)), { startDelay: 1.0 }),
      ...spawnEdgeBurst(ctx.canvas, "mid_grunt_laser", Math.max(3, Math.round(2 * ctx.density)), { startDelay: 2.0 }),
      ...spawnAt("mid_boss_core", bossX, bossY, 0)
    ];
  }
];

const FACTION_ROUNDS = {
  low: LOW_ROUNDS,
  mid: MID_ROUNDS
};

export function generateWave({ faction = "low", round = 1, difficulty = "normal", canvas }) {
  const rounds = FACTION_ROUNDS[faction] || FACTION_ROUNDS.low;
  const builder = rounds[(round - 1) % rounds.length];
  const mod = DIFFICULTY_MOD[difficulty] || DIFFICULTY_MOD.normal;
  const ctx = {
    faction,
    round,
    difficulty,
    canvas,
    density: mod.bulletDensity ?? 1
  };
  const spawns = builder(ctx) || [];
  return {
    spawns
  };
}
