// Koh-e Zard highlands: hand-placed relief, roads, sites and force positions for Mountain Survival.
// Fictional location. Units in metres, +z = south, -z = north. Heights are resolved from the terrain at load.

export const MOUNTAIN_SUN = [-0.5, 0.56, 0.66];
export const MOUNTAIN_TIME = 600;

export const MOUNTAIN_LAYOUT = {
  ridges: [
    { a: [-360, -700], b: [-290, 380], h: 205, w: 250, jag: 340 },   // west ridge
    { a: [330, -700], b: [280, 350], h: 195, w: 240, jag: 360 },     // east ridge
    { a: [-650, -660], b: [650, -645], h: 420, w: 210, jag: 420 },   // northern massif
    { a: [-380, 540], b: [360, 560], h: 125, w: 170, jag: 300 },     // southern saddle (LZ)
    { a: [120, -30], b: [160, -240], h: 88, w: 105, jag: 200 },      // central east hill
    { a: [-150, 40], b: [-240, -90], h: 105, w: 115, jag: 220 },     // west spur
    { a: [-128, 330], b: [-240, 250], h: 62, w: 90, jag: 160 },      // south-west knoll
    { a: [195, 345], b: [230, 190], h: 55, w: 80, jag: 150 },        // south-east knoll
  ],
  valley: [[-22, 760], [-24, 540], [-30, 372], [8, 226], [40, 84], [18, -58], [-30, -202], [-12, -362], [40, -522], [72, -760]],
  valleyWidth: 300,
  roads: [
    { pts: [[-8, 760], [-10, 540], [-14, 372], [22, 226], [52, 92], [34, -58], [-14, -205], [4, -362], [56, -522], [88, -760]], width: 3.1, smooth: 14 },
  ],
  trails: [
    { pts: [[-225, 574], [-172, 540], [-112, 500], [-58, 448], [-22, 400]], width: 1.4, smooth: 6 },
    { pts: [[52, 92], [70, 60]], width: 1.6, smooth: 4 },
    { pts: [[40, 30], [94, -40], [130, -100]], width: 1.3, smooth: 6 },
    { pts: [[-4, -150], [-96, -126], [-176, -96], [-242, -74]], width: 1.3, smooth: 6 },
    { pts: [[4, -362], [22, -410], [40, -450]], width: 1.2, smooth: 5 },
    { pts: [[52, 92], [150, 64], [256, 36]], width: 1.2, smooth: 6 },
    { pts: [[-15, 376], [-60, 290], [-94, 212]], width: 1.2, smooth: 6 },
  ],
  pads: [
    { id: 'lz', x: -225, z: 574, r: 13, blend: 16 },
    { id: 'village', x: 88, z: 58, r: 24, blend: 14, square: true },
    { id: 'east', x: 134, z: -114, r: 17, blend: 12, square: true },
    { id: 'westOutpost', x: -250, z: -72, r: 11, blend: 10 },
    { id: 'eastOP', x: 262, z: 34, r: 7, blend: 8 },
    { id: 'northOP', x: 42, z: -455, r: 7, blend: 8 },
    { id: 'checkpoint', x: 4, z: -350, r: 12, blend: 10 },
    { id: 'hut', x: -94, z: 208, r: 8, blend: 10 },
    { id: 'tower', x: -188, z: -18, r: 6, blend: 7 },
  ],
};

/** Structures placed on the pads (relative coordinates). */
export const MOUNTAIN_SITES = {
  village: {
    kind: 'compound', w: 32, d: 28, gate: { side: 'w', at: 0, width: 3.4 },
    houses: [
      { x0: -14, z0: -12, x1: -2, z1: -3, h: 3.1, door: { side: 's', at: -8 }, windows: [['s', -12], ['s', -4.5], ['w', -7.5]] },
      { x0: 3, z0: -12, x1: 14, z1: -4, h: 3.2, door: { side: 's', at: 8.5 }, windows: [['s', 5], ['s', 12], ['e', -8]] },
      { x0: 6, z0: 5, x1: 14, z1: 12, h: 2.7, door: { side: 'w', at: 8.5 }, windows: [['n', 10]] },
    ],
    tree: [-6, 6], well: [0, 3],
  },
  east: {
    kind: 'compound', w: 24, d: 22, gate: { side: 's', at: 0, width: 3.4 },
    houses: [
      { x0: -10, z0: -9, x1: 2, z1: -1, h: 3.1, door: { side: 's', at: -4.5 }, windows: [['s', -8.5], ['n', -4], ['w', -5]] },
      { x0: 4, z0: -9, x1: 10, z1: 1, h: 3.0, door: { side: 'w', at: -4.5 }, windows: [['e', -4]] },
    ],
    tree: [5, 6],
  },
  westOutpost: { kind: 'outpost' },
  eastOP: { kind: 'sangar', face: -1.9 },
  northOP: { kind: 'sangar', face: 0.1 },
  checkpoint: { kind: 'checkpoint' },
  hut: { kind: 'hut' },
  tower: { kind: 'tower' },
  lz: { kind: 'lz' },
};

/** Team insertion (LZ) and the friendly squad around it. */
export const MOUNTAIN_TEAM = {
  spawn: { x: -221, z: 568, yaw: -0.87 },
  mates: [
    { name: 'SGT NOWAK', short: 'NOWAK', role: 'rifle', offset: [-4, 5] },
    { name: 'CPL MAZUR', short: 'MAZUR', role: 'marksman', offset: [4, 5] },
    { name: 'SPC WÓJCIK', short: 'WÓJCIK', role: 'rifle', offset: [-8, 9] },
    { name: 'SPC KRÓL', short: 'KRÓL', role: 'rifle', offset: [8, 9] },
    { name: 'MEDIC LIS', short: 'LIS', role: 'rifle', offset: [0, 11] },
  ],
};

/**
 * Pre-placed hostile force. site + rel: position relative to a pad, or pos: absolute [x, z].
 * roof: stand on the roof of the house containing the point. group: coordinated reactions.
 * hunt: seconds after insertion when the group starts moving on the team's last reported area.
 */
export const MOUNTAIN_HOSTILES = [
  // shepherd hut on the south-west knoll
  { id: 'hut1', profile: 'fighter', site: 'hut', rel: [-1, 5], yaw: 2.9, mode: 'guard', group: 'hut', hunt: 75 },
  { id: 'hut2', profile: 'fighter', site: 'hut', rel: [8, -10], mode: 'patrol', routeRel: [[8, -10], [30, -32], [-16, -40], [-24, -6]], group: 'hut', hunt: 75 },
  // hidden positions among boulders
  { id: 'rock1', profile: 'fighter', pos: [-116, 182], yaw: 2.6, mode: 'guard', group: 'rocksW', hunt: 150 },
  { id: 'rock2', profile: 'marksman', pos: [102, 266], yaw: -2.6, mode: 'guard', stationary: true, group: 'rocksE' },
  { id: 'rock3', profile: 'fighter', pos: [176, -296], yaw: 2.4, mode: 'guard', group: 'rocksN', hunt: 330 },
  // village compound in the valley
  { id: 'v1', profile: 'fighter', site: 'village', rel: [-22, -18], mode: 'patrol', routeRel: [[-22, -18], [22, -18], [22, 18], [-22, 18]], group: 'village', hunt: 200 },
  { id: 'v2', profile: 'fighter', site: 'village', rel: [-19, 0.6], yaw: -Math.PI / 2, mode: 'guard', group: 'village', hunt: 200 },
  { id: 'v3', profile: 'marksman', site: 'village', rel: [8.5, -8], roof: true, yaw: 2.6, mode: 'guard', stationary: true, group: 'village' },
  { id: 'v4', profile: 'fighter', site: 'village', rel: [-2, 2], yaw: 1.4, mode: 'guard', group: 'village', hunt: 260 },
  { id: 'v5', profile: 'veteranFighter', pos: [60, 110], mode: 'patrol', route: [[60, 110], [30, 150], [60, 110], [112, 92]], group: 'village', hunt: 200 },
  // east hillside compound
  { id: 'e1', profile: 'fighter', site: 'east', rel: [0, 13.5], yaw: 0, mode: 'guard', group: 'east', hunt: 300 },
  { id: 'e2', profile: 'marksman', site: 'east', rel: [-4, -5], roof: true, yaw: 0.6, mode: 'guard', stationary: true, group: 'east' },
  { id: 'e3', profile: 'fighter', site: 'east', rel: [0, 4], yaw: -0.4, mode: 'guard', group: 'east', hunt: 360 },
  { id: 'e4', profile: 'veteranFighter', site: 'east', rel: [-15, -14], mode: 'patrol', routeRel: [[-15, -14], [15, -14], [15, 14], [-15, 14]], group: 'east', hunt: 300 },
  // west ridge outpost
  { id: 'w1', profile: 'marksman', site: 'westOutpost', rel: [4, 7], yaw: 1.9, mode: 'guard', stationary: true, group: 'west' },
  { id: 'w2', profile: 'fighter', site: 'westOutpost', rel: [-5, -7], yaw: 1.5, mode: 'guard', group: 'west', hunt: 240 },
  { id: 'w3', profile: 'veteranFighter', site: 'westOutpost', rel: [9, -8], yaw: 2.2, mode: 'guard', group: 'west', hunt: 240 },
  // observation posts
  { id: 'op1', profile: 'marksman', site: 'eastOP', rel: [0, 1], yaw: -1.9, mode: 'guard', stationary: true, group: 'eastOP' },
  { id: 'op2', profile: 'fighter', site: 'eastOP', rel: [-3, -4], yaw: -2.3, mode: 'guard', group: 'eastOP', hunt: 420 },
  { id: 'op3', profile: 'marksman', site: 'northOP', rel: [-1, 2], yaw: 0.1, mode: 'guard', stationary: true, group: 'northOP' },
  { id: 'op4', profile: 'fighter', site: 'northOP', rel: [4, -2], yaw: -0.3, mode: 'guard', group: 'northOP', hunt: 450 },
  // road checkpoint
  { id: 'c1', profile: 'fighter', site: 'checkpoint', rel: [-2, 8], yaw: 0.2, mode: 'guard', group: 'checkpoint', hunt: 380 },
  { id: 'c2', profile: 'veteranFighter', site: 'checkpoint', rel: [4.8, 1.2], yaw: 0, mode: 'guard', group: 'checkpoint', hunt: 380 },
  { id: 'c3', profile: 'fighter', site: 'checkpoint', rel: [-9, 16], mode: 'patrol', routeRel: [[-9, 16], [-22, 56], [-9, 16], [14, -22]], group: 'checkpoint', hunt: 380 },
  // ruined tower on the west spur
  { id: 't1', profile: 'fighter', site: 'tower', rel: [3.8, 3.2], yaw: 2.4, mode: 'guard', group: 'tower', hunt: 280 },
  // patrol on the west slope trail
  { id: 'p1', profile: 'fighter', pos: [-120, -112], mode: 'patrol', route: [[-120, -112], [-40, -140], [-12, -200], [-60, -126]], group: 'trail', hunt: 180 },
];
