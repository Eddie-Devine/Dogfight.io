import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { updateJetPhysics } from './clientPhysics.js';

//
const activeExplosions = [];
const activeSprites = [];
//

//TEMPERARY: server gives jet config to prevent mis match, in future client will have hard coded copy
let JET_CONFIG;
fetch('/jetConfig')
	.then(response => response.json())
	.then(config => JET_CONFIG = config);

const mouse = {
	x: 0, //actual mouse position on screen
	y: 0,
	worldX: 0, //mouse maped to world cordnites
	worldZ: 0,
	controlRadius: 450 //this value overrided by getControlRadius
};

const flightState = {
	jet: null,
	heading: 180, // current heading in degrees (0 = south)
	speed: 100, // current speed
	position: { x: 0, z: 0 },
	bankAngle: 0,
	throttle: 0,
	aimAngle: 0,
	testX: 0,
	testZ: 0
}

let menuActive = true;
const VIEW_HEIGHT = 2000; //size of world player can see (world units)
let hasFocus = true;

let scene = null;
const remotePlayers = new Map();
let radarContects = [];
const pendingRemoteSpawns = new Set();
const jetTemplateCache = new Map();
const gltfLoader = new GLTFLoader();

//gets token used to join game, passes it to connectToGame
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
		flightState.jet = data.jet;

		connectToGame(token, gamemode);

	} catch (error) {
		console.error('Error initializing guest:', error);
		alert('Failed to join game. Please try again.');
	}
}

//uses token to connect to game and listen on websocket
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
			flightState.position.x = data.position.x;
			flightState.position.z = data.position.z;
			flightState.speed = data.speed;
			flightState.heading = data.heading;
			flightState.bankAngle = data.bankAngle;

			startClientGame(data, ws); //start the game using player info
			//after everything is loaded tell server we are ready
		}

		if (data.type === 'world:update') {
			flightState.testX = data?.self?.position?.x;
			flightState.testZ = data?.self?.position?.z;

			//check how far off client is from server
			const dx = data.self.position.x - flightState.position.x;
			const dz = data.self.position.z - flightState.position.z;
			const error = Math.hypot(dx, dz);

			//correct error
			if (error > 120) {
				// large error: snap
				console.log("snap");
				flightState.position.x = data.self.position.x;
				flightState.position.z = data.self.position.z;
			}
			else {
				// small error: smooth correction
				// if (error > 10) console.log(error);
				const blend = 0.1;
				flightState.position.x += dx * blend;
				flightState.position.z += dz * blend;
			}

			if (!scene) return;

			//players the server sent
			const seen = new Set();

			//console.log(data.visualContacts);

			for (const p of data.visualContacts) {
				seen.add(p.id); // or p.id, match your server field

				//load new player if they weren't in last snapshot
				let remote = remotePlayers.get(p.id);
				if (!remote) {
					spawnRemoteJet(p);
					continue;
				}

				//update their physics based on snapshot
				remote.position.x = p.position.x;
				remote.position.z = p.position.z;
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

		if (data.type === 'radar:update') {
			const radarContacts = data.radarContacts;
			updateRadar(radarContacts);
			//console.log(radarContacts);
		}

	}

	ws.onerror = (error) => {
		console.error('WebSocket error:', error);
	};

	ws.onclose = () => {
		console.log('Disconnected from game');
	};
}

//loads GLTF models for remote players, uses cache system to avoid reloading identical models
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
	console.log(playerState.id);
	const playerId = playerState.id;
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
		remoteJet.position.set(playerState.position.x, 0, playerState.position.z);
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

const RADAR_CENTER = 100;   // SVG center
const RADAR_RADIUS = 86;    // SVG radar ring radius
const WORLD_RADIUS = 8000;  // how many world units the radar edge represents
function updateRadar(contacts) {
	const blipGroup = document.getElementById('radar-blips');
	if (!blipGroup) return;

	blipGroup.innerHTML = '';

	for (const [x, z] of contacts) {
		const dx = x - flightState.position.x;
		const dz = z - flightState.position.z;

		if (Math.hypot(dx, dz) > WORLD_RADIUS) continue;

		const scale = RADAR_RADIUS / WORLD_RADIUS;
		const svgX = RADAR_CENTER + dx * scale;
		const svgZ = RADAR_CENTER + dz * scale;

		const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

		const outer = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		outer.setAttribute('cx', svgX);
		outer.setAttribute('cy', svgZ);
		outer.setAttribute('r', '2.5');
		outer.setAttribute('fill', '#4de3ff');

		const inner = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		inner.setAttribute('cx', svgX);
		inner.setAttribute('cy', svgZ);
		inner.setAttribute('r', '1');
		inner.setAttribute('fill', '#ffffff');

		g.appendChild(outer);
		g.appendChild(inner);
		blipGroup.appendChild(g);
	}
}

//creates envirment for game
function startClientGame(session, ws) {
	menuActive = false;

	document.getElementById('radar').classList.add('visible');

	const canvas = setupCanvas();
	hideMenu();

	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

	scene = new THREE.Scene();
	const camera = setupCamera();

	setupWorld(session);
	loadPlayerJet(session.jet, ws);
	getControlRadius(camera);

	const directionArrow = createDirectionArrow();

	setupResizeHandler(camera, renderer, VIEW_HEIGHT);

	startRenderLoop(renderer, camera, directionArrow, session.jet, ws);
}

function createDirectionArrow() {
	const arrow = new THREE.Group();

	const ringMaterial = new THREE.MeshBasicMaterial({
		color: 0x4de3ff,
		transparent: true,
		opacity: 0.75,
		blending: THREE.AdditiveBlending,
		depthWrite: false,
		side: THREE.DoubleSide
	});
	const chevronMaterial = ringMaterial.clone();
	chevronMaterial.opacity = 0.9;

	const ring = new THREE.Mesh(new THREE.RingGeometry(13, 17, 36), ringMaterial);
	arrow.add(ring);

	const chevronShape = new THREE.Shape();
	chevronShape.moveTo(0, 11);
	chevronShape.lineTo(-6, -7);
	chevronShape.lineTo(0, -2.5);
	chevronShape.lineTo(6, -7);
	chevronShape.lineTo(0, 11);
	const chevron = new THREE.Mesh(new THREE.ShapeGeometry(chevronShape), chevronMaterial);
	arrow.add(chevron);

	arrow.rotation.x = -Math.PI / 2;
	arrow.position.y = 1;
	arrow.userData.ringMaterial = ringMaterial;
	arrow.userData.chevronMaterial = chevronMaterial;

	scene.add(arrow);
	return arrow;
}

function updateDirectionArrow(arrow, jet, mouseWorldX, mouseWorldZ, controlRadius) {
	if (!arrow || !jet) return;

	const dx = mouseWorldX - jet.position.x;
	const dz = mouseWorldZ - jet.position.z;
	const dist = Math.hypot(dx, dz);

	// avoid divide-by-zero
	if (dist < 0.0001) return;

	const nx = dx / dist;
	const nz = dz / dist;

	// arrow follows mouse distance but stops at control radius
	let clampedDist = Math.min(dist, controlRadius); //dont exceed control distance
	clampedDist = Math.max(80, clampedDist); //dont cover player

	arrow.position.x = jet.position.x + nx * clampedDist;
	arrow.position.z = jet.position.z + nz * clampedDist;

	const targetAngle = Math.atan2(dx, dz);
	arrow.rotation.z = targetAngle + Math.PI;

	const ratio = Math.min(dist / controlRadius, 1);
	const scale = 0.85 + ratio * 0.55;
	arrow.scale.setScalar(scale);

	const pulse = 0.6 + Math.sin(performance.now() * 0.012) * 0.2;
	arrow.userData.ringMaterial.opacity = 0.45 + ratio * 0.2 + pulse * 0.08;
	arrow.userData.chevronMaterial.opacity = 0.65 + ratio * 0.2 + pulse * 0.1;
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
	const radar = document.getElementById('radar');
	if (radar) radar.classList.add('visible'); // ← add this
}

function setupWorld(session) {
	const gridSize = session.worldSize;
	const divisions = gridSize / 100; //each box is x world units

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

		getControlRadius(camera);
	});
}

//Update mouse world coordinates based on current camera position
//mouse position needs to based off world coordinates for use in game
function updateMouseWorldPosition(camera) {
	const vector = new THREE.Vector3(mouse.x, mouse.y, 0.5);
	vector.unproject(camera);
	mouse.worldX = vector.x;
	mouse.worldZ = vector.z;
}

//call after mouse world position has been updated
//update the desired thrust
function updateThrottle() {
	if (!hasFocus) {
		flightState.throttle = 0;
		return;
	}

	const dx = mouse.worldX - flightState.position.x;
	const dz = mouse.worldZ - flightState.position.z;

	const distanceFromPlayer = Math.hypot(dx, dz);
	const throttle = Math.min(distanceFromPlayer / mouse.controlRadius, 1);

	if (!Number.isFinite(throttle)) return;

	flightState.throttle = throttle;
}

//update the desired angle the player wants to fly at
function updateAimAngle() {
	if (!hasFocus) return;

	const dx = mouse.worldX - flightState.position.x;
	const dz = mouse.worldZ - flightState.position.z;

	const aimAngle = Math.atan2(dx, dz);

	if (!Number.isFinite(aimAngle)) return;

	flightState.aimAngle = aimAngle;
}

let lastInputSendTime = 0;
let inputSeq = 0;
function sendInputUpdate(ws) {
	if (ws.readyState !== WebSocket.OPEN) return;

	const now = performance.now();
	if (now - lastInputSendTime < (1000 / 30)) return; // too soon, skip cap at 30Hz

	inputSeq++;
	const input = {
		aimAngle: flightState.aimAngle,
		throttle: flightState.throttle
	};

	ws.send(JSON.stringify({
		type: 'input:update',
		seq: inputSeq,
		input
	}));

	lastInputSendTime = now;
}

let lastRadarRequestTime = 0;
function requestRadarUpdate(ws) {
	if (ws.readyState !== WebSocket.OPEN) return;

	const now = performance.now();
	if (now - lastRadarRequestTime < 3000) return; // too soon, skip cap at 1 request every 3 seconds (radar rotation)

	ws.send(JSON.stringify({
		type: 'radar:request'
	}));
	lastRadarRequestTime = now;
}

function getControlRadius(camera) {
	const viewWidth = camera.right - camera.left;
	const viewHeight = camera.top - camera.bottom;
	return Math.min(viewWidth, viewHeight) * 0.4;
}

function startRenderLoop(renderer, camera, directionArrow, jetModelName, ws) {
	const config = JET_CONFIG[jetModelName];
	let lastTime = null;

	//
	const circle = createCircle(25);
	//

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

		deltaTime = Math.min(deltaTime, 1 / 60); //safty to prevent deltaTime from being huge from lag

		//
		updateExplosions(deltaTime);
		//

		updateCamera(camera, jet);
		updateMouseWorldPosition(camera);
		updateAimAngle();
		updateThrottle();
		sendInputUpdate(ws);
		updateJetPhysics(jet, config, flightState, deltaTime);
		updateDirectionArrow(directionArrow, jet, mouse.worldX, mouse.worldZ, mouse.controlRadius);
		requestRadarUpdate(ws);

		//
		circle.position.x = flightState.testX;
		circle.position.z = flightState.testZ;
		//

		renderer.render(scene, camera);
	}
	animate(0);
}

function createCircle(radius, color = 0xff0000, segments = 16) {
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

//handle mouse leaving screen and user leaving window (AFK pauses input)
(() => {
	// Mouse leaving the window
	window.addEventListener('mouseleave', () => {
		hasFocus = false;
	});

	window.addEventListener('mouseenter', () => {
		hasFocus = true;
	});

	// Tab switching
	document.addEventListener('visibilitychange', () => {
		hasFocus = !document.hidden;
	});

	// Window losing focus
	window.addEventListener('blur', () => {
		hasFocus = false;
	});

	window.addEventListener('focus', () => {
		hasFocus = true;
	});
})();

//--------------------------------------------

function explodeJet(jetObject) {
	const worldPos = new THREE.Vector3();
	jetObject.getWorldPosition(worldPos);

	activeSprites.push(spawnExplosionSprite(worldPos)); // add this line

	const pieces = [];

	// collect all meshes FIRST without modifying anything
	const meshes = [];
	jetObject.traverse((child) => {
		if (child.isMesh) meshes.push(child);
	});

	// then detach and set up each one
	for (const child of meshes) {
		child.material = child.material.clone();

		scene.attach(child); // now safe to modify tree

		child.userData.velocity = new THREE.Vector3(
			(Math.random() - 0.5) * 300,
			Math.random() * 350,
			(Math.random() - 0.5) * 300
		);
		child.userData.spin = new THREE.Vector3(
			(Math.random() - 0.5) * 5,
			(Math.random() - 0.5) * 5,
			(Math.random() - 0.5) * 5
		);
		child.userData.life = 1.0;

		pieces.push(child);
	}

	//scene.remove(jetObject);
	//window.playerJet = null;
	activeExplosions.push(pieces);
}

function spawnExplosionSprite(position) {
	const texture = new THREE.TextureLoader().load('/Textures/explosion.png');
	const COLS = 4, ROWS = 4;
	const TOTAL = COLS * ROWS;

	texture.repeat.set(1 / COLS, 1 / ROWS);
	texture.offset.set(0, 1 - 1 / ROWS);

	const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
	const sprite = new THREE.Sprite(material);
	sprite.scale.set(200, 200, 1);
	sprite.position.copy(position);
	scene.add(sprite);

	let frame = 0;
	const FPS = 24;
	let elapsed = 0;

	sprite.userData.update = (delta) => {
		elapsed += delta;
		if (elapsed >= 1 / FPS) {
			elapsed = 0;
			frame++;
			if (frame >= TOTAL) {
				scene.remove(sprite);
				return false; // signal done
			}
			const col = frame % COLS;
			const row = Math.floor(frame / COLS);
			texture.offset.set(col / COLS, 1 - (row + 1) / ROWS);
		}
		return true; // still alive
	};

	return sprite;
}

function updateExplosions(delta) {
	for (let i = activeExplosions.length - 1; i >= 0; i--) {
		const alive = activeSprites[i].userData.update(delta);
		if (!alive) activeSprites.splice(i, 1);
		const pieces = activeExplosions[i];
		let allDead = true;

		for (const p of pieces) {
			p.userData.life -= delta * 0.5;
			if (p.userData.life <= 0) {
				scene.remove(p);
				continue;
			}
			allDead = false;
			p.position.addScaledVector(p.userData.velocity, delta);
			p.userData.velocity.y -= 9.8 * delta;
			p.rotation.x += p.userData.spin.x * delta;
			p.rotation.y += p.userData.spin.y * delta;
			p.rotation.z += p.userData.spin.z * delta;
			const s = Math.max(0, p.userData.life);
			p.scale.set(s, s, s);
			p.material.transparent = true;
			p.material.opacity = p.userData.life;
		}

		if (allDead) activeExplosions.splice(i, 1);
	}
}