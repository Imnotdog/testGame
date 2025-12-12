import { DIRECTION_ANGLES, GAME_CONFIG } from "../config.js";

const hud = {
  hp: document.getElementById("hpBar"),
  hull: document.getElementById("hullBar"),
  hullLabel: document.getElementById("hullLabel"),
  shield: document.getElementById("shieldBar"),
  torp: document.getElementById("torpBar"),
  torpLabelFront: document.getElementById("torpFront"),
  torpLabelRear: document.getElementById("torpRear"),
  laser: document.getElementById("laserBar"),
  roundLabel: document.getElementById("roundLabel"),
  miniNeedle: document.getElementById("miniNeedle"),
  miniDirLabel: document.getElementById("miniDirLabel"),
  difficultySelect: document.getElementById("difficultySelect"),
  factionSelect: document.getElementById("factionSelect"),
  deathToggle: document.getElementById("deathToggle"),
  laserOffline: document.getElementById("laserOffline"),
  torpFrontOffline: document.getElementById("torpFrontOffline"),
  torpRearOffline: document.getElementById("torpRearOffline"),
  torpFrontJam: document.getElementById("torpFrontJam"),
  torpRearJam: document.getElementById("torpRearJam"),
  debugPanel: document.getElementById("debugPanel"),
  debugText: document.getElementById("debugText")
};

export const UIManager = {
  onDifficultyChange(callback) {
    hud.difficultySelect.addEventListener("change", () => callback(hud.difficultySelect.value));
    hud.difficultySelect.addEventListener("keydown", (e) => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
        e.preventDefault();
      }
    });
  },

  onFactionChange(callback) {
    hud.factionSelect.addEventListener("change", () => callback(hud.factionSelect.value));
    hud.factionSelect.addEventListener("keydown", (e) => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
        e.preventDefault();
      }
    });
  },

  onDeathToggle(callback) {
    if (!hud.deathToggle) return;
    hud.deathToggle.addEventListener("change", () => callback(hud.deathToggle.checked));
  },

  setDifficulty(value) {
    hud.difficultySelect.value = value;
  },

  setFaction(value) {
    hud.factionSelect.value = value;
  },

  setDeathAllowed(enabled) {
    if (hud.deathToggle) hud.deathToggle.checked = enabled;
  },

  updatePlayerBars(player, laserEnergy) {
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const hpRatio = player?.maxHp ? clamp01(player.hp / player.maxHp) : 0;
    const shieldTotal = Array.isArray(player?.shieldSectors)
      ? player.shieldSectors.reduce((sum, val) => sum + val, 0)
      : (player?.shield ?? 0);
    const shieldRatio = player?.maxShield ? clamp01(shieldTotal / player.maxShield) : 0;
    // 前/後魚雷庫存，以小巧文字顯示剩餘數
    const torpFront = player?.torpAmmoFront ?? player?.torpAmmo ?? 0;
    const torpRear = player?.torpAmmoRear ?? 0;
    const torpMaxFront = 12;
    const torpMaxRear = 5;
    const torpRatio = torpMaxFront ? clamp01(torpFront / torpMaxFront) : 0;
    const laserMax = GAME_CONFIG?.laser?.maxEnergy ?? 100;
    const laserRatio = clamp01((laserEnergy ?? 0) / laserMax);

    hud.hp.style.width = `${hpRatio * 100}%`;
    hud.shield.style.width = `${shieldRatio * 100}%`;
    hud.torp.style.width = `${torpRatio * 100}%`;
    hud.laser.style.width = `${laserRatio * 100}%`;

    if (hud.torpLabelFront) {
      hud.torpLabelFront.textContent = `${torpFront}/${torpMaxFront}`;
    }
    if (hud.torpLabelRear) {
      hud.torpLabelRear.textContent = `${torpRear}/${torpMaxRear}`;
    }
    if (hud.hullLabel) {
      const hull = player?.hull ?? player?.hp ?? 0;
      const maxHull = player?.maxHull ?? player?.maxHp ?? 100;
      const ratio = clamp01(maxHull ? hull / maxHull : 0);
      hud.hull.style.width = `${ratio * 100}%`;
      hud.hullLabel.textContent = `${Math.round(ratio * 100)}%`;
    }

    const offline = player?.disableTimer || {};
    if (hud.laserOffline) {
      hud.laserOffline.style.opacity = offline.laser > 0 ? 1 : 0;
      hud.laserOffline.textContent = offline.laser > 0 ? `OFF ${offline.laser.toFixed(1)}s` : "";
    }
    if (hud.torpFrontOffline) {
      hud.torpFrontOffline.style.opacity = offline.torpFront > 0 ? 1 : 0;
      hud.torpFrontOffline.textContent = offline.torpFront > 0 ? `OFF ${offline.torpFront.toFixed(1)}s` : "";
    }
    if (hud.torpRearOffline) {
      hud.torpRearOffline.style.opacity = offline.torpRear > 0 ? 1 : 0;
      hud.torpRearOffline.textContent = offline.torpRear > 0 ? `OFF ${offline.torpRear.toFixed(1)}s` : "";
    }
    if (hud.torpFrontJam) {
      const jam = player?.targetingError?.front || 0;
      hud.torpFrontJam.style.opacity = jam > 0 ? 1 : 0;
      hud.torpFrontJam.textContent = jam > 0 ? `偏 ${jam.toFixed(1)}s` : "";
    }
    if (hud.torpRearJam) {
      const jam = player?.targetingError?.rear || 0;
      hud.torpRearJam.style.opacity = jam > 0 ? 1 : 0;
      hud.torpRearJam.textContent = jam > 0 ? `偏 ${jam.toFixed(1)}s` : "";
    }
  },

  updateRound(round) {
    hud.roundLabel.textContent = `回合：${round}`;
  },

  updateCompass(angle) {
    const deg = angle * 180 / Math.PI;
    hud.miniNeedle.style.transform = `translate(-50%, -70%) rotate(${deg}deg)`;
    let nearest = "N";
    let best = Infinity;
    for (const [name, a] of Object.entries(DIRECTION_ANGLES)) {
      const delta = Math.abs(((a - deg) + 540) % 360 - 180);
      if (delta < best) {
        best = delta;
        nearest = name;
      }
    }
    hud.miniDirLabel.textContent = nearest;
  },

  setDebugVisible(visible) {
    if (!hud.debugPanel) return;
    hud.debugPanel.classList.toggle("visible", visible);
  },

  updateDebug(data) {
    if (!hud.debugText) return;
    const lines = [];
    lines.push(`Round ${data.round} | ${data.faction} | ${data.difficulty}`);
    lines.push(`Pos (${data.pos.x.toFixed(1)}, ${data.pos.y.toFixed(1)}) v=${data.vel.toFixed(1)}`);
    lines.push(`Hull ${Math.round(data.hullRatio * 100)}%  Shield [${data.shield.map(s => s.toFixed(0)).join("/")}]`);
    lines.push(`Laser ${data.laser.state} t=${data.laser.timer.toFixed(2)} cd=${data.laser.cooldown.toFixed(2)} en=${data.laser.energy.toFixed(0)}`);
    lines.push(`Torp F ${data.torp.front}/${data.torp.frontMax} cd=${data.torp.cdFront.toFixed(2)} | R ${data.torp.rear}/${data.torp.rearMax} cd=${data.torp.cdRear.toFixed(2)}`);
    lines.push(`Offline L:${data.offline.laser.toFixed(1)} F:${data.offline.front.toFixed(1)} R:${data.offline.rear.toFixed(1)} | Jam F:${data.jam.front.toFixed(1)} R:${data.jam.rear.toFixed(1)}`);
    lines.push(`Invuln ${data.invuln.toFixed(2)} DashCD ${data.dash.toFixed(2)}`);
    lines.push(`DebugMode: ${data.debugMode ? "ON" : "OFF"} | Hotkeys: F3 toggle, 1/2/3/4 test hits`);
    hud.debugText.textContent = lines.join("\n");
  }
};
