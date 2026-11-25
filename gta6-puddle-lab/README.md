# Vice City Puddle Lab — Interactive GPU Companion (`NextGen Systems Lab`)

Zero-backend static HTML/Canvas simulator built as the playable companion to:
- **Flagship Episode #1:** *How GTA 6-Scale Cities Actually Fit Inside a GPU* — https://youtu.be/j2P7taYN5ww
- **Funnel Short #1:** *Why Game Reflections Vanish When You Look Down* — https://youtu.be/qaukQgnOY_A

## What Viewers Can Play With
1. **Tilt the Camera Down (Slider or Direct Drag):** Watch the glowing `OCEAN VICE` neon sign cross the top viewport edge (`y = 0`) and see **Screen-Space Reflections (SSR)** instantly vanish into flat grey water while **Hardware Ray Tracing (2-Level BVH)** keeps the reflection intact.
2. **Toggle the RT Denoiser:** See raw 1-SPP Monte Carlo speckle vs. denoised reflections live in the puddle.
3. **Side-View X-Ray Frustum & TLAS → BLAS Visualizer:** Shows the camera cone tilting away from the building and the exact red `X` where SSR clips at the screen edge while the cyan BVH ray hits off-screen geometry.
4. **Live `16.67 ms` (60 FPS) Frame-Budget Lab:** Interactive sliders for all 4 Hardware Walls (DirectStorage vs. VRAM spill, Crowds + `ExecuteIndirect` CPU bottleneck / GPU-idle gap, SSR vs. RT vs. Path Tracing, and Native 4K vs. DLSS/FSR/TSR).

## Deploy Free in 60 Seconds
No build step, no npm install, zero backend, zero external CDN dependencies:
- **Cloudflare Pages:** Drag-and-drop the `web_demos/gta6-puddle-lab/` folder into Cloudflare Pages (or connect the repo with Build Output Directory = `web_demos/gta6-puddle-lab`).
- **GitHub Pages:** Publish `web_demos/gta6-puddle-lab/` to a `gh-pages` branch or copy into `/docs` in a public companion repo.
- **Local Preview:** Double-click `index.html` or run `python -m http.server 8090 --directory web_demos/gta6-puddle-lab`.
