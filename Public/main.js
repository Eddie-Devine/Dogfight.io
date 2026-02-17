import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

const JET_CONFIG = {
	'F22': {
		scale: 10,
		maxBankAngle: 90,
		maxTurnRate: 100, // degrees per second at optimal speed
		optimalTurnSpeed: 250, // speed where turning is best
		minSpeed: 100,
		maxSpeed: 500,
	},
	'A10': {
		scale: 10,
		maxBankAngle: 60,
		maxTurnRate: 60,
		optimalTurnSpeed: 250,
		minSpeed: 80,
		maxSpeed: 400,
	}
};

const mouse = { x: 0, y: 0, worldX: 0, worldZ: 0 };
const flightState = {
	heading: 180, // current heading in degrees (0 = south)
	speed: 100, // current speed
	position: { x: 0, z: 0 },
	bankAngle: 0,
	testX: 0,
	testZ: 0
}

let menuActive = true;
const VIEW_HEIGHT = 1000;

let scene = null;
const remotePlayers = new Map();
const pendingRemoteSpawns = new Set();
const jetTemplateCache = new Map();
const gltfLoader = new GLTFLoader();

async function initGuest() {
	try {
		const response = await fetch('/init/guest', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				callsign: document.getElementById('pilotName').value,
				jet: getSelectedModel(),
				gamemode: getCurrentMode()
			})
		});

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const data = await response.json();
		const token = data.token;
		const gamemode = data.gamemode;

		connectToGame(token, gamemode);

	} catch (error) {
		console.error('Error initializing guest:', error);
		alert('Failed to join game. Please try again.');
	}
}

function connectToGame(token, gamemode) {
	// Get protocol (ws or wss) based on current page protocol
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	const wsUrl = `${protocol}//${window.location.host}/game/${gamemode}?token=${token}`;

	const ws = new WebSocket(wsUrl);

	ws.onopen = () => {
		console.log('Connected to game!');
	};

	ws.onmessage = (event) => {
		const data = JSON.parse(event.data);

		//server starts the session and gives player info
		if (data.type === 'session:init') {
			flightState.position.x = data.pos.x;
			flightState.position.z = data.pos.z;

			startClientGame(data, ws); //start the game using player info
			//after everything is loaded tell server we are ready
		}

		//server sends its copy of the players physics
		if (data.type === 'position:update') {
			flightState.testX = data.pos.x;
			flightState.testZ = data.pos.z;

			//check how far off client is from server
			const dx = data.pos.x - flightState.position.x;
			const dz = data.pos.z - flightState.position.z;
			const error = Math.hypot(dx, dz);

			if (error > 120) {
				// large error: snap
				flightState.position.x = data.pos.x;
				flightState.position.z = data.pos.z;
			} else {
				// small error: smooth correction
				const blend = 0.15;
				flightState.position.x += dx * blend;
				flightState.position.z += dz * blend;
			}
		}

		//server sends list of remote players the client needs to know and display
		if (data.type === 'world:update') {
			if (!scene) return;

			//players the server sent
			const seen = new Set();

			for (const p of data.players) {
				seen.add(p.ID); // or p.id, match your server field

				//load new player if they weren't in last snapshot
				let remote = remotePlayers.get(p.ID);
				if (!remote) {
					spawnRemoteJet(p);
					continue;
				}

				//update their physics based on snapshot
				remote.position.x = p.pos.x;
				remote.position.z = p.pos.z;
				remote.rotation.y = (p.heading * Math.PI / 180) + Math.PI;
				remote.rotation.z = p.bankAngle * Math.PI / 180;
			}

			//remove players from last snapshot that arnt in this snapshot
			for (const [id, obj] of remotePlayers) {
				if (!seen.has(id)) {
					scene.remove(obj);
					remotePlayers.delete(id);
					pendingRemoteSpawns.delete(id);
				}
			}
		}

	}

	ws.onerror = (error) => {
		console.error('WebSocket error:', error);
	};

	ws.onclose = () => {
		console.log('Disconnected from game');
	};
}

async function getJetTemplate(jetModel) {
	const cached = jetTemplateCache.get(jetModel);
	if (cached) return cached;

	const loadPromise = new Promise((resolve, reject) => {
		gltfLoader.load(
			`/Models/${jetModel}/scene.gltf`,
			(gltf) => resolve(gltf.scene),
			undefined,
			(error) => reject(error)
		);
	});

	jetTemplateCache.set(jetModel, loadPromise);
	return loadPromise;
}

async function spawnRemoteJet(playerState) {
	const playerId = playerState.ID;
	if (!playerId) return;
	if (remotePlayers.has(playerId)) return; //don't spawn duplicate
	if (pendingRemoteSpawns.has(playerId)) return; //don't spawn if in process of spawining already

	pendingRemoteSpawns.add(playerId);
	try {
		const template = await getJetTemplate(playerState.jet);
		if (!scene) return;

		const remoteJet = cloneSkeleton(template);
		const config = JET_CONFIG[playerState.jet] || JET_CONFIG.F22;
		remoteJet.scale.set(config.scale, config.scale, config.scale);
		remoteJet.position.set(playerState.pos.x, 0, playerState.pos.z);
		remoteJet.rotation.y = (playerState.heading * Math.PI / 180) + Math.PI;
		remoteJet.rotation.z = playerState.bankAngle * Math.PI / 180;

		scene.add(remoteJet);
		remotePlayers.set(playerId, remoteJet);
	} catch (error) {
		console.error('Error spawning remote jet:', error);
	} finally {
		pendingRemoteSpawns.delete(playerId);
	}
}

function startClientGame(session, ws) {
	menuActive = false;

	const canvas = setupCanvas();
	hideMenu();

	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

	scene = new THREE.Scene();
	const camera = setupCamera();

	setupWorld(session);
	loadPlayerJet(session.jet, ws);

	const directionArrow = createDirectionArrow();

	setupResizeHandler(camera, renderer, VIEW_HEIGHT);

	startRenderLoop(renderer, camera, directionArrow, session.jet, ws);
}

//calculates the shortest rotation between two angles (handles the wraparound from 359° to 0°
function angleDifference(target, current) {
	let diff = target - current;
	// Normalize to -180 to +180
	while (diff > 180) diff -= 360;
	while (diff < -180) diff += 360;
	return diff;
}

// Calculate turn rate based on speed (g-force mechanics)
function calculateTurnRate(speed, config) {
	const { maxTurnRate, optimalTurnSpeed, minSpeed, maxSpeed } = config;

	// Calculate how far we are from optimal speed
	const speedDiff = Math.abs(speed - optimalTurnSpeed);
	const maxDiff = Math.max(optimalTurnSpeed - minSpeed, maxSpeed - optimalTurnSpeed);

	// Turn rate is best at optimal speed, decreases as you get faster or slower
	// Using a parabolic curve centered at optimal speed
	const efficiency = 1 - (speedDiff / maxDiff) * 0.6; // 0.6 = how much slower turning gets

	return maxTurnRate * efficiency;
}

function updateJetPhysics(jet, config, deltaTime) {
	if (!jet) return;

	// Calculate angle to mouse cursor
	const dx = mouse.worldX - flightState.position.x;
	const dz = mouse.worldZ - flightState.position.z;
	const targetHeading = Math.atan2(dx, dz) * (180 / Math.PI); // Convert to degrees

	// Calculate how much we need to turn
	const headingDiff = angleDifference(targetHeading, flightState.heading);

	// Get current turn rate based on speed
	const currentTurnRate = calculateTurnRate(flightState.speed, config);

	// Apply turn (limited by turn rate)
	const turnAmount = Math.sign(headingDiff) * Math.min(Math.abs(headingDiff), currentTurnRate * deltaTime);
	flightState.heading += turnAmount;

	// Normalize heading to 0-360
	while (flightState.heading >= 360) flightState.heading -= 360;
	while (flightState.heading < 0) flightState.heading += 360;

	// Update position based on heading and speed
	const headingRad = flightState.heading * (Math.PI / 180);
	const velocityX = Math.sin(headingRad) * flightState.speed * deltaTime; // 0.016 ≈ 1/60 for smooth movement
	const velocityZ = Math.cos(headingRad) * flightState.speed * deltaTime;

	flightState.position.x += velocityX;
	flightState.position.z += velocityZ;

	// Update jet visual position and rotation
	jet.position.x = flightState.position.x;
	jet.position.z = flightState.position.z;

	jet.rotation.y = headingRad + (180 * (Math.PI / 180)); //extra 180 degrees added at the end to fix bug DONT REMOVE

	// Calculate target bank angle based on turn rate
	const targetBankAngle = (turnAmount / (currentTurnRate * deltaTime)) * config.maxBankAngle;

	// Smoothly interpolate current bank angle towards target
	const bankSmoothness = 5; // Higher = faster response, lower = smoother
	flightState.bankAngle += (targetBankAngle - flightState.bankAngle) * Math.min(deltaTime * bankSmoothness, 1);

	// Apply the smoothed bank angle
	jet.rotation.z = flightState.bankAngle * (Math.PI / 180);
}

function createDirectionArrow() {
	// Create a small triangle that points upward (towards +Z in world space)
	const shape = new THREE.Shape();
	const size = 15; // Size of the arrow
	shape.moveTo(0, size); // tip
	shape.lineTo(-size * 0.5, -size * 0.5); // bottom left
	shape.lineTo(size * 0.5, -size * 0.5); // bottom right
	shape.lineTo(0, size); // back to tip

	const geometry = new THREE.ShapeGeometry(shape);
	const material = new THREE.MeshBasicMaterial({
		color: 0x00ff00,
		side: THREE.DoubleSide,
		transparent: true,
		opacity: 0.8
	});

	const arrow = new THREE.Mesh(geometry, material);
	arrow.rotation.x = -Math.PI / 2; // Lay it flat on the ground
	arrow.position.y = 1; // Slightly above ground to avoid z-fighting

	scene.add(arrow);
	return arrow;
}

function updateDirectionArrow(arrow, jet, mouseWorldX, mouseWorldZ) {
	if (!arrow) return;

	// Calculate angle from jet to mouse
	const dx = mouseWorldX - jet.position.x;
	const dz = mouseWorldZ - jet.position.z;
	const targetAngle = Math.atan2(dx, dz);

	// Position arrow around the jet at a fixed radius
	const box = new THREE.Box3().setFromObject(jet);
	const sphere = new THREE.Sphere();
	box.getBoundingSphere(sphere);
	const radius = sphere.radius;

	arrow.position.x = jet.position.x + Math.sin(targetAngle) * radius;
	arrow.position.z = jet.position.z + Math.cos(targetAngle) * radius;

	// Rotate arrow to point away from center (outward)
	// Since the arrow tip points toward +Y in local space (before x rotation),
	// and we rotated it to lie flat, rotation.z controls which way it points
	arrow.rotation.z = targetAngle + Math.PI;
}

function setupCanvas() {
	if (window.stopStarfield) window.stopStarfield();

	// Force garbage collection of old WebGL context
	const oldCanvas = document.getElementById('gameCanvas');
	if (oldCanvas) {
		oldCanvas.remove();
	}

	// Create fresh canvas
	const canvas = document.createElement('canvas');
	canvas.id = 'gameCanvas';
	canvas.style.pointerEvents = 'auto';
	canvas.style.zIndex = '0';
	document.body.prepend(canvas);

	return canvas;
}

function hideMenu() {
	const main = document.querySelector('main');
	if (main) main.classList.add('hidden');
	const brand = document.getElementById('game-brand');
	if (brand) brand.classList.add('hidden');
}

function setupWorld(session) {
	const gridSize = session.worldSize;
	const divisions = gridSize / 50; //each box is x world units

	// Ground plane
	const geometry = new THREE.PlaneGeometry(gridSize, gridSize);
	const material = new THREE.MeshBasicMaterial({ color: 0x222222 });
	const ground = new THREE.Mesh(geometry, material);
	scene.add(ground);

	const ambientLight = new THREE.AmbientLight(0xffffff, 2); // Soft white light
	scene.add(ambientLight);

	const directionalLight = new THREE.DirectionalLight(0xffffff, 2);
	directionalLight.position.set(0, 500, 0); // From above
	scene.add(directionalLight);

	// Grid
	const gridHelper = new THREE.GridHelper(gridSize, divisions, 0xaaaaaa, 0xaaaaaa);
	scene.add(gridHelper);
}

function setupCamera() {
	const viewHeight = VIEW_HEIGHT;
	const aspect = window.innerWidth / window.innerHeight;
	const viewWidth = viewHeight * aspect;

	const camera = new THREE.OrthographicCamera(
		-viewWidth / 2,
		viewWidth / 2,
		viewHeight / 2,
		-viewHeight / 2,
		1,
		1000
	);
	camera.position.set(0, 500, 0);
	camera.lookAt(0, 0, 0);

	window.addEventListener('mousemove', (event) => {
		// Convert screen coordinates to normalized device coordinates (-1 to +1)
		mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
		mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

		// Convert to world coordinates
		// const vector = new THREE.Vector3(mouse.x, mouse.y, 0.5);
		// vector.unproject(camera);

		// mouse.worldX = vector.x;
		// mouse.worldZ = vector.z;
	});

	return camera;
}

//updates camera position to follow player
function updateCamera(camera, jet) {
	camera.position.x = jet.position.x;
	camera.position.z = jet.position.z;
	camera.lookAt(jet.position.x, 0, jet.position.z);
}

function setupResizeHandler(camera, renderer, viewHeight) {
	window.addEventListener('resize', () => {
		const newAspect = window.innerWidth / window.innerHeight;
		const newViewWidth = viewHeight * newAspect;

		camera.left = -newViewWidth / 2;
		camera.right = newViewWidth / 2;
		camera.updateProjectionMatrix();

		renderer.setSize(window.innerWidth, window.innerHeight);
	});
}

//Update mouse world coordinates based on current camera position
//mouse position needs to based off world coordinates for use in game
let lastMouseSendTime = 0; //used to decide whether to send mouse position update to the server
function updateMouseWorldPosition(camera, ws) {
	const vector = new THREE.Vector3(mouse.x, mouse.y, 0.5);
	vector.unproject(camera);
	mouse.worldX = vector.x;
	mouse.worldZ = vector.z;

	const now = performance.now();
	//60 Hz cap
	if ((now - lastMouseSendTime) >= (1000 / 60)) {
		if (ws.readyState !== WebSocket.OPEN) return; //dont send update if socket closes

		ws.send(JSON.stringify({
			type: 'mouse:update',
			mouse: {
				worldX: mouse.worldX,
				worldZ: mouse.worldZ
			}
		}));
		lastMouseSendTime = now;
	}
}

function startRenderLoop(renderer, camera, directionArrow, jetModelName, ws) {
	const config = JET_CONFIG[jetModelName];
	let lastTime = null;

	const circle = createCircle(25);

	function animate(currentTime) {
		requestAnimationFrame(animate);

		const jet = window.playerJet;
		if (!jet) {
			lastTime = currentTime; //keep clock synced while waiting for model to load
			return;
		}

		if (lastTime === null) lastTime = currentTime; //set last time is jet loads really fast (safty)

		let deltaTime = (currentTime - lastTime) / 1000;
		lastTime = currentTime;

		deltaTime = Math.min(deltaTime, 1 / 30); //safty to prevent deltaTime from being huge from lag

		updateCamera(camera, jet);
		updateMouseWorldPosition(camera, ws);
		updateJetPhysics(jet, config, deltaTime);
		updateDirectionArrow(directionArrow, jet, mouse.worldX, mouse.worldZ);

		circle.position.x = flightState.testX;
		circle.position.z = flightState.testZ;

		renderer.render(scene, camera);
	}
	animate(0);
}

function createCircle(radius, color = 0xff0000, segments = 64) {
	// Create circle geometry
	const geometry = new THREE.RingGeometry(
		radius - 2,  // inner radius (slightly smaller to create a ring/outline)
		radius,      // outer radius
		segments     // number of segments (higher = smoother circle)
	);

	// Create material
	const material = new THREE.MeshBasicMaterial({
		color: color,
		side: THREE.DoubleSide,
		transparent: true,
		opacity: 0.5
	});

	// Create mesh
	const circle = new THREE.Mesh(geometry, material);

	// Rotate to lay flat on the ground (XZ plane)
	circle.rotation.x = -Math.PI / 2;
	circle.position.y = 0.5; // Slightly above ground to avoid z-fighting

	// Add to scene
	scene.add(circle);

	return circle;
}

function loadPlayerJet(jetModel, ws) {
	gltfLoader.load(`/Models/${jetModel}/scene.gltf`, (gltf) => {
		const jet = gltf.scene;
		const config = JET_CONFIG[jetModel];

		jet.scale.set(config.scale, config.scale, config.scale);

		scene.add(jet);

		window.playerJet = jet;


		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({
				type: 'session:ready',
				state: flightState
			}));
		}

	}, undefined, (error) => {
		console.error('Error loading jet model:', error);
	});
}

// Background starfield on the full-page canvas
(() => {
	const BACKGROUND_CANVAS = document.getElementById('gameCanvas');

	const renderer = new THREE.WebGLRenderer({
		canvas: BACKGROUND_CANVAS,
		antialias: true,
		alpha: false
	});
	renderer.setClearColor(0x05070d, 1);

	const scene = new THREE.Scene();

	const camera = new THREE.PerspectiveCamera(
		60,
		window.innerWidth / window.innerHeight,
		0.1,
		200
	);
	camera.position.set(0, 0, 2);

	const starCount = 1500;
	const geometry = new THREE.BufferGeometry();
	const positions = new Float32Array(starCount * 3);

	for (let i = 0; i < starCount; i++) {
		const radius = THREE.MathUtils.randFloat(40, 120);
		const phi = Math.acos(THREE.MathUtils.randFloatSpread(2));
		const theta = THREE.MathUtils.randFloat(0, Math.PI * 2);

		const x = radius * Math.sin(phi) * Math.cos(theta);
		const y = radius * Math.sin(phi) * Math.sin(theta);
		const z = radius * Math.cos(phi);

		positions[i * 3] = x;
		positions[i * 3 + 1] = y;
		positions[i * 3 + 2] = z;
	}

	geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

	const material = new THREE.PointsMaterial({
		color: 0xffffff,
		size: 0.4,
		sizeAttenuation: true,
		transparent: true,
		opacity: 0.9
	});

	const stars = new THREE.Points(geometry, material);
	scene.add(stars);

	const onResize = () => {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const { innerWidth: w, innerHeight: h } = window;
		renderer.setPixelRatio(dpr);
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	};

	let lastTime = 0;
	let animationId;
	const animate = (time = 0) => {
		animationId = requestAnimationFrame(animate);
		const delta = (time - lastTime) * 0.001;
		lastTime = time;

		stars.rotation.y += 0.003 * delta * 3;
		stars.rotation.x += 0.0005 * delta * 3;

		renderer.render(scene, camera);
	};

	const stopStarfield = () => {
		if (animationId) cancelAnimationFrame(animationId);
		window.removeEventListener('resize', onResize);
	};

	window.stopStarfield = stopStarfield;
	window.addEventListener('resize', onResize);
	onResize();
	animate();
})();

// Hold-to-start behavior for the Take Off button
(() => {
	const HOLD_MS = 0;
	const takeoffBtn = document.getElementById('takeoffBtn');
	if (!takeoffBtn) return;

	let raf = null;
	let startTime = 0;
	let triggered = false;

	const setFill = (percent) => {
		takeoffBtn.style.setProperty('--takeoff-fill', `${percent}%`);
	};

	const resetFill = () => {
		setFill(0);
		triggered = false;
		if (raf) {
			cancelAnimationFrame(raf);
			raf = null;
		}
	};

	const fireTakeoff = () => {
		if (triggered) return;
		triggered = true;
		const selectedModel = window.getSelectedModel ? window.getSelectedModel() : null;
		const currentMode = window.getCurrentMode ? window.getCurrentMode() : null;
		takeoffBtn.dispatchEvent(
			new CustomEvent('takeoff-confirmed', {
				bubbles: true,
				detail: { selectedModel, mode: currentMode }
			})
		);
	};

	const tick = (now) => {
		const elapsed = now - startTime;
		const progress = Math.min(elapsed / HOLD_MS, 1);
		setFill(progress * 100);
		if (progress >= 1) {
			fireTakeoff();
			return;
		}
		raf = requestAnimationFrame(tick);
	};

	const startHold = (event) => {
		if (!menuActive) return;
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		resetFill();
		startTime = performance.now();
		raf = requestAnimationFrame(tick);
	};

	const startHoldKey = (event) => {
		if (!menuActive) return;
		if (event.key !== 'Enter') return;
		if (event.repeat) return; // ignore auto-repeat
		resetFill();
		startTime = performance.now();
		raf = requestAnimationFrame(tick);
	};

	const cancelHold = () => {
		if (triggered) {
			// briefly keep the bar filled to show completion
			setTimeout(resetFill, 240);
		} else {
			resetFill();
		}
	};

	takeoffBtn.addEventListener('pointerdown', startHold);
	window.addEventListener('pointerup', cancelHold);
	window.addEventListener('pointercancel', cancelHold);
	window.addEventListener('keydown', startHoldKey);
	window.addEventListener('keyup', (event) => {
		if (event.key !== 'Enter') return;
		cancelHold();
	});
	takeoffBtn.addEventListener('blur', cancelHold);

	// Example handler: replace with actual start-game logic
	takeoffBtn.addEventListener('takeoff-confirmed', () => {
		console.log('Takeoff confirmed – start the game here.');
		initGuest();
	});
})();

// Game mode selector buttons
(() => {
	const modeToggle = document.getElementById('modeToggle');
	if (!modeToggle) return;

	const modeLabel = document.getElementById('modeLabel');
	const modes = [
		{ value: 'freeforall', label: 'FREE FOR ALL' },
	];

	let currentIndex = modes.findIndex((m) => m.value === modeLabel?.dataset.mode);
	if (currentIndex === -1) currentIndex = 0;

	const applyMode = () => {
		const { value, label } = modes[currentIndex];
		if (modeLabel) {
			modeLabel.dataset.mode = value;
			modeLabel.textContent = label;
		}
		window.getCurrentMode = () => value;
		modeToggle.dispatchEvent(new CustomEvent('mode-changed', { detail: { mode: value }, bubbles: true }));
	};

	const shiftMode = (delta) => {
		currentIndex = (currentIndex + delta + modes.length) % modes.length;
		applyMode();
	};

	modeToggle.addEventListener('click', (e) => {
		if (!menuActive) return;
		// Ignore keyboard-activated clicks (Enter/Space) so we only change via arrows or Arrow keys
		if (e.detail === 0) return;
		const dirBtn = e.target.closest('[data-dir]');
		if (!dirBtn) return;
		shiftMode(dirBtn.dataset.dir === 'next' ? 1 : -1);
	});

	window.addEventListener('keydown', (e) => {
		if (!menuActive) return;
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			shiftMode(-1);
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			shiftMode(1);
		}
	});

	applyMode();
})();

// Grid selection for jets
(() => {
	const grid = document.querySelector('.grid-5x5');
	if (!grid) return;

	let selectedCell = null;
	let selectedModel = null;

	const selectCell = (cell) => {
		if (selectedCell) selectedCell.classList.remove('selected');
		selectedCell = cell;
		selectedModel = cell.id || null;
		if (selectedCell) selectedCell.classList.add('selected');
	};

	grid.addEventListener('click', (e) => {
		if (!menuActive) return;
		const cell = e.target.closest('.grid-cell');
		if (!cell || !grid.contains(cell)) return;
		if (!cell.id) return; // only selectable if it maps to a model folder
		selectCell(cell);
	});

	window.getSelectedModel = () => selectedModel;
})();
