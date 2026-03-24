# Changelog — Materealized Web

## 2026-03-23

### Text Input Added
- Added a fixed text input bar at the bottom of the screen so users can type memories instead of relying solely on voice
- Input hides during recording and generation, reappears after
- Event isolation prevents typing from triggering pan/zoom on the grid
- **Why:** Voice-only input excluded browsers without Web Speech API support and users who prefer typing

### Background Removal — Black Background (Reverted)
- Initially prompted Gemini for "pure black background" and used a luminance threshold (`lum < 30`) to zero out alpha on dark pixels
- **Problem:** Black is a common color in actual subjects (shadows, dark fur, dark furniture). The threshold ate into the subject itself, creating holes and harsh cutouts
- **Lesson:** Never use the subject's own likely colors as a chroma key

### Background Removal — Green Screen (Current)
- Switched prompt to "solid bright green (#00FF00) chroma-key background"
- Detection uses two metrics: `greenness = G - max(R, B) > 25` and `ratio = G / (R+G+B+1) > 0.36`
- **Why green over black:** Green is rarely present in natural/interior subjects, so the key doesn't eat into the object. Same reason film/TV uses green screens
- **Green spill/despill:** Gemini's green background bleeds into subject edges. Applied despill to ALL pixels — if a pixel's green channel exceeds max(R, B) + 10, green is reduced to `maxRB + (G - maxRB) * 0.3`. Earlier version only despilled semi-transparent edge pixels, which left visible green tint on fully opaque areas near the edge
- **Feather radius:** Started at 4, was too soft/blurry. Reduced to 2. The feather is a box blur applied to the binary mask (0=green, 1=subject) at the cutout boundary, so it only affects the transition zone between subject and background

### Particles — Edge Detection Rewrite
- **Before:** Particles were placed based on distance from the IMAGE CENTER. This meant they appeared uniformly around the edges of the frame, not the edges of the subject. A subject in the middle of the frame got particles all around it like a halo regardless of its shape
- **After:** Particles use the green-screen mask to compute a distance field from the actual subject boundary. Each subject pixel gets an `edgeProximity` score (1 = right at boundary, 0 = deep inside). Particles are heavily weighted toward high edgeProximity pixels
- **Lesson:** "Edge" must mean the subject's contour, not the image frame edge

### Particles — Color Fix (Additive → Normal Blending)
- **Before:** `THREE.AdditiveBlending` caused particles to wash out to white because additive blending ADDS color values together — overlapping colored particles all approach white
- **After:** Switched to `THREE.NormalBlending` so particles display their actual sampled color from the subject edge
- **Lesson:** Additive blending only looks good for glowing/emissive effects (fire, stars). For colored point clouds representing a physical object, use normal blending

### Particles — Noise-Based Turbulence
- **Before:** Simple sine/cosine waves made particles oscillate uniformly — looked mechanical and flat
- **After:** 3D noise field (hash-based pseudo-noise at 3 frequencies) drives displacement. Added curl-like swirl (cross-axis sine influence) for more organic flow
- Movement is controlled by the turbulence slider: low values = subtle drift, high values = particles swirl and scatter significantly
- **Lesson:** Sine waves are periodic and regular — noise fields produce the organic, unpredictable motion needed for natural-looking particle effects

### Post-Processing — Bloom (Added then Removed)
- Added `UnrealBloomPass` via Three.js EffectComposer
- **Problem:** EffectComposer creates opaque framebuffers by default — no alpha support. Even with `RGBAFormat` + `HalfFloatType` render targets and `clearAlpha = 0`, the bloom pass internally composites in a way that washes particle colors to white
- Tried raising threshold to 0.85, reducing strength — still white particles
- **Resolution:** Removed EffectComposer entirely. Render directly with `renderer.render()`. Particles finally showed their actual colors
- **Lesson:** Three.js EffectComposer does not play well with transparent canvases layered over HTML content. If you need bloom on a transparent overlay, you'd need a custom shader approach, not the stock UnrealBloomPass

### Green Screen Detection — Iteration
- First threshold: `greenness > 40, ratio > 0.4` — missed soft greens entirely
- Second threshold: `greenness > 25, ratio > 0.36` — still missed Gemini's softer green tones
- Final threshold: `greenness > 15, ratio > 0.34` + secondary catch `(g > 100 && greenness > 10 && ratio > 0.38)` — catches both bright and muted greens
- **Lesson:** Gemini doesn't generate pure #00FF00. The green backgrounds have significant variation. Need very aggressive detection with multiple criteria

### Dissolve Edge Effect
- Replaced hard feather blur with noise-based dissolve on the image mask
- Computes distance field from subject boundary, then uses 3-octave hash noise to randomly punch out pixels near the edge
- Deeper pixels have lower probability of being dissolved; edge pixels dissolve first
- Non-dissolved edge pixels get soft alpha falloff: `min(1, (noise - edgeFactor) * 3)`
- Controlled by dissolve slider (0 = clean edge, 100 = deep erosion)
- **Lesson:** `Math.sin(x * big + y * big) * huge % 1` can return negative values — use `(val - Math.floor(val))` for proper 0-1 hash noise

### Particles — Per-Particle Seeds
- **Before:** All particles used the same noise field sampled at their base position. Nearby particles got similar noise values → moved together like a "flock of birds"
- **After:** Each particle gets 3 random seeds: X phase offset, Y phase offset, frequency multiplier (0.7-1.3x). These offset where each particle samples the noise field, breaking up coherent motion
- **Lesson:** Noise fields produce correlated motion for nearby sample points. Per-particle random offsets decorrelate neighbors

### Particles — Multi-Octave Noise with Controls
- 3 controllable octaves: low freq (1.2, large shapes), mid freq (4.5, detail), high freq (10, jitter)
- Low freq always active; mid scales linearly with octaves slider; high scales quadratically (`oct * oct`)
- Swirl slider controls circular motion intensity + curl cross-axis coupling
- Auto-breathing: turbulence amplitude oscillates 60-100% via overlapping sine waves at 3 frequencies

### Particles — Subject Body Coverage
- 60% of particles edge-weighted (dissolving boundary effect)
- 40% sampled uniformly across entire subject body (so interior isn't empty)
- Edge particles get more turbulence displacement; body particles stay tighter

### Cage Sphere — Fresnel Edge Effect
- **Before:** Uniform opacity across all sphere particles → looked like a filled ball, not a hollow shell
- **After:** 3 concentric shells (radii 1.9, 2.0, 2.1) with per-particle Fresnel calculation
- Each particle stores its outward normal. Every frame: `dot(rotated_normal, view_direction)` determines if the particle faces the camera (center) or is edge-on (silhouette)
- Face-on particles: brightness 0.15 (nearly invisible). Edge-on particles: brightness 1.0 (bright)
- Creates the hollow-shell look: dense bright ring at edges, transparent center where the image sits
- Dual-axis rotation (Y primary + slow X tilt) for tumbling motion
- Cage is independent of subject particle sliders — only cage speed slider affects it
- **Lesson:** A hollow sphere of particles only reads as spherical when edge particles are brighter. This is the Fresnel effect — viewing angle determines apparent density

### Layout — Image Inside Sphere
- Cell `overflow: visible` so particles extend beyond cell boundaries
- Particle canvas sized to 150% of cell, offset -25% to center
- Camera pulled back to z=5 for wider field of view
- Image shrunk to 60% of cell and centered so it sits inside the cage sphere
- Subject particle scale reduced from 3.2 to 2.2 to fit within sphere radius
- `.cell-image.masked` at z-index 4 (above particles at z-index 3) so image composites on top

### Control Panel (Dev Sliders)
- Turbulence — base noise displacement amplitude
- Octaves (detail) — how much mid/high frequency noise is mixed in
- Swirl — circular motion + curl intensity
- Dissolve — noise erosion depth on image mask edge
- Cage speed — sphere rotation speed
- Feedback — lerp rate reduction (slower = more trailing)
- Particle size — point material size

### Missing Slider HTML Fix
- Three `wire()` calls referenced HTML elements that didn't exist: `ctrl-stream`/`v-stream`, `ctrl-clump`/`v-clump`, `ctrl-pole`/`v-pole`
- Calling `document.getElementById()` returned `null`, then `.addEventListener()` on `null` threw a TypeError and broke the entire app on load
- Added the missing slider HTML under the Cage Sphere section with matching defaults from the `params` object
- **Lesson:** Always verify DOM element IDs exist before wiring event listeners

### Cage Sphere — Organic Pole-Density Distribution
- **Before:** Fibonacci sphere gave perfectly even particle distribution — looked too uniform and mechanical
- **After:** Rejection sampling with latitude-based density weighting. `|cos(phi)|` (1 at poles, 0 at equator) raised to a steep power (1 + poleDensity × 10) controls acceptance probability
- At full pole density: equator accepts ~1% of particles, poles accept 100% — creates ~100× density ratio
- Particles still placed on the full sphere surface (not clustered at pole points), preserving the round silhouette
- **Lesson:** Rejection sampling with a steep power curve on latitude gives smooth density gradients without losing the sphere shape. Earlier attempts with separate cap/equator zones created visible bands and lost the spherical outline

### Cage Sphere — Organic Animation
- Replaced rigid Y-axis-only rotation with dual-axis motion: primary Y rotation + slow secondary X tilt (`sin(time * 0.07) * 0.15`) for wobble
- Per-particle surface flow: particles drift along the surface using unique seed-driven sine/cosine offsets (controlled by stream slider)
- Per-particle breathing with unique phase offsets instead of uniform pulsing
- Clump drift: nearby particles move together via low-frequency seed-correlated motion (controlled by clump slider)
- Random twinkle on brightness for sparkle variation
- **Lesson:** Per-particle random seeds (4 per particle: 3 phase offsets + 1 speed multiplier) are essential for breaking up coherent motion in large particle systems

### Cage Sphere — Fresnel Edge Boost
- Increased fresnel silhouette brightness: power lowered from 2.0 to 1.5, range expanded to 0.005–0.95
- Sphere boundary/rim is now much more visible, center faces nearly invisible
- Creates stronger hollow-shell appearance matching reference

### Subject Particles — Point Cloud Scan Aesthetic
- **Before:** Flat photo image with radial mask sat on top of particles — looked like a photo with effects behind it, not a 3D scan
- **After:** Photo image hidden (`opacity: 0`), particles are the sole visual for the subject
- Particle count increased from 25k to 60k to carry the subject alone
- Default particle size increased from 0.001 to 0.003
- Interior particles (low edge proximity) have near-zero scatter and flat z-depth — they pack tightly and read as the object
- Edge particles scatter into 3D with depth — point cloud feel at the boundaries
- `scatter = ep² × 0.18`, `z = zRaw × (0.05 + ep × 0.95)` — smooth gradient from flat core to scattered edges
- Interior particles also get reduced turbulence strength (`0.1 + ep × 0.9`) to keep the core stable

### Subject Particles — Surge Animation (Coalesce Effect)
- **Removed:** Periodic 2D↔3D glitch snap (too mechanical, wrong feel)
- **Added:** Turbulence/swirl surge system with two modes:
  - **Periodic surges:** Every ~8 seconds, turbulence and swirl automatically ramp up (random intensity 0.5–0.8) then smoothly decay back to calm. Creates organic breathing/disruption
  - **Generation coalesce:** When a new image is placed, surge starts at 1.0 (fully scattered) and slowly decays (0.008 rate) — particles appear chaotic then gradually come together into the subject form
- Surge adds to slider base values: `effectiveTurb = params.turbulence + surge × 0.8`, `effectiveSwirl = params.swirl + surge × 0.7`
- Octaves also boosted during surge (`+ surge × 0.5`) for more chaotic detail
- **Lesson:** Animating the control parameters themselves (turbulence, swirl) rather than adding separate animation systems keeps the motion consistent with the existing particle physics

### Control Panel — Updated Defaults
- Cage count slider: 80k default (up from 50k), max 150k
- Particle size slider: 0.003 default (up from 0.001)
- Subject particle count: 60k constant

---

## Key Lessons

1. **Don't use subject-likely colors as chroma keys.** Black background keying fails for any dark subject. Green is safe for most real-world objects.
2. **"Edge" in particle systems must reference the subject boundary, not the image frame.** Always compute edge proximity from a mask, not from pixel coordinates.
3. **Additive blending washes to white.** Use NormalBlending when particles need to show their actual color. Reserve AdditiveBlending for glowing effects (like the cage sphere).
4. **Feather/blur radius on masks should be small (1-3px).** Larger values create visible ghosting.
5. **Noise > sine waves for organic motion.** Multi-frequency noise with per-particle random seeds prevents "flocking" behavior.
6. **Three.js EffectComposer kills alpha.** Don't use it for transparent overlays on HTML content.
7. **Green screen thresholds must be very aggressive.** AI-generated green backgrounds are not pure #00FF00 — use multiple detection criteria.
8. **Hollow spheres need Fresnel opacity.** Per-particle `dot(normal, viewDir)` makes edge particles bright and center particles transparent, creating the visual density gradient of a shell.
9. **Deploy functions carefully.** Firebase skips unchanged functions — if only the compiled JS changed but the hash matches, add a config change to force re-upload.
10. **Cell overflow must be visible** for effects that extend beyond the grid cell boundaries.
