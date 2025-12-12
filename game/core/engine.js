let rafId = null;
let lastTime = 0;
let updateFn = () => {};
let renderFn = () => {};

export const Engine = {
  init({ update, render }) {
    updateFn = update;
    renderFn = render;
    lastTime = performance.now();
  },

  start() {
    lastTime = performance.now();
    const loop = (time) => {
      const dt = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;
      updateFn(dt);
      renderFn();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  },

  stop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }
};
