export const meta = {
  name: 'kart-completion-1',
  description: 'Correctness pass plus the six known art blockers, then integrate and verify',
  phases: [
    { title: 'Fix', detail: 'seven specialists: compiles, bug hunt, sea, paint, effects, HUD, camera' },
    { title: 'Integrate', detail: 'reconcile, playtest, capture' },
  ],
}

// CHANGE THIS to your checkout before running.
//
// Not read from the environment: workflow scripts execute in a sandbox with no
// `process` and no filesystem, so `process.env` throws on the first line and the
// run dies before a single agent starts. Asking for a literal is the honest
// interface here.
const ROOT = '/Users/ryan/dev/personal/kart-game'

const BASE = `Three.js kart racing game at ${ROOT}. Read ${ROOT}/ART_DIRECTION.md and ${ROOT}/src/types.ts first.
Current frames are in ${ROOT}/shots/r7/ — Read the relevant PNGs before AND after your change.

The game currently scores 62/100 against a shipped-Mario-Kart bar from a panel of hostile art
directors. This round is about closing specific, already-diagnosed gaps — not exploring.

Rules:
- Stay in YOUR FILES. Never edit src/types.ts.
- Do NOT run tools/shot.mjs, tools/hitch-check.mjs or the dev server — other agents run in
  parallel and the ports are shared. Verify with: cd ${ROOT} && npx tsc --noEmit
- Keep the draw-call budget (~200 typical, 250 ceiling). Instance or merge anything you add.
- Everything is procedural: no asset files, no model loading.
- The player-facing boot flow now goes title screen -> character select -> race. Do not
  reintroduce a direct-to-gameplay boot.

YOUR JOB:
`

const JOBS = [
  {
    key: 'compiles',
    label: 'fix:late-shader-compiles',
    files: 'src/world/TrackGeometry.ts, src/world/Props.ts, src/fx/Effects.ts, src/fx/Particles.ts, src/game/Projectiles.ts, src/core/Prewarm.ts',
    brief: `**THREE SHADER PROGRAMS STILL COMPILE DURING PLAY, CAUSING DROPPED FRAMES.**

Measured: every frame spike over 24ms in a 60s race compiled a new GPU program, worst 56.6ms
against a 16.7ms budget. A synchronous compile blocks the GL thread, the browser misses its
compositing deadline and presents a partially-updated surface — the player sees part of the
screen flash black. This is a confirmed, reproduced, player-reported bug.

src/core/Prewarm.ts now compiles everything present in the scene at boot (including objects
with visible=false, which it temporarily reveals). Three programs still slip through, because
their materials DO NOT EXIST at boot — they are constructed lazily on first use. Identified so
far: a material named 'tunnel-bore-vc' plus two unnamed programs with a 286-char cacheKey.

Do this:
1. Find every material in your files that is created lazily — inside an update, an event
   handler, a spawn function, a getter with a cache miss, or an onBeforeCompile variant that
   only materialises when a condition first holds. Grep for material construction outside
   init/constructor paths.
2. Make them eager: construct at init time and cache, so Prewarm sees them.
3. If a material genuinely cannot be built early (it needs runtime data), then instead ensure a
   representative instance exists in the scene at boot with visible=false — Prewarm reveals and
   compiles those.
4. 'tunnel-bore-vc' is a named material in TrackGeometry.ts — find why its program is not
   compiled by the boot pass. A likely cause is a material property mutated AFTER Prewarm runs
   (toggling vertexColors, flatShading, a define, or assigning a map) which invalidates the
   program and forces a recompile. Set such properties BEFORE the prewarm, never after.
5. You may extend src/core/Prewarm.ts if a systematic hook helps (e.g. a registry that
   subsystems push must-compile materials into).

You cannot run the measurement harness (port contention). Reason from the code, be thorough,
and state precisely which materials you made eager so the integrator can verify with
tools/hitch-check.mjs.`,
  },
  {
    key: 'bughunt',
    label: 'fix:gameplay-bug-hunt',
    files: 'src/game/Race.ts, src/game/AI.ts, src/game/Items.ts, src/game/Projectiles.ts, src/kart/Kart.ts',
    brief: `**FULL PLAYTHROUGH BUG HUNT.** The player has found four real bugs in a row that none of the
automated critics caught, because critics judge still frames and cannot play. Your job is to be
the player.

You may run headless play sessions (do NOT use tools/shot.mjs — port contention). Write your own
short puppeteer script in the scratchpad on a UNIQUE port (pick something in 5200-5290) using
the startVite helper exported from ${ROOT}/tools/vite-server.mjs, drive the game via
window.__ctx, and assert on real behaviour over several full races.

Hunt specifically for:
- Lap counting and placement errors: does a full 3-lap race finish correctly for all 8 karts?
  Do positions ever swap incorrectly? Is the final classification right? Does the results screen
  show sane times?
- Checkpoint validation: can a kart cut the course and gain a lap? Drive one deliberately
  backwards and across the infield and confirm it is not credited.
- Respawn: does an off-track kart get returned facing the right way, at a sane position, without
  losing its lap or gaining one?
- Items: does every ItemKind actually work end-to-end? Fire each one and confirm it hits, expires
  and cleans up. Do projectiles leak (count them over a long race)? Does a red shell home
  correctly? Do bananas persist and despawn? Does the roulette ever get stuck?
- Race state machine: countdown -> racing -> finished -> results, plus pause and restart from the
  pause menu, and 'race again' from results. Any state that can deadlock?
- NaN/instability: assert no kart position, velocity or quaternion is ever non-finite across a
  long race.
- AI: any kart stranded, stuck reversing, or lapping far slower than the rest?

Fix everything you find. Report each bug with the evidence that proved it and the fix. If you
find something outside your files, report it precisely rather than reaching into another
subsystem.`,
  },
  {
    key: 'sea',
    label: 'fix:show-the-sea',
    files: 'src/world/Scenery.ts, src/world/Water.ts, src/world/Props.ts',
    brief: `**A COASTAL CIRCUIT CALLED "SUNSET BAY" DOES NOT SHOW THE SEA IN A SINGLE FRAME.**
That is the composition critic's sharpest finding and it is correct — check ${ROOT}/shots/r7/
yourself, all ten frames.

The art bible's course description is built around water: a harbour sweep past a marina, a cliff
traverse with a sheer drop to the sea, a beach descent, and a banked coastal curve described as
"the money shot — the full bay visible below". None of that is reading on screen.

Do this:
1. Work out WHY the sea is not visible. Likely candidates, verify which: the water plane sits
   below the camera's view at the elevations the track actually runs at; it is culled; it is
   fogged out to the same value as the sky; it is too far from the road; or the road-side terrain
   berm occludes it from a chase-camera height.
2. Fix it so the sea is a genuine, prominent presence through the harbour, cliff, beach and
   banked-curve sections — visible from the CHASE CAMERA at driving height, not only from a high
   wide shot.
3. Make it beautiful, per the bible: depth-based colour ramp from #3fc9c4 shallow to #0d5a7a
   deep, a sun-glitter path running toward the camera (the single best thing available at golden
   hour), swell, foam where water meets shore and cliff, and a horizon that dissolves into
   atmosphere rather than ending in a hard line. The lighting critic separately called the sea
   "a dead white sea with a hard horizon seam" — fix both.
4. Add the coastal life that sells it: moored boats in the harbour, breakwaters, buoys, distant
   sails, gulls over the water.

Stay instanced and inside the draw budget.`,
  },
  {
    key: 'paint',
    label: 'fix:paint-and-road-response',
    files: 'src/render/Materials.ts, src/render/Textures.ts, src/kart/Liveries.ts',
    brief: `**TWO MATERIAL FAULTS EXPOSED WHEN THE POST-PROCESSING CHAIN WAS RESTORED.**

The post chain had been silently disabled on High/Ultra for several rounds (a TypeError in
PostFX.build was caught and swallowed, turning the whole composer off). With it restored, and
with the environment probe's ground hemisphere fixed, two things now over-read. Look at
${ROOT}/shots/r7/closeup.png and ${ROOT}/shots/r7/hero.png.

1. **The red livery reads iridescent magenta/purple.** The clearcoat lobe plus the environment
   tint is overwhelming the base colour — the kart is supposed to be #ff3b5c red and is coming
   out a shifting purple-pink. Check: clearcoat intensity and roughness, envMapIntensity on the
   paint material, whether sheen or iridescence parameters are set at all (they should not be),
   and whether the livery tint is being multiplied in a colour space it should not be. The paint
   must read unmistakably as its roster colour from every angle while keeping a real lacquer
   highlight. Verify all eight liveries, not just red — they must stay clearly distinct from one
   another, since the HUD and minimap identify racers by colour.

2. **The tarmac reads WET.** It has a broad glossy sheen that says "after rain", not "dry asphalt
   at golden hour". The roughness floor is too low and/or the specular response too strong now
   that the env probe has a ground hemisphere. Dry asphalt is rough and mostly diffuse, with a
   grazing-angle sheen ONLY at very shallow incidence — that grazing sheen is wanted (the
   lighting critic asked for it), a uniform wet gloss is not. Keep the macro-scale variation,
   the patch repairs, the racing-line polish band and the wear — those landed well and must
   survive.

Do not fix either by turning the environment down globally: a previous round found
envMapIntensity crushed to 0.40 across the board, which silently deleted every metal reflection
and clearcoat lobe in the game. Fix these two materials specifically.`,
  },
  {
    key: 'effects',
    label: 'fix:effects-readability',
    files: 'src/fx/Effects.ts, src/fx/Particles.ts, src/fx/Trails.ts, src/render/PostFX.ts',
    brief: `**THE TWO FRAMES WHOSE ONLY JOB IS TO SHOW EVENT ARE THE WEAKEST IN THE SET.**
Verbatim from the game-feel critic (61/100, joint lowest with lighting):

  "a 120 km/h boost frame with no speed lines, no smear and no FOV change, and a tier-2 drift
   whose sparks read as dust motes, are not polish problems; they are the feature being absent
   from the screen"
  "ten frames of a kart parked dead-centre with almost nothing happening around it"

Look at ${ROOT}/shots/r7/boost.png and ${ROOT}/shots/r7/drift.png.

1. **Boost must be unmistakable.** At 32 m/s with boost active the frame should read as violent
   speed: real flame plumes from both exhausts (hot white-yellow core to orange tips), radial
   speed lines, a visible FOV punch, motion smear on the world, chromatic aberration ramping,
   and a shockwave ring on activation. Note the player's kart is deliberately held OUT of motion
   blur (it was being smeared into mush) — the WORLD must still streak convincingly. Verify the
   speed-line and radial-blur terms in PostFX are actually driven by ctx.speedIntensity and
   ctx.fovPunch, and that those are non-zero when boosting.
2. **Drift sparks must read as sparks, not dust.** Tier 1 blue #4fc3ff, tier 2 orange #ff9d2e,
   tier 3 purple #c05cff. Bright additive core with a soft glow, thrown from both rear contact
   patches with real velocity and arc, a burst and a flash on each tier change, plus a ground
   glow and skid decals. At tier 2 it should be obvious at a glance across the room.
3. Keep it energy-conserving — test boost + tier-3 drift + tunnel exit stacked, and confirm the
   frame does not clip to white. The critics have flagged blown highlights repeatedly.
4. Add the ambient event the critics say is missing: dust and grit kicked up by the pack, heat
   shimmer over the tarmac, gulls scattering, trackside flags reacting to a passing kart.`,
  },
  {
    key: 'hud',
    label: 'fix:hud-as-one-system',
    files: 'src/ui/HUD.ts, src/ui/Minimap.ts, src/ui/Menus.ts, src/ui/ui.css, src/ui/ItemIcons.ts',
    brief: `**THE HUD IS SIX SEPARATELY-INVENTED WIDGETS, NOT ONE DESIGNED SYSTEM.**
The UI critic scored 62 and was specific:

  "a left-edge stack of six separately-invented widgets, not a HUD, and the minimap in the middle
   of that stack is genuinely unreadable in all ten frames"
  "a Grafana-grade infographic speedometer, a photoreal-bead minimap parked on the vanishing
   point, and two unrelated numeral treatments sharing a frame"
  "mitred text-stroke outlines, iOS-app-icon panels with backdrop grain, and a right-aligned race
   timer I measured jittering 5px because the digits aren't tabular"

Look at every PNG in ${ROOT}/shots/r7/.

Do this:
1. **Unify the visual language.** One panel recipe, one corner radius, one border treatment, one
   shadow, one type scale, one numeral treatment. Pick the strongest existing idea and apply it
   everywhere rather than inventing a seventh style.
2. **Fix the layout.** Elements are stacking down the left edge and colliding. Distribute them to
   the corners the art bible specifies (section 7) with generous margins, and make sure nothing
   lands on the player's kart or the vanishing point. Check at 1280x720, 1920x1080 and 2560x1440.
3. **Make the minimap readable.** It is the single worst-rated element. It must read instantly:
   a clear track ribbon with strong contrast against its panel, the player unmistakable, rivals
   legible in their livery colours, and correct orientation.
4. **Fix the timer jitter** — tabular numerals; the critic measured 5px of horizontal jump.
5. Remove the mitred text-stroke outlines and the backdrop grain the critic identified as CSS
   tells.
6. Keep the touch layout working. src/core/TouchControls.ts contains scoped overrides under an
   html[data-touch] selector that move the speedometer clear of the on-screen button cluster —
   if you relocate the speedometer, update that block too. That block is the only thing outside
   your file set you may edit.

Everything must survive against a blown-out golden-hour sky.`,
  },
  {
    key: 'camera',
    label: 'fix:camera-energy',
    files: 'src/game/Camera.ts',
    brief: `**EVERY FRAME IS THE KART PARKED DEAD CENTRE.** The game-feel critic called the whole set
"a still-life gallery". Look at all ten frames in ${ROOT}/shots/r7/ — the kart sits in the middle
of the frame in almost every one, at a similar distance and a similar angle.

A Mario Kart screenshot is never static: the kart slides across the frame in a drift, the horizon
tilts through a banked corner, the camera drops and closes under boost, and the world rushes past
at an angle.

Do this:
1. **Drift must move the kart across the frame.** The camera should follow the direction of
   TRAVEL, not the kart's facing, so a sliding kart visibly yaws across the shot. Confirm the
   blend between velocity-heading and facing is actually engaging at drift angles — the critic
   says it is not visible at all.
2. **Bank must tilt the horizon.** The camera's up should follow the track normal with a lag
   through the 20-degree banked coastal curve. Verify this is reaching the frame.
3. **Boost must change the shot**, not just the FOV number: drop the arm slightly, close the
   distance, add a touch of roll, and let it settle back with a small overshoot.
4. **Vary the rig by context** so ten frames are not ten identical compositions — a slightly
   lower, closer pose at speed, a wider one through the scenic sections.
5. Keep the existing spring behaviour, the collision pull-in (the tunnel must stay seamless), the
   velocity feed-forward that cancels SmoothDamp's standing error, and the window.__camMode
   support ('chase' | 'wide' | 'close') that the capture harness sets.

Zero allocation in lateUpdate.`,
  },
]

phase('Fix')

const done = await parallel(
  JOBS.map((j) => () =>
    agent(BASE + j.brief + `\n\n## YOUR FILES (the only files you may write)\n${j.files}\n\n` +
      `Report what you changed, the evidence you used, and anything you could not fix.`,
      { label: j.label, phase: 'Fix' })
  )
)

phase('Integrate')

const integration = await agent(
  `cd ${ROOT}. Seven specialists just worked in parallel on the kart racing game.

${JOBS.map((j, i) => `### ${j.label}\n${done[i] || '(no report — check whether its files changed)'}`).join('\n\n')}

Your job, in order. Report what you ACTUALLY observed at each step.

1. npx tsc --noEmit — fix every error.
2. node tools/hitch-check.mjs 60
   This is the player-reported black-flash bug. It must print NOT CONFIRMED, i.e. zero programs
   compiling during play. If programs still compile late, identify them and make them eager.
3. node tools/ai-health.mjs — all 8 karts moving, near-zero off-track, none stranded. Run twice.
4. node tools/touch-test.mjs and node tools/touch-lazy-test.mjs — both must print PASS.
5. Verify the boot flow by hand with your own puppeteer script on a unique port (5291+), using
   the startVite helper from tools/vite-server.mjs: the title screen must appear, Enter must
   advance to character select, and confirming again must start the race (race.state reaches
   Countdown). Also confirm Enter mid-race fires an item and does NOT open the pause menu, and
   that Escape DOES open it.
6. node tools/shot.mjs --out shots/r8 --settle 3 --w 1920 --h 1080
   Iterate until zero console errors. Then Read every PNG and confirm by eye:
   - the sea is visibly present in the coastal frames
   - the kart's paint reads as its roster colour, not magenta
   - the tarmac reads dry, not wet
   - boost and drift frames obviously show boost and drift
   - the HUD reads as one designed system with no collisions
   - frames are compositionally varied, not ten identical centred shots
7. Fix anything broken or regressed. Do not remove features to make errors go away.

Finish with everything green. Then give an honest per-item verdict, plus the draw-call and fps
figures.`,
  { label: 'integrator', phase: 'Integrate' }
)

return { jobs: JOBS.map((j, i) => ({ name: j.label, ok: !!done[i] })), integration }
