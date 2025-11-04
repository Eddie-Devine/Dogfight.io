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
    jetSprite.src = '/Images/placeholder_player.png';
    let jetReady = false;
    jetSprite.onload = () => { jetReady = true; };

    function resize() {
        cw = world.clientWidth;
        ch = world.clientHeight;
        dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));

        vw = Math.floor(cw * dpr);
        vh = Math.floor(ch * dpr);

        for (const c of [world, hud]) {
            c.width = vw; c.height = vh;
            c.style.width = cw + 'px';
            c.style.height = ch + 'px';
        }
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
        accel: 30,
        minRadius: 7,
        maxRadius: 120,
        turnDemand: 0,           // [-1..+1]
        turnDecay: 2.5,          // (unused without pointer lock, OK to keep)
        rollSway: 0,
    };

    const camera = { x: 0, y: 0, stiffness: 6.0 };

    // ============================================================
    // Input: W/S speed, mouse X => turnDemand
    // ============================================================
    const keys = new Set();
    window.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        if (e.code === 'KeyW' || e.code === 'KeyS') e.preventDefault();
        keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => { keys.delete(e.code); });

    // NO pointer-lock — mapping is from cursor X relative to center
    let mouse = { x: cw / 2, y: ch / 2 };
    window.addEventListener('mousemove', (e) => {
        mouse.x = e.clientX;
        const centerX = cw * 0.5;
        const t = clamp((mouse.x - centerX) / (centerX), -1, 1);
        player.turnDemand = t;
        uiTarget = t; // HUD knob mirrors the same value
    }, { passive: true });

    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

    // HUD turn knob smoothing (UI-only)
    let uiTurn = 0;      // what we draw
    let uiTarget = 0;    // desired knob position

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

        // input -> target speed
        if (keys.has('KeyW')) player.targetSpeed = Math.min(player.maxSpeed, player.targetSpeed + player.accel * dt);
        if (keys.has('KeyS')) player.targetSpeed = Math.max(player.minSpeed, player.targetSpeed - player.accel * dt);

        while (acc >= FIXED_DT) {
            step(FIXED_DT);
            acc -= FIXED_DT;
        }

        // ease the HUD knob toward live demand
        const uiEase = 12;
        uiTurn += (uiTarget - uiTurn) * (1 - Math.exp(-uiEase * dt));

        render();
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    function step(dt) {
        // smooth speed to target
        const ds = player.targetSpeed - player.speed;
        player.speed += clamp(ds, -player.accel * dt, player.accel * dt);

        // turn radius mapping
        const demand = player.turnDemand;                // [-1..1]
        const ad = Math.abs(demand);
        let radius; //the radius the jet turns at 
        const playerT = Math.max(-1, Math.min(1, uiTurn)).toFixed(2); //the turn demand shown to the player on the HUD
        if(Math.abs(playerT) == 0){ //if the user says 0 turn demand
            radius = Infinity; //turn radius is a straight line
        }
        else{
            radius = lerp(player.maxRadius, player.minRadius, ad); //map the turn demand to the turn radius
        }
        const turnDir = Math.sign(demand) || 0;
        const omega = (turnDir === 0 || ad < 1e-4) ? 0 : (player.speed / radius) * turnDir; // rad/s

        // integrate heading and position
        player.heading += omega * dt;

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

        // visual roll sway for HUD sprite
        const targetSway = clamp(-turnDir * ad, -1, 1);
        player.rollSway += (targetSway - player.rollSway) * (1 - Math.exp(-8 * dt));
    }

    function lerp(a, b, t) { return a + (b - a) * t; }

    // ============================================================
    // Rendering
    // ============================================================
    function render() {
        wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        hctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        wctx.clearRect(0, 0, cw, ch);
        hctx.clearRect(0, 0, cw, ch);

        // WORLD
        wctx.save();
        wctx.translate(cw * 0.5, ch * 0.5);
        wctx.scale(PPU, PPU);
        wctx.translate(-camera.x, -camera.y);

        drawGrid(wctx);
        drawPlayer(wctx, player);

        wctx.restore();

        drawHUD(hctx);
    }

    function drawGrid(ctx) {
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
        const L = 4.0 * 10;   // fuselage length (WU)
        const W = 3.2 * 10;   // wingspan/width (WU)

        ctx.save();
        ctx.translate(p.pos.x, p.pos.y);
        ctx.rotate(p.heading + p.rollSway * 0.3);

        // shadow
        ctx.save();
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.ellipse(0.1, 0.3, W * 0.55, L * 0.18, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        if (jetReady) {
            ctx.imageSmoothingEnabled = true;
            ctx.save();
            const x = -W * 0.5;
            const y = -L * 0.5;
            ctx.drawImage(jetSprite, x, y, W, L);
            ctx.restore();
        } else {
            // fallback vector jet
            ctx.fillStyle = '#7fb2ff';
            ctx.strokeStyle = '#d2e8ff';
            ctx.lineWidth = 1.2 / PPU;

            ctx.beginPath();
            ctx.moveTo(L * 0.55, 0);
            ctx.lineTo(0, W * 0.55);
            ctx.lineTo(-L * 0.3, W * 0.25);
            ctx.lineTo(-L * 0.65, 0.12);
            ctx.lineTo(-L * 0.85, 0);
            ctx.lineTo(-L * 0.65, -0.12);
            ctx.lineTo(-L * 0.3, -W * 0.25);
            ctx.lineTo(0, -W * 0.55);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = '#1a324a';
            ctx.beginPath();
            ctx.ellipse(L * 0.15, 0, L * 0.18, L * 0.10, 0, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = 'rgba(255,255,255,0.75)';
            ctx.beginPath();
            ctx.arc(L * 0.48, 0, 0.06, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
    }

    function drawHUD(ctx) {
        // top-left info panel
        const pad = 14;
        const boxW = 230;
        const lineH = 18;

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
        ctx.fillText(`HDG: ${hdgDeg.toFixed(0)}°`, 12, y); y += lineH;
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

        // Bottom turn-demand bar with moving knob (centered, fractional width)
        ctx.save();

        const trackH = 18;
        const knobR = 10;
        const padY = 12;

        const panelY = ch - (trackH + 20) - padY; // box height = trackH + 20
        const panelH = trackH + 20;

        const barFraction = 0.5;   // 50% of screen width
        const panelW = cw * barFraction;
        const panelX = (cw - panelW) * 0.5;

        // panel background
        roundedRect(ctx, panelX, panelY, panelW, panelH, 10);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fill();

        // track geometry
        const trackW = cw * barFraction;
        const trackX = (cw - trackW) * 0.5;   // centered
        const trackY = panelY + (panelH - trackH) / 2;

        // track line
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(160,200,230,0.5)';
        ctx.beginPath();
        ctx.moveTo(trackX, trackY + trackH / 2);
        ctx.lineTo(trackX + trackW, trackY + trackH / 2);
        ctx.stroke();

        // center tick
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(160,200,230,0.5)';
        ctx.beginPath();
        const cx = trackX + trackW * 0.5;
        ctx.moveTo(cx, trackY + 4);
        ctx.lineTo(cx, trackY + trackH - 4);
        ctx.stroke();

        // labels
        ctx.fillStyle = 'rgba(169,197,222,0.85)';
        ctx.font = '12px ui-sans-serif,system-ui,Segoe UI,Roboto,Inter,Arial,sans-serif';
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillText('L', trackX, trackY - 4);
        ctx.textAlign = 'right';
        ctx.fillText('R', trackX + trackW, trackY - 4);

        // knob position from uiTurn [-1..+1]
        const t = Math.max(-1, Math.min(1, uiTurn));
        const knobX = trackX + (t + 1) * 0.5 * trackW;
        const knobY = trackY + trackH / 2;

        // knob glow
        ctx.beginPath();
        ctx.arc(knobX, knobY, knobR + 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(120,200,255,0.15)';
        ctx.fill();

        // knob circle
        ctx.beginPath();
        ctx.arc(knobX, knobY, knobR, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(190,235,255,0.95)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(60,130,180,0.9)';
        ctx.stroke();

        // optional numeric readout
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(169,197,222,0.9)';
        ctx.font = '11px ui-sans-serif,system-ui,Segoe UI,Roboto,Inter,Arial,sans-serif';
        ctx.fillText(`TURN INPUT: ${t.toFixed(2)}`, knobX, knobY + knobR + 6);

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
        a = (a + Math.PI) % (Math.PI * 2);
        if (a < 0) a += Math.PI * 2;
        return a - Math.PI;
    }
})();
