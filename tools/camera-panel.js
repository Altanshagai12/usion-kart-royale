export const meta = {
  name: 'kart-camera-panel',
  description: 'Three independent camera rebuilds in isolated worktrees, judged on measured feel, best one landed',
  phases: [
    { title: 'Candidates', detail: 'three rigs, three philosophies, each measured' },
    { title: 'Judge', detail: 'pick the winner on numbers, not prose' },
    { title: 'Land', detail: 'apply the winner to the main tree and re-verify' },
  ],
}

const ROOT = '/Users/ryan/dev/personal/kart-game'

const MEASURED = `## MEASURED BASELINE — this is what is wrong, in numbers

Run \`node tools/camera-probe.mjs\` for yourself before changing anything. It drives the player
through \`Race.driveOverride\` (the sanctioned hook — do NOT call \`Kart.step\` directly, the race
director is already stepping it and you will double-integrate and measure nonsense).

Current, on the main tree:

    [step: 0.5s straight, 1.5s full lock, 1.5s release]
      peak camera swing      1013 deg/s      <-- nausea
      p95 swing               355 deg/s
      peak lag behind kart    157.5 deg      <-- camera nearly backwards
      peak off-centre          14.34         (1.0 = screen edge; the kart LEAVES THE SCREEN)
      mean off-centre           0.729
      frames past 35% off      79.5%
      settle                    0.38 s

    [weave: gentle +/-0.45 sine, the ordinary case]
      peak swing              227 deg/s
      peak lag                 46 deg
      mean off-centre           1.208        <-- off screen ON AVERAGE
      frames past 35% off      65.4%

    [frame-rate independence — same input script at three rates]
      30Hz   peak swing  125 deg/s
      60Hz   peak swing 1040 deg/s
      120Hz  peak swing 2153 deg/s
      peak-lag spread across rates: 26.8 deg     <-- RATE DEPENDENT

That 17x swing difference across frame rates is the single clearest defect: something in the rig
is integrating per FRAME rather than per SECOND. On a 120Hz laptop the camera behaves completely
differently than on a 60Hz one. Find it.

## TARGETS (the judge scores against these)

    peak swing            < 300 deg/s at EVERY rate
    p95 swing             < 150 deg/s
    peak lag              < 35 deg
    peak off-centre       < 0.60
    mean off-centre       < 0.20
    frames past 35% off   < 10%
    settle                < 0.45 s
    rate spread           < 3 deg peak-lag across 30/60/120Hz

Hitting the targets by making the camera rigid is NOT a pass. A camera bolted to the kart's
facing scores perfectly on every number above and feels dead. The rig must still:
  - follow the direction of TRAVEL during a drift, so the kart visibly slides across frame
  - roll with the banked coastal curve
  - drop and close under boost, settling with a small overshoot
  - pull in rather than clip through the tunnel roof and walls
  - keep the road ahead readable into a corner
The judge is explicitly told to check that these survive.
`

const RULES = `## Rules
- You are working in your OWN GIT WORKTREE. Nothing you do can affect the other candidates.
- You own \`src/game/Camera.ts\`. You may also read anything else. If a fix genuinely belongs in
  \`src/kart/Kart.ts\` (steering rack rates, MAX_STEER) say so in your report — a separate agent
  owns the kart this round and the judge will weigh it.
- Verify with: npx tsc --noEmit
- Measure with: node tools/camera-probe.mjs   (it starts its own vite on port 5313)
  You may also capture with: node tools/shot.mjs --only hero,drift,corner --settle 3 --out shots/cam
  Read those PNGs — numbers cannot tell you whether the composition is any good.
- Zero allocation in lateUpdate. Keep window.__camMode ('chase'|'wide'|'close') working, the
  capture harness sets it.
- Report the FULL probe output before and after. A candidate with no numbers cannot be judged.
`

const CANDIDATES = [
  {
    key: 'repair',
    label: 'cam:repair-in-place',
    brief: `**PHILOSOPHY: FIX WHAT IS THERE.**

The existing rig is ~3500 lines and contains real work — a spring arm, velocity feed-forward that
cancels SmoothDamp's standing error, collision pull-in, cinematic poses, a travel-vs-facing
heading blend. It scores badly, but it may be a few broken terms rather than a bad design.

Diagnose surgically. Find the specific terms responsible for each measured defect:
  - which smoothing site is per-frame rather than per-second (that is the 17x)
  - which term lets the kart reach 14x off screen (a lead/anticipation term with no clamp?)
  - why the lag reaches 157 degrees on a step input
Fix those. Change as little else as possible. Your advantage over the other candidates is that
you keep every behaviour that already works; your risk is that the design itself is the problem.`,
  },
  {
    key: 'rebuild',
    label: 'cam:clean-rebuild',
    brief: `**PHILOSOPHY: REBUILD IT SIMPLY.**

Assume the existing rig has accreted past the point of being tunable — 3500 lines with dozens of
interacting constants, several rounds of patches on patches. Replace it with the smallest rig
that hits the targets and keeps the five required behaviours.

A good arcade chase camera is not complicated: a target pose derived from the kart's travel
heading and the track normal, a critically-damped spring toward it with frame-rate-independent
damping, a clamp on how far the subject may leave centre, and a handful of state responses
(boost, drift, landing, collision). Write that, cleanly, with each constant named and justified.

Keep the public surface: class ChaseCamera implements System, init/lateUpdate/resize/addShake,
and window.__camMode. Your advantage is that a simple rig is tunable and predictable; your risk
is losing a behaviour the old one had, so read it carefully first and enumerate what you drop.`,
  },
  {
    key: 'framing',
    label: 'cam:framing-first',
    brief: `**PHILOSOPHY: SOLVE FOR THE FRAME, NOT THE POSE.**

Every other approach positions the camera and hopes the picture is good. Invert it: decide where
the kart and the road ahead should SIT ON SCREEN, then solve the camera pose that puts them
there.

The measured failure is fundamentally a framing failure — the subject is off screen on average
during ordinary driving. A framing-first rig makes that impossible by construction: the kart's
screen position is an explicit, clamped input, not an emergent result.

Practically: pick a desired screen point for the kart (slightly below centre, shifted opposite
the turn so the player sees into the corner), pick how much road ahead must be visible, and
drive the pose from those with a damped solver. Clamp the screen offset hard. This should also
naturally fix the swing, because the frame cannot move faster than the subject does within it.

Keep the five required behaviours — a framing solver still needs to roll with banking and slide
during a drift. Your advantage is that the numbers the judge scores are framing numbers; your
risk is a camera that feels mechanical or laggy, so watch peak lag and settle time.`,
  },
]

phase('Candidates')

const results = await parallel(
  CANDIDATES.map((c) => () =>
    agent(
      `You are rebuilding the chase camera for a Three.js kart racing game at ${ROOT}.
Read ${ROOT}/ART_DIRECTION.md section 9 and ${ROOT}/src/game/Camera.ts in full first.

${c.brief}

${MEASURED}

${RULES}

Report: the full before/after probe output, what you changed and why, which of the five required
behaviours you verified and how, and anything you knowingly traded away.`,
      { label: c.label, phase: 'Candidates', isolation: 'worktree' },
    )
  )
)

phase('Judge')

const verdict = await agent(
  `You are judging three independent rebuilds of the chase camera for the kart racer at ${ROOT}.

Each candidate worked in its own git worktree and reported measured results from
\`tools/camera-probe.mjs\`. Their reports:

${CANDIDATES.map((c, i) => `## ${c.label}\n${results[i] || '(no report — treat as failed)'}`).join('\n\n')}

## Targets
    peak swing < 300 deg/s at every rate; p95 < 150; peak lag < 35 deg;
    peak off-centre < 0.60; mean off-centre < 0.20; frames past 35% off < 10%;
    settle < 0.45 s; peak-lag spread across 30/60/120Hz < 3 deg.

## How to judge
1. **Do not take the numbers on trust.** Each candidate's worktree still exists; find it
   (\`git worktree list\`), and re-run \`node tools/camera-probe.mjs\` in each one yourself. A
   candidate that cannot reproduce its own claimed numbers loses on that basis alone.
   Run them ONE AT A TIME — the probe binds port 5313.
2. **Check the rig is not merely rigid.** Every target above can be hit by welding the camera to
   the kart's facing, and that camera is dead. For each candidate verify, by capture and by
   reading the PNGs, that: the kart visibly slides across frame during a drift; the horizon rolls
   on the banked curve; boost changes the shot; the tunnel does not clip; the road ahead is
   readable into a corner. Capture with
   \`node tools/shot.mjs --only hero,drift,corner,boost --settle 3 --out shots/judge-<name>\`.
3. **Look at the frames.** Numbers rank; pictures decide. A rig that scores second but frames
   the game beautifully beats one that scores first and looks like a security camera.
4. Weigh maintainability last, but weigh it: report each candidate's final line count.

Return a clear winner, the numbers that justify it, and — importantly — any specific idea from a
LOSING candidate that should be grafted onto the winner. Name the winning worktree path exactly.`,
  { label: 'judge', phase: 'Judge' },
)

phase('Land')

const landed = await agent(
  `cd ${ROOT}. A judge has picked a winning chase-camera rebuild from three candidates that were
developed in isolated git worktrees.

## Judge's verdict
${verdict || '(no verdict — read the candidate reports and pick the best yourself, on measured numbers)'}

## Candidate reports
${CANDIDATES.map((c, i) => `### ${c.label}\n${(results[i] || '(failed)').slice(0, 3000)}`).join('\n\n')}

Do this:
1. Bring the winning \`src/game/Camera.ts\` (plus any helper files it added) into the MAIN tree.
   Use the worktree path the judge named. Copy the files; do not merge branches.
2. Graft in any specific improvement the judge flagged from a losing candidate, if it is
   genuinely separable and you can verify it did not degrade the numbers.
3. npx tsc --noEmit — must be clean.
4. **node tools/camera-probe.mjs — report the full output.** It must beat the baseline
   (peak swing 1013 deg/s, peak lag 157.5 deg, mean off-centre 0.729/1.208, 79.5%/65.4% past
   35%, rate spread 26.8 deg) on every metric, and ideally hit the targets.
5. Re-verify nothing else broke — these all have to stay green:
     node tools/shot.mjs --out shots/r13 --settle 3 --w 1920 --h 1080   (zero console errors)
     node tools/mobile-soak.mjs 30      (PASS)
     node tools/hitch-check.mjs 30      (NOT CONFIRMED = zero late compiles)
     node tools/ai-health.mjs           (8/8 racing, near-zero off-track)
     node tools/touch-test.mjs          (PASS)
     node tools/context-loss-test.mjs   (PASS)
6. Read every PNG in shots/r13 and confirm the game still frames well — especially drift.png
   (kart sliding across frame), corner.png (tunnel, no clipping) and boost.png.
7. Clean up: \`git worktree remove\` the candidate worktrees once the winner is landed.

Report the final probe numbers against the baseline, the gate results, and your own honest read
of whether the camera now looks and feels better in the captured frames.`,
  { label: 'land', phase: 'Land' },
)

return {
  candidates: CANDIDATES.map((c, i) => ({ name: c.label, ok: !!results[i] })),
  verdict,
  landed,
}
