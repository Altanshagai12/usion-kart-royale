export const meta = {
  name: 'kart-critique-round',
  description: 'Capture the game, tear it apart from six hostile angles, then dispatch fixes',
  phases: [
    { title: 'Capture', detail: 'render the shot set headlessly' },
    { title: 'Critique', detail: 'six art directors, each hunting a different class of failure' },
    { title: 'Fix', detail: 'one specialist per subsystem, working only from confirmed findings' },
    { title: 'Verify', detail: 're-capture and confirm the frame improved' },
  ],
}

const ROOT = '/Users/ryan/dev/personal/kart-game'
const ROUND = (args && args.round) || 1
const OUT = `shots/r${ROUND}`

phase('Capture')

await agent(
  `cd ${ROOT} and capture the full shot set for critique round ${ROUND}:

    node tools/shot.mjs --out ${OUT} --settle 3 --w 1920 --h 1080

The harness boots vite itself, drives the game to ten scripted vantage points and writes PNGs
plus ${OUT}/report.json (console errors, fps).

If it exits non-zero or any console error is reported, FIX THE ERRORS in the source, then
re-run, and repeat until the capture is clean. A capture with runtime errors is worthless —
the critics would be judging a broken frame.

Then Read every PNG it produced and confirm each one is a real rendered game frame (not black,
not blank, not the camera inside geometry, not all ten shots identical). If a shot is broken,
fix the cause — either in tools/shot.mjs if the harness is positioning things wrongly, or in
the game if the game is wrong.

Report: the capture path, the fps figure, any errors you fixed, and a one-line factual
description of what each of the ten frames actually shows.`,
  { label: 'capture', phase: 'Capture' }
)

const CRITIC_SCHEMA = {
  type: 'object',
  required: ['score', 'verdict', 'findings'],
  properties: {
    score: { type: 'number', description: '0-100. 90+ means genuinely indistinguishable from shipped AAA work.' },
    verdict: { type: 'string', description: 'Two sentences. Blunt.' },
    worstFrame: { type: 'string', description: 'Filename of the weakest shot and why.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'frame', 'problem', 'fix', 'owner'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          frame: { type: 'string', description: 'which shot(s) show it' },
          problem: { type: 'string', description: 'what is wrong, concretely, as seen in the image' },
          fix: { type: 'string', description: 'the specific technical change that would fix it' },
          owner: {
            type: 'string',
            enum: ['render', 'sky', 'materials', 'track', 'scenery', 'kartmodel', 'physics', 'vfx', 'ui', 'gameplay', 'camera'],
          },
        },
      },
    },
  },
}

const CRITIC_BASE = `You are a hostile senior art director reviewing screenshots from a Three.js kart racing game
that is trying to match the visual quality of a shipped Nintendo Mario Kart title.

The shots are in ${ROOT}/${OUT}/ — READ EVERY PNG IN THAT DIRECTORY with the Read tool. You are
judging the actual pixels, not the source code. You may read source afterwards to work out WHY
something looks wrong and to make your fix suggestions specific and actionable, but your
findings must originate from what you can see in the images.

Also read ${ROOT}/ART_DIRECTION.md — section 9 is the formal rubric.

## How to judge
Hold the frames to the standard of a shipped, retail, first-party console racing game. Not
"good for a web demo". Not "impressive for procedural". The comparison class is Mario Kart 8
Deluxe and Mario Kart World running on real hardware: images with authored lighting, dense
coherent worlds, immaculate material response and total visual confidence.

Be harsh. Generous scoring here produces a worse game. The specific failure mode to avoid is
finding three cosmetic nits and declaring victory while an obvious structural problem — a flat
lighting wash, an empty horizon, plastic-looking materials — sits in the middle of the frame.
Lead with the biggest problem in the image, not the easiest one to describe.

Scoring calibration, apply it strictly:
  0-40   reads as a programmer-art prototype
  40-60  a competent hobby project; obviously not commercial
  60-75  a good indie game; still clearly not first-party
  75-88  near-professional, but a trained eye spots the tells immediately
  88-95  genuinely shipped-AAA quality
  95+    best-in-class

Almost nothing deserves 88+ on an early round. If you are inclined to give 85, look harder —
you are probably missing something.

Every finding must name the specific technical fix and the owning subsystem, because your
output is dispatched directly to the engineer who owns that module. Vague findings ("lighting
could be better") are useless and will be discarded. Say what to change.

## YOUR SPECIFIC LENS
`

const CRITICS = [
  {
    key: 'lighting',
    label: 'critic:lighting',
    lens: `LIGHTING, ATMOSPHERE AND EXPOSURE. Is there real key/fill/rim separation, or a flat ambient
wash? Do shadows read as directional golden-hour shadows with warm penumbrae, or as a generic
grey darkening? Is there warm/cool contrast between lit and shadowed surfaces? Does the sky band
or dither cleanly? Does the fog match the sky at the horizon or is there a seam? Is there aerial
perspective separating fore/mid/background? Is anything blown out or crushed to pure black? Do
shadows actually land where the sun direction says they should? Is there bounce light, or do
shadowed areas look dead? Does the env map appear to be lighting the PBR materials at all?
Judge whether the frame's light tells a story or merely illuminates.`,
  },
  {
    key: 'materials',
    label: 'critic:materials',
    lens: `MATERIALS AND SURFACE RESPONSE. Zoom in mentally on every surface. Does roughness vary
spatially or is everything uniformly matte/uniformly shiny? Is there visible UV tiling repeat?
Are normal maps present and doing real work, or are surfaces flat? Does metal look like metal
(env reflection, sharp highlight) and paint look like lacquered paint (clearcoat, dual-lobe
highlight)? Is the tarmac aggregate visible at close range? Do materials hold up at BOTH the
close-up shot and the wide shot? Count the visibly distinct surface responses in each frame —
the bible demands at least five. Call out anything that reads as untextured MeshStandardMaterial
with a flat colour, which is the project's stated automatic fail.`,
  },
  {
    key: 'composition',
    label: 'critic:composition',
    lens: `COMPOSITION, SILHOUETTE AND WORLD DENSITY. Squint at each frame: does it read at thumbnail
size? Is there a clear focal point? Is the horizon empty or does the world continue convincingly
into the distance? Is there foreground/midground/background layering, or does everything sit on
one plane? Is the scene dense enough to feel like a PLACE — a real coastal circuit with a
village, a harbour, crowds, foliage — or does it look like a road in a void with a few props
scattered on it? Are there dead zones of empty ground? Does the track's shape read clearly so
the player can anticipate the next corner? Is the scenery placed with intent or scattered
randomly? Compare against how densely a Nintendo course is dressed — they never leave a frame
empty.`,
  },
  {
    key: 'craft',
    label: 'critic:craft',
    lens: `TECHNICAL CRAFT AND AMATEUR TELLS. Hunt specifically for: aliasing and crawl on thin
geometry, z-fighting, objects floating with no contact shadow or AO, hard unchamfered 90-degree
edges that catch no specular, geometry intersecting wrongly, shadow acne or peter-panning,
shadow map swimming, low-poly silhouettes on curved forms, LOD popping, texture stretching on
slopes, seams where meshes meet, particles slicing through the ground (no soft-particle depth
fade), banding in gradients, and blown-out additive effects stacking to white. These are the
details that separate "shipped" from "student project". Also assess the kart itself as a hero
asset in the closeup frame — is it a believable authored object or a box with cylinders?`,
  },
  {
    key: 'game',
    label: 'critic:game-feel',
    lens: `GAME FEEL, EFFECTS AND READABILITY. Do the frames look like something is HAPPENING? Is the
sense of speed conveyed visually in the boost frame (speed lines, motion blur, FOV, effects) or
does a 32 m/s frame look identical to a stationary one? Are the drift sparks unmistakable and
tier-coloured? Is there tyre smoke, dust, skid marks, exhaust flame? Do effects sit in the
scene's lighting or glow flatly on top of it? Is the camera framing dynamic — does the kart
slide across the frame in the drift shot, does the banked curve tilt the horizon? Is the scene
readable as gameplay: can you tell where the track goes, where your rivals are, what state
you're in? Judge the sheer ENERGY of the frames against a Mario Kart screenshot, which is always
bursting with motion and event.`,
  },
  {
    key: 'ui',
    label: 'critic:ui',
    lens: `HUD, TYPOGRAPHY AND PRESENTATION. Is a HUD present and complete (lap, position, timer,
item, speedometer, minimap)? Does the typography look designed — deliberate weights, sizes,
letter-spacing, tabular numerals — or does it look like default browser text? Is there layered
depth via shadow/gradient/outline, and does every element survive against a bright sky? Is the
minimap the true track shape and does it read instantly? Is the layout balanced, with proper
margins, or does it crowd the edges? Do the elements feel like one designed system or a
collection of separately-invented widgets? Compare directly against the confidence and polish of
a first-party console racing HUD. Note: you are judging static frames, so judge what's
judgeable — layout, hierarchy, type, colour, iconography, craft.`,
  },
]

const reviews = await parallel(
  CRITICS.map((c) => () =>
    agent(CRITIC_BASE + c.lens, { label: c.label, phase: 'Critique', schema: CRITIC_SCHEMA })
  )
)

const ok = reviews.filter(Boolean)
const all = ok.flatMap((r, i) => (r.findings || []).map((f) => ({ ...f, critic: CRITICS[i].key })))
const scores = ok.map((r, i) => `${CRITICS[i].key}: ${r.score}`)
const avg = ok.length ? Math.round(ok.reduce((s, r) => s + (r.score || 0), 0) / ok.length) : 0

log(`round ${ROUND} scores — ${scores.join('  ')}  |  mean ${avg}`)
log(`${all.length} findings (${all.filter((f) => f.severity === 'blocker').length} blockers, ${all.filter((f) => f.severity === 'major').length} major)`)

phase('Fix')

// Route findings to the subsystem that owns them. An owner with no findings is
// not dispatched at all — idle agents produce churn, not improvement.
const OWNER_FILES = {
  render: 'src/render/Renderer.ts, src/render/PostFX.ts',
  sky: 'src/render/Sky.ts, src/render/Atmosphere.ts',
  materials: 'src/render/Materials.ts, src/render/Textures.ts, src/render/Noise.ts',
  track: 'src/world/Track.ts, src/world/TrackLayout.ts, src/world/TrackGeometry.ts',
  scenery: 'src/world/Scenery.ts, src/world/Props.ts, src/world/Water.ts, src/world/Foliage.ts',
  kartmodel: 'src/kart/KartModel.ts, src/kart/Driver.ts, src/kart/Liveries.ts',
  physics: 'src/kart/Kart.ts, src/kart/Suspension.ts, src/kart/Tyre.ts',
  vfx: 'src/fx/Effects.ts, src/fx/Particles.ts, src/fx/Decals.ts, src/fx/Trails.ts',
  ui: 'src/ui/HUD.ts, src/ui/Minimap.ts, src/ui/Menus.ts, src/ui/ui.css',
  gameplay: 'src/game/Race.ts, src/game/AI.ts, src/game/Items.ts, src/game/Projectiles.ts',
  camera: 'src/game/Camera.ts',
}

const byOwner = {}
for (const f of all) {
  const o = OWNER_FILES[f.owner] ? f.owner : 'render'
  ;(byOwner[o] ||= []).push(f)
}

const order = { blocker: 0, major: 1, minor: 2 }
const owners = Object.keys(byOwner).sort(
  (a, b) => byOwner[b].filter((f) => f.severity === 'blocker').length - byOwner[a].filter((f) => f.severity === 'blocker').length
)

log(`dispatching to ${owners.length} owners: ${owners.join(', ')}`)

const fixes = await parallel(
  owners.map((owner) => () => {
    const list = byOwner[owner].sort((a, b) => order[a.severity] - order[b.severity])
    return agent(
      `You own the **${owner}** subsystem of the Three.js kart racing game at ${ROOT}.
Your files: ${OWNER_FILES[owner]}

Six art directors just reviewed round-${ROUND} screenshots (in ${ROOT}/${OUT}/) against a
shipped-Mario-Kart standard. These are the findings assigned to YOU, worst first:

${list.map((f, i) => `${i + 1}. [${f.severity.toUpperCase()}] (seen in: ${f.frame})
   PROBLEM: ${f.problem}
   SUGGESTED FIX: ${f.fix}`).join('\n\n')}

## What to do
1. LOOK AT THE EVIDENCE FIRST. Read the relevant PNGs in ${ROOT}/${OUT}/ yourself so you are
   fixing what is actually in the image, not what the description sounds like. If you believe a
   finding is wrong — you looked and the problem is not there, or the suggested fix would make
   it worse — do not implement it. Say so in your report with your reasoning. You are the
   expert on your subsystem; the critics are judging pixels and may misattribute a cause.
2. Fix every finding you agree with, blockers first. Go beyond the literal suggestion where the
   real fix is deeper — the critics describe symptoms, and treating a symptom while the cause
   remains means it comes back next round.
3. Read ${ROOT}/ART_DIRECTION.md and stay inside it. Do not drift the art direction to dodge a
   note.
4. Stay in your own files. Never edit src/types.ts. If a fix genuinely requires another
   subsystem to change, do not reach into their file — describe it in your report and it will
   be routed next round.
5. Verify your work compiles:  cd ${ROOT} && npx tsc --noEmit 2>&1 | grep -E '(${OWNER_FILES[owner].split(', ').join('|')})'
   Do NOT run the dev server or tools/shot.mjs — other agents are running in parallel and the
   port is shared.
6. Do not regress performance to win a beauty note. The budget in section 8 still holds.

Report: what you changed and why, what you rejected and why, and anything you need from
another subsystem.`,
      { label: `fix:${owner}`, phase: 'Fix' }
    )
  })
)

phase('Verify')

const verify = await agent(
  `cd ${ROOT}. ${owners.length} specialists just applied fixes to the kart racing game in parallel.

1. npx tsc --noEmit — fix every error. Parallel edits produce cross-module breakage; that is
   your job. Fix seams, do not delete features.
2. node tools/shot.mjs --out shots/r${ROUND}-verify --settle 3 --w 1920 --h 1080
   Iterate until it exits clean with zero console errors.
3. Read the new PNGs and compare them against the previous round in ${ROOT}/${OUT}/.
   State plainly, per frame, whether it improved, stayed the same, or REGRESSED. Regressions
   matter more than improvements — a fix that broke something else must be caught here.
4. If anything regressed badly, fix it.

Report honestly. Do not claim improvement you cannot see in the images. Include the fps figure
and confirm the frame is still within the performance budget.`,
  { label: 'verify', phase: 'Verify' }
)

return {
  round: ROUND,
  scores: Object.fromEntries(ok.map((r, i) => [CRITICS[i].key, r.score])),
  mean: avg,
  verdicts: Object.fromEntries(ok.map((r, i) => [CRITICS[i].key, r.verdict])),
  blockers: all.filter((f) => f.severity === 'blocker').length,
  major: all.filter((f) => f.severity === 'major').length,
  minor: all.filter((f) => f.severity === 'minor').length,
  dispatched: owners,
  verify,
}
