# AGENTS.md

## File contracts

Some source files open with a block comment containing `## behavior` and `## constraints`. Read it before editing that file.

- If your change contradicts a constraint, stop and raise it instead of editing around it. Don't read a constraint narrowly to make a change fit.
- Leaving a task undone because it contradicts a contract is a complete result. Report it plainly.
- If your change alters behavior a header describes, update the header in the same commit.

## Vocabulary

Use these words for these looks, in code, docs and prompts to other agents:

- **fluid** — the default domain-warped gradient. Frozen; never altered by new looks.
- **sweep** (`look.sweep`) — the wispy look: the gradient's color carried like dye through a slow, large, drifting current and photographed soft, so it pulls into curving wisps and silk-like folds. Implemented in `src/sweep.ts` as advection through capped curl noise plus a drift, then a defocus and a speed-scaled blur along the current. It is *not* drawn objects (petals, feathers), *not* fiber/strand texture (reads as fur or watercolor), *not* brushwork along curl-noise lines (Van Gogh), *not* one straight camera motion (too linear), and never closed eddies or twirls (bullseye rings). All were tried and rejected.
- **ground** (`look.ground`) — the pale base the color floats over, in the palette's lightest stop; turned up to leave room for text on thumbnails.

## Skills

- `.claude/skills/` — for working **on** this repo: adding palettes, and how the rendering algorithms work. Load them before touching `src/palettes.ts`, `src/render.ts`, `src/random.ts` or `src/color.ts`.
- `skills/` — shipped **with** the package for consumers, installed via `npx fluid-gradients-init-skills`. Edit these when the public API changes.
