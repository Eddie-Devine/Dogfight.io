import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// jetConfig.js
export const JET_CONFIG = {
	'F22': {
		scale: 10,
		rotation: { x: 0, y: THREE.MathUtils.degToRad(-90), z: 0 },
		offset: { x: 0, y: 0, z: 0 }
	}
};

const mouse = { x: 0, y: 0, worldX: 0, worldZ: 0 };

let menuActive = true;
const VIEW_HEIGHT = 800;

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

		if (data.type == 'session:init') {
			startClientGame(data);
		}
	};

	ws.onerror = (error) => {
		console.error('WebSocket error:', error);
	};

	ws.onclose = () => {
		console.log('Disconnected from game');
	};
}

function startClientGame(session) {
	menuActive = false;

	const canvas = setupCanvas();
	hideMenu();

	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

	const scene = new THREE.Scene();
	const camera = setupCamera(session);

	setupWorld(scene, session);
	loadPlayerJet(scene, session.jet);
	setupResizeHandler(camera, renderer, VIEW_HEIGHT);
	startRenderLoop(renderer, scene, camera);
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

function setupWorld(scene, session) {
	const gridSize = session.worldSize;
	const divisions = 150;

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

function setupCamera(session) {
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
		const vector = new THREE.Vector3(mouse.x, mouse.y, 0.5);
		vector.unproject(camera);

		mouse.worldX = vector.x;
		mouse.worldZ = vector.z;
	});

	return camera;
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

function startRenderLoop(renderer, scene, camera) {
	function animate() {
		requestAnimationFrame(animate);

		if (window.playerJet && mouse.worldX !== undefined) {
			const jet = window.playerJet;

			// Calculate direction to mouse
			const dx = mouse.worldX - jet.position.x;
			const dz = mouse.worldZ - jet.position.z;
			const distance = Math.sqrt(dx * dx + dz * dz);

			// Only move if not already at mouse position
			if (distance > 5) {
				// Normalize direction and move
				jet.position.x += (dx / distance) * 3;
				jet.position.z += (dz / distance) * 3;

				// Rotate to face movement direction
				jet.rotation.y = Math.atan2(dx, dz);
			}

			// Camera follows jet
			camera.position.x = jet.position.x;
			camera.position.z = jet.position.z;
			camera.lookAt(jet.position.x, 0, jet.position.z);
		}

		renderer.render(scene, camera);
	}
	animate();
}

function loadPlayerJet(scene, jetModel) {
	const loader = new GLTFLoader();

	loader.load(`/Models/${jetModel}/scene.gltf`, (gltf) => {
		const jet = gltf.scene;

		const config = JET_CONFIG[jetModel];

		jet.scale.set(config.scale, config.scale, config.scale);
		jet.rotation.set(config.rotation.x, config.rotation.y, config.rotation.z);
		jet.position.set(config.offset.x, config.offset.y, config.offset.z);

		scene.add(jet);

		const box = new THREE.BoxHelper(jet, 0xff0000); // Red box
		scene.add(box);

		// Store reference for later updates
		window.playerJet = jet;
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
	const HOLD_MS = 600;
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
