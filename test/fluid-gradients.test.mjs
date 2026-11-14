/*
 * fluid-gradients.test — the suite that pins determinism, palette selection and
 * CLI/API parity.
 *
 * ## behavior
 * - Everything is imported from `dist/`, not `src/`. `npm test` builds first, so
 *   these run against the published artifact.
 * - `test/fixtures/jewel-peacock-aspect.webp` is Aspect's released 0.3.0
 *   artwork. The render of seed `aspect` + `jewel-peacock` is compared to it
 *   byte-for-byte.
 *
 * ## constraints
 * - The fixture is evidence, not a snapshot. Never regenerate it, replace it
 *   with current output, or relax the comparison to a size or pixel-tolerance
 *   check to get the suite green: it is the only thing standing between an edit
 *   to `src/render.ts` or `src/random.ts` and silently re-rendering artwork that
 *   has already shipped in another product. A failure here means the change is
 *   wrong, unless a `sharp`/`libwebp` bump is the cause — then compare decoded
 *   pixels first and say so in the commit that touches the fixture.
 * - The CLI checks read flags back out of the generated `helpText`, which is why
 *   they catch a render option that has no flag. Replacing that with a
 *   hardcoded list of flag names turns the test into a restatement of itself and
 *   it will pass forever.
 * - The rendezvous-hashing tests (order independence, add/remove stability, even
 *   distribution over 2000 seeds) are the specification of `pickPalette`, not
 *   sampling noise. Do not loosen the thresholds or shrink the seed count to
 *   quiet a failure — a genuine failure there means seeds have been reassigned
 *   to different palettes.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  colorPalettes,
  complementColor,
  createMeshGradients,
  findPalette,
  generateMeshGradient,
  paletteAccent,
  paletteComplement,
  pickPalette,
  renderMeshGradient,
  validatePalette,
} from '../dist/index.js';

test('palette names are unique and every color is a 6-digit hex', () => {
  const names = colorPalettes.map((p) => p.name);
  assert.equal(new Set(names).size, names.length);
  for (const palette of colorPalettes) {
    assert.doesNotThrow(() => validatePalette(palette), palette.name);
  }
});

test('findPalette throws with the valid names on a miss', () => {
  assert.equal(findPalette('mint-sea').name, 'mint-sea');
  assert.throws(() => findPalette('nope'), /Unknown palette "nope"/);
});

const seeds = Array.from({ length: 2000 }, (_, i) => `seed-${i}`);
const picks = (palettes) => seeds.map((seed) => pickPalette(seed, palettes).name);

test('pickPalette is deterministic and ignores list order', () => {
  assert.equal(pickPalette('autocad-0.3.0').name, pickPalette('autocad-0.3.0').name);
  assert.deepEqual(picks([...colorPalettes].reverse()), picks(colorPalettes));
});

test('pickPalette uses every palette roughly evenly', () => {
  const counts = new Map();
  for (const name of picks(colorPalettes)) counts.set(name, (counts.get(name) ?? 0) + 1);
  assert.equal(counts.size, colorPalettes.length);
  const expected = seeds.length / colorPalettes.length; // ~54
  for (const [name, count] of counts) assert.ok(count > expected * 0.4 && count < expected * 2, `${name}: ${count}`);
});

test('adding a palette only moves seeds onto the new palette', () => {
  const extra = { name: 'brand', colors: ['#ffffff', '#888888', '#000000'] };
  const before = picks(colorPalettes);
  const after = picks([...colorPalettes, extra]);
  const moved = after.filter((name, i) => name !== before[i]);
  assert.ok(moved.length > 0);
  assert.ok(moved.every((name) => name === 'brand'));
});

test('removing a palette only moves seeds that had picked it', () => {
  const before = picks(colorPalettes);
  const after = picks(colorPalettes.filter((p) => p.name !== 'mint-sea'));
  after.forEach((name, i) => {
    if (before[i] !== 'mint-sea') assert.equal(name, before[i]);
  });
});

test('validatePalette enforces 3–5 #rrggbb colors', () => {
  const colors = (n) => Array.from({ length: n }, () => '#abcdef');
  assert.throws(() => validatePalette({ name: 'a', colors: colors(2) }), /3–5 colors. Got 2/);
  assert.throws(() => validatePalette({ name: 'a', colors: colors(6) }), /3–5 colors. Got 6/);
  assert.throws(() => validatePalette({ name: 'a', colors: ['#fff', '#000000', '#000000'] }), /invalid color "#fff"/);
  assert.throws(() => validatePalette({ name: '', colors: colors(3) }), /non-empty name/);
  assert.doesNotThrow(() => validatePalette({ name: 'a', colors: colors(5) }));
});

test('createMeshGradients validates its set up front', () => {
  const good = { name: 'a', colors: ['#ffffff', '#888888', '#000000'] };
  assert.throws(() => createMeshGradients({ palettes: [] }), /At least one/);
  assert.throws(() => createMeshGradients({ palettes: [good, good] }), /Duplicate palette name "a"/);
  assert.throws(() => createMeshGradients({ palettes: [{ name: 'b', colors: ['#ffffff'] }] }), /Got 1/);
});

test('createMeshGradients picks, finds, and renders only from its own set', async () => {
  const brand = { name: 'brand', colors: ['#ffffff', '#888888', '#000000'] };
  const gradients = createMeshGradients({ palettes: [brand] });
  assert.equal(gradients.pickPalette('anything').name, 'brand');
  assert.throws(() => gradients.findPalette('mint-sea'), /Unknown palette "mint-sea"/);
  const result = await gradients.generate({ seed: 'x', format: 'png', width: 8, height: 8 });
  assert.equal(result.palette.name, 'brand');
  await assert.rejects(
    gradients.generate({ seed: 'x', palette: { name: 'bad', colors: ['#ffffff', '#000000'] } }),
    /3–5 colors/,
  );
});

test('createMeshGradients applies default size, per-call size wins', async () => {
  const gradients = createMeshGradients({ palettes: colorPalettes, width: 40, height: 20 });
  const defaults = await gradients.generate({ seed: 'x', format: 'png' });
  assert.deepEqual([defaults.width, defaults.height], [40, 20]);
  const overridden = await gradients.generate({ seed: 'x', format: 'png', height: 10 });
  assert.deepEqual([overridden.width, overridden.height], [40, 10]);
  const canvas = await gradients.render({ seed: 'x' });
  assert.deepEqual([canvas.canvas.width, canvas.canvas.height], [40, 20]);
});

test('createMeshGradients rejects invalid sizes', async () => {
  assert.throws(() => createMeshGradients({ palettes: colorPalettes, width: 0 }), /width must be a positive integer/);
  assert.throws(() => createMeshGradients({ palettes: colorPalettes, height: 1.5 }), /height must be a positive integer/);
  const gradients = createMeshGradients({ palettes: colorPalettes });
  await assert.rejects(gradients.generate({ seed: 'x', width: -1 }), /width must be a positive integer/);
});

test('paletteAccent returns the mid-tone', () => {
  assert.equal(paletteAccent(findPalette('jewel-peacock')), '#1f7a99');
});

// OKLab lightness + hue of a hex, for checking complements independently of src/color.ts.
function oklab(hex) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, C: Math.hypot(A, B), h: Math.atan2(B, A) };
}

test('every palette complement is vivid, readable and opposite the accent hue', () => {
  for (const palette of colorPalettes) {
    const accent = oklab(paletteAccent(palette));
    const complement = oklab(paletteComplement(palette));
    if (complement.C < 0.01) continue; // hueless palettes get a gray, pinned below
    // Visibility is the point: a muted complement disappears on the image.
    assert.ok(complement.C > 0.1, `${palette.name}: chroma ${complement.C.toFixed(3)} too muted`);
    assert.ok(complement.L > 0.49 && complement.L < 0.81, `${palette.name}: lightness out of band`);
    if (accent.C < 0.03) continue; // near-gray accents take their hue from the ramp
    let delta = Math.abs(accent.h - complement.h) * (180 / Math.PI);
    if (delta > 180) delta = 360 - delta;
    assert.ok(Math.abs(180 - delta) < 5, `${palette.name}: hue ${delta.toFixed(1)}° apart`);
  }
});

test('complements pin known values; grays get the opposite-lightness gray', () => {
  assert.equal(paletteComplement(findPalette('battleship-steel')), '#e74c92'); // hue from the ramp
  assert.equal(paletteComplement(findPalette('jewel-peacock')), '#fc6d00');
  assert.equal(paletteComplement(findPalette('onyx-snow')), '#cecece');
  assert.equal(complementColor('#2f4fd8'), '#eab500');
  assert.equal(complementColor('#4A4A4A'), '#cecece');
  assert.equal(complementColor('#f0f0f0'), '#222222');
});

// Fixture is Aspect's released 0.3.0 artwork (seed "aspect", jewel-peacock,
// 1200×1500, WebP q82). Matching it byte-for-byte proves the extraction did not
// change the look. Encoder upgrades (sharp/libwebp) can shift bytes without a
// visual change — if this alone fails after a dependency bump, compare pixels.
test('reproduces the Aspect 0.3.0 release gradient exactly', async () => {
  const result = await generateMeshGradient({ seed: 'aspect', palette: 'jewel-peacock' });
  const fixture = readFileSync(new URL('./fixtures/jewel-peacock-aspect.webp', import.meta.url));
  assert.equal(result.accent, '#1f7a99');
  assert.equal(result.complement, '#fc6d00');
  assert.equal(result.width, 1200);
  assert.equal(result.height, 1500);
  assert.ok(result.buffer.equals(fixture), 'rendered WebP differs from fixture');
});

test('png output honors custom size', async () => {
  const result = await generateMeshGradient({ seed: 'x', format: 'png', width: 64, height: 32 });
  assert.equal(result.format, 'png');
  assert.equal(result.buffer.subarray(1, 4).toString(), 'PNG');
  assert.equal(result.width, 64);
});

test('sweep and ground at 0 are byte-identical to omitting them, including the Aspect fixture', async () => {
  const fixture = readFileSync(new URL('./fixtures/jewel-peacock-aspect.webp', import.meta.url));
  const explicit = await generateMeshGradient({
    seed: 'aspect',
    palette: 'jewel-peacock',
    look: { sweep: 0, ground: 0 },
  });
  assert.ok(explicit.buffer.equals(fixture), 'sweep: 0 / ground: 0 changed the default render');
});

test('sweep and ground are deterministic, change the image, and reject out-of-range values', async () => {
  const base = { palette: 'tulip-blur', format: 'png', width: 96, height: 120 };
  const plain = await generateMeshGradient({ ...base, seed: 's' });
  const swept = await generateMeshGradient({ ...base, seed: 's', look: { sweep: 0.7 } });
  const again = await generateMeshGradient({ ...base, seed: 's', look: { sweep: 0.7 } });
  const lighter = await generateMeshGradient({ ...base, seed: 's', look: { sweep: 0.3 } });
  const grounded = await generateMeshGradient({ ...base, seed: 's', look: { ground: 0.5 } });
  assert.ok(swept.buffer.equals(again.buffer), 'same seed + sweep must render the same bytes');
  assert.ok(!swept.buffer.equals(plain.buffer), 'sweep should change the image');
  assert.ok(!swept.buffer.equals(lighter.buffer), 'sweep amounts should differ');
  assert.ok(!grounded.buffer.equals(plain.buffer), 'ground should change the image');
  for (const knob of ['sweep', 'ground']) {
    for (const bad of [-0.1, 1.1, Number.NaN]) {
      await assert.rejects(
        generateMeshGradient({ ...base, seed: 's', look: { [knob]: bad } }),
        new RegExp(`look.${knob} must be between 0 and 1`),
      );
    }
  }
});

// `ground` sets a floor on how much of the image is near-lightest-stop, not an
// increment: areas the fluid already left light count toward the share.
test('ground opens roughly its share of the image to the lightest stop', async () => {
  const palette = findPalette('jewel-peacock');
  const [lightR, lightG, lightB] = [1, 3, 5].map((i) => parseInt(palette.colors[0].slice(i, i + 2), 16));
  const groundShare = async (ground) => {
    const { canvas } = await renderMeshGradient({
      seed: 'g',
      palette: palette.name,
      width: 120,
      height: 150,
      look: { ground, grainOpacity: 0 },
    });
    const { data } = canvas.getContext('2d').getImageData(0, 0, 120, 150);
    let near = 0;
    for (let i = 0; i < data.length; i += 4) {
      const distance = Math.hypot(data[i] - lightR, data[i + 1] - lightG, data[i + 2] - lightB);
      if (distance < 12) near++;
    }
    return near / (data.length / 4);
  };
  const none = await groundShare(0);
  const half = await groundShare(0.5);
  const most = await groundShare(1);
  assert.ok(half > none && half > 0.4, `ground 0.5 should open space (${none} → ${half})`);
  assert.ok(most > half && most > 0.8, `ground 1 should open most of it (${half} → ${most})`);
});

// ── CLI ────────────────────────────────────────────────────────────────────
// The CLI holds no flag list of its own: parser, help and options all come from
// the flag tables, so these checks are what keeps it level with the TS API.
const { helpText, runCli } = await import('../dist/cli.js');
const { defaultLook } = await import('../dist/index.js');

test('every render option has a CLI flag', () => {
  // The help text is generated from the flag tables, so reading it back is the
  // same as reading the tables.
  const flagged = [...helpText.matchAll(/^ {2}--([a-z-]+)/gm)].map((m) => m[1]);
  for (const knob of Object.keys(defaultLook)) {
    const flag = knob.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    assert.ok(flagged.includes(flag), `missing --${flag}`);
  }
  for (const flag of ['seed', 'palette', 'width', 'height', 'quality', 'out', 'json']) {
    assert.ok(flagged.includes(flag), `missing --${flag}`);
  }
});

test('runCli writes a file and honors look flags', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluid-cli-'));
  const out = join(dir, 'out.png');
  await runCli(['--seed', 'cli', '--palette', 'mint-sea', '--width', '32', '--height', '32', '--grain-opacity', '0', '--out', out]);
  assert.ok(statSync(out).size > 0);
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the CLI with --json and returns the parsed metadata line. */
async function runJson(args) {
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(line);
  try {
    await runCli([...args, '--json']);
  } finally {
    console.log = log;
  }
  return JSON.parse(lines.at(-1));
}

test('runCli derives the palette from the seed and honors an explicit one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluid-cli-'));
  const args = ['--width', '4', '--height', '4'];
  const a = await runJson([...args, '--seed', 'fixed', '--out', join(dir, 'a.png')]);
  const b = await runJson([...args, '--seed', 'fixed', '--out', join(dir, 'b.png')]);
  assert.equal(a.palette, b.palette);
  assert.equal(a.palette, pickPalette('fixed').name);

  const explicit = await runJson([...args, '--seed', 'fixed', '--palette', 'mint-sea', '--out', join(dir, 'c.png')]);
  assert.equal(explicit.palette, 'mint-sea');
  rmSync(dir, { recursive: true, force: true });
});

test('runCli uses a random seed when none is given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluid-cli-'));
  const a = await runJson(['--width', '4', '--height', '4', '--out', join(dir, 'a.png')]);
  const b = await runJson(['--width', '4', '--height', '4', '--out', join(dir, 'b.png')]);
  rmSync(dir, { recursive: true, force: true });
  assert.notEqual(a.seed, b.seed);
  assert.equal(a.palette, pickPalette(a.seed).name);
});

test('runCli --random-palette ignores the seed-derived pick; --chaos is seed-deterministic', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluid-cli-'));
  const args = ['--width', '4', '--height', '4', '--seed', 'fixed'];
  const names = new Set();
  for (let i = 0; i < 12; i++) {
    const r = await runJson([...args, '--random-palette', '--out', join(dir, `r${i}.png`)]);
    assert.equal(r.seed, 'fixed');
    names.add(r.palette);
  }
  assert.ok(names.size > 1, 'random palettes should vary for one seed');

  const a = await runJson([...args, '--chaos', '--out', join(dir, 'a.png')]);
  const b = await runJson([...args, '--chaos', '--out', join(dir, 'b.png')]);
  assert.equal(a.palette, 'chaos');
  assert.equal(a.accent, b.accent);
  assert.equal(a.complement, b.complement);
  rmSync(dir, { recursive: true, force: true });
});

test('runCli --colors renders the given colors, with or without #', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluid-cli-'));
  const args = ['--width', '4', '--height', '4', '--seed', 'fixed'];
  const colors = ['#fdf6ee', '#f2c4ce', '#3f6fd8', '#0b1d3a'];
  const expected = { name: 'custom', colors };
  const a = await runJson([...args, '--colors', colors.join(','), '--out', join(dir, 'a.png')]);
  const b = await runJson([...args, '--colors', 'FDF6EE, f2c4ce, 3f6fd8, 0b1d3a', '--out', join(dir, 'b.png')]);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(a.palette, 'custom');
  assert.equal(a.accent, paletteAccent(expected));
  assert.equal(a.complement, paletteComplement(expected));
  assert.equal(b.accent.toLowerCase(), a.accent.toLowerCase());
  assert.equal(b.complement, a.complement);
});

test('runCli rejects bad --colors values', async () => {
  await assert.rejects(runCli(['--colors', '#ffffff,#000000']), /--colors needs 3–5 colors/);
  await assert.rejects(runCli(['--colors', '#fff,#000000,#123456']), /--colors has an invalid color "#fff"/);
  await assert.rejects(runCli(['--colors', '']), /--colors needs 3–5 colors/);
});

test('runCli rejects conflicting palette-source flags', async () => {
  await assert.rejects(runCli(['--palette', 'mint-sea', '--chaos']), /cannot be combined/);
  await assert.rejects(runCli(['--palette', 'mint-sea', '--random-palette']), /cannot be combined/);
  await assert.rejects(runCli(['--random-palette', '--chaos']), /cannot be combined/);
  const colors = '#ffffff,#888888,#000000';
  await assert.rejects(runCli(['--colors', colors, '--palette', 'mint-sea']), /cannot be combined/);
  await assert.rejects(runCli(['--colors', colors, '--chaos']), /cannot be combined/);
  await assert.rejects(runCli(['--colors', colors, '--random-palette']), /cannot be combined/);
});

test('runCli rejects bad flag values through the flag specs', async () => {
  await assert.rejects(runCli(['--width', '0']), /--width must be a positive integer/);
  await assert.rejects(runCli(['--grain-opacity', 'abc']), /--grain-opacity must be a number/);
  await assert.rejects(runCli(['--sweep', '2']), /--sweep must be a number from 0 to 1/);
  await assert.rejects(runCli(['--out', 'x.gif']), /must end in .webp or .png/);
});
