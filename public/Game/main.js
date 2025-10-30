(() => {
    // ============================================================
    // Canvas + DPI/resize
    // ============================================================
    const world = document.getElementById('world');
    const hud = document.getElementById('hud');
    const wctx = world.getContext('2d');
    const hctx = hud.getContext('2d');

    let dpr = 1, cw = 0, ch = 0;        // CSS pixels
    let vw = 0, vh = 0;                 // device pixels
    let PPU = 1.5;                      // pixels-per-world-unit (zoom)
    const GRID = { gap: 20, thickEvery: 5 }; // world units

    // --- Sprite preload ---
    const jetSprite = new Image();
    jetSprite.src = '/Images/placeholder_player.png'; // <-- your file path
    let jetReady = false;
    jetSprite.onload = () => { jetReady = true; };


    function resize() {
        cw = world.clientWidth;
        ch = world.clientHeight;
        dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2)); // cap DPR if you like

        vw = Math.floor(cw * dpr);
        vh = Math.floor(ch * dpr);

        // size both canvases
        for (const c of [world, hud]) {
            c.width = vw; c.height = vh;  // backing store in device px
            c.style.width = cw + 'px';     // CSS size
            c.style.height = ch + 'px';
        }

        // draw at CSS pixel units: scale once, per frame we’ll reset + apply transforms
        // (we'll always start frames with ctx.setTransform(dpr,0,0,dpr,0,0))
    }
    window.addEventListener('resize', resize, { passive: true });
    resize();

    // ============================================================
    // World model (authoritative, screen-size independent)
    // ============================================================
    const player = {
        id: 'local',
        pos: { x: 0, y: 0 },     // world units
        heading: 0,              // radians (0° = North, clockwise positive)
        speed: 14,               // world units / second
        targetSpeed: 14,
        minSpeed: 6,
        maxSpeed: 40,
        accel: 30,               // how quickly W/S changes speed
        // turning via radius (smaller radius = tighter turns)
        minRadius: 7,            // tightest possible turn
        maxRadius: 120,          // straight-ish flight
        turnDemand: 0,           // -1..+1 (set by mouse movement)
        turnDecay: 2.5,          // returns demand toward 0 when mouse stops (per second)
        rollSway: 0,             // visual bank angle for HUD sprite
    };

    // Camera follows the player; same world view regardless of monitor size.
    const camera = {
        x: 0, y: 0,
        stiffness: 6.0,   // spring toward player
        // zoom could be dynamic per HUD if you want—keep fixed here for consistent feel.
    };

    // ============================================================
    // Input: W/S speed, mouse movement => turnDemand
    // ============================================================
    const keys = new Set();
    window.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        if (e.code === 'KeyW' || e.code === 'KeyS') e.preventDefault();
        keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
        keys.delete(e.code);
    });

    // Pointer lock (optional but makes "mouse movement controls turn" feel great)
    world.addEventListener('click', () => {
        if (document.pointerLockElement !== world) world.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
        // no-op; we read movementX when locked; otherwise we infer from cursor position
    });

    // Turn control: movementX (locked) accumulates into [-1,1].
    let mouse = { x: cw / 2, y: ch / 2 };
    window.addEventListener('mousemove', (e) => {
        if (document.pointerLockElement === world) {
            // scale movement into demand; tune sensitivity as needed
            const sens = 0.0035; // demand per px moved
            player.turnDemand = clamp(player.turnDemand + e.movementX * sens, -1, 1);
        } else {
            // Without pointer lock, infer demand from cursor distance from center (x only)
            mouse.x = e.clientX;
            const centerX = cw * 0.5;
            const t = clamp((mouse.x - centerX) / (centerX), -1, 1);
            player.turnDemand = t;
        }
    }, { passive: true });

    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

    // ============================================================
    // Fixed-timestep simulation
    // ============================================================
    let last = performance.now();
    let acc = 0;
    const FIXED_DT = 1 / 120;  // 120 Hz sim
    const MAX_ACC = 0.25;

    function loop(now) {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        acc = Math.min(MAX_ACC, acc + dt);

        // --- input -> target speed
        if (keys.has('KeyW')) player.targetSpeed = Math.min(player.maxSpeed, player.targetSpeed + player.accel * dt);
        if (keys.has('KeyS')) player.targetSpeed = Math.max(player.minSpeed, player.targetSpeed - player.accel * dt);

        // decay turn demand toward 0 (only when pointer-locked; without lock, we continuously map cursor X)
        if (document.pointerLockElement === world) {
            const sign = Math.sign(player.turnDemand);
            const mag = Math.max(0, Math.abs(player.turnDemand) - player.turnDecay * dt);
            player.turnDemand = sign * mag;
        }

        while (acc >= FIXED_DT) {
            step(FIXED_DT);
            acc -= FIXED_DT;
        }

        render();
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    function step(dt) {
        // smooth speed to target
        const ds = player.targetSpeed - player.speed;
        player.speed += clamp(ds, -player.accel * dt, player.accel * dt);

        // map demand (-1..1) to a radius [maxRadius..minRadius]
        const demand = player.turnDemand;
        const ad = Math.abs(demand);
        const radius = lerp(player.maxRadius, player.minRadius, ad); // smaller radius = tighter turn
        const turnDir = Math.sign(demand) || 0;
        const omega = (turnDir === 0 || ad < 1e-4) ? 0 : (player.speed / radius) * turnDir; // rad/s

        // integrate heading and position
        player.heading += omega * dt;

        // forward vector from heading
        // const vx = Math.cos(player.heading);
        // const vy = Math.sin(player.heading);

        // Aviation-style: 0° = North (negative Y)
        const vx = Math.sin(player.heading);
        const vy = -Math.cos(player.heading);


        player.pos.x += vx * player.speed * dt;
        player.pos.y += vy * player.speed * dt;

        // camera spring to player
        const cx = player.pos.x - camera.x;
        const cy = player.pos.y - camera.y;
        camera.x += cx * (1 - Math.exp(-camera.stiffness * dt));
        camera.y += cy * (1 - Math.exp(-camera.stiffness * dt));

        // visual roll sway for HUD sprite (bank into the turn)
        const targetSway = clamp(-turnDir * ad, -1, 1);
        player.rollSway += (targetSway - player.rollSway) * (1 - Math.exp(-8 * dt));
    }

    function lerp(a, b, t) { return a + (b - a) * t; }

    // ============================================================
    // Rendering
    // ============================================================
    function render() {
        // reset transforms into CSS pixel space
        wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        hctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // clear
        wctx.clearRect(0, 0, cw, ch);
        hctx.clearRect(0, 0, cw, ch);

        // WORLD transform: center screen at camera, scale world->pixels by PPU
        wctx.save();
        wctx.translate(cw * 0.5, ch * 0.5);
        wctx.scale(PPU, PPU);
        wctx.translate(-camera.x, -camera.y);

        drawGrid(wctx);
        drawPlayer(wctx, player);

        // (later) draw other players using the same world transform
        // e.g., for (const p of others) drawPlayer(wctx, p);

        wctx.restore();

        drawHUD(hctx);
    }

    function drawGrid(ctx) {
        // The grid is defined in world units and rendered relative to camera,
        // so it’s stable across all DPIs and screen sizes.
        const gap = GRID.gap;
        const halfW = (cw * 0.5) / PPU;
        const halfH = (ch * 0.5) / PPU;

        const left = camera.x - halfW;
        const right = camera.x + halfW;
        const top = camera.y - halfH;
        const bottom = camera.y + halfH;

        const startX = Math.floor(left / gap) * gap;
        const startY = Math.floor(top / gap) * gap;

        const cols = Math.ceil((right - left) / gap) + 2;
        const rows = Math.ceil((bottom - top) / gap) + 2;

        ctx.lineWidth = 1 / PPU;

        for (let i = 0; i < cols; i++) {
            const x = startX + i * gap;
            const isThick = (Math.round(x / gap) % GRID.thickEvery) === 0;
            ctx.strokeStyle = isThick ? 'rgba(70, 120, 160, 0.25)' : 'rgba(80, 100, 120, 0.15)';
            ctx.beginPath();
            ctx.moveTo(x, top - gap);
            ctx.lineTo(x, bottom + gap);
            ctx.stroke();
        }
        for (let j = 0; j < rows; j++) {
            const y = startY + j * gap;
            const isThick = (Math.round(y / gap) % GRID.thickEvery) === 0;
            ctx.strokeStyle = isThick ? 'rgba(70, 120, 160, 0.25)' : 'rgba(80, 100, 120, 0.15)';
            ctx.beginPath();
            ctx.moveTo(left - gap, y);
            ctx.lineTo(right + gap, y);
            ctx.stroke();
        }
    }

    function drawPlayer(ctx, p) {
        // Desired size in WORLD UNITS (same numbers you used before)
        const L = 4.0 * 10;   // fuselage length (world units)
        const W = 3.2 * 10;   // wingspan/width (world units)

        ctx.save();
        ctx.translate(p.pos.x, p.pos.y);

        // heading + bank sway
        ctx.rotate(p.heading + p.rollSway * 0.3);

        // --- Shadow (keep from your vector version, scaled to L/W) ---
        ctx.save();
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.ellipse(0.1, 0.3, W * 0.55, L * 0.18, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // --- Draw sprite (in WORLD units; camera transform will scale by PPU) ---
        if (jetReady) {
            // Optional: crisp vs smooth. Set false for pixel-art.
            ctx.imageSmoothingEnabled = true;

            ctx.save();

            // Anchor sprite at its center
            const x = -W * 0.5;
            const y = -L * 0.5;
            ctx.drawImage(jetSprite, x, y, W, L); // width=W, height=L (WU)
            ctx.restore();
        } else {
            // Fallback: your original vector glyph until the image loads
            ctx.fillStyle = '#7fb2ff';
            ctx.strokeStyle = '#d2e8ff';
            ctx.lineWidth = 1.2 / PPU;

            ctx.beginPath();
            ctx.moveTo(L * 0.55, 0);               // nose
            ctx.lineTo(0, W * 0.55);              // right wing tip
            ctx.lineTo(-L * 0.3, W * 0.25);           // right wing root
            ctx.lineTo(-L * 0.65, 0.12);            // tail right
            ctx.lineTo(-L * 0.85, 0);               // tail
            ctx.lineTo(-L * 0.65, -0.12);            // tail left
            ctx.lineTo(-L * 0.3, -W * 0.25);           // left wing root
            ctx.lineTo(0, -W * 0.55);              // left wing tip
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            // canopy
            ctx.fillStyle = '#1a324a';
            ctx.beginPath();
            ctx.ellipse(L * 0.15, 0, L * 0.18, L * 0.10, 0, 0, Math.PI * 2);
            ctx.fill();

            // nose sparkle
            ctx.fillStyle = 'rgba(255,255,255,0.75)';
            ctx.beginPath();
            ctx.arc(L * 0.48, 0, 0.06, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
    }


    function drawHUD(ctx) {
        // simple HUD overlay in screen space (CSS px)
        const pad = 14;
        const boxW = 230;
        const lineH = 18;

        // panel
        ctx.save();
        ctx.translate(pad, pad);
        roundedRect(ctx, 0, 0, boxW, 96, 10);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#a9c5de';
        ctx.font = '12px ui-sans-serif,system-ui,Segoe UI,Roboto,Inter,Arial,sans-serif';
        ctx.textBaseline = 'top';

        const speed = player.speed;
        const demand = player.turnDemand;
        const radius = lerp(player.maxRadius, player.minRadius, Math.abs(demand));
        const omega = (Math.abs(demand) < 1e-4) ? 0 : (speed / radius);
        const hdgDeg = ((player.heading * 180 / Math.PI) % 360 + 360) % 360; // 0..359, 0°=North

        let y = 10;
        ctx.fillText(`SPD: ${speed.toFixed(1)} u/s`, 12, y); y += lineH;
        ctx.fillText(`HDG: ${hdgDeg.toFixed(0)}°`, 12, y); y+= lineH;
        ctx.fillText(`TURN R: ${radius.toFixed(1)} u`, 12, y); y += lineH;
        ctx.fillText(`Ω: ${(omega * 180 / Math.PI).toFixed(2)} °/s`, 12, y);

        ctx.restore();

        // center reticle
        ctx.save();
        ctx.translate(cw * 0.5, ch * 0.5);
        ctx.strokeStyle = 'rgba(168, 230, 255, 0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(0, 0, 10, 0, Math.PI * 2);
        ctx.moveTo(-16, 0); ctx.lineTo(-6, 0);
        ctx.moveTo(16, 0); ctx.lineTo(6, 0);
        ctx.moveTo(0, -16); ctx.lineTo(0, -6);
        ctx.moveTo(0, 16); ctx.lineTo(0, 6);
        ctx.stroke();
        ctx.restore();

        // bottom bar (future: net stats, player name, etc.)
        ctx.save();
        const barH = 26;
        roundedRect(ctx, 12, ch - barH - 12, cw - 24, barH, 10);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fill();
        ctx.font = '12px ui-sans-serif,system-ui,Segoe UI,Roboto,Inter,Arial,sans-serif';
        ctx.fillStyle = '#a9c5de';
        ctx.textBaseline = 'middle';
        ctx.fillText('DOGFIGHT.IO — local sandbox • networking hooks ready', 22, ch - barH / 2 - 12 + barH / 2);
        ctx.restore();
    }

    function roundedRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function wrapAngle(a) {
        // wrap to [-PI, PI)
        a = (a + Math.PI) % (Math.PI * 2);
        if (a < 0) a += Math.PI * 2;
        return a - Math.PI;
    }

    // ============================================================
    // Networking Hooks (stubbed for later)
    // ============================================================
    // You’ll broadcast/receive world-space states like:
    // {
    //   id, pos:{x,y}, heading, speed, timestamp
    // }
    // Then:
    // - Interpolate remote players at render time.
    // - Keep all physics in world units; never in screen pixels.
    // - Don’t send screen size; it’s irrelevant with this camera model.
    // - Consider a fixed tick + client-side prediction for your own jet.
})();