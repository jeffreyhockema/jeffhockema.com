// Game constants
export const GAME_CONFIG = {
    CANVAS: {
        HUD_HEIGHT: 140,
    },
    
    PLAYER: {
        SIZE: 16,
        SPEED: 3,
        MAX_HEALTH: 100,
        INVULNERABLE_TIME: 1000,
    },
    
    CAMERA: {
        SMOOTHING: 0.1,
    },
    
    WEAPONS: {
        FIST: { name: 'FIST', ammo: -1, damage: 20, delay: 300, range: 30 },
        PISTOL: { name: 'PISTOL', ammo: -1, damage: 15, delay: 200, range: 300 },
        SHOTGUN: { name: 'SHOTGUN', ammo: 0, damage: 50, delay: 800, range: 200 },
        CHAINGUN: { name: 'CHAINGUN', ammo: 0, damage: 10, delay: 100, range: 300 },
        ROCKET: { name: 'ROCKET LAUNCHER', ammo: 0, damage: 100, delay: 1000, range: 500 },
        PLASMA: { name: 'PLASMA RIFLE', ammo: 0, damage: 40, delay: 150, range: 400 },
    },
    
    ENEMIES: {
        ZOMBIE: { health: 20, speed: 1, damage: 10, points: 100 },
        DEMON: { health: 60, speed: 2, damage: 20, points: 300 },
        CACODEMON: { health: 100, speed: 1.5, damage: 30, points: 500 },
        BARON: { health: 200, speed: 1, damage: 40, points: 1000 },
    },
    
    SOUNDS: {
        PISTOL: { freq: 800, duration: 0.1 },
        SHOTGUN: { freq: 600, duration: 0.2 },
        CHAINGUN: { freq: 900, duration: 0.05 },
        ROCKET: { freq: 400, duration: 0.3 },
        PLASMA: { freq: 1200, duration: 0.08 },
        HIT: { freq: 300, duration: 0.15 },
        PICKUP: { freq: 1000, duration: 0.1 },
        DOOR: { freq: 200, duration: 0.5 },
    },
    
    COLORS: {
        WALL: '#8B7D6B',
        FLOOR: '#2F2F2F',
        DOOR: '#654321',
        PLAYER: '#00FF00',
        ENEMY: '#FF0000',
        BULLET: '#FFFF00',
        HEALTH: '#FF0000',
        AMMO: '#FFD700',
        KEY: '#00FFFF',
    },
    
    GRID: {
        SIZE: 32,
    },
    
    PERFORMANCE: {
        MAX_BULLETS: 50,
        MAX_EXPLOSIONS: 20,
        VIEWPORT_BUFFER: 100,
    }
};

export const GAME_STATES = {
    MENU: 'menu',
    INSTRUCTIONS: 'instructions',
    PLAYING: 'playing',
    PAUSED: 'paused',
    GAME_OVER: 'game_over',
    LEVEL_COMPLETE: 'level_complete',
    SETTINGS: 'settings'
};

export const INPUT_KEYS = {
    MOVE_UP: ['KeyW', 'ArrowUp'],
    MOVE_DOWN: ['KeyS', 'ArrowDown'],
    MOVE_LEFT: ['KeyA', 'ArrowLeft'],
    MOVE_RIGHT: ['KeyD', 'ArrowRight'],
    SHOOT: ['Space'],
    INTERACT: ['KeyE'],
    PAUSE: ['Escape'],
    SETTINGS: ['KeyM'],
    WEAPON_1: ['Digit1'],
    WEAPON_2: ['Digit2'],
    WEAPON_3: ['Digit3'],
    WEAPON_4: ['Digit4'],
    WEAPON_5: ['Digit5'],
    WEAPON_6: ['Digit6'],
};