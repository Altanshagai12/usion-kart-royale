# Player & public feedback — Jul 27–29

Collected from two X threads. Kept because several of these are better signal
than anything the automated critic rounds produced, and because two of them
identify the same gap the internal scoring kept circling.

---

## 1. The single most useful piece of design feedback

> **@nikmlnkr:** "For a kart racer the whole game lives in the drift into boost
> loop. Make a risky line pay off with a boost that feels earned and people will
> rerun the same track just to nail it cleaner. **Feel first, more tracks later.**"

This is the highest-value item in the whole set, and it **converges with the
internal critique independently**. Game-feel scored lowest or joint-lowest in
every round, and the round-9 critic wrote:

> "a 120 km/h boost frame with no speed lines, no smear and no FOV change, and a
> tier-2 drift whose sparks read as dust motes, are not polish problems; they are
> the feature being absent from the screen"

A stranger on X and a hostile art director reached the same conclusion from
opposite directions. That is about as strong as evidence gets.

**Implication for planning:** the drift → mini-turbo → boost loop is the product.
It outranks lighting, more tracks, more items, and everything else currently
queued. Specifically:
- entering a drift must feel committed and slightly risky
- holding it must be legible — the player must *know* which tier they are on
  without reading the HUD
- release must pay off unmistakably: audio, flame, FOV, world smear, and a
  genuine lap-time advantage
- a greedy line must be measurably faster, so nailing it cleaner is worth rerunning

Corroborated by **@nickventuri:** *"gonna drift this until my browser crashes"* —
drift is already what people reach for. It just does not pay off yet.

---

## 2. The sharpest criticism, and it is correct

> **@SplitPostIO:** "One shot game demos are all one genre: procedural, no
> authored assets, geometry is the art direction. That's why they cohere. The
> prompt dies on verification. A /loop needs an oracle — 'Critic agent compares
> to COD' isn't one, it can't run the build. **Nobody's playing the game.**"

Three claims, assessed honestly:

| claim | verdict |
|---|---|
| procedural-only is why these cohere | **True.** No asset pipeline means no asset/code mismatch. It is also a real constraint on ceiling — see §4. |
| the loop lacks an oracle | **True as stated, but it was fixed.** The critics judge rendered PNGs from a real headless build, not code. That is a genuine oracle for *appearance*. |
| nobody's playing the game | **Devastatingly true, and the central lesson of this project.** |

Every single gameplay bug came from Ryan playing: inverted steering, missing
mobile controls, black frames, Enter doing nothing then doing too much, the
phone crash. Six art directors scored three full rounds and never mentioned one
of them. **Automated visual critique is structurally blind to everything a still
frame cannot show.**

**Implication for planning:** the next capability worth building is not another
critic — it is an *automated player*. Something that drives a full race and
asserts on outcomes: lap times within a band, no wall contacts above a
threshold, a drift attempt succeeding, an item connecting. Some of this exists
(`ai-health.mjs`, the bug-hunt agent) but it is not a standing gate.

---

## 3. Performance on ordinary hardware

> **@RandomAmer22077:** "You need a decent pc to play this!"

Consistent with the missing-world reports from Chromium testers (§5) and with
the mobile work already done (texture memory 217.7 MB → 34.1 MB, phones now get
Quality.Low). But nothing has been verified on a low-end discrete GPU or an
Intel iGPU.

**Implication:** the quality tiers exist but are only tested at the extremes —
a software rasteriser and an Apple M5. The middle is unmeasured.

---

## 4. Flattering, but needs an honest answer

> **@Dezoir360844:** "Why does it have better graphics than Mario Kart World?"
> **@stephenlearns:** "the most polished demo I have seen so far"

It does not have better graphics than Mario Kart World. Last full score was
**62/100** against that bar, from a panel explicitly calibrated so that 60–75
means "a good indie game; still clearly not first-party". The remaining gap is
mostly hand-authored art direction, which is exactly what the procedural
constraint rules out.

Worth answering honestly whenever it comes up — the project's credibility rests
on the numbers being real.

---

## 5. Open bug from the public

Several testers on Brave / Edge / Chrome report the HUD rendering correctly over
an empty world. Works on Ryan's Chrome and Safari, so it is GPU/driver, not
browser. `src/core/Diagnostics.ts` now catches this and prints a probable cause;
`__gl()` returns a copy-pasteable report including any shader that failed to
compile. **Waiting on one reporter to send that output.** Leading theory is an
Intel iGPU or older AMD driver rejecting a shader that Apple and NVIDIA accept.

---

## 6. Repeated asks (decisions for Ryan, not engineering)

- **Open source / share the code** — @sgates2011, @the_milesinfo, @secureurbag.
  @secureurbag's framing is the useful one: *"be cool to remix from a starting
  point without spending a load of opus credits initially."*
- **Cost and duration** — @secureurbag, @Lazo41749019. Real figures:
  ~27.6M subagent tokens, 114 subagents across 9 orchestrated waves, ~60.5k
  lines across 49 source files, 13 test harnesses, zero art assets.

---

## 7. Process observations worth keeping

> **@Trav_Roebuck:** "I'm trying to create a single room/garage 3D environment. I
> have literally given it photorealistic images of every angle, and it returns
> this shitshow."

Instructive contrast. This project supplied **no reference images at all** — it
had a written art bible (course layout, exact sun angle, palette hexes, material
standards) and generated everything procedurally. Photo references invite a
match-the-photo failure mode; a written spec that names *values* is checkable and
composable across parallel agents. Worth remembering as a technique.

> **@NigelHiggs7:** "Does anyone else find it deeply unsatisfying to generate a
> whole program/game that literally took zero effort on your part?"

Fair challenge, and the honest answer contradicts the premise: the human found
every gameplay bug in this project. The automated loop produced a good-looking
game that was unplayable in specific ways it could not perceive. That is not
zero effort — it is the effort moving to judgement and playtesting.

---

## Suggested priority order for next steps

1. **The drift → boost loop.** §1. Feel first. This is the game.
2. **A standing automated-player gate.** §2. Assert on outcomes across a full
   race, not on frames.
3. **Resolve the missing-world reports.** §5. Blocked on a `__gl()` dump.
4. **Verify the middle of the hardware range.** §3.
5. **Lighting key/fill separation.** Still the largest single visual gap —
   lit and shadowed surfaces differ by about one stop where they should differ
   by three or four. Highest-value *visual* item, but below the items above.
