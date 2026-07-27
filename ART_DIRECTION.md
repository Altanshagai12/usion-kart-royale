# Kart Royale — Art Direction Bible

**Every visual agent must obey this document.** It exists so that eleven people
working in parallel produce one coherent-looking game instead of eleven
tech demos. Where this document and your own taste disagree, this wins.

---

## 1. The course: **Sunset Bay Circuit**

A coastal Mediterranean circuit at golden hour. Think Amalfi cliffs crossed
with a Nintendo colour palette. One lap, in order:

| Section | t range | Content |
|---|---|---|
| Start straight | 0.00–0.10 | Wide harbour-front boulevard, banner arch over the start line, grandstand + crowd on the left, moored boats right |
| Harbour sweep | 0.10–0.22 | Long left-hander hugging the marina, glass-calm water, mooring posts, gulls |
| Village climb | 0.22–0.38 | Rising esses through terraced pastel houses, laundry lines, flower boxes, cobble surface change |
| Cliff traverse | 0.38–0.52 | High narrow ledge, sheer drop to the sea on the right, no guardrail (just kerb + posts), sun low and directly ahead |
| Tunnel | 0.52–0.60 | Cut through rock, warm sodium strip lights, boost pads, strong exit bloom |
| Beach descent | 0.60–0.74 | Fast downhill onto sand-lined tarmac, palms, parasols, tide line, sand off-track |
| Banked coastal curve | 0.74–0.86 | Big 20° banked 180°, the money shot — full bay visible below |
| Bridge & return | 0.86–1.00 | Arched stone bridge over an inlet, windmill on the headland, back to the harbour |

Track is ~1600 m of centreline. Road half-width 9–13 m, narrowing on the cliff.

### Elevation
Sea level at the harbour, +42 m at the cliff apex, back to +4 m at the beach.
Never flat for more than 120 m. Banking up to 20° on the coastal curve, 6–10°
on the harbour sweep, negative (off-camber) 4° on one village corner to punish
a greedy line.

---

## 2. Lighting: golden hour, 14° sun elevation

This is non-negotiable and it is the single biggest reason the game will read
as expensive. Everything downstream keys off it.

- **Sun azimuth**: low and roughly west, so the cliff traverse looks straight
  into it. Direction toward sun ≈ `normalize(-0.62, 0.245, -0.745)`.
- **Sun colour** `#ffd9a8`, intensity ~4.2 (physical-ish, tone mapped).
- **Sky colour** at zenith `#3f74c4`, horizon `#ffd0a0`, with a warm bloom
  around the sun disc. Rayleigh + Mie, not a gradient texture.
- **Bounce**: warm sand/stone bounce from below (`#c98f5a`, weak), cool sky
  fill from above (`#a8c8ff`).
- **Ambient occlusion is mandatory** in every contact point — kart to road,
  prop to ground, kerb to tarmac. Nothing floats.
- **Shadows**: long, soft, warm-tinted penumbra. Cascades: 12 m / 45 m / 160 m /
  500 m. Shadow bias tuned so kart wheels show contact shadow, not acne.
- **Exposure** ~1.05 with ACES. Highlights on chrome and water must clip to
  white and bloom; that is the look.

### Colour grade
Warm highlights, teal-leaning shadows, slight S-curve, mild saturation lift
(1.12) with a **highlight desaturation rolloff** so bloom doesn't go neon.
Vignette 0.22. Very slight chromatic aberration at the frame edge only
(0.0012), scaling with speed.

---

## 3. Palette

Never use pure `#000` or pure `#fff` in albedo. Nothing in the world is
fully desaturated.

| Role | Hex | Notes |
|---|---|---|
| Tarmac | `#4a4a52` | cool grey-violet, roughness 0.72, subtle aggregate normal |
| Tarmac wet/polish line | `#3e3e48` | racing line worn darker + smoother (0.55) |
| Kerb red | `#e0453f` | |
| Kerb white | `#f2ece0` | never `#ffffff` |
| Sand | `#e3c893` | |
| Grass | `#6f9b47` | with `#87b356` tips |
| Sea deep | `#0d5a7a` | |
| Sea shallow | `#3fc9c4` | |
| Sea foam | `#eefaff` | |
| Stone / cliff | `#a8927a` | |
| Village pastels | `#f2c9a0` `#e8a5a0` `#f5e2b0` `#a9c8d4` `#dcb8d8` | roofs `#b5643f` |
| Sky-warm | `#ffd0a0` | |
| Boost / mini-turbo blue | `#4fc3ff` | tier 1 |
| Mini-turbo orange | `#ff9d2e` | tier 2 |
| Mini-turbo purple | `#c05cff` | tier 3 |

---

## 4. Material standards (PBR, all procedural — no external files)

Every material must ship **albedo + normal + roughness (+ AO where it earns
it)**, generated procedurally into canvases and uploaded as textures. Flat
untextured `MeshStandardMaterial` is an automatic fail.

- Minimum texture resolution 1024² for anything the camera gets within 5 m of;
  512² beyond. Use `anisotropy = min(8, maxAnisotropy)` on all road surfaces.
- **Triplanar or correctly-tiled UVs.** No visible tiling repeat within a
  single camera frame — break it up with a second octave at a non-integer
  scale, or vertex-colour blending.
- Roughness must **vary spatially**. A constant roughness value reads as
  plastic and is the #1 tell of an amateur real-time scene.
- Metals: chrome trim on karts `metalness 1.0, roughness 0.15`, must sample the
  environment map. Painted bodywork: `metalness 0.0, roughness 0.28` with a
  **clearcoat** layer (`MeshPhysicalMaterial`, clearcoat 1, clearcoatRoughness
  0.06) — this is what makes the karts look like toys with real lacquer.
- Foliage: alpha-tested, two-sided, with **subsurface-ish** wrap lighting so
  leaves glow when backlit by the low sun. Palms backlit at golden hour is a
  hero moment — do not waste it.
- Water: animated normal from two scrolling octaves, screen-space-ish
  reflection or at minimum a mirrored env sample, Fresnel, depth-based colour
  ramp from `#3fc9c4` shallow to `#0d5a7a` deep, foam line where geometry
  intersects the shore.

---

## 5. The kart

Chunky Nintendo proportions, **not** a realistic go-kart. Wheels large relative
to the body (radius ≈ 0.36 m against a 2.1 m body). Visible driver figure with
helmet, hands on the wheel, head that leans into corners and looks toward the
apex. Exhaust stacks. A front bumper with a soft bevel. Chrome roll bar.

Detail budget: 6–12 k triangles per kart. Every edge chamfered — hard 90°
edges catch no specular and are the second-biggest amateur tell. Eight distinct
liveries from the roster colours, each with a secondary trim colour and a
decal, all procedurally generated.

Animation: wheels steer and spin, suspension compresses per-wheel, body rolls
into corners and pitches under braking/acceleration, driver leans and
counter-steers, and the whole kart **hops** on drift entry.

---

## 6. Effects — the readability layer

Arcade racers live or die on feedback. Each of these must be unmistakable at a
glance:

- **Drift sparks**: tier 1 blue, tier 2 orange, tier 3 purple. Emitted from
  both rear wheels, additive, with a bright core and a soft glow, plus a
  ground-scorch decal. Tier change = a flash + a burst.
- **Boost**: flame plume from the exhausts, radial speed lines, FOV punch,
  chromatic aberration ramp, motion blur increase, and a shockwave ring on
  activation.
- **Tyre smoke** on drift and **dust** off-track, colour-keyed to the surface
  (see `SURFACE_PROPS`). Soft, lit, and it must catch the sun.
- **Water spray** through the shallows, **sand kick-up** on the beach.
- **Speed lines** only above ~70% top speed, and subtle — they frame, they
  don't obscure.
- **Godrays** through the palms and out of the tunnel mouth.
- Impacts: screen shake, a stars ring, a squash-and-stretch on the chassis.

Everything additive must be **energy-conserving on screen**: if three effects
stack, the frame must not white out. Test the boost + drift + tunnel-exit case.

---

## 7. HUD

Clean, confident, readable at a glance, animated with real easing (no linear
tweens, no instant pops). Sits in the safe area with generous margins.

- Top-left: lap `1/3` with the lap number in a large weight, plus a lap-split
  flash when a lap completes.
- Top-right: race timer, monospaced digits so it doesn't jitter.
- Bottom-left: item box with the roulette spin, then a settle bounce.
- Bottom-right: speedometer — analogue arc, needle with slight overshoot, plus
  a digital readout.
- Left-centre: position `3rd` — big, with an ordinal suffix and a punch
  animation on change.
- Minimap: bottom-centre or top-centre, the true track path, player as a
  larger dot, rivals as smaller dots in their livery colours.
- Countdown: 3 / 2 / 1 / GO! with scale-and-fade, and a full-screen flash on GO.
- Everything must have a subtle drop shadow or outline so it survives over a
  bright sky.

**No default browser fonts at default weights.** Use a strong system stack with
explicit weights, letter-spacing and tabular numerals.

---

## 8. Performance budget

Target 60 fps at 1080p on an M-series Mac / RTX 3060 at `Quality.High`.

- ≤ 250 draw calls in a typical frame. **Instance everything repeated** —
  foliage, crowd, fence posts, kerb segments, buildings.
- Frustum-cull aggressively; LOD anything beyond 60 m.
- Particles pooled and instanced; zero per-frame allocation in the hot path.
- No `new THREE.Vector3()` inside `update()`. Use module-scope scratch objects.

---

## 9. What "AAA" means for review

A frame passes when all of these are true:

1. **Silhouette + composition** — you could read the scene at thumbnail size.
2. **Lighting tells a story** — clear key/fill/rim separation, warm/cool
   contrast, no flat ambient wash.
3. **Material variety** — at least five visibly distinct surface responses in
   frame, each with spatially varying roughness.
4. **Grounding** — every object has contact shadow and AO. Nothing floats.
5. **Depth** — foreground, midground, background all present, with aerial
   perspective (fog tinted toward the sky) separating them.
6. **No amateur tells** — no visible UV tiling, no z-fighting, no hard
   unchamfered edges, no uniform roughness, no pure-black shadows, no banding
   in the sky, no aliasing crawl on thin geometry.
7. **Motion & energy** — the frame looks like something is *happening*.
