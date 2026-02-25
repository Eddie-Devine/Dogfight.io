function angleDifference(target, current) {
	let difference = target - current;
	while (difference > 180) difference -= 360;
	while (difference < -180) difference += 360;
	return difference;
}

function calculateTurnRate(speed, config) {
	const { maxTurnRate, optimalTurnSpeed, minSpeed, maxSpeed } = config;
	const speedDiff = Math.abs(speed - optimalTurnSpeed);
	const maxDiff = Math.max(optimalTurnSpeed - minSpeed, maxSpeed - optimalTurnSpeed);
	const efficiency = 1 - (speedDiff / maxDiff) * 0.6;
	return maxTurnRate * efficiency;
}

//map degrees to 0-360
function normalizeDegrees(degrees) {
	while (degrees >= 360) degrees -= 360;
	while (degrees < 0) degrees += 360;
	return degrees;
}

//radians to degrees
function toDegrees(radians) {
	const degrees = radians * (180 / Math.PI);
	return degrees;
}

//degrees to radians
function toRadians(degrees){
	const radians = degrees * (Math.PI / 180);
	return radians;
}

function updateHeading(jet, flightState, config, deltaTime) {
	let targetHeading = toDegrees(flightState.aimAngle);
	targetHeading = normalizeDegrees(targetHeading);

	const headingDifference = angleDifference(targetHeading, flightState.heading);
	const currentTurnRate = calculateTurnRate(flightState.speed, config);
	const turnAmount = Math.sign(headingDifference) * Math.min(Math.abs(headingDifference), currentTurnRate * deltaTime);

	flightState.heading += turnAmount;
	flightState.heading = normalizeDegrees(flightState.heading); //wrap degrees when changing left to right

	const headingRadians = toRadians(flightState.heading);
	jet.rotation.y = headingRadians + Math.PI;

	//info needed to update bank angle based on turn
	return {turnAmount, currentTurnRate};
}

function updateSpeed(flightState, config, deltaTime) {
	const throttle = Math.max(0, Math.min(1, flightState.throttle));
	const targetSpeed = config.minSpeed + (config.maxSpeed - config.minSpeed) * Math.pow(throttle, config.throttleGamma);

	const speedNorm = (flightState.speed - config.minSpeed) / (config.maxSpeed - config.minSpeed);
	const clampedNorm = Math.min(Math.max(speedNorm, 0), 1);

	const accelAvail = config.maxAccel * Math.pow(1 - clampedNorm, config.accelFalloffExp);
	const maxUp = accelAvail * deltaTime;
	const maxDown = config.maxDecel * deltaTime;

	const speedErr = targetSpeed - flightState.speed;
	const speedDelta = Math.max(-maxDown, Math.min(speedErr, maxUp));

	flightState.speed += speedDelta;
	flightState.speed = Math.min(Math.max(flightState.speed, config.minSpeed), config.maxSpeed);
}

function updatePosition(jet, flightState, deltaTime) {
	const headingRadians = toRadians(flightState.heading);
	flightState.position.x += Math.sin(headingRadians) * flightState.speed * deltaTime;
	flightState.position.z += Math.cos(headingRadians) * flightState.speed * deltaTime;

	jet.position.x = flightState.position.x;
	jet.position.z = flightState.position.z;
}

function updateBankAngle(jet, flightState, config, deltaTime, turnAmount, currentTurnRate) {
	const denom = currentTurnRate * deltaTime;
	const turnRatio = denom > 0 ? (turnAmount / denom) : 0;
	const clampedTurnRatio = Math.max(-1, Math.min(turnRatio, 1));
	const targetBankAngle = clampedTurnRatio * config.maxBankAngle;

	flightState.bankAngle += (targetBankAngle - flightState.bankAngle) * Math.min(deltaTime * config.bankSmoothness, 1);

	jet.rotation.z = flightState.bankAngle * (Math.PI / 180);
}

export function updateJetPhysics(jet, config, flightState, deltaTime) {
	if (!jet) return;

	// let targetHeading = toDegrees(state.aimAngle);
	// targetHeading = normalizeDegrees(targetHeading);

	// const headingDiff = angleDifference(targetHeading, state.heading);
	// const currentTurnRate = calculateTurnRate(state.speed, config);
	// const turnAmount = Math.sign(headingDiff) * Math.min(Math.abs(headingDiff), currentTurnRate * deltaTime);

	// state.heading += turnAmount;
	// state.heading = normalizeDegrees(state.heading);

	const {turnAmount, currentTurnRate} = updateHeading(jet, flightState, config, deltaTime);
	updateBankAngle(jet, flightState, config, deltaTime, turnAmount, currentTurnRate);
	updateSpeed(flightState, config, deltaTime);
	updatePosition(jet, flightState, deltaTime);


	// const throttle = Math.max(0, Math.min(1, state.throttle));
	// const targetSpeed = config.minSpeed + (config.maxSpeed - config.minSpeed) * Math.pow(throttle, config.throttleGamma);

	// const speedNorm = (state.speed - config.minSpeed) / (config.maxSpeed - config.minSpeed);
	// const clampedNorm = Math.min(Math.max(speedNorm, 0), 1);

	// const accelAvail = config.maxAccel * Math.pow(1 - clampedNorm, config.accelFalloffExp);
	// const maxUp = accelAvail * deltaTime;
	// const maxDown = config.maxDecel * deltaTime;

	// const speedErr = targetSpeed - state.speed;
	// const speedDelta = Math.max(-maxDown, Math.min(speedErr, maxUp));

	// state.speed += speedDelta;
	// state.speed = Math.min(Math.max(state.speed, config.minSpeed), config.maxSpeed);

	// const headingRad = state.heading * (Math.PI / 180);
	// state.position.x += Math.sin(headingRad) * state.speed * deltaTime;
	// state.position.z += Math.cos(headingRad) * state.speed * deltaTime;

	// const denom = currentTurnRate * deltaTime;
	// const turnRatio = denom > 0 ? (turnAmount / denom) : 0;
	// const clampedTurnRatio = Math.max(-1, Math.min(turnRatio, 1));
	// const targetBankAngle = clampedTurnRatio * config.maxBankAngle;

	// const bankSmoothness = 5;
	// state.bankAngle += (targetBankAngle - state.bankAngle) * Math.min(deltaTime * bankSmoothness, 1);

	// jet.position.x = state.position.x;
	// jet.position.z = state.position.z;
	//jet.rotation.y = headingRad + Math.PI;
	// jet.rotation.z = state.bankAngle * (Math.PI / 180);
}
