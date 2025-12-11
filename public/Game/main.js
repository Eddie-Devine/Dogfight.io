(() => {
    // ============================================================
    // Canvas + DPI/resize
    // ============================================================
    const world = document.getElementById('world');
    const hud = document.getElementById('hud');
    const helpPanels = Array.from(document.querySelectorAll('.help'));
    const wctx = world.getContext('2d');
    const hctx = hud.getContext('2d');

    let dpr = 1, cw = 0, ch = 0;        // CSS pixels
    let vw = 0, vh = 0;                 // device pixels
    let PPU = 1.5;                      // pixels-per-world-unit (zoom)
    const GRID = { gap: 20, thickEvery: 5 }; // world units

    // --- Sprite preload ---
    const jetSprite = new Image();
    jetSprite.src = '/Assets/placeholder_player.png';
    let jetReady = false;
    jetSprite.onload = () => { jetReady = true; };
    const JET_LENGTH = 4.0 * 10;
    const JET_WIDTH = 3.2 * 10;
    const remotePlayers = new Map();

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
    // Load player jet from server
    // ============================================================
    const WS_PATH = window.__DF_WS_PATH || '/ws/';
    const STATE_UPDATE_INTERVAL = 100;

    let playerJet = null; // accessible within this module; also mirrored on window
    let gameSocket = null;
    let stateTimer = null;
    let reconnectTimer = null;
    async function loadPlayerJet() {
        try {
            const res = await fetch('/api/jet', { credentials: 'include' });
            if (!res.ok) throw new Error(`Failed to load jet (${res.status})`);
            const jet = await res.json();
            playerJet = jet;
            window.playerJet = jet; // expose for debugging/other modules
            const mechanicSource = jet?.Mechanics ?? jet?.mechanics;
            if (!mechanicSource) throw new Error('Loaded jet is missing mechanics data');
            const resolvedMechanics = applyPlayerMechanics(mechanicSource);
            jet._resolvedMechanics = resolvedMechanics;
            // console.log('Loaded player jet:', jet);
        } catch (err) {
            console.error('Error loading player jet:', err);
        }
    }
    loadPlayerJet();

    // ============================================================
    // World model (authoritative, screen-size independent)
    // ============================================================
    let activeMechanics = null;
    window.activeMechanics = activeMechanics;

    const player = {
        id: 'local',
        pos: { x: 0, y: 0 },     // world units
        heading: 0,              // radians (0° = North, clockwise positive)
        speed: 0,
        targetSpeed: 0,
        minSpeed: 0,
        maxSpeed: 0,
        accel: 0,
        minRadius: 0,
        maxRadius: 0,
        maxGForce: 0,
        gForceScalar: 1, // prevents divide-by-zero before mechanics load
        mechanics: activeMechanics,
        mechanicsReady: false,
        health: 0,
        maxHealth: 0,
        fuel: 0,
        maxFuel: 0,
        fuelRate: 1000,
        radarDistance: 0,
        radarContacts: [],
        turnDemand: 0,           // [-1..+1]
        turnDecay: 2.5,          // (unused without pointer lock, OK to keep)
        rollSway: 0,
    };
    window.player = player;

    const camera = { x: 0, y: 0, stiffness: 6.0 };

    // ============================================================
    // Input: W/S speed, mouse X => turnDemand
    // ============================================================
    const keys = new Set();
    function setHelpVisible(visible) {
        helpPanels.forEach((el) => {
            el.style.opacity = visible ? '' : '0';
            el.style.visibility = visible ? '' : 'hidden';
        });
    }
    let helpVisible = true;
    setHelpVisible(helpVisible);

    window.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        if (e.code === 'KeyH') {
            helpVisible = !helpVisible;
            setHelpVisible(helpVisible);
            e.preventDefault();
            return;
        }
        if (e.code === 'KeyW' || e.code === 'KeyS') e.preventDefault();
        keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => { keys.delete(e.code); });

    let mouse = { x: cw / 2, y: ch / 2 };
    window.addEventListener('mousemove', (e) => {
        mouse.x = e.clientX;
        const centerX = cw * 0.5;

        // raw input from -1 to +1
        const raw = (mouse.x - centerX) / centerX;

        // curve it so it's softer near center but still reaches ±1 at the edges
        const expo = 1.4; // try 1.2–1.8; higher = softer center
        const curved = Math.sign(raw) * Math.pow(Math.abs(raw), expo);

        // final clamped turn demand
        const t = clamp(curved, -1, 1);

        player.turnDemand = t;
        uiTarget = t; // HUD knob mirrors the same value
    }, { passive: true });


    //Helpter functions
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

    function lerp(a, b, t) { return a + (b - a) * t; }

    function wrapAngle(a) {
        a = (a + Math.PI) % (Math.PI * 2);
        if (a < 0) a += Math.PI * 2;
        return a - Math.PI;
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

    function getInterpolatedPos(entry, now = performance.now()) {
        const { prevPos, nextPos, prevTime, nextTime } = entry;
        if (!prevPos && !nextPos) return { x: 0, y: 0 };
        if (!prevPos) return { ...nextPos };
        if (!nextPos) return { ...prevPos };
        const span = Math.max(1, nextTime - prevTime);
        const t = clamp((now - prevTime) / span, 0, 1.2);
        return {
            x: lerp(prevPos.x, nextPos.x, t),
            y: lerp(prevPos.y, nextPos.y, t),
        };
    }

    function getInterpolatedHeading(entry, now = performance.now()) {
        const { prevHeading, nextHeading, prevTime, nextTime } = entry;
        if (prevHeading === undefined && nextHeading === undefined) return 0;
        if (prevHeading === undefined) return nextHeading || 0;
        if (nextHeading === undefined) return prevHeading || 0;
        const span = Math.max(1, nextTime - prevTime);
        const t = clamp((now - prevTime) / span, 0, 1.2);
        let delta = nextHeading - prevHeading;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        return prevHeading + delta * t;
    }

    function lerpColor(a, b, t) {
        return [
            Math.round(lerp(a[0], b[0], t)),
            Math.round(lerp(a[1], b[1], t)),
            Math.round(lerp(a[2], b[2], t)),
        ];
    }

    function updateRemotePlayers(contacts) {
        if (!Array.isArray(contacts)) return;
        const now = performance.now();
        const seen = new Set();

        for (const contact of contacts) {
            if (!contact?.id || !contact.pos) continue;
            seen.add(contact.id);
            const target = { x: contact.pos.x, y: contact.pos.y };
            const entry = remotePlayers.get(contact.id);

            if (entry) {
                const current = getInterpolatedPos(entry, now);
                const headingCurrent = getInterpolatedHeading(entry, now);
                entry.prevPos = current;
                entry.prevHeading = headingCurrent;
                entry.prevTime = now;
                entry.nextPos = target;
                entry.nextHeading = contact.heading ?? headingCurrent;
                entry.nextTime = now + STATE_UPDATE_INTERVAL;
                entry.lastSeen = now;
            } else {
                const heading = contact.heading || 0;
                remotePlayers.set(contact.id, {
                    prevPos: target,
                    nextPos: target,
                    prevHeading: heading,
                    nextHeading: heading,
                    prevTime: now,
                    nextTime: now + STATE_UPDATE_INTERVAL,
                    lastSeen: now,
                });
            }
        }

        for (const [id, entry] of remotePlayers) {
            if (seen.has(id)) continue;
            if (now - entry.lastSeen > 1500) {
                remotePlayers.delete(id);
            }
        }
    }

    function getRemotePlayerSnapshots() {
        const snapshots = [];
        const now = performance.now();
        for (const [id, entry] of remotePlayers) {
            if (now - entry.lastSeen > 2000) {
                remotePlayers.delete(id);
                continue;
            }
            snapshots.push({
                id,
                pos: getInterpolatedPos(entry, now),
                heading: getInterpolatedHeading(entry, now),
            });
        }
        return snapshots;
    }

    function requireNumber(label, value) {
        const n = Number(value);
        if (!Number.isFinite(n)) {
            throw new Error(`Jet mechanics missing valid '${label}' value`);
        }
        return n;
    }

    function resolveMechanics(source = null) {
        if (!source || typeof source !== 'object') {
            throw new Error('Jet is missing mechanics data');
        }

        const pick = (keys, label) => {
            for (const key of keys) {
                if (source[key] !== undefined) {
                    return requireNumber(label, source[key]);
                }
            }
            throw new Error(`Jet mechanics missing '${label}'`);
        };

        return {
            cruiseSpeed: pick(['cruiseSpeed', 'CruiseSpeed', 'cruise', 'Cruise', 'speed', 'Speed'], 'cruiseSpeed'),
            minSpeed: pick(['minSpeed', 'MinSpeed', 'minimumSpeed', 'min'], 'minSpeed'),
            maxSpeed: pick(['maxSpeed', 'MaxSpeed', 'maximumSpeed', 'max'], 'maxSpeed'),
            accel: pick(['accel', 'Accel', 'acceleration', 'Acceleration', 'accell'], 'accel'),
            minRadius: pick(['minRadius', 'MinRadius', 'turnMinRadius', 'tightRadius'], 'minRadius'),
            maxRadius: pick(['maxRadius', 'MaxRadius', 'turnMaxRadius', 'wideRadius'], 'maxRadius'),
            maxGForce: pick(['maxGForce', 'MaxGForce', 'gLimit', 'GLimit'], 'maxGForce'),
            gForceScalar: pick(['gForceScalar', 'GForceScalar', 'gScalar', 'turnScaler'], 'gForceScalar'),
            maxHealth: pick(['maxHealth', 'MaxHealth', 'health', 'Health'], 'maxHealth'),
            maxFuel: pick(['maxFuel', 'MaxFuel', 'fuelCapacity', 'FuelCapacity'], 'maxFuel'),
            fuelRate: pick(['fuelRate', 'FuelRate', 'fuelBurnMs', 'FuelBurnMs'], 'fuelRate'),
            radarDistance: pick(['radarDistance', 'RadarDistance', 'radar', 'Radar'], 'radarDistance'),
        };
    }

    function applyPlayerMechanics(source) {
        const resolved = resolveMechanics(source);
        activeMechanics = resolved;
        window.activeMechanics = resolved;
        player.mechanics = resolved;

        const cruise = clamp(resolved.cruiseSpeed, resolved.minSpeed, resolved.maxSpeed);
        player.minSpeed = resolved.minSpeed;
        player.maxSpeed = resolved.maxSpeed;
        player.accel = resolved.accel;
        player.minRadius = resolved.minRadius;
        player.maxRadius = resolved.maxRadius;
        player.maxGForce = resolved.maxGForce;
        player.gForceScalar = resolved.gForceScalar;
        player.maxHealth = resolved.maxHealth;
        player.health = resolved.maxHealth;
        player.maxFuel = resolved.maxFuel;
        player.fuel = resolved.maxFuel;
        player.fuelRate = resolved.fuelRate;
        player.radarDistance = resolved.radarDistance;
        player.speed = cruise;
        player.targetSpeed = cruise;
        player.mechanicsReady = true;
        return resolved;
    }

    function buildSocketUrl() {
        const basePath = WS_PATH.startsWith('/') ? WS_PATH : `/${WS_PATH}`;
        const protocol = 'wss:';
        return `${protocol}//${window.location.host}${basePath}`;
    }

    function pushPlayerState() {
        if (!gameSocket || gameSocket.readyState !== WebSocket.OPEN) return;
        if (!player.mechanicsReady) return;
        const payload = {
            type: 'state:update',
            pos: { x: player.pos.x, y: player.pos.y },
            health: player.health,
            speed: player.speed,
            heading: player.heading,
        };
        try {
            gameSocket.send(JSON.stringify(payload));
        } catch (err) {
            console.warn('Failed to send player state update', err);
        }
    }

    function startStateSync() {
        if (stateTimer) window.clearInterval(stateTimer);
        stateTimer = window.setInterval(pushPlayerState, STATE_UPDATE_INTERVAL);
    }

    function stopStateSync() {
        if (stateTimer) {
            window.clearInterval(stateTimer);
            stateTimer = null;
        }
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            connectGameSocket();
        }, 1500);
    }

    function connectGameSocket() {
        stopStateSync();
        if (gameSocket && gameSocket.readyState === WebSocket.OPEN) {
            try { gameSocket.close(4000, 'Restarting socket'); } catch { /* noop */ }
        }

        remotePlayers.clear();
        player.radarContacts = [];

        const url = buildSocketUrl();
        gameSocket = new WebSocket(url);
        window.gameSocket = gameSocket;

        gameSocket.addEventListener('open', () => {
            pushPlayerState();
            startStateSync();
        });

        gameSocket.addEventListener('message', (event) => {
            let data;
            try {
                data = JSON.parse(event.data);
            } catch {
                return;
            }
            if (data?.type === 'session:init') {
                console.info('Connected to session', data.player);
                if (typeof data.player?.fuel === 'number') player.fuel = data.player.fuel;
                if (typeof data.player?.maxFuel === 'number') player.maxFuel = data.player.maxFuel;
                if (Array.isArray(data.player?.radar)) {
                    player.radarContacts = data.player.radar;
                    updateRemotePlayers(data.player.radar);
                }
            } else if (data?.type === 'state:sync') {
                if (typeof data.fuel === 'number') player.fuel = data.fuel;
                if (typeof data.health === 'number') player.health = data.health;
                if (Array.isArray(data.radar)) {
                    player.radarContacts = data.radar;
                    updateRemotePlayers(data.radar);
                }
            }
        });

        gameSocket.addEventListener('close', () => {
            stopStateSync();
            scheduleReconnect();
        });

        gameSocket.addEventListener('error', () => {
            if (gameSocket.readyState === WebSocket.OPEN) {
                gameSocket.close();
            }
        });
    }

    connectGameSocket();

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
        if (!player.mechanicsReady) return;

        // smooth speed to target
        const ds = player.targetSpeed - player.speed;
        player.speed += clamp(ds, -player.accel * dt, player.accel * dt);

        // --- turn radius mapping (physics truth with a tiny deadzone) ---
        let demand = player.turnDemand;                 // [-1..1]
        const tDisplay = Math.max(-1, Math.min(1, uiTurn)); // smoothed, numeric
        const showZero = Math.abs(tDisplay) < 0.005;        // same as "0.00" on HUD

        // If HUD would show 0.00, fly truly straight
        if (showZero) demand = 0;

        const ad = Math.abs(demand);
        const turnDir = Math.sign(demand) || 0;

        // radius & turn rate (with g-force limit)
        let radius = (ad === 0) ? Infinity : lerp(player.maxRadius, player.minRadius, ad);

        if (ad !== 0) {
            const maxCentripetal = Math.max(1, player.maxGForce * player.gForceScalar);
            const gLimitedRadius = (player.speed * player.speed) / maxCentripetal;
            radius = Math.max(radius, gLimitedRadius);
        }

        const omega = (turnDir === 0) ? 0 : (player.speed / radius) * turnDir; // rad/s


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
            drawOtherJets(wctx);
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
        if (!jetReady) return; // don't draw until the image is loaded

        ctx.save();

        // Move to player position (world space), rotate by heading + visual roll
        ctx.translate(p.pos.x, p.pos.y);
        ctx.rotate(p.heading + p.rollSway * 0.3);

        // If your art points UP by default and 0° = North (your sim),
        // no extra offset is needed. If your art points RIGHT, add:
        // ctx.rotate(-Math.PI / 2);

        // For crisp vector art leave smoothing on; for pixel art set false
        ctx.imageSmoothingEnabled = true;

        // Draw centered on the player (anchor at sprite center)
        const x = -JET_WIDTH * 0.5;
        const y = -JET_LENGTH * 0.5;
        ctx.drawImage(jetSprite, x, y, JET_WIDTH, JET_LENGTH);

        ctx.restore();
    }

    function drawOtherJets(ctx) {
        if (!jetReady) return;
        const contacts = getRemotePlayerSnapshots();
        for (const contact of contacts) {
            if (!contact?.pos) continue;
            ctx.save();
            ctx.translate(contact.pos.x, contact.pos.y);
            ctx.rotate(contact.heading || 0);
            const x = -JET_WIDTH * 0.5;
            const y = -JET_LENGTH * 0.5;
            ctx.drawImage(jetSprite, x, y, JET_WIDTH, JET_LENGTH);
            ctx.restore();
        }
    }


    function drawSpeedBar(ctx) {
        // pull from global player
        const speed = player.speed;
        const minSpeed = player.minSpeed;
        const maxSpeed = player.maxSpeed;

        // layout
        const padEdge = 14;                 // distance from left screen edge
        const panelW = 80;                 // overall panel width og 64
        const trackW = 18;                 // bar width
        const barH = Math.min(260, ch - 2 * 80); // bar height; clamp so it looks nice
        const panelH = barH + 36;

        // vertically center the panel (keeps clear of your top-left info box)
        const panelX = padEdge;
        const panelY = (ch - panelH) * 0.5;

        ctx.save();

        // panel
        roundedRect(ctx, panelX, panelY, panelW, panelH, 10);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fill();

        // track rect inside panel
        const trackX = panelX + (panelW - trackW) * 0.5;
        const trackY = panelY + 12;

        // track background
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(160,200,230,0.35)';
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.beginPath();
        ctx.rect(trackX, trackY, trackW, barH);
        ctx.fill();
        ctx.stroke();

        // normalize speed -> [0,1] with safe denom
        const denom = Math.max(1e-6, maxSpeed - minSpeed);
        const t = clamp((speed - minSpeed) / denom, 0, 1);

        // filled column from bottom up
        const fillH = barH * t;
        ctx.fillStyle = 'rgba(120,200,255,0.35)';
        ctx.fillRect(trackX + 1, trackY + (barH - fillH), trackW - 2, fillH);

        // current speed marker line
        ctx.strokeStyle = 'rgba(168,230,255,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        const yMark = trackY + (barH - fillH);
        ctx.moveTo(trackX - 6, yMark);
        ctx.lineTo(trackX + trackW + 6, yMark);
        ctx.stroke();

        // ticks & labels (every 5 units)
        ctx.fillStyle = 'rgba(169,197,222,0.85)';
        ctx.strokeStyle = 'rgba(160,200,230,0.5)';
        ctx.font = '11px ui-sans-serif,system-ui,Segoe UI,Roboto,Inter,Arial,sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        const step = 20;
        const vMin = Math.ceil(minSpeed / step) * step;
        const vMax = Math.floor(maxSpeed / step) * step;
        for (let v = vMin; v <= vMax; v += step) {
            const tv = clamp((v - minSpeed) / denom, 0, 1);
            const y = trackY + (barH - tv * barH);
            // tick
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(trackX + trackW + 4, y);
            ctx.lineTo(trackX + trackW + 10, y);
            ctx.stroke();
            // label
            ctx.fillText(String(v), trackX + trackW + 12, y);
        }

        // numeric readout
        // ctx.textAlign = 'center';
        // ctx.textBaseline = 'top';
        // ctx.fillStyle = 'rgba(169,197,222,0.95)';
        // ctx.font = '12px ui-sans-serif,system-ui,Segoe UI,Roboto,Inter,Arial,sans-serif';
        //ctx.fillText(`SPD ${speed.toFixed(1)}`, panelX + panelW / 2, panelY + 4);

        ctx.restore();
    }

    function drawInfoPanel(ctx) {
        const pad = 14;
        const boxW = 230;
        const lineH = 18;
        const infoLines = 6;
        const boxH = 24 + infoLines * lineH;

        ctx.save();
        ctx.translate(pad, pad);

        // panel box
        roundedRect(ctx, 0, 0, boxW, boxH, 10);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.fill();
        ctx.stroke();

        // text style
        ctx.fillStyle = '#a9c5de';
        ctx.font = '12px ui-sans-serif,system-ui,Segoe UI,Roboto,Inter,Arial,sans-serif';
        ctx.textBaseline = 'top';

        // compute values (keep HUD consistent with physics)
        const speed = player.speed;
        const posX = player.pos.x;
        const posY = player.pos.y;
        const hdgDeg = ((player.heading * 180 / Math.PI) % 360 + 360) % 360;

        const tDisplay = Math.max(-1, Math.min(1, uiTurn));
        const showZero = Math.abs(tDisplay) < 0.005;

        let radiusHUD, omegaHUD;
        if (showZero) {
            radiusHUD = Infinity;
            omegaHUD = 0;
        } else {
            const ad = Math.abs(player.turnDemand);
            const r = lerp(player.maxRadius, player.minRadius, ad);
            radiusHUD = r;
            omegaHUD = speed / r;
        }

        // lines
        let y = 10;
        ctx.fillText(`SPD: ${speed.toFixed(1)} u/s`, 12, y); y += lineH;
        ctx.fillText(`POS X: ${posX.toFixed(1)} u`, 12, y); y += lineH;
        ctx.fillText(`POS Y: ${posY.toFixed(1)} u`, 12, y); y += lineH;
        ctx.fillText(`HDG: ${hdgDeg.toFixed(0)}°`, 12, y); y += lineH;
        ctx.fillText(`TURN R: ${Number.isFinite(radiusHUD) ? radiusHUD.toFixed(1) + ' u' : '∞'}`, 12, y); y += lineH;
        ctx.fillText(`Ω: ${(omegaHUD * 180 / Math.PI).toFixed(2)} °/s`, 12, y);

        ctx.restore();
    }

    function drawResourceBar(ctx, opts) {
        const { label, value, maxValue, panelX, panelY, width, colorFrom, colorTo } = opts;
        if (!player.mechanicsReady || maxValue <= 0) return;

        const panelW = width;
        const panelH = 48;
        const barHeight = 14;

        const trackX = panelX + 12;
        const trackY = panelY + 22;
        const trackW = panelW - 24;

        const clampedValue = clamp(value, 0, maxValue);
        const ratio = clamp(clampedValue / Math.max(1, maxValue), 0, 1);
        const [r, g, b] = lerpColor(colorFrom, colorTo, ratio);

        roundedRect(ctx, panelX, panelY, panelW, panelH, 10);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.strokeStyle = 'rgba(160,200,230,0.35)';
        ctx.lineWidth = 1;
        roundedRect(ctx, trackX, trackY, trackW, barHeight, 7);
        ctx.fill();
        ctx.stroke();

        if (ratio > 0) {
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.85)`;
            roundedRect(ctx, trackX, trackY, trackW * ratio, barHeight, 7);
            ctx.fill();
        }

        ctx.fillStyle = '#a9c5de';
        ctx.font = '12px ui-sans-serif,system-ui,Segoe UI,Roboto,Inter,Arial,sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${label} ${Math.round(clampedValue)}/${Math.round(maxValue)}`, panelX + panelW / 2, panelY + 12);
    }

    function drawHealthBar(ctx) {
        ctx.save();
        const pad = 14;
        const panelW = 230;
        const panelX = cw - pad - panelW;
        const panelY = pad;
        drawResourceBar(ctx, {
            label: 'HEALTH',
            value: player.health,
            maxValue: player.maxHealth,
            panelX,
            panelY,
            width: panelW,
            colorFrom: [220, 90, 70],
            colorTo: [105, 222, 150],
        });
        drawResourceBar(ctx, {
            label: 'FUEL',
            value: player.fuel,
            maxValue: player.maxFuel,
            panelX: panelX - (panelW + 12),
            panelY,
            width: panelW,
            colorFrom: [240, 150, 60],
            colorTo: [120, 210, 255],
        });
        ctx.restore();
    }

    function drawCenterReticle(ctx) {
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
    }

    function drawRadar(ctx) {
        const size = 200;
        const margin = 14;
        const panelX = cw - margin - size;
        const panelY = ch - margin - size;
        const centerX = panelX + size / 2;
        const centerY = panelY + size / 2;
        const radius = (size / 2) - 14;

        ctx.save();

        roundedRect(ctx, panelX, panelY, size, size, 14);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.fill();
        ctx.stroke();

        ctx.translate(centerX, centerY);

        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(125, 255, 180, 0.35)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(0, 0, radius * 0.66, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(125, 255, 180, 0.2)';
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(0, 0, radius * 0.33, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(125, 255, 180, 0.15)';
        ctx.stroke();

        ctx.strokeStyle = 'rgba(125, 255, 180, 0.3)';
        ctx.beginPath();
        ctx.moveTo(-radius, 0);
        ctx.lineTo(radius, 0);
        ctx.moveTo(0, -radius);
        ctx.lineTo(0, radius);
        ctx.stroke();

        const contacts = getRemotePlayerSnapshots();
        const maxRange = player.radarDistance || 0;
        if (maxRange > 0) {
            ctx.fillStyle = 'rgba(125, 255, 180, 0.35)';
            for (const contact of contacts) {
                if (!contact?.pos) continue;
                const dx = contact.pos.x - player.pos.x;
                const dy = contact.pos.y - player.pos.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > maxRange) continue;
                const t = dist / maxRange;
                const angle = Math.atan2(dx, -dy);
                const r = radius * t;
                const px = Math.sin(angle) * r;
                const py = -Math.cos(angle) * r;
                ctx.beginPath();
                ctx.arc(px, py, 4, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        const sweepSpeed = 0.7;
        const sweepAngle = (performance.now() / 1000) * sweepSpeed;
        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
        gradient.addColorStop(0, 'rgba(80,255,170,0.2)');
        gradient.addColorStop(1, 'rgba(80,255,170,0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, radius, sweepAngle, sweepAngle + Math.PI / 3);
        ctx.closePath();
        ctx.fill();

        ctx.restore();
    }

    function drawRWR(ctx) {
        const radarSize = 200;
        const margin = 14;
        const spacing = 10;
        const size = 120;
        const panelX = cw - margin - radarSize + (radarSize - size) * 0.5;
        const panelY = ch - margin - radarSize - spacing - size;
        const centerX = panelX + size / 2;
        const centerY = panelY + size / 2;
        const radius = (size / 2) - 10;

        ctx.save();

        roundedRect(ctx, panelX - 4, panelY - 36, size + 8, 28, 6);
        ctx.strokeStyle = 'rgba(125, 255, 180, 0.5)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = '14px ui-sans-serif,system-ui,Segoe UI,Roboto,Inter,Arial,sans-serif';
        ctx.fillStyle = 'rgba(125, 255, 180, 0.85)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('RWR', panelX + (size / 2), panelY - 22);

        roundedRect(ctx, panelX, panelY, size, size, 14);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.fill();
        ctx.stroke();

        ctx.translate(centerX, centerY);

        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(125, 255, 180, 0.35)';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(0, 0, radius * 0.45, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(125, 255, 180, 0.25)';
        ctx.stroke();

        ctx.strokeStyle = 'rgba(125, 255, 180, 0.35)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 8; i++) {
            const angle = (Math.PI * 2 * i) / 8;
            const x = Math.cos(angle) * radius;
            const y = Math.sin(angle) * radius;
            const inner = radius - 10;
            ctx.beginPath();
            ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
            ctx.lineTo(x, y);
            ctx.stroke();
        }

        ctx.strokeStyle = 'rgba(125, 255, 180, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, -radius * 0.5);
        ctx.lineTo(radius * 0.25, radius * 0.4);
        ctx.lineTo(-radius * 0.25, radius * 0.4);
        ctx.closePath();
        ctx.stroke();

        ctx.restore();
    }

    function drawTurnDemandBar(ctx) {
        ctx.save();

        const trackH = 18;
        const knobR = 10;
        const padY = 12;

        const panelY = ch - (trackH + 20) - padY; // box height = trackH + 20
        const panelH = trackH + 20;

        const barFraction = 0.5;                 // 50% of screen width
        const panelW = cw * barFraction;
        const panelX = (cw - panelW) * 0.5;

        // panel background
        roundedRect(ctx, panelX, panelY, panelW, panelH, 10);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fill();

        // track geometry
        const trackW = cw * barFraction;
        const trackX = (cw - trackW) * 0.5;      // centered
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
        const cxLine = trackX + trackW * 0.5;
        ctx.moveTo(cxLine, trackY + 4);
        ctx.lineTo(cxLine, trackY + trackH - 4);
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

        // numeric readout
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(169,197,222,0.9)';
        ctx.font = '11px ui-sans-serif,system-ui,Segoe UI,Roboto,Inter,Arial,sans-serif';
        ctx.fillText(`TURN INPUT: ${t.toFixed(2)}`, knobX, knobY + knobR + 6);

        ctx.restore();
    }

    function drawHUD(ctx) {
        // draw left speed bar first so other panels can overlap if needed
        drawSpeedBar(ctx);

        drawHealthBar(ctx);
        drawRadar(ctx);
        drawRWR(ctx);

        // core HUD elements
        drawInfoPanel(ctx);
        drawCenterReticle(ctx);
        drawTurnDemandBar(ctx);
    }
})();
