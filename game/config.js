export const GAME_CONFIG = {
  canvas: {
    defaultWidth: 1280,
    defaultHeight: 720,
    background: "#04060d"
  },
  laser: {
    burstDuration: 0.5,
    cooldown: 10,
    range: 600,
    width: 16,
    maxEnergy: 100,
    chargeTime: 0.05,
    releaseTime: 0.25
  },
  dash: {
    cooldown: 1.2,
    duration: 0.22,
    speed: 400,
    postBoostDuration: 0.7,
    postBoostCapMultiplier: 1.5,
    dragMultiplier: 0.8
  },
  torpedo: {
    speed: 1080,
    cooldown: 0.25,
    damage: 12,
    ammoMax: 17, // legacy shared pool, not used after split
    regenPerSecond: 0.0, // split ammo不再自動回復
    lockConeDeg: 30,
    maxRange: 800, // Increased range for faster speed
    homingTurnRate: 2.2,
    laserKillRefund: 0.4
  },
  player: {
    baseMoveSpeed: 280,
    maxMoveSpeed: 360,
    velocityCap: 620,
    accel: 420,
    moveDrag: 0.95,
    radius: 13.5, // Increased from 9 to 1.5x for better hitbox coverage
    angularAccel: 30,
    angularMaxSpeed: 9,
    angularDamp: 14,
    maxHp: 100,
    maxShield: 120,
    shieldDelay: 3,
    shieldRegenPerSec: 12,
    invincibleTime: 1
  }
};

export const DIFFICULTY_MOD = {
  easy: { hp: 0.75, damage: 0.7, bulletDensity: 0.6, enemySpeed: 0.7 },
  normal: { hp: 1.0, damage: 1.0, bulletDensity: 1.0, enemySpeed: 0.85 },
  hard: { hp: 1.25, damage: 1.3, bulletDensity: 1.2, enemySpeed: 1.0 },
  god: { hp: 1.25, damage: 1.3, bulletDensity: 1.2, enemySpeed: 1.0 }
};

export const ENEMY_STATS = {
  low_grunt1: { hp: 36, speed: 70, fireDelay: 2.4, damage: 10 },
  low_grunt2: { hp: 60, speed: 80, fireDelay: 2.0, damage: 10 },
  low_grunt3: { hp: 84, speed: 90, fireDelay: 2.2, damage: 12 },
  low_miniboss: { hp: 220, speed: 65, fireDelay: 1.6, damage: 16 },
  low_boss: { hp: 950, speed: 30, fireDelay: 1.2, damage: 18 },
  mid_grunt_skirmisher: { hp: 90, speed: 110, fireDelay: 1.6, damage: 15 },
  mid_grunt_laser: { hp: 110, speed: 95, fireDelay: 2.4, damage: 18 },
  mid_miniboss_dual: { hp: 320, speed: 70, fireDelay: 1.4, damage: 18 },
  mid_miniboss_core: { hp: 360, speed: 120, fireDelay: 1.3, damage: 22 },
  mid_boss_core: { hp: 1400, speed: 0, fireDelay: 1.0, damage: 20 }
};

export const DIRECTION_ANGLES = {
  "N": 0, "NNE": 22.5, "NE": 45, "ENE": 67.5,
  "E": 90, "ESE": 112.5, "SE": 135, "SSE": 157.5,
  "S": 180, "SSW": 202.5, "SW": 225, "WSW": 247.5,
  "W": 270, "WNW": 292.5, "NW": 315, "NNW": 337.5
};

export const NUMPAD_DIRECTION_MAP = {
  "8": "N",
  "89": "NNE",
  "9": "NE",
  "69": "ENE",
  "6": "E",
  "36": "ESE",
  "3": "SE",
  "23": "SSE",
  "2": "S",
  "12": "SSW",
  "1": "SW",
  "14": "WSW",
  "4": "W",
  "47": "WNW",
  "7": "NW",
  "78": "NNW"
};
