/*
 * sweep — the opt-in second pass behind `look.sweep` and `look.ground`.
 *
 * "Sweep" is dye drifting in slow water, photographed soft: the fluid's color
 * is carried through a large, smooth current, so fast parts of the current
 * pull it into thin curving wisps and slow parts leave soft folds, like silk
 * or a long-exposure flower. "Ground" is the pale base the color floats over,
 * in the palette's lightest stop, opened where the fluid is already lightest
 * so it reads as space for text. Neither draws objects, adds fiber texture,
 * or twirls.
 *
 * ## behavior
 * - `applySweep` rewrites the RGB of the fluid pass's pixels in place, before
 *   grain. It samples the fluid through `rampPositionAt` (the same function
 *   the fluid loop uses, evaluable off the canvas) and maps back through the
 *   same ramp, so every color is a ramp color or a blend toward the ground.
 * - Current: the curl of a low-frequency noise (divergence-free, so dye never
 *   piles up or thins out), soft-capped below a seeded drift, plus that drift.
 *   It slowly turns between two such fields over the trace, which folds the
 *   wisps.
 * - Advection: each point is traced backward through the current for
 *   `sweep × 1.6` image heights of drift and takes the fluid's color
 *   from where it lands. At sweep 0 nothing moves.
 * - Softening: a slight defocus blur, then a line integral convolution along
 *   the present current: each point blurs along its own path for one exposure
 *   (typical travel `sweep × 0.5` heights, flat-topped window), so wisps blur
 *   along their length more than across it, and still water barely blurs.
 * - Ground: coverage is the advected ramp position plus a domain-warped noise
 *   sampled at the same advected points; the lowest `ground × 0.9` share of
 *   the image becomes the lightest stop through a soft edge, which the
 *   softening then carries along.
 * - Everything runs on a working grid at most 400 px tall and is upsampled;
 *   about 1 s at 1200×1500.
 *
 * ## constraints
 * - Never draw from the fluid pass's `random`. Everything here comes from its
 *   own `<seed>::sweep` stream. One extra draw from the main stream shifts the
 *   grain of every image, sweep or not, and breaks the byte-for-byte Aspect
 *   fixture. `render.ts` calls in only when `sweep > 0 || ground > 0`.
 * - Keep the eddies slower than the drift (`eddyCap × √2 < 1`). Where an eddy
 *   outruns the drift its streamlines close, and the dye winds into bullseye
 *   rings — the twirl look that was rejected. A much higher
 *   `velocityFrequency` or longer `advectDistance` turns it into marbling.
 * - Alternatives already tried and rejected, so don't drift back to them:
 *   painting along curl-noise flow lines (reads as Van Gogh brushwork), fiber
 *   or strand feathering (watercolor, fur), and stretching along one camera
 *   motion (too linear). The references are smooth, soft photographs.
 * - The velocity grid's margin must cover the farthest a trace can travel.
 *   Traces that leave it read a clamped current and draw a hard-edged curve.
 * - The exposure follows the raw velocity, not its direction. Normalizing it
 *   flips the blur's direction across every stagnation point, which shows as
 *   sharp X-shaped creases.
 * - The constants below are part of the output for any seed rendered with
 *   sweep or ground, as `defaultLook` is for the fluid. Retune them only as a
 *   deliberate visual change, with before/after renders.
 */
import { createNoise2D } from 'simplex-noise';
import { createSeededRandom, hashStringToInt } from './random';

type Rgb = [number, number, number];

export type SweepInput = {
  seed: string;
  width: number;
  height: number;
  /** RGBA from the fluid pass, rewritten in place. Alpha is left alone. */
  pixels: Uint8ClampedArray;
  /** The fluid's ramp position (0–1) at any point, in height units; defined off the canvas too. */
  rampPositionAt: (u: number, v: number) => number;
  rgbStops: Rgb[];
  sampleRamp: (position: number) => Rgb;
  sweep: number;
  ground: number;
};

/** Lengths are in image heights, frequencies in cycles per image height. */
const tuning = {
  workHeight: 400,
  velocityFrequency: 0.4,
  /** Velocity grid cells per image height. */
  velocityResolution: 80,
  /** Travel at sweep 1, measured at drift speed. */
  advectDistance: 1.6,
  advectSteps: 32,
  /** Drift speed relative to the current's RMS speed. */
  drift: 1.0,
  /** Eddy speed cap, relative to the drift. Two fields mixed at most √2 ×
   * this, which must stay below 1 or eddies can close. */
  eddyCap: 0.65,
  /** Radians the current turns between its two fields over the trace. */
  timeSpin: 1.2,
  defocus: 0.008,
  smearLength: 0.5,
  smearSteps: 40,
  /** Fraction of the exposure at full weight before the window tapers. */
  smearFlat: 0.6,
  groundSoftness: 0.35,
  groundFieldWeight: 1.0,
  groundNoiseWeight: 0.6,
  groundBlur: 0.02,
  groundMaxCover: 0.9,
  groundFrequency: 0.9,
} as const;

const smoothStep = (edge: number) => edge * edge * (3 - 2 * edge);
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

type Noise = (x: number, y: number) => number;
const fractal = (noise: Noise, x: number, y: number) =>
  0.5 * noise(x, y) + 0.25 * noise(x * 2, y * 2);

/** A scalar grid sampled bilinearly in its own pixel coordinates. */
class Grid {
  readonly values: Float32Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.values = new Float32Array(width * height);
  }
  sample(x: number, y: number) {
    const gx = Math.max(0, Math.min(this.width - 1.0001, x));
    const gy = Math.max(0, Math.min(this.height - 1.0001, y));
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const v = this.values;
    const i = y0 * this.width + x0;
    const top = v[i] + (v[i + 1] - v[i]) * fx;
    const bottom = v[i + this.width] + (v[i + this.width + 1] - v[i + this.width]) * fx;
    return top + (bottom - top) * fy;
  }
}

export function applySweep(input: SweepInput) {
  const { seed, width, height, pixels, rampPositionAt, rgbStops, sampleRamp, sweep, ground } = input;
  const t = tuning;
  const random = createSeededRandom(hashStringToInt(`${seed}::sweep`));
  const currentNoiseA = createNoise2D(random);
  const currentNoiseB = createNoise2D(random);
  const coverageNoise = createNoise2D(random);
  const coverageWarpNoise = createNoise2D(random);
  const driftAngle = random() * Math.PI * 2;

  // Working grid, in its own pixels; height units are y / workH.
  const scale = Math.min(1, t.workHeight / height);
  const workW = Math.max(2, Math.round(width * scale));
  const workH = Math.max(2, Math.round(height * scale));
  const aspect = width / height;

  // ── Current: two curl-noise fields at unit RMS speed, plus the drift. ──
  const driftX = Math.cos(driftAngle) * t.drift;
  const driftY = Math.sin(driftAngle) * t.drift;
  // Speed never exceeds the drift plus √2 × the eddy cap (< 2× drift), and
  // `advectDistance` is measured at drift speed, so 2× covers any trace.
  const margin = 2 * t.advectDistance * sweep + 0.1;
  const cell = 1 / t.velocityResolution;
  const velW = Math.ceil((aspect + 2 * margin) / cell) + 2;
  const velH = Math.ceil((1 + 2 * margin) / cell) + 2;
  const currents = [currentNoiseA, currentNoiseB].map((noise) => {
    const vx = new Grid(velW, velH);
    const vy = new Grid(velW, velH);
    const f = t.velocityFrequency;
    const e = 0.002;
    let total = 0;
    for (let gy = 0; gy < velH; gy++) {
      for (let gx = 0; gx < velW; gx++) {
        const u = (gx * cell - margin) * f;
        const v = (gy * cell - margin) * f;
        const i = gy * velW + gx;
        vx.values[i] = (fractal(noise, u, v + e) - fractal(noise, u, v - e)) / (2 * e);
        vy.values[i] = -(fractal(noise, u + e, v) - fractal(noise, u - e, v)) / (2 * e);
        total += vx.values[i] ** 2 + vy.values[i] ** 2;
      }
    }
    // Unit RMS speed, then a soft cap below the drift: the current then always
    // makes headway along the drift, so no streamline closes into an eddy and
    // nothing stalls.
    const rms = Math.sqrt(total / vx.values.length) || 1;
    const cap = t.eddyCap * t.drift;
    for (let i = 0; i < vx.values.length; i++) {
      const speed = Math.hypot(vx.values[i], vy.values[i]) / rms + 1e-9;
      const limited = (cap * Math.tanh(speed / cap)) / speed / rms;
      vx.values[i] *= limited;
      vy.values[i] *= limited;
    }
    return { vx, vy };
  });
  const velocity = (u: number, v: number, phase: number, out: number[]) => {
    const gx = (u + margin) / cell;
    const gy = (v + margin) / cell;
    const a = Math.cos(phase);
    const b = Math.sin(phase);
    out[0] = a * currents[0].vx.sample(gx, gy) + b * currents[1].vx.sample(gx, gy) + driftX;
    out[1] = a * currents[0].vy.sample(gx, gy) + b * currents[1].vy.sample(gx, gy) + driftY;
  };

  // ── Advection: trace each point back to where its dye came from. ──
  const flowX = new Grid(workW, workH);
  const flowY = new Grid(workW, workH);
  const fieldSource = new Grid(workW, workH);
  const sourceU = new Float32Array(workW * workH);
  const sourceV = new Float32Array(workW * workH);
  const steps = t.advectSteps;
  const dt = (sweep * t.advectDistance) / t.drift / steps;
  const k1 = [0, 0];
  const k2 = [0, 0];
  for (let y = 0; y < workH; y++) {
    for (let x = 0; x < workW; x++) {
      let u = x / workH;
      let v = y / workH;
      const i = y * workW + x;
      velocity(u, v, 0, k1);
      flowX.values[i] = k1[0];
      flowY.values[i] = k1[1];
      for (let s = 0; s < steps; s++) {
        const phase = (t.timeSpin * s) / steps;
        velocity(u, v, phase, k1);
        velocity(u - (k1[0] * dt) / 2, v - (k1[1] * dt) / 2, phase, k2);
        u -= k2[0] * dt;
        v -= k2[1] * dt;
      }
      sourceU[i] = u;
      sourceV[i] = v;
      fieldSource.values[i] = rampPositionAt(u, v);
    }
  }
  boxBlur(fieldSource.values, workW, workH, Math.max(1, Math.round(t.defocus * sweep * workH)), 3);

  // ── Ground: opens first where the fluid is already near the light end. ──
  const coverageSource = new Grid(workW, workH);
  if (ground > 0) {
    for (let y = 0; y < workH; y++) {
      for (let x = 0; x < workW; x++) {
        const i = y * workW + x;
        const su = sourceU[i] * t.groundFrequency;
        const sv = sourceV[i] * t.groundFrequency;
        const warpX = fractal(coverageWarpNoise, su, sv);
        const warpY = fractal(coverageWarpNoise, su + 5.2, sv + 1.3);
        coverageSource.values[i] =
          t.groundFieldWeight * fieldSource.values[i] + t.groundNoiseWeight * fractal(coverageNoise, su + warpX, sv + warpY);
      }
    }
    const sorted = Float32Array.from(coverageSource.values).sort();
    const threshold = sorted[Math.min(sorted.length - 1, Math.floor(ground * t.groundMaxCover * sorted.length))];
    for (let i = 0; i < coverageSource.values.length; i++) coverageSource.values[i] -= threshold;
    boxBlur(coverageSource.values, workW, workH, Math.max(1, Math.round(t.groundBlur * workH)), 3);
  }

  // ── Exposure: average along the present current (line integral convolution). ──
  const smearedField = new Grid(workW, workH);
  const smearedCoverage = new Grid(workW, workH);
  // Blur is speed × exposure time, so it fades to nothing where the current
  // stalls; a fixed length there would flip direction between neighbors and
  // draw a hard crease. Exposure time is set so typical travel is the length.
  const smearSteps = t.smearSteps;
  const step = (sweep * t.smearLength * workH) / 2 / Math.hypot(1, t.drift) / smearSteps;
  const weights = new Float32Array(smearSteps + 1);
  for (let s = 0; s <= smearSteps; s++) {
    const along = s / (smearSteps + 1);
    weights[s] = along <= t.smearFlat ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (along - t.smearFlat)) / (1 - t.smearFlat));
  }
  for (let y = 0; y < workH; y++) {
    for (let x = 0; x < workW; x++) {
      let fieldTotal = weights[0] * fieldSource.sample(x, y);
      let coverageTotal = ground > 0 ? weights[0] * coverageSource.sample(x, y) : 0;
      let weightTotal = weights[0];
      for (let direction = -1; direction <= 1; direction += 2) {
        let px = x;
        let py = y;
        for (let s = 1; s <= smearSteps; s++) {
          const mx = px + (direction * flowX.sample(px, py) * step) / 2;
          const my = py + (direction * flowY.sample(px, py) * step) / 2;
          px += direction * flowX.sample(mx, my) * step;
          py += direction * flowY.sample(mx, my) * step;
          if (px < 0 || py < 0 || px > workW - 1 || py > workH - 1) break;
          const w = weights[s];
          fieldTotal += w * fieldSource.sample(px, py);
          if (ground > 0) coverageTotal += w * coverageSource.sample(px, py);
          weightTotal += w;
        }
      }
      smearedField.values[y * workW + x] = fieldTotal / weightTotal;
      smearedCoverage.values[y * workW + x] = coverageTotal / weightTotal;
    }
  }

  // ── Compose at full resolution. ──
  const groundColor = rgbStops[0];
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const sx = (px + 0.5) * scale - 0.5;
      const sy = (py + 0.5) * scale - 0.5;
      let [r, g, b] = sampleRamp(smearedField.sample(sx, sy));
      if (ground > 0) {
        const m = smoothStep(clamp01(smearedCoverage.sample(sx, sy) / t.groundSoftness + 0.5));
        r = groundColor[0] + (r - groundColor[0]) * m;
        g = groundColor[1] + (g - groundColor[1]) * m;
        b = groundColor[2] + (b - groundColor[2]) * m;
      }
      const o = (py * width + px) * 4;
      pixels[o] = r;
      pixels[o + 1] = g;
      pixels[o + 2] = b;
    }
  }
}

function boxBlur(values: Float32Array, width: number, height: number, radius: number, passes: number) {
  const scratch = new Float32Array(values.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let total = 0;
        for (let k = -radius; k <= radius; k++) total += values[y * width + Math.max(0, Math.min(width - 1, x + k))];
        scratch[y * width + x] = total / (2 * radius + 1);
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let total = 0;
        for (let k = -radius; k <= radius; k++) total += scratch[Math.max(0, Math.min(height - 1, y + k)) * width + x];
        values[y * width + x] = total / (2 * radius + 1);
      }
    }
  }
}
