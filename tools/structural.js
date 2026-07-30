export const meta = {
  name: 'kart-structural',
  description: 'Deep-fix the five structural problems that survived three critique rounds',
  phases: [
    { title: 'Structural', detail: 'five deep agents on the recurring root causes' },
    { title: 'Integrate', detail: 'reconcile, verify the AI still races, capture' },
  ],
}

/**
 * Set ROOT to your checkout. Workflow scripts run in a sandbox without
 * filesystem access, so the path cannot be derived — it has to be stated.
 */
const ROOT = process.env.KART_ROOT || '/ABSOLUTE/PATH/TO/kart-game'

const BASE = `You are fixing the Three.js kart racing game at ${ROOT}.

Read first: ${ROOT}/ART_DIRECTION.md (the art bible) and ${ROOT}/src/types.ts (the contract).
Look at the current frames in ${ROOT}/shots/r3/ with the Read tool before you change anything.

This is NOT a normal critique round. Three rounds of criticism have already been applied and
the mean score has crawled 56 -> 59 out of 100 against a shipped-Mario-Kart bar. It stalled
because each round fixed symptoms inside one file while the underlying structural problem
survived. You have been given ONE of those root causes. Fix it properly, at the root, even if
that means a substantial rewrite of the files you own.

Rules:
- Stay in YOUR FILES (listed below). Never edit src/types.ts.
- Do not run the dev server or tools/shot.mjs — other agents are running in parallel.
  Verify compilation with: cd ${ROOT} && npx tsc --noEmit
- Keep the performance work that just landed: karts have a merged impostor + LOD, several
  prop families no longer cast shadows, and the frame is now ~200 draw calls against a 250
  budget. Do not blow that budget. If your fix costs draws, instance or merge it.
- Everything is procedural. No asset files, no model loading.

YOUR ROOT CAUSE:
`

const JOBS = [
  {
    key: 'track-width',
    label: 'root:track-proportions',
    files: 'src/world/Track.ts, src/world/TrackLayout.ts, src/world/TrackGeometry.ts',
    brief: `**THE ROAD IS FAR TOO WIDE. This is the single most damaging flaw in the game and it has
been reported by the composition critic in all three rounds without ever being fixed.**

Look at ${ROOT}/shots/r3/wide.png and ${ROOT}/shots/r3/hero.png. The road is roughly EIGHT kart
widths across. It reads as an airport taxiway or a town plaza, not a kart circuit. Consequences
visible in every single frame:
  - 30-50% of the image is empty featureless asphalt with nothing happening on it
  - the player's kart is a speck, so the hero asset everyone worked on cannot be seen
  - the eight-kart field spreads out and never bunches, so there is no sense of a race
  - scenery is pushed so far to the edges that the road is bounded by void

A Mario Kart road is about THREE TO FOUR kart widths — wide enough for a pack of four abreast
plus a passing line, and no wider. A kart here is ~1.5 m wide.

Do this:
1. Cut the road half-width substantially — target roughly 6.5-8 m half-width (13-16 m road) on
   normal sections, narrowing to ~5.5 m on the cliff traverse and widening to ~9 m only on the
   start straight and the banked coastal curve where the pack genuinely needs room. Currently
   it is around 13 m half-width. Tune the exact numbers by eye against the frames.
2. The width taper must remain smooth — no discontinuities that snap as the player drives.
3. Re-check everything that keys off width: the start grid must still fit eight karts two
   abreast without clipping into the kerbs; the racing line and its lateral offsets; item box
   placement; kerb and shoulder geometry; guardrail placement; the tunnel bore must still
   clear the road with headroom; the bridge parapets.
4. With the road narrower, the kerbs, shoulders and barriers become far more visible — make
   sure they hold up to that scrutiny. Raise the kerb profile detail if needed.
5. While you are in here: the composition critic also notes the track has long featureless
   straights. Add road-surface interest that costs nothing structurally — a worn racing line
   that actually follows the racing line, patch repairs, expansion joints, drain covers,
   painted edge lines, sponsor paint at corner entries, and rumble strips before braking zones.

This change has a wide blast radius. The AI racing line, physics and scenery placement all
query ITrack. Keep every ITrack method's contract EXACTLY as declared in types.ts — same
signatures, same units, same t-parameterisation. Other agents are editing those consumers right
now, so the interface is the one thing that must not move.`,
  },
  {
    key: 'materials-macro',
    label: 'root:material-macro-scale',
    files: 'src/render/Materials.ts, src/render/Textures.ts, src/render/Noise.ts',
    brief: `**EVERY SURFACE IS THE SAME MATERIAL WEARING A DIFFERENT TINT.** The materials critic has
now said this twice, in nearly identical words, and the score has not moved (56, then 56):

  "one grade of uniform high-frequency isotropic speckle, applied to tarmac, cliff, hillside,
   grass and tunnel rock alike, with no metre-or-larger scale on top of it"
  "no clearcoat on the paint, no reflection in the chrome, no macro form in any rock"

The texture generator is sophisticated but it only produces ONE spatial frequency: fine grain.
Real surfaces have structure at every scale — centimetre grain, decimetre features, and
METRE-scale variation. Without the large scale, every surface reads as flat noise and the eye
instantly clocks it as procedural.

Fix it at the root:
1. **Add macro-scale variation to every terrain-ish material.** On tarmac: patch repairs with
   soft irregular boundaries, colour drift across metres, oil staining, pooling darkness at the
   edges, tyre-worn polish along the line. On rock and cliff: actual STRATA and large fracture
   planes, not pebble noise — layered bands with varying tone and roughness, big shapes that
   read as geology from 40 m. On grass: clumping and colour variation in patches, dirt showing
   through where it is worn. Use low-frequency FBM and domain warping, and modulate BOTH albedo
   AND roughness with it.
2. **Break the isotropy.** Real surfaces have direction — road aggregate is smeared along the
   direction of travel, rock strata run horizontally, wood grain runs along the plank. Add
   anisotropic/stretched noise where the surface has a natural direction.
3. **Roughness must vary at macro scale too**, not just albedo. This is what makes the grazing
   golden-hour sun produce a varied sheen across the tarmac instead of a uniform dull band —
   the lighting critic separately complained there is "no grazing sun sheen on the tarmac", and
   this is the actual cause.
4. **Fix the paint and chrome.** The critic says there is no clearcoat lobe on the kart paint
   and no reflection in the chrome. Verify the kart materials are genuinely MeshPhysicalMaterial
   with clearcoat, that envMapIntensity is sane (an earlier round found it globally crushed to
   0.40 — make sure that is really resolved and that metals get a full-strength environment),
   and that chrome has a low enough roughness to produce a sharp reflection.
5. Add per-material triplanar where UV stretching shows on slopes.

Do not regress generation time or memory: use lower resolutions for the macro layer (it is low
frequency by definition — a 128px macro map stretched over 30 m is plenty) and combine at
sample time rather than baking huge textures.`,
  },
  {
    key: 'distant-world',
    label: 'root:distant-world',
    files: 'src/world/Scenery.ts, src/world/Props.ts, src/world/Foliage.ts, src/world/Water.ts',
    brief: `**THE WORLD STOPS ABOUT 80 METRES FROM THE CAMERA AND THE HORIZON IS EMPTY.**
The composition critic, twice: "one side is a wall, the other is a void", "the world stops
about 80 metres from the camera and the horizon has nothing in it".

Look at ${ROOT}/shots/r3/hero.png. The distant hills are FLAT, UNTEXTURED, FACETED CARDBOARD
CUTOUTS in a single tan tone. They have visible polygon facets, no material, no silhouette
interest, and no atmospheric separation from each other. They are the most amateur thing in an
otherwise decent frame. The sea is a flat white-grey band with a hard horizon seam.

Fix:
1. **Rebuild the distant terrain as real landforms.** Multiple ridgelines at genuinely different
   distances (200 m, 600 m, 1500 m, 4000 m), each with an interesting silhouette — peaks,
   saddles, headlands running into the sea, an island or two. Displaced geometry with real
   noise, not extruded blobs. Give them the rock material with macro strata (the materials
   agent is adding that right now — request it by name and it will be there).
2. **Aerial perspective must separate the layers.** Each successive ridge should sit further
   toward the sky colour, with reduced contrast and saturation. This is what creates depth, and
   it is the cheapest big win available. Make sure it agrees with the scene fog rather than
   fighting it.
3. **Fill the midground — the 40 to 150 m band, which is currently the emptiest part of every
   frame.** Terraced olive groves and vineyards on the hillsides, a coast road switchbacking up
   the headland, distant villages clinging to slopes, a marina with masts, breakwaters, a
   distant lighthouse, boats out on the water. All instanced.
4. **The sea is dead.** It reads as flat white-grey with a hard seam at the horizon. It needs
   the depth-based colour ramp the bible specifies, a proper sun-glitter path running toward
   the camera (the single most beautiful thing available at golden hour), swell, and a horizon
   that dissolves into atmosphere rather than terminating in a hard line.
5. **Fix the "wall on one side, void on the other" framing.** Wherever the track has open space
   on one side, put something there at a readable distance — a line of cypresses, a stone wall,
   a row of parasols, moored boats, a fence with banners. The player's eye should never find a
   hole in the frame.

Everything instanced or merged; you are working against a ~200 draw call budget that was just
hard-won. LOD and cull aggressively — distant layers can be very low poly since aerial
perspective hides their detail anyway.`,
  },
  {
    key: 'vfx-rework',
    label: 'root:effects-rework',
    files: 'src/fx/Effects.ts, src/fx/Particles.ts, src/fx/Trails.ts, src/fx/Decals.ts',
    brief: `**THE EFFECTS LAYER HAS BLOCKER-GRADE ARTIFACTS IN THE CENTRE OF THE FRAME.**
Verbatim from the game-feel critic, who scored 58:

  "the drift 'spark ring' is an opaque plastic hula-hoop clipping through the chassis"
  "the boost shot has no flame, a teal dinner-plate for a shockwave, and a hero kart blurred
   into unreadable mush"
  "four of the ten frames have a blocker-grade artifact sitting in the exact centre"

And from craft: "alpha-test crawl on every palm", "a boost pad clipped to featureless white".

Fix each properly:
1. **Kill the hula-hoop.** Whatever is drawing a hard opaque ring/torus around the kart during
   drift must go. Drift feedback should be SPARKS — small, additive, short-lived particles
   thrown from the rear contact patches, with a bright core and soft glow, tier-coloured blue
   #4fc3ff / orange #ff9d2e / purple #c05cff — plus a low ground-hugging glow and a scorch
   decal. Nothing rigid, nothing that intersects the chassis, nothing with a hard silhouette.
2. **Restore a real boost flame.** Tapered plumes from both exhaust stacks, hot white-yellow
   core to cool orange-red tips, animated, additive, that clearly read at the 32 m/s hero shot.
   The activation shockwave must be a fast, thin, expanding-and-fading ring seen nearly
   edge-on — not an opaque teal disc parked on the road.
3. **Energy conservation.** The bible demands it and the critics say the frame clips to white.
   Explicitly test boost + drift + tunnel exit stacked together, and make sure nothing saturates
   the frame. Additive effects should ADD to a scene, not replace it.
4. **Soft particles.** Craft has flagged particles slicing through the ground in every round.
   The integrator noted a depth texture is unavailable because particles render inside the scene
   pass. Solve it properly: either request a depth prepass, or use the cheap and very effective
   fallback — fade each particle by its own distance above the ground plane, which you can get
   from ctx.track.probe, plus a soft-edged texture and a camera-facing bias. Do not leave this
   unsolved for a fourth round.
5. Make sure every effect sits IN the golden-hour lighting rather than glowing flatly on top of
   it — non-additive smoke and dust must be lit.

Scale everything by ctx.settings.particleDensity, pool everything, zero allocation per frame.`,
  },
  {
    key: 'light-separation',
    label: 'root:lighting-separation',
    files: 'src/render/Sky.ts, src/render/Atmosphere.ts, src/render/PostFX.ts, src/render/Renderer.ts',
    brief: `**THE LIGHTING ILLUMINATES BUT DOES NOT SCULPT.** Lighting moved 48 -> 61 but stalled there,
and the critic's diagnosis is specific:

  "no key/fill/rim separation on the karts, no grazing sun sheen on the tarmac, a dead white
   sea with a hard horizon seam, a tunnel that is brighter inside than the daylight outside it,
   and effects that emit no light onto anything"
  "golden hour is asserted by the palette, not by the light"

Fix each:
1. **Key/fill/rim separation.** With a 14-degree sun, a kart should have a hot warm-lit side, a
   distinctly COOLER shadowed side (sky fill, not merely a darker version of the key), and a
   bright rim where the low sun grazes its edge. Right now the shadowed side is just dimmer.
   Make the fill genuinely cool and directional (sky-dominant from above and the anti-sun side),
   and make sure the environment map has enough contrast between the sun side and the anti-sun
   side of the sky to produce a real rim. A uniform-luminance env map is the usual cause of
   "flat" PBR, so check yours.
2. **The tunnel is brighter inside than outside.** That is an inversion, and it is a blocker.
   The interior must be genuinely dark, lit by its sodium strips and by daylight spilling in at
   the mouths, with a strong bright exit that the eye adapts to. Check whether ambient/env
   lighting is leaking in unoccluded — that is almost certainly what is happening, and it is
   what AO and a local light probe or a simple interior-darkening volume are for.
3. **Grazing sun sheen.** At 14 degrees the sun should skim the tarmac and produce a broad
   specular sheen down the road toward the camera. This requires both spatially varying
   roughness (the materials agent is adding that) and a specular response that is not being
   crushed. Verify your side of it.
4. **The horizon seam.** The fog colour and the sky colour must match EXACTLY at the horizon.
   A visible seam where the sea meets the sky is called out in the bible as a classic tell.
5. **Exposure and highlight rolloff.** Multiple rounds have flagged blown-out white regions —
   boost pads clipping to featureless white, the sun side bleaching. Tune the tone-mapping
   shoulder so highlights roll off into colour instead of clipping to flat white.
6. Effects emit no light onto the world. A cheap, very effective fix: attach a short-range
   point light to the boost flame and to strong drift sparks, budget-limited to the player and
   the nearest rival.`,
  },
]

phase('Structural')

const done = await parallel(
  JOBS.map((j) => () =>
    agent(BASE + j.brief + `\n\n## YOUR FILES (the only files you may write)\n${j.files}\n\n` +
      `Report: what you changed at the root, what you measured or looked at to confirm it, and ` +
      `anything you could not fix from inside your own files.`,
      { label: j.label, phase: 'Structural' })
  )
)

phase('Integrate')

const integration = await agent(
  `cd ${ROOT}. Five agents just made STRUCTURAL changes to the kart racing game in parallel.
The largest by far: the road half-width was cut from ~13 m to ~7 m, which changes the geometry
every other system queries.

Their reports:
${JOBS.map((j, i) => `### ${j.label}\n${done[i] || '(no report — agent may have failed; check its files)'}`).join('\n\n')}

Your job, in order:
1. **npx tsc --noEmit** — fix every error.
2. **Verify the AI can still drive the narrower circuit.** This is the highest risk in the whole
   change: a racing line tuned for a 26 m road may now run through the barriers.
     node tools/ai-health.mjs
   Every kart must cover meaningful distance with near-zero off-track frames and no kart stuck
   reversing. If they are hitting walls, fix the racing line / lateral offsets / AI avoidance
   until they race cleanly. Run it more than once — there is real run-to-run variance.
3. **Verify the grid still fits.** Eight karts, two abreast, on a road half as wide. Check they
   do not spawn inside kerbs, barriers or each other.
4. **Capture and LOOK:**
     node tools/shot.mjs --out shots/r4 --settle 3 --w 1920 --h 1080
   Iterate until zero console errors. Then Read every PNG and confirm with your own eyes:
   the road now reads as a kart track rather than a plaza; the player's kart is a substantial
   presence in frame; the distant hills are no longer flat cardboard; there is no opaque ring
   around the kart during drift; the boost shot has a real flame.
5. **Check the touch controls still lay out correctly** (they are new):
     node tools/touch-test.mjs
   It must print PASS.
6. Fix anything broken. Do not remove features to make errors go away.

Report honestly, per item above, with what you actually observed. If the road width change
broke something you could not fully fix, say exactly what.`,
  { label: 'integrator', phase: 'Integrate' }
)

return { jobs: JOBS.map((j, i) => ({ name: j.label, ok: !!done[i] })), integration }
