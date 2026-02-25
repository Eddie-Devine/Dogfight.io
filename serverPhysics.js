function angleDifference(target, current) {
	let diff = target - current;
	while (diff > 180) diff -= 360;
	while (diff < -180) diff += 360;
	return diff;
}

function calculateTurnRate(speed, config) {
	const { maxTurnRate, optimalTurnSpeed, minSpeed, maxSpeed } = config;
	const speedDiff = Math.abs(speed - optimalTurnSpeed);
	const maxDiff = Math.max(optimalTurnSpeed - minSpeed, maxSpeed - optimalTurnSpeed);
	const efficiency = 1 - (speedDiff / maxDiff) * 0.6;
	return maxTurnRate * efficiency;
}

function toRadians(degrees) {
	const radians = degrees * (Math.PI / 180);
	return radians;
}

function toDegrees(radians){
	const degrees = radians * (180 / Math.PI);
	return degrees;
}

function updatePlayerHeading(player, config, deltaTime) {
	let targetHeading = player.input.aimAngle * (180 / Math.PI);

	while (targetHeading >= 360) targetHeading -= 360;
	while (targetHeading < 0) targetHeading += 360;

	const headingDifference = angleDifference(targetHeading, player.heading);
	const currentTurnRate = calculateTurnRate(player.speed, config);
	const turnAmount = Math.sign(headingDifference) * Math.min(Math.abs(headingDifference), currentTurnRate * deltaTime);

	player.heading += turnAmount;

	while (player.heading >= 360) player.heading -= 360;
	while (player.heading < 0) player.heading += 360;

	//bank based on turn
	updatePlayerBankAngle(player, config, turnAmount, currentTurnRate, deltaTime);
}

function updatePlayerSpeed(player, config, deltaTime) {
	const targetSpeed = config.minSpeed + (config.maxSpeed - config.minSpeed) * Math.pow(player.input.throttle, config.throttleGamma);

	const speedNorm = (player.speed - config.minSpeed) / (config.maxSpeed - config.minSpeed);
	const clampedNorm = Math.min(Math.max(speedNorm, 0), 1);

	const accelAvail = config.maxAccel * Math.pow(1 - clampedNorm, config.accelFalloffExp);
	const maxUp = accelAvail * deltaTime;
	const maxDown = config.maxDecel * deltaTime;

	const speedErr = targetSpeed - player.speed;
	const speedDelta = Math.max(-maxDown, Math.min(speedErr, maxUp));

	player.speed += speedDelta;
	player.speed = Math.min(Math.max(player.speed, config.minSpeed), config.maxSpeed);
}

function updatePlayerBankAngle(player, config, turnAmount, currentTurnRate, deltaTime) {

	const denom = currentTurnRate * deltaTime;
	const turnRatio = denom > 0 ? (turnAmount / denom) : 0;
	const clampedTurnRatio = Math.max(-1, Math.min(turnRatio, 1));

	const targetBankAngle = clampedTurnRatio * config.maxBankAngle;
	player.bankAngle += (targetBankAngle - player.bankAngle) * Math.min(deltaTime * config.bankSmoothness, 1);
}

function updatePlayerPosition(player, deltaTime) {
	const headingRadians = toRadians(player.heading);

	const velocityX = Math.sin(headingRadians) * player.speed * deltaTime;
	const velocityZ = Math.cos(headingRadians) * player.speed * deltaTime;

	player.position.x += velocityX;
	player.position.z += velocityZ;
}

function updatePlayerPhysics(player, config, deltaTime) {
	updatePlayerHeading(player, config, deltaTime); //this function also updates the bank angle based on heading change
	updatePlayerSpeed(player, config, deltaTime);
	updatePlayerPosition(player, deltaTime);
}

module.exports = updatePlayerPhysics;