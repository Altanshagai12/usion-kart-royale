export const meta = {
  name: 'kart-completion-2',
  description: 'Fix the measurable lighting failure, the missing kart shadows, and the round-1 regressions',
  phases: [
    { title: 'Fix', detail: 'six specialists on concrete, measurable defects' },
    { title: 'Verify', detail: 'before/after capture with explicit regression hunting' },
  ],
}

// CHANGE THIS to your checkout before running.
//
// Not read from the environment: workflow scripts execute in a sandbox with no
// `process` and no filesystem, so `process.env` throws on the first line and the
// run dies before a single agent starts. Asking for a literal is the honest
// interface here.
const ROOT = '/Users/ryan/dev/personal/kart-game'

const BASE = `Three.js kart racing game at ${ROOT}. Read ${ROOT}/ART_DIRECTION.md first.
The frames the critics just scored are in ${ROOT}/shots/r1/ — Read the relevant PNGs BEFORE and
AFTER your change. (That directory name is a harness quirk; it is the current build.)

The mean score just went DOWN, 62 -> 58, after a round that was supposed to improve it. Some of
that is regression introduced by the previous round. Your job is concrete, measurable defects —
not exploration, not re-styling.

Rules:
- Stay in YOUR FILES. Never edit src/types.ts.
- Do NOT run tools/shot.mjs or the dev server — other agents run in parallel, ports are shared.
  Verify with: cd ${ROOT} && npx tsc --noEmit
- Draw-call budget: typical frames must stay under 250. Current worst is 210.
- If you believe a finding is wrong, look first, then say so with evidence rather than
  implementing it anyway.

YOUR JOB:
`

const JOBS = [
  {
    key: 'keylight',
    label: 'fix:key-to-fill-ratio',
    files: 'src/render/Sky.ts, src/render/Atmosphere.ts',
    brief: `**THE SINGLE HIGHEST-VALUE FIX IN THE PROJECT. The fill light is as bright as the sun.**

The lighting critic has scored lowest or joint-lowest in every round (48, 61, 56, 54) and has
now given a measurable diagnosis instead of an impression:

  "on the tarmac the unshadowed fill lights are roughly as strong as the 14-degree sun, so lit
   and shadowed road differ by about ONE STOP and nothing in frame reads as sunlit versus
   shaded"
  "there is no rim, no warm/cool split, no sun disc, no readable key direction on the karts"

One stop of separation is why every round has reported a "flat ambient wash" no matter how good
the sky looks. It is the root cause behind several other complaints, including "the karts have
no key direction" and "the effects do not sit in the light".

Do this:
1. **Measure the current ratio before changing anything.** Sum the irradiance actually reaching
   a flat upward-facing surface from the key (DirectionalLight) versus everything else — the
   hemisphere/ambient light, the LightProbe/SH from the PMREM env map, and any fill or bounce
   lights. Write the numbers down in your report.
2. **Get to 3-4 stops of separation** between lit and shadowed road: the key must dominate.
   Practically that means raising the sun's intensity and cutting the ambient/fill/probe
   contribution substantially — not the reverse, and NOT by crushing the env map globally,
   which a previous round did and which silently deleted every metal reflection in the game.
   Metals and clearcoat still need a full-strength specular environment; it is the DIFFUSE
   ambient term that is too strong. Those are separately controllable.
3. **Make the fill cool and directional**, not a uniform grey lift: sky-blue from above and from
   the anti-sun side, a weak warm bounce from below. A shadowed surface should read cool, not
   merely darker. That warm/cool split is what golden hour actually looks like.
4. **Add a visible sun disc** with limb softening and a proper atmospheric halo. The critic
   notes there is none, which removes the single clearest cue for where the key is coming from.
5. **Make sure rim light happens.** With a 14-degree sun, karts and props should get a bright
   edge where the sun grazes them. That needs real contrast between the sun side and the
   anti-sun side of the env map — check yours is not near-uniform in luminance, which is the
   usual cause of "flat" PBR.
6. Re-check exposure afterwards: raising the key without touching exposure will blow highlights,
   and the critics have flagged blown whites repeatedly.

This will change the look of every frame in the game. That is the point — but verify the scene
does not go black in shadow, and that the tunnel interior still works.`,
  },
  {
    key: 'shadows',
    label: 'fix:kart-contact-shadows',
    files: 'src/render/DrawBudget.ts, src/kart/KartModel.ts, src/kart/Liveries.ts',
    brief: `**THE HERO KART HAS NO CONTACT SHADOW IN EIGHT OF TEN FRAMES.** From the craft critic:

  "the hero kart has no contact shadow in eight of ten frames, the one shot where shadows do
   render shows them fully detached from their casters, and ... the hero asset floats on the
   tarmac like a decal"

"Nothing floats" is rule 4 of the art bible's own pass criteria. This is very likely a
REGRESSION introduced by the performance work, which added shadow-relevance culling
(src/render/DrawBudget.ts) and made a merged impostor the kart's only shadow caster. Suspect,
and verify each:
- the shadow-relevance cull is rejecting the PLAYER's kart, which is by definition always in
  frame — the frustum padding or distance test may be wrong, or measured from the wrong camera
- the near-LOD kart wears a colorWrite:false / depthWrite:false material; if
  \`material.visible\` is false anywhere in that path, three's WebGLShadowMap.renderObject skips
  the caster entirely (it gates on object.visible, object.castShadow AND material.visible)
- the impostor bake's shadow may be offset from the real kart, which would explain "fully
  detached from their casters"
- the near shadow cascade may not actually cover the kart at chase-camera distance

Fix it so every kart has a correct, attached, soft contact shadow at all times, and the player's
kart never loses one. Do not solve it by disabling the LOD or the culling wholesale — keep the
draw-call win and fix the correctness bug inside it.

If the detachment is a cascade or bias problem rather than a culling one, say so clearly in your
report so it can be routed to the lighting owner instead.`,
  },
  {
    key: 'speed',
    label: 'fix:speed-reads-on-screen',
    files: 'src/fx/Effects.ts, src/render/PostFX.ts, src/fx/Trails.ts',
    brief: `**A 101 KM/H FRAME AND A 55 KM/H FRAME ARE VISUALLY INDISTINGUISHABLE.** The game-feel critic:

  "speed is communicated by a number in the corner, which is the single most damning thing you
   can say about a racing game screenshot"

And a regression it also flagged, from the last round's own work:

  "the boost frame's plume blows out to featureless white and eats the player kart"

Do both:
1. **Make speed legible at a glance.** The delta between cruising and flat-out must be obvious
   in the pixels: motion streaking on trackside geometry that scales hard with speed, radial
   blur strengthening toward the frame edge, speed lines that only appear above ~70% top speed
   and then ramp decisively, FOV widening, chromatic aberration ramping, and a vignette that
   closes in. Verify ctx.speedIntensity and ctx.fovPunch are actually non-zero and actually
   driving these terms — a previous round found the speed-line comb had been retuned so far down
   that it does nothing.
   IMPORTANT: the player's kart is deliberately held OUT of the motion blur (it was being
   smeared into mush). The WORLD must carry the speed instead. Do not undo that hold.
2. **Fix the boost plume.** It must read as a hot flame without blowing to featureless white or
   occluding the kart it is attached to. Constrain its screen-space size, keep the core hot but
   small, let the falloff do the work, and make sure it sits BEHIND the kart in the chase view
   rather than in front of it. Then explicitly check the stacked worst case — boost plus a
   tier-3 drift plus the tunnel exit — and confirm the frame does not clip.

The last round oscillated between "no speed lines at all" and "a white starburst that destroyed
the tunnel frame". Find the middle and verify it at BOTH ends: a 55 km/h frame must look calm, a
101 km/h boost frame must look violent, and neither may blow out.`,
  },
  {
    key: 'hudtower',
    label: 'fix:hud-occlusion',
    files: 'src/ui/HUD.ts, src/ui/ui.css, src/ui/Minimap.ts',
    brief: `**THE NEW STANDINGS TOWER OCCLUDES THE KARTS THE PLAYER IS RACING.** From the UI critic,
scoring the element the last round added:

  "The single worst decision is a sim-racing timing tower parked over the right third of the
   frame, duplicating the position widget and occluding the karts you are actually racing."
  "a well-systematised web-app HUD, not a console racing HUD — ... executed in the OS system
   font on dark navy iOS cards that have nothing to do with Sunset Bay's warm coastal palette"

Do this:
1. **Remove or radically reduce the full standings tower.** It lists all eight racers down the
   right third of the screen, duplicates information the position widget already shows, and sits
   exactly where rivals appear. A console kart racer shows your position and at most the racer
   immediately ahead. If you keep any of it, make it a compact two-or-three-row sliver that
   cannot overlap the racing line of sight, or show it only on lap transitions.
2. **Re-theme the panels to the game's own world.** Dark navy iOS-style cards clash with a warm
   golden-hour coastal palette. Take the palette from ART_DIRECTION.md section 3 — warm paper,
   deep warm ink, the gold accent — and make the HUD look like it belongs to Sunset Bay.
   "Never pure black, never pure white" applies here too.
3. **Stop using the OS system font at default weights.** The bible calls that out explicitly.
   Build the numerals and labels from a deliberate treatment — heavy condensed display weights
   for numbers, tracked caps for labels — and keep tabular figures so nothing jitters.
4. Keep everything already working: one plate recipe, correct margins, no collisions at
   1280x720 / 1920x1080 / 2560x1440, and the html[data-touch] overrides in
   src/core/TouchControls.ts must still line up (that block is the only file outside your set
   you may edit).`,
  },
  {
    key: 'surfaces',
    label: 'fix:surface-variety',
    files: 'src/render/Materials.ts, src/render/Textures.ts, src/render/Noise.ts',
    brief: `**THE SAME NOISE IS DOING DUTY ON EVERY SURFACE IN THE GAME.** The materials critic:

  "the frame count where five distinct surface responses are actually visible is ZERO, because
   the same speckled-stone and same single-octave noise are doing duty on the kerb, the fences,
   the sign frames, the cliff and the backdrop"
  "the flat untextured crowd, the flat item boxes and the dead flat sea are outright violations
   of the bible's own automatic-fail clause"

And from craft: "two of the largest surfaces in the game (the cliff face and the tarmac) are
single-octave noise at CONSTANT ROUGHNESS".

Do this:
1. **Give each material family its own characteristic frequency, direction and roughness
   behaviour.** Painted metal, rough stone, smooth stucco, fabric, wood, glass and rubber
   should not share a noise basis. Vary octave count, lacunarity, anisotropy and — critically —
   how roughness responds, because roughness variation is what the eye reads as material
   identity under a low sun.
2. **Fix constant roughness on the two biggest surfaces.** The tarmac and the cliff face are the
   largest things in most frames and both are reported as constant-roughness single-octave
   noise. They need multi-octave detail AND spatially varying roughness.
3. **The crowd and the item boxes are flat untextured colour** — the bible's stated automatic
   fail. Give them real material response. The crowd is instanced, so do it in a way that keeps
   one draw call: per-instance colour plus a shared texture and normal is plenty.
4. Re-check the tarmac's wet look, which two rounds have now failed to fully resolve. The last
   diagnosis was the grade's split-tone rather than the IBL (measured: zeroing envMapIntensity
   made saturation WORSE, 46% to 51%; neutralising coolTint/shadowLift took it to 22%). It was
   reduced to 45% strength and still reads wet. Look at the road material's SHIPPED roughness
   value and map range, its specularIntensity, and whether its albedo is so dark that any
   specular dominates.

Do not regress generation time. Use low-resolution macro layers combined at sample time rather
than baking large textures.`,
  },
  {
    key: 'compose',
    label: 'fix:fill-the-frame',
    files: 'src/world/Scenery.ts, src/world/Props.ts, src/world/Foliage.ts, src/world/TrackLayout.ts',
    brief: `**HALF THE FRAMES ARE A BLACK ROAD IN AN ORANGE VOID.** The composition critic:

  "corner.png and drift.png are 50-60% dead tarmac with nothing above the horizon, and the
   'money shot' banked curve hides the bay it exists to show"
  "half these frames are a black road in an orange void with a scatter of props along one edge
   and a flat, unlit paper backdrop behind"

Two jobs:
1. **Fill the empty frames.** Find the sections that produce corner.png (t=0.58) and drift.png
   (t=0.74) and dress them properly — the art bible describes a tunnel and a banked coastal
   curve there. Both should be dense with event: rock walls and light strips through the tunnel,
   the full bay and a marina visible from the banked curve, plus roadside content on BOTH sides
   so the frame never has a dead quadrant. Nintendo never leaves a frame empty.
2. **The banked coastal curve must show the bay.** The bible calls it "the money shot — the full
   bay visible below" and the sea is not visible from it. The previous round diagnosed the cause
   precisely: the seaward guardrail and terrain berm block the view at chase-camera height, and
   fixing it needs the guardrail dropped to a low parapet in TrackLayout.ts. That file is YOURS
   this round — make the change, and make sure collision still works: the parapet must still
   stop a kart leaving the road, it just must not be a wall at eye level. Verify the barrier
   geometry and the collision geometry stay consistent.

Stay instanced; the budget is 250 draw calls and the worst frame is currently 210.`,
  },
]

phase('Fix')

const done = await parallel(
  JOBS.map((j) => () =>
    agent(BASE + j.brief + `\n\n## YOUR FILES (the only files you may write)\n${j.files}\n\n` +
      `Report what you changed, the measurements or images that justify it, and anything you rejected and why.`,
      { label: j.label, phase: 'Fix' })
  )
)

phase('Verify')

const verify = await agent(
  `cd ${ROOT}. Six specialists just worked in parallel. The previous round REGRESSED the score
(62 -> 58), so your job is as much about catching regressions as confirming fixes.

${JOBS.map((j, i) => `### ${j.label}\n${done[i] || '(no report — check whether its files changed)'}`).join('\n\n')}

In order:
1. npx tsc --noEmit — fix every error.
2. node tools/shot.mjs --out shots/r10 --settle 3 --w 1920 --h 1080
   Iterate until zero console errors.
3. Read EVERY png in shots/r10 and compare each against the same frame in shots/r1 (the
   previously scored build). For each of the ten, state: improved / unchanged / REGRESSED.
   Regressions matter more than improvements here.
   Confirm specifically:
   - lit and shadowed road now differ by clearly more than one stop, and shadowed surfaces read
     COOL rather than merely dark
   - every kart has an attached contact shadow, in every frame
   - a boost frame looks violently fast and a cruising frame looks calm, and neither blows out
   - the standings tower no longer occludes rivals
   - corner.png and drift.png are no longer half-empty tarmac
   - the sea is visible from the banked coastal curve
4. node tools/hitch-check.mjs 45 — must still print NOT CONFIRMED (zero late compiles).
5. node tools/ai-health.mjs — field races cleanly. node tools/touch-test.mjs and
   node tools/touch-lazy-test.mjs — both PASS.
6. node tools/perf.mjs if it exists — typical frames must stay under 250 draw calls.
7. Fix anything broken or regressed.

Report honestly, per frame. If the lighting change made things worse, say so plainly — it is a
large change and reverting part of it is a legitimate outcome.`,
  { label: 'verify', phase: 'Verify' }
)

return { jobs: JOBS.map((j, i) => ({ name: j.label, ok: !!done[i] })), verify }
