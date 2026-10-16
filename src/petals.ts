/*
 * petals — the optional "whispiness" layer: soft, translucent petals composited
 * over the fluid gradient.
 *
 * ## behavior
 * - `createPetalLayer` builds a fixed arrangement of petals from the seed — one
 *   large cluster fanning out from a focus just off one canvas edge, and a
 *   smaller counter-cluster — and returns `shade`, which composites them onto a
 *   pixel the fluid gradient has already colored.
 * - The fluid gradient stays the base. `shade` first pulls the pixel toward the
 *   palette's lightest stop (the "veil", so the fluid calms into a pale ground),
 *   then blends each petal over it. Both scale with `amount`, so 0 is the
 *   untouched fluid and 1 is the full effect.
 * - Petal geometry and color depend only on `(seed, palette stops, aspect
 *   ratio)`, never on `amount`: sliding whispiness fades the same petals in
 *   rather than rearranging them.
 * - Petals take their colors from the palette's stops after the first. Each has
 *   its own edge softness (sharp ones read as in focus, soft ones as depth),
 *   fine lengthwise fibers, and a lighter rim.
 *
 * ## constraints
 * - This file draws only from its own stream, `createSeededRandom` over
 *   `<seed>::whisp`. It must never touch the stream `renderCanvas` seeds from the
 *   bare seed: that stream's order (three noise fields, then one grain value per
 *   pixel) is what keeps existing images and the Aspect fixture byte-for-byte
 *   stable. `renderCanvas` only calls in here when whispiness is above 0.
 * - The order of draws in this file is part of the output, and the constants
 *   (`VEIL`, the fiber/fringe/edge numbers, the profile exponents, the cluster
 *   counts and spreads) are the approved look, not tuning suggestions. Reordering
 *   a draw or editing one re-lays-out every whispy image for every seed. That
 *   includes the four anchor points in `buildPetals`, which are all evaluated
 *   even though only one is used.
 * - Coordinates are in height units (`pixelX / height`, `pixelY / height`). That
 *   keeps the composition identical at every size with the same aspect ratio,
 *   like the fluid layer's normalized sampling. Absolute pixels would make every
 *   size a different picture.
 * - `shade` mutates the color it is given and allocates nothing: it runs for
 *   every pixel times every petal.
 */
import { createNoise2D } from 'simplex-noise';
import { createSeededRandom, hashStringToInt } from './random';

type Rgb = [number, number, number];

type Petal = {
  focusX: number;
  focusY: number;
  cos: number;
  sin: number;
  length: number;
  halfWidth: number;
  /** Bend of the petal's spine, as a sideways offset per squared distance along it. */
  curve: number;
  /** 0 = crisp edge, 1 = very soft and faint. */
  softness: number;
  alpha: number;
  seedOffset: number;
  base: Rgb;
  tip: Rgb;
};

export type PetalLayer = {
  /** Composite the petals onto `color` (mutated). `x`/`y` are in height units. */
  shade(x: number, y: number, color: Rgb, amount: number): void;
};

/** How far full whispiness pulls the fluid toward the palette's lightest stop. */
const VEIL = 0.8;
const FIBER_ACROSS = 60;
const FIBER_ALONG = 1.2;
const FRINGE = 0.3;
const EDGE = 0.006;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function buildPetals(random: () => number, stops: Rgb[], aspectRatio: number): Petal[] {
  const petals: Petal[] = [];

  const cluster = (
    focusX: number,
    focusY: number,
    aimX: number,
    aimY: number,
    count: number,
    spread: number,
    lengthScale: number,
  ) => {
    const aim = Math.atan2(aimY - focusY, aimX - focusX);
    for (let i = 0; i < count; i++) {
      const fan = count === 1 ? 0 : i / (count - 1) - 0.5;
      const angle = aim + fan * spread + (random() - 0.5) * 0.18;
      const length = lengthScale * (0.6 + 0.55 * random());
      const baseIndex = 1 + Math.floor(random() * (stops.length - 1));
      const tipIndex = Math.min(stops.length - 1, baseIndex + (random() < 0.5 ? 1 : 0));
      const halfWidth = length * (0.17 + 0.13 * random());
      const softness = Math.pow(random(), 1.6);
      const curve = ((random() - 0.5) * 0.7) / length;
      const alpha = 0.6 + 0.3 * random();
      const seedOffset = random() * 50;
      petals.push({
        focusX,
        focusY,
        cos: Math.cos(angle),
        sin: Math.sin(angle),
        length,
        halfWidth,
        curve,
        softness,
        alpha,
        seedOffset,
        base: stops[baseIndex],
        tip: stops[tipIndex],
      });
    }
  };

  const side = Math.floor(random() * 4);
  const anchors = [
    [-0.08 * aspectRatio, 0.55 + 0.4 * random()],
    [1.08 * aspectRatio, 0.1 + 0.4 * random()],
    [aspectRatio * (0.2 + 0.6 * random()), 1.08],
    [aspectRatio * (0.2 + 0.6 * random()), -0.08],
  ];
  const [anchorX, anchorY] = anchors[side];
  cluster(
    anchorX,
    anchorY,
    aspectRatio * 0.5,
    0.5,
    6 + Math.floor(random() * 3),
    1.5 + random() * 0.4,
    1.05,
  );

  const oppositeX = aspectRatio - anchorX;
  const oppositeY = 1 - anchorY;
  cluster(
    oppositeX * 0.7 + aspectRatio * 0.15,
    oppositeY > 0.5 ? 1.1 : -0.1,
    aspectRatio * 0.5,
    0.5,
    3 + Math.floor(random() * 2),
    1.0,
    0.7,
  );
  return petals;
}

export function createPetalLayer(seed: string, stops: Rgb[], aspectRatio: number): PetalLayer {
  const random = createSeededRandom(hashStringToInt(`${seed}::whisp`));
  const fiberNoise = createNoise2D(random);
  const edgeNoise = createNoise2D(random);
  const petals = buildPetals(random, stops, aspectRatio);
  const [veilR, veilG, veilB] = stops[0];

  const fiberAt = (x: number, y: number) =>
    0.5 * fiberNoise(x, y) + 0.25 * fiberNoise(x * 2, y * 2);

  return {
    shade(x, y, color, amount) {
      const veil = VEIL * amount;
      color[0] += (veilR - color[0]) * veil;
      color[1] += (veilG - color[1]) * veil;
      color[2] += (veilB - color[2]) * veil;

      for (const petal of petals) {
        const dx = x - petal.focusX;
        const dy = y - petal.focusY;
        const along = dx * petal.cos + dy * petal.sin;
        if (along < 0 || along > petal.length) continue;
        const t = along / petal.length;
        const across = -dx * petal.sin + dy * petal.cos - petal.curve * along * along;
        // Rounded teardrop: narrow at the base, fullest around mid-length, round tip.
        const width = petal.halfWidth * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.55)), 0.6);
        const reach = Math.abs(across);
        if (reach > width * 1.6 + 0.03 + petal.softness * 0.12) continue;

        const fiber = fiberAt(across * FIBER_ACROSS + petal.seedOffset, along * FIBER_ALONG + petal.seedOffset);
        const ragged =
          edgeNoise((across / petal.halfWidth) * 3 + petal.seedOffset, along * 2.2) * 0.8 + fiber * 0.15;
        const distance = reach - width * (1 + FRINGE * ragged * (0.7 - 0.5 * t));
        const softEdge = EDGE + petal.softness * 0.07;
        let coverage = 1 - smoothstep(-softEdge, softEdge, distance);
        if (coverage <= 0) continue;

        const fiberLight = fiber * 0.5 + 0.5;
        const fiberShade = 1 - 0.38 * Math.max(0, 1 - petal.softness * 3) * (1 - fiberLight);
        coverage *=
          smoothstep(0, 0.12, t) *
          (1 - smoothstep(0.88, 1, t)) *
          fiberShade *
          petal.alpha *
          (1 - 0.35 * petal.softness) *
          amount;

        // Base→tip gradient, lighter toward the rim for a translucent look.
        const rim = clamp01(reach / Math.max(width, 1e-4));
        const lift = 0.55 * rim * rim * rim + 0.18 * (1 - t) * fiberLight;
        const blend = clamp01(coverage);
        for (let channel = 0; channel < 3; channel++) {
          const petalColor = petal.base[channel] + (petal.tip[channel] - petal.base[channel]) * t;
          const lit = petalColor + (stops[0][channel] - petalColor) * lift;
          color[channel] += (lit - color[channel]) * blend;
        }
      }
    },
  };
}
