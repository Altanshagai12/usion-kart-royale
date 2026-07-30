export const meta = {
  name: 'kart-ship-ready',
  description: 'Make the drift ladder pay, stop the black screen for good, and re-run every gate',
  phases: [
    { title: 'Fix', detail: 'ladder, feedback, GPU compatibility' },
    { title: 'Judge', detail: 'is the loop rewarding now? measured on the histogram, not the lap time' },
    { title: 'Ship', detail: 'every gate green, production build verified' },
  ],
}

// CHANGE THIS to your checkout before running.
//
// Not read from the environment: workflow scripts execute in a sandbox with no
// `process` and no filesystem, so `process.env` throws on the first line and the
// run dies before a single agent starts. Asking for a literal is the honest
// interface here.
const ROOT = '/Users/ryan/dev/personal/kart-game'

const WHY = `## THIS IS THE ROUND BEFORE THE GAME GOES PUBLIC

The repository is about to be open-sourced and written up publicly, with honest numbers
attached. Two things must be true first, and they are the only two.

### 1. The loop has to actually pay

The last round measured the drift-to-boost loop at 74/100 and found exactly why:

    83 drift attempts across three laps
      released at tier 0 : 69   (83% — banked NOTHING)
      released at tier 1 : 13
      released at tier 2 : 1
      released at tier 3 : 0    (never reached, on any corner, ever)
    median hold: 0.45 s   |   tier 1 needs 0.63 s

Drifting IS faster — 2.03 s/lap against a 0.44% noise floor — but 56% of that comes from one
corner, and it comes from the SLIDE cornering faster, not from the mini-turbo. The ladder that
is supposed to make this a skill is decoration for two thirds of its range.

A player on X said it plainly: *"I tried and it's not fun to play."* They are right, and the
measurement agrees with them.

**IMPORTANT — do not re-add the fix that already exists.** The previous judge recommended a
carry window so a brief steering dip does not destroy the charge. That is ALREADY IMPLEMENTED:
\`DRIFT_CARRY_TIME = 0.4\` in \`src/kart/Kart.ts\`, with the carry/restore logic around the
engage and release paths. It was in place when the 83% was measured. So either it is not
working, 0.4 s is too short, or — and this matters — the 83% is an artifact of how the AI BENCH
DRIVER steers rather than how a human does. Establish which before changing anything.

### 2. Nobody may get a black screen

Several people on Chromium browsers get a working HUD over an empty world, while the same build
runs fine elsewhere. It is a GPU/driver problem, not a browser one. Diagnostics exist
(\`__gl()\`, and a draw-call watchdog that announces the failure) but no reporter has sent a dump
and none may ever arrive. A visitor who gets a black screen does not file a report — they close
the tab. Ship a fallback blind.
`

const RULES = `## Rules
- Stay in YOUR FILES. Never edit src/types.ts.
- Do NOT run tools/shot.mjs or the dev server — agents run in parallel and ports are shared.
  You MAY write your own puppeteer script in the scratchpad on a UNIQUE port in 5330-5390, using
  the startVite helper from ${ROOT}/tools/vite-server.mjs.
- Drive the player through \`Race.driveOverride\`. Calling \`Kart.step\` directly double-integrates
  against the race director and measures nonsense.
- Verify with: cd ${ROOT} && npx tsc --noEmit
- Budgets hold: ~200 draw calls typical, mobile texture memory under 80MB, zero late shader
  compiles, no per-frame allocation in hot paths.
- Two harnesses in this project have produced confident FALSE readings. Validate any instrument
  you write against ground truth before you trust a number from it.

YOUR JOB:
`

const JOBS = [
  {
    key: 'ladder',
    label: 'drift:make-the-ladder-pay',
    files: 'src/kart/Kart.ts, src/kart/Tyre.ts, src/kart/Suspension.ts',
    brief: `**MAKE THE MINI-TURBO LADDER REAL. This is the round's headline.**

Target histogram, measured by \`tools/drift-bench.mjs\`: a competent lap should bank a tier on
the clear MAJORITY of drift attempts, tier 2 should be routine on the longer corners, and tier 3
should be reachable — hard, but reachable — on at least the banked coastal curve.

Work in this order:

1. **Diagnose before you tune.** Instrument the drift lifecycle and answer, with numbers:
   - How often does the carry window actually fire, and how often does it expire first?
   - What is the distribution of hold times, and what breaks a hold — the player releasing, the
     steering gate dropping out, \`forfeitDrift\` firing, or the kart leaving the road?
   - Is the 83% figure real for a HUMAN input pattern? Drive a smooth scripted human-like trace
     (hold the button through a whole corner, steer continuously) as well as the AI's, and
     compare. If the AI's steering dips are the cause, that is an AI bug, not a mechanic bug,
     and the fix belongs somewhere different. Say so clearly.
2. **Fix what the numbers show.** Candidates, in rough order of likelihood: the hold gate is too
   strict about steering angle or slip; the carry window is too short or is cleared on a path it
   should not be; the tier thresholds (0.9 / 2.0 / 3.2 s) are too long for the corner lengths
   this circuit actually has; \`forfeitDrift\` fires on conditions that are not really blown
   drifts.
3. **Make the tiers worth climbing.** Tier 3 must be clearly better than tier 1 — enough that a
   player chooses to hold through a corner rather than release early for a safe blue.
4. **Do not break what works.** Drifting must stay faster than not drifting (currently 2.03 s a
   lap), the field must still race cleanly, and a genuinely blown drift must still cost.

Report the before/after histogram, the drift-vs-clean margin, and the tier-3 reachability per
corner.`,
  },
  {
    key: 'feedback',
    label: 'drift:tier-feedback',
    files: 'src/ui/HUD.ts, src/ui/ui.css, src/fx/Effects.ts',
    brief: `**THE PLAYER MUST KNOW WHICH TIER THEY ARE ON, AND THERE IS A CONFIRMED BUG.**

1. **Fix the charge rail — it renders the WRONG TIER.** The previous judge found this precisely:
   \`src/ui/ui.css\` around line 481 puts the NEXT tier's colour at 4px and the BANKED tier's at
   only 9% of element height, while the fill translates the rail by \`(1-fill)*100%\`. Below about
   0.09 charge — which, at the measured median hold of 0.45 s, is essentially always — the only
   colour on screen is the tier the player has NOT earned. Measured on a shipped tier-2 frame:
   the visible sliver is purple; the banked orange never appears. The comment above the rule
   asserts the opposite of what it draws. Verify this yourself by rendering the rail at several
   charge values and reading the pixels, then fix it.
2. **Make the banked tier unmistakable and peripheral.** The player's eyes are on the apex, not
   the corner of the screen. Colour and motion in peripheral vision beat shape. The tier they
   have BANKED matters more than progress toward the next one — that is the information the
   hold-or-release decision needs.
3. **Land the three cues as one event.** On a tier transition the HUD punch, the spark burst and
   the audio tone must fire on the same frame. If they are even a few frames apart it reads as
   mush rather than as an event.
4. **Reward the release.** A tier-3 release should feel like the game acknowledging it — a
   callout, a speed surge on the speedometer, something that makes a player want to do it again.

Do not restyle the HUD; it scores acceptably and is not the problem. Add only what the loop
needs. Everything must survive against a blown-out golden-hour sky and must not collide at
1280x720, 1920x1080 or 2560x1440.`,
  },
  {
    key: 'compat',
    label: 'fix:never-show-a-black-screen',
    files: 'src/render/Renderer.ts, src/render/PostFX.ts, src/core/Settings.ts, src/core/Diagnostics.ts',
    brief: `**SHIP A BLIND FALLBACK. NOBODY MAY GET A WORKING HUD OVER AN EMPTY WORLD.**

Real reports on Brave, Edge and Chrome; the same build is fine on other machines. GPU/driver, not
browser. No diagnostic dump has arrived and none may.

Build defence in depth — every layer must degrade rather than disappear:

1. **Detect at boot, before it matters.** Extend the existing device probe to actually verify the
   things the pipeline depends on rather than assuming them: that a half-float colour buffer is
   genuinely renderable (create one and check completeness — do not trust the extension string
   alone), that the render targets the composer needs can be allocated at the chosen size, and
   that a representative material actually COMPILES AND LINKS. A driver that rejects one shader
   is the leading theory, and \`getShaderInfoLog\` after a trial compile will say so.
2. **Degrade on failure, in steps.** If half-float is unavailable, fall back to an 8-bit buffer.
   If the composer cannot be built, use the direct render path (it exists). If a shader family
   fails to link, drop to a simpler material variant rather than leaving invisible geometry. Each
   step must be logged so a future report is actionable.
3. **Never present nothing.** The draw-call watchdog in Diagnostics already notices when the
   scene submits nothing for 90 frames. Wire it to ACT, not just announce: force the pipeline
   down a rung and try again, and only show the banner if even the simplest path draws nothing.
4. **Verify by simulating the failures.** You cannot reproduce their GPU, but you can force each
   condition: launch Chrome with WebGL2 disabled, monkey-patch \`getExtension\` to return null for
   the float-buffer extensions, force \`createProgram\` to fail for one material, and make the
   composer constructor throw. For each, assert the game still renders SOMETHING recognisable and
   logs a specific reason. That is the real test of a fallback.
5. Keep the desktop path byte-identical when nothing fails. This must cost nothing on hardware
   that works.`,
  },
]

phase('Fix')

const built = await parallel(
  JOBS.map((j) => () =>
    agent(
      `Three.js kart racing game at ${ROOT}. Read ${ROOT}/ART_DIRECTION.md, ${ROOT}/src/types.ts and ${ROOT}/FEEDBACK.md first.\n\n` +
      WHY + '\n' + RULES + j.brief +
      `\n\n## YOUR FILES (the only files you may write)\n${j.files}\n\n` +
      `Report measurements before and after, what you changed, and anything you could not fix.`,
      { label: j.label, phase: 'Fix' },
    )
  )
)

phase('Judge')

const judged = await agent(
  `Judge whether the drift loop in the kart racer at ${ROOT} is now genuinely rewarding, and
whether the game is safe to put in front of strangers.

${JOBS.map((j, i) => `### ${j.label}\n${(built[i] || '(no report — check whether its files changed)').slice(0, 2500)}`).join('\n\n')}

1. **Run \`node tools/drift-bench.mjs\` yourself.** Judge on the TIER HISTOGRAM, not the lap time
   — the lap time was already passing for the wrong reason (the slide corners faster; the
   mini-turbo was barely contributing). The previous baseline was 69/13/1/0 across tiers 0-3 out
   of 83 attempts. Report the new distribution. A majority of attempts banking at least tier 1,
   with tier 3 reachable somewhere on the circuit, is the bar.
2. **Confirm drifting is still faster** than not drifting, and by how much.
3. **Check the tier is legible.** Capture with
   \`node tools/shot.mjs --only drift,boost,hero --settle 3 --out shots/r15\` and read the PNGs.
   Can you tell the tier from the image alone? Verify the charge rail now shows the BANKED tier
   by rendering it at several charge values and reading the pixels — the previous judge proved it
   showed the wrong one.
4. **Try to break the renderer.** Verify the compatibility fallbacks actually work by forcing the
   failures (WebGL2 off, float extensions nulled, composer throwing) and confirming the game
   still draws something recognisable each time, with a specific reason logged.
5. **Score the loop out of 100** on one question: *would a player rerun this track to nail a
   cleaner lap?* The last score was 74. Justify with the histogram and the frames.

Return the score, the histogram, the fallback results, and anything that should block shipping.`,
  { label: 'judge', phase: 'Judge' },
)

phase('Ship')

const shipped = await agent(
  `cd ${ROOT}. Final integration before this repository is open-sourced and written up publicly.
Everything must be green and the production artifact must be verified.

## Judge's verdict
${judged || '(no verdict — evaluate it yourself)'}

## Specialist reports
${JOBS.map((j, i) => `### ${j.label}\n${(built[i] || '(failed)').slice(0, 1500)}`).join('\n\n')}

In order, reporting what you ACTUALLY observed:

1. npx tsc --noEmit — fix every error. Watch for backticks inside template literals; that has
   broken this build twice.
2. **Every gate, all of them.** A previous round's integration died mid-run and these were never
   re-run, so treat nothing as known-good:
     node tools/drift-bench.mjs        (drifting faster than not drifting)
     node tools/autoplay.mjs           (full races, no deadlocks, no NaN, zero console errors)
     node tools/camera-probe.mjs       (peak swing < 300 deg/s, peak lag < 35 deg, TRUE off-centre < 0.6)
     node tools/mobile-soak.mjs 45     (PASS — textures under 80MB, no context loss)
     node tools/hitch-check.mjs 30     (NOT CONFIRMED = zero late compiles)
     node tools/ai-health.mjs          (8/8 racing, near-zero off-track)
     node tools/touch-test.mjs         (PASS)
     node tools/touch-lazy-test.mjs    (PASS)
     node tools/context-loss-test.mjs  (PASS)
     node tools/steer-test.mjs         (steer +1 moves POSITIVE along screen-right)
   Fix anything that fails. Do not remove a feature to make a gate pass.
3. node tools/shot.mjs --out shots/r15 --settle 3 --w 1920 --h 1080 — zero console errors, and
   read every PNG to confirm nothing is broken, black or torn.
4. **Verify the PRODUCTION build, not the dev server:**
     npm run build
     npx vite preview --port 4173 &
   then drive it headlessly on a desktop viewport AND an emulated iPhone: confirm it boots,
   the scene submits a healthy number of draw calls, nothing is dark, and there are zero console
   errors on either.
5. Commit everything with a clear message. Do NOT push and do NOT deploy — those are the last
   human steps.

Report every gate result explicitly, the production-build verification, and a plain yes/no on
whether this is safe to open-source and put in front of strangers.`,
  { label: 'ship', phase: 'Ship' },
)

return { jobs: JOBS.map((j, i) => ({ name: j.label, ok: !!built[i] })), judged, shipped }
