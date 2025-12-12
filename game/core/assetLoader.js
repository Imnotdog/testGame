import { ASSETS } from "./assets.js";

const imageCache = {};

function flattenManifest(manifest, prefix = "") {
  const result = [];
  for (const [key, value] of Object.entries(manifest)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      result.push({ key: fullKey, src: value });
    } else if (typeof value === "object") {
      result.push(...flattenManifest(value, fullKey));
    }
  }
  return result;
}

export async function loadAssets() {
  const entries = flattenManifest(ASSETS);
  const promises = entries.map(entry => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      imageCache[entry.key] = img;
      resolve();
    };
    img.onerror = () => {
      console.warn(`[Assets] Failed to load ${entry.src}`);
      resolve();
    };
    img.src = entry.src;
  }));
  await Promise.all(promises);
}

export const Assets = {
  get(key) {
    return imageCache[key] || null;
  }
};
