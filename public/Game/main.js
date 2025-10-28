// --- Setup canvases with DPR scaling ---
const world = document.getElementById('world');
const hud = document.getElementById('hud');
const wctx = world.getContext('2d');
const hctx = hud.getContext('2d');

let viewWidth = 0, viewHeight = 0, dpr = 1;

function resize() {
    dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2)); // cap DPR if you want
    viewWidth = Math.floor(window.innerWidth * dpr);
    viewHeight = Math.floor(window.innerHeight * dpr);

    [world, hud].forEach(c => {
        c.width = viewWidth;
        c.height = viewHeight;
        c.style.width = '100%';
        c.style.height = '100%';
    });

    // Optional: crisper lines/text
    [wctx, hctx].forEach(ctx => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
        ctx.imageSmoothingEnabled = false;
    });
}

// Throttle resize a bit for laptop window drags
let resizeRaf = 0;
window.addEventListener('resize', () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(resize);
});
resize();

// --- Simple game state ---
const keys = new Set();
window.addEventListener('keydown', e => keys.add(e.key.toLowerCase()));
window.addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));

const player = {
    x: 400, y: 300, angle: 0, speed: 0,
    maxSpeed: 250, accel: 500, turnRate: Math.PI, // px/s and rad/s
    size: 22, // triangle size
    hp: 100, hpMax: 100,
};

// Dummy radar targets
const enemies = [
    { x: 1200, y: 900 },
    { x: -500, y: -200 },
    { x: 300, y: 1500 },
];

// Camera (center on player)
const camera = { x: 0, y: 0 };

// --- Game loop ---
let last = performance.now();
function loop(now) {
    const dt = Math.min(0.033, (now - last) / 1000); // clamp dt
    last = now;

    update(dt);
    drawWorld();
    drawHUD();

    requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function update(dt) {
    // Controls: WASD or arrows
    const forward = keys.has('w') || keys.has('arrowup');
    const back = keys.has('s') || keys.has('arrowdown');
    const left = keys.has('a') || keys.has('arrowleft');
    const right = keys.has('d') || keys.has('arrowright');

    if (left) player.angle -= player.turnRate * dt;
    if (right) player.angle += player.turnRate * dt;

    const targetSpeed = forward ? player.maxSpeed : back ? -player.maxSpeed * 0.5 : 0;
    const dv = targetSpeed - player.speed;
    const maxDelta = player.accel * dt;
    player.speed += Math.max(-maxDelta, Math.min(maxDelta, dv));

    player.x += Math.cos(player.angle) * player.speed * dt;
    player.y += Math.sin(player.angle) * player.speed * dt;

    // Center camera on player (no world bounds yet)
    camera.x = player.x - (world.width / (2 * dpr));
    camera.y = player.y - (world.height / (2 * dpr));
}

function clear(ctx) {
    ctx.clearRect(0, 0, ctx.canvas.width / dpr, ctx.canvas.height / dpr);
}

function drawWorld() {
    clear(wctx);

    const vw = world.width / dpr;
    const vh = world.height / dpr;

    // Simple grid to visualize movement
    wctx.save();
    wctx.translate(-camera.x, -camera.y);
    drawGrid(wctx, 80, '#1e1e26', vw + camera.x, vh + camera.y);
    drawPlayer(wctx, player);
    wctx.restore();
}

function drawGrid(ctx, step, color, w, h) {
    ctx.beginPath();
    for (let x = Math.floor((camera.x) / step) * step; x < camera.x + w; x += step) {
        ctx.moveTo(x, camera.y - step);
        ctx.lineTo(x, camera.y + h + step);
    }
    for (let y = Math.floor((camera.y) / step) * step; y < camera.y + h; y += step) {
        ctx.moveTo(camera.x - step, y);
        ctx.lineTo(camera.x + w + step, y);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.stroke();
}

function drawPlayer(ctx, p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);

    // Jet body (simple triangle placeholder)
    ctx.beginPath();
    ctx.moveTo(p.size, 0);
    ctx.lineTo(-p.size * 0.6, -p.size * 0.6);
    ctx.lineTo(-p.size * 0.6, p.size * 0.6);
    ctx.closePath();
    ctx.fillStyle = '#5ec8ff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#0b6ea8';
    ctx.stroke();

    // Nose line
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(p.size, 0);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#b8ecff';
    ctx.stroke();

    ctx.restore();
}

function drawHUD() {
    clear(hctx);

    const vw = hud.width / dpr;
    const vh = hud.height / dpr;

    // Health bar (top-left)
    const pad = 16;
    const w = 220, h = 16;
    const hpFrac = Math.max(0, player.hp / player.hpMax);

    hctx.fillStyle = '#2a2a34';
    hctx.fillRect(pad - 2, pad - 2, w + 4, h + 4);
    hctx.fillStyle = '#3f3f52';
    hctx.fillRect(pad, pad, w, h);
    hctx.fillStyle = hpFrac > 0.5 ? '#47e26f' : hpFrac > 0.25 ? '#ffd24d' : '#ff6464';
    hctx.fillRect(pad, pad, w * hpFrac, h);

    hctx.font = '12px system-ui, Segoe UI, Roboto, sans-serif';
    hctx.fillStyle = '#d6d6de';
    hctx.fillText(`HP: ${Math.round(player.hp)}/${player.hpMax}`, pad, pad + h + 14);

    // Radar (bottom-right)
    const radarSize = 140;
    const rs = radarSize;
    const rx = vw - pad - rs;
    const ry = vh - pad - rs;

    // Radar frame
    hctx.strokeStyle = '#8ca0b3';
    hctx.lineWidth = 2;
    hctx.strokeRect(rx, ry, rs, rs);

    // Player center on radar
    const rCenterX = rx + rs / 2;
    const rCenterY = ry + rs / 2;

    // Project enemies into radar space (very simple)
    const radarRange = 2000; // world units shown across radar
    enemies.forEach(e => {
        const dx = e.x - player.x;
        const dy = e.y - player.y;
        const sx = (dx / radarRange) * rs + rCenterX;
        const sy = (dy / radarRange) * rs + rCenterY;
        if (sx >= rx && sx <= rx + rs && sy >= ry && sy <= ry + rs) {
            hctx.beginPath();
            hctx.arc(sx, sy, 3, 0, Math.PI * 2);
            hctx.fillStyle = '#ff6666';
            hctx.fill();
        }
    });

    // Player blip
    hctx.beginPath();
    hctx.arc(rCenterX, rCenterY, 4, 0, Math.PI * 2);
    hctx.fillStyle = '#7fffd4';
    hctx.fill();
}