export const meta = {
  name: 'kart-completion-3',
  description: 'Mobile crash, black frames, and the three Cs — camera, controls, character',
  phases: [
    { title: 'Fix', detail: 'six specialists: memory, context loss, camera, controls, character, stability' },
    { title: 'Integrate', detail: 'gated on the mobile soak test passing' },
  ],
}

const ROOT = '/Users/ryan/dev/personal/kart-game'

const BASE = `Three.js kart racing game at ${ROOT}. Read ${ROOT}/ART_DIRECTION.md and ${ROOT}/src/types.ts first.

The player has reported three things from a REAL device, and player reports have outranked every
automated critic in this project so far:
  1. "still black partial renders at times"
  2. "the 3 Cs (camera, controls, character) need major optimizing"
  3. "stability/performance, especially mobile — it crashes on my phone after 10 seconds"

## Measured evidence, gathered before this round (do not re-litigate it, build on it)
Run on an emulated iPhone (844x390 @2, Quality.Medium, iOS user-agent):
  - **texture memory 217.7 MB** against a mobile budget of 80 MB  <-- the crash
  - 138 textures, dozens of them 1024x1024 at 5.34 MB each
  - JS heap 202 MB steady (fine on desktop; near the ceiling for an iOS tab)
  - GPU textures 161 -> 173, geometries 122 -> 175 then flat (settles, not a leak)
  - **ZERO WebGL context-loss handling anywhere in the codebase** — no
    'webglcontextlost' listener, no restore path
  - no crash reproduced in 45s on desktop-emulated mobile; the real device is
    memory-constrained in a way the emulator is not

iOS Safari kills a tab on total footprint, and textures count against it. 218 MB of textures plus
a 200 MB heap is a jetsam kill on a real phone. That is the leading theory and the numbers
support it.

## Rules
- Stay in YOUR FILES. Never edit src/types.ts.
- Do NOT run the dev server or tools/shot.mjs — agents run in parallel, ports are shared.
  You MAY write your own puppeteer script in the scratchpad on a unique port in 5310-5390 using
  the startVite helper from ${ROOT}/tools/vite-server.mjs.
- Verify compilation with: cd ${ROOT} && npx tsc --noEmit
- Everything is procedural. No asset files.
- Do not fix mobile by making the desktop game worse. Quality tiers exist — use them.

YOUR JOB:
`

const JOBS = [
  {
    key: 'memory',
    label: 'fix:mobile-memory',
    files: 'src/render/Materials.ts, src/render/Textures.ts, src/core/Settings.ts',
    brief: `**CUT TEXTURE MEMORY FROM 218 MB TO UNDER 80 MB ON MOBILE. This is the crash.**

Measured: 217.7 MB of texture memory at Quality.Medium, which is the tier a phone gets. Dozens
of 1024x1024 RGBA textures at 5.34 MB each (4 bytes/px plus mips).

Do this:
1. **Scale texture resolution by quality tier.** A 1024 albedo on a phone at 844x390 is absurd —
   the texel density is many times the pixel density. Halve or quarter every generated texture
   below Quality.High. The art bible's "1024 minimum" is a desktop standard; add an explicit
   mobile clause rather than silently violating it.
2. **Stop paying for channels you do not use.** Roughness, metalness, AO and height are single-
   channel data stored in RGBA — that is 4x waste. Pack them into one RGB texture (the standard
   ORM/MRA layout: occlusion in R, roughness in G, metalness in B) and sample the right channel.
   That alone can take a third off.
3. **Drop mips where they cannot help**, and make sure nothing is generating mips for a texture
   that is only ever sampled 1:1 (UI, decal atlases, LUTs).
4. **Share aggressively.** Audit for near-duplicate textures generated separately that could be
   one texture plus a tint — the variant helper already exists, so use it.
5. **Free the generation canvases.** Procedural textures are drawn into canvases and uploaded;
   if a reference to the canvas or its ImageData survives, that memory is charged twice, once on
   the GPU and once in the JS heap (currently 202 MB, which is high). After upload, release the
   source where three allows it.
6. **Fix quality detection in src/core/Settings.ts.** It currently sniffs
   /Android|iPhone|iPad|iPod/ in the user agent. That misses iPadOS Safari entirely, which
   defaults to "Request Desktop Website" and reports a Mac user agent — the exact bug that
   already bit the touch controls in this project. Use robust signals: pointer coarseness,
   maxTouchPoints, devicePixelRatio combined with screen size, and
   navigator.deviceMemory / hardwareConcurrency where available. Getting this wrong hands a
   phone the Ultra preset, which is an instant crash.
7. Consider adding a genuine Quality.Low mobile default with a lower renderScale — a phone at
   deviceScaleFactor 3 rendering at renderScale 1.0 is drawing far more pixels than it needs to.

Verify with: node tools/mobile-soak.mjs 45  (it prints texture memory and exits non-zero over
budget). You may run that — it uses port 5302, which no other agent will touch.`,
  },
  {
    key: 'context',
    label: 'fix:context-loss',
    files: 'src/render/Renderer.ts, src/render/PostFX.ts, src/main.ts',
    brief: `**THERE IS NO WEBGL CONTEXT-LOSS HANDLING ANYWHERE. This is almost certainly the "black
partial renders", and on mobile it turns a recoverable hiccup into a dead tab.**

When a mobile GPU comes under memory pressure the browser takes the WebGL context away. Without
a handler the canvas goes black permanently and never comes back — there is no automatic
recovery in three.js for your scene's GPU resources.

Implement it properly:
1. Listen for 'webglcontextlost' on the canvas and call **event.preventDefault()**. Without that
   single call the browser will never fire 'webglcontextrestored' at all, and recovery is
   impossible. This is the most commonly missed line in WebGL apps.
2. On loss: stop the render loop immediately, mark the pipeline unavailable so nothing tries to
   draw, and show a brief, calm on-screen notice rather than a black rectangle.
3. On 'webglcontextrestored': rebuild everything that lives on the GPU — the composer and all
   its render targets, the PMREM environment map, shadow maps — then re-run the shader pre-warm
   (src/core/Prewarm.ts, exported as prewarm(ctx)) and resume. Textures and geometries that
   three still holds will re-upload on demand, but anything you own that wraps a GL resource
   must be reconstructed.
4. **Add a render-loop watchdog.** If a frame takes absurdly long or the context is gone, do not
   keep queueing work that piles up — that turns a stall into a crash.
5. **Investigate the partial black frames directly.** The capture harness
   (tools/shot.mjs) documents this exact artifact and works around it with retries: "roughly one
   capture in five comes back as a vertical split, with the left band holding the previous frame
   and everything right of the seam holding a scene buffer that was never drawn into". It was
   assumed to be a SwiftShader compositor quirk — but the PLAYER SEES IT ON REAL HARDWARE, so
   that assumption is wrong and the harness has been masking a genuine bug for several rounds.
   Find the real cause. Prime suspects: a render target resized mid-frame, the composer's
   swap/read-write buffers being out of step, a pass reading the buffer it is writing, or the
   scene pass not clearing a target it only partially covers.
6. Make sure the game degrades rather than dies: if the composer cannot be built, fall back to a
   direct render (that path exists) rather than showing nothing.

You own src/main.ts for the loop changes. Keep the __freeze hook the capture harness relies on.`,
  },
  {
    key: 'camera',
    label: 'fix:C-camera',
    files: 'src/game/Camera.ts',
    brief: `**THE FIRST OF THE THREE Cs. The player says the camera needs major optimizing.**

Read src/game/Camera.ts fully first — there is real work in there already (spring arm, velocity
feed-forward that cancels SmoothDamp's standing error, collision pull-in, cinematic poses). Do
not throw it away; make it FEEL right.

The bar is Mario Kart's camera, which does several things this one is reported not to:
1. **It stays out of the way.** Test for and fix: clipping into walls and the tunnel roof,
   jarring snaps when the kart respawns or lands, the horizon rolling too far or too late,
   nausea-inducing over-correction, and any frame where the camera ends up inside geometry.
2. **It reads the road ahead.** The player must see far enough into the next corner to react.
   A previous review noted the corner-lead aim pushes the kart 35-50% off frame centre in tight
   corners, which is aggressive — find the balance between showing the apex and keeping the
   subject stable.
3. **It is frame-rate independent.** Every smoothing term must use an exponential/damped form
   with dt, never a raw per-frame lerp constant. On a 120Hz phone a per-frame constant makes the
   camera behave completely differently from a 60Hz desktop. Audit every smoothing site.
4. **It responds to state**: speed lengthens and lowers the arm, boost punches and settles with
   a slight overshoot, drift follows the direction of travel so the kart slides across frame,
   landing dips, braking pitches forward, collisions kick.
5. **It never allocates in lateUpdate.**

Write yourself a headless probe (unique port 5310-5390) that drives a full lap and records
camera position, the distance to the kart, the angle between camera-forward and kart-forward,
and any frame where the camera is inside geometry or the kart leaves the frame. Fix what the
numbers show, and report those numbers.`,
  },
  {
    key: 'controls',
    label: 'fix:C-controls',
    files: 'src/core/Input.ts, src/core/TouchControls.ts',
    brief: `**THE SECOND OF THE THREE Cs. The player says the controls need major optimizing.**

Read src/core/Input.ts and src/core/TouchControls.ts fully. Recent history matters: steering was
inverted (fixed), fast key taps were dropped because edges were polled rather than latched
(fixed), and the on-screen pad never appeared on iPadOS (fixed).

Now make them FEEL excellent:
1. **Latency is everything.** Audit the whole path from event to physics. Anything that adds a
   frame of delay for no reason must go. The steering ramp for keyboard exists to fake an axis
   out of a digital key — make sure its rates feel immediate rather than mushy, and that the
   analogue paths (touch stick, gamepad) are not being smoothed twice.
2. **Touch steering quality.** The floating stick's dead zone (0.1) and response curve (pow 1.35)
   were chosen without playtesting. Tune them for fine control near centre AND full lock being
   comfortably reachable with a thumb. Consider whether the stick should have a maximum
   deflection that maps to full lock well before the thumb runs out of travel.
3. **Gamepad.** Verify the mapping on a standard layout, add trigger analogue throttle/brake
   (buttons 6/7 are analogue), a proper dead zone with rescaling, and rumble on impacts if the
   API is available.
4. **Frame-rate independence.** The steer ramp uses dt, but verify every rate constant behaves
   the same at 30, 60 and 120 fps. A phone at 120Hz must not steer twice as fast.
5. **Buffering.** A drift or item press that arrives a frame before it becomes legal should still
   register — a small input buffer (~100ms) is standard in the genre and makes the game feel far
   more responsive.
6. **Do not regress**: keyboard, gamepad and touch must all keep working, and
   tools/touch-test.mjs and tools/touch-lazy-test.mjs must both still PASS. Run them; they use
   ports 5181 and 5182 and no other agent will touch those.`,
  },
  {
    key: 'character',
    label: 'fix:C-character',
    files: 'src/kart/Kart.ts, src/kart/Suspension.ts, src/kart/Tyre.ts',
    brief: `**THE THIRD OF THE THREE Cs — the character, i.e. how the kart itself behaves. The player says
it needs major optimizing.**

Read src/kart/Kart.ts, Suspension.ts and Tyre.ts fully. There is a real model in there: 120Hz
substepped integration, four-corner raycast suspension, a slip-angle tyre with a friction circle,
hop-and-slide drifting with three mini-turbo tiers.

Make it feel like a shipped kart racer:
1. **Responsiveness.** The kart must change direction the instant the player asks. Audit for
   anything that adds lag: over-damped steering rack, excessive yaw inertia, a tyre model whose
   peak slip angle is reached too slowly.
2. **Drift must be easy to enter, stable to hold, and rewarding to release.** Verify a player can
   reliably hold a tier-3 mini-turbo through a long corner without the kart snapping or sliding
   off. A previous round measured drift washing the kart a median 3.48 m sideways with 7 of 8
   episodes ending off the road — that was retuned for the AI, but verify it from the PLAYER's
   seat, at player speeds, on the corners a player actually uses.
3. **Weight and grip must read.** Acceleration should feel like it builds, braking should bite,
   landings should compress the suspension visibly, and the surface types must feel genuinely
   different — grass and sand should be a real punishment.
4. **Stability.** No NaN paths, no tunnelling through walls at speed, no getting wedged. Assert
   over a long headless session that position, velocity and quaternion stay finite and that the
   kart never leaves the world.
5. **Frame-rate independence.** The integrator substeps at a fixed 120Hz, which is right — verify
   the accumulator handles a long stall without spiralling (clamp the number of substeps) and
   that behaviour is identical at 30 and 120 fps. Measure it: run the same input script at both
   rates and compare the resulting trajectories.
6. **Mobile matters here too.** The physics runs on the CPU every frame for 8 karts; profile it
   and cut per-frame cost where you can without changing the feel.

Write a headless probe on a unique port (5310-5390) that measures: time-to-full-steering-response,
0-to-top-speed, drift entry success rate, tier-3 hold rate over a real corner, and trajectory
divergence between 30fps and 120fps. Report those numbers before and after.`,
  },
  {
    key: 'stability',
    label: 'fix:stability-and-frame-pacing',
    files: 'src/fx/Particles.ts, src/fx/Effects.ts, src/fx/Decals.ts, src/game/Projectiles.ts, src/render/DrawBudget.ts',
    brief: `**STABILITY AND FRAME PACING, ESPECIALLY ON MOBILE.**

The soak test shows GPU geometries climbing 122 -> 175 in the first ten seconds before settling,
and the JS heap sitting at 202 MB. Neither is a runaway leak, but both are higher than they
should be, and on a phone the headroom is not there.

Do this:
1. **Find and remove per-frame allocation in the hot path.** Particles, effects, decals and
   projectiles are the usual offenders. Every allocation is GC pressure, and a GC pause on a
   phone is a dropped frame — which is exactly what the player is reporting as a black flash.
   Profile it: run headless, sample the heap across a race, and identify what is churning.
2. **Cap everything that can grow.** Decals, particles, projectiles and trails must have hard
   ceilings and pooled reuse, with the oldest recycled rather than the pool extended. Verify by
   forcing a worst case (whole field drifting with items firing) and confirming the counts
   plateau.
3. **Scale hard by quality tier.** ctx.settings.particleDensity exists — make sure every emitter
   honours it, and that the mobile tier actually produces far fewer particles rather than
   slightly fewer.
4. **Check geometry churn.** Geometries climbing after boot means something is building meshes
   at runtime. Find what, and pre-allocate it.
5. **Frame pacing.** Look for work that happens in bursts rather than being spread — a decal
   atlas rebuild, a trail rebuild, a shadow cascade refresh. A single 40ms frame is far worse
   than five 8ms frames. Amortise where you can.
6. Keep the draw-call budget (typical under 250) and do not remove content to hit numbers.

Verify with: node tools/mobile-soak.mjs 60 (port 5302, yours alone to run).`,
  },
]

phase('Fix')

const done = await parallel(
  JOBS.map((j) => () =>
    agent(BASE + j.brief + `\n\n## YOUR FILES (the only files you may write)\n${j.files}\n\n` +
      `Report the measurements before and after, what you changed, and anything you could not fix.`,
      { label: j.label, phase: 'Fix' })
  )
)

phase('Integrate')

const integration = await agent(
  `cd ${ROOT}. Six specialists just worked in parallel on the mobile crash, the black frames and
the three Cs.

${JOBS.map((j, i) => `### ${j.label}\n${done[i] || '(no report — check whether its files changed)'}`).join('\n\n')}

Your job, in order. Report what you ACTUALLY observed and measured at each step.

1. npx tsc --noEmit — fix every error. Parallel edits produce cross-module breakage; that is
   your job. Watch specifically for backticks accidentally written inside template literals —
   that has broken this build twice.
2. **node tools/mobile-soak.mjs 60 — THIS IS THE PRIMARY GATE. It must PASS.**
   Texture memory under 80 MB, heap under 350 MB, no growth, no context losses, no page errors.
   If it fails, fix it. This is the player's crash and it is the most important thing in the
   round.
3. Verify context-loss recovery actually works. Write a probe on port 5395 that boots the game,
   then forces a loss via the WEBGL_lose_context extension, waits, and confirms: the page does
   not go permanently black, 'webglcontextrestored' fires, the composer is rebuilt and rendering
   resumes with a non-black frame. A context-loss handler that has never been exercised is not a
   handler.
4. node tools/hitch-check.mjs 45 — must still print NOT CONFIRMED (zero late compiles).
5. node tools/ai-health.mjs — field races cleanly, twice.
6. node tools/touch-test.mjs and node tools/touch-lazy-test.mjs — both PASS.
7. node tools/steer-test.mjs — steering must still be correct: steer +1 moves the kart POSITIVE
   along screen-right, steer -1 negative.
8. node tools/shot.mjs --out shots/r11 --settle 3 --w 1920 --h 1080 — zero console errors.
   Read every PNG and confirm none is black, torn or broken, and that the game still looks at
   least as good as shots/r1.
9. Fix anything broken or regressed. Do not remove features to make errors go away.

Finish with the mobile soak passing. Then report: the soak numbers, whether context loss now
recovers, the three Cs verdicts with their measurements, and anything still outstanding.`,
  { label: 'integrator', phase: 'Integrate' }
)

return { jobs: JOBS.map((j, i) => ({ name: j.label, ok: !!done[i] })), integration }
