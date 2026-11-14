/*
 * flags — the single source of truth for every CLI flag.
 *
 * ## behavior
 * - `optionFlags` and `lookFlags` each map one render option to one long flag,
 *   with the parser/validator for that flag's value living beside it.
 * - `cliOnlyFlags` holds the flags with no API counterpart: file output,
 *   terminal presentation, and the palette-source switches (`--random-palette`,
 *   `--chaos`, `--colors`), which the CLI resolves into an ordinary `palette`
 *   before calling the API. An entry with an empty `placeholder` is a boolean
 *   switch; one with a placeholder takes a string value.
 * - `src/cli.ts` builds its `parseArgs` config, its help text and its options
 *   object from these tables. `format` is absent on purpose — it comes from the
 *   `--out` extension.
 *
 * ## constraints
 * - The two `satisfies { [K in keyof ...]: FlagSpec<...> }` clauses are the
 *   whole point of the file, not annotations. They make adding a render option
 *   to `MeshGradientOptions` or a knob to `GradientLook` fail `npm run lint`
 *   until it has a flag here, which is what keeps `fluid-gradient --foo` and
 *   `generateMeshGradient({ foo })` from drifting apart. Deleting one to quiet
 *   an error removes the check that was reporting it.
 * - Flag definitions live here and nowhere else. A flag added directly to the
 *   parser or the help string in `src/cli.ts` gets no `parse`, no typecheck and
 *   no README entry; add it to a table here instead and the CLI picks it up.
 * - `describe` strings are user-facing docs: they are rendered into the help
 *   text and from there into README.md by `scripts/sync-docs.mjs`. Editing one
 *   without running `npm run docs` fails `npm test`, which runs that script with
 *   `--check`.
 */
import type { GradientLook, MeshGradientFormatOptions, MeshGradientOptions } from './render';
import { DEFAULT_HEIGHT, DEFAULT_WEBP_QUALITY, DEFAULT_WIDTH, defaultLook, lookDescriptions } from './render';

/** One flag: how it is written, how it is described, and how its value parses. */
export type FlagSpec<Value> = {
  /** Long flag name, used as `--<flag>`. */
  flag: string;
  /** Shown in help, e.g. `<px>`. */
  placeholder: string;
  describe: string;
  parse: (raw: string) => Value;
};

const positiveInteger = (flag: string) => (raw: string) => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${flag} must be a positive integer. Got: ${raw}`);
  }
  return value;
};

const finiteNumber = (flag: string) => (raw: string) => {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${flag} must be a number. Got: ${raw}`);
  return value;
};

const unitInterval = (flag: string) => (raw: string) => {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`--${flag} must be a number from 0 to 1. Got: ${raw}`);
  }
  return value;
};

/**
 * Render options the CLI maps one-to-one. `format` is excluded because it comes
 * from the --out extension, and `look` has its own table below.
 */
type FlaggedOptions = Omit<
  Required<MeshGradientOptions & MeshGradientFormatOptions>,
  'look' | 'format'
>;

export const optionFlags = {
  seed: {
    flag: 'seed',
    placeholder: '<string>',
    describe: 'Seed string. Same seed → same image. Default: random.',
    parse: (raw: string) => raw,
  },
  palette: {
    flag: 'palette',
    placeholder: '<name>',
    describe: 'Built-in palette name. Default: a deterministic pick from the seed.',
    parse: (raw: string) => raw,
  },
  width: {
    flag: 'width',
    placeholder: '<px>',
    describe: `Output width. Default ${DEFAULT_WIDTH}.`,
    parse: positiveInteger('width'),
  },
  height: {
    flag: 'height',
    placeholder: '<px>',
    describe: `Output height. Default ${DEFAULT_HEIGHT}.`,
    parse: positiveInteger('height'),
  },
  quality: {
    flag: 'quality',
    placeholder: '<1-100>',
    describe: `WebP quality. Default ${DEFAULT_WEBP_QUALITY}.`,
    parse: positiveInteger('quality'),
  },
} satisfies { [K in keyof FlaggedOptions]: FlagSpec<unknown> };

export const lookFlags = {
  baseNoiseFrequency: {
    flag: 'base-noise-frequency',
    placeholder: '<n>',
    describe: `${lookDescriptions.baseNoiseFrequency} Default ${defaultLook.baseNoiseFrequency}.`,
    parse: finiteNumber('base-noise-frequency'),
  },
  domainWarpStrength: {
    flag: 'domain-warp-strength',
    placeholder: '<n>',
    describe: `${lookDescriptions.domainWarpStrength} Default ${defaultLook.domainWarpStrength}.`,
    parse: finiteNumber('domain-warp-strength'),
  },
  fractalOctaveCount: {
    flag: 'fractal-octave-count',
    placeholder: '<n>',
    describe: `${lookDescriptions.fractalOctaveCount} Default ${defaultLook.fractalOctaveCount}.`,
    parse: positiveInteger('fractal-octave-count'),
  },
  colorTransitionContrast: {
    flag: 'color-transition-contrast',
    placeholder: '<n>',
    describe: `${lookDescriptions.colorTransitionContrast} Default ${defaultLook.colorTransitionContrast}.`,
    parse: finiteNumber('color-transition-contrast'),
  },
  grainOpacity: {
    flag: 'grain-opacity',
    placeholder: '<0-1>',
    describe: `${lookDescriptions.grainOpacity} Default ${defaultLook.grainOpacity}.`,
    parse: finiteNumber('grain-opacity'),
  },
  sweep: {
    flag: 'sweep',
    placeholder: '<0-1>',
    describe: `${lookDescriptions.sweep} Default ${defaultLook.sweep}.`,
    parse: unitInterval('sweep'),
  },
  ground: {
    flag: 'ground',
    placeholder: '<0-1>',
    describe: `${lookDescriptions.ground} Default ${defaultLook.ground}.`,
    parse: unitInterval('ground'),
  },
} satisfies { [K in keyof GradientLook]: FlagSpec<number> };

/** Flags that exist only in the CLI: file output and terminal presentation. */
export const cliOnlyFlags = [
  {
    flag: 'out',
    placeholder: '<path>',
    describe: 'Output file, .webp or .png. Default: output/<palette>-<seed>.webp',
  },
  {
    flag: 'random-palette',
    placeholder: '',
    describe: 'Pick the palette at random instead of deriving it from --seed. The name is printed.',
  },
  {
    flag: 'chaos',
    placeholder: '',
    describe: 'Ignore the palettes: use 3–5 random colors (the same --seed gives the same colors).',
  },
  {
    flag: 'colors',
    placeholder: '<hex,...>',
    describe: 'Use your own 3–5 colors, light → dark, comma-separated: "#fdf6ee,#f2c4ce,#3f6fd8". The # is optional.',
  },
  { flag: 'json', placeholder: '', describe: 'Print result metadata as JSON.' },
  { flag: 'list-palettes', placeholder: '', describe: 'Print built-in palette names and exit.' },
  { flag: 'help', placeholder: '', describe: 'Show this help (-h).' },
] as const;
