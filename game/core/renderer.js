const BG_STATE = {
  inited: false,
  stars: { near: [], mid: [], far: [] },
  clusters: [],
  blobs: [],
  nebulaSeed: Math.random() * 1000
};

function initBackground(width, height) {
  const makeStars = (count, sizeMin, sizeMax, alphaMin, alphaMax) => {
    const arr = [];
    for (let i = 0; i < count; i++) {
      arr.push({
        x: Math.random() * width,
        y: Math.random() * height,
        size: sizeMin + Math.random() * (sizeMax - sizeMin),
        alpha: alphaMin + Math.random() * (alphaMax - alphaMin),
        twinkle: 0.5 + Math.random() * 1.5
      });
    }
    return arr;
  };
  BG_STATE.stars.near = makeStars(160, 1.0, 2.2, 0.5, 1.0);
  BG_STATE.stars.mid = makeStars(240, 0.8, 1.6, 0.3, 0.8);
  BG_STATE.stars.far = makeStars(320, 0.6, 1.2, 0.15, 0.4);
  BG_STATE.clusters = Array.from({ length: 18 }).map(() => ({
    x: Math.random() * width,
    y: Math.random() * height,
    r: 6 + Math.random() * 16,
    alpha: 0.35 + Math.random() * 0.35,
    hue: 200 + Math.random() * 80
  }));
  BG_STATE.blobs = Array.from({ length: 40 }).map(() => ({
    x: Math.random() * width,
    y: Math.random() * height,
    r: width * (0.08 + Math.random() * 0.18),
    alpha: 0.1 + Math.random() * 0.16,
    hue: 180 + Math.random() * 140,
    sat: 50 + Math.random() * 30,
    light: 22 + Math.random() * 20
  }));
  BG_STATE.inited = true;
}

function parallaxOffset(player, width, height, factor) {
  if (!player) return { x: 0, y: 0 };
  const px = (player.x / width) - 0.5;
  const py = (player.y / height) - 0.5;
  const nonLinear = (v) => Math.sign(v) * Math.pow(Math.abs(v), 1.2);
  return { x: nonLinear(px) * factor * width * 0.05, y: nonLinear(py) * factor * height * 0.05 };
}

export const Renderer = {
  drawBackground(ctx, width, height, player = null) {
    if (!BG_STATE.inited) initBackground(width, height);
    const t = performance.now() * 0.001;
    const normX = player ? (player.x / width - 0.5) : 0;
    const normY = player ? (player.y / height - 0.5) : 0;
    const skewX = normX * 0.12;
    const skewY = -normY * 0.12;
    const tilt = 0.78 + Math.min(0.22, (Math.abs(normX) + Math.abs(normY)) * 0.14);
    ctx.save();
    ctx.fillStyle = "#03040a";
    ctx.fillRect(0, 0, width, height);

    // Nebula/gradient base
    const baseRot = t * 0.01;
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate(baseRot);
    const nebula = ctx.createRadialGradient(0, 0, width * 0.05, 0, 0, Math.max(width, height) * 0.7);
    nebula.addColorStop(0, "rgba(20,30,60,0.6)");
    nebula.addColorStop(0.35, "rgba(10,15,30,0.5)");
    nebula.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = nebula;
    ctx.scale(1.2, 0.9);
    ctx.beginPath();
    ctx.rect(-width, -height, width * 2, height * 2);
    ctx.fill();
    ctx.restore();

    // Parallax offsets
    const offNear = parallaxOffset(player, width, height, 1.0);
    const offMid = parallaxOffset(player, width, height, 0.6);
    const offFar = parallaxOffset(player, width, height, 0.3);

    // Galaxy disk with perspective skew
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate(t * 0.004);
    ctx.transform(1, skewY, skewX, tilt, 0, 0);
    const diskGrad = ctx.createRadialGradient(0, 0, width * 0.08, 0, 0, Math.max(width, height) * 0.7);
    diskGrad.addColorStop(0, "rgba(60,80,140,0.45)");
    diskGrad.addColorStop(0.4, "rgba(40,50,90,0.32)");
    diskGrad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = diskGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, width, height * 0.65, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Soft color blobs to increase richness
    ctx.save();
    ctx.translate(offMid.x * 0.4, offMid.y * 0.4);
    for (const b of BG_STATE.blobs) {
      const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      g.addColorStop(0, `hsla(${b.hue},${b.sat}%,${b.light + 10}%,${b.alpha * 1.2})`);
      g.addColorStop(1, `hsla(${b.hue},${b.sat}%,${b.light}%,0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Spiral arms (two layers)
    const drawArmLayer = (radiusScale, alpha, rotSpeed, color) => {
      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.rotate(t * rotSpeed);
      ctx.transform(1, skewY * 0.8, skewX * 0.8, tilt, 0, 0);
      ctx.globalAlpha = alpha;
      ctx.scale(radiusScale, radiusScale * 0.82);
      const armCount = 3;
      for (let i = 0; i < armCount; i++) {
        ctx.save();
        ctx.rotate((Math.PI * 2 / armCount) * i);
        const grad = ctx.createRadialGradient(0, 0, 40, 0, 0, Math.max(width, height) * 0.8);
        grad.addColorStop(0, `${color}0.18)`);
        grad.addColorStop(0.3, `${color}0.14)`);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.rect(0, -height, Math.max(width, height), height * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    };
    drawArmLayer(1.05, 0.22, 0.006, "rgba(130,180,255,");
    drawArmLayer(0.95, 0.18, -0.004, "rgba(190,170,255,");

    // Stars helper
    const drawStars = (stars, offset, rotSpeed) => {
      ctx.save();
      ctx.translate(width / 2 + offset.x, height / 2 + offset.y);
      ctx.rotate(t * rotSpeed);
      ctx.translate(-width / 2, -height / 2);
      for (const s of stars) {
        const tw = 0.5 + 0.5 * Math.sin(t * s.twinkle + s.x * 0.01);
        ctx.globalAlpha = s.alpha * tw;
        ctx.fillStyle = `rgba(255,255,255,${s.alpha * tw})`;
        ctx.fillRect(s.x, s.y, s.size, s.size);
      }
      ctx.restore();
    };
    drawStars(BG_STATE.stars.far, offFar, 0.003);
    drawStars(BG_STATE.stars.mid, offMid, -0.006);
    drawStars(BG_STATE.stars.near, offNear, 0.01);

    // Clusters (highlighted star groups)
    ctx.save();
    ctx.translate(width / 2 + offNear.x * 0.7, height / 2 + offNear.y * 0.7);
    ctx.rotate(t * 0.004);
    ctx.translate(-width / 2, -height / 2);
    for (const c of BG_STATE.clusters) {
      ctx.save();
      ctx.globalAlpha = c.alpha * (0.6 + 0.4 * Math.sin(t * 0.7 + c.x * 0.01));
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r * 2);
      g.addColorStop(0, `hsla(${c.hue},80%,75%,0.9)`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r * 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    ctx.restore();
  }
};
