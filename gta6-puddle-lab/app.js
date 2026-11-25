(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    pitchDeg: 19.5, // -6 (up) .. +32 (down); sign leaves viewport around ~13 deg
    splitFrac: 0.5, // 0.08 .. 0.92
    viewMode: "split", // "ssr" | "split" | "rt"
    denoiser: true,
    autoTilt: false,
    autoPhase: 0,
    time: 0,
    // 4 Hardware Walls (Frame Budget Simulator)
    streaming: "directstorage", // "directstorage" | "pcie_cpu" | "vram_spill"
    crowdLevel: 3, // 1..4
    executeIndirect: true,
    reflMode: "rt_1spp", // "ssr" | "rt_1spp" | "path_traced"
    upscale: "upscaled_1440", // "native_4k" | "upscaled_1440" | "upscaled_1080"
  };

  // DOM refs
  const vpCanvas = document.getElementById("viewportCanvas");
  const vpCtx = vpCanvas.getContext("2d");
  const xrCanvas = document.getElementById("xrayCanvas");
  const xrCtx = xrCanvas.getContext("2d");
  const tlCanvas = document.getElementById("timelineCanvas");
  const tlCtx = tlCanvas.getContext("2d");

  const pitchSlider = document.getElementById("pitchSlider");
  const pitchReadout = document.getElementById("pitchReadout");
  const splitSlider = document.getElementById("splitSlider");
  const splitReadout = document.getElementById("splitReadout");
  const denoiserToggle = document.getElementById("denoiserToggle");
  const btnAutoTilt = document.getElementById("btnAutoTilt");

  const ssrStatusPill = document.getElementById("ssrStatusPill");
  const telSignVisible = document.getElementById("telSignVisible");
  const telSsrResult = document.getElementById("telSsrResult");
  const telRtResult = document.getElementById("telRtResult");

  const streamingSelect = document.getElementById("streamingSelect");
  const crowdSlider = document.getElementById("crowdSlider");
  const crowdReadout = document.getElementById("crowdReadout");
  const indirectToggle = document.getElementById("indirectToggle");
  const reflSelect = document.getElementById("reflSelect");
  const upscaleSelect = document.getElementById("upscaleSelect");

  const frameTimeVal = document.getElementById("frameTimeVal");
  const fpsVal = document.getElementById("fpsVal");
  const budgetStatusPill = document.getElementById("budgetStatusPill");
  const wall1Note = document.getElementById("wall1Note");
  const wall2Note = document.getElementById("wall2Note");
  const wall3Note = document.getElementById("wall3Note");
  const wall4Note = document.getElementById("wall4Note");

  // Deterministic pseudo-random noise tile for raw 1-SPP Ray Tracing view
  const noiseCanvas = document.createElement("canvas");
  noiseCanvas.width = 160;
  noiseCanvas.height = 100;
  const noiseCtx = noiseCanvas.getContext("2d");

  function refreshNoiseTile(frameTick) {
    const img = noiseCtx.createImageData(noiseCanvas.width, noiseCanvas.height);
    const d = img.data;
    let seed = (frameTick * 2654435761) >>> 0;
    for (let i = 0; i < d.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const v = (seed >>> 24) & 255;
      const bright = v > 175 ? 255 : v < 75 ? 0 : 120;
      d[i] = bright;
      d[i + 1] = bright;
      d[i + 2] = bright;
      d[i + 3] = v > 155 ? 115 : 42;
    }
    noiseCtx.putImageData(img, 0, 0);
  }

  // ---------------------------------------------------------------------------
  // Physics / Projection Math (Shared between Viewport & Side-View X-Ray)
  // ---------------------------------------------------------------------------
  // Unified optical model:
  //   Vertical FOV = 56 deg (half-FOV = 28 deg).
  //   Hero neon sign spans elevation +14 deg (bottom) to +23 deg (top) from camera eye.
  //   Upper frustum edge = 28 - pitchDeg.
  //   -> At pitchDeg = 5 deg, sign top touches y = 0.
  //   -> At pitchDeg = 14 deg, sign bottom exits y = 0 -> SSR drops to 0% on the exact pixel!
  const HALF_FOV_DEG = 28.0;
  const SIGN_BOTTOM_DEG = 14.0;
  const SIGN_TOP_DEG = 23.0;

  function computeSignVisibility(pitchDeg) {
    const upperRayDeg = HALF_FOV_DEG - pitchDeg;
    const lowerRayDeg = -HALF_FOV_DEG - pitchDeg;
    const visibleFrac = clamp((upperRayDeg - SIGN_BOTTOM_DEG) / (SIGN_TOP_DEG - SIGN_BOTTOM_DEG), 0, 1);
    return {
      upperRayDeg,
      lowerRayDeg,
      visibleFrac,
      fullyClipped: visibleFrac <= 0.02,
      partial: visibleFrac > 0.02 && visibleFrac < 0.98,
    };
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // ---------------------------------------------------------------------------
  // 4-Wall Frame Budget Model (Illustrative GPU Architecture Math)
  // ---------------------------------------------------------------------------
  const CROWD_LABELS = [
    "",
    "Sparse (400 agents)",
    "Medium (1,100 agents)",
    "High (2,400 agents)",
    "Vice City Rush Hour (4,500 agents)",
  ];

  function computeFrameBudget() {
    // Wall 1: Streaming / VRAM pressure
    let streamCpuMs = 0.6;
    let streamGpuMs = 0.8;
    let streamNote = "DirectStorage + GDeflate streams mipmaps straight to VRAM (~0.8 ms).";
    if (state.streaming === "pcie_cpu") {
      streamCpuMs = 3.2;
      streamGpuMs = 1.9;
      streamNote = "CPU decompression eats 3.2 ms and slows asset uploads across PCIe.";
    } else if (state.streaming === "vram_spill") {
      streamCpuMs = 2.4;
      streamGpuMs = 6.4;
      streamNote = "VRAM overflow spills textures to system RAM — PCIe stall blows past 16.67 ms!";
    }

    // Wall 2: Crowds & CPU Draw Submission
    const crowdBase = [0, 3.4, 5.8, 8.4, 12.2][state.crowdLevel];
    const drawSubmitMs = state.executeIndirect ? crowdBase * 0.42 : crowdBase * 1.48;
    const cpuTotalMs = 2.6 + streamCpuMs + drawSubmitMs;
    const wall2Text = state.executeIndirect
      ? `ExecuteIndirect keeps CPU submission compact (${cpuTotalMs.toFixed(1)} ms) so the GPU stays fed.`
      : `Legacy CPU draw-call loop spikes to ${cpuTotalMs.toFixed(1)} ms — leaving the GPU sitting IDLE!`;

    // Wall 4: Resolution scaling factor for shading & post
    let resFactor = 1.0;
    let pixelLabel = "3.69M px (1440p -> 4K)";
    let wall4Text = "Temporal upscaling shades 44% of 4K pixels and reconstructs edges via motion vectors.";
    if (state.upscale === "native_4k") {
      resFactor = 1.92;
      pixelLabel = "8.29M px (Native 4K)";
      wall4Text = "Native 4K = ~498 million pixels/sec at 60 FPS — nearly doubles shading & RT cost!";
    } else if (state.upscale === "upscaled_1080") {
      resFactor = 0.62;
      pixelLabel = "2.07M px (1080p -> 4K)";
      wall4Text = "Performance mode shades just 25% of 4K pixels, creating massive headroom for RT.";
    }

    // Wall 3: Reflections & Lighting GPU cost
    let reflMs = 1.1 * resFactor;
    let wall3Text = "SSR reuses screen pixels (~1.1 ms) — blazing fast, but blind to anything off-screen.";
    if (state.reflMode === "rt_1spp") {
      reflMs = (state.denoiser ? 3.5 : 2.9) * (0.55 + 0.45 * resFactor);
      wall3Text = state.denoiser
        ? "Hardware 2-level BVH (1 SPP) + spatiotemporal denoiser keeps off-screen reflections solid."
        : "Raw 1-SPP hardware RT hits off-screen geometry, but without a denoiser it looks grainy.";
    } else if (state.reflMode === "path_traced") {
      reflMs = 11.8 * (0.55 + 0.45 * resFactor);
      wall3Text = "Multi-bounce path tracing is cinema-grade, but brutal on a 16.67 ms 60 FPS clock.";
    }

    const geomShadeMs = 4.6 * resFactor;
    const postMs = (state.upscale === "native_4k" ? 1.0 : 1.7) + (state.denoiser && state.reflMode !== "ssr" ? 0.6 : 0);
    const gpuWorkMs = streamGpuMs + geomShadeMs + reflMs + postMs;

    // Frame pipelining: GPU starts slightly staggered (1.8ms) or stalls waiting on CPU!
    const gpuStartOffset = state.executeIndirect ? 1.6 : Math.max(1.8, cpuTotalMs - 5.2);
    const gpuFinishMs = gpuStartOffset + gpuWorkMs;
    const totalMs = Math.max(cpuTotalMs, gpuFinishMs);
    const cpuBottlenecked = cpuTotalMs > gpuWorkMs + 1.4;
    const fps = 1000 / Math.max(1, totalMs);

    return {
      cpuTotalMs,
      streamCpuMs,
      drawSubmitMs,
      streamGpuMs,
      geomShadeMs,
      reflMs,
      postMs,
      gpuWorkMs,
      gpuStartOffset,
      gpuFinishMs,
      totalMs,
      fps,
      cpuBottlenecked,
      pixelLabel,
      notes: { streamNote, wall2Text, wall3Text, wall4Text },
    };
  }

  // ---------------------------------------------------------------------------
  // Render 1: Live Vice City Viewport (SSR Left vs Ray Traced Right)
  // ---------------------------------------------------------------------------
  function drawViceCityHalf(ctx, w, h, mode, vis, t) {
    // Unified vertical projection matching computeSignVisibility & renderXray (56 deg vFOV)
    const pxPerDeg = h / (HALF_FOV_DEG * 2);
    const yOfElev = (elevDeg) => h * 0.5 - (elevDeg + state.pitchDeg) * pxPerDeg;
    const horizonY = yOfElev(0);

    // 1. Dusk sky gradient
    const sky = ctx.createLinearGradient(0, Math.min(0, horizonY - 260), 0, Math.max(h * 0.55, horizonY + 40));
    sky.addColorStop(0, "#090c1b");
    sky.addColorStop(0.45, "#1b1433");
    sky.addColorStop(0.78, "#561d4a");
    sky.addColorStop(1, "#e85d4a");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, Math.max(0, horizonY + 8));

    // Distant skyline silhouettes
    ctx.fillStyle = "#0c1021";
    const buildings = [
      [0.03, 0.11, 130], [0.14, 0.10, 175], [0.25, 0.08, 120],
      [0.64, 0.11, 165], [0.76, 0.09, 210], [0.86, 0.12, 145],
    ];
    for (const [bx, bw, bh] of buildings) {
      ctx.fillRect(bx * w, horizonY - bh, bw * w, bh + 6);
    }

    // 2. Hero Art Deco Hotel + Glowing Neon Sign (exact elevation SIGN_BOTTOM_DEG..SIGN_TOP_DEG)
    const signTopY = yOfElev(SIGN_TOP_DEG);
    const signBotY = yOfElev(SIGN_BOTTOM_DEG);
    const signH = Math.max(40, signBotY - signTopY);
    const signW = 296;
    const signX = w * 0.5 - signW / 2;
    const signY = signTopY;

    const hotelW = w * 0.36;
    const hotelX = w * 0.32;
    const hotelTop = signTopY - 24;
    const hotelH = Math.max(40, horizonY - hotelTop);
    ctx.fillStyle = "#12182d";
    ctx.fillRect(hotelX, hotelTop, hotelW, hotelH + 4);
    ctx.strokeStyle = "#263459";
    ctx.lineWidth = 2;
    ctx.strokeRect(hotelX, hotelTop, hotelW, hotelH);

    // Subtle Art Deco hotel windows below the neon sign
    ctx.fillStyle = "rgba(56, 189, 248, 0.22)";
    for (let row = 0; row < 4; row++) {
      const wy = signBotY + 18 + row * 28;
      if (wy + 13 > horizonY - 4) break;
      for (let col = 0; col < 6; col++) {
        const wx = hotelX + 24 + col * ((hotelW - 48) / 6);
        ctx.fillRect(wx, wy, 26, 13);
      }
    }

    const flicker = 0.94 + 0.06 * Math.sin(t * 7.5);

    ctx.save();
    ctx.shadowColor = "#f43f5e";
    ctx.shadowBlur = 26;
    ctx.fillStyle = "rgba(18, 8, 28, 0.94)";
    ctx.strokeStyle = `rgba(244, 63, 94, ${flicker})`;
    ctx.lineWidth = 3.5;
    roundRect(ctx, signX, signY, signW, signH, 10);
    ctx.fill();
    ctx.stroke();

    ctx.shadowColor = "#38bdf8";
    ctx.shadowBlur = 14;
    ctx.strokeStyle = "rgba(56, 189, 248, 0.9)";
    ctx.lineWidth = 1.6;
    roundRect(ctx, signX + 7, signY + 7, signW - 14, signH - 14, 6);
    ctx.stroke();

    ctx.shadowColor = "#f43f5e";
    ctx.shadowBlur = 18;
    ctx.fillStyle = "#ff4d7d";
    ctx.font = "900 32px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("OCEAN VICE", w * 0.5, signY + signH * 0.56);

    ctx.shadowColor = "#38bdf8";
    ctx.shadowBlur = 10;
    ctx.fillStyle = "#7dd3fc";
    ctx.font = "800 13px Consolas, monospace";
    ctx.fillText("HOTEL  //  NEON STRIP", w * 0.5, signY + signH * 0.82);
    ctx.restore();

    // Palm tree silhouettes flanking the street
    drawPalm(ctx, w * 0.14, horizonY + 8, 130, 1);
    drawPalm(ctx, w * 0.86, horizonY + 8, 138, -1);

    // 3. Wet Asphalt Street Plane
    const roadTop = Math.max(-20, horizonY);
    const roadGrad = ctx.createLinearGradient(0, roadTop, 0, h);
    roadGrad.addColorStop(0, "#121828");
    roadGrad.addColorStop(0.45, "#0d1320");
    roadGrad.addColorStop(1, "#080c15");
    ctx.fillStyle = roadGrad;
    ctx.fillRect(0, roadTop, w, h - roadTop);

    // Perspective lane lines
    ctx.strokeStyle = "rgba(250, 204, 21, 0.34)";
    ctx.lineWidth = 3;
    ctx.setLineDash([22, 18]);
    ctx.beginPath();
    ctx.moveTo(w * 0.5, roadTop + 8);
    ctx.lineTo(w * 0.5, h);
    ctx.stroke();
    ctx.setLineDash([]);

    // Curb edges
    ctx.strokeStyle = "rgba(56, 189, 248, 0.25)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w * 0.34, roadTop);
    ctx.lineTo(w * 0.04, h);
    ctx.moveTo(w * 0.66, roadTop);
    ctx.lineTo(w * 0.96, h);
    ctx.stroke();

    // 4. THE HERO RAIN PUDDLE (Positioned at -22 deg elevation so tilting down centers the puddle)
    const puddleCX = w * 0.5;
    const puddleCY = clamp(yOfElev(-22), h * 0.44, h * 0.78);
    const puddleRX = w * 0.33;
    const puddleRY = h * 0.165;

    ctx.save();
    // Organic wet puddle silhouette
    ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const wobble = 1 + 0.06 * Math.sin(a * 3 + 0.8) + 0.04 * Math.cos(a * 5 - 0.5);
      const px = puddleCX + Math.cos(a) * puddleRX * wobble;
      const py = puddleCY + Math.sin(a) * puddleRY * wobble;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();

    // Base flat dark water (what you fall back to when SSR misses!)
    const waterBase = ctx.createRadialGradient(puddleCX, puddleCY, 12, puddleCX, puddleCY, puddleRX);
    waterBase.addColorStop(0, "#1d2638");
    waterBase.addColorStop(0.75, "#151c2a");
    waterBase.addColorStop(1, "#0d121d");
    ctx.fillStyle = waterBase;
    ctx.fill();
    ctx.clip();

    // Determine reflection strength:
    //   - SSR depends strictly on `vis.visibleFrac` (vanishes the instant sign crosses y=0!)
    //   - RT always sees the off-screen sign via the 2-level BVH!
    const reflStrength = mode === "ssr" ? vis.visibleFrac : 1.0;

    if (reflStrength > 0.02) {
      ctx.save();
      ctx.globalAlpha = reflStrength * 0.92;

      // Ambient magenta/cyan neon bloom in water
      const glow = ctx.createRadialGradient(puddleCX, puddleCY - 6, 10, puddleCX, puddleCY, puddleRX * 0.85);
      glow.addColorStop(0, "rgba(244, 63, 94, 0.55)");
      glow.addColorStop(0.42, "rgba(56, 189, 248, 0.32)");
      glow.addColorStop(1, "rgba(12, 18, 32, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(puddleCX - puddleRX, puddleCY - puddleRY, puddleRX * 2, puddleRY * 2);

      // Mirrored inverted neon sign inside the puddle with gentle water ripple
      ctx.translate(puddleCX, puddleCY + 4);
      ctx.scale(1, -0.78);
      const rippleX = Math.sin(t * 3.1) * 2.5;
      ctx.strokeStyle = `rgba(244, 63, 94, ${0.85 * flicker})`;
      ctx.lineWidth = 3;
      roundRect(ctx, -135 + rippleX, -34, 270, 68, 8);
      ctx.stroke();

      ctx.strokeStyle = "rgba(56, 189, 248, 0.72)";
      ctx.lineWidth = 1.5;
      roundRect(ctx, -128 - rippleX * 0.5, -27, 256, 54, 5);
      ctx.stroke();

      ctx.fillStyle = "#ff5c8a";
      ctx.font = "900 30px 'Segoe UI', Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("OCEAN VICE", rippleX, 8);

      ctx.fillStyle = "#7dd3fc";
      ctx.font = "800 12px Consolas, monospace";
      ctx.fillText("HOTEL  //  NEON STRIP", -rippleX * 0.6, 25);
      ctx.restore();

      // If RT mode AND denoiser is OFF, overlay realistic 1-SPP Monte Carlo ray speckle!
      if (mode === "rt" && !state.denoiser) {
        ctx.save();
        ctx.globalCompositeOperation = "overlay";
        ctx.globalAlpha = 0.72;
        const pat = ctx.createPattern(noiseCanvas, "repeat");
        ctx.fillStyle = pat;
        ctx.fillRect(puddleCX - puddleRX, puddleCY - puddleRY, puddleRX * 2, puddleRY * 2);
        ctx.restore();
      }
    } else if (mode === "ssr") {
      // Flat grey fallback + subtle SSR miss scanlines so viewer sees WHY it went blank
      ctx.strokeStyle = "rgba(244, 63, 94, 0.28)";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([6, 8]);
      for (let rx = -140; rx <= 140; rx += 56) {
        ctx.beginPath();
        ctx.moveTo(puddleCX + rx, puddleCY + 24);
        ctx.lineTo(puddleCX + rx * 0.8, puddleCY - puddleRY);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      ctx.fillStyle = "rgba(253, 164, 175, 0.9)";
      ctx.font = "800 14px Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText("SSR SCREEN-SPACE MISS (SIGN OFF-SCREEN)", puddleCX, puddleCY + 5);
    }

    // Subtle raindrop ripples on puddle surface
    for (let r = 0; r < 3; r++) {
      const p = (t * 0.55 + r * 0.33) % 1;
      const rx = puddleCX + (r - 1) * 115;
      const ry = puddleCY + (r % 2 === 0 ? -16 : 22);
      ctx.strokeStyle = `rgba(186, 230, 253, ${(1 - p) * 0.35})`;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.ellipse(rx, ry, 8 + p * 38, 3 + p * 12, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();

    // Puddle crisp rim specular
    ctx.strokeStyle = mode === "rt" ? "rgba(56, 189, 248, 0.45)" : "rgba(148, 163, 184, 0.3)";
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const wobble = 1 + 0.06 * Math.sin(a * 3 + 0.8) + 0.04 * Math.cos(a * 5 - 0.5);
      const px = puddleCX + Math.cos(a) * puddleRX * wobble;
      const py = puddleCY + Math.sin(a) * puddleRY * wobble;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  }

  function renderViewport() {
    const w = vpCanvas.width;
    const h = vpCanvas.height;
    const vis = computeSignVisibility(state.pitchDeg);

    vpCtx.clearRect(0, 0, w, h);

    if (state.viewMode === "ssr") {
      drawViceCityHalf(vpCtx, w, h, "ssr", vis, state.time);
    } else if (state.viewMode === "rt") {
      drawViceCityHalf(vpCtx, w, h, "rt", vis, state.time);
    } else {
      const splitX = Math.round(w * state.splitFrac);
      // Left half: SSR
      vpCtx.save();
      vpCtx.beginPath();
      vpCtx.rect(0, 0, splitX, h);
      vpCtx.clip();
      drawViceCityHalf(vpCtx, w, h, "ssr", vis, state.time);
      vpCtx.restore();

      // Right half: Ray Tracing
      vpCtx.save();
      vpCtx.beginPath();
      vpCtx.rect(splitX, 0, w - splitX, h);
      vpCtx.clip();
      drawViceCityHalf(vpCtx, w, h, "rt", vis, state.time);
      vpCtx.restore();

      // Split curtain line & handle
      vpCtx.strokeStyle = "#ffffff";
      vpCtx.lineWidth = 2.5;
      vpCtx.beginPath();
      vpCtx.moveTo(splitX, 0);
      vpCtx.lineTo(splitX, h);
      vpCtx.stroke();

      vpCtx.fillStyle = "#070b14";
      vpCtx.strokeStyle = "#38bdf8";
      vpCtx.lineWidth = 2.5;
      vpCtx.beginPath();
      vpCtx.arc(splitX, h * 0.52, 18, 0, Math.PI * 2);
      vpCtx.fill();
      vpCtx.stroke();

      vpCtx.fillStyle = "#ffffff";
      vpCtx.font = "900 13px Consolas, monospace";
      vpCtx.textAlign = "center";
      vpCtx.fillText("<>", splitX, h * 0.52 + 4.5);
    }

    // Top Viewport Edge Boundary Indicator (makes the screen-space cutoff unmistakable!)
    vpCtx.fillStyle = vis.fullyClipped ? "rgba(244, 63, 94, 0.88)" : "rgba(56, 189, 248, 0.72)";
    vpCtx.fillRect(0, 0, w, 4);
    vpCtx.fillStyle = "rgba(7, 11, 20, 0.85)";
    vpCtx.fillRect(w * 0.5 - 195, 6, 390, 24);
    vpCtx.strokeStyle = vis.fullyClipped ? "#f43f5e" : "#38bdf8";
    vpCtx.lineWidth = 1.2;
    vpCtx.strokeRect(w * 0.5 - 195, 6, 390, 24);
    vpCtx.fillStyle = vis.fullyClipped ? "#fda4af" : "#7dd3fc";
    vpCtx.font = "800 11.5px Consolas, monospace";
    vpCtx.textAlign = "center";
    vpCtx.fillText(
      vis.fullyClipped
        ? "TOP SCREEN EDGE (y=0) // SIGN CLIPPED OFF-SCREEN"
        : "TOP SCREEN EDGE (y=0) // SIGN VISIBLE IN BUFFER",
      w * 0.5,
      22
    );

    // Side HUD Pills
    if (state.viewMode !== "rt") {
      drawCornerPill(
        vpCtx,
        14,
        42,
        "SSR (SCREEN-SPACE)",
        vis.fullyClipped ? "REFLECTION LOST" : vis.partial ? "PARTIAL CLIP" : "REFLECTING",
        vis.fullyClipped ? "#f43f5e" : "#fb923c",
        "left"
      );
    }
    if (state.viewMode !== "ssr") {
      drawCornerPill(
        vpCtx,
        w - 14,
        42,
        "RAY TRACING (2-LEVEL BVH)",
        state.denoiser ? "1 SPP + DENOISED" : "RAW 1 SPP (NOISY)",
        "#38bdf8",
        "right"
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Render 2: Side-View X-Ray Frustum & 2-Level BVH Diagram
  // ---------------------------------------------------------------------------
  function renderXray() {
    const w = xrCanvas.width;
    const h = xrCanvas.height;
    const vis = computeSignVisibility(state.pitchDeg);

    xrCtx.fillStyle = "#060a13";
    xrCtx.fillRect(0, 0, w, h);

    // Subtle engineering grid
    xrCtx.strokeStyle = "rgba(30, 45, 72, 0.45)";
    xrCtx.lineWidth = 1;
    for (let gx = 40; gx < w; gx += 48) {
      xrCtx.beginPath();
      xrCtx.moveTo(gx, 0);
      xrCtx.lineTo(gx, h);
      xrCtx.stroke();
    }
    for (let gy = 40; gy < h; gy += 48) {
      xrCtx.beginPath();
      xrCtx.moveTo(0, gy);
      xrCtx.lineTo(w, gy);
      xrCtx.stroke();
    }

    // World-to-canvas transform for side view (mathematically locked to SIGN_BOTTOM_DEG..SIGN_TOP_DEG!)
    const groundY = h - 92;
    const camX = 96;
    const camY = groundY - 90;
    const puddleX = 335;
    const hotelX = 565;
    const signX = 565;
    const dxSign = signX - camX;
    const signTopY = camY - Math.tan((SIGN_TOP_DEG * Math.PI) / 180) * dxSign;
    const signBotY = camY - Math.tan((SIGN_BOTTOM_DEG * Math.PI) / 180) * dxSign;
    const signMidY = (signTopY + signBotY) * 0.5;

    // Ground street line
    xrCtx.strokeStyle = "#334155";
    xrCtx.lineWidth = 3;
    xrCtx.beginPath();
    xrCtx.moveTo(24, groundY);
    xrCtx.lineTo(w - 24, groundY);
    xrCtx.stroke();

    // Hotel building cross-section + TLAS / BLAS 2-level BVH boxes!
    // Outer TLAS box (amber dashed)
    xrCtx.save();
    xrCtx.strokeStyle = "rgba(250, 204, 21, 0.72)";
    xrCtx.fillStyle = "rgba(250, 204, 21, 0.05)";
    xrCtx.lineWidth = 1.8;
    xrCtx.setLineDash([8, 5]);
    xrCtx.fillRect(hotelX - 24, signTopY - 26, 152, groundY - signTopY + 26);
    xrCtx.strokeRect(hotelX - 24, signTopY - 26, 152, groundY - signTopY + 26);
    xrCtx.setLineDash([]);
    xrCtx.fillStyle = "#facc15";
    xrCtx.font = "800 11px Consolas, monospace";
    xrCtx.fillText("TLAS // BLOCK_04", hotelX - 20, signTopY - 33);

    // Building core
    xrCtx.fillStyle = "#121b2e";
    xrCtx.strokeStyle = "#2b3e63";
    xrCtx.lineWidth = 2;
    xrCtx.fillRect(hotelX + 12, signTopY + 12, 98, groundY - (signTopY + 12));
    xrCtx.strokeRect(hotelX + 12, signTopY + 12, 98, groundY - (signTopY + 12));

    // Inner BLAS box around Neon Sign (cyan glow!)
    xrCtx.strokeStyle = "#38bdf8";
    xrCtx.fillStyle = "rgba(56, 189, 248, 0.12)";
    xrCtx.lineWidth = 2;
    xrCtx.fillRect(signX - 10, signTopY - 8, 42, signBotY - signTopY + 16);
    xrCtx.strokeRect(signX - 10, signTopY - 8, 42, signBotY - signTopY + 16);
    xrCtx.fillStyle = "#7dd3fc";
    xrCtx.font = "800 10.5px Consolas, monospace";
    xrCtx.fillText("BLAS // SIGN", signX - 10, signTopY - 14);

    // Glowing Neon Sign bar on facade
    xrCtx.shadowColor = "#f43f5e";
    xrCtx.shadowBlur = 18;
    xrCtx.fillStyle = "#f43f5e";
    xrCtx.fillRect(signX, signTopY, 12, signBotY - signTopY);
    xrCtx.restore();

    // Camera Frustum Cone (tilts live with state.pitchDeg!)
    const upperRad = (-vis.upperRayDeg * Math.PI) / 180;
    const lowerRad = (-vis.lowerRayDeg * Math.PI) / 180;
    const frustumLen = 620;
    const ux = camX + Math.cos(upperRad) * frustumLen;
    const uy = camY + Math.sin(upperRad) * frustumLen;
    const lx = camX + Math.cos(lowerRad) * frustumLen;
    const ly = camY + Math.sin(lowerRad) * frustumLen;

    xrCtx.save();
    xrCtx.beginPath();
    xrCtx.moveTo(camX, camY);
    xrCtx.lineTo(ux, uy);
    xrCtx.lineTo(lx, ly);
    xrCtx.closePath();
    const coneGrad = xrCtx.createLinearGradient(camX, camY, hotelX, camY);
    coneGrad.addColorStop(0, "rgba(56, 189, 248, 0.22)");
    coneGrad.addColorStop(1, "rgba(56, 189, 248, 0.04)");
    xrCtx.fillStyle = coneGrad;
    xrCtx.fill();

    // Top frustum boundary (Screen Top Edge!)
    xrCtx.strokeStyle = vis.fullyClipped ? "#f43f5e" : "#38bdf8";
    xrCtx.lineWidth = 2.4;
    xrCtx.setLineDash([7, 5]);
    xrCtx.beginPath();
    xrCtx.moveTo(camX, camY);
    xrCtx.lineTo(ux, uy);
    xrCtx.stroke();

    xrCtx.strokeStyle = "rgba(56, 189, 248, 0.45)";
    xrCtx.lineWidth = 1.6;
    xrCtx.beginPath();
    xrCtx.moveTo(camX, camY);
    xrCtx.lineTo(lx, ly);
    xrCtx.stroke();
    xrCtx.setLineDash([]);
    xrCtx.restore();

    // Label along top frustum edge
    const lblX = camX + Math.cos(upperRad) * 235;
    const lblY = camY + Math.sin(upperRad) * 235 - 10;
    xrCtx.fillStyle = vis.fullyClipped ? "#fda4af" : "#7dd3fc";
    xrCtx.font = "800 11px Consolas, monospace";
    xrCtx.fillText("TOP SCREEN EDGE (SSR LIMIT)", lblX, Math.max(28, lblY));

    // Puddle strip on road
    xrCtx.fillStyle = "#38bdf8";
    xrCtx.fillRect(puddleX - 58, groundY - 4, 116, 7);
    xrCtx.fillStyle = "#94a3b8";
    xrCtx.font = "700 11.5px Consolas, monospace";
    xrCtx.textAlign = "center";
    xrCtx.fillText("WET PUDDLE", puddleX, groundY + 22);
    xrCtx.textAlign = "left";

    // Primary View Ray: Camera -> Puddle
    xrCtx.strokeStyle = "#e2e8f0";
    xrCtx.lineWidth = 2.2;
    xrCtx.beginPath();
    xrCtx.moveTo(camX, camY);
    xrCtx.lineTo(puddleX, groundY - 2);
    xrCtx.stroke();

    // Reflected Ray (Hardware RT + 2-Level BVH): Puddle -> Off-Screen Neon Sign!
    const pulse = (state.time * 0.9) % 1;
    xrCtx.save();
    xrCtx.strokeStyle = "#38bdf8";
    xrCtx.shadowColor = "#38bdf8";
    xrCtx.shadowBlur = 10;
    xrCtx.lineWidth = 3;
    xrCtx.beginPath();
    xrCtx.moveTo(puddleX, groundY - 2);
    xrCtx.lineTo(signX, signMidY);
    xrCtx.stroke();

    // Animated photon packet travelling along the RT ray
    const phX = lerp(puddleX, signX, pulse);
    const phY = lerp(groundY - 2, signMidY, pulse);
    xrCtx.fillStyle = "#ffffff";
    xrCtx.beginPath();
    xrCtx.arc(phX, phY, 4.5, 0, Math.PI * 2);
    xrCtx.fill();

    // Hit starburst on neon sign
    xrCtx.fillStyle = "#34d399";
    xrCtx.beginPath();
    xrCtx.arc(signX, signMidY, 7, 0, Math.PI * 2);
    xrCtx.fill();
    xrCtx.restore();

    // If SSR is clipped, mark the exact intersection where the reflected ray exits the camera frustum!
    if (vis.fullyClipped || vis.partial) {
      const hitPt = rayIntersect(puddleX, groundY - 2, signX, signMidY, camX, camY, ux, uy);
      if (hitPt && hitPt.t >= 0 && hitPt.t <= 1) {
        xrCtx.save();
        xrCtx.strokeStyle = "#f43f5e";
        xrCtx.lineWidth = 2.6;
        xrCtx.beginPath();
        xrCtx.moveTo(hitPt.x - 9, hitPt.y - 9);
        xrCtx.lineTo(hitPt.x + 9, hitPt.y + 9);
        xrCtx.moveTo(hitPt.x + 9, hitPt.y - 9);
        xrCtx.lineTo(hitPt.x - 9, hitPt.y + 9);
        xrCtx.stroke();

        xrCtx.fillStyle = "rgba(15, 10, 22, 0.92)";
        xrCtx.strokeStyle = "#f43f5e";
        xrCtx.lineWidth = 1.4;
        roundRect(xrCtx, hitPt.x - 122, hitPt.y - 44, 178, 28, 6);
        xrCtx.fill();
        xrCtx.stroke();
        xrCtx.fillStyle = "#fda4af";
        xrCtx.font = "800 11px Consolas, monospace";
        xrCtx.fillText("SSR STOPS HERE (CLIPPED)", hitPt.x - 112, hitPt.y - 26);
        xrCtx.restore();
      }
    }

    // Camera icon
    xrCtx.save();
    xrCtx.translate(camX, camY);
    xrCtx.rotate((state.pitchDeg * Math.PI) / 180);
    xrCtx.fillStyle = "#1e293b";
    xrCtx.strokeStyle = "#38bdf8";
    xrCtx.lineWidth = 2;
    roundRect(xrCtx, -22, -13, 34, 26, 5);
    xrCtx.fill();
    xrCtx.stroke();
    xrCtx.beginPath();
    xrCtx.moveTo(12, -7);
    xrCtx.lineTo(24, -13);
    xrCtx.lineTo(24, 13);
    xrCtx.lineTo(12, 7);
    xrCtx.closePath();
    xrCtx.fillStyle = "#38bdf8";
    xrCtx.fill();
    xrCtx.restore();

    xrCtx.fillStyle = "#cbd5e1";
    xrCtx.font = "800 11.5px Consolas, monospace";
    xrCtx.fillText(`CAMERA (${state.pitchDeg.toFixed(1)} deg)`, camX - 42, camY + 34);

    // RT Hit callout badge
    xrCtx.fillStyle = "rgba(7, 18, 28, 0.92)";
    xrCtx.strokeStyle = "#34d399";
    xrCtx.lineWidth = 1.5;
    roundRect(xrCtx, signX - 188, signMidY - 16, 172, 30, 6);
    xrCtx.fill();
    xrCtx.stroke();
    xrCtx.fillStyle = "#6ee7b7";
    xrCtx.font = "800 11px Consolas, monospace";
    xrCtx.fillText("BVH RAY HIT (OFF-SCREEN)", signX - 178, signMidY + 3);

    // Legend footer inside X-ray canvas
    xrCtx.fillStyle = "#94a3b8";
    xrCtx.font = "700 11.5px Consolas, monospace";
    xrCtx.fillText("WHITE = Camera Ray   |   CYAN = Hardware BVH Ray   |   RED X = SSR Screen-Edge Cutoff", 22, h - 18);
  }

  // ---------------------------------------------------------------------------
  // Render 3: 16.67 ms Frame Budget Timeline (CPU vs GPU)
  // ---------------------------------------------------------------------------
  function renderTimeline(budget) {
    const w = tlCanvas.width;
    const h = tlCanvas.height;
    tlCtx.fillStyle = "#060a13";
    tlCtx.fillRect(0, 0, w, h);

    const padL = 138;
    const padR = 36;
    const plotW = w - padL - padR;
    const maxMs = Math.max(36, Math.ceil(budget.totalMs + 4));
    const xOf = (ms) => padL + (ms / maxMs) * plotW;

    // Vertical ms gridlines
    tlCtx.font = "700 11.5px Consolas, monospace";
    for (let ms = 0; ms <= maxMs; ms += 5) {
      const x = xOf(ms);
      tlCtx.strokeStyle = "rgba(30, 45, 72, 0.65)";
      tlCtx.lineWidth = 1;
      tlCtx.beginPath();
      tlCtx.moveTo(x, 24);
      tlCtx.lineTo(x, h - 26);
      tlCtx.stroke();
      tlCtx.fillStyle = "#64748b";
      tlCtx.textAlign = "center";
      tlCtx.fillText(`${ms} ms`, x, h - 8);
    }

    // Row tracks
    const cpuY = 44;
    const gpuY = 104;
    const barH = 40;

    tlCtx.textAlign = "left";
    tlCtx.fillStyle = "#e2e8f0";
    tlCtx.font = "800 13px Consolas, monospace";
    tlCtx.fillText("CPU THREAD", 18, cpuY + 25);
    tlCtx.fillText("GPU PIPELINE", 18, gpuY + 25);

    // Track wells
    tlCtx.fillStyle = "#0d1424";
    roundRect(tlCtx, padL, cpuY, plotW, barH, 6);
    tlCtx.fill();
    roundRect(tlCtx, padL, gpuY, plotW, barH, 6);
    tlCtx.fill();

    // CPU segments
    let cx = 0;
    const cpuSegs = [
      { label: "SIM / PHYSICS", ms: 2.6, color: "#6366f1" },
      { label: "STREAM", ms: budget.streamCpuMs, color: "#f59e0b" },
      { label: state.executeIndirect ? "INDIRECT" : "DRAW CALLS!", ms: budget.drawSubmitMs, color: state.executeIndirect ? "#38bdf8" : "#f43f5e" },
    ];
    for (const seg of cpuSegs) {
      drawTimelineBlock(tlCtx, xOf(cx), cpuY + 3, xOf(cx + seg.ms) - xOf(cx), barH - 6, seg.color, seg.label, seg.ms);
      cx += seg.ms;
    }

    // GPU Idle gap callout when CPU bottlenecks!
    if (budget.gpuStartOffset > 2.2) {
      const gx0 = xOf(0);
      const gx1 = xOf(budget.gpuStartOffset);
      tlCtx.save();
      tlCtx.fillStyle = "rgba(244, 63, 94, 0.16)";
      tlCtx.strokeStyle = "#f43f5e";
      tlCtx.setLineDash([5, 4]);
      tlCtx.fillRect(gx0, gpuY + 3, gx1 - gx0, barH - 6);
      tlCtx.strokeRect(gx0, gpuY + 3, gx1 - gx0, barH - 6);
      tlCtx.setLineDash([]);
      if (gx1 - gx0 > 74) {
        tlCtx.fillStyle = "#fda4af";
        tlCtx.font = "800 11px Consolas, monospace";
        tlCtx.textAlign = "center";
        tlCtx.fillText("GPU IDLE (WAITING ON CPU)", (gx0 + gx1) / 2, gpuY + 24);
      }
      tlCtx.restore();
    }

    // GPU segments
    let gx = budget.gpuStartOffset;
    const gpuSegs = [
      { label: "VRAM", ms: budget.streamGpuMs, color: "#f59e0b" },
      { label: "GEOM + SHADE", ms: budget.geomShadeMs, color: "#0ea5e9" },
      { label: state.reflMode === "ssr" ? "SSR" : state.reflMode === "rt_1spp" ? "RT BVH" : "PATH RT", ms: budget.reflMs, color: "#f43f5e" },
      { label: "UPSCALE/POST", ms: budget.postMs, color: "#10b981" },
    ];
    for (const seg of gpuSegs) {
      drawTimelineBlock(tlCtx, xOf(gx), gpuY + 3, xOf(gx + seg.ms) - xOf(gx), barH - 6, seg.color, seg.label, seg.ms);
      gx += seg.ms;
    }

    // 16.67 ms (60 FPS) & 33.33 ms (30 FPS) Deadline Lines
    drawDeadlineLine(tlCtx, xOf(16.67), 18, h - 24, "#f43f5e", "16.67 ms // 60 FPS BUDGET");
    drawDeadlineLine(tlCtx, xOf(33.33), 18, h - 24, "#fb923c", "33.33 ms // 30 FPS");
  }

  function drawTimelineBlock(ctx, x, y, w, h, color, label, ms) {
    if (w <= 1) return;
    ctx.save();
    ctx.fillStyle = color;
    roundRect(ctx, x + 1, y, Math.max(2, w - 2), h, 5);
    ctx.fill();
    if (w > 64) {
      ctx.fillStyle = "#060a13";
      ctx.font = "800 11px Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText(`${label} ${ms.toFixed(1)}ms`, x + w / 2, y + h / 2 + 4);
    } else if (w > 34) {
      ctx.fillStyle = "#060a13";
      ctx.font = "800 10px Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText(`${ms.toFixed(1)}`, x + w / 2, y + h / 2 + 4);
    }
    ctx.restore();
  }

  function drawDeadlineLine(ctx, x, y0, y1, color, label) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = color;
    ctx.font = "900 11px Consolas, monospace";
    ctx.textAlign = "center";
    ctx.fillText(label, x, y0 - 4);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Geometry & Drawing Helpers
  // ---------------------------------------------------------------------------
  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawPalm(ctx, baseX, baseY, height, leanDir) {
    ctx.save();
    ctx.strokeStyle = "#090d1a";
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    const topX = baseX + leanDir * 24;
    const topY = baseY - height;
    ctx.beginPath();
    ctx.moveTo(baseX, baseY);
    ctx.quadraticCurveTo(baseX + leanDir * 8, baseY - height * 0.55, topX, topY);
    ctx.stroke();

    ctx.lineWidth = 3.2;
    const angles = [-2.5, -1.9, -1.2, -0.5, 0.2, 0.7];
    for (const a of angles) {
      const fx = topX + Math.cos(a) * 52;
      const fy = topY + Math.sin(a) * 34 + 14;
      ctx.beginPath();
      ctx.moveTo(topX, topY);
      ctx.quadraticCurveTo(topX + Math.cos(a) * 26, topY + Math.sin(a) * 14 - 8, fx, fy);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawCornerPill(ctx, x, y, title, sub, color, align) {
    const w = 232;
    const h = 48;
    const dx = align === "right" ? x - w : x;
    ctx.save();
    ctx.fillStyle = "rgba(7, 11, 20, 0.88)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    roundRect(ctx, dx, y, w, h, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillRect(dx, y, 5, h);
    ctx.font = "900 12px Consolas, monospace";
    ctx.textAlign = "left";
    ctx.fillText(title, dx + 14, y + 20);
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "700 11px Consolas, monospace";
    ctx.fillText(sub, dx + 14, y + 37);
    ctx.restore();
  }

  function rayIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
    const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) < 1e-6) return null;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
    return { t, x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
  }

  // ---------------------------------------------------------------------------
  // UI Sync & Presets
  // ---------------------------------------------------------------------------
  function syncDomReadouts() {
    const vis = computeSignVisibility(state.pitchDeg);
    const pitchState = vis.fullyClipped ? "SIGN OFF-SCREEN" : vis.partial ? "CROSSING EDGE" : "SIGN IN VIEW";
    pitchReadout.textContent = `${state.pitchDeg.toFixed(1)}° (${pitchState})`;
    splitReadout.textContent = `${Math.round(state.splitFrac * 100)}%`;

    if (vis.fullyClipped) {
      ssrStatusPill.textContent = "SSR MISS // OFF-SCREEN";
      ssrStatusPill.classList.remove("ok");
      telSignVisible.textContent = "NO (CLIPPED ABOVE y = 0)";
      telSignVisible.classList.remove("tel-ok");
      telSsrResult.textContent = "MISS -> FALLBACK GREY";
      telSsrResult.classList.remove("tel-ok");
    } else if (vis.partial) {
      ssrStatusPill.textContent = "SSR PARTIAL // EDGE FADE";
      ssrStatusPill.classList.remove("ok");
      telSignVisible.textContent = `PARTIAL (${Math.round(vis.visibleFrac * 100)}% IN BUFFER)`;
      telSignVisible.classList.remove("tel-ok");
      telSsrResult.textContent = "FADING NEAR TOP EDGE";
      telSsrResult.classList.remove("tel-ok");
    } else {
      ssrStatusPill.textContent = "SSR HIT // SIGN IN BUFFER";
      ssrStatusPill.classList.add("ok");
      telSignVisible.textContent = "YES (100% IN SCREEN BUFFER)";
      telSignVisible.classList.add("tel-ok");
      telSsrResult.textContent = "HIT: COPIED SCREEN PIXELS";
      telSsrResult.classList.add("tel-ok");
    }

    telRtResult.textContent = state.denoiser
      ? "HIT: HOTEL_NEON_SIGN (1 SPP + DENOISED)"
      : "HIT: HOTEL_NEON_SIGN (RAW 1 SPP NOISY)";

    // Budget telemetry
    const budget = computeFrameBudget();
    crowdReadout.textContent = CROWD_LABELS[state.crowdLevel];
    frameTimeVal.textContent = `${budget.totalMs.toFixed(2)} ms`;
    fpsVal.textContent = `${budget.fps.toFixed(1)} FPS`;
    wall1Note.textContent = budget.notes.streamNote;
    wall2Note.textContent = budget.notes.wall2Text;
    wall3Note.textContent = budget.notes.wall3Text;
    wall4Note.textContent = budget.notes.wall4Text;

    budgetStatusPill.classList.remove("ok", "warn", "fail");
    if (budget.totalMs <= 16.67) {
      budgetStatusPill.textContent = "60 FPS LOCKED (<= 16.67 ms)";
      budgetStatusPill.classList.add("ok");
    } else if (budget.totalMs <= 33.33) {
      budgetStatusPill.textContent = budget.cpuBottlenecked
        ? "MISSED 60 FPS — CPU BOTTLENECK!"
        : "MISSED 60 FPS — GPU OVER BUDGET";
      budgetStatusPill.classList.add("warn");
    } else {
      budgetStatusPill.textContent = "SUB-30 FPS — FRAME BUDGET BLOWN";
      budgetStatusPill.classList.add("fail");
    }

    renderTimeline(budget);
  }

  function applyPreset(name) {
    state.autoTilt = false;
    btnAutoTilt.setAttribute("aria-pressed", "false");
    btnAutoTilt.textContent = "▶ Auto-Tilt Camera";

    if (name === "puddle-break") {
      state.pitchDeg = 19.5;
      state.viewMode = "split";
      state.splitFrac = 0.5;
      state.denoiser = true;
      state.streaming = "directstorage";
      state.crowdLevel = 3;
      state.executeIndirect = true;
      state.reflMode = "rt_1spp";
      state.upscale = "upscaled_1440";
    } else if (name === "puddle-intact") {
      state.pitchDeg = 2.0;
      state.viewMode = "split";
      state.splitFrac = 0.5;
      state.denoiser = true;
    } else if (name === "cpu-idle") {
      state.pitchDeg = 18.0;
      state.streaming = "pcie_cpu";
      state.crowdLevel = 4;
      state.executeIndirect = false;
      state.reflMode = "ssr";
      state.upscale = "upscaled_1080";
    } else if (name === "4k-meltdown") {
      state.pitchDeg = 21.0;
      state.streaming = "vram_spill";
      state.crowdLevel = 4;
      state.executeIndirect = true;
      state.reflMode = "path_traced";
      state.upscale = "native_4k";
    } else if (name === "balanced-60") {
      state.pitchDeg = 19.5;
      state.streaming = "directstorage";
      state.crowdLevel = 3;
      state.executeIndirect = true;
      state.reflMode = "rt_1spp";
      state.upscale = "upscaled_1440";
      state.denoiser = true;
    }

    // Sync controls to state
    pitchSlider.value = String(state.pitchDeg);
    splitSlider.value = String(Math.round(state.splitFrac * 100));
    denoiserToggle.checked = state.denoiser;
    streamingSelect.value = state.streaming;
    crowdSlider.value = String(state.crowdLevel);
    indirectToggle.checked = state.executeIndirect;
    reflSelect.value = state.reflMode;
    upscaleSelect.value = state.upscale;

    document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === state.viewMode));
    document.querySelectorAll(".chip[data-preset]").forEach((b) => b.classList.toggle("active", b.dataset.preset === name));
    syncDomReadouts();
  }

  // ---------------------------------------------------------------------------
  // Pointer Interaction Directly on the Vice City Canvas
  // ---------------------------------------------------------------------------
  let dragMode = null; // "split" | "pitch"
  let dragStartY = 0;
  let dragStartPitch = 0;

  vpCanvas.addEventListener("pointerdown", (e) => {
    const rect = vpCanvas.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    if (state.viewMode === "split" && Math.abs(relX - state.splitFrac) < 0.065) {
      dragMode = "split";
    } else {
      dragMode = "pitch";
      dragStartY = e.clientY;
      dragStartPitch = state.pitchDeg;
    }
    state.autoTilt = false;
    btnAutoTilt.setAttribute("aria-pressed", "false");
    btnAutoTilt.textContent = "▶ Auto-Tilt Camera";
    vpCanvas.setPointerCapture(e.pointerId);
  });

  vpCanvas.addEventListener("pointermove", (e) => {
    if (!dragMode) return;
    const rect = vpCanvas.getBoundingClientRect();
    if (dragMode === "split") {
      state.splitFrac = clamp((e.clientX - rect.left) / rect.width, 0.08, 0.92);
      splitSlider.value = String(Math.round(state.splitFrac * 100));
    } else if (dragMode === "pitch") {
      const dy = e.clientY - dragStartY;
      state.pitchDeg = clamp(dragStartPitch + dy * 0.14, -6, 32);
      pitchSlider.value = state.pitchDeg.toFixed(1);
    }
    syncDomReadouts();
  });

  vpCanvas.addEventListener("pointerup", () => {
    dragMode = null;
  });

  // Wire controls
  pitchSlider.addEventListener("input", () => {
    state.autoTilt = false;
    btnAutoTilt.setAttribute("aria-pressed", "false");
    btnAutoTilt.textContent = "▶ Auto-Tilt Camera";
    state.pitchDeg = parseFloat(pitchSlider.value);
    syncDomReadouts();
  });

  splitSlider.addEventListener("input", () => {
    state.splitFrac = parseFloat(splitSlider.value) / 100;
    syncDomReadouts();
  });

  denoiserToggle.addEventListener("change", () => {
    state.denoiser = denoiserToggle.checked;
    syncDomReadouts();
  });

  btnAutoTilt.addEventListener("click", () => {
    state.autoTilt = !state.autoTilt;
    btnAutoTilt.setAttribute("aria-pressed", String(state.autoTilt));
    btnAutoTilt.textContent = state.autoTilt ? "⏸ Pause Auto-Tilt" : "▶ Auto-Tilt Camera";
  });

  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.viewMode = btn.dataset.view;
      document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });

  document.querySelectorAll(".chip[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
  });

  streamingSelect.addEventListener("change", () => {
    state.streaming = streamingSelect.value;
    syncDomReadouts();
  });
  crowdSlider.addEventListener("input", () => {
    state.crowdLevel = parseInt(crowdSlider.value, 10);
    syncDomReadouts();
  });
  indirectToggle.addEventListener("change", () => {
    state.executeIndirect = indirectToggle.checked;
    syncDomReadouts();
  });
  reflSelect.addEventListener("change", () => {
    state.reflMode = reflSelect.value;
    syncDomReadouts();
  });
  upscaleSelect.addEventListener("change", () => {
    state.upscale = upscaleSelect.value;
    syncDomReadouts();
  });

  // ---------------------------------------------------------------------------
  // Main 60 FPS Animation Loop
  // ---------------------------------------------------------------------------
  let lastTs = 0;
  let frameTick = 0;
  function tick(ts) {
    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
    lastTs = ts;
    state.time += dt;
    frameTick += 1;

    if (state.autoTilt) {
      state.autoPhase += dt * 0.72;
      state.pitchDeg = 12.0 + Math.sin(state.autoPhase) * 14.5;
      pitchSlider.value = state.pitchDeg.toFixed(1);
      syncDomReadouts();
    }

    if (!state.denoiser && frameTick % 2 === 0) {
      refreshNoiseTile(frameTick);
    }

    renderViewport();
    renderXray();
    requestAnimationFrame(tick);
  }

  refreshNoiseTile(1);
  syncDomReadouts();
  requestAnimationFrame(tick);
})();
