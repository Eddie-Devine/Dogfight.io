(function initJetsCatalog(root, factory) {
	const data = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = data;
	} else if (root) {
		root.JETS_DATA = data;
	}
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildJetsCatalog() {
	return {
		Jets: [
			{
				ID: 'F22',
				Name: 'F-22 Raptor',
				Manufacturer: 'Lockheed Martin',
				Nationality: 'USA',
				Year: '2005',
				Mechanics: {
					cruiseSpeed: 0,
					minSpeed: 0,
					maxSpeed: 380,
					accel: 55,
					minRadius: 45,
					maxRadius: 200,
					maxGForce: 9,
					gForceScalar: 12,
					maxHealth: 150,
					radarDistance: 3000,
					RWRDistance: 2500,
					maxFuel: 150,
					fuelRate: 1000,
					cannonRate: 30,
					cannonCooldown: 1000,
					cannonBurst: 1000,
					cannonAmmo: 1000,
				}
			},
		],
	};
});
