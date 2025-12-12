import { GAME_CONFIG, DIFFICULTY_MOD, ENEMY_STATS } from "../config.js";
import { Input } from "../core/input.js";
import { Renderer } from "../core/renderer.js";
import { Assets } from "../core/assetLoader.js";
import { shortestAngleDiff, vecFromAngle } from "../core/math.js";
import { UIManager } from "./ui_manager.js";
import { generateWave } from "./round_manager.js";

function angleFromVector(dx, dy) {
  // Convert world-space vector to our angle convention (0 = up, clockwise positive)
  return Math.atan2(dx, -dy);
}

const LASER_FX_CONFIG = {
  orbCount: 0,
  beamWidth: 22,
  shakeDuration: 0.08,
  boltInterval: 0.05,
  chargeBoltInterval: 0.12,
  shockwaveInterval: 0.4,
  chargingRingIntervalBase: 0.6,
  chargingRingIntervalMin: 0.12,
  chargingRingStartRadius: 170,

  chargingRingShrinkSpeed: 260,
  chargingRingAlpha: 0.8,
  emberSpawnRateBase: 18,
  emberSpawnRateMax: 45
};

function createPlayer() {
  return {
    x: 0,
    y: 0,
    angle: 0,
    targetAngle: 0,
    velX: 0,
    velY: 0,
    dashCooldown: 0,
    dashActive: false,
    dashTime: 0,
    dashDirX: 0,
    dashDirY: 0,
    dashBoostTimer: 0,
    angularSpeed: 0,
    radius: GAME_CONFIG.player.radius,
    maxHp: GAME_CONFIG.player.maxHp,
    hp: GAME_CONFIG.player.maxHp,
    maxShield: GAME_CONFIG.player.maxShield,
    // Shield Sectors: 0: Front, 1: Right, 2: Back, 3: Left
    shieldSectors: [
      GAME_CONFIG.player.maxShield / 4,
      GAME_CONFIG.player.maxShield / 4,
      GAME_CONFIG.player.maxShield / 4,
      GAME_CONFIG.player.maxShield / 4
    ],
    shieldDelayTimer: 0,
    invincibleTimer: 0,
    torpAmmo: GAME_CONFIG.torpedo.ammoMax,
    torpAmmoMax: GAME_CONFIG.torpedo.ammoMax,
    torpAmmoFront: 12,
    torpAmmoRear: 5,
    torpCooldownFront: 0,
    torpCooldownRear: 0,
    torpCooldown: 0,
    torpRegenPerSec: GAME_CONFIG.torpedo.regenPerSecond,
    shieldRegenPerSec: GAME_CONFIG.player.shieldRegenPerSec,
    flickerTimer: 0,
    laserState: "ready", // ready, firing, cooldown
    laserTimer: 0,
    disableTimer: {}
  };
}

function findTorpTarget(player, enemies) {
  const dir = vecFromAngle(player.angle);
  const coneCos = Math.cos(GAME_CONFIG.torpedo.lockConeDeg * Math.PI / 180);
  let best = null;
  let bestDist = Infinity;
  for (const e of enemies) {
    const dx = e.x - player.x;
    const dy = e.y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist > GAME_CONFIG.torpedo.maxRange) continue;
    const len = dist || 1;
    const ux = dx / len;
    const uy = dy / len;
    const dot = ux * dir.x + uy * dir.y;
    if (dot > coneCos && dist < bestDist) {
      best = e;
      bestDist = dist;
    }
  }
  return best;
}

function createShieldBreakState() {
  return {
    active: false,
    start: 0,
    lastTime: 0,
    radius: 0,
    hexSize: 0,
    hexGrid: [],
    exploding: [],
    shards: [],
    cracks: [],
    coreFlash: 0
  };
}

// Shield palette (7-tone with wider separation for richer hue steps)
const SHIELD_PALETTE = ["#e2fbff", "#b5f0ff", "#7ad7ff", "#5aa5ff", "#7b73ff", "#c25dff", "#ff8bd9"];
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const v = parseInt(h, 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}
function getPaletteColor(ratio, alpha = 1) {
  const t = Math.max(0, Math.min(1, 1 - ratio)); // high shield -> lightest
  const idx = Math.min(SHIELD_PALETTE.length - 1, Math.floor(t * (SHIELD_PALETTE.length - 1)));
  const c = hexToRgb(SHIELD_PALETTE[idx]);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
}

function getShieldTotal(player) {
  if (!player) return 0;
  if (Array.isArray(player.shieldSectors)) {
    return player.shieldSectors.reduce((sum, val) => sum + val, 0);
  }
  return player.shield ?? 0;
}

export class GameState {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.remote = null; // 另一位玩家的顯示用快照
    this.enemies = [];
    this.playerBullets = [];
    this.enemyBullets = [];
    this.particles = [];
    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.round = 1;
    this.pendingNextWave = false;
    this.waveCooldown = 0;
    this.difficulty = "normal";
    this.faction = "low";
    this.laser = {
      state: "idle",
      timer: 0,
      energy: GAME_CONFIG.laser.maxEnergy
    };
    this.cameraShakeTime = 0;
    this.laserFx = createLaserFx();
    this.prevLaserState = "idle";
    this.autoMode = this.difficulty === "god";
    this.autoInput = { thrust: 0, dash: false, torp: false, laser: false, targetAngle: null, moveAngle: null };
    this.shieldFx = {
      hitTimer: 0,
      hitAngle: 0,
      hitSprite: null,
      baseSprite: null,
      flashTimer: 0,
      flashOn: false,
      flashPhase: 0,
      flashStrength: 0,
      hits: [],
      hitFragments: [],
      break: createShieldBreakState(),
      breakWaves: [],
      breakArcs: [],
      breakFragments: [],
      breakScans: [],
      breakFlash: 0
    };
    this.allowDeath = true;
    this.autoTarget = null;
    this.glowNormalPhase = 0;
    this.glowLaserPhase = 0;
    this.glowLaserBlend = 0;
    this.glowLaserPeakTimer = 0;
    this.disableTimer = {};
    this.targetingError = { front: 0, rear: 0 };
    this.debugMode = false;
    this.debugHint = "F3 toggle debug";
    window.addEventListener("keydown", (e) => {
      if (e.code === "KeyP") {
        if (this.difficulty === "god") {
          this.autoMode = !this.autoMode;
        } else {
          console.info("[Auto] enable auto only in god difficulty");
        }
      }
      if (e.code === "F3") {
        this.debugMode = !this.debugMode;
        UIManager.setDebugVisible(this.debugMode);
      }
      if (this.debugMode) {
        const angle = this.player.angle;
        const front = angle;
        const back = angle + Math.PI;
        const left = angle - Math.PI / 2;
        const right = angle + Math.PI / 2;
        const dirFromAngle = (a) => ({ x: -Math.cos(a), y: -Math.sin(a) });
        if (e.code === "Digit1") this.applyDamageToPlayer(20, dirFromAngle(front).x, dirFromAngle(front).y);
        if (e.code === "Digit2") this.applyDamageToPlayer(20, dirFromAngle(back).x, dirFromAngle(back).y);
        if (e.code === "Digit3") this.applyDamageToPlayer(20, dirFromAngle(left).x, dirFromAngle(left).y);
        if (e.code === "Digit4") this.applyDamageToPlayer(20, dirFromAngle(right).x, dirFromAngle(right).y);
      }
    });
    this.player = createPlayer();
    this.centerPlayer();
    UIManager.updateRound(this.round);
    this.buildSpawnQueue();
  }

  tryDisableWeapons(hitSide, hull, maxHull) {
    const hpRatio = Math.max(0, Math.min(1, hull / Math.max(1, maxHull)));
    const duration = 5 + (1 - hpRatio) * 25; // 5s at full hull, up to 30s at low hull
    const chance = 0.35; // 35% chance on qualifying hit
    if (Math.random() > chance) return;

    if (hitSide === "front") {
      // disable laser or front torp (random)
      const pick = Math.random() < 0.5 ? "laser" : "front";
      if (pick === "laser") {
        this.disableTimer = this.disableTimer || {};
        this.disableTimer.laser = duration;
      } else {
        this.disableTimer = this.disableTimer || {};
        this.disableTimer.torpFront = duration;
      }
    } else if (hitSide === "back") {
      this.disableTimer = this.disableTimer || {};
      this.disableTimer.torpRear = duration;
    }
  }

  tryJamTargeting(hitSide, hull, maxHull) {
    if (hitSide !== "front" && hitSide !== "back") return;
    const hpRatio = Math.max(0, Math.min(1, hull / Math.max(1, maxHull)));
    const duration = 5 + (1 - hpRatio) * 25;
    const chance = 0.35;
    if (Math.random() > chance) return;
    const pick = Math.random() < 0.5 ? "front" : "rear";
    this.targetingError = this.targetingError || { front: 0, rear: 0 };
    this.targetingError[pick] = Math.max(this.targetingError[pick] || 0, duration);
  }

  centerPlayer() {
    this.player.x = this.canvas.width / 2;
    this.player.y = this.canvas.height * 0.7;
  }

  setDifficulty(diff) {
    this.difficulty = diff;
    UIManager.setDifficulty(diff);
    this.autoMode = this.difficulty === "god" ? true : this.autoMode;
    this.resetRound();
  }

  setDeathAllowed(enabled) {
    this.allowDeath = enabled;
    UIManager.setDeathAllowed(enabled);
  }

  setFaction(faction) {
    this.faction = faction;
    UIManager.setFaction(faction);
    this.resetRound();
  }

  getLaserRange() {
    // Use a length that comfortably exceeds the screen so the beam spans the view from any position.
    return Math.hypot(this.canvas.width, this.canvas.height) * 2;
  }

  resetRound() {
    const deathPref = this.allowDeath;
    this.player = createPlayer();
    this.player.disableTimer = {};
    this.player.targetingError = { front: 0, rear: 0 };
    this.disableTimer = {};
    this.targetingError = { front: 0, rear: 0 };
    // 前/後魚雷獨立庫存與冷卻
    this.player.torpAmmoFront = 12;
    this.player.torpAmmoRear = 5;
    this.player.torpCooldownFront = 0;
    this.player.torpCooldownRear = 0;
    this.player.maxHull = 100;
    this.player.hull = 100;
    this.centerPlayer();
    this.enemies = [];
    this.playerBullets = [];
    this.enemyBullets = [];
    this.particles = [];
    this.spawnQueue = [];
    this.round = 1;
    this.pendingNextWave = false;
    this.waveCooldown = 0;
    this.laser.state = "idle";
    this.laser.energy = GAME_CONFIG.laser.maxEnergy;
    this.cameraShakeTime = 0;
    this.laserFx = createLaserFx();
    this.autoInput = { thrust: 0, dash: false, torp: false, laser: false, targetAngle: null, moveAngle: null };
    this.shieldFx = {
      hitTimer: 0,
      hitAngle: 0,
      hitSprite: null,
      baseSprite: null,
      flashTimer: 0,
      flashOn: false,
      flashPhase: 0,
      flashStrength: 0,
      hits: [],
      hitFragments: [],
      break: createShieldBreakState(),
      breakWaves: []
    };
    if (this.difficulty === "god") {
      this.autoMode = true;
    }
    this.allowDeath = deathPref;
    this.autoTarget = null;
    UIManager.updateRound(this.round);
    this.buildSpawnQueue();
  }

  buildSpawnQueue() {
    const wave = generateWave({
      round: this.round,
      difficulty: this.difficulty,
      faction: this.faction,
      canvas: { width: this.canvas.width, height: this.canvas.height }
    });
    this.spawnQueue = (wave && wave.spawns) ? [...wave.spawns] : [];
    this.spawnTimer = 0;
  }

  spawnEnemy(info) {
    const mod = DIFFICULTY_MOD[this.difficulty];
    const base = ENEMY_STATS[info.typeId];
    if (!base) return;
    const enemy = {
      typeId: info.typeId,
      x: info.x ?? Math.random() * this.canvas.width,
      y: info.y ?? -30,
      vx: 0, vy: 0,
      radius: info.radius ?? 12,
      hp: base.hp * mod.hp,
      speed: base.speed * mod.enemySpeed,
      baseSpeed: base.speed * mod.enemySpeed,
      fireDelay: base.fireDelay / mod.bulletDensity,
      fireTimer: Math.random() * base.fireDelay,
      damage: base.damage * mod.damage,
      aiPhase: Math.random() * Math.PI * 2,
      behavior: null
    };

    switch (info.typeId) {
      case "mid_grunt_skirmisher":
        enemy.behavior = "skirmisher";
        enemy.preferredRange = 260;
        enemy.strafeTimer = 0;
        enemy.reactionDelay = 0.35;
        enemy.reactionTimer = 0;
        enemy.glowNormalPhase = Math.random() * Math.PI * 2;
        enemy.glowLaserBlend = 0;
        enemy.glowLaserPhase = 0;
        enemy.glowLaserPeakTimer = 0;
        break;
      case "mid_grunt_laser":
        enemy.behavior = "laser_grunt";
        enemy.laser = {
          state: "idle",
          timer: 0,
          cooldown: 0.8 + Math.random(),
          duration: 0.45,
          warning: 0.35
        };
        enemy.glowNormalPhase = Math.random() * Math.PI * 2;
        enemy.glowLaserBlend = 0;
        enemy.glowLaserPhase = 0;
        break;
      case "mid_miniboss_dual":
        enemy.behavior = "dual_miniboss";
        enemy.radius = 28;
        enemy.turretTimer = 0.0;
        enemy.chargeTimer = 2.8;
        enemy.chargeActive = 0;
        break;
      case "mid_miniboss_core":
        enemy.behavior = "spin_miniboss";
        enemy.radius = 24;
        enemy.spin = {
          state: "idle",
          cooldown: 1.2 + Math.random() * 0.8,
          warning: 0.65,
          firing: 0.9,
          angularVel: 0,
          targetVel: 0
        };
        enemy.spinDir = Math.random() > 0.5 ? 1 : -1;
        enemy.spinAngle = Math.random() * Math.PI * 2;
        enemy.aiPhaseRate = 1.1;
        enemy.disableDefaultFire = true;
        enemy.glowAnim = 0;
        break;
      case "mid_boss_core":
        enemy.behavior = "mid_boss";
        enemy.radius = 40;
        enemy.phaseTimer = 0;
        enemy.phaseIndex = 0;
        enemy.phaseList = ["torp", "rain", "clamp", "ultimate"];
        enemy.phaseData = null;
        enemy.warnings = [];
        enemy.activeBeams = [];
        enemy.ultimate = null;
        enemy.summonTimer = 4;
        enemy.animTimer = 0;
        enemy.animIndex = 0;
        break;
      default:
        enemy.behavior = null;
        break;
    }

    if (info.typeId.includes("grunt")) {
      enemy.radius = (enemy.radius || 12) * 2 / 1.5; // Scaled down by 1.5x
    }

    this.enemies.push(enemy);
  }

  firePlayerTorpedo(angle, target, slot = "front") {
    const dir = target
      ? (() => {
        const dx = target.x - this.player.x;
        const dy = target.y - this.player.y;
        const len = Math.hypot(dx, dy) || 1;
        return { x: dx / len, y: dy / len };
      })()
      : vecFromAngle(angle);
    // Apply targeting jam offset
    const jamTimer = this.targetingError && slot === "front"
      ? this.targetingError.front
      : this.targetingError && slot === "rear"
        ? this.targetingError.rear
        : 0;
    let fireAngle = Math.atan2(dir.y, dir.x);
    if (jamTimer > 0) {
      const offset = (Math.random() * 40 - 20) * Math.PI / 180; // ±20°
      fireAngle += offset;
    }
    const dirVec = { x: Math.cos(fireAngle), y: Math.sin(fireAngle) };
    const startX = this.player.x + dir.x * 22;
    const startY = this.player.y + dir.y * 22;
    // torpedo speed scales with player base speed * 3
    const speed = GAME_CONFIG.player.baseMoveSpeed * 3;
    this.playerBullets.push({
      from: "player",
      x: startX,
      y: startY,
      vx: dirVec.x * speed,
      vy: dirVec.y * speed,
      radius: 5,
      damage: GAME_CONFIG.torpedo.damage,
      life: 3,
      angle: fireAngle,
      speed,
      target: target || null
    });
  }

  fireEnemyTorpedo(enemy) {
    const dx = this.player.x - enemy.x;
    const dy = this.player.y - enemy.y;
    const len = Math.hypot(dx, dy) || 1;
    const dirX = dx / len;
    const dirY = dy / len;
    const speed = 190;
    this.enemyBullets.push({
      from: "enemy",
      x: enemy.x + dirX * 18,
      y: enemy.y + dirY * 18,
      vx: dirX * speed,
      vy: dirY * speed,
      radius: 3,
      damage: enemy.damage,
      life: 4
    });
  }

  applyDamageToPlayer(amount, dirX = null, dirY = null) {
    const player = this.player;
    if (this.difficulty === "god") return;
    const mod = DIFFICULTY_MOD[this.difficulty];
    let remaining = amount * mod.damage;
    let sectorIdx = -1;
    let sectorHitFrom = null;
    let directionVec = null;

    // Determine sector if direction is provided
    if (dirX != null && dirY != null) {
      const len = Math.hypot(dirX, dirY) || 1;
      directionVec = { x: dirX / len, y: dirY / len };
      const angleToSource = Math.atan2(-directionVec.y, -directionVec.x);
      let relAngle = angleToSource - player.angle;
      while (relAngle > Math.PI) relAngle -= Math.PI * 2;
      while (relAngle < -Math.PI) relAngle += Math.PI * 2;

      if (Math.abs(relAngle) <= Math.PI / 4) {
        sectorIdx = 0; // Front
        sectorHitFrom = "front";
      } else if (relAngle > Math.PI / 4 && relAngle <= 3 * Math.PI / 4) {
        sectorIdx = 1; // Right (starboard)
        sectorHitFrom = "right";
      } else if (relAngle < -Math.PI / 4 && relAngle >= -3 * Math.PI / 4) {
        sectorIdx = 3; // Left (port)
        sectorHitFrom = "left";
      } else {
        sectorIdx = 2; // Back (aft)
        sectorHitFrom = "back";
      }
    }

    // Apply damage to shield sector
    if (sectorIdx !== -1 && player.shieldSectors[sectorIdx] > 0) {
      // "The amount of damage is random, anywhere between 1/4 to 1/8 of Your shield strength."
      // Wait, "Your shield strength" usually means Max Shield? Or current?
      // "1/4 to 1/8 of Your shield strength" implies a fixed chunk based on max strength?
      // Or is it proportional to the *incoming damage*?
      // The slide says: "The amount of damage is random, anywhere between 1/4 to 1/8 of Your shield strength."
      // This sounds like the damage *taken by the shield* is fixed/random regardless of bullet damage?
      // That would be weird. Maybe it means "The visual effect brightness"?
      // "This does not display, but it affects the brightness of the shield-glare effect."
      // Ah. "The amount of damage is random... This does not display..."
      // This sentence is confusing.
      // Interpretation A: The shield *takes* random damage (1/4-1/8 max) instead of bullet damage.
      // Interpretation B: The bullet does normal damage, but the *visual* brightness is based on a random value?
      // "Based on where the enemy hits the shield only that sector receives shield damage."
      // "The amount of damage is random... This does not display..."
      // I will assume Interpretation A: Shield takes random damage per hit, ignoring bullet damage? No, that breaks balance.
      // Maybe it means "The shield absorbs damage, but the *visual impact* (brightness) is random"?
      // "The amount of damage is random... This does not display, but it affects the brightness..."
      // Okay, maybe the *internal damage variable for visuals* is random?
      // BUT, it says "only that sector receives shield damage".
      // Let's stick to: Bullet does `remaining` damage. Shield absorbs it.
      // BUT the slide says: "The amount of damage is random, anywhere between 1/4 to 1/8 of Your shield strength."
      // This is a specific rule. I will implement it as:
      // Shield Damage = Random(MaxShield/8, MaxShield/4).
      // This overrides the bullet damage for the shield portion?
      // "Your shield now has 4 sectors... based on where the enemy hits... only that sector receives shield damage. The amount of damage is random..."
      // Yes, it seems to replace the damage calculation for shields.
      // So: If shield is hit, reduce shield by Random(Max/8, Max/4). If shield breaks, maybe excess goes to HP?
      // Or maybe it just damages shield and blocks the hit completely?
      // "This does not display" -> maybe the numeric value isn't shown, but brightness is.

      const shieldDmg = player.maxShield * (0.125 + Math.random() * 0.125);
      const blocked = Math.min(player.shieldSectors[sectorIdx], shieldDmg);
      player.shieldSectors[sectorIdx] -= blocked;

      // Visuals - register shield hit with sector information
      if (!this.shieldFx) this.shieldFx = {};
      if (!this.shieldFx.hits) this.shieldFx.hits = [];

      const shieldRadius = player.radius * 4;
      // Place impact on the side facing the incoming source (direction FROM player TO source)
      const angle = Math.atan2(-dirY, -dirX);
      const impactX = Math.cos(angle) * shieldRadius * 0.7;
      const impactY = Math.sin(angle) * shieldRadius * 0.7;
      const hitData = {
        time: performance.now(),
        ix: impactX,
        iy: impactY,
        sector: sectorIdx,
        speed: 1.0,
        colorT: Math.random()
      };

      this.shieldFx.hits.push(hitData);
      console.log('Shield hit registered:', hitData); // 除錯日誌

      // If shield absorbed it, does any pass through?
      // If the rule implies "Shield takes X damage", does it block the bullet entirely?
      // Usually yes, unless shield breaks.
      // If blocked < shieldDmg (shield broke), does the rest go to HP?
      // The slide doesn't say. I'll assume if shield absorbs *some*, the bullet is stopped/mitigated.
      // Let's assume if shield > 0 in that sector, it blocks the hit but takes the random damage.
      // If shield reaches 0, it breaks.

      if (player.shieldSectors[sectorIdx] <= 0) {
        // Sector broken: register multiple FX
        if (this.shieldFx) {
          const now = performance.now();
          this.shieldFx.breakWaves = this.shieldFx.breakWaves || [];
          this.shieldFx.breakArcs = this.shieldFx.breakArcs || [];
          this.shieldFx.breakFragments = this.shieldFx.breakFragments || [];
          this.shieldFx.breakScans = this.shieldFx.breakScans || [];
          this.shieldFx.breakWaves.push({
            sector: sectorIdx,
            start: now,
            duration: 650,
            angle: player.angle,
            colorT: Math.random()
          });
          // electric arcs along rim
          const arcCount = 6;
          for (let i = 0; i < arcCount; i++) {
            this.shieldFx.breakArcs.push({
              sector: sectorIdx,
              start: now + i * 20,
              life: 180 + Math.random() * 120,
              seed: Math.random() * 1000
            });
          }
          // glass fragments burst
          for (let i = 0; i < 24; i++) {
            const ang = player.angle + (sectorIdx === 0 ? 0 : sectorIdx === 1 ? Math.PI / 2 : sectorIdx === 2 ? Math.PI : -Math.PI / 2) + (Math.random() - 0.5) * 0.8;
            const spd = 180 + Math.random() * 220;
            this.shieldFx.breakFragments.push({
              x: Math.cos(ang) * player.radius * 4,
              y: Math.sin(ang) * player.radius * 4,
              vx: Math.cos(ang) * spd,
              vy: Math.sin(ang) * spd,
              rot: (Math.random() - 0.5) * 12,
              size: 6 + Math.random() * 10,
              life: 0.6 + Math.random() * 0.4
            });
          }
          // scanning lines
          const scanCount = 3;
          for (let i = 0; i < scanCount; i++) {
            this.shieldFx.breakScans.push({
              sector: sectorIdx,
              start: now + i * 60,
              duration: 380,
              offset: Math.random()
            });
          }
          // flash bloom
          this.shieldFx.breakFlash = 0.45;
          this.cameraShakeTime = Math.max(this.cameraShakeTime, 0.18);
        }
      }

      // Shield absorbs this hit entirely
      remaining = 0;
    }

    // Hull damage (after shield broken or no shield)
    if (remaining > 0 && player.invincibleTimer <= 0) {
      // Directional effects on hull
      let hullDamage = remaining;
      if (sectorHitFrom === "left" || sectorHitFrom === "right") {
        hullDamage *= 2; // port/starboard deal double to hull
        player.velX *= 0.7;
        player.velY *= 0.7;
      }
      player.hull = Math.max(0, (player.hull ?? player.hp) - hullDamage);
      // 前/後命中可讓武器離線
      if (sectorHitFrom === "front" || sectorHitFrom === "back") {
        this.tryDisableWeapons(sectorHitFrom, player.hull, player.maxHull ?? player.maxHp);
        this.tryJamTargeting(sectorHitFrom, player.hull, player.maxHull ?? player.maxHp);
      }

      player.hp = player.hull; // hull is the source of death check
      player.invincibleTimer = GAME_CONFIG.player.invincibleTime;
      player.flickerTimer = 0.4;
    }

    // Prevent non-death mode from hitting zero
    player.shieldDelayTimer = GAME_CONFIG.player.shieldDelay;
    if (player.hp < 0) player.hp = 0;
    if (!this.allowDeath && player.hp <= 0) {
      player.hp = Math.max(1, player.hp);
      player.invincibleTimer = Math.max(player.invincibleTimer, 0.5);
    }
  }

  updatePlayer(dt) {
    const player = this.player;
    if (player.flickerTimer > 0) {
      player.flickerTimer = Math.max(0, player.flickerTimer - dt);
    }
    let desiredAngle = null;
    if (this.autoMode) {
      this.updateAutoMode(dt);
      if (this.autoInput.targetAngle != null) {
        desiredAngle = this.autoInput.targetAngle;
        player.targetAngle = desiredAngle;
        // Auto-aim snaps immediately to?��??��?，避?��?準落�?        player.angle = desiredAngle;
        player.angularSpeed = 0;
      } else {
        player.targetAngle = player.angle;
      }
    } else {
      const dirName = Input.getDirectionName();
      if (dirName) {
        desiredAngle = Input.getDirectionAngle();
        if (desiredAngle != null) {
          desiredAngle = this.applyAimAssist(desiredAngle);
          player.targetAngle = desiredAngle;
        }
      } else {
        player.targetAngle = player.angle;
      }
    }

    // rotation（auto: 強制貼�??��?角度，避?��?準落後�?
    const diff = shortestAngleDiff(player.angle, player.targetAngle);
    const absDiff = Math.abs(diff);
    const deadZone = 0.01;
    const laserActive = this.laser.state === "charging" || this.laser.state === "firing";
    const baseAccel = laserActive ? GAME_CONFIG.player.angularAccel * 0.5 : GAME_CONFIG.player.angularAccel;
    const turnMul = this.autoMode ? 2.6 : 1;
    const maxSpeed = GAME_CONFIG.player.angularMaxSpeed * turnMul;
    const angularAccel = baseAccel * turnMul;
    if (absDiff > deadZone) {
      const dir = Math.sign(diff);
      const turnBoost = absDiff > Math.PI / 1.8 ? 2.2 : 1;
      const accel = angularAccel * turnBoost;
      if (player.angularSpeed * dir < 0) {
        player.angularSpeed += dir * accel * 2 * dt;
      } else {
        player.angularSpeed += dir * accel * dt;
      }
      if (player.angularSpeed > maxSpeed) player.angularSpeed = maxSpeed;
      if (player.angularSpeed < -maxSpeed) player.angularSpeed = -maxSpeed;
    } else {
      const damp = Math.min(1, GAME_CONFIG.player.angularDamp * dt);
      player.angularSpeed *= (1 - damp);
      if (Math.abs(player.angularSpeed) < 0.02) player.angularSpeed = 0;
    }
    let angleStep = player.angularSpeed * dt;
    if (Math.abs(angleStep) > absDiff) {
      angleStep = diff;
      player.angularSpeed = 0;
    }
    player.angle += angleStep;

    this.glowNormalPhase = (this.glowNormalPhase + dt * 0.7) % (Math.PI * 2);
    const blendTarget = laserActive ? 1 : 0;
    const blendSpeed = laserActive ? 6 : 2;
    this.glowLaserBlend += (blendTarget - this.glowLaserBlend) * Math.min(1, blendSpeed * dt);
    if (laserActive) {
      this.glowLaserPhase = (this.glowLaserPhase + dt * 1.5) % (Math.PI * 2);
      this.glowLaserPeakTimer += dt;
    } else {
      this.glowLaserPhase = 0;
      this.glowLaserPeakTimer = 0;
    }

    // shield FX timers
    const fx = this.shieldFx;
    if (fx.hitTimer > 0) fx.hitTimer = Math.max(0, fx.hitTimer - dt);
    const shieldAmount = getShieldTotal(player);
    const shieldRatio = player.maxShield > 0 ? shieldAmount / player.maxShield : 0;
    if (shieldAmount > 0 && shieldRatio < 0.5) {
      const stress = Math.min(1, Math.max(0, 1 - shieldRatio * 2)); // 0 at 50%, 1 at 0%
      const freq = 2.5 + (9 - 2.5) * stress;
      fx.flashPhase = (fx.flashPhase || 0) + dt * freq * Math.PI * 2;
      const sinPulse = 0.5 + 0.5 * Math.sin(fx.flashPhase);
      const gaussNoise = ((Math.random() + Math.random() + Math.random() + Math.random()) - 2) * 0.1; // approx N(0,0.1)
      const amplitude = 0.25 + 0.55 * stress;
      fx.flashStrength = Math.max(0, Math.min(1.2, (sinPulse + gaussNoise) * amplitude));
    } else {
      fx.flashStrength = 0;
      fx.flashPhase = 0;
    }

    // movement with inertia
    const isDashing = player.dashBoostTimer > 0;
    let thrustVector = null;
    let thrustAmount = 0;
    if (this.autoMode) {
      // ?�自?�模式中，移?��??��??�離：移?��??�由 autoInput.moveAngle 決�?
      const moveAngle = this.autoInput.moveAngle;
      if (moveAngle != null) {
        thrustAmount = this.autoInput.thrust;
        thrustVector = vecFromAngle(moveAngle);
      } else {
        thrustAmount = 0;
      }
    } else if (desiredAngle != null) {
      thrustAmount = 1;
      thrustVector = vecFromAngle(desiredAngle);
    }
    if (thrustVector && thrustAmount !== 0) {
      const direction = thrustAmount > 0 ? 1 : -1;
      const accel = (isDashing ? GAME_CONFIG.player.accel * 0.2 : GAME_CONFIG.player.accel) * direction;
      player.velX += thrustVector.x * accel * dt;
      player.velY += thrustVector.y * accel * dt;
      if (!isDashing && direction > 0) {
        const forwardSpeed = player.velX * thrustVector.x + player.velY * thrustVector.y;
        if (forwardSpeed > GAME_CONFIG.player.baseMoveSpeed) {
          const excess = forwardSpeed - GAME_CONFIG.player.baseMoveSpeed;
          player.velX -= thrustVector.x * excess;
          player.velY -= thrustVector.y * excess;
        }
      }
    }

    const dragRate = isDashing
      ? GAME_CONFIG.player.moveDrag * GAME_CONFIG.dash.dragMultiplier
      : GAME_CONFIG.player.moveDrag;
    const drag = Math.min(1, dragRate * dt);
    player.velX *= (1 - drag);
    player.velY *= (1 - drag);

    const speed = Math.hypot(player.velX, player.velY);
    const allowedCap = GAME_CONFIG.player.velocityCap *
      (player.dashBoostTimer > 0 ? GAME_CONFIG.dash.postBoostCapMultiplier : 1);
    if (speed > allowedCap) {
      const scale = allowedCap / speed;
      player.velX *= scale;
      player.velY *= scale;
    }

    // In auto mode, clamp speed and optionally stop when already in ideal range
    if (this.autoMode) {
      const target = this.autoTarget;
      if (target) {
        const dx = target.x - player.x;
        const dy = target.y - player.y;
        const dist = Math.hypot(dx, dy);
        const idealMin = 140;
        const idealMax = 260;
        if (dist >= idealMin && dist <= idealMax) {
          player.velX = 0;
          player.velY = 0;
        }
      }
      const cap = GAME_CONFIG.player.maxMoveSpeed * 1.1;
      const current = Math.hypot(player.velX, player.velY);
      if (current > cap) {
        const s = cap / current;
        player.velX *= s;
        player.velY *= s;
      }
    }

    // dash impulse
    const dashPressed = this.autoMode ? this.autoInput.dash : Input.isDown("KeyX");
    if (dashPressed && player.dashCooldown <= 0 && !player.dashActive) {
      player.dashActive = true;
      player.dashTime = GAME_CONFIG.dash.duration;
      player.dashCooldown = GAME_CONFIG.dash.cooldown;
      const dirVec = vecFromAngle(player.angle);
      player.dashDirX = dirVec.x;
      player.dashDirY = dirVec.y;
      player.velX += dirVec.x * GAME_CONFIG.dash.speed;
      player.velY += dirVec.y * GAME_CONFIG.dash.speed;
      player.dashBoostTimer = GAME_CONFIG.dash.postBoostDuration;
      for (let i = 0; i < 12; i++) {
        this.particles.push({
          x: player.x,
          y: player.y,
          vx: (Math.random() - 0.5) * 80,
          vy: (Math.random() - 0.5) * 80,
          life: 0.3 + Math.random() * 0.2,
          color: "rgba(150,200,255,",
          size: 3 + Math.random() * 2
        });
      }
    }
    if (player.dashActive) {
      player.dashTime -= dt;
      if (player.dashTime <= 0) player.dashActive = false;
    }
    if (player.dashBoostTimer > 0) {
      player.dashBoostTimer -= dt;
    }
    if (player.dashCooldown > 0) player.dashCooldown -= dt;

    player.x += player.velX * dt;
    player.y += player.velY * dt;
    player.x = Math.max(player.radius, Math.min(this.canvas.width - player.radius, player.x));
    player.y = Math.max(player.radius, Math.min(this.canvas.height - player.radius, player.y));

    // torpedo split ammo (front/rear)
    if (player.torpCooldownFront > 0) player.torpCooldownFront -= dt;
    if (player.torpCooldownRear > 0) player.torpCooldownRear -= dt;

    // 更新離線計時
    if (this.disableTimer) {
      if (this.disableTimer.laser != null) {
        this.disableTimer.laser = Math.max(0, this.disableTimer.laser - dt);
        if (this.disableTimer.laser === 0) delete this.disableTimer.laser;
      }
      if (this.disableTimer.torpFront != null) {
        this.disableTimer.torpFront = Math.max(0, this.disableTimer.torpFront - dt);
        if (this.disableTimer.torpFront === 0) delete this.disableTimer.torpFront;
      }
      if (this.disableTimer.torpRear != null) {
        this.disableTimer.torpRear = Math.max(0, this.disableTimer.torpRear - dt);
        if (this.disableTimer.torpRear === 0) delete this.disableTimer.torpRear;
      }
    }
    if (this.targetingError) {
      if (this.targetingError.front != null) {
        this.targetingError.front = Math.max(0, this.targetingError.front - dt);
      }
      if (this.targetingError.rear != null) {
        this.targetingError.rear = Math.max(0, this.targetingError.rear - dt);
      }
    }

    // Forward Torpedo (Z)
    const torpForward = this.autoMode ? this.autoInput.torp : Input.isDown("KeyZ");
    const frontOffline = this.disableTimer && this.disableTimer.torpFront > 0;
    if (torpForward && player.torpCooldownFront <= 0 && player.torpAmmoFront > 0 && !frontOffline) {
      const target = findTorpTarget(player, this.enemies);
      this.firePlayerTorpedo(player.angle, target, "front");
      player.torpAmmoFront -= 1;
      player.torpCooldownFront = GAME_CONFIG.torpedo.cooldown;
    }

    // Aft Torpedo (V)
    const torpAft = this.autoMode ? false : Input.isDown("KeyV");
    const rearOffline = this.disableTimer && this.disableTimer.torpRear > 0;
    if (torpAft && player.torpCooldownRear <= 0 && player.torpAmmoRear > 0 && !rearOffline) {
      this.firePlayerTorpedo(player.angle + Math.PI, null, "rear");
      player.torpAmmoRear -= 1;
      player.torpCooldownRear = GAME_CONFIG.torpedo.cooldown;
    }

    // laser state machine (Burst / Cooldown)
    const laser = this.laser;
    const prevLaserState = laser.state;

    if (laser.state === "idle" || laser.state === "ready") { // waiting
      const laserOffline = this.disableTimer && this.disableTimer.laser > 0;
      if (!laserOffline && (this.autoMode ? this.autoInput.laser : Input.isDown("KeyC"))) {
        const charge = GAME_CONFIG.laser.chargeTime || 0;
        if (charge > 0) {
          laser.state = "charging";
          laser.timer = charge;
        } else {
          laser.state = "firing";
          laser.timer = GAME_CONFIG.laser.burstDuration;
        }
      }
    } else if (laser.state === "charging") {
      laser.timer -= dt;
      if (laser.timer <= 0) {
        laser.state = "firing";
        laser.timer = GAME_CONFIG.laser.burstDuration;
      }
    } else if (laser.state === "firing") {
      laser.timer -= dt;
      // Fire logic
      const range = this.getLaserRange();
      const beamWidth = GAME_CONFIG.laser.width;
      const dirVec = vecFromAngle(player.angle);
      for (const e of this.enemies) {
        const ex = e.x - player.x;
        const ey = e.y - player.y;
        const proj = ex * dirVec.x + ey * dirVec.y;
        if (proj < 0 || proj > range) continue;
        const px = dirVec.x * proj;
        const py = dirVec.y * proj;
        const dist = Math.hypot(ex - px, ey - py);
        if (dist < e.radius + beamWidth) {
          e.hp -= 120 * dt; // Damage per second
          e.slowTimer = Math.max(e.slowTimer || 0, 0.45);
        }
      }

      if (laser.timer <= 0) {
        laser.state = "release";
        laser.timer = GAME_CONFIG.laser.releaseTime;
      }
    } else if (laser.state === "release") {
      laser.timer -= dt;
      if (laser.timer <= 0) {
        laser.state = "cooldown";
        laser.timer = GAME_CONFIG.laser.cooldown;
      }
    } else if (laser.state === "cooldown") {
      laser.timer -= dt;
      if (laser.timer <= 0) {
        laser.state = "ready";
      }
    }

    // keep UI energy bar in sync with the burst/cooldown cycle
    if (laser.state === "ready" || laser.state === "idle") {
      laser.energy = GAME_CONFIG.laser.maxEnergy;
    } else if (laser.state === "charging") {
      const remaining = Math.max(0, laser.timer);
      const total = Math.max(0.0001, GAME_CONFIG.laser.chargeTime);
      laser.energy = GAME_CONFIG.laser.maxEnergy * (1 - (total - remaining) / total);
    } else if (laser.state === "firing") {
      const remaining = Math.max(0, laser.timer);
      const duration = Math.max(0.0001, GAME_CONFIG.laser.burstDuration);
      laser.energy = Math.max(0, GAME_CONFIG.laser.maxEnergy * (remaining / duration));
    } else if (laser.state === "release") {
      laser.energy = 0;
    } else if (laser.state === "cooldown") {
      const remaining = Math.max(0, laser.timer);
      const cooldown = Math.max(0.0001, GAME_CONFIG.laser.cooldown);
      const progress = 1 - remaining / cooldown;
      laser.energy = Math.max(0, Math.min(GAME_CONFIG.laser.maxEnergy, GAME_CONFIG.laser.maxEnergy * progress));
    }

    // Map "ready" to "idle" for rendering if needed, or update renderer.
    // The renderer checks for "charging", "firing", "release".
    // I should probably map my new states to something the renderer understands or update renderer.
    // Renderer: drawLaser checks ["charging", "firing", "release"].
    // My new states: "ready", "firing", "cooldown".
    // "firing" matches.
    // "ready" is like "idle".
    // "cooldown" is like "idle" visually (no beam).
    // So renderer should be fine if I only draw when "firing".

    this.prevLaserState = laser.state;
  }

  updateEnemies(dt) {
    const mod = DIFFICULTY_MOD[this.difficulty];
    this.spawnTimer += dt;
    for (let i = this.spawnQueue.length - 1; i >= 0; i--) {
      const info = this.spawnQueue[i];
      info.delay -= dt;
      if (info.delay <= 0) {
        this.spawnEnemy(info);
        this.spawnQueue.splice(i, 1);
      }
    }

    for (const enemy of this.enemies) {
      const dx = this.player.x - enemy.x;
      const dy = this.player.y - enemy.y;
      const dist = Math.hypot(dx, dy) || 1;
      let towards = 1.0;
      let side = 0.4;
      if (enemy.behavior === "skirmisher") {
        towards = 0.7;
        side = 0.9;
      } else if (enemy.behavior === "laser_grunt") {
        towards = 0.7;
        side = 0.5;
      } else if (enemy.behavior === "dual_miniboss") {
        towards = 0.4;
        side = 0.2;
      } else if (enemy.behavior === "spin_miniboss") {
        towards = 0.85;
        side = 0.95;
      } else if (enemy.behavior === "mid_boss") {
        towards = 0;
        side = 0;
      }
      const ux = dx / dist;
      const uy = dy / dist;
      const sx = -uy;
      const sy = ux;
      const aiPhaseRate = enemy.aiPhaseRate || 0.7;
      enemy.aiPhase += dt * aiPhaseRate;
      const sideFactor = Math.sin(enemy.aiPhase) * side;
      let effectiveSpeed = enemy.baseSpeed || enemy.speed;
      if (enemy.slowTimer && enemy.slowTimer > 0) {
        enemy.slowTimer -= dt;
        effectiveSpeed *= 0.45;
      } else {
        enemy.slowTimer = 0;
      }
      enemy.x += (ux * towards + sx * sideFactor) * effectiveSpeed * dt;
      enemy.y += (uy * towards + sy * sideFactor) * effectiveSpeed * dt;
      const margin = 20;
      enemy.x = Math.max(margin, Math.min(this.canvas.width - margin, enemy.x));
      enemy.y = Math.max(margin, Math.min(this.canvas.height - margin, enemy.y));

      if (!enemy.disableDefaultFire) {
        enemy.fireTimer -= dt;
        if (enemy.fireTimer <= 0) {
          enemy.fireTimer = ENEMY_STATS[enemy.typeId].fireDelay / mod.bulletDensity;
          this.fireEnemyTorpedo(enemy);
        }
      }

      this.updateEnemyBehavior(enemy, dt);
    }

    // bullets
    for (const b of this.playerBullets) {
      if (b.from === "player" && b.target) {
        if (!this.enemies.includes(b.target) || b.target.hp <= 0) {
          b.target = null;
        } else {
          const dx = b.target.x - b.x;
          const dy = b.target.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 1) {
            const desiredX = dx / dist;
            const desiredY = dy / dist;
            const speed = b.speed || Math.hypot(b.vx, b.vy) || GAME_CONFIG.torpedo.speed;
            const curDirX = b.vx / speed;
            const curDirY = b.vy / speed;
            const turn = Math.min(1, GAME_CONFIG.torpedo.homingTurnRate * dt);
            let newDirX = curDirX + (desiredX - curDirX) * turn;
            let newDirY = curDirY + (desiredY - curDirY) * turn;
            const newLen = Math.hypot(newDirX, newDirY) || 1;
            newDirX /= newLen;
            newDirY /= newLen;
            b.vx = newDirX * speed;
            b.vy = newDirY * speed;
            b.speed = speed;
            b.angle = Math.atan2(newDirY, newDirX);
          }
        }
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
    }
    for (const b of this.enemyBullets) {
      if (b.homing) {
        const dx = this.player.x - b.x;
        const dy = this.player.y - b.y;
        const dist = Math.hypot(dx, dy) || 1;
        const desiredX = dx / dist;
        const desiredY = dy / dist;
        const speed = b.speed || Math.hypot(b.vx, b.vy) || 1;
        const curDirX = b.vx / speed;
        const curDirY = b.vy / speed;
        const turn = Math.min(1, b.homing * dt);
        let newDirX = curDirX + (desiredX - curDirX) * turn;
        let newDirY = curDirY + (desiredY - curDirY) * turn;
        const newLen = Math.hypot(newDirX, newDirY) || 1;
        newDirX /= newLen;
        newDirY /= newLen;
        b.vx = newDirX * speed;
        b.vy = newDirY * speed;
        b.speed = speed;
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
    }
    const withinBounds = (b) => b.life > 0 && b.x > -50 && b.x < this.canvas.width + 50 && b.y > -50 && b.y < this.canvas.height + 50;
    this.playerBullets = this.playerBullets.filter(withinBounds);
    this.enemyBullets = this.enemyBullets.filter(withinBounds);

    // collisions
    if (this.player.invincibleTimer > 0) this.player.invincibleTimer -= dt;

    // Enemy bullet vs player (shield + hull two-layer detection)
    for (const b of this.enemyBullets) {
      const dx = b.x - this.player.x;
      const dy = b.y - this.player.y;
      const dist = Math.hypot(dx, dy);

      // First check shield collision (larger radius)
      const shieldRadius = this.player.radius * 4;
      const hullRadius = this.player.radius;

      let hitShield = false;
      let hitHull = false;

      // Check if bullet is within shield range
      if (dist < shieldRadius + b.radius) {
        // Determine which sector this attack is coming from
        const angleToSource = Math.atan2(-dy, -dx);
        let relAngle = angleToSource - this.player.angle;
        while (relAngle > Math.PI) relAngle -= Math.PI * 2;
        while (relAngle < -Math.PI) relAngle += Math.PI * 2;

        let sectorIdx = -1;
        if (Math.abs(relAngle) <= Math.PI / 4) {
          sectorIdx = 0; // Front
        } else if (relAngle > Math.PI / 4 && relAngle <= 3 * Math.PI / 4) {
          sectorIdx = 1; // Right
        } else if (relAngle < -Math.PI / 4 && relAngle >= -3 * Math.PI / 4) {
          sectorIdx = 3; // Left
        } else {
          sectorIdx = 2; // Back
        }

        // Check if that sector has shield
        if (sectorIdx !== -1 && this.player.shieldSectors[sectorIdx] > 0) {
          hitShield = true;
        }
      }

      // If no shield in that direction, check hull collision
      if (!hitShield && dist < hullRadius + b.radius) {
        hitHull = true;
      }

      // Apply damage accordingly
      if (hitShield || hitHull) {
        b.life = 0;
        this.applyDamageToPlayer(b.damage, -dx, -dy);
      }
    }

    // Enemy vs player collision
    for (const enemy of this.enemies) {
      const dx = enemy.x - this.player.x;
      const dy = enemy.y - this.player.y;
      const dist = Math.hypot(dx, dy);
      const minDist = enemy.radius + this.player.radius;
      if (dist < minDist && dist > 0) {
        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = minDist - dist;
        enemy.x += nx * overlap * 0.6;
        enemy.y += ny * overlap * 0.6;
        this.player.x -= nx * overlap * 0.4;
        this.player.y -= ny * overlap * 0.4;
        this.applyDamageToPlayer(20, -dx, -dy);
        enemy.hp -= 40;
      }
    }

    // Player bullet vs enemy collision
    for (const bullet of this.playerBullets) {
      for (const enemy of this.enemies) {
        const dx = bullet.x - enemy.x;
        const dy = bullet.y - enemy.y;
        if (Math.hypot(dx, dy) < enemy.radius + bullet.radius) {
          bullet.life = 0;
          enemy.hp -= bullet.damage;
          break;
        }
      }
    }

    // Remove dead enemies
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (this.enemies[i].hp <= 0) {
        if (this.laser.state === "firing") {
          this.player.torpAmmo = Math.min(
            this.player.torpAmmoMax,
            this.player.torpAmmo + GAME_CONFIG.torpedo.laserKillRefund
          );
        }
        this.enemies.splice(i, 1);
      }
    }

    // Shield regen
    if (this.player.shieldDelayTimer > 0) {
      this.player.shieldDelayTimer -= dt;
    } else {
      // Regen each sector separately
      for (let i = 0; i < 4; i++) {
        if (this.player.shieldSectors[i] < this.player.maxShield / 4) {
          this.player.shieldSectors[i] = Math.min(
            this.player.maxShield / 4,
            this.player.shieldSectors[i] + this.player.shieldRegenPerSec * dt / 4
          );
        }
      }
    }

    // Wave progression
    if (this.enemies.length === 0 && this.spawnQueue.length === 0 && !this.pendingNextWave) {
      this.pendingNextWave = true;
      this.waveCooldown = 2;
    }
    if (this.pendingNextWave) {
      this.waveCooldown -= dt;
      if (this.waveCooldown <= 0) {
        this.pendingNextWave = false;
        if (this.faction === "mid" && this.round >= 3) {
          // stay at boss round for mid civ until player changes settings
          this.round = 3;
          UIManager.updateRound(this.round);
          this.buildSpawnQueue();
        } else {
          this.round++;
          if (this.round > 3) this.round = 1;
          UIManager.updateRound(this.round);
          this.buildSpawnQueue();
        }
      }
    }
  }

  updateEnemyFacing(enemy, dt, turnRate = 4.2) {
    // Smoothly rotate enemy toward its target angle.
    if (!enemy) return;
    if (enemy.facingAngle == null) {
      enemy.facingAngle = this.computeEnemyTargetAngle(enemy);
    }
    const desired = this.computeEnemyTargetAngle(enemy);
    const diff = shortestAngleDiff(enemy.facingAngle, desired);
    const maxStep = Math.max(0, turnRate) * dt;
    if (Math.abs(diff) <= maxStep) {
      enemy.facingAngle = desired;
    } else {
      enemy.facingAngle += Math.sign(diff) * maxStep;
    }
  }

  updateEnemyBehavior(enemy, dt) {
    if (enemy.behavior === "skirmisher") {
      const dx = this.player.x - enemy.x;
      const dy = this.player.y - enemy.y;
      const dist = Math.hypot(dx, dy) || 1;
      const desired = enemy.preferredRange || 240;
      enemy.glowNormalPhase = ((enemy.glowNormalPhase || 0) + dt * 0.45) % (Math.PI * 2);
      if (dist < desired - 30) {
        enemy.reactionTimer += dt;
        if (enemy.reactionTimer >= (enemy.reactionDelay || 0.3)) {
          const push = (desired - dist) * 0.2;
          enemy.x -= (dx / dist) * push;
          enemy.y -= (dy / dist) * push;
        }
      } else {
        enemy.reactionTimer = Math.max(0, enemy.reactionTimer - dt);
      }
      enemy.aiPhase += dt * 1.2;
      this.updateEnemyFacing(enemy, dt, 4.5);
      return;
    }

    if (enemy.behavior === "laser_grunt") {
      const laser = enemy.laser;
      if (!laser) return;
      if (laser.state === "idle") {
        laser.cooldown -= dt;
        if (laser.cooldown <= 0) {
          laser.state = "warning";
          laser.timer = laser.warning;
          laser.aimAngle = Math.atan2(this.player.y - enemy.y, this.player.x - enemy.x);
        }
      } else if (laser.state === "warning") {
        laser.timer -= dt;
        if (laser.timer <= 0) {
          laser.state = "firing";
          laser.timer = laser.duration;
        }
      } else if (laser.state === "firing") {
        this.applyEnemyLaserDamage(enemy, laser.aimAngle, 10, 260, 28 * dt);
        laser.timer -= dt;
        if (laser.timer <= 0) {
          laser.state = "idle";
          laser.cooldown = 1.3 + Math.random();
        }
      }
      const active = laser.state === "warning" || laser.state === "firing";
      const blendTarget = active ? 1 : 0;
      const blendSpeed = active ? 5 : 2;
      enemy.glowLaserBlend = (enemy.glowLaserBlend || 0) + (blendTarget - (enemy.glowLaserBlend || 0)) * Math.min(1, blendSpeed * dt);
      enemy.glowNormalPhase = ((enemy.glowNormalPhase || 0) + dt * 0.5) % (Math.PI * 2);
      if (active) {
        enemy.glowLaserPhase = ((enemy.glowLaserPhase || 0) + dt * 1.5) % (Math.PI * 2);
      }
      this.updateEnemyFacing(enemy, dt, 3.2);
      return;
    }

    if (enemy.behavior === "dual_miniboss") {
      enemy.turretTimer -= dt;
      if (enemy.turretTimer <= 0) {
        enemy.turretTimer = 0.9;
        const offsets = [-22, 22];
        for (const off of offsets) {
          const aim = Math.atan2(this.player.y - enemy.y, this.player.x - enemy.x);
          const dir = { x: Math.cos(aim), y: Math.sin(aim) };
          const spawnX = enemy.x + (-dir.y) * off;
          const spawnY = enemy.y + dir.x * off;
          this.enemyBullets.push({
            from: "enemy",
            x: spawnX,
            y: spawnY,
            vx: dir.x * 220,
            vy: dir.y * 220,
            radius: 4,
            damage: enemy.damage,
            life: 4
          });
        }
      }
      if (!enemy.chargeLaser) {
        enemy.chargeLaser = { state: "idle", cooldown: 3.0 };
      }
      const charge = enemy.chargeLaser;
      if (charge.state === "idle") {
        charge.cooldown -= dt;
        if (charge.cooldown <= 0) {
          charge.state = "warning";
          charge.timer = 0.6;
          charge.aimAngle = Math.atan2(this.player.y - enemy.y, this.player.x - enemy.x);
        }
      } else if (charge.state === "warning") {
        charge.timer -= dt;
        if (charge.timer <= 0) {
          charge.state = "firing";
          charge.timer = 0.7;
        }
      } else if (charge.state === "firing") {
        this.applyEnemyLaserDamage(enemy, charge.aimAngle, 18, 360, 45 * dt);
        charge.timer -= dt;
        if (charge.timer <= 0) {
          charge.state = "idle";
          charge.cooldown = 3.5;
        }
      }
      return;
    }

    if (enemy.behavior === "spin_miniboss") {
      if (!enemy.spin) {
        enemy.spin = { state: "idle", cooldown: 1.5, warning: 0.7, firing: 0.85 };
        enemy.spinDir = Math.random() > 0.5 ? 1 : -1;
      }
      const spin = enemy.spin;
      const warningSpin = 3.4;
      const firingSpin = 5.6;
      const accel = 18; // rad/s^2 for smoother velocity changes
      if (spin.state === "idle") {
        enemy.glowAnim = (enemy.glowAnim || 0) + dt * 2;
        spin.targetVel = 0;
        spin.cooldown -= dt;
        if (spin.cooldown <= 0) {
          spin.state = "warning";
          spin.timer = spin.warning;
          spin.aimAngle = Math.atan2(this.player.y - enemy.y, this.player.x - enemy.x);
          enemy.spinAngle = spin.aimAngle;
          spin.spinDir = Math.random() > 0.5 ? 1 : -1;
        }
      } else if (spin.state === "warning") {
        spin.targetVel = warningSpin * spin.spinDir;
        enemy.glowAnim = (enemy.glowAnim || 0) + dt * 6;
        spin.timer -= dt;
        // subtle drift toward player while charging
        const desired = Math.atan2(this.player.y - enemy.y, this.player.x - enemy.x);
        spin.aimAngle = spin.aimAngle + shortestAngleDiff(spin.aimAngle, desired) * Math.min(1, 2.5 * dt);
        if (spin.timer <= 0) {
          spin.state = "firing";
          spin.timer = spin.firing;
          enemy.spinAngle = spin.aimAngle;
        }
      } else if (spin.state === "firing") {
        spin.targetVel = firingSpin * spin.spinDir;
        enemy.glowAnim = (enemy.glowAnim || 0) + dt * 9;
        const beamAngle = enemy.spinAngle;
        this.applyEnemyLaserDamage(enemy, beamAngle, 14, this.getLaserRange(), 32 * dt);
        spin.timer -= dt;
        if (spin.timer <= 0) {
          spin.state = "idle";
          spin.cooldown = 1.1 + Math.random() * 0.9;
        }
      }
      // smooth angular velocity toward target
      const diffVel = spin.targetVel - (spin.angularVel || 0);
      const step = Math.sign(diffVel) * accel * dt;
      if (Math.abs(step) >= Math.abs(diffVel)) {
        spin.angularVel = spin.targetVel;
      } else {
        spin.angularVel = (spin.angularVel || 0) + step;
      }
      enemy.spinAngle = (enemy.spinAngle || 0) + (spin.angularVel || 0) * dt;
      enemy.facingAngle = enemy.spinAngle;
      return;
    }

    if (enemy.behavior === "mid_boss") {
      if (!enemy.phaseList) {
        enemy.phaseList = ["torp", "rain", "clamp", "ultimate"];
        enemy.phaseIndex = 0;
      }
      if (!enemy.warnings) enemy.warnings = [];
      if (!enemy.activeBeams) enemy.activeBeams = [];

      enemy.warnings = enemy.warnings.filter(w => {
        if (w.duration) {
          w.timer -= dt;
          return w.timer > 0;
        }
        return true;
      });

      if (enemy.activeBeams.length) {
        for (const beam of enemy.activeBeams) {
          beam.timer -= dt;
          this.applyEnemyLaserDamage(enemy, beam.angle, beam.width, beam.range, beam.damage * dt);
        }
        enemy.activeBeams = enemy.activeBeams.filter(b => b.timer > 0);
      }

      if (enemy.ultimate) {
        const ult = enemy.ultimate;
        if (ult.state === "warning") {
          ult.timer -= dt;
          this.cameraShakeTime = Math.max(this.cameraShakeTime, 0.3);
          if (ult.timer <= 0) {
            ult.state = "firing";
            ult.timer = ult.duration;
          }
        } else if (ult.state === "firing") {
          ult.timer -= dt;
          const width = ult.width;
          const range = this.canvas.height;
          this.applyEnemyLaserDamage(enemy, Math.PI / 2, width, range, ult.damage * dt);
          this.cameraShakeTime = Math.max(this.cameraShakeTime, 0.55);
          if (ult.timer <= 0) {
            enemy.ultimate = null;
            this.advanceMidBossPhase(enemy);
          }
        }
      }

      enemy.summonTimer -= dt;
      if (enemy.summonTimer <= 0) {
        enemy.summonTimer = 7;
        const spawnX = enemy.x + (Math.random() - 0.5) * 220;
        const spawnY = enemy.y + 120;
        this.spawnEnemy({ typeId: "mid_grunt_laser", x: spawnX, y: spawnY, delay: 0 });
      }

      enemy.animTimer = (enemy.animTimer || 0) + dt * 10;
      const currentPhase = enemy.phaseList[enemy.phaseIndex];
      enemy.phaseTimer += dt;

      if (currentPhase === "torp") {
        if (!enemy.phaseData) enemy.phaseData = { fireTimer: 0.5, count: 0 };
        const data = enemy.phaseData;
        data.fireTimer -= dt;
        if (data.fireTimer <= 0) {
          data.fireTimer = 0.7;
          data.count++;
          const aim = Math.atan2(this.player.y - enemy.y, this.player.x - enemy.x);
          const dir = { x: Math.cos(aim), y: Math.sin(aim) };
          const speed = 170;
          this.enemyBullets.push({
            from: "enemy",
            x: enemy.x,
            y: enemy.y + 25,
            vx: dir.x * speed,
            vy: dir.y * speed,
            radius: 6,
            damage: enemy.damage * 1.2,
            life: 6,
            homing: 1.4,
            speed
          });
        }
        if (data.count >= 6) {
          this.advanceMidBossPhase(enemy);
        }
      } else if (currentPhase === "rain") {
        if (!enemy.phaseData) {
          const laneCount = 6;
          const laneWidth = this.canvas.width / laneCount;
          const warnings = [];
          for (let i = 0; i < laneCount; i++) {
            warnings.push({
              type: "lane",
              x: i * laneWidth + laneWidth * 0.1,
              width: laneWidth * 0.8,
              timer: 1.1,
              duration: 1.1
            });
          }
          enemy.warnings = warnings;
          enemy.phaseData = { stage: "warning", timer: 1.1, laneWidth, laneCount, fired: false };
        } else {
          const data = enemy.phaseData;
          if (data.stage === "warning") {
            data.timer -= dt;
            if (data.timer <= 0) {
              data.stage = "firing";
              data.timer = 2.0;
              enemy.warnings = [];
              if (!data.fired) {
                data.fired = true;
                const laneWidth = data.laneWidth;
                for (let i = 0; i < data.laneCount; i++) {
                  const laneX = i * laneWidth + laneWidth / 2;
                  for (let j = 0; j < 3; j++) {
                    this.enemyBullets.push({
                      from: "enemy",
                      x: laneX + (Math.random() - 0.5) * (laneWidth * 0.3),
                      y: enemy.y + 20 - j * 60,
                      vx: 0,
                      vy: 240,
                      radius: 4,
                      damage: enemy.damage * 0.9,
                      life: 5
                    });
                  }
                }
              }
            }
          } else if (data.stage === "firing") {
            data.timer -= dt;
            if (data.timer <= 0) {
              this.advanceMidBossPhase(enemy);
            }
          }
        }
      } else if (currentPhase === "clamp") {
        if (!enemy.phaseData) {
          const center = Math.atan2(this.player.y - enemy.y, this.player.x - enemy.x);
          const startOffset = 0.9;
          const targetOffset = 0.2;
          const angles = [center - startOffset, center + startOffset];
          const targetAngles = [center - targetOffset, center + targetOffset];
          enemy.phaseData = {
            stage: "warning",
            timer: 0.9,
            angles,
            targetAngles,
            spinTime: 1.5,
            rotationSpeed: 1.6
          };
          enemy.warnings = angles.map(angle => ({
            type: "beam",
            angle,
            range: 520,
            timer: 0.9,
            duration: 0.9
          }));
        } else {
          const data = enemy.phaseData;
          if (data.stage === "warning") {
            data.timer -= dt;
            if (data.timer <= 0) {
              data.stage = "spin";
              enemy.warnings = [];
            }
          } else if (data.stage === "spin") {
            data.spinTime -= dt;
            const updatedAngles = [];
            for (let i = 0; i < data.angles.length; i++) {
              const current = data.angles[i];
              const target = data.targetAngles[i];
              const diff = shortestAngleDiff(current, target);
              const step = Math.sign(diff) * data.rotationSpeed * dt;
              if (Math.abs(step) >= Math.abs(diff)) {
                data.angles[i] = target;
              } else {
                data.angles[i] = current + step;
              }
              updatedAngles.push(data.angles[i]);
            }
            enemy.activeBeams = updatedAngles.map(angle => ({
              angle,
              width: 28,
              range: 520,
              timer: dt + 0.05,
              damage: 60
            }));
            const closeEnough = updatedAngles.every((angle, i) => Math.abs(shortestAngleDiff(angle, data.targetAngles[i])) < 0.02);
            if (closeEnough && data.spinTime <= 0) {
              this.advanceMidBossPhase(enemy);
            }
          }
        }
      } else if (currentPhase === "ultimate") {
        if (!enemy.ultimate) {
          enemy.ultimate = {
            state: "warning",
            timer: 2.0,
            length: this.canvas.height,
            width: 140,
            duration: 1.6,
            damage: 140
          };
          this.cameraShakeTime = Math.max(this.cameraShakeTime, 0.6);
        }
      }
    }
  }

  update(dt) {
    if (this.cameraShakeTime > 0) {
      this.cameraShakeTime = Math.max(0, this.cameraShakeTime - dt);
    }
    this.updatePlayer(dt);
    this.updateEnemies(dt);
    updateLaserFx(this.laserFx, this.laser, this.player, dt);
    this.player.disableTimer = this.disableTimer || {};
    this.player.targetingError = this.targetingError || { front: 0, rear: 0 };
    UIManager.updatePlayerBars(this.player, this.laser.energy);
    UIManager.updateCompass(this.player.angle);
    if (this.debugMode) {
      UIManager.updateDebug({
        round: this.round,
        difficulty: this.difficulty,
        faction: this.faction,
        pos: { x: this.player.x, y: this.player.y },
        vel: Math.hypot(this.player.velX, this.player.velY),
        hullRatio: (this.player.hull ?? this.player.hp) / Math.max(1, this.player.maxHull ?? this.player.maxHp),
        shield: this.player.shieldSectors || [0, 0, 0, 0],
        laser: {
          state: this.laser.state,
          timer: this.laser.timer || 0,
          cooldown: this.laser.state === "cooldown" ? this.laser.timer : 0,
          energy: this.laser.energy || 0
        },
        torp: {
          front: this.player.torpAmmoFront,
          rear: this.player.torpAmmoRear,
          frontMax: 12,
          rearMax: 5,
          cdFront: Math.max(0, this.player.torpCooldownFront || 0),
          cdRear: Math.max(0, this.player.torpCooldownRear || 0)
        },
        offline: {
          laser: this.disableTimer?.laser || 0,
          front: this.disableTimer?.torpFront || 0,
          rear: this.disableTimer?.torpRear || 0
        },
        jam: {
          front: this.targetingError?.front || 0,
          rear: this.targetingError?.rear || 0
        },
        invuln: Math.max(0, this.player.invincibleTimer || 0),
        dash: Math.max(0, this.player.dashCooldown || 0),
        debugMode: this.debugMode
      });
    }
  }

  drawPlayer(ctx) {
    const p = this.player;
    const flicker = p.flickerTimer > 0 && (Math.floor(p.flickerTimer * 30) % 2 === 0);
    if (flicker) ctx.globalAlpha = 0.3;
    // shield FX behind the ship
    this.drawShieldFx(ctx);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);

    const sprite = getShipSprite();
    if (sprite) {
      const desiredHeight = 75;
      const scale = desiredHeight / sprite.base.height;
      const width = sprite.base.width * scale;
      ctx.drawImage(sprite.base, -width / 2, -desiredHeight / 2, width, desiredHeight);
      if (sprite.glowFrames && sprite.glowFrames.length) {
        const frames = sprite.glowFrames;
        const normalPhase = (Math.sin(this.glowNormalPhase) + 1) / 2;
        const reserveHigh = Math.min(5, frames.length - 1);
        const normalRange = Math.max(1, frames.length - reserveHigh);
        let baseIdx = Math.min(normalRange - 1, Math.max(0, Math.floor(normalPhase * (normalRange - 1 || 1))));
        let finalIdx = baseIdx;
        if (this.glowLaserBlend > 0) {
          const highStart = Math.max(0, frames.length - reserveHigh);
          let highIdx;
          if ((this.laser.state === "charging" || this.laser.state === "firing") && this.glowLaserPeakTimer < 0.2) {
            highIdx = frames.length - 1;
          } else {
            const highPhase = (Math.sin(this.glowLaserPhase) + 1) / 2;
            const highCount = frames.length - highStart;
            highIdx = highStart + Math.min(highCount - 1, Math.floor(highPhase * highCount));
          }
          finalIdx = Math.round(baseIdx * (1 - this.glowLaserBlend) + highIdx * this.glowLaserBlend);
        }
        finalIdx = Math.max(0, Math.min(frames.length - 1, finalIdx));
        const glowFrame = frames[finalIdx];
        const pulse = 0.75 + 0.25 * normalPhase;
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 1.6 * pulse;
        const outerScale = 1.12;
        ctx.drawImage(
          glowFrame,
          -width * outerScale / 2,
          -desiredHeight * outerScale / 2,
          width * outerScale,
          desiredHeight * outerScale
        );
        ctx.globalAlpha = 1.15 * pulse;
        ctx.drawImage(
          glowFrame,
          -width / 2,
          -desiredHeight / 2,
          width,
          desiredHeight
        );
        ctx.restore();
      }
    } else {
      const grad = ctx.createLinearGradient(0, -20, 0, 22);
      grad.addColorStop(0, "#f5f5f5");
      grad.addColorStop(0.3, "#9fa7b3");
      grad.addColorStop(0.7, "#474c57");
      grad.addColorStop(1, "#161820");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(0, -20);
      ctx.lineTo(10, 10);
      ctx.lineTo(5, 18);
      ctx.lineTo(-5, 18);
      ctx.lineTo(-10, 10);
      ctx.closePath();
      ctx.fill();
    }

    ctx.globalAlpha = 0.7;
    const flameGrad = ctx.createLinearGradient(0, 18, 0, 38);
    flameGrad.addColorStop(0, "rgba(255,220,160,1)");
    flameGrad.addColorStop(1, "rgba(255,80,0,0)");
    ctx.fillStyle = flameGrad;
    ctx.beginPath();
    ctx.moveTo(-6, 20);
    ctx.lineTo(0, 40 + Math.random() * 6);
    ctx.lineTo(6, 20);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
    ctx.globalAlpha = 1;

    // remove old shield overlay; visuals handled elsewhere
  }

  drawShieldSectorUI(ctx) {
    const p = this.player;
    const uiX = 80; // Position from left (increased to fit PORT label)
    const uiY = this.canvas.height - 95; // Position from bottom
    const shipSize = 40; // Size of ship outline
    const barLength = 32; // Length of shield bars
    const barHeight = 6; // Height of shield bars

    ctx.save();
    ctx.translate(uiX, uiY);

    // Draw simple diamond ship shape
    ctx.strokeStyle = "rgba(120, 180, 220, 0.7)";
    ctx.fillStyle = "rgba(60, 90, 130, 0.4)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(shipSize / 2, 0);
    ctx.lineTo(shipSize, shipSize / 2);
    ctx.lineTo(shipSize / 2, shipSize);
    ctx.lineTo(0, shipSize / 2);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();

    // Shield sector labels and bars
    // Match getSectorForPos logic: 0=Right, 1=Bottom, 2=Left, 3=Top
    // But ship faces UP initially, so we need to account for player.angle offset
    // When player.angle = -PI/2 (facing up), getSectorForPos returns:
    // Top (y<0) = sector 3, Right (x>0) = sector 0, Bottom (y>0) = sector 1, Left (x<0) = sector 2
    const maxSector = p.maxShield / 4;
    const sectors = [
      { idx: 3, name: "FWD", x: shipSize / 2, y: -8, barX: shipSize / 2 - barLength / 2, barY: -18, horizontal: true },       // Top = sector 3
      { idx: 0, name: "STB", x: shipSize + 5, y: shipSize / 2 + 3, barX: shipSize + 8, barY: shipSize / 2 - barHeight / 2, horizontal: false },  // Right = sector 0
      { idx: 1, name: "AFT", x: shipSize / 2, y: shipSize + 15, barX: shipSize / 2 - barLength / 2, barY: shipSize + 5, horizontal: true },      // Bottom = sector 1
      { idx: 2, name: "PORT", x: -18, y: shipSize / 2 + 3, barX: -barLength - 8, barY: shipSize / 2 - barHeight / 2, horizontal: false }        // Left = sector 2
    ];

    ctx.font = "8px monospace";

    for (const sector of sectors) {
      const health = p.shieldSectors[sector.idx];
      const ratio = health / maxSector;
      const color = ratio > 0.6 ? "rgba(100, 220, 255" : ratio > 0.3 ? "rgba(255, 200, 100" : "rgba(255, 100, 100";

      // Label
      ctx.fillStyle = "rgba(150, 200, 240, 0.8)";
      ctx.textAlign = "center";
      ctx.fillText(sector.name, sector.x, sector.y + 3);

      // Bar background
      if (sector.horizontal) {
        ctx.fillStyle = "rgba(40, 50, 70, 0.6)";
        ctx.fillRect(sector.barX, sector.barY, barLength, barHeight);
        // Bar fill
        ctx.fillStyle = color + ", 0.85)";
        ctx.fillRect(sector.barX, sector.barY, barLength * ratio, barHeight);
        // Bar border
        ctx.strokeStyle = color + ", 1)";
        ctx.lineWidth = 1;
        ctx.strokeRect(sector.barX, sector.barY, barLength, barHeight);
      } else {
        // Vertical bar
        ctx.fillStyle = "rgba(40, 50, 70, 0.6)";
        ctx.fillRect(sector.barX, sector.barY, barHeight, barLength);
        // Bar fill (from bottom to top)
        const fillHeight = barLength * ratio;
        ctx.fillStyle = color + ", 0.85)";
        ctx.fillRect(sector.barX, sector.barY + barLength - fillHeight, barHeight, fillHeight);
        // Bar border
        ctx.strokeStyle = color + ", 1)";
        ctx.lineWidth = 1;
        ctx.strokeRect(sector.barX, sector.barY, barHeight, barLength);
      }
    }

    ctx.restore();
  }

  drawEnemies(ctx) {
    const mod = DIFFICULTY_MOD[this.difficulty];
    for (const e of this.enemies) {
      ctx.save();
      ctx.translate(e.x, e.y);
      let usedCustomSprite = false;
      if (e.behavior === "mid_boss") {
        usedCustomSprite = this.drawMidBossSprite(ctx, e);
      } else if (e.behavior === "spin_miniboss") {
        usedCustomSprite = this.drawSpinMiniboss(ctx, e);
      } else if (e.typeId === "mid_grunt_skirmisher" || e.typeId === "mid_grunt_laser") {
        usedCustomSprite = this.drawMidGlow(ctx, e);
      }
      if (!usedCustomSprite) {
        const grad = ctx.createLinearGradient(-10, -10, 10, 12);
        grad.addColorStop(0, "#f1f5ff");
        grad.addColorStop(0.4, "#7d8ba5");
        grad.addColorStop(1, "#1b1d26");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(0, -14);
        ctx.lineTo(12, 6);
        ctx.lineTo(0, 14);
        ctx.lineTo(-12, 6);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = "rgba(255,180,80,0.9)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, 10, 0, Math.PI * 2);
        ctx.stroke();
      }

      const baseHp = ENEMY_STATS[e.typeId].hp * mod.hp;
      const frac = e.hp / baseHp;
      if (frac < 0.3) {
        const t = performance.now() / 100;
        const a = 0.4 + 0.4 * Math.abs(Math.sin(t));
        ctx.globalAlpha = a;
        ctx.strokeStyle = "rgba(255,80,80,1)";
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.arc(0, 0, 13, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();

      if (e.laser && e.laser.state && e.laser.state !== "idle" && e.laser.aimAngle != null) {
        this.drawEnemyLaser(ctx, e, e.laser, e.laser.state === "warning");
      }
      if (e.chargeLaser && e.chargeLaser.state && e.chargeLaser.state !== "idle" && e.chargeLaser.aimAngle != null) {
        this.drawEnemyLaser(ctx, e, e.chargeLaser, e.chargeLaser.state === "warning", 18, 360);
      }
      if (e.behavior === "mid_boss") {
        this.drawMidBossTelegraph(ctx, e);
      }
    }
  }

  drawBullets(ctx) {
    for (const b of this.playerBullets) {
      ctx.save();
      ctx.translate(b.x, b.y);
      const ang = b.angle ?? Math.atan2(b.vy, b.vx);
      ctx.rotate(ang);
      const len = 28;
      const halfLen = len / 2;
      const halfWidth = 4;
      const gradOuter = ctx.createLinearGradient(-halfLen, 0, halfLen, 0);
      gradOuter.addColorStop(0, "rgba(130,90,255,0)");
      gradOuter.addColorStop(0.5, "rgba(210,170,255,0.7)");
      gradOuter.addColorStop(1, "rgba(130,90,255,0)");
      ctx.fillStyle = gradOuter;
      ctx.globalAlpha = 0.7;
      drawRoundedRect(ctx, -halfLen, -halfWidth - 2, len, (halfWidth + 2) * 2, 6);
      ctx.fill();

      const gradCore = ctx.createLinearGradient(-halfLen, 0, halfLen, 0);
      gradCore.addColorStop(0, "rgba(255,255,255,0.2)");
      gradCore.addColorStop(0.5, "rgba(245,230,255,1)");
      gradCore.addColorStop(1, "rgba(200,180,255,0.5)");
      ctx.fillStyle = gradCore;
      ctx.globalAlpha = 1;
      drawRoundedRect(ctx, -halfLen, -halfWidth, len, halfWidth * 2, 4);
      ctx.fill();

      ctx.globalAlpha = 0.8;
      ctx.fillStyle = "rgba(255,220,200,0.9)";
      ctx.beginPath();
      ctx.arc(-halfLen, 0, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    for (const b of this.enemyBullets) {
      ctx.save();
      ctx.fillStyle = "#ff9e5f";
      ctx.shadowColor = "#ff9e5f";
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  drawLaser(ctx) {
    const laser = this.laser;
    if (!["charging", "firing", "release"].includes(laser.state)) return;
    const player = this.player;
    const fx = this.laserFx;
    drawLaserEffect(ctx, player, laser, fx);
  }

  render() {
    Renderer.drawBackground(this.ctx, this.canvas.width, this.canvas.height, this.player);
    const shakeX = this.cameraShakeTime > 0 ? (Math.random() - 0.5) * 4 : 0;
    const shakeY = this.cameraShakeTime > 0 ? (Math.random() - 0.5) * 4 : 0;
    this.ctx.save();
    this.ctx.translate(shakeX, shakeY);
    this.drawLaser(this.ctx);
    this.drawBullets(this.ctx);
    this.drawEnemies(this.ctx);
    this.drawAutoDebug(this.ctx);
    this.drawPlayer(this.ctx);
    this.drawRemotePlayer(this.ctx);

    this.ctx.restore();

    // Draw shield sector UI (after camera shake restore)
    this.drawShieldSectorUI(this.ctx);
  }

  setRemotePlayer(snapshot) {
    if (!snapshot) {
      this.remote = null;
      return;
    }
    const radius = snapshot.radius || GAME_CONFIG.player.radius || 18;
    this.remote = { radius, ...snapshot };
  }

  drawRemotePlayer(ctx) {
    if (!this.remote) return;
    const r = this.remote;
    const x = r.x || 0;
    const y = r.y || 0;
    const angle = r.angle || 0;
    const radius = r.radius || 18;
    const color = r.color || "#e04545";
    const sprite = Assets.get("player.ship");

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    if (sprite) {
      const size = radius * 3;
      ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
      ctx.globalCompositeOperation = "source-atop";
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = color;
      ctx.fillRect(-size / 2, -size / 2, size, size);
      ctx.globalCompositeOperation = "source-over";
    } else {
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      const a = angle - Math.PI / 2;
      ctx.lineTo(Math.cos(a) * radius * 1.4, Math.sin(a) * radius * 1.4);
      ctx.stroke();
    }

    if (r.nickname) {
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = "#fff";
      ctx.font = "12px system-ui";
      ctx.fillText(r.nickname, -radius, -radius - 10);
    }
    ctx.restore();
  }

  drawAutoDebug(ctx) {
    if (!this.autoMode || !this.autoTarget || !this.enemies.includes(this.autoTarget)) return;
    const target = this.autoTarget;
    ctx.save();
    ctx.strokeStyle = "rgba(255,80,80,0.8)";
    ctx.fillStyle = "rgba(255,80,80,0.35)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(target.x, target.y, target.radius + 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fill();

    // line from player to target
    ctx.strokeStyle = "rgba(255,200,80,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(this.player.x, this.player.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();

    // label
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "16px monospace";
    const dist = Math.round(Math.hypot(target.x - this.player.x, target.y - this.player.y));
    ctx.fillText(`LOCK: ${target.typeId} | hp=${Math.round(target.hp)} | dist=${dist}`, target.x + 18, target.y - 12);
    ctx.restore();
  }

  applyEnemyLaserDamage(enemy, angle, width, range, damage) {
    const effectiveRange = this.getLaserRange();
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const px = this.player.x - enemy.x;
    const py = this.player.y - enemy.y;
    const proj = px * dirX + py * dirY;
    if (proj < 0 || proj > effectiveRange) return;
    const lx = dirX * proj;
    const ly = dirY * proj;
    const dist = Math.hypot(px - lx, py - ly);
    if (dist <= this.player.radius + width) {
      this.applyDamageToPlayer(damage, dirX, dirY);
    }
  }

  drawEnemyLaser(ctx, enemy, laser, warning = false, width = 10, range = 260) {
    // 視覺上永?�貫穿整張地?��??�全局射�?；實?�傷害�??�由 applyEnemyLaserDamage ??range ?�制
    const effectiveRange = this.getLaserRange();
    const dirX = Math.cos(laser.aimAngle);
    const dirY = Math.sin(laser.aimAngle);
    const endX = enemy.x + dirX * effectiveRange;
    const endY = enemy.y + dirY * effectiveRange;
    ctx.save();
    ctx.lineCap = "round";
    if (warning) {
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = "rgba(255,140,80,0.85)";
      ctx.lineWidth = width * 0.7;
      ctx.beginPath();
      ctx.moveTo(enemy.x, enemy.y);
      ctx.lineTo(endX, endY);
      ctx.stroke();
    } else {
      const base = width || 10;
      let multipliers;
      let colors;
      if (base > 25) {
        // Boss 超�?激?��?外�?深�?，內?�亮橘�??��?純白，避?��??��?�?        multipliers = [2.6, 2.2, 1.9, 1.6, 1.3, 1.05, 0.8, 0.6];
        colors = [
          "rgba(110,25,10,0.4)",
          "rgba(145,35,15,0.45)",
          "rgba(185,55,25,0.5)",
          "rgba(215,80,35,0.6)",
          "rgba(240,110,50,0.7)",
          "rgba(255,160,80,0.8)",
          "rgba(255,200,130,0.85)",
          "rgba(255,235,190,0.9)"
        ];
      } else if (base > 14) {
        multipliers = [2.2, 1.9, 1.6, 1.3, 1.1, 0.9, 0.7, 0.55, 0.4];
        colors = [
          "rgba(120,30,10,0.35)",
          "rgba(150,40,20,0.4)",
          "rgba(180,55,30,0.45)",
          "rgba(210,70,35,0.5)",
          "rgba(235,95,45,0.6)",
          "rgba(255,130,60,0.7)",
          "rgba(255,170,90,0.8)",
          "rgba(255,210,150,0.9)",
          "rgba(255,240,210,0.95)"
        ];
      } else {
        multipliers = [1.8, 1.5, 1.3, 1.1, 0.9, 0.7, 0.5, 0.35];
        colors = [
          "rgba(130,40,20,0.4)",
          "rgba(170,55,30,0.45)",
          "rgba(205,75,40,0.5)",
          "rgba(235,100,55,0.6)",
          "rgba(255,140,75,0.7)",
          "rgba(255,180,110,0.8)",
          "rgba(255,215,165,0.9)",
          "rgba(255,240,210,0.95)"
        ];
      }
      const count = Math.min(multipliers.length, colors.length);
      for (let i = 0; i < count; i++) {
        ctx.strokeStyle = colors[i];
        ctx.globalAlpha = 1;
        ctx.lineWidth = base * multipliers[i];
        ctx.beginPath();
        ctx.moveTo(enemy.x, enemy.y);
        ctx.lineTo(endX, endY);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawMidBossTelegraph(ctx, boss) {
    if (boss.warnings) {
      for (const warn of boss.warnings) {
        const alpha = warn.duration ? warn.timer / warn.duration : 1;
        ctx.save();
        ctx.globalAlpha = 0.2 + 0.5 * Math.max(0, alpha);
        if (warn.type === "lane") {
          ctx.fillStyle = "rgba(255,170,100,0.5)";
          ctx.fillRect(warn.x, boss.y + 20, warn.width, this.canvas.height - boss.y);
        } else if (warn.type === "beam") {
          const dummy = { aimAngle: warn.angle };
          this.drawEnemyLaser(ctx, { x: boss.x, y: boss.y }, dummy, true, 18, warn.range || 520);
        }
        ctx.restore();
      }
    }
    if (boss.activeBeams && boss.activeBeams.length) {
      for (const beam of boss.activeBeams) {
        const dummy = { aimAngle: beam.angle };
        this.drawEnemyLaser(ctx, boss, dummy, false, beam.width, beam.range);
      }
    }
    if (boss.ultimate) {
      const ult = boss.ultimate;
      const dummyLaser = { aimAngle: Math.PI / 2 };
      const isWarning = ult.state === "warning";
      // Use layered laser style for the ultra thick beam
      this.drawEnemyLaser(
        ctx,
        boss,
        dummyLaser,
        isWarning,
        ult.width,
        ult.length
      );
    }
  }

  advanceMidBossPhase(enemy) {
    if (!enemy.phaseList) return;
    enemy.phaseIndex = (enemy.phaseIndex + 1) % enemy.phaseList.length;
    enemy.phaseTimer = 0;
    enemy.phaseData = null;
    enemy.warnings = [];
    enemy.activeBeams = [];
    enemy.ultimate = null;
  }

  updateAutoMode(dt) {
    if (!this.autoInput) {
      this.autoInput = { thrust: 0, dash: false, torp: false, laser: false, targetAngle: null, moveAngle: null };
    }
    const ctrl = this.autoInput;
    ctrl.thrust = 0;
    ctrl.dash = false;
    ctrl.torp = false;
    ctrl.laser = false;
    ctrl.targetAngle = null;
    ctrl.moveAngle = null;
    const player = this.player;
    const enemies = this.enemies;
    if (!enemies.length) {
      ctrl.targetAngle = player.angle;
      return;
    }

    // lock target until it dies/leaves; prefer boss/miniboss first
    if (!this.autoTarget || !enemies.includes(this.autoTarget) || this.autoTarget.hp <= 0) {
      this.autoTarget = this.pickAutoTarget();
    }
    const target = this.autoTarget || this.findClosestEnemy();

    // straight pursuit toward target for quicker closes
    const toTarget = { x: target.x - player.x, y: target.y - player.y };
    const targetDist = Math.hypot(toTarget.x, toTarget.y) || 1;
    toTarget.x /= targetDist; toTarget.y /= targetDist;

    ctrl.targetAngle = angleFromVector(toTarget.x, toTarget.y);

    // 移�?：若已在?�想距離?��?住�??��??��??��??��??��??�?�步
    const idealMin = 140;
    const idealMax = 260;
    if (targetDist > idealMax) {
      ctrl.moveAngle = ctrl.targetAngle;
      ctrl.thrust = 1;
      ctrl.dash = this.player.dashCooldown <= 0; // 快速貼�?    } else if (targetDist < idealMin) {
      ctrl.moveAngle = ctrl.targetAngle + Math.PI; // ?��?
      ctrl.thrust = 0.8;
    } else {
      ctrl.moveAngle = null; // ?��?輸出
      ctrl.thrust = 0;
    }

    // offense
    ctrl.torp = this.player.torpCooldown <= 0 && this.player.torpAmmo > 0.5;
    ctrl.laser = true; // 永�??��??��?輸出
  }

  pickAutoTarget() {
    // boss > 小頭目 > 其他
    let candidate = null;
    for (const e of this.enemies) {
      if (e.typeId.includes("boss")) {
        candidate = e;
        break;
      }
      if (e.behavior === "spin_miniboss" || e.behavior === "dual_miniboss") {
        candidate = e;
      }
    }
    return candidate || this.findClosestEnemy();
  }

  findClosestEnemy(maxDist = Infinity) {
    let closest = null;
    let best = maxDist;
    for (const enemy of this.enemies) {
      const dx = enemy.x - this.player.x;
      const dy = enemy.y - this.player.y;
      const dist = Math.hypot(dx, dy);
      if (dist < best) {
        best = dist;
        closest = enemy;
      }
    }
    return closest;
  }

  applyAimAssist(angle) {
    const target = this.findClosestEnemy(600);
    if (!target) return angle;
    const targetAngle = angleFromVector(target.x - this.player.x, target.y - this.player.y);
    const diff = shortestAngleDiff(angle, targetAngle);
    const threshold = this.laser.state === "firing" ? 45 * Math.PI / 180 : 28 * Math.PI / 180;
    const factor = this.laser.state === "firing" ? 0.8 : 0.45;
    if (Math.abs(diff) < threshold) {
      return angle + diff * factor;
    }
    return angle;
  }

  drawMidGlow(ctx, enemy) {
    const frames = getMidGlowFrames();
    if (!frames.length) return false;
    const normalPhase = (Math.sin(enemy.glowNormalPhase || 0) + 1) / 2;
    const reserveHigh = Math.min(4, Math.max(0, frames.length - 1));
    const normalRange = Math.max(1, frames.length - reserveHigh);
    let baseIdx = normalRange > 1
      ? Math.min(normalRange - 1, Math.max(0, Math.floor(normalPhase * (normalRange - 1))))
      : 0;
    let finalIdx = baseIdx;
    const blend = enemy.glowLaserBlend || 0;
    if (blend > 0) {
      const highStart = Math.max(0, frames.length - reserveHigh);
      let highIdx;
      const isLaserPeak =
        enemy.laser &&
        (enemy.laser.state === "warning" || enemy.laser.state === "firing") &&
        (enemy.glowLaserPhase || 0) < 0.2;
      if (isLaserPeak) {
        highIdx = frames.length - 1;
      } else {
        const highPhase = (Math.sin(enemy.glowLaserPhase || 0) + 1) / 2;
        const highCount = Math.max(1, frames.length - highStart);
        highIdx = highStart + Math.min(highCount - 1, Math.floor(highPhase * highCount));
      }
      finalIdx = Math.round(baseIdx * (1 - blend) + highIdx * blend);
    }
    finalIdx = Math.max(0, Math.min(frames.length - 1, finalIdx));
    const glowFrame = frames[finalIdx];
    if (!glowFrame) return false;

    const maxDim = Math.max(glowFrame.width, glowFrame.height) || 1;
    const scale = ((enemy.radius * 2) / maxDim) / 1.5; // Scaled down by 1.5x
    const drawW = glowFrame.width * scale;
    const drawH = glowFrame.height * scale;
    enemy.spriteHeight = drawH;

    const baseAlpha = 0.75 + 0.25 * normalPhase;
    const angle = this.getEnemyFacingAngle(enemy);
    ctx.save();
    ctx.rotate(angle);
    ctx.globalAlpha = baseAlpha;
    ctx.drawImage(glowFrame, -drawW / 2, -drawH / 2, drawW, drawH);
    if (blend > 0.15) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = Math.min(1, 0.35 + blend * 0.8);
      ctx.drawImage(glowFrame, -drawW / 2, -drawH / 2, drawW, drawH);
    }
    ctx.restore();
    return true;
  }

  drawSpinMiniboss(ctx, enemy) {
    const frames = getSpinBossFrames();
    if (!frames.length) return false;
    const angle = enemy.spinAngle || 0;
    const anim = enemy.glowAnim || 0;
    const idx = Math.floor(anim) % frames.length;
    const frame = frames[idx];
    const sprite = frame.canvas;
    const maxDim = Math.max(sprite.width, sprite.height) || 1;
    const scale = ((enemy.radius * 3.0) / maxDim) / 1.5; // Scaled down by 1.5x
    const drawW = sprite.width * scale;
    const drawH = sprite.height * scale;
    ctx.save();
    ctx.rotate(angle);
    const active = enemy.spin && (enemy.spin.state === "warning" || enemy.spin.state === "firing");
    if (active) {
      ctx.shadowColor = "rgba(120,200,255,0.9)";
      ctx.shadowBlur = 24;
    }
    ctx.drawImage(
      sprite,
      -drawW / 2 - frame.offsetX * scale,
      -drawH / 2 - frame.offsetY * scale,
      drawW,
      drawH
    );
    if (enemy.spin && enemy.spin.state === "firing") {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.7;
      ctx.drawImage(sprite, -drawW / 2, -drawH / 2, drawW, drawH);
    }
    ctx.restore();
    return true;
  }

  getEnemyFacingAngle(enemy) {
    if (enemy.facingAngle == null) {
      enemy.facingAngle = this.computeEnemyTargetAngle(enemy);
    }
    return enemy.facingAngle;
  }

  registerShieldHit(dirX, dirY, damage = 10) {
    const fx = this.shieldFx;
    if (!fx.hits) fx.hits = [];
    fx.hitTimer = 0.25;
    const len = Math.hypot(dirX, dirY) || 1;
    const nx = dirX / len;
    const ny = dirY / len;
    fx.hitAngle = Math.atan2(ny, nx); // align impact toward incoming direction
    const sprites = getShieldHitSprites();
    const choice = sprites[Math.floor(Math.random() * Math.max(1, sprites.length))] || null;
    fx.hitSprite = choice;
    if (!fx.baseSprite) fx.baseSprite = choice;
    fx.flashStrength = Math.max(fx.flashStrength || 0, 0.9);
    fx.flashPhase = 0;

    // 記錄擊中點給六角護盾特效
    const R_OUT = this.player.radius * 6;
    const angle = fx.hitAngle;
    const ix = Math.cos(angle) * R_OUT;
    const iy = Math.sin(angle) * R_OUT;
    const strength = Math.max(0.5, Math.min(2, damage / 20));
    const speed = 1.6 + (strength - 1) * 1.0; // faster dissipation, stronger hit = much quicker
    fx.hits.push({ angle, ix, iy, time: performance.now(), strength, speed });

    fx.hitFragments = fx.hitFragments || [];
    for (let i = 0; i < 14; i++) {
      const ang = angle + (Math.random() - 0.5) * 0.6;
      const spd = (220 + Math.random() * 140) * speed;
      fx.hitFragments.push({
        x: ix,
        y: iy,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        life: 0.35 + Math.random() * 0.25,
        size: 6 + Math.random() * 6
      });
    }
  }

  triggerShieldBreak() {
    const fx = this.shieldFx;
    if (!fx) return;
    const p = this.player;
    const now = performance.now();
    const radius = Math.max(70, p.radius * 7);
    const hexSize = Math.max(10, p.radius * 1.4);
    const sqrt3 = Math.sqrt(3);
    const range = Math.ceil(radius / hexSize);
    const hexGrid = [];
    for (let q = -range; q <= range; q++) {
      for (let r = -range; r <= range; r++) {
        const x = hexSize * (sqrt3 * q + (sqrt3 / 2) * r);
        const y = hexSize * (1.5 * r);
        const d = Math.hypot(x, y);
        if (d <= radius) hexGrid.push({ x, y });
      }
    }

    const exploding = hexGrid.map(h => ({
      x: h.x,
      y: h.y,
      size: hexSize * (0.9 + Math.random() * 0.3),
      angle: Math.atan2(h.y, h.x) + (Math.random() - 0.5) * 0.6,
      speed: (2 + Math.random() * 4) * (radius / 90),
      rot: Math.random() * Math.PI,
      rotSpeed: (Math.random() - 0.5) * 2.2,
      life: 1
    }));

    const cracks = [];
    const crackCount = 16;
    for (let i = 0; i < crackCount; i++) {
      const ang = Math.random() * Math.PI * 2;
      const branch = 4 + Math.floor(Math.random() * 3);
      const pts = [];
      for (let j = 0; j < branch; j++) {
        const a = ang + (Math.random() - 0.5) * 0.8;
        const d = radius * (0.55 + Math.random() * 1.0);
        pts.push({ x: Math.cos(a) * d, y: Math.sin(a) * d });
      }
      cracks.push({ ix: 0, iy: 0, points: pts, time: now });
    }

    const shards = [];
    const shardCount = 70;
    for (let i = 0; i < shardCount; i++) {
      const ang = Math.random() * Math.PI * 2;
      const baseSpeed = (4 + Math.random() * 4) * (radius / 90);
      shards.push({
        x: 0,
        y: 0,
        prevX: 0,
        prevY: 0,
        angle: ang,
        speed: baseSpeed,
        life: 1
      });
    }

    fx.break = {
      active: true,
      start: now,
      lastTime: now,
      originX: p.x,
      originY: p.y,
      radius,
      hexSize,
      hexGrid,
      exploding,
      shards,
      cracks,
      coreFlash: 1
    };
  }

  drawMidBossSprite(ctx, enemy) {
    const bodyFrames = getMidBossFrames();
    const partFrames = getMidBossPartFrames();
    if (!bodyFrames.length) return false;
    const bodyIdx = Math.floor(enemy.animTimer || 0) % bodyFrames.length;
    const body = bodyFrames[bodyIdx];
    const maxDim = Math.max(body.canvas.width, body.canvas.height) || 1;
    // 保�?比�?，避?��?�?    const scale = 0.9 / 1.5; // Scaled down by 1.5x
    ctx.save();
    ctx.rotate(enemy.facingAngle || 0);
    ctx.drawImage(
      body.canvas,
      -body.canvas.width * scale / 2,
      -body.canvas.height * scale / 2,
      body.canvas.width * scale,
      body.canvas.height * scale
    );
    if (partFrames.length) {
      const partIdx = Math.floor((enemy.animTimer || 0) * 1.2) % partFrames.length;
      const part = partFrames[partIdx];
      const partScale = scale * 0.9; // 翼炮縮小以貼合機體比例
      const baseW = midBossMaxSize ? midBossMaxSize.w : body.canvas.width;
      const baseH = midBossMaxSize ? midBossMaxSize.h : body.canvas.height;
      const offsetX = baseW * 0.5 * scale;
      const offsetY = baseH * 0.2 * scale;
      const drawPart = (side) => {
        ctx.save();
        ctx.translate(offsetX * side, offsetY);
        ctx.drawImage(
          part.canvas,
          -part.canvas.width * partScale / 2,
          -part.canvas.height * partScale / 2,
          part.canvas.width * partScale,
          part.canvas.height * partScale
        );
        ctx.restore();
      };
      drawPart(1);
      drawPart(-1);
    }
    ctx.restore();
    return true;
  }

  drawShieldFx(ctx) {
    const p = this.player;
    const fx = this.shieldFx;
    if (!fx) return;
    if (!fx.hits) fx.hits = [];

    if (fx.break && fx.break.active) {
      this.drawShieldBreak(ctx);
    }

    // Check if any shield sector has health (but allow break waves to render)
    const hasShield = p.shieldSectors && p.shieldSectors.some(s => s > 0);
    const hasBreakWave = fx.breakWaves && fx.breakWaves.length > 0;
    if (!hasShield && !hasBreakWave) return;

    const now = performance.now();
    const WAVE_DURATION = 1500; // ms

    // 清理舊的擊中記錄
    fx.hits = fx.hits.filter(h => now - h.time <= WAVE_DURATION);

    // 如果沒有最近的擊中且沒有破裂波，不顯示護盾
    if (fx.hits.length === 0 && !hasBreakWave) return;

    const R_OUT = p.radius * 4;
    const HEX = p.radius * 0.74;
    const sqrt3 = Math.sqrt(3);
    const RANGE = Math.ceil(R_OUT / HEX) + 2;

    ctx.save();
    ctx.translate(p.x, p.y);

    // Background radial gradient
    ctx.save();
    const bg = ctx.createRadialGradient(0, 0, 0, 0, 0, R_OUT);
    bg.addColorStop(0, "rgba(20, 30, 60, 0.7)");
    bg.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(0, 0, R_OUT, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const drawHex = (x, y, s) => {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3 + Math.PI / 6;
        const px = x + s * Math.cos(a);
        const py = y + s * Math.sin(a);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    };

    const getSectorForPos = (x, y) => {
      const angle = Math.atan2(y, x);
      let relAngle = angle - p.angle;
      while (relAngle < 0) relAngle += Math.PI * 2;
      while (relAngle >= Math.PI * 2) relAngle -= Math.PI * 2;

      if (relAngle < Math.PI / 4 || relAngle >= 7 * Math.PI / 4) return 0;
      if (relAngle >= Math.PI / 4 && relAngle < 3 * Math.PI / 4) return 1;
      if (relAngle >= 3 * Math.PI / 4 && relAngle < 5 * Math.PI / 4) return 2;
      return 3;
    };

    const maxSector = p.maxShield / 4;
    // 微抖動與色帶偏移
    const jitterX = (Math.random() - 0.5) * 2;
    const jitterY = (Math.random() - 0.5) * 2;
    const bandShift = Math.sin(now * 0.0017) * 0.08;
    const bandShift2 = Math.cos(now * 0.0013) * 0.1;

    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, R_OUT, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    let hexCount = 0; // 調試計數器

    for (let q = -RANGE; q <= RANGE; q++) {
      for (let r = -RANGE; r <= RANGE; r++) {
        const x = HEX * (sqrt3 * q + (sqrt3 / 2) * r) + jitterX;
        const y = HEX * (1.5 * r) + jitterY;
        const d = Math.sqrt(x * x + y * y);

        if (d > R_OUT) continue;

        const sectorIdx = getSectorForPos(x, y);
        const sectorHealth = p.shieldSectors[sectorIdx];
        const sectorRatio = sectorHealth / maxSector;

        if (sectorHealth <= 0.01) continue;

        // Check if this hex should be displayed based on ripple waves
        let shouldDisplay = false;
        let totalBrightness = 0;

        for (const hit of fx.hits) {
          // Only show hexes in the hit sector
          if (hit.sector !== sectorIdx) continue;

          const dt = now - hit.time;
          const elapsed = dt / 1000;
          const WAVE_DURATION = 1.5;
          if (elapsed > WAVE_DURATION) continue;
          const fade = 1 - (elapsed / WAVE_DURATION);


          // Distance from hex to impact point
          const distFromImpact = Math.hypot(x - hit.ix, y - hit.iy);

          // Ripple wave effect
          const waveSpeed = 200;
          const waveRadius = elapsed * waveSpeed;
          const waveThickness = 50;
          
          if (distFromImpact < waveRadius - waveThickness) continue;
          if (distFromImpact > waveRadius + waveThickness) continue;
          
          shouldDisplay = true;

          const distToWaveFront = Math.abs(distFromImpact - waveRadius);
          let brightness = 1 - (distToWaveFront / waveThickness);
          brightness = Math.max(0, Math.min(1, brightness)) * 0.7 + 0.2;

          const distToEdge = R_OUT - d;
          if (distToEdge < 15) {
            brightness *= 1 + (1 - distToEdge / 15) * 0.5;
          }

          brightness *= fade;
          totalBrightness += brightness;
        }

        if (!shouldDisplay || totalBrightness < 0.05) continue;

        totalBrightness = Math.min(1, totalBrightness);

        // Palette-based color with slight drift within same palette bucket
        const colorAlpha = 0.2 + totalBrightness * 0.8;
        ctx.strokeStyle = getPaletteColor(sectorRatio, colorAlpha);
        ctx.lineWidth = 1.2;
        drawHex(x, y, HEX);
        ctx.stroke();
        hexCount++; // 計數

        // Add glow for high brightness
        if (totalBrightness > 0.7) {
          ctx.strokeStyle = `rgba(255, 255, 255, ${(totalBrightness - 0.7) * colorAlpha})`;
          ctx.lineWidth = 0.8;
          drawHex(x, y, HEX * 0.9);
          ctx.stroke();
        }
      }
    }

    // Color band overlay using palette
    ctx.save();
    ctx.globalAlpha = 0.08;
    const gradBand = ctx.createLinearGradient(-R_OUT, -R_OUT, R_OUT, R_OUT);
    gradBand.addColorStop(0, getPaletteColor(0.1, 0.8));
    gradBand.addColorStop(0.5 + bandShift, getPaletteColor(0.5, 0.5));
    gradBand.addColorStop(1, getPaletteColor(0.9, 0.7));
    ctx.fillStyle = gradBand;
    ctx.beginPath();
    ctx.arc(0, 0, R_OUT, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Flicker noise points
    ctx.save();
    for (let i = 0; i < 24; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.random() * R_OUT;
      const px = Math.cos(ang) * rad + jitterX;
      const py = Math.sin(ang) * rad + jitterY;
      const lifePulse = Math.random() * 0.6 + 0.3;
      ctx.fillStyle = `rgba(255,255,255,${lifePulse * 0.3})`;
      ctx.fillRect(px - 1, py - 1, 2, 2);
    }
    ctx.restore();

    console.log('Drew', hexCount, 'hexagons'); // 調試輸出

    ctx.restore();

    // Draw circular impact waves (only for sectors that still have shield)
    for (const hit of fx.hits) {
      if (hit.sector != null && p.shieldSectors && p.shieldSectors[hit.sector] <= 0) {
        continue; // sector broken, no wave propagation
      }
      const dt = now - hit.time;
      const t = Math.min(1, dt / WAVE_DURATION);
      const fade = 1 - t;

      // Skip if sector broken (safety)
      if (hit.sector != null && p.shieldSectors && p.shieldSectors[hit.sector] <= 0) {
        continue;
      }

      // Sector-limited arc for wave
      const sectorAngles = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
      const halfSpan = Math.PI / 4; // 90 deg sector half-span
      const baseAng = sectorAngles[hit.sector ?? 0] + p.angle;
      const spanScale = p.shieldSectors && hit.sector != null
        ? Math.max(0.35, Math.min(1, p.shieldSectors[hit.sector] / (p.maxShield / 4)))
        : 1;
      const span = halfSpan * spanScale;

      const maxR = R_OUT * 1.3;
      const r = 20 + maxR * t * (0.8 + 0.4 * spanScale);
      const thickness = 26 * (0.6 + 0.4 * spanScale);
      const innerR = Math.max(0, r - thickness);
      const outerR = r + thickness;

      const x0 = hit.ix;
      const y0 = hit.iy;

      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, R_OUT, baseAng - span, baseAng + span);
      ctx.arc(0, 0, 0, baseAng + span, baseAng - span, true);
      ctx.closePath();
      ctx.clip();

      // Palette-based multi-color wave with per-hit offset for more variety
      const tShift = (hit.colorT || 0) * 0.4;
      const g = ctx.createRadialGradient(x0, y0, innerR, x0, y0, outerR);
      g.addColorStop(0.0, getPaletteColor(Math.min(0.95, 0.05 + tShift), 0.9 * fade));
      g.addColorStop(0.3, getPaletteColor(Math.min(0.95, 0.25 + tShift), 0.72 * fade));
      g.addColorStop(0.55, getPaletteColor(Math.min(0.95, 0.5 + tShift * 0.8), 0.55 * fade));
      g.addColorStop(0.8, getPaletteColor(Math.min(0.95, 0.75 + tShift * 0.6), 0.38 * fade));
      g.addColorStop(1.0, `rgba(0, 0, 0, 0)`);

      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x0, y0, outerR, baseAng - span, baseAng + span);
      ctx.arc(x0, y0, innerR, baseAng + span, baseAng - span, true);
      ctx.closePath();
      ctx.fill();

      // 疊加數層同色系噪聲環，增加豐富度但不跳色
      for (let n = 0; n < 4; n++) {
        const jitterR = (Math.random() - 0.5) * 18;
        const rA = Math.max(0, r + jitterR - 8);
        const rB = rA + 12 + Math.random() * 12;
        const colorAlpha = 0.18 * fade;
        const t1 = Math.min(0.95, 0.1 + n * 0.15 + tShift * 0.2);
        const t2 = Math.min(0.95, t1 + 0.12);
        const rGrad = ctx.createRadialGradient(x0, y0, rA, x0, y0, rB);
        rGrad.addColorStop(0, getPaletteColor(t1, colorAlpha));
        rGrad.addColorStop(1, getPaletteColor(t2, colorAlpha * 0.9));
        ctx.fillStyle = rGrad;
        ctx.beginPath();
        ctx.arc(x0, y0, rB, baseAng - span, baseAng + span);
        ctx.arc(x0, y0, rA, baseAng + span, baseAng - span, true);
        ctx.closePath();
        ctx.fill();
      }

      // Wide soft bloom (保持原有的柔光效果，但仍受扇區裁切)
      const bloomInner = innerR * 0.6;
      const bloomOuter = outerR * 1.35;
      const bloom = ctx.createRadialGradient(x0, y0, bloomInner, x0, y0, bloomOuter);
      bloom.addColorStop(0, getPaletteColor(Math.min(0.95, 0.15 + tShift), 0.32 * fade));
      bloom.addColorStop(1, `rgba(0,0,0,0)`);
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(x0, y0, bloomOuter, baseAng - span, baseAng + span);
      ctx.arc(x0, y0, bloomInner, baseAng + span, baseAng - span, true);
      ctx.closePath();
      ctx.fill();

      ctx.restore();
    }

    // Break ring waves (sector broken)
    if (fx.breakWaves && fx.breakWaves.length) {
      const nowMs = performance.now();
      for (let i = fx.breakWaves.length - 1; i >= 0; i--) {
        const bw = fx.breakWaves[i];
        const t = Math.max(0, nowMs - bw.start);
        const prog = t / bw.duration;
        if (prog >= 1) {
          fx.breakWaves.splice(i, 1);
          continue;
        }
        const fade = 1 - prog;
        const centerAngle = p.angle + [0, Math.PI / 2, Math.PI, -Math.PI / 2][bw.sector] || 0;
        const cx = Math.cos(centerAngle) * R_OUT * 0.7;
        const cy = Math.sin(centerAngle) * R_OUT * 0.7;
        const baseR0 = R_OUT * 0.2 + prog * R_OUT * 0.5;
        const baseThickness = 18 + Math.sin(prog * Math.PI) * 6;
        // 疊三層帶隨機雜訊與色偏的暈染，避免過度均勻
        for (let pass = 0; pass < 3; pass++) {
          const jitter = (Math.random() - 0.5) * 10;
          const r0 = baseR0 + jitter;
          const r1 = r0 + baseThickness + (Math.random() - 0.5) * 12;
          const noiseAlpha = fade * (0.25 + Math.random() * 0.25);
          const tShift = (bw.colorT || 0) * 0.4 + pass * 0.05;
          const c1 = getPaletteColor(Math.min(0.95, 0.05 + tShift), 0.20 * noiseAlpha);
          const c2 = getPaletteColor(Math.min(0.95, 0.35 + tShift), 0.32 * noiseAlpha);
          const c3 = getPaletteColor(Math.min(0.95, 0.65 + tShift), 0.26 * noiseAlpha);
          ctx.save();
          ctx.beginPath();
          ctx.arc(0, 0, R_OUT, 0, Math.PI * 2);
          ctx.closePath();
          ctx.clip();
          const grad = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1 + 50);
          grad.addColorStop(0, c1);
          grad.addColorStop(0.35 + Math.random() * 0.15, c2);
          grad.addColorStop(0.7 + Math.random() * 0.15, c3);
          grad.addColorStop(1, `rgba(0,0,0,0)`);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(cx, cy, r1 + 60, 0, Math.PI * 2);
          ctx.arc(cx, cy, r0, Math.PI * 2, 0, true);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }
    }

    // Electric arcs along sector rim
    if (fx.breakArcs && fx.breakArcs.length) {
      const nowMs = performance.now();
      for (let i = fx.breakArcs.length - 1; i >= 0; i--) {
        const a = fx.breakArcs[i];
        const t = nowMs - a.start;
        if (t < 0) continue;
        if (t > a.life) {
          fx.breakArcs.splice(i, 1);
          continue;
        }
        const fade = 1 - t / a.life;
        const baseAngle = p.angle + [0, Math.PI / 2, Math.PI, -Math.PI / 2][a.sector] || 0;
        const arcLen = Math.PI / 3;
        const startAngle = baseAngle - arcLen / 2 + Math.sin((t + a.seed) * 0.01) * 0.2;
        const endAngle = startAngle + arcLen * (0.6 + Math.random() * 0.4);
        ctx.save();
        ctx.strokeStyle = getPaletteColor(Math.min(0.95, 0.3 + (a.seed % 0.4)), 0.65 * fade);
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.arc(0, 0, R_OUT * 0.9, startAngle, endAngle);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Glass fragments burst (after break)
    if (fx.breakFragments && fx.breakFragments.length) {
      const dt = 1 / 60;
      for (let i = fx.breakFragments.length - 1; i >= 0; i--) {
        const f = fx.breakFragments[i];
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        f.vx *= 0.94;
        f.vy *= 0.94;
        f.life -= dt;
        const fade = Math.max(0, f.life);
        if (fade <= 0) {
          fx.breakFragments.splice(i, 1);
          continue;
        }
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.rotate(f.rot);
        ctx.globalAlpha = fade * 0.8;
        ctx.fillStyle = "rgba(255,210,140,0.8)";
        ctx.beginPath();
        ctx.moveTo(-f.size, -f.size * 0.6);
        ctx.lineTo(f.size, -f.size * 0.4);
        ctx.lineTo(f.size * 0.4, f.size);
        ctx.lineTo(-f.size * 0.6, f.size * 0.6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    // Scanning lines across broken sector
      if (fx.breakScans && fx.breakScans.length) {
        const nowMs = performance.now();
        for (let i = fx.breakScans.length - 1; i >= 0; i--) {
          const s = fx.breakScans[i];
          const t = nowMs - s.start;
        if (t < 0) continue;
        if (t > s.duration) {
          fx.breakScans.splice(i, 1);
          continue;
        }
        const prog = t / s.duration;
        const baseAngle = p.angle + [0, Math.PI / 2, Math.PI, -Math.PI / 2][s.sector] || 0;
        const span = Math.PI / 2.3;
        const a0 = baseAngle - span / 2;
        const a1 = baseAngle + span / 2;
        const sweep = a0 + (a1 - a0) * prog;
        ctx.save();
        ctx.strokeStyle = getPaletteColor(Math.min(0.95, 0.4 + (s.offset || 0) * 0.4), 0.4 * (1 - prog));
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, R_OUT * 0.8, sweep - 0.08, sweep + 0.08);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Break flash / color split overlay
    if (fx.breakFlash && fx.breakFlash > 0) {
      const flash = fx.breakFlash;
      // use fixed frame step (render context無 dt) to fade flash
      fx.breakFlash = Math.max(0, fx.breakFlash - 0.016 * 2.8);
      const offset = 4 * flash;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `rgba(255,255,255,${0.35 * flash})`;
      ctx.beginPath();
      ctx.arc(offset, 0, R_OUT * 0.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(120,180,255,${0.25 * flash})`;
      ctx.beginPath();
      ctx.arc(-offset, 0, R_OUT * 0.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // hit fragments
    if (fx.hitFragments && fx.hitFragments.length) {
      const dt = 1 / 60;
      for (let i = fx.hitFragments.length - 1; i >= 0; i--) {
        const f = fx.hitFragments[i];
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        f.vx *= 0.94;
        f.vy *= 0.94;
        f.life -= dt * 1.8;
        const fade = Math.max(0, f.life);
        ctx.save();
        ctx.translate(p.x + f.x, p.y + f.y);
        ctx.rotate(Math.atan2(f.vy, f.vx));
        ctx.globalAlpha = fade;
        ctx.strokeStyle = `rgba(180,240,255,${0.25 * fade})`;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        for (let j = 0; j < 6; j++) {
          const a = j * Math.PI / 3;
          const px = Math.cos(a) * f.size * 0.6;
          const py = Math.sin(a) * f.size * 0.6;
          if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
        if (f.life <= 0) fx.hitFragments.splice(i, 1);
      }
    }

    ctx.restore();
  }

  drawShieldBreak(ctx) {
    const fx = this.shieldFx;
    if (!fx || !fx.break || !fx.break.active) return;
    const b = fx.break;
    const now = performance.now();
    const dt = b.lastTime ? Math.max(0, (now - b.lastTime) / 1000) : 0;
    b.lastTime = now;
    const elapsed = (now - b.start) / 1000;
    const fadeOut = Math.max(0, 1 - elapsed / 1.2);
    const R = b.radius;
    const R_BIG = R * 1.8;

    ctx.save();
    ctx.translate(b.originX || this.player.x, b.originY || this.player.y);

    if (fadeOut > 0) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R_BIG);
      g.addColorStop(0, `rgba(80, 120, 200, ${0.5 * fadeOut})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(-R_BIG * 2, -R_BIG * 2, R_BIG * 4, R_BIG * 4);
    }

    const drawHexLocal = (x, y, s) => {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3 + Math.PI / 6;
        const px = x + s * Math.cos(a);
        const py = y + s * Math.sin(a);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    };

    for (const h of b.exploding) {
      h.x += Math.cos(h.angle) * h.speed;
      h.y += Math.sin(h.angle) * h.speed;
      h.rot += h.rotSpeed * dt * 18;
      h.speed *= 1.06;
      h.life -= dt * 1.2;
      const d = Math.hypot(h.x, h.y);
      const edgeFade = Math.max(0, 1 - Math.pow(d / R_BIG, 1.25));

      ctx.save();
      ctx.translate(h.x, h.y);
      ctx.rotate(h.rot);
      const alpha = Math.max(0, h.life) * edgeFade;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = `rgba(180, 230, 255, ${alpha})`;
      ctx.lineWidth = 2;
      drawHexLocal(0, 0, h.size);
      ctx.stroke();
      ctx.restore();
    }
    b.exploding = b.exploding.filter(h => h.life > 0);

    const crackLife = 1.2;
    for (const c of b.cracks) {
      const t = Math.min(1, (now - c.time) / (crackLife * 1000));
      const tipX = c.points[c.points.length - 1].x * t;
      const tipY = c.points[c.points.length - 1].y * t;
      const edgeFade = Math.max(0, 1 - Math.pow(Math.hypot(tipX, tipY) / R_BIG, 1.25));
      ctx.strokeStyle = `rgba(200, 240, 255, ${(1 - t) * edgeFade})`;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(c.ix, c.iy);
      for (const p of c.points) {
        ctx.lineTo(c.ix + p.x * t * 1.6, c.iy + p.y * t * 1.6);
      }
      ctx.stroke();
    }

    for (const s of b.shards) {
      s.x += Math.cos(s.angle) * s.speed;
      s.y += Math.sin(s.angle) * s.speed;
      s.speed *= 1.06;
      s.life -= dt * 1.5;
      const d = Math.hypot(s.x, s.y);
      const edgeFade = Math.max(0, 1 - Math.pow(d / R_BIG, 1.25));

      const fade = Math.max(0, s.life) * edgeFade;
      ctx.strokeStyle = `rgba(180, 240, 255, ${0.3 * fade})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.prevX, s.prevY);
      ctx.lineTo(s.x, s.y);
      ctx.stroke();

      ctx.fillStyle = `rgba(255, 255, 255, ${0.8 * fade})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3 * fade, 0, Math.PI * 2);
      ctx.fill();

      s.prevX = s.x;
      s.prevY = s.y;
    }
    b.shards = b.shards.filter(s => s.life > 0);

    if (b.coreFlash > 0) {
      ctx.save();
      ctx.globalAlpha = b.coreFlash;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.8, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fill();
      ctx.restore();
      b.coreFlash = Math.max(0, b.coreFlash - dt * 2.2);
    }

    ctx.restore();
    ctx.restore();

    if (fadeOut <= 0 && b.exploding.length === 0 && b.shards.length === 0) {
      enemy.facingAngle = desired;
      return;
    }
    const diff = shortestAngleDiff(enemy.facingAngle, desired);
    const maxTurn = Math.max(0.0001, turnRate) * dt;
    if (Math.abs(diff) <= maxTurn) {
      enemy.facingAngle = desired;
    } else {
      enemy.facingAngle += Math.sign(diff) * maxTurn;
    }
  }

  computeEnemyTargetAngle(enemy) {
    const dx = this.player.x - enemy.x;
    const dy = this.player.y - enemy.y;
    const len = Math.hypot(dx, dy) || 1;
    const dirX = dx / len;
    const dirY = dy / len;
    return Math.atan2(dirX, -dirY);
  }
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

const LIGHTNING_KEYS = [
  "laser.lightning_1",
  "laser.lightning_2",
  "laser.lightning_3",
  "laser.lightning_4",
  "laser.lightning_5"
];

let lightningCache = null;
let spinBossCache = null;
let shieldWholeCache = null;
function getLightningFrames() {
  if (lightningCache) return lightningCache;

  const sheet = Assets.get("laser.lightning_sheet");
  if (sheet) {
    const frameCount = 6;
    const frameHeight = Math.floor(sheet.height / frameCount);
    const frames = [];
    for (let i = 0; i < frameCount; i++) {
      const slice = document.createElement("canvas");
      slice.width = sheet.width;
      slice.height = frameHeight;
      const sctx = slice.getContext("2d");
      sctx.drawImage(
        sheet,
        0, i * frameHeight,
        sheet.width, frameHeight,
        0, 0,
        slice.width, slice.height
      );
      maskCanvas(slice, 40, 70);
      frames.push(slice);
    }
    if (frames.length) {
      lightningCache = frames;
      return lightningCache;
    }
  }

  lightningCache = LIGHTNING_KEYS
    .map(key => getMaskedSprite(key, 40, 70))
    .filter(Boolean);
  return lightningCache;
}

function getSpinBossFrames() {
  if (spinBossCache) return spinBossCache;
  const keys = Array.from({ length: 8 }, (_, i) => `enemies.mid.miniboss_core.frame_${i + 1} `);
  const images = keys.map(k => Assets.get(k)).filter(Boolean);

  if (!images.length) {
    const single = Assets.get("enemies.mid.miniboss_core");
    spinBossCache = single ? [{ canvas: single, offsetX: 0, offsetY: 0 }] : [];
    return spinBossCache;
  }

  const maxW = Math.max(...images.map(img => img.width));
  const maxH = Math.max(...images.map(img => img.height));
  const frames = images.map(img => {
    const canvas = document.createElement("canvas");
    canvas.width = maxW;
    canvas.height = maxH;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, (maxW - img.width) / 2, (maxH - img.height) / 2);
    return { canvas, offsetX: 0, offsetY: 0 };
  });

  spinBossCache = frames;
  return spinBossCache;
}

let midBossBodyCache = null;
let midBossPartCache = null;
let midBossMaxSize = null;
let midBossComposite = null;

function loadMidBossAssets() {
  // Always build from parts; ignore composite to avoid oversized single image.
  if (midBossBodyCache && midBossPartCache && midBossMaxSize !== null) return;

  const bodyKeys = Array.from({ length: 12 }, (_, i) => `enemies.mid.boss_core.frame_${i + 1} `);
  const partKeys = Array.from({ length: 12 }, (_, i) => `enemies.mid.boss_part.frame_${i + 1} `);
  const bodyImgs = bodyKeys.map(k => Assets.get(k)).filter(Boolean);
  const partImgs = partKeys.map(k => Assets.get(k)).filter(Boolean);
  midBossComposite = null;
  const all = [...bodyImgs, ...partImgs];
  if (!all.length) {
    midBossMaxSize = { w: 0, h: 0 };
    midBossBodyCache = [];
    midBossPartCache = [];
    return;
  }
  const maxW = Math.max(...all.map(img => img.width));
  const maxH = Math.max(...all.map(img => img.height));
  midBossMaxSize = { w: maxW, h: maxH };

  const build = (images) => images.map(img => {
    const c = document.createElement("canvas");
    c.width = maxW;
    c.height = maxH;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, (maxW - img.width) / 2, (maxH - img.height) / 2);
    return { canvas: c };
  });

  midBossBodyCache = build(bodyImgs);
  midBossPartCache = build(partImgs);
}

function getMidBossFrames() {
  loadMidBossAssets();
  return midBossBodyCache || [];
}

function getMidBossPartFrames() {
  loadMidBossAssets();
  return midBossPartCache || [];
}

function trimCanvasAlpha(canvas) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  // 二方?��??��??�找左右?��?，�?上�?，避?��??�細?��?
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4 + 3;
      if (data[i] > 5) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return canvas;
  // 強制對�?�?��形�??��?大�??��??��??��??��?�?��裁�?
  const boxSize = Math.max(maxX - minX + 1, maxY - minY + 1);
  // 以內容中心為?�形中�?
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const half = boxSize / 2;
  const sx = Math.max(0, Math.floor(cx - half));
  const sy = Math.max(0, Math.floor(cy - half));
  const ex = Math.min(width, Math.ceil(cx + half));
  const ey = Math.min(height, Math.ceil(cy + half));
  const trimW = ex - sx;
  const trimH = ey - sy;
  const out = document.createElement("canvas");
  out.width = trimW;
  out.height = trimH;
  const octx = out.getContext("2d");
  octx.drawImage(canvas, sx, sy, trimW, trimH, 0, 0, trimW, trimH);
  return out;
}

function drawChargingRing(ctx, sprite, player, alpha, timeSeconds) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const pulse = 1.0 + Math.sin(timeSeconds * 6) * 0.15;
  const size = 140 * pulse;
  ctx.globalAlpha = alpha * 0.8;
  ctx.drawImage(sprite, player.x - size / 2, player.y - size / 2, size, size);
  ctx.globalAlpha = alpha * 0.5;
  ctx.drawImage(sprite, player.x - size, player.y - size, size * 2, size * 2);
  ctx.restore();
}

const maskedSpriteCache = new Map();

const shipSpriteCache = {
  base: null,
  glowFrames: []
};
const midGlowCache = [];
const MID_GRUNT_SHEET_KEY = "enemies.mid.grunt_skirmisher";

const SHIP_GLOW_KEYS = [
  "player.ship_glow.frame_1",
  "player.ship_glow.frame_2",
  "player.ship_glow.frame_3",
  "player.ship_glow.frame_4",
  "player.ship_glow.frame_5",
  "player.ship_glow.frame_6",
  "player.ship_glow.frame_7",
  "player.ship_glow.frame_8",
  "player.ship_glow.frame_9",
  "player.ship_glow.frame_10",
  "player.ship_glow.frame_11",
  "player.ship_glow.frame_12",
  "player.ship_glow.frame_13",
  "player.ship_glow.frame_14",
  "player.ship_glow.frame_15",
  "player.ship_glow.frame_16"
];

let shieldHitCache = null;
function getShieldHitSprites() {
  if (shieldHitCache) return shieldHitCache;
  const keys = [
    "shield.overlay_1",
    "shield.overlay_2",
    "shield.overlay_3",
    "shield.overlay_4",
    "shield.overlay_alt"
  ];
  shieldHitCache = keys.map(k => Assets.get(k)).filter(Boolean);
  return shieldHitCache;
}

function getShieldWholeSprite() {
  if (shieldWholeCache) return shieldWholeCache;
  const sprite = getMaskedSprite("shield.whole", 50, 70);
  shieldWholeCache = sprite;
  return shieldWholeCache;
}

function getMaskedSprite(key, threshold = 60, softness = 30) {
  const cacheKey = `${key}| ${threshold}| ${softness} `;
  if (maskedSpriteCache.has(cacheKey)) {
    return maskedSpriteCache.get(cacheKey);
  }
  const original = Assets.get(key);
  if (!original) return null;
  const off = document.createElement("canvas");
  off.width = original.width;
  off.height = original.height;
  const ictx = off.getContext("2d");
  ictx.drawImage(original, 0, 0);
  maskCanvas(off, threshold, softness);
  maskedSpriteCache.set(cacheKey, off);
  return off;
}

function getShipSprite() {
  if (!shipSpriteCache.base) {
    const base = Assets.get("player.ship");
    if (!base) return null;
    shipSpriteCache.base = base;
  }
  if (!shipSpriteCache.glowFrames.length) {
    shipSpriteCache.glowFrames = SHIP_GLOW_KEYS.map((key) => Assets.get(key)).filter(Boolean);
  }
  return {
    base: shipSpriteCache.base,
    glowFrames: shipSpriteCache.glowFrames
  };
}

function getMidGlowFrames() {
  if (!midGlowCache.length) {
    const sheet = Assets.get(MID_GRUNT_SHEET_KEY);
    if (!sheet) return midGlowCache;
    const canvas = document.createElement("canvas");
    canvas.width = sheet.width;
    canvas.height = sheet.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(sheet, 0, 0);
    const { width, height } = canvas;
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;
    const visited = new Uint8Array(width * height);
    const frames = [];

    const stack = [];
    const dirs = [
      [1, 0], [-1, 0], [0, 1], [0, -1]
    ];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (visited[idx]) continue;
        const alpha = data[idx * 4 + 3];
        if (alpha === 0) continue;
        let minX = x;
        let maxX = x;
        let minY = y;
        let maxY = y;
        let count = 0;
        stack.push(idx);
        visited[idx] = 1;
        while (stack.length) {
          const cur = stack.pop();
          const cy = Math.floor(cur / width);
          const cx = cur % width;
          count++;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          for (const [dx, dy] of dirs) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const nIdx = ny * width + nx;
            if (visited[nIdx]) continue;
            const nAlpha = data[nIdx * 4 + 3];
            if (nAlpha === 0) continue;
            visited[nIdx] = 1;
            stack.push(nIdx);
          }
        }
        if (count < 300) continue;
        const margin = 5;
        minX = Math.max(0, minX - margin);
        maxX = Math.min(width - 1, maxX + margin);
        minY = Math.max(0, minY - margin);
        maxY = Math.min(height - 1, maxY + margin);
        const w = maxX - minX + 1;
        const h = maxY - minY + 1;
        if (w < 24 || h < 24) continue;
        const slice = document.createElement("canvas");
        slice.width = w;
        slice.height = h;
        const sctx = slice.getContext("2d");
        sctx.drawImage(canvas, minX, minY, w, h, 0, 0, w, h);
        frames.push({ canvas: slice, intensity: measureCanvasLuminance(slice) });
      }
    }

    frames
      .sort((a, b) => a.intensity - b.intensity)
      .slice(0, 16)
      .forEach(frame => midGlowCache.push(frame.canvas));
  }
  return midGlowCache;
}

function measureCanvasLuminance(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let total = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    if (alpha <= 0) continue;
    const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
    total += lum * alpha;
    weight += alpha;
  }
  if (weight === 0) return 0;
  return total / weight;
}

function maskCanvas(canvas, threshold, softness) {
  const ctx = canvas.getContext("2d");
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const brightness = (r + g + b) / 3;
    if (brightness < threshold) {
      data[i + 3] = 0;
    } else if (brightness < threshold + softness) {
      const ratio = (brightness - threshold) / Math.max(softness, 1);
      data[i + 3] = data[i + 3] * ratio;
    }
  }
  ctx.putImageData(image, 0, 0);
}

function createLaserFx() {
  const fx = {
    orbs: [],
    bolts: [],
    shockwaves: [],
    chargeRings: [],
    embers: [],
    boltTimer: 0,
    chargeBoltTimer: 0,
    shockwaveTimer: 0,
    chargingRingTimer: 0,
    emberTimer: 0,
    shakeTime: 0,
    fireTime: 0
  };
  initLaserOrbs(fx);
  return fx;
}

function initLaserOrbs(fx) {
  fx.orbs = [];
  for (let i = 0; i < LASER_FX_CONFIG.orbCount; i++) {
    fx.orbs.push({
      angle: (Math.PI * 2 / LASER_FX_CONFIG.orbCount) * i,
      radius: 110,
      sizePhase: Math.random() * Math.PI * 2
    });
  }
}

function onLaserStateChange(fx, prev, next, player) {
  if (next === "charging") {
    initLaserOrbs(fx);
    fx.chargeBoltTimer = 0;
    fx.chargingRingTimer = 0;
    fx.emberTimer = 0;
    fx.chargeRings = [];
    fx.embers = [];
  }
  if (next === "firing") {
    fx.fireTime = 0;
    fx.boltTimer = 0;
    fx.shockwaveTimer = 0;
    spawnShockwave(fx, player.x, player.y);
    fx.shakeTime = LASER_FX_CONFIG.shakeDuration;
  }
  if (next === "idle") {
    fx.orbs = [];
    fx.bolts = [];
    fx.shockwaves = [];
    fx.chargeRings = [];
    fx.embers = [];
  }
}

function spawnShockwave(fx, x, y) {
  fx.shockwaves.push({
    x,
    y,
    r: 10,
    life: 0.5,
    maxLife: 0.5
  });
}

function spawnChargeRing(fx, player, progress) {
  fx.chargeRings.push({
    x: player.x,
    y: player.y,
    radius: LASER_FX_CONFIG.chargingRingStartRadius,
    alpha: LASER_FX_CONFIG.chargingRingAlpha * (0.4 + progress * 0.6),
    shrinkSpeed: LASER_FX_CONFIG.chargingRingShrinkSpeed * (1.2 + progress * 2.2)
  });
}

function spawnEmber(fx, player, dirVec) {
  const perp = { x: -dirVec.y, y: dirVec.x };
  const forward = 20 + Math.random() * 40;
  const lateral = (Math.random() - 0.5) * 80;
  const x = player.x + dirVec.x * forward + perp.x * lateral;
  const y = player.y + dirVec.y * forward + perp.y * lateral;
  const drift = (Math.random() - 0.5) * 30;
  fx.embers.push({
    x,
    y,
    vx: dirVec.x * 45 + perp.x * drift * 0.2,
    vy: dirVec.y * 45 + perp.y * drift * 0.2,
    life: 0.5 + Math.random() * 0.35,
    maxLife: 0.5 + Math.random() * 0.35
  });
}

function spawnLaserBolt(fx, player, dirVec, mode) {
  const frames = getLightningFrames();
  if (!frames.length) return;
  const sprite = frames[Math.floor(Math.random() * frames.length)];
  if (!sprite) return;
  if (mode === "charge") {
    const angle = Math.random() * Math.PI * 2;
    const radius = 40 + Math.random() * 40;
    const x = player.x + Math.cos(angle) * radius;
    const y = player.y + Math.sin(angle) * radius;
    fx.bolts.push({
      x,
      y,
      angle,
      life: 0.25,
      maxLife: 0.25,
      sprite,
      size: 85,
      flip: Math.random() > 0.5 ? -1 : 1
    });
  } else {
    const perp = { x: -dirVec.y, y: dirVec.x };
    const len = Math.hypot(window.innerWidth, window.innerHeight) * 2;
    const t = 0.15 + Math.random() * 0.75;
    const baseX = player.x + dirVec.x * (len * t);
    const baseY = player.y + dirVec.y * (len * t);
    const lateral = (Math.random() - 0.5) * 120 * (1 - t);
    const x = baseX + perp.x * lateral;
    const y = baseY + perp.y * lateral;
    const stretch = 0.85 + Math.random() * 0.5;
    fx.bolts.push({
      x,
      y,
      angle: Math.atan2(dirVec.y, dirVec.x) + (Math.random() - 0.5) * 0.35,
      life: 0.16,
      maxLife: 0.16,
      sprite,
      size: (140 + Math.random() * 80) * stretch * 0.85,
      flip: Math.random() > 0.5 ? -1 : 1,
      skew: stretch,
      anchorOffset: (Math.random() - 0.5) * 30
    });
  }
}

function updateLaserFx(fx, laser, player, dt) {
  fx.shakeTime = Math.max(0, fx.shakeTime - dt);
  if (laser.state === "firing") {
    fx.fireTime += dt;
  } else {
    fx.fireTime = 0;
  }
  const dirVec = vecFromAngle(player.angle);

  if (laser.state === "charging") {
    if (!fx.orbs.length) initLaserOrbs(fx);
    const progress = Math.min(1, laser.timer / GAME_CONFIG.laser.chargeTime);
    for (const orb of fx.orbs) {
      orb.angle += dt * (1.5 + progress);
      orb.radius = 80 + 60 * progress;
      orb.sizePhase += dt * 6;
    }
    fx.chargeBoltTimer -= dt;
    if (fx.chargeBoltTimer <= 0) {
      spawnLaserBolt(fx, player, dirVec, "charge");
      fx.chargeBoltTimer = LASER_FX_CONFIG.chargeBoltInterval;
    }
    const stage = Math.min(progress, 1);
    const intervalRange = LASER_FX_CONFIG.chargingRingIntervalBase - LASER_FX_CONFIG.chargingRingIntervalMin;
    const ringInterval = Math.max(
      LASER_FX_CONFIG.chargingRingIntervalMin,
      LASER_FX_CONFIG.chargingRingIntervalBase - stage * stage * intervalRange
    );
    fx.chargingRingTimer -= dt;
    if (fx.chargingRingTimer <= 0) {
      spawnChargeRing(fx, player, progress);
      fx.chargingRingTimer = ringInterval;
    }
    const emberRate = LASER_FX_CONFIG.emberSpawnRateBase + progress * (LASER_FX_CONFIG.emberSpawnRateMax - LASER_FX_CONFIG.emberSpawnRateBase);
    fx.emberTimer -= dt;
    if (fx.emberTimer <= 0) {
      spawnEmber(fx, player, dirVec);
      fx.emberTimer = 1 / Math.max(emberRate, 1);
    }
  }

  if (laser.state === "firing") {
    fx.boltTimer -= dt;
    fx.shockwaveTimer -= dt;
    if (fx.boltTimer <= 0) {
      spawnLaserBolt(fx, player, dirVec, "beam");
      fx.boltTimer = LASER_FX_CONFIG.boltInterval;
    }
    if (fx.shockwaveTimer <= 0) {
      spawnShockwave(fx, player.x, player.y);
      fx.shockwaveTimer = LASER_FX_CONFIG.shockwaveInterval;
      fx.shakeTime = LASER_FX_CONFIG.shakeDuration;
    }
  }

  for (let i = fx.bolts.length - 1; i >= 0; i--) {
    const bolt = fx.bolts[i];
    bolt.life -= dt;
    if (bolt.life <= 0) {
      fx.bolts.splice(i, 1);
    }
  }

  for (let i = fx.shockwaves.length - 1; i >= 0; i--) {
    const s = fx.shockwaves[i];
    s.life -= dt;
    s.r += dt * 260;
    if (s.life <= 0) fx.shockwaves.splice(i, 1);
  }

  for (let i = fx.chargeRings.length - 1; i >= 0; i--) {
    const ring = fx.chargeRings[i];
    ring.radius -= ring.shrinkSpeed * dt;
    if (ring.radius <= 40) {
      fx.chargeRings.splice(i, 1);
    }
  }

  for (let i = fx.embers.length - 1; i >= 0; i--) {
    const ember = fx.embers[i];
    ember.life -= dt;
    ember.x += ember.vx * dt;
    ember.y += ember.vy * dt;
    if (ember.life <= 0) {
      fx.embers.splice(i, 1);
    }
  }
}

function drawLaserEffect(ctx, player, laser, fx) {
  const dirVec = vecFromAngle(player.angle);
  const angle = Math.atan2(dirVec.y, dirVec.x);
  const now = performance.now() / 1000;
  const ringSprite = getMaskedSprite("laser.ring", 50, 70);
  const particleSprite = getMaskedSprite("laser.particle", 50, 70);
  const coreSprite = getMaskedSprite("laser.core", 40, 60);
  const beamLength = Math.hypot(ctx.canvas.width, ctx.canvas.height) * 2;
  const releaseAlpha = laser.state === "release"
    ? Math.max(0, Math.min(1, laser.timer / Math.max(0.0001, GAME_CONFIG.laser.releaseTime)))
    : 1;

  const shakeStrength = fx.shakeTime > 0
    ? (fx.shakeTime / LASER_FX_CONFIG.shakeDuration)
    : 0;
  const shakeX = (Math.random() - 0.5) * 6 * shakeStrength;
  const shakeY = (Math.random() - 0.5) * 6 * shakeStrength;

  ctx.save();
  ctx.translate(shakeX, shakeY);

  if (laser.state === "charging" && ringSprite) {
    for (const ring of fx.chargeRings) {
      const size = ring.radius * 2;
      const fade = ring.radius / LASER_FX_CONFIG.chargingRingStartRadius;
      ctx.save();
      ctx.globalAlpha = ring.alpha * fade;
      ctx.drawImage(ringSprite, ring.x - size / 2, ring.y - size / 2, size, size);
      ctx.restore();
    }
  }

  if ((laser.state === "charging" || laser.state === "firing") && particleSprite) {
    for (const ember of fx.embers) {
      const lifeRatio = ember.life / ember.maxLife;
      const size = 10 + 4 * lifeRatio;
      ctx.save();
      ctx.globalAlpha = 0.6 * lifeRatio;
      ctx.drawImage(particleSprite, ember.x - size / 2, ember.y - size / 2, size, size);
      ctx.restore();
    }
  }

  for (const s of fx.shockwaves) {
    ctx.save();
    ctx.globalAlpha = (s.life / s.maxLife) * 0.8 * releaseAlpha;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(160,220,255,0.85)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  if (laser.state === "firing" || laser.state === "release") {
    const pulse = 0.9 + 0.1 * Math.sin(fx.fireTime * 16);
    const len = beamLength * pulse;
    const beamLayers = [
      { width: LASER_FX_CONFIG.beamWidth * 2.6, color: "rgba(40,90,140,0.4)" },
      { width: LASER_FX_CONFIG.beamWidth * 2.3, color: "rgba(55,110,170,0.36)" },
      { width: LASER_FX_CONFIG.beamWidth * 2.0, color: "rgba(75,135,200,0.33)" },
      { width: LASER_FX_CONFIG.beamWidth * 1.75, color: "rgba(100,160,220,0.32)" },
      { width: LASER_FX_CONFIG.beamWidth * 1.5, color: "rgba(130,190,240,0.33)" },
      { width: LASER_FX_CONFIG.beamWidth * 1.35, color: "rgba(170,215,255,0.4)" },
      { width: LASER_FX_CONFIG.beamWidth * 1.1, color: "rgba(200,235,255,0.5)" },
      { width: LASER_FX_CONFIG.beamWidth * 0.9, color: "rgba(230,245,255,0.6)" },
      { width: LASER_FX_CONFIG.beamWidth * 0.75, color: "rgba(250,250,255,0.7)" },
      { width: LASER_FX_CONFIG.beamWidth * 0.55, color: "rgba(255,255,255,0.82)" },
      { width: LASER_FX_CONFIG.beamWidth * 0.35, color: "rgba(255,255,255,1)" }
    ];
    ctx.save();
    ctx.lineCap = "round";
    beamLayers.forEach(layer => {
      ctx.strokeStyle = layer.color;
      ctx.globalAlpha = releaseAlpha;
      ctx.lineWidth = layer.width;
      ctx.beginPath();
      ctx.moveTo(player.x, player.y);
      ctx.lineTo(player.x + dirVec.x * len, player.y + dirVec.y * len);
      ctx.stroke();
    });
    ctx.restore();

    if (coreSprite) {
      ctx.save();
      ctx.translate(player.x, player.y);
      const s = 1.2 + 0.7 * (1 - releaseAlpha);
      ctx.globalAlpha = 0.9 * releaseAlpha;
      ctx.drawImage(coreSprite, -55 * s, -55 * s, 110 * s, 110 * s);
      ctx.restore();
    }
  }

  for (const bolt of fx.bolts) {
    ctx.save();
    const alpha = (bolt.life / bolt.maxLife) * releaseAlpha;
    ctx.globalAlpha = alpha;
    ctx.translate(bolt.x, bolt.y);
    ctx.rotate(bolt.angle);
    const scaleX = (bolt.flip && bolt.flip < 0 ? -1 : 1) * (bolt.skew || 1);
    ctx.scale(scaleX, 1);
    if (bolt.anchorOffset) ctx.translate(bolt.anchorOffset, 0);
    const size = bolt.size;
    ctx.drawImage(bolt.sprite, -size / 2, -size / 2, size, size);
    ctx.restore();
  }

  ctx.restore();
}
