import { GAME_CONFIG, GAME_STATES, INPUT_KEYS } from './constants.js';

export class GameState {
    constructor() {
        this.current = GAME_STATES.MENU;
        this.level = 1;
        this.score = 0;
        this.keys = 0;
        this.settings = {
            volume: 0.5,
            difficulty: 'normal',
            graphics: 'high'
        };
    }

    setState(newState) {
        this.current = newState;
        this.onStateChange?.(newState);
        
        // Trigger canvas resize when state changes
        window.dispatchEvent(new Event('resize'));
    }

    reset() {
        this.level = 1;
        this.score = 0;
        this.keys = 0;
    }
}

export class Player {
    constructor(x, y) {
        this.x = x;
        this.y = y;
        this.angle = 0;
        this.size = GAME_CONFIG.PLAYER.SIZE;
        this.speed = GAME_CONFIG.PLAYER.SPEED;
        this.health = GAME_CONFIG.PLAYER.MAX_HEALTH;
        this.maxHealth = GAME_CONFIG.PLAYER.MAX_HEALTH;
        this.weapons = ['fist', 'pistol'];
        this.currentWeapon = 1;
        this.ammo = { 
            fist: -1, 
            pistol: -1, 
            shotgun: 0, 
            chaingun: 0, 
            rocket: 0, 
            plasma: 0 
        };
        this.lastShot = 0;
        this.keys = { red: 0, yellow: 0, blue: 0 };
        this.invulnerable = false;
        this.invulnerableTime = 0;
        this.doorOpening = null;
        this.doorOpeningTime = 0;
    }

    update(deltaTime) {
        if (this.invulnerable && this.invulnerableTime > 0) {
            this.invulnerableTime -= deltaTime;
            if (this.invulnerableTime <= 0) {
                this.invulnerable = false;
            }
        }

        if (this.doorOpening && this.doorOpeningTime > 0) {
            this.doorOpeningTime -= deltaTime;
            if (this.doorOpeningTime <= 0) {
                this.doorOpening = null;
            }
        }
    }

    takeDamage(amount) {
        if (this.invulnerable) return false;
        
        this.health = Math.max(0, this.health - amount);
        this.invulnerable = true;
        this.invulnerableTime = GAME_CONFIG.PLAYER.INVULNERABLE_TIME;
        
        return this.health <= 0;
    }

    heal(amount) {
        this.health = Math.min(this.maxHealth, this.health + amount);
    }

    hasAmmo(weaponType) {
        return this.ammo[weaponType] === -1 || this.ammo[weaponType] > 0;
    }

    useAmmo(weaponType, amount = 1) {
        if (this.ammo[weaponType] > 0) {
            this.ammo[weaponType] -= amount;
        }
    }

    addAmmo(weaponType, amount) {
        if (this.ammo[weaponType] !== -1) {
            this.ammo[weaponType] += amount;
        }
    }
}

export class Enemy {
    constructor(x, y, type, isBoss = false) {
        this.x = x;
        this.y = y;
        this.type = type;
        this.isBoss = isBoss;
        this.size = 16;
        this.angle = 0;
        this.targetAngle = 0;
        this.lastAction = 0;
        this.lastShot = 0;
        this.path = [];
        this.pathIndex = 0;
        this.stuck = false;
        this.stuckTime = 0;
        this.lastX = x;
        this.lastY = y;
        this.active = true;

        const config = GAME_CONFIG.ENEMIES[type.toUpperCase()] || GAME_CONFIG.ENEMIES.ZOMBIE;
        this.maxHealth = isBoss ? config.health * 2 : config.health;
        this.health = this.maxHealth;
        this.speed = config.speed;
        this.damage = config.damage;
        this.points = config.points;
    }

    update(deltaTime, player, levelData) {
        if (!this.active) return;

        // Simple AI: move towards player
        const dx = player.x - this.x;
        const dy = player.y - this.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance > 20) {
            this.targetAngle = Math.atan2(dy, dx);
            const moveX = Math.cos(this.targetAngle) * this.speed;
            const moveY = Math.sin(this.targetAngle) * this.speed;

            // Basic collision detection
            if (this.isValidPosition(this.x + moveX, this.y, levelData)) {
                this.x += moveX;
            }
            if (this.isValidPosition(this.x, this.y + moveY, levelData)) {
                this.y += moveY;
            }
        }
    }

    isValidPosition(x, y, levelData) {
        // Simple bounds check - implement proper collision detection
        return x > 0 && x < 1000 && y > 0 && y < 1000;
    }

    takeDamage(amount) {
        this.health -= amount;
        return this.health <= 0;
    }

    destroy() {
        this.active = false;
    }
}

export class Bullet {
    static pool = [];
    static poolSize = 0;

    constructor(x, y, angle, speed, damage, range, color = '#FFFF00') {
        this.reset(x, y, angle, speed, damage, range, color);
    }

    static create(x, y, angle, speed, damage, range, color) {
        let bullet;
        if (Bullet.pool.length > 0) {
            bullet = Bullet.pool.pop();
            bullet.reset(x, y, angle, speed, damage, range, color);
        } else {
            bullet = new Bullet(x, y, angle, speed, damage, range, color);
        }
        return bullet;
    }

    static destroy(bullet) {
        bullet.active = false;
        if (Bullet.pool.length < GAME_CONFIG.PERFORMANCE.MAX_BULLETS) {
            Bullet.pool.push(bullet);
        }
    }

    reset(x, y, angle, speed, damage, range, color) {
        this.x = x;
        this.y = y;
        this.startX = x;
        this.startY = y;
        this.angle = angle;
        this.speed = speed;
        this.damage = damage;
        this.range = range;
        this.color = color;
        this.active = true;
        this.vx = Math.cos(angle) * speed;
        this.vy = Math.sin(angle) * speed;
    }

    update(deltaTime) {
        if (!this.active) return;

        this.x += this.vx * deltaTime / 16;
        this.y += this.vy * deltaTime / 16;

        const dx = this.x - this.startX;
        const dy = this.y - this.startY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance > this.range) {
            this.active = false;
        }
    }
}

export class Camera {
    constructor() {
        this.x = 0;
        this.y = 0;
        this.targetX = 0;
        this.targetY = 0;
        this.smoothing = GAME_CONFIG.CAMERA.SMOOTHING;
    }

    update(targetX, targetY, canvasWidth, canvasHeight) {
        this.targetX = targetX - canvasWidth / 2;
        this.targetY = targetY - canvasHeight / 2;

        this.x += (this.targetX - this.x) * this.smoothing;
        this.y += (this.targetY - this.y) * this.smoothing;
    }

    isVisible(x, y, size, canvasWidth, canvasHeight) {
        const buffer = GAME_CONFIG.PERFORMANCE.VIEWPORT_BUFFER;
        return (x + size >= this.x - buffer && 
                x - size <= this.x + canvasWidth + buffer &&
                y + size >= this.y - buffer && 
                y - size <= this.y + canvasHeight + buffer);
    }
}

export class AudioManager {
    constructor() {
        this.context = null;
        this.masterGain = null;
        this.enabled = false;
        this.volume = 0.5;
        
        this.initAudioContext();
    }

    async initAudioContext() {
        try {
            this.context = new (window.AudioContext || window.webkitAudioContext)();
            this.masterGain = this.context.createGain();
            this.masterGain.connect(this.context.destination);
            this.masterGain.gain.value = this.volume;
            this.enabled = true;
        } catch (error) {
            console.warn('Audio not supported:', error);
            this.enabled = false;
        }
    }

    setVolume(volume) {
        this.volume = Math.max(0, Math.min(1, volume));
        if (this.masterGain) {
            this.masterGain.gain.value = this.volume;
        }
    }

    playSound(soundName) {
        if (!this.enabled || !this.context || !GAME_CONFIG.SOUNDS[soundName.toUpperCase()]) {
            return;
        }

        try {
            const sound = GAME_CONFIG.SOUNDS[soundName.toUpperCase()];
            const oscillator = this.context.createOscillator();
            const gainNode = this.context.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(this.masterGain);

            oscillator.frequency.value = sound.freq;
            oscillator.type = 'square';

            gainNode.gain.value = 0.1;
            gainNode.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + sound.duration);

            oscillator.start();
            oscillator.stop(this.context.currentTime + sound.duration);
        } catch (error) {
            console.warn('Error playing sound:', error);
        }
    }
}

export class InputManager {
    constructor() {
        this.keys = {};
        this.mouse = { x: 0, y: 0, down: false };
        this.touches = new Map();
        this.cheatBuffer = '';
        this.cheatCodes = {
            'iddqd': 'god_mode',
            'idkfa': 'all_weapons',
            'idclip': 'no_clip',
            'iddt': 'map_reveal',
            'idbeholdh': 'health_boost',
            'idbehold1': 'invulnerability',
            'idbehold2': 'invisibility'
        };
        
        this.bindEvents();
    }

    bindEvents() {
        document.addEventListener('keydown', (e) => {
            this.keys[e.code] = true;
            
            // Handle cheat codes
            this.handleCheatInput(e.key);
        });

        document.addEventListener('keyup', (e) => {
            this.keys[e.code] = false;
        });

        // Mouse events
        document.addEventListener('mousemove', (e) => {
            this.mouse.x = e.clientX;
            this.mouse.y = e.clientY;
        });

        document.addEventListener('mousedown', (e) => {
            this.mouse.down = true;
        });

        document.addEventListener('mouseup', (e) => {
            this.mouse.down = false;
        });

        // Touch events for mobile
        document.addEventListener('touchstart', this.handleTouchStart.bind(this), { passive: false });
        document.addEventListener('touchmove', this.handleTouchMove.bind(this), { passive: false });
        document.addEventListener('touchend', this.handleTouchEnd.bind(this), { passive: false });
    }

    handleTouchStart(e) {
        e.preventDefault();
        for (let touch of e.changedTouches) {
            this.touches.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
        }
    }

    handleTouchMove(e) {
        e.preventDefault();
        for (let touch of e.changedTouches) {
            if (this.touches.has(touch.identifier)) {
                this.touches.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
            }
        }
    }

    handleTouchEnd(e) {
        e.preventDefault();
        for (let touch of e.changedTouches) {
            this.touches.delete(touch.identifier);
        }
    }

    isKeyPressed(action) {
        const keys = INPUT_KEYS[action] || [];
        return keys.some(key => this.keys[key]);
    }

    isActionPressed(action) {
        return this.isKeyPressed(action) || this.mouse.down;
    }

    handleCheatInput(key) {
        // Only handle letter keys for cheat codes
        if (key.length === 1 && /[a-zA-Z0-9]/.test(key)) {
            this.cheatBuffer += key.toLowerCase();
            
            // Keep buffer manageable
            if (this.cheatBuffer.length > 20) {
                this.cheatBuffer = this.cheatBuffer.slice(-20);
            }
            
            // Check for cheat codes
            for (let cheat in this.cheatCodes) {
                if (this.cheatBuffer.includes(cheat)) {
                    this.triggerCheat(this.cheatCodes[cheat]);
                    this.cheatBuffer = ''; // Clear buffer after successful cheat
                    break;
                }
            }
        } else if (key === 'Escape') {
            // Clear cheat buffer on escape
            this.cheatBuffer = '';
        }
    }

    triggerCheat(cheatType) {
        // Dispatch custom event for cheat activation
        const event = new CustomEvent('cheatActivated', { 
            detail: { type: cheatType } 
        });
        document.dispatchEvent(event);
        
        // Visual feedback
        console.log(`Cheat activated: ${cheatType}`);
    }

    // Method to register cheat callback
    onCheatActivated(callback) {
        document.addEventListener('cheatActivated', callback);
    }
}