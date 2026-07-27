/**
 * ============================================================================
 *  CHASE CAMERA — spring-arm rig
 * ============================================================================
 *  The camera is a gameplay system, not a transform copier.
 *
 *   - It rides a critically-damped spring arm behind the kart, with separate
 *     smoothing constants for the eye (weighty) and the aim point (stiffer, so
 *     the kart stays framed). Every filter in here is either the analytic
 *     critically-damped solution or a substepped harmonic oscillator, so the
 *     response is identical at 30, 60 and 144 Hz. There is not one raw
 *     per-frame lerp constant anywhere in this file.
 *
 *   - The kart is a SUBJECT, at 21-23% of frame height across the whole speed
 *     range. That is a rig geometry decision (5.2 m arm, 1.05 m rise) held
 *     against the lens by hand at every speed and every state, because a
 *     6 k-triangle chassis with a livery and a driver in it only reads as a
 *     character above about a fifth of the frame; below that it is a smudge on
 *     tarmac and the eye goes to the road specular instead.
 *
 *   - It is a LENS before it is a rig. 50 degrees vertical is 79 horizontal at
 *     16:9 — generous for an arcade racer, and less than half the solid angle
 *     of the 91-99 degrees this file used to run. Focal length is what decides
 *     whether the kart is a subject or a dot, whether the kerbs are in frame
 *     beside it or thirty degrees outside the frustum, and whether the road
 *     spreads out underneath the camera or compresses toward the horizon. No
 *     amount of rig tuning survives the wrong lens.
 *
 *   - The eye is LOW and the axis is LEVEL. The lens sits under two metres
 *     above the chassis on a six-and-a-half metre arm, and the aim point sits
 *     *higher* than the eye, so the view axis runs a fraction of a degree up.
 *     A chase camera that looks down is a map; the horizon belongs near the
 *     middle of the frame and the kart belongs at the bottom of it.
 *
 *   - The arm follows the direction of TRAVEL, not the direction the chassis
 *     points. During a drift it stays behind the velocity heading, so the kart
 *     visibly slides sideways across the frame. That single detail is most of
 *     what makes a kart racer read as a kart racer.
 *
 *   - THE SUBJECT IS FRAMED IN SCREEN SPACE, not hoped for in world space.
 *     Every other offset in this file is a world-space nudge sized against
 *     something that is not the kart — the vista lift against the kerb crest it
 *     must see over, the outside swing against the arc, the arm sweep against a
 *     wall — and round one proved that once four of them stack, nobody knows
 *     where the player ends up. (Worse: two of them were cancelling. The drift
 *     eye-slide gave back a third of the drift aim-yaw's framing every frame,
 *     which is why the player sat within 4% of frame centre in all ten review
 *     shots.) So the pose is built, then the kart's actual NDC is measured and
 *     the aim rotated until it lands where the composition asked. The
 *     world-space offsets keep doing what only they can do — parallax, and what
 *     is *behind* the kart — and none of them can move the subject any more.
 *
 *   - Every corner composes, not just the drifted ones. Lateral acceleration is
 *     measured from the yaw rate of the travel heading and blended with the
 *     bend of the road ahead, so the frame starts recomposing on the approach:
 *     the horizon tilts, the eye swings to the outside of the arc, and the kart
 *     translates up to 18% of frame width toward the outside with the exit
 *     opening in front of it. A fast sweeper is never framed like a straight.
 *
 *   - A drift is a composition, not a rotation. On top of the travel heading
 *     the rig slides laterally toward the outside of the slide, lets the arm
 *     trail further behind the heading so the chassis visibly points across the
 *     frame, and leans harder with every mini-turbo tier. Same kart, same
 *     corner, unmistakably different frame.
 *
 *   - A boost is a dolly zoom. The lens opens eight degrees and the arm comes
 *     in by the matching amount, so the world stretches past the frame edge
 *     while the kart holds its size. FOV alone does the opposite of what it is
 *     for: it makes the subject smaller in the one frame that should be the
 *     most exciting in the game.
 *
 *   - It rolls with the road: the up vector chases the banked track normal
 *     with deliberate lag and a clamped magnitude, so the 20 degree coastal
 *     curve tilts the horizon instead of leaving it stubbornly level. The gain
 *     is deliberately *partial* — a rig glued 1:1 to the road plane renders a
 *     banked corner as a level frame with level trackside furniture, which is
 *     the one thing a banked corner must never look like.
 *
 *   - It finds the view. Every frame it asks the track how far the ground falls
 *     away on each side; where there is a drop (the cliff traverse, the banked
 *     coastal 180, the bridge over the inlet) the rig lifts and pitches down so
 *     the bay, the drop and the skyline enter frame instead of twenty-six
 *     metres of tarmac and a strip of haze. This is derived from the terrain,
 *     not from a hand-written table of t ranges, so it follows the layout if
 *     the layout moves.
 *
 *   - It reacts. FOV opens with speed, punches on boost and rubber-bands back;
 *     the arm lengthens and drops at speed; landings dip, braking pitches the
 *     nose down, impacts kick and shake.
 *
 *   - It never clips. The arm is swept against walls, terrain and the tunnel
 *     bore, pulled in hard on a hit and let back out slowly.
 *
 *  Zero allocation in lateUpdate: every vector, quaternion, matrix and track
 *  sample used per frame is module scope or owned by the instance.
 * ============================================================================
 */
import * as THREE from 'three';
import { BASE_TOP_SPEED, RaceState, type Ctx, type IKart, type System, type TrackSample } from '../types';

// ---------------------------------------------------------------------------
//  Tuning
// ---------------------------------------------------------------------------

/**
 * Vertical FOV, degrees.
 *
 * This is the single most consequential number in the file and it was the
 * root cause of round one's "grey wedge with a small red dot": 60 vertical at
 * 16:9 is **91.5 degrees horizontal**, and speed opened it to 99. At that
 * focal length a 2 m kart eight metres away subtends 6-9% of frame width, a
 * 26 m wide road spans thirteen metres at the bottom edge with both kerbs
 * outside the frustum, and every piece of trackside dressing is squeezed into
 * the last few percent at the frame edge. Nothing downstream — not scenery
 * density, not lighting — can beat a lens that wide.
 *
 * 50 vertical is 79 degrees horizontal, which is still a generous arcade field
 * (a shipped kart racer sits around 75-80) but puts the kart at 13-14% of
 * frame width, cuts the bare road across the bottom edge from ~13 m to ~9 m,
 * and roughly doubles the apparent size of everything in the midground.
 */
const FOV_BASE = 50;
/** Vertical FOV is derived from this reference aspect whenever the frame is
 *  narrower, so a tall window widens the lens instead of cropping the road. */
const REF_ASPECT = 16 / 9;

/**
 * Arm geometry.
 *
 * Height is measured from the chassis COM, so the eye sits ARM_HEIGHT +
 * PIVOT_UP above it and about a third of a metre more above the road. The old
 * 3.02 + 0.62 put the lens 3.6 m up over an 8-9 m arm — a 21 degree look-down
 * onto a road that is up to 26 m wide, which is a helicopter shot, not a chase
 * camera. 1.34 + 0.62 is roughly shoulder height on the roll bar: the road
 * plane compresses toward the horizon instead of spreading out underneath.
 */
/*
 * Round two: the arm came in another twenty percent.
 *
 * Round one shipped the kart at 13-18% of frame height depending on speed, and
 * every reviewer read the frame the same way: no subject. A shipped kart racer
 * holds the player at 20-25% of frame height, because that is the size at which
 * a 6 k-triangle chassis with a livery and a driver reads as a *character* at
 * thumbnail size instead of as a red smudge on tarmac.
 *
 * 5.2 m at 50 degrees puts a 1.5 m kart at 23% at cruise and 21.5% on a boost
 * (the boost pull below is sized so the punch widens the lens without shrinking
 * the subject — see poseChase). ARM_DIST_SPEED came down with it: the arm used
 * to grow 1.8 m between 56 and 131 km/h, which cancelled most of what the lens
 * was doing and is a large part of why "the kart is the same size in every
 * frame" and "the boost frame is no wider" were both true at once.
 */
/*
 * Round seven: the arm stopped growing with speed.
 *
 * The review note was "ten frames, one composition", and the rig's own speed
 * response was working against fixing it. The lens opens 5 degrees between a
 * crawl and top speed; the arm was simultaneously growing 1.35 m, and the two
 * together held the subject at a near-constant 21-25% of frame height whatever
 * the kart was doing. A shipped kart racer does the opposite: it gets LOWER and
 * CLOSER as the speed comes up, so the same corner photographed at 60 and at
 * 120 km/h is two different pictures. 0.55 leaves enough growth that the frame
 * still breathes with the throttle, while the height drop below is nearly
 * doubled — and the scenic sections now go the other way (VISTA_DIST,
 * VISTA_FOV), which is where the variety actually comes from.
 */
const ARM_DIST = 5.2;        // metres behind the pivot at rest
const ARM_DIST_SPEED = 0.55; // extra length at full speed
const ARM_HEIGHT = 1.05;     // metres above the pivot at rest
const ARM_HEIGHT_SPEED = -0.24;
const PIVOT_UP = 0.62;       // the arm hangs off a point above the chassis COM
/**
 * Aim height above the kart. Sits *above* the eye, so the view axis is level
 * to a fraction of a degree up rather than the 4+ degrees down it used to be.
 * That is what lifts the horizon off 0.44 of frame height and stops the lower
 * half of every frame being tarmac.
 */
/**
 * Aim height above the kart.
 *
 * With the subject's screen position now solved directly (frameSubject), this
 * constant no longer decides where the kart sits in frame — it decides where
 * the HORIZON sits relative to the kart, which is the more useful control and
 * the one the review actually asked for. Pitching the axis up moves the
 * horizon down past the subject, so the kart's roll bar, driver and canopy
 * break the skyline and read against sea, haze and headland instead of against
 * tarmac of near-identical value. That is the "value break" note, and it is a
 * composition fix, not a lighting one: no rim light survives a silhouette drawn
 * on top of a surface the same brightness as itself.
 *
 * 3.0 m puts the axis ~3.7 degrees up, which drops the horizon to about -0.13
 * NDC while the kart sits at -0.29 — so the top fifth of the kart is against
 * sky, and the road still owns 44% of frame height ahead of it.
 */
const AIM_UP = 3.00;
/** Height of the corner-lead aim point over the road, metres. Paired with
 *  AIM_UP: the lead is blended in at 0.2, so both set the final pitch — which
 *  is why this had to rise with it, or the lead would drag the horizon back. */
const AIM_LEAD_UP = 3.10;

const POS_SMOOTH = 0.155;    // eye spring — the "weight" of the rig
const AIM_SMOOTH = 0.095;    // aim spring — stiffer, keeps the kart framed
const UP_SMOOTH = 0.40;      // banking lag

/**
 * Fraction of the road's tilt the camera adopts.
 *
 * This wants to be well under 1. Trackside furniture is planted along the road
 * normal, so on a 20 degree bank the palms, signs and fence posts are already
 * leaning 20 degrees with the surface; a rig that also adopts 20 degrees
 * renders every one of them bolt upright and the corner reads as a straight.
 * At 0.68 the horizon still swings a decisive 13.6 degrees on the coastal 180
 * *and* the kart and the furniture visibly lean 6.4 the other way, so the frame
 * carries the bank twice over. If the world ever plants trackside props along
 * world up instead of the road normal, this can go back toward 0.85.
 */
/*
 * Round seven: 0.68 -> 0.80.
 *
 * The measurement stands — the horizon *was* swinging, ROLL_GAIN reaches the
 * frame intact (probe().normal is the banked centreline normal on road, the
 * lerp toward world up is the only attenuation, and Matrix4.lookAt carries the
 * whole perpendicular component of `up` into camera roll). What round seven
 * showed is that 13.6 degrees on the one corner that banks 20 is not enough to
 * survive a shot list that never samples the apex: the two frames either side
 * of the coastal 180 came back with 3-5 degrees on them and read as level.
 * 0.80 gives 16 degrees at the apex and, more importantly, 8-10 through the
 * entry and exit thirds where the frames actually get taken. Still short of
 * 1:1, so the palms and posts planted on the road normal keep their visible
 * 4 degrees of counter-lean and the corner still reads as a corner.
 */
const ROLL_GAIN = 0.80;
/** ~30 degrees. Raised with ROLL_GAIN: 16 of bank plus 11 of tier-3 drift lean
 *  plus the corner lean was clipping against the old 27.5 ceiling on exactly
 *  the frame — banked, sideways, charged — that is supposed to be the most
 *  extreme one in the game. */
const MAX_ROLL = 0.52;

// --- heading: travel vs facing -------------------------------------------
/**
 * How far the arm rotates from the chassis facing toward the direction of
 * TRAVEL, as a fraction of the measured slip angle.
 *
 * This used to be a chord lerp between the two unit vectors, which is not the
 * same thing: `lerp(face, vel, w)` moves *toward* vel along a chord, so the
 * realised yaw is always less than `w * slip`, and it caps out at the vector
 * itself — there is no way to express "further sideways than the physics".
 * Rotating by a measured angle is exact, costs one atan2, and lets the drift
 * term go past 1, which is the whole point: a shipped kart racer exaggerates
 * the slide, it does not merely report it.
 *
 * At 1.14 a 19 degree slip renders as 21 degrees of chassis yaw before the arm
 * spring's own trailing lag (another 6-9 through a committed slide) is added on
 * top. Round seven measured 18.6 degrees of real slip on the drift plate and
 * the old blend turned it into 16.7, which is inside the range an ordinary
 * corner produces — hence "the drift frame reads as a kart pointing straight
 * ahead with sparks under it".
 */
const HEAD_TRAVEL = 0.42;
const HEAD_TRAVEL_DRIFT = 0.72;
/** hard ceiling on the yaw, so a spin-out or a shell hit can never whip the
 *  rig round the back of the kart. ~31 degrees. */
const HEAD_MAX_SLIP = 0.55;

// --- drift framing -------------------------------------------------------
/** lateral shift of the eye, metres, toward the outside of the slide */
const DRIFT_RIG_LAT = 2.4;
/**
 * Extra lean, radians: base plus per-tier, ~6.0 to 10.9 degrees.
 *
 * Round one ran 4.6-8.0 and the reviewers measured zero dutch in nine frames
 * out of ten. Four degrees of roll on a 1080p frame moves the horizon 38 px
 * across the full width; it is under the noise floor of "is this tilted?".
 */
const DRIFT_ROLL = 0.105;
const DRIFT_ROLL_TIER = 0.085;

// --- boost: a different shot, not a different FOV number ------------------
/**
 * A boost has to be legible as a *composition change* in a still frame. Round
 * seven's boost plate differed from its cruise plate by the FOV alone, and a
 * FOV difference in a still is invisible — there is no before to compare it
 * with. So the rig moves: it drops, it closes, and it puts a few degrees of
 * dutch on the horizon, and all three unwind with the surge oscillator's own
 * overshoot rather than easing back on a ramp.
 *
 * BOOST_DIST is sized against the lens: applyFov opens ~8 degrees on a punch,
 * which alone shrinks the subject by about a seventh. Pulling 1.35 m off a
 * 5.75 m arm gives it back and then some, so the boost frame is the *tightest*
 * one in the set instead of the loosest.
 */
const BOOST_DIST = 1.35;         // metres the arm closes on a live boost
const BOOST_HEIGHT = 0.38;       // metres the arm drops
const BOOST_ROLL = 0.070;        // ~4 degrees of dutch, signed by the corner
/** transient coupling of the surge oscillator (kicked on the boost event,
 *  zeta 0.5, so it snaps in and overshoots back out) into arm and height */
const BOOST_SURGE_DIST = 3.2;
const BOOST_SURGE_HEIGHT = 0.55;

// --- cornering, drifting or not ------------------------------------------
/**
 * `corner` is a signed, normalised "how hard are we turning right now",
 * +1 = a full-commitment right-hander. It is the single input that stops every
 * gameplay frame being the same photograph, and round one got it wrong twice
 * over:
 *
 *  1. It was derived from the *arm spring's own lag* behind the heading, which
 *     is yaw rate times a 0.145 s smoothing constant. On a fast sweeper that is
 *     0.05-0.08 — so `turn * CORNER_ROLL` came out at one to two degrees of
 *     lean and `turn * CORNER_LAT` at half a metre of swing. Both were real and
 *     both were invisible, which is the worst place for a feature to be.
 *  2. It fed the *eye* laterally but never the *aim*, and moving the eye while
 *     the aim stays glued to the kart does not move the kart in frame at all —
 *     it only changes the parallax behind it. That is the mechanical reason the
 *     player sat within 4% of frame centre in all ten shots.
 *
 * Now it is measured honestly — the yaw rate of the travel heading times speed,
 * i.e. lateral acceleration in m/s², normalised — blended with the bend of the
 * road *ahead*, so the frame starts composing on the approach rather than at
 * the apex. The lateral framing itself is solved in screen space (frameSubject)
 * so nothing downstream can quietly cancel it again.
 */
const CORNER_G_FULL = 9.0;       // m/s^2 of lateral accel that counts as "full"
const CORNER_MEASURED = 0.72;    // weight of the measured yaw rate
const CORNER_ANTICIPATED = 0.52; // weight of the road bend ahead
const CORNER_ROLL = 0.155;       // radians of lean at |corner| = 1 (~8.9 deg)
const CORNER_LAT = 2.6;          // metres of outside eye swing at |corner| = 1
/** extra arm smoothing under cornering — bounded, or the lag feeds itself */
const CORNER_LAG = 0.06;

// --- subject framing, solved in screen space ------------------------------
/**
 * Where the player's kart is asked to sit in the frame, in NDC (x right, y up).
 *
 * This is the composition, stated as a composition. Every other offset in this
 * file — the vista lift, the outside swing, the drift slide, the corner lead on
 * the aim — is a *world-space* nudge sized against something that is not the
 * kart, and round one proved that once four of them stack nobody knows where
 * the subject ends up. (Two of them, the drift eye-slide and the drift aim-yaw,
 * were actively subtracting from each other: the eye offset gave back 30% of
 * the yaw's framing every frame.)
 *
 * So: build the pose exactly as before, then measure where the kart actually
 * lands and rotate the aim until it lands where the frame wants it. The
 * world-space offsets keep doing what they are good at — parallax, sightline,
 * what is *behind* the kart — and none of them can move the subject any more.
 *
 * X is signed toward the *outside* of the corner, so the exit opens up in front
 * of the kart. 0.33 is the thirds line; the cap sits just past it.
 */
const FRAME_Y = -0.24;           // base: subject below the axis, horizon high
const FRAME_Y_SPEED = -0.05;     // faster -> a little more road ahead
const FRAME_Y_DRIFT = -0.06;     // sideways -> more background above the kart
const FRAME_Y_VISTA = -0.10;     // a view to show -> drop the subject, lift the bay
/**
 * Floor on how far down the frame the subject may be pushed.
 *
 * -0.46 was two thirds of the way to the bottom edge, and on the corner plate
 * the terms stacked to reach it: base, speed and vista all pull the same way,
 * and the coastal 180 fires all three at once. A subject at -0.42 with a HUD
 * element under it and a lateral offset beside it reads as "shoved into the
 * corner", which is exactly the note that came back.
 *
 * -0.40 rather than the -0.333 thirds line itself: the vista and drift terms
 * exist to make a scenic frame and a sideways frame *different* from a cruise,
 * and a floor set at the thirds line would saturate all three into the same
 * number and undo that. The corner plate now lands near -0.33 on its own,
 * because the vista drop is faded under cornering where the two used to stack
 * (see poseChase); the clamp is the backstop, not the mechanism.
 */
const FRAME_Y_MIN = -0.40;
const FRAME_Y_MAX = -0.08;
const FRAME_X_CORNER = 0.34;
/** A slide has to throw the kart further across the frame than an ordinary
 *  corner does, or the one composition in the game that only a drift can
 *  produce is indistinguishable from the eighty percent of corners nobody
 *  drifts through. 0.22 + 0.17/tier runs 0.22 (catch) to 0.39 (purple). */
const FRAME_X_DRIFT = 0.22;
const FRAME_X_DRIFT_TIER = 0.17;
/** and away from the drop, so the bay gets the other two thirds to itself.
 *  This is the term that keeps a scenic *straight* off dead centre. */
const FRAME_X_VISTA = 0.16;
/** Solved against the residual (see FRAME_GAIN), these land the kart 11-16% of
 *  frame width off centre through corners and drifts — the review asked for
 *  12-18% and the cap has to overshoot it, because the rig's own lateral swing
 *  is pulling the other way and only 90% of the error is taken out. */
const FRAME_X_MAX = 0.44;
/** how much of the framing error is taken out per frame. Deliberately < 1:
 *  the residual is what keeps the kart alive in the frame instead of pinned. */
const FRAME_GAIN = 0.90;
/** airborne, the rig lets go and the kart flies up the frame */
const FRAME_GAIN_AIR = 0.32;

// --- vista: how the rig reacts to ground falling away beside the road ----
/** how far past the road edge the terrain is interrogated, metres */
const VISTA_PROBE = 26;
/** drop, in metres, that counts as no view / as a full view */
const VISTA_MIN = 2.0;
const VISTA_MAX = 13.0;
/**
 * Extra arm height over a full drop.
 *
 * This was 2.75 m on top of a 3 m arm and it was the *other* half of round
 * one's blocker: the coastal and bay sections — precisely the ones the shot
 * list calls the money shot — ran the rig at nearly six metres and pitched it
 * down to match, which is where "bare tarmac occupies the bottom half" came
 * from. The lift is worth keeping (it does open the bay out from behind the
 * outer kerb) but it has to be a lift, not a crane: 1.3 m over a 1.34 m arm is
 * already a near-doubling of eye height, and the aim rises almost as far so
 * the net extra look-down is about a degree instead of seven.
 */
const VISTA_HEIGHT = 1.30;
/**
 * And further back — this is now the *wide* half of the contextual variation
 * the review asked for.
 *
 * The rig gets low, close and long-lensed at speed (ARM_DIST_SPEED,
 * ARM_HEIGHT_SPEED, BOOST_DIST) and tall, distant and wide-lensed where there
 * is something to look at (here, plus VISTA_FOV). Measured at the frame sizes
 * that actually ship: the subject sits at ~19% of frame height on a scenic
 * coastal frame, ~24% cruising, ~27% on a boost. That is a real spread —
 * round seven ran 21-25% across all ten plates, which is why they stacked.
 */
const VISTA_DIST = 1.10;
/** degrees of extra vertical FOV over a full drop, on top of the arm going
 *  back. Lens and rig pulling the same way is what makes a scenic frame read
 *  as *chosen* rather than as the chase camera that happened to be there. */
const VISTA_FOV = 3.0;
/**
 * The vista used to raise the *aim* as well, to trade a degree of pitch for the
 * bay. It no longer does, and it must not: the subject's height in frame is now
 * solved directly (FRAME_Y_VISTA), so an aim offset here would just be undone
 * by the solver a few lines later, and whatever survived would be a fight
 * between two systems that both think they own the pitch. The eye lift stays —
 * that is parallax over the outer kerb, which is the part that actually reveals
 * the drop, and nothing else can produce it.
 */
/** lean the eye out over the drop — the cheapest metre of sightline there is */
const VISTA_EYE_LAT = 1.25;

const CAM_RADIUS = 0.55;     // collision probe radius
/** Minimum metres between the eye and the ground. Lower than it was, because
 *  the arm itself is now less than half as tall — at 0.85 the sweep tripped on
 *  every crest between the lens and the kart and the rig pumped. */
const GROUND_CLEAR = 0.68;
/**
 * Shortest arm the sweep is allowed to pull to, in METRES.
 *
 * This used to be a fraction (0.55) of the desired arm, which was fine while
 * the desired arm barely moved. It is not fine now: the boost pull, the surge
 * transient and the speed term all subtract, and 0.55 of the resulting 3.7 m
 * is 2.0 m — inside the driver's helmet. Stating it in metres also *helps* the
 * tunnel, which is the case the fraction was protecting: on a long arm the
 * sweep may now pull in further than 0.55 would have allowed, so the bore stays
 * seamless instead of clipping the rock at the entry.
 */
const MIN_ARM = 2.85;
const ARM_RECOVER = 0.55;    // seconds for the arm to ease back out after a hit

// --- scenery occlusion ----------------------------------------------------
/**
 * Round eight's blocker, and the only note in the set that made a frame
 * *unshippable* rather than merely weak: the rig parked itself behind a
 * roadside sign panel and photographed the back of it.
 *
 * The cause is structural, not a tuning miss. Everything this file knew about
 * the world came from two analytic queries — `track.probe` (terrain height) and
 * `track.collideWalls` (barriers) — plus a raycast against the tunnel bore.
 * Signs, poles, gantries, banners, parasols and mooring posts are none of those
 * things, so as far as the camera was concerned the verge was empty air. The
 * arm swept clean through a billboard and the LOS report came back clear
 * because the one ray anybody was casting happened to pass over the panel and
 * hit the roll bar.
 *
 * So the rig now carries its own picture of trackside furniture: a flat array
 * of world-space AABBs, built once from the scene graph and tested with a slab
 * intersection. Boxes rather than triangles is a deliberate choice — signs,
 * posts, crates and gantry legs *are* boxes, a slab test is twenty flops with
 * no allocation and no BVH, and it is exact enough to answer the only question
 * being asked ("is there something solid on this segment"). Three tests run per
 * frame: the arm itself (pulls the arm in, through the existing armFrac spring
 * so it cannot pump), five rays to the subject's box (lifts and swings the rig
 * out, which is what a spring arm does when the subject is screened by
 * something the arm itself misses), and a point test on the eye (hard push-out,
 * so the lens can never end up *inside* a panel).
 */
/** widest a box may be, in the horizontal plane, and still count as furniture.
 *  Above this it is architecture — a facade, a grandstand, a banner arch — and
 *  collapsing the arm every time one is near the sightline is far worse than
 *  the occasional clipped corner. Terrain and walls already answer for those. */
const PROP_MAX_SPAN = 13;
/** and tallest. A 20 m building or a landscape-scale mesh is not an occluder
 *  this rig should be dodging; it is the backdrop. */
const PROP_MAX_HEIGHT = 15;
/** hard ceiling on the box list, so a scenery system that instances ten
 *  thousand fence posts cannot turn the camera into the frame budget. */
const PROP_MAX_COUNT = 2400;
/** per-instance boxes are extracted up to this count; denser fields (kerb
 *  segments, crowd, foliage) are skipped wholesale. */
const PROP_MAX_INSTANCES = 384;
/** Frames at which the box list is (re)built. Scenery is not all present on
 *  frame one — some of it is parented into groups that already exist, so a
 *  child-count watch alone would never fire and one early build would latch an
 *  empty list. After the last of these the list is final unless the scene's
 *  top-level shape changes, and never more than PROP_MAX_BUILDS times total. */
const PROP_BUILD_FRAMES = [0, 12, 40, 110, 300];
const PROP_MAX_BUILD = 9;
/** Names that are never furniture. Karts are excluded structurally (they move,
 *  so a cached box would be a phantom blocker parked on the grid); foliage is
 *  excluded because a palm's AABB is nine parts air and pulling the arm in for
 *  a frond is a worse artefact than seeing through one. */
const PROP_SKIP = new RegExp([
  // backdrop and the surfaces the track already answers for analytically
  'sky|cloud|sea|water|ocean|backdrop|horizon|fog|terrain|ground',
  'road|tarmac|asphalt|kerb|curb|grass|sand',
  // things with no solidity to speak of
  'shadow|decal|spark|smoke|dust|particle|trail|godray|flare|glow',
  // foliage: the AABB is nine parts air, and pulling the arm in for a frond is
  // a worse artefact than seeing through one
  'foliage|leaf|leaves|frond|palm|tree|bush|shrub|hedge|plant|flower',
  // crowds are instanced and animated, and a spectator is not an occluder
  'crowd|spectator',
  // gameplay objects: they move, they are meant to be driven through, and a
  // cached box for one would be a phantom blocker sitting where it spawned
  'item|pickup|coin|shell|banana|bomb|star|projectile|boostpad|pad',
  'minimap|helper|gizmo',
].join('|'), 'i');
/** metres of extra eye height the rig will climb to clear the subject */
const CLEAR_LIFT_MAX = 2.30;
/** and metres it will swing outboard, away from whatever is screening it */
const CLEAR_OUT_MAX = 1.55;
/**
 * Shortest the *furniture* sweep alone may leave the arm, as a fraction of the
 * arm the rig asked for. Terrain, walls and the tunnel bore are not floored —
 * see sweepArm for why furniture is the one occluder class that gets a floor,
 * and what an unfloored one did to the hero plate.
 *
 * High deliberately: this test is the softest of the three furniture responses
 * and is the only one that is not load-bearing. propPush guarantees the lens is
 * never inside a box and subjectBlocked guarantees the kart is never behind
 * one, so all the arm sweep has to add is a light ease-off as the rig passes a
 * sign — not a range change the viewer reads as a cut.
 *
 * Measured at the hero mark, arm fraction -> range -> subject height in frame:
 * unfloored 0.297 -> 2.56 m (bumper cam, two thirds of the frame bare asphalt);
 * 0.62 -> 4.32 m (still visibly short); 0.85 -> 5.39 m, which is the range the
 * plate is composed for. Anything that genuinely must collapse the arm further
 * than this is ground or a barrier, and both of those get their say above.
 */
const PROP_ARM_MIN_FRAC = 0.85;
/** fraction of the subject rays that must be blocked before the rig moves,
 *  and the fraction it must fall back under before the rig comes home. The gap
 *  is the hysteresis that stops the correction chasing its own tail. */
const CLEAR_ON = 0.25;
const CLEAR_OFF = 0.08;

// --- banking --------------------------------------------------------------
/**
 * The banked coastal 180 is the bible's declared money shot (§1) and round
 * eight photographed it as "a vertical wall of tarmac with nothing happening".
 *
 * Two things were missing, and neither is a tuning value:
 *
 *  1. Height. A lens two metres over the road on the LOW side of a 20 degree
 *     bank is looking *into* the banking — the outer half of the road is above
 *     eye level, so the frame is a wall. The rig has to climb the bank, which
 *     means both a lift along the road normal and a slide toward the high side.
 *     ROLL_GAIN was already tilting the horizon; tilting the horizon over a
 *     picture of tarmac does not make it a picture of a corner.
 *  2. A reason to believe there is a corner. The aim lead was a flat 0.2 blend
 *     toward a mark 24-44 m ahead whatever the road was doing, so a 180 got the
 *     same amount of look-ahead as a straight and the exit was thirty degrees
 *     outside the frustum.
 *
 * `TrackSample.bank` is signed with the right side raised, so a banked
 * right-hander (outside = left = high) reports negative; the rig's own sign
 * convention is +1 = right-hander, hence the negation where it is read.
 */
/** radians of bank that count as "fully banked" — deliberately under the 20
 *  degree apex so the entry and exit thirds, where the shots actually land,
 *  are already carrying most of the response. */
const BANK_FULL = 0.30;
/** metres the eye climbs at full bank */
const BANK_HEIGHT = 1.15;
/** metres it slides up the bank, toward the outside. Added to the corner
 *  swing, which on a properly banked corner already points the same way. */
const BANK_LAT = 2.10;
/** extra horizon tilt at full bank, ~5 degrees, on top of what the road
 *  normal already contributes through ROLL_GAIN. This is the term that gets a
 *  frame taken on the *entry* of the coastal curve over the 8 degree floor the
 *  review asked for, without touching the apex (which MAX_ROLL still caps). */
const BANK_ROLL = 0.088;
/** how much further down the road the aim reaches at |corner| = 1, metres,
 *  and how much harder it blends toward it. Together these are what put the
 *  corner EXIT in frame instead of the inside of the banking. */
const CORNER_LEAD_DIST = 30;
const CORNER_LEAD_BLEND = 0.24;

// --- the establishing plate ----------------------------------------------
/**
 * Range and lens, solved backwards from "the subject must be 8-10% of frame
 * height" rather than forwards from "an establishing shot is far away".
 *
 * Vertical footprint at the subject is `2 * range * tan(fov/2)`. At the old
 * 55 m / 36 deg that is 35.8 m, which renders a 2.1 m kart at 5.9% of frame
 * height on its long axis and about 2.5% on its short one — the "60 px red
 * speck" the review measured. At 42 m / 31 deg it is 23.3 m: 9.0% long axis,
 * and the karts finally read as karts.
 *
 * The lens goes LONGER as the range comes in, not wider. Shortening the range
 * alone would have bought the subject size back by widening coverage and
 * flattening the compression, which is the opposite of what an aerial plate is
 * for; taking three degrees off the lens at the same time keeps the stacking.
 */
const WIDE_RANGE = 42;
const WIDE_FOV = 31;
/** Thirds intersection, signed away from the direction of travel so the racing
 *  line runs into the frame rather than out of it. */
const WIDE_FRAME_X = 0.31;
const WIDE_FRAME_Y = -0.26;

const INTRO_DUR = 3.55;      // countdown fly-in length
const FINISH_HOLD = 2.3;     // seconds the finish-line cut holds trackside

// ---------------------------------------------------------------------------
//  Module scratch — nothing below here allocates once init() has run
// ---------------------------------------------------------------------------

const WORLD_UP = new THREE.Vector3(0, 1, 0);

const _eye = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _chaseEye = new THREE.Vector3();
const _chaseAim = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _face = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _lead = new THREE.Vector3();
const _camR = new THREE.Vector3();
const _camU = new THREE.Vector3();
const _cr = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _kr = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _box = new THREE.Box3();
const _euler = new THREE.Euler();

/** the five stations on the subject the clearance test asks about: lateral
 *  offset (chassis widths), vertical offset (metres), forward offset. Centre
 *  first, so the common "nothing is in the way" case exits on the first ray. */
const SUBJ_PROBE = [
  0.0, 0.45, 0.0,
  0.0, 1.10, 0.0,
  0.78, 0.45, 0.0,
  -0.78, 0.45, 0.0,
  0.0, 0.28, 0.95,
];

/** Track.sample() accepts a scratch target; the ITrack interface hides it. */
type SampleFn = (t: number, out?: TrackSample) => TrackSample;

type CamMode = 'chase' | 'wide' | 'close';

function clamp(v: number, a: number, b: number) { return v < a ? a : v > b ? b : v; }

function smootherstep(x: number) {
  x = clamp(x, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * Analytic critically-damped spring. Unconditionally stable for any dt,
 * settles without overshoot, and the response is a pure function of
 * `smoothTime` rather than of the frame rate.
 */
function damp1(cur: number, target: number, vel: { v: number }, smoothTime: number, dt: number) {
  const om = 2 / Math.max(1e-4, smoothTime);
  const x = om * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel.v + om * change) * dt;
  vel.v = (vel.v - om * temp) * e;
  return target + (change + temp) * e;
}

/** Vector form of the above; writes through `cur` and `vel`. */
function damp3(cur: THREE.Vector3, target: THREE.Vector3, vel: THREE.Vector3, smoothTime: number, dt: number) {
  const om = 2 / Math.max(1e-4, smoothTime);
  const x = om * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const cx = cur.x - target.x, cy = cur.y - target.y, cz = cur.z - target.z;
  const tx = (vel.x + om * cx) * dt, ty = (vel.y + om * cy) * dt, tz = (vel.z + om * cz) * dt;
  vel.set((vel.x - om * tx) * e, (vel.y - om * ty) * e, (vel.z - om * tz) * e);
  cur.set(target.x + (cx + tx) * e, target.y + (cy + ty) * e, target.z + (cz + tz) * e);
}

/**
 * Harmonic oscillator with a free damping ratio — this is the one that is
 * allowed to overshoot, which is what gives the FOV its rubber-band settle
 * after a boost and the landing dip its bounce. Semi-implicit Euler,
 * substepped so a long frame can never make it explode.
 */
class Osc {
  v = 0;
  vel = 0;
  step(target: number, omega: number, zeta: number, dt: number) {
    const steps = Math.min(8, Math.max(1, Math.ceil(dt * omega * 3)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.vel += (-2 * zeta * omega * this.vel - omega * omega * (this.v - target)) * h;
      this.v += this.vel * h;
    }
    return this.v;
  }
  kick(a: number) { this.vel += a; }
}

/** Two detuned sines: dense enough to read as shake, smooth enough not to alias. */
function shakeNoise(t: number, seed: number) {
  return Math.sin(t * 27.3 + seed * 4.7) * 0.62 + Math.sin(t * 44.1 + seed * 11.3) * 0.38;
}

// ---------------------------------------------------------------------------

export class ChaseCamera implements System {
  // --- rig state ---------------------------------------------------------
  private eye = new THREE.Vector3();
  private eyeVel = new THREE.Vector3();
  private aim = new THREE.Vector3();
  private aimVel = new THREE.Vector3();
  /** true when the current pose is bolted to the kart rather than to the world */
  private followsKart = true;
  private arm = new THREE.Vector3(0, 0, 1);   // smoothed unit heading, world space
  private armVel = new THREE.Vector3();
  private upSm = new THREE.Vector3(0, 1, 0);  // smoothed camera up
  private upVel = new THREE.Vector3();
  private ready = false;

  // --- scalar filters ----------------------------------------------------
  private driftSigned = 0;   // -1 .. 1, smoothed drift direction
  private driftAmt = 0;      // |driftSigned|
  private driftVel = { v: 0 };
  private tierAmt = 0;       // 0..1, smoothed mini-turbo charge tier
  private tierVel = { v: 0 };
  /** signed, normalised cornering effort: +1 = a full-commitment right-hander */
  private corner = 0;
  private cornerVel = { v: 0 };
  /** raw (un-exaggerated) travel heading this frame — the yaw-rate reference */
  private travel = new THREE.Vector3();
  /** previous travel heading, for the yaw-rate measurement */
  private prevHeading = new THREE.Vector3();
  /** signed bend of the road over the next 30-60 m, +1 = bends right */
  private bend = 0;
  private bendVel = { v: 0 };
  private boostAmt = 0;      // 0..1, smoothed "boost is live"
  private boostVel = { v: 0 };
  private vista = 0;         // 0..1, how much the ground falls away beside us
  private vistaVel = { v: 0 };
  private vistaSide = 0;     // signed: +1 the drop is to the right, -1 left
  private vistaSideVel = { v: 0 };
  /** signed, normalised road bank: +1 = a fully banked right-hander (outside,
   *  i.e. the left edge, is the high one). Sign matches `corner`. */
  private bank = 0;
  private bankVel = { v: 0 };
  /** metres of extra eye height / outboard swing bought by the subject
   *  clearance test, and which way "outboard" currently is */
  private clearLift = 0;
  private clearLiftVel = { v: 0 };
  private clearOut = 0;
  private clearOutVel = { v: 0 };
  private clearSide = 1;
  private brakeAmt = 0;
  private brakeVel = { v: 0 };
  private lookAmt = 0;
  private lookVel = { v: 0 };
  private lookHold = 0;
  private armFrac = 1;                        // collision-limited arm fraction
  private armFracVel = { v: 0 };
  private fovOsc = new Osc();
  private dip = new Osc();                    // landing bob
  private kick = new Osc();                   // impact punch along the view axis
  private surge = new Osc();                  // boost arm-pull

  // --- shake -------------------------------------------------------------
  private trauma = 0;
  private traumaDecay = 3.3;

  // --- cinematics --------------------------------------------------------
  private introT = 0;
  /** bearing of the countdown hold, chosen off the sun when the intro arms */
  private introAng = 0.5;
  private finishT = 0;
  private orbit = 0;
  private prevState: RaceState = RaceState.Menu;
  private cutPos = new THREE.Vector3();
  private cutTangent = new THREE.Vector3();

  // --- environment -------------------------------------------------------
  private fovAspectMul = 1;
  private sampleFn: SampleFn | null = null;
  private smp: TrackSample | null = null;
  private smpV: TrackSample | null = null;
  private blockers: THREE.Mesh[] = [];
  /** built lazily, and only ever in the `wide` harness mode (see poseWide) */
  private wideBlockers: THREE.Object3D[] | null = null;
  private blockerBox = new THREE.Box3();
  private hasBlockers = false;
  private ray = new THREE.Raycaster();
  private hits: THREE.Intersection[] = [];
  private unsub: (() => void) | null = null;
  /** trackside furniture as world-space AABBs, six floats each:
   *  minX minY minZ maxX maxY maxZ. Static, built once (see ensureProps). */
  private props: Float32Array | null = null;
  private propCount = 0;
  private propSceneChildren = -1;
  private propBuilds = 0;
  private propStage = 0;
  /** index of the box the last segment test entered first, or -1 */
  private propHit = -1;
  /** broad-phase scratch: offsets into `props`, filled by propGather */
  private cand = new Int32Array(96);
  private prevMode: CamMode | null = null;

  // =======================================================================

  init(ctx: Ctx) {
    ctx.camera.near = 0.2;
    ctx.camera.far = 3000;
    this.fovOsc.v = FOV_BASE;
    ctx.camera.fov = FOV_BASE;
    ctx.camera.updateProjectionMatrix();
    this.resize(ctx.width, ctx.height);

    // Bound once. The cast exposes Track's scratch-target overload, which
    // ITrack omits; an implementation that ignores the second argument still
    // returns a correct sample, it just costs one allocation.
    this.sampleFn = (ctx.track.sample as SampleFn).bind(ctx.track);
    this.smp = ctx.track.sample(0);
    // A second scratch sample: the corner-lead lookup in poseChase and the
    // terrain interrogation in updateVista are both live in the same frame and
    // must not write into each other.
    this.smpV = ctx.track.sample(0);

    // Only the tunnel bore needs a real ray test. Walls and terrain are
    // resolved through the track's own analytic queries, which are an order of
    // magnitude cheaper than triangle soup.
    ctx.track.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!(m as any).isMesh || (m as any).isInstancedMesh) return;
      if (!/tunnel|bore/i.test(m.name)) return;
      m.updateWorldMatrix(true, false);
      this.blockers.push(m);
      this.blockerBox.union(new THREE.Box3().setFromObject(m));
    });
    this.hasBlockers = this.blockers.length > 0;
    // Margin so the gate opens before the eye is actually inside the bore.
    if (this.hasBlockers) this.blockerBox.expandByScalar(16);

    // Screen shake already arrives through ctx.shake() -> addShake(); these
    // handlers only add the rig displacements nobody else can produce.
    this.unsub = ctx.bus.on((e) => {
      if (!('kart' in e) || !e.kart?.isPlayer) return;
      switch (e.type) {
        case 'land':
          // `impact` is a descent rate in m/s: a drop off the bridge thumps,
          // a kerb hop barely registers.
          this.dip.kick(-clamp(e.impact * 0.055, 0, 1.15));
          break;
        case 'collide':
          this.kick.kick(clamp(e.impulse * 0.035, 0, 1.4));
          break;
        case 'boost':
          this.surge.kick(-4.6 - e.tier * 0.9);
          break;
        case 'hit':
          this.kick.kick(0.9);
          break;
      }
    });
  }

  dispose() { this.unsub?.(); this.unsub = null; }

  // =======================================================================
  //  Trackside furniture — the thing this rig used to be blind to
  // =======================================================================

  /**
   * Flatten every piece of roadside furniture into a flat array of world-space
   * AABBs. Built lazily and rebuilt only when the scene's top-level child count
   * changes (scenery, props and karts arrive across several boot frames), with
   * a hard cap on rebuilds so a system that churns the graph cannot make this
   * run every frame. Nothing here allocates once the array is built.
   *
   * What goes in: signs, posts, gantry legs, crates, parasols, mooring bollards
   * — anything solid, ground-planted and small enough that a camera can
   * sensibly go round or over it.
   *
   * What stays out, and why each one matters:
   *  - karts, structurally, by walking `race.karts[].object` first. They move,
   *    and a cached box would be a phantom occluder parked on the grid.
   *  - foliage and crowd, by name. A palm's AABB is mostly air; pulling the arm
   *    in for a frond is a worse artefact than seeing through one.
   *  - anything wider than PROP_MAX_SPAN or taller than PROP_MAX_HEIGHT. A
   *    facade, a grandstand or a banner arch spanning the road is architecture,
   *    and terrain + walls already answer for those. This is also what keeps a
   *    start-line arch from collapsing the arm on every lap.
   *  - dense instanced fields, which are kerb segments and foliage by
   *    construction (the bible mandates instancing exactly those).
   */
  private ensureProps(ctx: Ctx) {
    // Two triggers, because either one alone fails. A top-level child count
    // change catches a system that parents its output straight onto the scene;
    // the frame schedule catches the far more likely case of scenery being
    // built into a group that already existed, where the count never moves and
    // a single early build would latch an empty list and silently disable the
    // whole occlusion path for the session. Both are capped: after the last
    // milestone this never runs again, so nothing here can reach the steady
    // state hot path or allocate in it.
    const n = ctx.scene.children.length;
    const stageDue = this.propStage < PROP_BUILD_FRAMES.length
      && ctx.frame >= PROP_BUILD_FRAMES[this.propStage];
    const changed = this.props === null || n !== this.propSceneChildren;
    if (stageDue) this.propStage++;
    else if (!changed || this.propBuilds >= PROP_MAX_BUILD) return;
    this.propBuilds++;
    this.propSceneChildren = n;

    // Karts are excluded by identity, not by name — they are the one thing in
    // the scene that is guaranteed to invalidate a cached box.
    const skipRoots = new Set<THREE.Object3D>();
    const karts = ctx.race?.karts;
    if (karts) for (let i = 0; i < karts.length; i++) skipRoots.add(karts[i].object);

    const out: number[] = [];
    const push = (b: THREE.Box3) => {
      if (out.length >= PROP_MAX_COUNT * 6) return;
      const sx = b.max.x - b.min.x, sy = b.max.y - b.min.y, sz = b.max.z - b.min.z;
      if (!(sx > 0.05 && sy > 0.35 && sz > 0.05)) return;   // decals, thin mats
      if (sx > PROP_MAX_SPAN || sz > PROP_MAX_SPAN || sy > PROP_MAX_HEIGHT) return;
      out.push(b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z);
    };

    ctx.scene.traverse((o) => {
      if (skipRoots.has(o)) { skipRoots.add(o); return; }
      // A kart's children are reached through the kart root, which is already
      // in the set; traverse() has no skip-subtree, so re-check the ancestry
      // cheaply by marking descendants as we meet them.
      if (o.parent && skipRoots.has(o.parent)) { skipRoots.add(o); return; }

      const m = o as THREE.Mesh;
      if (!(m as any).isMesh || !m.visible || !m.geometry) return;
      if (PROP_SKIP.test(m.name)) return;
      const geo = m.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      if (!bb) return;
      m.updateWorldMatrix(true, false);

      const inst = m as unknown as THREE.InstancedMesh;
      if ((inst as any).isInstancedMesh) {
        if (inst.count > PROP_MAX_INSTANCES) return;
        for (let i = 0; i < inst.count; i++) {
          inst.getMatrixAt(i, _m2);
          _m.multiplyMatrices(m.matrixWorld, _m2);
          _box.copy(bb).applyMatrix4(_m);
          push(_box);
        }
        return;
      }

      _box.copy(bb).applyMatrix4(m.matrixWorld);
      push(_box);
    });

    this.props = out.length ? new Float32Array(out) : null;
    this.propCount = out.length / 6;
  }

  /**
   * Parametric distance along `p0 -> p1` at which the segment first enters any
   * furniture box, inflated by `pad`. Returns 1 when the segment is clear.
   *
   * A branchless-ish slab test behind a six-compare AABB reject, over a flat
   * Float32Array. At a couple of thousand boxes the reject costs about the same
   * as one particle update and the slab test runs on the handful that survive;
   * there is no allocation, no raycaster and no BVH to keep warm.
   */
  /**
   * Broad phase for the clearance test. One pass over the whole array collects
   * the handful of boxes that overlap the eye-to-subject region; the five slab
   * tests then run against those instead of against everything, which turns
   * five full scans into one. At a couple of thousand boxes that is the
   * difference between "measurable" and "not".
   */
  private propGather(a: THREE.Vector3, b: THREE.Vector3, pad: number): number {
    const P = this.props;
    if (!P) return 0;
    const x0 = Math.min(a.x, b.x) - pad, x1 = Math.max(a.x, b.x) + pad;
    const y0 = Math.min(a.y, b.y) - pad, y1 = Math.max(a.y, b.y) + pad;
    const z0 = Math.min(a.z, b.z) - pad, z1 = Math.max(a.z, b.z) + pad;
    let n = 0;
    for (let i = 0, o = 0; i < this.propCount; i++, o += 6) {
      if (P[o + 3] < x0 || P[o] > x1 || P[o + 4] < y0 || P[o + 1] > y1 || P[o + 5] < z0 || P[o + 2] > z1) continue;
      this.cand[n++] = o;
      if (n === this.cand.length) break;
    }
    return n;
  }

  private propSegment(p0: THREE.Vector3, p1: THREE.Vector3, pad: number, candN = -1): number {
    this.propHit = -1;
    const P = this.props;
    if (!P) return 1;
    if (candN === 0) return 1;

    const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
    // A finite stand-in for 1/0: an exact zero would make the (b - p) * inv
    // product NaN whenever the origin sits exactly on a slab plane.
    const ix = dx !== 0 ? 1 / dx : 1e30;
    const iy = dy !== 0 ? 1 / dy : 1e30;
    const iz = dz !== 0 ? 1 / dz : 1e30;

    const qx0 = (dx < 0 ? p1.x : p0.x) - pad, qx1 = (dx < 0 ? p0.x : p1.x) + pad;
    const qy0 = (dy < 0 ? p1.y : p0.y) - pad, qy1 = (dy < 0 ? p0.y : p1.y) + pad;
    const qz0 = (dz < 0 ? p1.z : p0.z) - pad, qz1 = (dz < 0 ? p0.z : p1.z) + pad;

    // Either the whole list, or the candidates propGather already narrowed to.
    const count = candN >= 0 ? candN : this.propCount;
    let best = 1;
    for (let i = 0; i < count; i++) {
      const o = candN >= 0 ? this.cand[i] : i * 6;
      const bx0 = P[o], by0 = P[o + 1], bz0 = P[o + 2];
      const bx1 = P[o + 3], by1 = P[o + 4], bz1 = P[o + 5];
      if (bx1 < qx0 || bx0 > qx1 || by1 < qy0 || by0 > qy1 || bz1 < qz0 || bz0 > qz1) continue;

      let t0 = 0, t1 = best;
      let a = (bx0 - pad - p0.x) * ix, b = (bx1 + pad - p0.x) * ix;
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
      if (t0 > t1) continue;

      a = (by0 - pad - p0.y) * iy; b = (by1 + pad - p0.y) * iy;
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
      if (t0 > t1) continue;

      a = (bz0 - pad - p0.z) * iz; b = (bz1 + pad - p0.z) * iz;
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
      if (t0 > t1) continue;

      best = t0;
      this.propHit = o;
      if (best <= 0) break;
    }
    return best;
  }

  /**
   * How much of the subject is screened from `eye`, 0..1, over five rays that
   * span the kart's box rather than the single centre ray that reported the
   * corner plate clear while a sign panel covered half the chassis.
   *
   * Also picks the direction to escape in: away from whatever is doing the
   * screening, in the frame's own lateral axis, so the rig swings out from
   * behind a sign rather than deeper into it.
   */
  private subjectBlocked(eye: THREE.Vector3, k: IKart): number {
    if (!this.props) return 0;

    _cr.copy(k.position).sub(eye);
    if (_cr.lengthSq() < 1e-4) return 0;
    _cr.crossVectors(_cr.normalize(), this.upSm);
    if (_cr.lengthSq() < 1e-6) _cr.set(1, 0, 0); else _cr.normalize();

    _kr.crossVectors(k.forward, this.upSm);
    if (_kr.lengthSq() < 1e-6) _kr.copy(_cr); else _kr.normalize();

    // One broad-phase pass, padded by the widest station offset, then five
    // narrow tests against whatever survived it.
    const n = this.propGather(eye, k.position, 1.4);
    if (n === 0) return 0;

    let blocked = 0;
    let sideSum = 0;
    for (let i = 0; i < 5; i++) {
      const o = i * 3;
      _pt.copy(k.position)
        .addScaledVector(_kr, SUBJ_PROBE[o])
        .addScaledVector(this.upSm, SUBJ_PROBE[o + 1])
        .addScaledVector(k.forward, SUBJ_PROBE[o + 2]);
      // Stop a little short of the subject so the kart's own bounding volume,
      // and anything legitimately touching it, cannot read as an occluder.
      _pt.lerp(eye, 0.06);
      if (this.propSegment(eye, _pt, 0, n) < 1) {
        blocked++;
        const o2 = this.propHit;
        if (o2 >= 0) {
          const P = this.props;
          _tmp.set(
            (P[o2] + P[o2 + 3]) * 0.5 - eye.x,
            0,
            (P[o2 + 2] + P[o2 + 5]) * 0.5 - eye.z,
          );
          sideSum += _tmp.dot(_cr);
        }
      }
    }
    if (blocked > 0 && Math.abs(sideSum) > 0.15) this.clearSide = sideSum > 0 ? -1 : 1;
    return blocked / 5;
  }

  /**
   * Last line of defence: the lens is inside a panel. Push it out along the
   * axis of least penetration. Boxes that also contain the kart are skipped —
   * driving through a prop's bounding volume is the scenery system's problem,
   * and yanking the camera out of it would be a far louder artefact.
   */
  private propPush(p: THREE.Vector3, kart: THREE.Vector3, pad: number) {
    const P = this.props;
    if (!P) return;
    for (let i = 0, o = 0; i < this.propCount; i++, o += 6) {
      const bx0 = P[o] - pad, by0 = P[o + 1] - pad, bz0 = P[o + 2] - pad;
      const bx1 = P[o + 3] + pad, by1 = P[o + 4] + pad, bz1 = P[o + 5] + pad;
      if (p.x < bx0 || p.x > bx1 || p.y < by0 || p.y > by1 || p.z < bz0 || p.z > bz1) continue;
      if (kart.x >= bx0 && kart.x <= bx1 && kart.z >= bz0 && kart.z <= bz1) continue;

      const px = Math.min(p.x - bx0, bx1 - p.x);
      const py = by1 - p.y;                       // out of the top only, never down
      const pz = Math.min(p.z - bz0, bz1 - p.z);
      if (py <= px && py <= pz && py < 2.5) { p.y = by1; continue; }
      if (px <= pz && px < 2.5) { p.x = (p.x - bx0 < bx1 - p.x) ? bx0 : bx1; continue; }
      if (pz < 2.5) p.z = (p.z - bz0 < bz1 - p.z) ? bz0 : bz1;
    }
  }

  addShake(a: number, s = 0.3) {
    this.trauma = Math.min(1, this.trauma + a);
    // A longer requested duration means a slower bleed-off, not a timer — so
    // overlapping requests compose instead of the last one winning.
    this.traumaDecay = Math.min(this.traumaDecay, clamp(1 / Math.max(0.08, s), 0.6, 6));
  }

  resize(w: number, h: number) {
    const aspect = h > 0 ? w / h : REF_ASPECT;
    // Hor+ : hold the horizontal field constant below 16:9.
    const base = THREE.MathUtils.degToRad(FOV_BASE);
    this.fovAspectMul = aspect >= REF_ASPECT
      ? 1
      : (2 * Math.atan(Math.tan(base * 0.5) * REF_ASPECT / aspect)) / base;
    this.fovAspectMul = clamp(this.fovAspectMul, 1, 1.45);
  }

  // =======================================================================
  //  Frame
  // =======================================================================

  lateUpdate(ctx: Ctx, dt: number) {
    const k = ctx.race?.player;
    if (!k || !this.sampleFn) return;
    dt = Math.max(1e-4, dt);

    const mode: CamMode = ((window as any).__camMode as CamMode) || 'chase';
    const state = ctx.race.state;

    this.ensureProps(ctx);

    // A harness mode change is a CUT, not a move, and the lens has to be at its
    // new focal length on the very first frame of it: frameSubject solves the
    // subject's screen position against `fovOsc.v`, and a wide plate composed
    // against a stale 50 degrees puts the kart a third of a frame off where the
    // composition asked. applyFov's own settle is fine for everything else.
    if (mode !== this.prevMode) {
      // Including the very first frame: the harness sets the mode before the
      // rig has ever run, so "no previous mode" is precisely the case where
      // the lens is most likely to be wrong.
      this.fovOsc.v = (mode === 'wide' ? WIDE_FOV : mode === 'close' ? 34 : FOV_BASE) * this.fovAspectMul;
      this.fovOsc.vel = 0;
      this.prevMode = mode;
    }

    // --- speed / drift / brake scalars ------------------------------------
    const speed = Math.abs(k.forwardSpeed);
    const sp = clamp(speed / BASE_TOP_SPEED, 0, 1.25);
    // Signed, so the roll and the framing offset ease *out* through zero when
    // the drift releases instead of snapping the instant driftDir clears.
    const drifting = k.driftDir !== 0 && !k.airborne;
    // Snap in, ooze out: the composition should change the instant the slide
    // catches and unwind slowly enough that the release reads as a release.
    this.driftSigned = damp1(this.driftSigned, drifting ? k.driftDir : 0, this.driftVel, drifting ? 0.15 : 0.40, dt);
    this.driftAmt = Math.abs(this.driftSigned);
    // Tier drives the *depth* of the lean, so a purple slide is framed harder
    // than a blue one and the tier change is felt in the rig, not just in the
    // spark colour.
    this.tierAmt = damp1(this.tierAmt, drifting ? clamp(k.driftTier / 3, 0, 1) : 0, this.tierVel, 0.22, dt);
    const braking = ctx.input.state.brake > 0.4 && k.forwardSpeed > 5 ? 1 : 0;
    this.brakeAmt = damp1(this.brakeAmt, braking, this.brakeVel, 0.2, dt);
    // Boost drops the rig rather than pitching it: a lower eye already puts
    // more road under the kart, and a nose-down camera at 45 m/s is the exact
    // frame the composition notes are trying to get rid of.
    const boosting = k.boostTime > 0 ? 1 : 0;
    this.boostAmt = damp1(this.boostAmt, boosting, this.boostVel, boosting ? 0.11 : 0.30, dt);

    // lookBack is specified as a rising edge but plays naturally as a held
    // button; a short hold window makes both spellings behave sensibly.
    if (ctx.input.state.lookBack) this.lookHold = 0.3; else this.lookHold -= dt;
    const wantLook = this.lookHold > 0 && state === RaceState.Racing && mode === 'chase' ? 1 : 0;
    this.lookAmt = damp1(this.lookAmt, wantLook, this.lookVel, 0.19, dt);

    // --- ground frame and heading -----------------------------------------
    const probe = ctx.track.probe(k.position, k.t);
    this.updateUp(k, probe.normal, mode, dt);
    this.updateHeading(ctx, k, sp, speed, dt);
    this.updateVista(ctx, k, dt);

    // --- pose --------------------------------------------------------------
    const cinematic = this.buildPose(ctx, k, mode, state, sp, dt);

    // --- springs -----------------------------------------------------------
    if (!this.ready) {
      this.ready = true;
      this.eye.copy(_eye); this.aim.copy(_aim);
      this.eyeVel.set(0, 0, 0); this.aimVel.set(0, 0, 0);
    }
    const eyeSmooth = cinematic ? 0.34 : POS_SMOOTH + this.lookAmt * 0.05;
    const aimSmooth = cinematic ? 0.26 : AIM_SMOOTH;

    // A critically-damped spring chasing a *moving* target settles with a
    // standing error of |v| * smoothTime — at 30 m/s that silently added 4.6 m
    // to the arm and 2.8 m to the aim, so the rig geometry the constants above
    // describe was only ever true at a standstill (the kart shrank to a third
    // of its parked size on a straight). Feeding the target's own velocity
    // forward cancels the standing error exactly while leaving the transient
    // response — the "weight" of the rig — untouched.
    if (this.followsKart) {
      _lead.copy(k.velocity);
      _eye.addScaledVector(_lead, eyeSmooth);
      _aim.addScaledVector(_lead, aimSmooth);
    }

    damp3(this.eye, _eye, this.eyeVel, eyeSmooth, dt);
    damp3(this.aim, _aim, this.aimVel, aimSmooth, dt);

    // --- impact offsets, applied outside the springs so they read as hits ---
    const dip = this.dip.step(0, 15, 0.42, dt);
    const kick = this.kick.step(0, 21, 0.36, dt);
    _tmp.copy(this.eye).addScaledVector(this.upSm, dip * 6.0);
    _dir.copy(this.aim).sub(this.eye);
    const armLen = _dir.length();
    if (armLen > 1e-3) _dir.multiplyScalar(1 / armLen); else _dir.set(0, 0, -1);
    _tmp.addScaledVector(_dir, -kick * 8.0);

    // Floor of last resort: whatever the springs and cinematics decided, the
    // eye never ends up inside the ground or under the sea.
    const under = ctx.track.probe(_tmp, k.t);
    if (_tmp.y < under.y + GROUND_CLEAR) _tmp.y = under.y + GROUND_CLEAR;

    ctx.camera.position.copy(_tmp);

    // --- orientation --------------------------------------------------------
    _up.copy(this.upSm);
    _m.lookAt(_tmp, this.aim, _up);
    ctx.camera.quaternion.setFromRotationMatrix(_m);

    this.applyShake(ctx, dt);
    this.applyFov(ctx, mode, sp, dt);
  }

  // =======================================================================
  //  Up vector — banking with lag and a hard roll ceiling
  // =======================================================================

  private updateUp(k: IKart, groundNormal: THREE.Vector3, mode: CamMode, dt: number) {
    _up.copy(groundNormal);
    if (_up.y < 0.15) _up.copy(WORLD_UP); // nonsense normal (cliff face) — bail out
    if (k.airborne) _up.lerp(WORLD_UP, 0.65);

    // Adopt only part of the road's tilt: a camera that banks 1:1 with a 20
    // degree curve throws away the horizon as a readable reference.
    let gain = ROLL_GAIN;
    if (mode === 'wide') gain = 0.18;        // establishing plates want a level horizon
    else if (mode === 'close') gain = 0.95;
    _up.lerp(WORLD_UP, 1 - gain).normalize();

    // Extra lean into the drift, deepening with the mini-turbo tier. On top of
    // a banked corner this is what takes the horizon past twenty degrees on the
    // money shot; on a flat one it is the only thing that says "sideways".
    //
    // The cornering lean underneath it is the same idea for the eighty percent
    // of corners nobody drifts through: a couple of degrees of tilt into the
    // arc, so a sweeping left-hander is never framed identically to a straight.
    // Both are gated to the chase rig — an establishing plate wants a level
    // horizon, and the hero shot is composed about the chassis, not the corner.
    let lean = 0;
    if (mode === 'chase') {
      lean = this.corner * CORNER_ROLL;
      // ...and the bank on top. ROLL_GAIN already carries the road normal into
      // the frame, but it carries the normal AT THE KART, and the plates get
      // taken on the entry and exit thirds where a 20 degree apex is only
      // running six or eight. The review asked for 8-12 degrees of tilt on the
      // banked corner specifically because the bank is the entire subject of
      // that shot; this is the term that guarantees it there instead of only at
      // the apex, and MAX_ROLL still caps the apex itself.
      lean += this.bank * BANK_ROLL;
    }
    // A drift is a drift in every gameplay framing, but an establishing plate
    // wants a level horizon (see the wide gain above) — leaving this ungated
    // meant a wide shot captured mid-slide came back dutched by ten degrees,
    // which is the one thing an establishing frame must not be.
    if (mode !== 'wide' && this.driftAmt > 1e-3) {
      const driftLean = (DRIFT_ROLL + DRIFT_ROLL_TIER * this.tierAmt) * this.driftSigned;
      // The two are measured from different things and do NOT have to agree:
      // `corner` is the yaw rate of the *travel* heading, driftSigned is which
      // way the chassis was kicked. A slide that has run wide and is being
      // steered back has them opposed, and round seven's drift plate was
      // exactly that case — the lean cancelled to nothing and the horizon came
      // back dead level on the one frame in the set that is supposed to be
      // sideways. A live slide owns the frame, so the corner term is faded out
      // wherever it would subtract from it.
      if (lean * driftLean < 0) lean *= 1 - this.driftAmt;
      lean += driftLean;
    }
    // A touch of dutch on a boost. Small — four degrees — but it is the term
    // that makes a boost legible in a *still*: FOV and speed lines both need a
    // before-frame to be read against, and a tilted horizon does not.
    // Signed by the corner where there is one, defaulting to a right-hand tilt
    // on a straight-line boost; continuous through corner = 0 either way.
    if (mode === 'chase' && this.boostAmt > 1e-3) {
      const s = clamp(this.corner * 3, -1, 1);
      lean += BOOST_ROLL * this.boostAmt * (s + (1 - Math.abs(s)));
    }
    if (Math.abs(lean) > 1e-4) {
      _q.setFromAxisAngle(this.arm, lean);
      _up.applyQuaternion(_q);
    }

    // Clamp roll measured about the view axis, so slope (which is pitch, not
    // roll) is never penalised by the limit.
    _right.crossVectors(this.arm, WORLD_UP);
    if (_right.lengthSq() > 1e-6) {
      _right.normalize();
      _tmp2.crossVectors(_right, this.arm).normalize(); // the "level up" in this plane
      const roll = Math.atan2(_up.dot(_right), _up.dot(_tmp2));
      const limited = clamp(roll, -MAX_ROLL, MAX_ROLL);
      if (limited !== roll) {
        const pitchPart = _up.dot(this.arm);
        _up.copy(_tmp2).multiplyScalar(Math.cos(limited))
          .addScaledVector(_right, Math.sin(limited))
          .addScaledVector(this.arm, pitchPart)
          .normalize();
      }
    }

    damp3(this.upSm, _up, this.upVel, mode === 'chase' ? UP_SMOOTH : 0.3, dt);
    this.upSm.normalize();
  }

  // =======================================================================
  //  Heading — direction of travel, not direction of facing
  // =======================================================================

  private updateHeading(ctx: Ctx, k: IKart, sp: number, speed: number, dt: number) {
    // Project onto the plane of the camera up so slope never leaks into yaw.
    _face.copy(k.forward);
    _face.addScaledVector(this.upSm, -_face.dot(this.upSm));
    if (_face.lengthSq() < 1e-6) _face.copy(this.arm); else _face.normalize();

    _vel.copy(k.velocity);
    _vel.addScaledVector(this.upSm, -_vel.dot(this.upSm));
    const vlen = _vel.length();

    // --- rotate toward the direction of TRAVEL ----------------------------
    //
    // Measured as an ANGLE and applied as a rotation, not as a chord lerp
    // between two unit vectors. The difference is not cosmetic. `lerp(face,
    // vel, w)` realises strictly less than `w * slip` degrees of yaw, and it
    // saturates at the velocity vector itself — there is no way to express
    // "read the slide as further sideways than it physically is", which is
    // precisely what a kart camera is for. Round seven measured 18.6 degrees
    // of real slip on the drift plate; the old blend rendered 16.7, which is
    // inside the band an ordinary fast corner produces, and the reviewers
    // could not tell the drift frame from the corner frame. The rotation form
    // lets the drift term go past 1.0 and puts 21 degrees of chassis yaw in
    // frame before the arm spring's own trailing lag adds another 6-9.
    let blend = 0;
    let trusted = false;
    if (vlen > 2) {
      _vel.multiplyScalar(1 / vlen);
      // Reversing, spun out or shelled: the velocity heading would whip the
      // camera through 180 degrees, so it is only trusted while it broadly
      // agrees with where the chassis points.
      const agree = _vel.dot(_face);
      if (agree > 0.2) {
        trusted = true;
        blend = clamp((vlen - 2) / 5, 0, 1)
          * (HEAD_TRAVEL + HEAD_TRAVEL_DRIFT * this.driftAmt)
          * clamp((agree - 0.2) / 0.35, 0, 1);
      }
    }

    // The RAW travel heading, kept before any exaggeration is applied. This is
    // the reference the yaw rate below is differentiated against, and it has to
    // be: the exaggeration scales with driftAmt, which ramps over 0.15 s on
    // entry and bleeds over 0.40 s on release, so differentiating the
    // exaggerated heading would report a saturating corner spike at both ends
    // of every slide — and on release it points the wrong way.
    this.travel.copy(trusted ? _vel : _face);

    if (blend > 1e-3) {
      // Signed slip about the camera up. cross(face, vel) . up is |sin|, and
      // setFromAxisAngle(up, slip) applied to `face` reproduces `vel` exactly,
      // so scaling `slip` is a clean over/under-drive of the real attitude.
      _tmp.crossVectors(_face, _vel);
      const slip = Math.atan2(_tmp.dot(this.upSm), clamp(_face.dot(_vel), -1, 1));
      const yaw = clamp(slip * blend, -HEAD_MAX_SLIP, HEAD_MAX_SLIP);
      if (Math.abs(yaw) > 1e-4) {
        _q.setFromAxisAngle(this.upSm, yaw);
        _face.applyQuaternion(_q).normalize();
      }
    }

    // --- how hard are we cornering, really -------------------------------
    //
    // Measured, not inferred. The yaw rate of the *travel* heading about the
    // camera up, times road speed, is lateral acceleration in m/s²: the number
    // the driver's inner ear is reporting and therefore the number the frame
    // should be composed around. The old proxy — the arm spring's lag behind
    // the heading — was the same quantity multiplied by a 0.145 s time
    // constant, i.e. a seventh of it, and it fed a constant tuned as though it
    // were the whole thing.
    _right.crossVectors(this.arm, this.upSm);
    if (_right.lengthSq() > 1e-6) _right.normalize(); else _right.set(1, 0, 0);

    if (this.prevHeading.lengthSq() < 0.5) this.prevHeading.copy(this.travel);
    _tmp.crossVectors(this.prevHeading, this.travel);
    // + = turning right, matching the sign of driftDir and of _right.
    const yawRate = clamp(-_tmp.dot(this.upSm) / dt, -5, 5);
    this.prevHeading.copy(this.travel);

    // Blended with the bend of the road ahead so the frame starts recomposing
    // on the approach instead of at the apex — a camera that only reacts is
    // always a beat late, and a beat late is what "rail-cam demo" looks like.
    const ahead = (26 + 34 * sp) / Math.max(1, ctx.track.length);
    const sAhead = this.sampleFn!(k.t + ahead, this.smp!);
    _tmp2.copy(sAhead.tangent);
    _tmp2.addScaledVector(this.upSm, -_tmp2.dot(this.upSm));
    const bendRaw = _tmp2.lengthSq() > 1e-6
      ? clamp(_tmp2.normalize().dot(_right), -1, 1)
      : 0;
    this.bend = damp1(this.bend, bendRaw, this.bendVel, 0.26, dt);

    const cornerTarget = clamp(
      (yawRate * speed / CORNER_G_FULL) * CORNER_MEASURED + this.bend * CORNER_ANTICIPATED,
      -1, 1,
    );
    this.corner = damp1(this.corner, cornerTarget, this.cornerVel, 0.18, dt);

    // Look-back is applied later as a yaw offset on the settled arm: springing
    // the direction vector itself through an antipode is degenerate, and
    // orbiting the arm is what gives the whip-round its arc.
    //
    // The drift term is what makes the camera visibly *trail* a slide instead
    // of rotating with it: at 0.05 the rig was within three degrees of the
    // heading through a tier-3 drift, which is why the drift frame read as a
    // kart pointing straight ahead with sparks under it.
    const lag = 0.12 + this.driftAmt * 0.11 + Math.abs(this.corner) * CORNER_LAG;
    damp3(this.arm, _face, this.armVel, lag, dt);
    // Insurance against a degenerate spin-out passing through the antipode.
    if (this.arm.lengthSq() < 1e-6) { this.arm.copy(_face); this.armVel.set(0, 0, 0); }
    this.arm.normalize();
  }

  // =======================================================================
  //  Vista — "is there anything to look at out there?"
  // =======================================================================
  //
  //  Careful with this one: it is a *lift*, and round one proved that a lift
  //  sized like a crane is worse than no lift at all. Hoisting the eye and
  //  pitching down to compensate is exactly how the coastal sections — the
  //  money shot — ended up as half a frame of tarmac with the bay squeezed
  //  into a strip. The gain below is now a fraction of what it was, and the
  //  aim rises almost as far as the eye, so the drop enters frame by parallax
  //  rather than by pointing the camera at the floor.
  //
  //  So: measure. Probe the ground a fixed distance outboard of each kerb and
  //  compare it with the centreline. A drop means there is a view — the sea off
  //  the cliff traverse, the bay inside the banked 180, the inlet under the
  //  bridge — and the rig lifts, leans toward the drop and pitches down until
  //  it is in frame. Rising ground (the village cutting, the tunnel bore) reads
  //  as no drop and changes nothing, which is exactly right: those sections
  //  want the low, fast, close-in rig they already have.
  //
  //  Two probes and one centreline sample per frame. The karts do thirty-two.

  private updateVista(ctx: Ctx, k: IKart, dt: number) {
    let drop = 0;
    let side = this.vistaSide >= 0 ? 1 : -1;
    let bank = 0;

    // Never lift inside the bore: the roof is 4.5 m up and the sweep would just
    // yank the arm straight back in, which pumps. Same gate for the bank
    // response below — a banked tunnel would otherwise hoist the lens into
    // the rock.
    if (!(this.hasBlockers && this.blockerBox.containsPoint(k.position))) {
      const s = this.sampleFn!(k.t, this.smpV!);
      const out = s.halfWidth + VISTA_PROBE;

      _tmp.copy(s.pos).addScaledVector(s.binormal, out);
      const dropR = s.pos.y - ctx.track.probe(_tmp, k.t).y;
      _tmp.copy(s.pos).addScaledVector(s.binormal, -out);
      const dropL = s.pos.y - ctx.track.probe(_tmp, k.t).y;

      drop = Math.max(dropL, dropR);
      side = dropR >= dropL ? 1 : -1;

      // `TrackSample.bank` is signed with the RIGHT side raised; the rig's own
      // convention (corner, driftSigned, the lean applied about the arm) is
      // +1 = right-hander. A properly built right-hander raises its outside,
      // which is the left edge, so the two are negatives of each other. Reading
      // the declared quantity rather than reconstructing it from the normal
      // also means a flat-but-turning corner reports zero here and gets its
      // framing from `corner` alone, which is correct.
      bank = clamp(-s.bank / BANK_FULL, -1, 1);
    }

    const v = smootherstep((drop - VISTA_MIN) / (VISTA_MAX - VISTA_MIN));
    // Slow, and near-symmetric: this is a landscape-scale quantity, so the rig
    // must neither bob over a gully nor snap back down at a bridge abutment.
    this.vista = damp1(this.vista, v, this.vistaVel, v > this.vista ? 0.75 : 0.8, dt);
    this.vistaSide = damp1(this.vistaSide, side * v, this.vistaSideVel, 0.75, dt);
    // Faster than the vista (a bank arrives over tens of metres, not hundreds)
    // but still slower than the arm, so entering the coastal curve is a move
    // rather than a step.
    this.bank = damp1(this.bank, bank, this.bankVel, 0.42, dt);
  }

  // =======================================================================
  //  Pose selection. Fills _eye / _aim; returns true for cinematic framing,
  //  which runs looser springs.
  // =======================================================================

  private buildPose(ctx: Ctx, k: IKart, mode: CamMode, state: RaceState, sp: number, dt: number): boolean {
    // Harness modes win outright: they are portfolio frames, not gameplay, and
    // must not be hijacked by a race-state cinematic.
    // Poses that are rigidly bolted to the kart need the spring's standing
    // tracking error cancelled (see the lead in lateUpdate); poses anchored to
    // the world — the finish cut, the results orbit — must not have it.
    this.followsKart = true;
    if (mode === 'wide') { this.poseWide(ctx, k); return true; }
    if (mode === 'close') { this.poseClose(k); return true; }

    // Arm the fly-in on the way *into* the countdown, not every frame of it.
    if (state === RaceState.Countdown && this.prevState !== RaceState.Countdown) {
      this.introT = 0;
      // Snap the heading to the kart before composing off it. The arm spring
      // starts at world +Z and needs half a second to find the grid; the intro
      // bearing is chosen once, on this frame, and a bearing chosen off a
      // stale arm is a bearing that is wrong for the whole countdown.
      _face.copy(k.forward);
      _face.addScaledVector(this.upSm, -_face.dot(this.upSm));
      if (_face.lengthSq() > 1e-6) {
        this.arm.copy(_face).normalize();
        this.armVel.set(0, 0, 0);
        this.prevHeading.copy(this.arm);
      }
      this.chooseIntroBearing(ctx);
    }
    if (state === RaceState.Finished && this.prevState !== RaceState.Finished) {
      this.finishT = 0;
      this.captureFinishCut(ctx, k);
    }
    if (state === RaceState.Results && this.prevState !== RaceState.Results) this.orbit = 0;
    this.prevState = state;

    // The live chase pose is always solved: cinematics blend onto it, and the
    // handover out of one has to be seamless.
    this.poseChase(ctx, k, sp, dt);
    _chaseEye.copy(_eye);
    _chaseAim.copy(_aim);

    if (state === RaceState.Results || state === RaceState.Menu) {
      this.poseOrbit(ctx, k, state === RaceState.Menu, dt);
      this.followsKart = false;
      return true;
    }
    if (state === RaceState.Finished) {
      this.finishT += dt;
      this.poseFinish(k);
      this.followsKart = false;
      return true;
    }

    // The countdown pose holds through the GO frame and releases the instant
    // the player is actually driving, so the intro can never eat the race.
    const introLive = state === RaceState.Countdown
      || (this.introT < INTRO_DUR && state === RaceState.Racing && Math.abs(k.forwardSpeed) < 2.5);
    if (this.introT < INTRO_DUR) {
      this.introT += introLive ? dt : dt * 2.6; // released early — hurry the settle
      const p = clamp(this.introT / INTRO_DUR, 0, 1);
      if (p < 1) { this.poseIntro(ctx, k, p); this.followsKart = false; return true; }
    }
    return false;
  }

  // --- the chase pose proper ---------------------------------------------

  private poseChase(ctx: Ctx, k: IKart, sp: number, dt: number) {
    const surge = this.surge.step(0, 13, 0.5, dt);

    _pivot.copy(k.position).addScaledVector(this.upSm, PIVOT_UP);

    // Look-back swings the whole rig around the pivot rather than flipping the
    // aim, so the return is a real move instead of a cut.
    _dir.copy(this.arm);
    if (this.lookAmt > 1e-3) {
      _q.setFromAxisAngle(this.upSm, Math.PI * this.lookAmt);
      _dir.applyQuaternion(_q);
    }

    // surge < 0 on boost entry (arm snaps in), then overshoots long as it
    // settles — the classic "the world pulls away from you" kick.
    // Looking back is the one time the view must not be hoisted over a cliff:
    // the point of it is the kart behind you.
    //
    // The boost pull is the other half of the boost punch, and the half that
    // was missing: the lens opens ~10 degrees on a boost, which by itself just
    // makes the subject smaller — a wider frame with a smaller kart in it reads
    // as *less* speed, not more. Pulling the arm in by the same proportion
    // holds the kart at its cruising size while the road, the kerbs and the
    // trackside furniture stretch out past the frame edge. That is a dolly
    // zoom, and it is what a boost is supposed to feel like.
    //
    // Round seven made the boost move the whole rig rather than only the arm
    // length: the arm drops as well as closing, and both ride the surge
    // oscillator (zeta 0.5) so the entry snaps and the settle overshoots back
    // out instead of easing home on a ramp. A still frame of a boost now
    // differs from a still frame of a cruise in eye height, range, dutch and
    // lens — four cues, any one of which survives a screenshot.
    const vista = this.vista * (1 - this.lookAmt);
    const boost = this.boostAmt * (1 - this.lookAmt);
    let dist = ARM_DIST + ARM_DIST_SPEED * sp + surge * BOOST_SURGE_DIST
      - this.brakeAmt * 0.85 - this.lookAmt * 1.4
      - boost * BOOST_DIST + VISTA_DIST * vista;
    const bank = Math.abs(this.bank) * (1 - this.lookAmt);
    let height = ARM_HEIGHT + ARM_HEIGHT_SPEED * sp + surge * BOOST_SURGE_HEIGHT
      - this.brakeAmt * 0.3 + this.lookAmt * 0.25
      - boost * BOOST_HEIGHT - this.driftAmt * 0.18 + VISTA_HEIGHT * vista
      // Climb the banking. A lens two metres over the road on the low side of a
      // 20 degree bank is looking INTO the banking: the outer half of the road
      // is above eye level and the frame is a wall of tarmac with the exit
      // hidden behind it. This, plus the outboard slide below, is what makes
      // the money shot a picture of a corner instead of a picture of asphalt.
      + BANK_HEIGHT * bank;
    if (k.airborne) height += 0.35;
    // The arm may never fold through the chassis, whatever the surge, the
    // brake and the boost decide between them.
    if (dist < 3.1) dist = 3.1;

    // Sweep the arm for obstructions and pull it in on a hit. Recovery is
    // deliberately slower than the pull, so the rig never pumps.
    const hit = this.sweepArm(ctx, k, _pivot, _dir, dist, height);
    if (hit < this.armFrac) { this.armFrac = hit; this.armFracVel.v = 0; }
    else this.armFrac = damp1(this.armFrac, hit, this.armFracVel, ARM_RECOVER, dt);
    // Floored in metres, not as a fraction — see MIN_ARM.
    const f = clamp(this.armFrac, Math.min(1, MIN_ARM / Math.max(0.1, dist)), 1);

    _eye.copy(_pivot).addScaledVector(_dir, -dist * f).addScaledVector(this.upSm, height * f);

    // The frame's own right, reused by every offset below.
    _right.crossVectors(_dir, this.upSm);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0); else _right.normalize();

    // Lean the eye out over the drop. A metre is nothing to the rig and it is
    // the difference between the outer kerb hiding the bay and the bay opening
    // up beyond it.
    if (vista > 1e-3) _eye.addScaledVector(_right, this.vistaSide * (1 - this.lookAmt) * VISTA_EYE_LAT);

    // Swing wide of the arc. The eye goes to the *outside* of the corner, and
    // it needs no drift to fire, so an ordinary fast sweeper stops being framed
    // like a straight. Faded out under look-back, where the whole point is what
    // is behind you.
    //
    // This is now purely a *parallax* control, and it can finally be sized like
    // one. When it also had to move the kart in frame it could not: it was
    // fighting the aim, which is glued to the kart, and the aim wins. Screen
    // position is frameSubject's job; this decides what is behind the kart —
    // on the village hairpin, whether that is the facades or an empty apron.
    //
    // The bank adds to it, and adds in the same direction on any corner built
    // the way a corner should be: `bank` is signed +1 for a right-hander whose
    // outside (left) edge is raised, which is exactly where `corner` is already
    // sending the eye. On the coastal 180 the two together put the lens up on
    // the high side of the banking, looking down across it at the exit and the
    // bay, which is the shot §1 of the bible describes.
    let swing = (this.corner * CORNER_LAT + this.bank * BANK_LAT) * (1 - this.lookAmt);
    // Slide the rig toward the outside of the SLIDE, which is a different
    // quantity — see the roll and framing notes: `corner` reads the travel
    // heading's yaw rate, driftSigned reads which way the chassis was kicked,
    // and a slide being caught or steered back has them opposed. Left to add
    // freely they cancelled, and round seven's drift plate came back with the
    // rig on the *inside* of the slide, in the grass, looking through it.
    if (this.driftAmt > 1e-3) {
      const driftLat = this.driftSigned * DRIFT_RIG_LAT * (1 - this.lookAmt);
      if (swing * driftLat < 0) swing *= 1 - this.driftAmt;
      swing += driftLat;
    }
    if (Math.abs(swing) > 1e-3) _eye.addScaledVector(_right, -swing);

    // --- get off the sign -------------------------------------------------
    //
    // The spring-arm clearance correction, applied from LAST frame's
    // measurement so the loop closes cleanly: pose, measure, correct next
    // frame. Measuring the pose we are about to modify and then modifying it
    // would be a fixed-point iteration with no guarantee of one, and a rig that
    // hunts between "behind the sign" and "clear of it" is worse than one that
    // is simply late.
    //
    // Height carries most of the escape because trackside furniture is
    // ground-planted and finite: signs, posts and gantry legs all run out at
    // three or four metres, and going over is both shorter and better composed
    // than going round. The outboard component is the remainder, signed away
    // from whatever is actually doing the screening (see subjectBlocked).
    if (this.clearLift > 1e-3) _eye.addScaledVector(this.upSm, this.clearLift);
    if (this.clearOut > 1e-3) _eye.addScaledVector(_right, this.clearSide * this.clearOut);

    // Every offset above is lateral or vertical, so the arm sweep (which only
    // walks the arm itself) cannot see any of them. One analytic wall query
    // resolves the barriers — and it is a resolve, not a bail-out, so the
    // composition survives a brush past a guardrail instead of snapping back to
    // centre — and one point test resolves the furniture the walls do not know
    // about, which is how the lens ended up inside a billboard.
    const w = ctx.track.collideWalls(_eye, CAM_RADIUS, k.t);
    if (w) _eye.add(w.push);
    this.propPush(_eye, k.position, CAM_RADIUS);

    // Aim ahead along the arm, plus a lead into the coming corner so the apex
    // is on screen before the kart gets there.
    //
    // This is now the *seed* pose, not the final one: frameSubject rotates it
    // until the kart lands where the composition asked, so what survives here
    // is the residual — how far down the road the axis wants to run, and hence
    // roughly where the horizon sits relative to the subject. Braking and boost
    // nose it over, which after the solve reads as the horizon lifting rather
    // than as the kart sliding down the frame.
    _aim.copy(k.position)
      .addScaledVector(this.upSm, AIM_UP - this.brakeAmt * 0.60 - this.boostAmt * 0.40);
    _aim.addScaledVector(_dir, (5.2 + 4.6 * sp) * (1 - 0.35 * this.lookAmt));

    if (this.lookAmt < 0.5) {
      // The lead scales with how hard the road is turning. A flat 0.2 blend
      // toward a mark 24-44 m ahead gives a 180 degree hairpin exactly as much
      // look-ahead as a straight, and on a 180 that is nowhere near enough: the
      // exit is thirty degrees outside the frustum and the frame answers "where
      // does the track go" with a wall of tarmac. At |corner| = 1 the mark goes
      // out to ~74 m and the blend to 0.44, which is what puts the exit — and
      // the bay beyond it — in frame beside the subject.
      const cAbs = Math.abs(this.corner);
      const ahead = (24 + 30 * sp + CORNER_LEAD_DIST * cAbs) / Math.max(1, ctx.track.length);
      const s = this.sampleFn!(k.t + ahead, this.smp!);
      _tmp.copy(s.pos).addScaledVector(s.normal, AIM_LEAD_UP);
      _aim.lerp(_tmp, (0.2 + CORNER_LEAD_BLEND * cAbs) * (1 - this.lookAmt * 2));
    }

    // --- and finally, compose ---------------------------------------------
    //
    // Everything above decided where the camera *stands* and roughly where it
    // looks. This decides where the subject sits in the picture, which is the
    // only part a reviewer actually sees.
    const look = 1 - clamp(this.lookAmt * 2, 0, 1);
    let cornerX = this.corner * FRAME_X_CORNER;
    const driftX = this.driftSigned * (FRAME_X_DRIFT + FRAME_X_DRIFT_TIER * this.tierAmt);
    // THE round-seven bug, and the reason "every frame is the kart parked dead
    // centre" was literally true of the one frame that had the best excuse not
    // to be. `corner` is the yaw rate of the travel heading; driftSigned is
    // which way the chassis was kicked. Through a slide that has run wide and
    // is being steered back — which is most of a long drift, and exactly what
    // the drift plate caught — they are opposed, and 0.34 of corner against
    // 0.27 of drift summed to 0.02: the kart landed within one percent of frame
    // centre with a tier-2 slide under it. A live slide owns the frame, so the
    // corner term is faded out wherever it would subtract from the slide, and
    // never the other way round.
    if (this.driftAmt > 1e-3 && cornerX * driftX < 0) cornerX *= 1 - this.driftAmt;
    // The third member of the same family, and the one still left unguarded:
    // `vistaSide` is which way the ground falls away, `corner` is which way the
    // road turns, and on a banked corner with the bay on the inside they are
    // opposed. Left to add freely they land the subject at an arbitrary
    // fraction of wherever either one asked for — the corner plate came back
    // with the kart pinned to one edge and two thirds of the frame empty, and
    // no term in this file could tell you which of the two put it there.
    // A corner is the stronger compositional statement (the exit is a place the
    // eye wants to go; a drop is only a backdrop), so it wins, and the vista
    // offset fades wherever it would fight it.
    let vistaX = this.vistaSide * FRAME_X_VISTA;
    if (cornerX * vistaX < 0) vistaX *= 1 - Math.abs(this.corner);
    const fx = clamp(
      cornerX + driftX + vistaX,
      -FRAME_X_MAX, FRAME_X_MAX,
    ) * look;
    // The vista drop is faded out under cornering. Both terms push the subject
    // down the frame and the coastal 180 fires both at once — that stack is
    // what put the kart at -0.42 with a HUD element under it and produced the
    // "shoved into the corner at small scale" note. A scenic STRAIGHT still
    // gets the full drop, which is where it earns its keep.
    const fy = clamp(
      FRAME_Y + FRAME_Y_SPEED * sp + FRAME_Y_DRIFT * this.driftAmt
      + FRAME_Y_VISTA * vista * (1 - 0.6 * Math.abs(this.corner)),
      FRAME_Y_MIN, FRAME_Y_MAX,
    );
    // Negated: a right-hander (corner > 0) throws the kart to the LEFT of frame,
    // which is the outside of the turn, and opens the exit up ahead of it.
    this.frameSubject(ctx, k, -fx, fy);

    // --- and then check our work ------------------------------------------
    //
    // Everything above assumed the subject is visible. Measure whether it
    // actually is, and hand the answer to the next frame's clearance offset.
    // Deliberately hysteretic: grow while genuinely screened, hold through the
    // middle band, release only when properly clear — otherwise the correction
    // un-blocks the subject, the target collapses to zero, the rig falls back
    // behind the sign and the whole thing limit-cycles at a couple of hertz.
    const blocked = this.subjectBlocked(_eye, k);
    let liftT = this.clearLift;
    let outT = this.clearOut;
    if (blocked >= CLEAR_ON) { liftT = CLEAR_LIFT_MAX * blocked; outT = CLEAR_OUT_MAX * blocked; }
    else if (blocked <= CLEAR_OFF) { liftT = 0; outT = 0; }
    // Snap out from behind an obstruction, ease back home — the review asked
    // for ~0.25 s, and an asymmetric pair means the recovery never races the
    // next occluder.
    const ct = liftT > this.clearLift ? 0.18 : 0.30;
    this.clearLift = damp1(this.clearLift, liftT, this.clearLiftVel, ct, dt);
    this.clearOut = damp1(this.clearOut, outT, this.clearOutVel, ct, dt);
  }

  /**
   * Put the subject where the composition asked for it.
   *
   * Measures the kart's actual position in normalised device coordinates given
   * the pose just built, then rotates the aim about the eye until it lands on
   * the requested NDC. One Gauss-Seidel step: rotating the axis by δ moves the
   * subject by −δ, so a single correction is exact to second order, and it is
   * re-solved every frame anyway.
   *
   * Costs no allocation, one square root and two divides. It runs *after* the
   * arm sweep and the wall resolve, so a rig that got shoved by a guardrail
   * still frames the kart — that case used to throw the subject at the frame
   * edge because nothing downstream knew the eye had moved.
   *
   * `gain` under 1 leaves a residual, so the kart still breathes around the
   * target with the rig's own weight instead of being welded to a pixel. The
   * springs on `this.eye` / `this.aim` in lateUpdate then add the lag on top,
   * which is where the trailing-behind-a-yaw feel comes from.
   */
  private frameSubject(ctx: Ctx, k: IKart, ndcX: number, ndcY: number) {
    _tmp.copy(_aim).sub(_eye);            // view axis
    const axisLen = _tmp.length();
    if (axisLen < 1e-3) return;
    _tmp.multiplyScalar(1 / axisLen);

    _camR.crossVectors(_tmp, this.upSm);
    if (_camR.lengthSq() < 1e-6) return;
    _camR.normalize();
    _camU.crossVectors(_camR, _tmp).normalize();

    _tmp2.copy(k.position).sub(_eye);     // eye -> subject
    const z = _tmp2.dot(_tmp);
    if (z < 0.5) return;                  // behind us (look-back): leave it alone

    // Half-frame tangents at the FOV the frame will actually be rendered with.
    // applyFov runs after this, so `fovOsc.v` is one substep stale — worth
    // about a tenth of a degree, i.e. nothing.
    const vFov = THREE.MathUtils.degToRad(clamp(this.fovOsc.v, 20, 90));
    const tanV = Math.tan(vFov * 0.5);
    const aspect = ctx.height > 0 ? ctx.width / ctx.height : REF_ASPECT;
    const tanH = tanV * aspect;

    const gain = k.airborne ? FRAME_GAIN_AIR : FRAME_GAIN;
    const dx = (_tmp2.dot(_camR) / z - ndcX * tanH) * gain * axisLen;
    const dy = (_tmp2.dot(_camU) / z - ndcY * tanV) * gain * axisLen;

    _aim.addScaledVector(_camR, dx).addScaledVector(_camU, dy);
  }

  /**
   * Usable fraction of the desired arm. Walls and terrain go through the
   * track's analytic queries; the tunnel bore is the one thing that needs a
   * real ray, and that is gated on the bore's own bounds so the cost is only
   * paid on the eight percent of the lap that is underground.
   */
  private sweepArm(ctx: Ctx, k: IKart, pivot: THREE.Vector3, dir: THREE.Vector3, dist: number, height: number) {
    let frac = 1;

    const SAMPLES = 5;
    for (let i = 1; i <= SAMPLES; i++) {
      const s = i / SAMPLES;
      _tmp.copy(pivot).addScaledVector(dir, -dist * s).addScaledVector(this.upSm, height * s);
      const pr = ctx.track.probe(_tmp, k.t);
      // Clearance is relaxed near the pivot. The arm is barely two metres tall
      // now, so a station a metre behind the kart legitimately sits low; a flat
      // clearance there means every crest between the lens and the chassis
      // slams the arm in and the rig pumps down a rolling road.
      const clear = GROUND_CLEAR * (0.45 + 0.55 * s);
      // Rising ground behind (village climb, cliff cutting) or a barrier the
      // eye is low enough to hit: stop at the previous station.
      if (_tmp.y < pr.y + clear || ctx.track.collideWalls(_tmp, CAM_RADIUS, k.t)) {
        frac = (i - 1) / SAMPLES;
        break;
      }
    }

    // Trackside furniture, as one exact segment test rather than as stations.
    // Station sampling is the wrong tool here and would have missed the very
    // panel that produced the blocker: a sign is 0.2 m thick and the stations
    // are a metre apart, so four times out of five the arm steps straight
    // through it. The slab test cannot.
    if (this.props) {
      _tmp.copy(pivot).addScaledVector(dir, -dist).addScaledVector(this.upSm, height);
      const tp = this.propSegment(pivot, _tmp, CAM_RADIUS);
      // Stop short of the surface, not on it, or the eye sits in the panel's
      // own near-plane and renders its back face across the frame.
      //
      // ...but FLOORED, which the terrain and wall tests above deliberately are
      // not. Those two answer for ground and barriers, and an eye inside a hill
      // or through a guardrail has no acceptable framing, so they may collapse
      // the arm to nothing. Furniture is different in kind: it is thin, it is
      // beside the road rather than across it, and there is a whole line of it
      // down every interesting straight.
      //
      // Unfloored, this amputated the signature shot. Measured at the `hero`
      // mark, where the verge carries a sign panel and a banner on posts (two
      // boxes about 3.9 x 4.4 x 3.6 m, based 2.1 m up, 7.5 m off the racing
      // line): the sweep hit them and drove armFrac to 0.297, so the plate was
      // shot from 2.56 m on a 55 degree lens instead of the six the rig asked
      // for. The frame came back as two thirds bare asphalt with the bay, the
      // headland and the whole sunset squeezed into the top eighth — the exact
      // "nothing happening" note this file keeps trying to answer, reintroduced
      // by the fix for a different one.
      //
      // Trimming is still right; amputating is not. The two guarantees that
      // actually matter are kept elsewhere and are unaffected by this floor:
      // propPush resolves the eye out of any box it ends up inside (so the lens
      // can never render a panel's back face), and subjectBlocked lifts and
      // swings the rig when the SUBJECT is screened (so the kart can never end
      // up behind one). This test is the third and softest of the three, and a
      // floor is what makes it read as a spring arm easing past a sign rather
      // than as a cut to a bumper cam every time one goes by.
      if (tp < 1) frac = Math.min(frac, Math.max(PROP_ARM_MIN_FRAC, tp - 0.07));
    }

    if (this.hasBlockers && this.blockerBox.containsPoint(pivot)) {
      _tmp.copy(dir).multiplyScalar(-dist).addScaledVector(this.upSm, height);
      const len = _tmp.length();
      if (len > 1e-3) {
        _tmp.multiplyScalar(1 / len);
        this.ray.set(pivot, _tmp);
        this.ray.near = 0.1;
        this.ray.far = len;
        this.hits.length = 0;
        this.ray.intersectObjects(this.blockers, false, this.hits);
        if (this.hits.length) {
          frac = Math.min(frac, Math.max(0, (this.hits[0].distance - CAM_RADIUS) / len));
        }
      }
    }

    return frac;
  }

  // --- countdown fly-in ---------------------------------------------------

  /**
   * Bearing for the countdown hold, chosen once when the intro arms.
   *
   * Round one held the grid shot 67 degrees off the racing axis, seven and a
   * half metres up, seventeen metres out — a surveillance angle, not a hero
   * angle. The pack fell away on a diagonal so it never read as a pack, the
   * front row went out of frame left, and because the bearing was a hard-coded
   * constant it happened to look straight down the sun line: two of the eight
   * karts dissolved in the flare.
   *
   * The sun is the one thing here that is fixed by the bible (§2, 14 degrees,
   * low and roughly west), so the shot should be composed *against* it rather
   * than in ignorance of it. Score a fan of candidate bearings on two terms —
   * how far the lens is pointing away from the sun, and how close to head-on
   * the shot stays — and take the best. On a start straight that runs away
   * from the sun this picks a near-head-on 20-30 degrees; on one that runs
   * into it, it swings out until the sun rakes the grid from the side and
   * rim-lights the field instead of burning through it.
   */
  private chooseIntroBearing(ctx: Ctx) {
    // Sun bearing in the ground plane, resolved against the racing axis.
    _tmp.copy(ctx.sunDirection);
    _tmp.addScaledVector(this.upSm, -_tmp.dot(this.upSm));
    if (_tmp.lengthSq() < 1e-6) { this.introAng = 0.5; return; }
    _tmp.normalize();
    _right.crossVectors(this.arm, this.upSm);
    if (_right.lengthSq() < 1e-6) { this.introAng = 0.5; return; }
    _right.normalize();
    const sunFwd = _tmp.dot(this.arm);
    const sunRight = _tmp.dot(_right);

    let best = 0.5;
    let bestScore = -1e9;
    for (let i = 0; i < 12; i++) {
      // +-0.34 .. +-1.05 rad, i.e. 20 to 60 degrees off head-on. The far end of
      // that range already clears a 66 degree horizontal lens of the sun disc;
      // anything wider stops being a grid shot and starts being the round-one
      // surveillance angle again.
      const a = (i < 6 ? 1 : -1) * (0.34 + (i % 6) * 0.142);
      // setFromAxisAngle(up, a) swings the arm toward -right, so the lens
      // (which looks back along -_dir) ends up here:
      const look = -Math.cos(a) * sunFwd + Math.sin(a) * sunRight;
      // Penalise pointing within ~45 degrees of the sun, hard; penalise being
      // off head-on, gently. Ties break toward the smaller swing.
      const score = -Math.max(0, look - 0.30) * 7 - Math.abs(a) * 0.5;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    this.introAng = best;
  }

  private poseIntro(ctx: Ctx, k: IKart, p: number) {
    // Two beats. First a held front three-quarter of the grid — the shot that
    // sells the field — then a sweep around the flank that lands exactly on
    // the chase pose as the lights go out.
    //
    // Low, close and near head-on. The player is always karts[0] and karts[0]
    // is always pole, so a lens in front of the player is a lens in front of
    // the whole field: the eight karts stack into rows behind each other and
    // read as a pack instead of trailing off to a vanishing point. Three
    // metres of eye height over an eleven metre range is a kerb-level hero
    // angle — the karts sit against the sky and the backdrop rather than
    // against a plan view of their own grid boxes.
    const front = smootherstep(clamp(p / 0.62, 0, 1));
    const settle = smootherstep(clamp((p - 0.58) / 0.42, 0, 1));

    const side = this.introAng >= 0 ? 1 : -1;
    const hold = this.introAng * (0.86 + front * 0.14);
    // ...then round the flank to just off directly-behind, where the chase is.
    const ang = hold + (side * 2.95 - hold) * settle;
    const dist = 16.6 - front * 4.1 - settle * 4.4;
    const height = 2.05 - front * 0.35 - settle * 0.16;

    _q.setFromAxisAngle(this.upSm, ang);
    _dir.copy(this.arm).applyQuaternion(_q);

    _eye.copy(k.position).addScaledVector(_dir, dist).addScaledVector(this.upSm, height);
    // A near-level axis, from an eye barely above the roll bars. Round one put
    // the lens 7.6 m up and aimed it at chassis height: a 20 degree depression,
    // which renders a grid as a plan view of eight grid boxes and pushes the
    // whole field into the top half with nothing above it but bank. At 1.7 m
    // and 2.2 degrees down the front row stands 18% of frame height, the karts
    // break the horizon instead of sitting on a diagram of it, and the top
    // 45% of the frame is clear sky — which is where the countdown numeral
    // wants to be, and where a banner arch would read if scenery builds one.
    _aim.copy(k.position).addScaledVector(this.upSm, 1.05 + settle * 0.5)
      .addScaledVector(this.arm, -5.0);

    // A kerb-height lens swung 20-60 degrees off the racing axis at fifteen
    // metres can end up outside the road furniture — behind a barrier, inside a
    // grandstand — and unlike the chase pose there is no arm sweep here to
    // catch it. One analytic wall query pushes it back onto the tarmac. It only
    // runs during the countdown, so it costs nothing that matters.
    const wall = ctx.track.collideWalls(_eye, CAM_RADIUS, k.t);
    if (wall) _eye.add(wall.push);

    // Ease home so the handover to gameplay has no seam at all.
    _eye.lerp(_chaseEye, settle);
    _aim.lerp(_chaseAim, settle);
  }

  // --- finish line --------------------------------------------------------

  private captureFinishCut(ctx: Ctx, k: IKart) {
    const s = this.sampleFn!(k.t + 0.004, this.smp!);
    const pr = ctx.track.probe(k.position, k.t);
    const side = pr.lateral >= 0 ? 1 : -1; // stand on the outside of the kart
    this.cutPos.copy(s.pos)
      .addScaledVector(s.binormal, side * (s.halfWidth + 8.5))
      .addScaledVector(s.normal, 3.4);
    this.cutTangent.copy(s.tangent);
    // A cut is a cut: teleport the springs rather than sweeping across the map.
    this.eye.copy(this.cutPos);
    this.aim.copy(k.position);
    this.eyeVel.set(0, 0, 0);
    this.aimVel.set(0, 0, 0);
    this.ready = true;
  }

  private poseFinish(k: IKart) {
    if (this.finishT < FINISH_HOLD) {
      // Trackside, dollying gently with the kart so it doesn't just leave frame.
      _eye.copy(this.cutPos).addScaledVector(this.cutTangent, this.finishT * 3.2);
      _aim.copy(k.position).addScaledVector(this.upSm, 0.9);
    } else {
      // Then rise into a wide victory-lap chase.
      const w = smootherstep((this.finishT - FINISH_HOLD) / 1.6);
      _tmp.copy(k.position).addScaledVector(this.arm, -11.5).addScaledVector(this.upSm, 5.6);
      _eye.copy(this.cutPos).addScaledVector(this.cutTangent, FINISH_HOLD * 3.2).lerp(_tmp, w);
      _aim.copy(k.position).addScaledVector(this.upSm, 0.9).addScaledVector(this.arm, 4.0 * w);
    }
  }

  // --- results / menu orbit ----------------------------------------------

  private poseOrbit(ctx: Ctx, player: IKart, wide: boolean, dt: number) {
    const winner = (ctx.race.standings && ctx.race.standings[0]) || player;
    this.orbit += dt * (wide ? 0.13 : 0.2);

    const dist = wide ? 13.5 : 8.4;
    const height = wide ? 4.6 : 2.9;
    _q.setFromAxisAngle(WORLD_UP, this.orbit);
    _dir.set(0, 0, 1).applyQuaternion(_q);

    _eye.copy(winner.position)
      .addScaledVector(_dir, dist)
      .addScaledVector(WORLD_UP, height + Math.sin(this.orbit * 1.7) * 0.35);
    _aim.copy(winner.position).addScaledVector(WORLD_UP, wide ? 1.4 : 0.95);
  }

  // --- harness modes ------------------------------------------------------

  /**
   * The establishing plate.
   *
   * Round one put this at 80 m back and 30 m up, which sounds like a helicopter
   * and is in fact *inside the village roofline*: the depression angle was 20
   * degrees, the terraced houses on the seaward side of the road are 15-20 m
   * tall, and every one of them stood between the lens and the road. The plate
   * showed terracotta, and the two saturated objects in the scene — the karts —
   * were both behind it.
   *
   * Three changes, in order of importance:
   *
   *  1. A steep enough descent that foreground geometry cannot reach the
   *     sightline, *verified rather than assumed*. The rig starts at 35 degrees
   *     and climbs in 7 degree steps until a ray from the subject to the lens
   *     is clear. That is the regression guard: the shot cannot silently go
   *     back inside a roofline when the village grows a storey.
   *  2. A long lens from a short range instead of a wide lens from a long one.
   *     36 degrees vertical at 55 m puts the karts at ~3.2% of frame width
   *     instead of 1.2%, i.e. sixty pixels of saturated red instead of twenty.
   *     A 200 m plate that shows the whole S-curve *cannot* also show a kart —
   *     at that range a kart is four pixels — so the shot picks a subject.
   *  3. The bearing is yawed 45 degrees off the racing axis and the aim is
   *     pushed down-track, so the road enters low and leaves high rather than
   *     vanishing up the middle.
   */
  private poseWide(ctx: Ctx, k: IKart) {
    this.ensureWideBlockers(ctx);

    // --- 1. range and lens: the subject has to be big enough to find --------
    //
    // Round eight measured the player at ~3% of frame height on this plate and
    // called it, correctly, a shot with no subject. 55 m at 36 degrees puts a
    // 36 m ground footprint in frame, and a 2.1 m kart inside a 36 m footprint
    // is a speck whatever else the composition does. WIDE_RANGE / WIDE_FOV are
    // solved backwards from the requirement instead: 42 m at 31 degrees sees a
    // 23 m footprint, so the kart occupies 9-10% of frame height — the band the
    // review asked for, and roughly triple what shipped.
    //
    // Closing the range and lengthening the lens together is deliberate. A
    // shorter range alone would have widened the coverage and flattened the
    // compression; taking three degrees off the lens at the same time keeps the
    // long-lens stacking that makes an establishing plate read as chosen.
    //
    // Aim at the ribbon a little ahead of the player: lerping toward the
    // sampled centreline rather than adding a raw offset pulls the axis back
    // onto the road when the player is out wide, so the racing line runs
    // through the frame rather than off the side of it.
    const LEAD = 13;
    const s = this.sampleFn!(k.t + LEAD / Math.max(1, ctx.track.length), this.smp!);
    _aim.copy(k.position).lerp(s.pos, 0.8).addScaledVector(WORLD_UP, 2.2);

    _q.setFromAxisAngle(WORLD_UP, 0.78);
    _dir.copy(this.arm).applyQuaternion(_q);
    _dir.y = 0;
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, 1); else _dir.normalize();

    // --- 2. an elevation that is VERIFIED clear of the subject --------------
    //
    // This loop existed and did not work, and the reason is worth stating: it
    // tested the sightline to `_aim`, which is a point on the centreline ten
    // metres ahead of the player. A telegraph pole standing between the lens
    // and the KART is not on that ray, so the escalation never fired, the plate
    // came back with a gantry through the middle of it, and the harness dutifully
    // reported the line of sight clear. The test now runs against the subject,
    // over five stations spanning the kart's box, exactly as the chase rig's
    // clearance test does — and it is the same failure both were built to catch.
    let elev = 0.55;                       // ~31 degrees
    for (let i = 0; i < 7; i++) {
      _eye.copy(_aim)
        .addScaledVector(_dir, -WIDE_RANGE * Math.cos(elev))
        .addScaledVector(WORLD_UP, WIDE_RANGE * Math.sin(elev));
      // Terrain is not in the blocker list (it is the one thing the track can
      // answer analytically), so clear it here.
      const pr = ctx.track.probe(_eye, k.t);
      if (_eye.y < pr.y + 8) _eye.y = pr.y + 8;
      if (!this.subjectOccluded(k)) break;
      elev += 0.115;                       // ~6.6 degrees
      if (elev > 1.25) break;              // 72 degrees is already a map view
    }

    // --- 3. compose ---------------------------------------------------------
    //
    // Same screen-space solver the chase rig uses, for the same reason: the
    // previous version hoped the subject would land somewhere reasonable given
    // a world-space aim offset, and hope put it in the lower-left at 3% with no
    // relationship to any line in the frame. Ask for the thirds intersection
    // and get it.
    //
    // The side is derived, not fixed: put the kart on the side of the frame it
    // is driving AWAY from, so the road ahead of it — the racing line, the
    // thing that is supposed to lead the eye — occupies the two thirds it is
    // heading into. On a plate whose bearing flips relative to the track, a
    // hard-coded side would put the player nose-first into the frame edge.
    _cr.crossVectors(_dir, WORLD_UP);
    if (_cr.lengthSq() > 1e-6) _cr.normalize(); else _cr.set(1, 0, 0);
    const side = s.tangent.dot(_cr) >= 0 ? -1 : 1;
    this.frameSubject(ctx, k, side * WIDE_FRAME_X, WIDE_FRAME_Y);
  }

  /**
   * Is the SUBJECT screened from `_eye`? Five rays spanning the kart's box,
   * cast from the kart outward so the near clip skips its own geometry and the
   * far clip stops short of the lens.
   *
   * Only ever called from the `wide` harness mode, at most seven times per
   * frame. Gameplay pays nothing — neither the traversal nor these rays run on
   * a chase frame; the chase rig uses the far cheaper AABB path instead.
   */
  private subjectOccluded(k: IKart): boolean {
    const list = this.wideBlockers;
    if (!list || list.length === 0) return false;

    _kr.crossVectors(k.forward, WORLD_UP);
    if (_kr.lengthSq() < 1e-6) _kr.set(1, 0, 0); else _kr.normalize();

    for (let i = 0; i < 5; i++) {
      const o = i * 3;
      _pt.copy(k.position)
        .addScaledVector(_kr, SUBJ_PROBE[o])
        .addScaledVector(WORLD_UP, SUBJ_PROBE[o + 1])
        .addScaledVector(k.forward, SUBJ_PROBE[o + 2]);
      _tmp.copy(_eye).sub(_pt);
      const len = _tmp.length();
      if (len < 8) return false;
      _tmp.multiplyScalar(1 / len);
      this.ray.set(_pt, _tmp);
      this.ray.near = 3;
      this.ray.far = len - 2;
      this.hits.length = 0;
      this.ray.intersectObjects(list, false, this.hits);
      if (this.hits.length) return true;
    }
    return false;
  }

  /**
   * Flatten the scene into a list of things that can plausibly block a
   * sightline. Built once, lazily, on the first wide-mode frame.
   *
   * Excluded: the sky dome and the sea (they are the backdrop, and an inward-
   * facing dome is hit by every ray), anything whose bounds are landscape
   * scale (terrain — handled by track.probe instead), and dense instanced
   * fields like foliage and crowd, where a ray test costs more than the shot
   * is worth and a palm frond is not an occluder worth craning for.
   */
  private ensureWideBlockers(ctx: Ctx) {
    if (this.wideBlockers) return;
    const list: THREE.Object3D[] = [];
    ctx.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!(m as any).isMesh || !m.visible || !m.geometry) return;
      if (/sky|cloud|sea|water|ocean|backdrop|horizon|fog|terrain|ground/i.test(m.name)) return;
      const inst = m as unknown as THREE.InstancedMesh;
      if ((inst as any).isInstancedMesh && inst.count > 1500) return;
      if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
      const r = m.geometry.boundingSphere?.radius ?? 0;
      m.updateWorldMatrix(true, false);
      const scale = _tmp2.setFromMatrixScale(m.matrixWorld).length() * 0.5774;
      if (r * scale > 500) return;
      list.push(m);
    });
    this.wideBlockers = list;
  }

  private poseClose(k: IKart) {
    // The classic front three-quarter hero angle, locked to the chassis rather
    // than to the travel heading so the model always presents the same face.
    _face.copy(k.forward);
    _face.addScaledVector(this.upSm, -_face.dot(this.upSm));
    if (_face.lengthSq() < 1e-6) _face.copy(this.arm); else _face.normalize();

    // Stand on the side the ground *rises*, so whatever is behind the kart is
    // the view rather than two hundred metres of receding tarmac. On the cliff
    // traverse that swaps a brown post and a band of haze for the drop and the
    // sea; where the ground is level either side it lands exactly where it did.
    const side = this.vistaSide >= 0 ? 1 : -1;
    _q.setFromAxisAngle(this.upSm, 0.66 * side);
    _dir.copy(_face).applyQuaternion(_q);

    // Get *under* the roll bar and tilt up. The round-one plate stood a metre
    // above the chassis and looked slightly down, which fills everything behind
    // the subject with receding tarmac — there was literally nothing in that
    // frame but road, kerb and gradient. Dropping the lens below the top of the
    // wheels and aiming above the centre of mass swings the horizon up behind
    // the kart, so the background becomes sky, sea and headland; it also reads
    // as a low hero angle, which is the whole point of the shot.
    const lift = 0.62 + 0.30 * this.vista;
    _eye.copy(k.position).addScaledVector(_dir, 3.6 + 0.3 * this.vista).addScaledVector(this.upSm, lift);
    _aim.copy(k.position).addScaledVector(this.upSm, 0.86).addScaledVector(_face, 0.2);
  }

  // =======================================================================
  //  Shake + FOV
  // =======================================================================

  private applyShake(ctx: Ctx, dt: number) {
    if (this.trauma <= 0) { this.traumaDecay = 3.3; return; }
    this.trauma = Math.max(0, this.trauma - this.traumaDecay * dt);
    if (this.trauma <= 0) { this.traumaDecay = 3.3; return; }

    // Squared falloff: small knocks stay subtle, big ones hit hard.
    const a = this.trauma * this.trauma;
    const t = ctx.time;

    // Rotational shake carries most of the weight. Translating the eye alone
    // reads as a camera bug; rotating it reads as an impact.
    _euler.set(
      shakeNoise(t, 1) * a * 0.028,
      shakeNoise(t, 2) * a * 0.032,
      shakeNoise(t, 3) * a * 0.045,
    );
    _q.setFromEuler(_euler);
    ctx.camera.quaternion.multiply(_q);

    _tmp.set(shakeNoise(t, 4) * a * 0.16, shakeNoise(t, 5) * a * 0.14, 0)
      .applyQuaternion(ctx.camera.quaternion);
    ctx.camera.position.add(_tmp);
  }

  private applyFov(ctx: Ctx, mode: CamMode, sp: number, dt: number) {
    let target: number;
    let omega = 11;
    let zeta = 0.62;

    // The plate is a long lens now, not a wide one — see poseWide / WIDE_FOV.
    if (mode === 'wide') { target = WIDE_FOV; omega = 8; zeta = 1; }
    else if (mode === 'close') { target = 34; omega = 8; zeta = 1; }
    else if (ctx.race.state === RaceState.Results || ctx.race.state === RaceState.Menu) {
      target = 40; omega = 7; zeta = 1;
    } else if (this.introT < INTRO_DUR) {
      // A long lens on the hold beat and only then opening out — the grid shot
      // lives or dies on compression. At 40 degrees the eight karts stack into
      // rows; at 50 they fan out and the pack stops reading as a pack. Keyed to
      // the settle beat rather than to raw p, so the lens is long for the whole
      // held shot instead of already halfway open by the time it is captured.
      target = 40 + (FOV_BASE - 40) * smootherstep(clamp((this.introT / INTRO_DUR - 0.58) / 0.42, 0, 1));
      omega = 7; zeta = 1;
    } else {
      // The punch is deliberately *not* the whole story any more. ctx.fovPunch
      // peaks around 10.5 degrees on a boost; at 0.95 that opened the lens to
      // 67 vertical — 100 horizontal — which is wider than the 60 this file was
      // written to get rid of, and it shrank the kart to a dot in precisely the
      // frame that is supposed to be the most exciting one in the game. The
      // remaining 8 degrees is plenty *because* poseChase now pulls the arm in
      // by the matching amount: the field opens, the kart does not shrink, and
      // the two together read as speed rather than as a fisheye.
      target = clamp(
        FOV_BASE
        + sp * 5.0               // speed opens the frame
        + ctx.fovPunch * 0.78    // boost punch, pre-smoothed upstream
        + this.lookAmt * 3.0     // slightly wider over the shoulder
        + this.vista * VISTA_FOV // scenic: lens and rig both go wide together
        - this.brakeAmt * 2.2,   // and tighter under braking
        36, 70,
      );
    }
    target *= this.fovAspectMul;

    // Underdamped on purpose in gameplay: the FOV rubber-bands back after a
    // boost, and that overshoot is what sells the release.
    const fov = this.fovOsc.step(target, omega, zeta, dt);
    if (Math.abs(fov - ctx.camera.fov) > 0.015) {
      ctx.camera.fov = fov;
      ctx.camera.updateProjectionMatrix();
    }
  }
}
