import { DIRECTION_ANGLES, NUMPAD_DIRECTION_MAP } from "../config.js";

const keys = new Set();
const numpadPressed = new Set();
const arrowPressed = new Set();

function mapKeyToArrow(code) {
  switch (code) {
    case "ArrowUp":
    case "KeyW":
      return "Up";
    case "ArrowDown":
    case "KeyS":
      return "Down";
    case "ArrowLeft":
    case "KeyA":
      return "Left";
    case "ArrowRight":
    case "KeyD":
      return "Right";
    default:
      return null;
  }
}

function directionFromNumpad() {
  if (numpadPressed.size === 0) return null;
  const digits = Array.from(numpadPressed).filter(d => d !== "5").sort();
  if (!digits.length) return null;
  const key = digits.join("");
  if (NUMPAD_DIRECTION_MAP[key]) return NUMPAD_DIRECTION_MAP[key];

  if (digits.length >= 2) {
    for (let i = 0; i < digits.length; i++) {
      for (let j = i + 1; j < digits.length; j++) {
        const combo = digits[i] + digits[j];
        if (NUMPAD_DIRECTION_MAP[combo]) return NUMPAD_DIRECTION_MAP[combo];
      }
    }
  }
  return NUMPAD_DIRECTION_MAP[digits[0]] || null;
}

function directionFromArrows() {
  const up = arrowPressed.has("Up");
  const down = arrowPressed.has("Down");
  const left = arrowPressed.has("Left");
  const right = arrowPressed.has("Right");

  const vConflict = up && down;
  const hConflict = left && right;

  if (!vConflict && up && !hConflict && right) return "NE";
  if (!vConflict && up && !hConflict && left) return "NW";
  if (!vConflict && down && !hConflict && right) return "SE";
  if (!vConflict && down && !hConflict && left) return "SW";
  if (!vConflict && up && !left && !right) return "N";
  if (!vConflict && down && !left && !right) return "S";
  if (!hConflict && right && !up && !down) return "E";
  if (!hConflict && left && !up && !down) return "W";
  return null;
}

export const Input = {
  init() {
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      keys.add(e.code);
      if (/^Numpad[1-9]$/.test(e.code)) {
        const d = e.code.replace("Numpad", "");
        numpadPressed.add(d);
        e.preventDefault();
      }
      const arrow = mapKeyToArrow(e.code);
      if (arrow === "Up")   { arrowPressed.delete("Down"); arrowPressed.add("Up"); e.preventDefault(); }
      if (arrow === "Down") { arrowPressed.delete("Up");   arrowPressed.add("Down"); e.preventDefault(); }
      if (arrow === "Left") { arrowPressed.delete("Right");arrowPressed.add("Left"); e.preventDefault(); }
      if (arrow === "Right"){ arrowPressed.delete("Left"); arrowPressed.add("Right");e.preventDefault(); }
    });

    window.addEventListener("keyup", (e) => {
      keys.delete(e.code);
      if (/^Numpad[1-9]$/.test(e.code)) {
        const d = e.code.replace("Numpad", "");
        numpadPressed.delete(d);
        e.preventDefault();
      }
      const arrow = mapKeyToArrow(e.code);
      if (arrow === "Up")   { arrowPressed.delete("Up"); e.preventDefault(); }
      if (arrow === "Down") { arrowPressed.delete("Down"); e.preventDefault(); }
      if (arrow === "Left") { arrowPressed.delete("Left"); e.preventDefault(); }
      if (arrow === "Right"){ arrowPressed.delete("Right"); e.preventDefault(); }
    });
  },

  isDown(code) {
    return keys.has(code);
  },

  getDirectionName() {
    if (numpadPressed.size > 0) return directionFromNumpad();
    return directionFromArrows();
  },

  getDirectionAngle() {
    const name = this.getDirectionName();
    if (!name) return null;
    const deg = DIRECTION_ANGLES[name];
    return (deg ?? 0) * Math.PI / 180;
  },

  isTurnLeft() {
    return keys.has("ArrowLeft") || keys.has("KeyA") || keys.has("Numpad4") || keys.has("KeyQ");
  },

  isTurnRight() {
    return keys.has("ArrowRight") || keys.has("KeyD") || keys.has("Numpad6") || keys.has("KeyE");
  },

  isThrustForward() {
    return keys.has("ArrowUp") || keys.has("KeyW") || keys.has("Numpad8");
  },

  isThrustBackward() {
    return keys.has("ArrowDown") || keys.has("KeyS") || keys.has("Numpad2");
  }
};
