export const meta = {
  name: 'kart-drift-boost',
  description: 'Make the drift-to-boost loop the game: feel, readability, sound, payoff — plus an automated player and the key light',
  phases: [
    { title: 'Build', detail: 'six specialists: feel, vfx, audio, hud, autoplayer, key light' },
    { title: 'Judge', detail: 'is the loop actually rewarding? measured, not asserted' },
    { title: 'Land', detail: 'integrate and hold every existing gate' },
  ],
}

const ROOT = '/Users/ryan/dev/personal/kart-game'

const WHY = `## WHY THIS ROUND EXISTS

Two independent sources converged on the same conclusion about this game.

A player, publicly:
> "For a kart racer the whole game lives in the drift into boost loop. Make a risky line pay off
> with a boost that feels earned and people will rerun the same track just to nail it cleaner.
> FEEL FIRST, more tracks later."

And the internal hostile-critic panel, which scored game-feel lowest or joint-lowest in every
round:
> "a 120 km/h boost frame with no speed lines, no smear and no FOV change, and a tier-2 drift
> whose sparks read as dust motes, are not polish problems; THEY ARE THE FEATURE BEING ABSENT
> FROM THE SCREEN."

A stranger and an adversarial reviewer reached that from opposite directions. It is the strongest
signal this project has had. Full analysis in ${ROOT}/FEEDBACK.md — read it.

**The drift → mini-turbo → boost loop IS the product.** It outranks lighting, more tracks, more
items, and everything else. This round makes it the best thing in the game.

## THE TEST THAT MATTERS

The loop is only real if a greedy line PAYS. So the headline gate for this round is:

    Is a lap driven with drifts measurably FASTER than the same lap driven without them?

If drifting is not faster, none of the feel work matters — the player will learn to stop doing
it. If it is *too* much faster, the game is a drift-spam simulator. The target is a clear,
earned advantage: a competent drifting lap should beat a clean non-drifting lap by a margin a
player can feel, and holding a higher tier should beat holding a lower one.
`

const RULES = `## Rules
- Stay in YOUR FILES. Never edit src/types.ts.
- Do NOT run tools/shot.mjs or the dev server — agents run in parallel and ports are shared.
  You MAY write your own puppeteer script in the scratchpad on a UNIQUE port in 5320-5390, using
  the startVite helper from ${ROOT}/tools/vite-server.mjs. Note it now REFUSES to adopt a server
  serving a different tree, which is deliberate — a stale sibling server once silently made a
  probe measure the wrong checkout.
- Drive the player through \`Race.driveOverride\`. Calling \`Kart.step\` directly double-integrates
  against the race director and produces nonsense.
- Verify with: cd ${ROOT} && npx tsc --noEmit
- Keep the budgets: ~200 draw calls typical, mobile texture memory under 80MB, zero late shader
  compiles, no per-frame allocation in hot paths.
- Everything is procedural. No asset files, no sample files.

YOUR JOB:
`

const JOBS = [
  {
    key: 'feel',
    label: 'drift:feel-and-payoff',
    files: 'src/kart/Kart.ts, src/kart/Tyre.ts, src/kart/Suspension.ts',
    brief: `**OWN THE MECHANIC. Make drifting risky, controllable, and worth it.**

You own whether the loop is a GAME. The other five specialists make it legible, audible and
visible; none of that matters if the underlying mechanic is not rewarding.

1. **Measure the headline question first, before changing anything.** Write a probe that drives
   the same corner twice — once clean, once drifting — and compares exit speed and section time.
   Do it for several corners. Report the numbers. If drifting is currently SLOWER, that is the
   single most important finding in this round and everything else follows from fixing it.
2. **Entry should feel committed.** Hopping into a drift is a decision the player makes going
   into a corner, and it should cost something if they misjudge it — a wider line, a scrubbed
   entry — while being reliable to initiate. It must not be twitchy to enter by accident, and it
   must not be finicky to enter on purpose.
3. **Holding must be controllable.** The player steers to modulate the slide angle. Too little
   authority and it is a cutscene; too much and it is a spin. A competent player should be able
   to hold a tier-3 charge through a long corner; the previous round measured this going from
   0/6 corners to 6/6, so verify it still holds from the PLAYER's seat at player speeds.
4. **Release must pay.** The boost should feel like a release of stored energy: a real speed
   ceiling increase plus acceleration, scaled by tier, long enough to matter into the next
   straight. Tune so tier 3 is meaningfully better than tier 1 — the whole point of holding
   longer.
5. **Risk must be real.** Overcooking it should punish: running wide, losing the line, or
   spinning. The bible's off-track penalties exist; make sure a blown drift actually meets them.

Report before/after numbers for: drift-vs-clean section times per corner, exit speed by tier,
time to reach each tier, entry success rate, and the tier-3 hold rate over a real corner.`,
  },
  {
    key: 'vfx',
    label: 'drift:visual-readability',
    files: 'src/fx/Effects.ts, src/fx/Particles.ts, src/fx/Trails.ts, src/render/PostFX.ts',
    brief: `**MAKE THE LOOP UNMISTAKABLE ON SCREEN.**

The critic's line is your brief: the feature is currently ABSENT FROM THE SCREEN.

1. **Tier must be readable at a glance, without the HUD.** Blue #4fc3ff, orange #ff9d2e, purple
   #c05cff. Not "a few coloured dots" — a genuine escalation the player feels building. Each
   tier transition needs a distinct event: a flash, a burst, a change in density and character.
   Someone watching across the room should know which tier is charged.
2. **The release must be an EVENT.** Right now boost is reported as barely visible. It needs the
   full stack, together and timed: flame from both exhausts, a shockwave ring on activation,
   speed lines, radial smear on the world, FOV punch, chromatic ramp. The player's kart is
   deliberately held OUT of motion blur — the WORLD carries the speed. Do not undo that.
3. **Sell the slide itself**: tyre smoke that builds with slip, skid decals that persist, grit
   thrown from the contact patch, a ground glow under the sparks at higher tiers.
4. **Energy budget.** Explicitly test tier-3 drift + boost + tunnel exit stacked and confirm the
   frame does not clip to white. Previous rounds oscillated between "no speed lines at all" and
   "a white starburst that destroyed the tunnel frame". Find the middle and verify BOTH ends: a
   55 km/h frame must look calm, a 120 km/h boost frame must look violent.
5. Scale by ctx.settings.particleDensity; pool everything; zero per-frame allocation.`,
  },
  {
    key: 'audio',
    label: 'drift:audio-payoff',
    files: 'src/audio/Audio.ts, src/audio/Synth.ts, src/audio/Music.ts',
    brief: `**SOUND IS HALF OF "FEELS EARNED", AND IT HAS BEEN NEGLECTED ALL PROJECT.**

No critic round has ever scored audio — the panel judges still frames — so this subsystem has
had no feedback at all. Everything is synthesised with the Web Audio API; there are no samples.

1. **The charge is a rising tension.** Each mini-turbo tier should have its own tone, rising in
   pitch and intensity as the charge builds, so a player can hear which tier they are on with
   their eyes on the road. This is the single highest-value audio change in the game: it turns
   the drift from a visual mechanic into a felt one.
2. **The release is the payoff.** A satisfying pop/whoosh scaled by tier, ducking the engine
   briefly so it punches through, then the engine surging back under load.
3. **The slide itself**: tyre squeal pitched by actual slip angle, surface-dependent, rising and
   falling with how hard the player is working the tyres. It should reward finesse audibly.
4. **The engine must respond to load**, not just speed — different timbre accelerating vs
   coasting, an overrun burble off-throttle, a real shift structure. A player should hear the
   boost in the engine, not only in the whoosh.
5. **Mix discipline.** Master limiter, no clipping when everything fires at once, and the tier
   tones must cut through the engine and the music. Honour ctx.settings.masterVolume.
6. Audio is blocked until a user gesture — the game must still run silently and error-free when
   it is never unlocked, because the capture harness never gestures. Guard every path.

Verify by capturing and ANALYSING actual audio: render the graph to an OfflineAudioContext,
measure that the tier tones are distinguishable in pitch/level, and report those numbers.`,
  },
  {
    key: 'hud',
    label: 'drift:hud-feedback',
    files: 'src/ui/HUD.ts, src/ui/ui.css',
    brief: `**TELL THE PLAYER WHERE THEY ARE IN THE LOOP — WITHOUT THEM HAVING TO LOOK.**

The HUD is now one coherent system and scores reasonably; do not restyle it. Add exactly what
the loop needs and nothing more.

1. **A drift charge indicator** that reads peripherally: the player's eyes are on the corner,
   not the corner of the screen. Tier-coloured, showing progress toward the NEXT tier so the
   decision "hold or release?" is informed. Consider a screen-edge treatment over a widget —
   peripheral vision detects motion and colour, not shape.
2. **The tier transition should be felt**, not just displayed: a brief punch, a colour wash, a
   flash timed exactly with the VFX and audio so the three land as one event.
3. **Reward the release.** A boost readout, a speed surge on the speedometer, and — the thing
   that makes people rerun a track — some acknowledgement that THIS drift was good: a chain
   counter, a "PERFECT" style callout at tier 3, or a section-time delta.
4. Do not add clutter. Every element must survive against a blown-out golden-hour sky and must
   not collide at 1280x720, 1920x1080 or 2560x1440. Keep the html[data-touch] overrides in
   src/core/TouchControls.ts consistent if you move anything.`,
  },
  {
    key: 'autoplayer',
    label: 'gate:automated-player',
    files: 'tools/autoplay.mjs (new), tools/drift-bench.mjs (new)',
    brief: `**BUILD THE ORACLE THE PROJECT HAS BEEN MISSING.**

The sharpest public criticism of this project was: *"The prompt dies on verification. A /loop
needs an oracle... Nobody's playing the game."* It is correct. Every gameplay bug in this
project — inverted steering, missing mobile controls, black frames, a pause menu that suspended
the race permanently — was found by a HUMAN playing. Six art directors scored three full rounds
and caught none of them, because they judge still frames.

Build the standing gate that fixes that. Two tools:

**tools/autoplay.mjs** — plays complete races and asserts on OUTCOMES, exiting non-zero on
failure so it can gate a workflow. It must check at minimum:
  - a full 3-lap race completes for all 8 karts, with a sane classification and finish times
  - lap times fall inside a plausible band (not 8 seconds, not 8 minutes)
  - no kart is ever stranded, stuck reversing, or lapped absurdly
  - no position/lap accounting errors; checkpoints cannot be cheated by cutting
  - every ItemKind fires, hits, expires and cleans up; projectiles do not leak
  - the state machine completes: countdown → racing → finished → results, plus pause/resume and
    restart, with no deadlock
  - no non-finite position, velocity or quaternion at any point
  - zero console errors across the whole race

**tools/drift-bench.mjs** — the headline measurement for this round:
  - drive a set of corners CLEAN and DRIFTING, compare section times and exit speeds
  - report time-to-tier for each mini-turbo tier, and the tier-3 hold rate
  - report the speed and duration delta the boost actually delivers, per tier
  - **exit non-zero if drifting is not faster than not drifting** — that is the gate

Both must be robust: unique ports, deterministic where possible, clear output, and honest
failure messages that say what broke rather than just failing. Follow the house style of the
existing harnesses in tools/ — read a couple first, especially mobile-soak.mjs, and note the
comment discipline about instruments that lie. TWO harnesses in this project have produced
confident false readings; assume yours can too, and validate it against ground truth before
trusting it.`,
  },
  {
    key: 'light',
    label: 'fix:key-light-separation',
    files: 'src/render/Sky.ts, src/render/Atmosphere.ts',
    brief: `**THE LARGEST REMAINING VISUAL GAP, AND IT IS ONE NUMBER.**

The lighting critic has scored lowest or joint-lowest in every round (48, 61, 56, 54) and gave a
measurable diagnosis rather than an impression:

> "on the tarmac the unshadowed fill lights are roughly as strong as the 14-degree sun, so lit
> and shadowed road differ by about ONE STOP and nothing in frame reads as sunlit versus shaded"
> "there is no rim, no warm/cool split, no sun disc, no readable key direction on the karts"

One stop of separation is why every round has reported a flat ambient wash no matter how good
the sky looks. It is also why the effects never look like they sit IN the scene.

1. **Measure the current ratio first.** Sum the irradiance reaching a flat upward-facing surface
   from the key (DirectionalLight) versus everything else — hemisphere/ambient, the LightProbe
   or SH from the PMREM env map, and any fill or bounce. Write the numbers in your report.
2. **Get to 3-4 stops.** The key must dominate. Raise the sun and cut the DIFFUSE ambient — NOT
   the specular environment. A previous round crushed envMapIntensity globally to 0.40 and
   silently deleted every metal reflection and clearcoat lobe in the game; metals and clearcoat
   still need a full-strength specular environment. Those are separately controllable.
3. **Make the fill cool and directional** — sky-blue from above and the anti-sun side, a weak
   warm bounce from below. A shadowed surface should read COOL, not merely darker. That
   warm/cool split is what golden hour actually looks like.
4. **Add a visible sun disc** with limb softening and an atmospheric halo. There is none, which
   removes the clearest cue for where the key is.
5. **Ensure rim light happens** — check the env map is not near-uniform in luminance, which is
   the usual cause of flat PBR.
6. Re-check exposure afterwards; raising the key without touching exposure blows highlights, and
   blown whites have been flagged repeatedly.

This changes every frame in the game. Verify the tunnel interior still works and that nothing
goes black in shadow.`,
  },
]

phase('Build')

const built = await parallel(
  JOBS.map((j) => () =>
    agent(
      `Three.js kart racing game at ${ROOT}. Read ${ROOT}/ART_DIRECTION.md and ${ROOT}/src/types.ts first.\n\n` +
      WHY + '\n' + RULES + j.brief +
      `\n\n## YOUR FILES (the only files you may write)\n${j.files}\n\n` +
      `Report the measurements before and after, what you changed, and anything you could not fix.`,
      { label: j.label, phase: 'Build' },
    )
  )
)

phase('Judge')

const judged = await agent(
  `You are judging whether the drift → boost loop in the kart racer at ${ROOT} is now genuinely
REWARDING. Not whether it is implemented — whether a player would rerun a track to nail it
cleaner. Be hard to please.

Six specialists just worked in parallel:
${JOBS.map((j, i) => `### ${j.label}\n${(built[i] || '(no report — check whether its files changed)').slice(0, 2500)}`).join('\n\n')}

Do this, in order:
1. **Run the headline gate yourself**: \`node tools/drift-bench.mjs\` (built this round). Drifting
   MUST be faster than not drifting. Report the actual margins per corner. If the tool does not
   exist or does not work, say so plainly and measure it yourself.
2. **Play it.** Run \`node tools/autoplay.mjs\` and confirm complete races work end to end.
3. **Look at it.** Capture and READ the frames:
   \`node tools/shot.mjs --out shots/r14 --settle 3 --w 1920 --h 1080\`
   Judge specifically: can you tell the drift tier from the image alone? Does the boost frame
   read as violently fast next to a cruising frame? Do lit and shadowed surfaces now differ by
   clearly more than one stop, with shadows reading COOL rather than just dark?
4. **Listen to it.** You cannot hear it, but you can measure it: check the audio specialist's
   OfflineAudioContext numbers, and verify yourself that the three tier tones are actually
   distinguishable in pitch and level.
5. **Score the loop out of 100** on this question alone: *would a player rerun this track to
   nail a cleaner lap?* Justify with the measured margins, the frames and the audio numbers.
   Under 70 means the loop is still not the game.

Return the score, the numbers behind it, and the single highest-value remaining change.`,
  { label: 'judge:is-it-fun', phase: 'Judge' },
)

phase('Land')

const landed = await agent(
  `cd ${ROOT}. Integrate the drift-to-boost round and hold every existing gate.

## Judge's verdict on whether the loop is rewarding
${judged || '(no verdict — evaluate it yourself)'}

## Specialist reports
${JOBS.map((j, i) => `### ${j.label}\n${(built[i] || '(failed)').slice(0, 1800)}`).join('\n\n')}

In order, reporting what you ACTUALLY observed:
1. npx tsc --noEmit — fix every error. Watch for backticks written inside template literals;
   that has broken this build twice.
2. **node tools/drift-bench.mjs** — drifting must be faster than not drifting. This is the
   round's headline gate. If it fails, fix it; that is the whole point of the round.
3. **node tools/autoplay.mjs** — complete races, no deadlocks, no NaN, zero console errors.
4. Every existing gate must stay green:
     node tools/camera-probe.mjs    (peak swing < 300 deg/s, peak lag < 35 deg, TRUE off-centre < 0.6)
     node tools/mobile-soak.mjs 45  (PASS — textures under 80MB)
     node tools/hitch-check.mjs 30  (NOT CONFIRMED = zero late compiles)
     node tools/ai-health.mjs       (8/8 racing, near-zero off-track)
     node tools/touch-test.mjs      (PASS)
     node tools/touch-lazy-test.mjs (PASS)
     node tools/context-loss-test.mjs (PASS)
     node tools/steer-test.mjs      (steer +1 moves POSITIVE along screen-right)
5. node tools/shot.mjs --out shots/r14 --settle 3 --w 1920 --h 1080 — zero console errors.
   Read every PNG. Confirm the lighting change did not break the tunnel, blow highlights, or
   crush shadows to black, and that drift.png and boost.png now clearly show their events.
6. Fix anything broken or regressed. Do not remove features to make a gate pass.

Finish with everything green. Report: the drift-vs-clean margins, the loop score, every gate
result, and your honest read on whether this round made the game more fun.`,
  { label: 'land', phase: 'Land' },
)

return { jobs: JOBS.map((j, i) => ({ name: j.label, ok: !!built[i] })), judged, landed }
