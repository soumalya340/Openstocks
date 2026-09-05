/**
 * Geometric Brownian motion price step (pure, shared by TUI + tests).
 * S' = S · exp((μ − σ²/2)Δt + σ√Δt · Z), Z ~ N(0,1); floored at 0.01.
 */

export const GBM = {
  MU: 0,
  SIGMA: 0.02,
  DT: 1,
};

/** Box–Muller standard normal sample. */
export function sampleNormal() {
  let u1 = 0;
  let u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * One GBM step. Inject Z for deterministic tests.
 * @param {number} S spot (> 0)
 * @param {number} Z standard normal shock
 * @param {number} [mu]
 * @param {number} [sigma]
 * @param {number} [dt]
 * @returns {number} next price (> 0)
 */
export function gbmNextPrice(
  S,
  Z,
  mu = GBM.MU,
  sigma = GBM.SIGMA,
  dt = GBM.DT
) {
  if (!(S > 0) || !Number.isFinite(S)) {
    throw new Error("spot must be positive");
  }
  const drift = (mu - (sigma * sigma) / 2) * dt;
  const diffusion = sigma * Math.sqrt(dt) * Z;
  const next = S * Math.exp(drift + diffusion);
  return Math.max(0.01, Number(next.toFixed(4)));
}
