import { GAME_CONFIG, GAME_STATES, INPUT_KEYS } from './constants.js';
import { GameState, Player, Enemy, Bullet, Camera, AudioManager, InputManager } from './classes.js';

export class GameEngine {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.lastTime = 0;
        this.animationId = null;
        
        // Game systems
        this.gameState = new GameState();
        this.camera = new Camera();
        this.audioManager = new AudioManager();
        this.inputManager = new InputManager();
        
        // Game objects
        this.player = null;
        this.bullets = [];
        this.enemies = [];
        this.items = [];
        this.doors = [];
        this.explosions = [];
        this.levelData = [];
        this.visibilityMap = [];
        this.exploredMap = [];
        
        // Performance tracking
        this.frameCount = 0;
        this.fps = 0;
        this.lastFpsTime = 0;
        
        this.init();
    }

    init() {
        this.resizeCanvas();
        window.addEventListener('resize', () => this.resizeCanvas());
        
        // Initialize player
        this.player = new Player(400, 300);
        
        // Generate initial level
        this.generateLevel();
        
        // Start game loop
        this.start();
    }

    resizeCanvas() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight - GAME_CONFIG.CANVAS.HUD_HEIGHT;
    }

    start() {
        this.gameState.setState(GAME_STATES.PLAYING);
        this.gameLoop(0);
    }

    stop() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    gameLoop(currentTime) {
        this.animationId = requestAnimationFrame((time) => this.gameLoop(time));
        
        const deltaTime = currentTime - this.lastTime;
        this.lastTime = currentTime;
        
        // Update FPS counter
        this.updateFPS(currentTime);
        
        // Update game based on current state
        switch (this.gameState.current) {
            case GAME_STATES.PLAYING:
                this.update(deltaTime);
                this.render();
                break;
            case GAME_STATES.PAUSED:
                this.renderPauseScreen();
                break;
            case GAME_STATES.GAME_OVER:
                this.renderGameOverScreen();
                break;
            case GAME_STATES.LEVEL_COMPLETE:
                this.renderLevelCompleteScreen();
                break;
            case GAME_STATES.SETTINGS:
                this.renderSettingsScreen();
                break;
            default:
                this.renderMenuScreen();
        }
    }

    updateFPS(currentTime) {
        this.frameCount++;
        if (currentTime - this.lastFpsTime >= 1000) {
            this.fps = this.frameCount;
            this.frameCount = 0;
            this.lastFpsTime = currentTime;
        }
    }

    update(deltaTime) {
        this.handleInput();
        this.updatePlayer(deltaTime);
        this.updateBullets(deltaTime);
        this.updateEnemies(deltaTime);
        this.updateExplosions(deltaTime);
        this.updateCamera();
        this.updateVisibility();
        
        this.checkCollisions();
        this.cleanupObjects();
        
        // Update HUD
        this.updateHUD();
    }

    handleInput() {
        const input = this.inputManager;
        
        // Movement
        let moveX = 0, moveY = 0;
        if (input.isKeyPressed('MOVE_LEFT')) moveX -= 1;
        if (input.isKeyPressed('MOVE_RIGHT')) moveX += 1;
        if (input.isKeyPressed('MOVE_UP')) moveY -= 1;
        if (input.isKeyPressed('MOVE_DOWN')) moveY += 1;
        
        // Normalize diagonal movement
        if (moveX !== 0 && moveY !== 0) {
            moveX *= 0.707;
            moveY *= 0.707;
        }
        
        this.movePlayer(moveX, moveY);
        
        // Shooting
        if (input.isActionPressed('SHOOT')) {
            this.shoot();
        }
        
        // Weapon switching
        for (let i = 1; i <= 6; i++) {
            if (input.isKeyPressed(`WEAPON_${i}`)) {
                this.switchWeapon(i - 1);
            }
        }
        
        // Other actions
        if (input.isKeyPressed('INTERACT')) {
            this.checkDoorInteraction();
        }
        
        if (input.isKeyPressed('PAUSE')) {
            this.togglePause();
        }
        
        if (input.isKeyPressed('SETTINGS')) {
            this.openSettings();
        }
    }

    movePlayer(moveX, moveY) {
        if (moveX === 0 && moveY === 0) return;
        
        const newX = this.player.x + moveX * this.player.speed;
        const newY = this.player.y + moveY * this.player.speed;
        
        // Check collision before moving
        if (!this.checkWallCollision(newX, this.player.y, this.player.size)) {
            this.player.x = newX;
        }
        if (!this.checkWallCollision(this.player.x, newY, this.player.size)) {
            this.player.y = newY;
        }
        
        // Update player angle based on mouse position
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = this.inputManager.mouse.x - rect.left;
        const mouseY = this.inputManager.mouse.y - rect.top;
        const centerX = this.canvas.width / 2;
        const centerY = this.canvas.height / 2;
        
        this.player.angle = Math.atan2(mouseY - centerY, mouseX - centerX);
    }

    updatePlayer(deltaTime) {
        this.player.update(deltaTime);
        
        // Check item collection
        this.checkItemCollection();
        
        // Check exit
        if (this.checkExit()) {
            this.nextLevel();
        }
    }

    updateBullets(deltaTime) {
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const bullet = this.bullets[i];
            bullet.update(deltaTime);
            
            if (!bullet.active || this.checkBulletCollision(bullet)) {
                Bullet.destroy(bullet);
                this.bullets.splice(i, 1);
            }
        }
    }

    updateEnemies(deltaTime) {
        for (let enemy of this.enemies) {
            if (enemy.active) {
                enemy.update(deltaTime, this.player, this.levelData);
            }
        }
    }

    updateExplosions(deltaTime) {
        for (let i = this.explosions.length - 1; i >= 0; i--) {
            const explosion = this.explosions[i];
            explosion.time += deltaTime;
            
            if (explosion.time > explosion.duration) {
                this.explosions.splice(i, 1);
            }
        }
    }

    updateCamera() {
        this.camera.update(this.player.x, this.player.y, this.canvas.width, this.canvas.height);
    }

    updateVisibility() {
        // Implement fog of war / line of sight
        // This is a simplified version
        const playerGridX = Math.floor(this.player.x / GAME_CONFIG.GRID.SIZE);
        const playerGridY = Math.floor(this.player.y / GAME_CONFIG.GRID.SIZE);
        
        // Mark areas around player as explored
        for (let dy = -3; dy <= 3; dy++) {
            for (let dx = -3; dx <= 3; dx++) {
                const gx = playerGridX + dx;
                const gy = playerGridY + dy;
                if (gx >= 0 && gx < this.levelData[0]?.length && gy >= 0 && gy < this.levelData.length) {
                    if (!this.exploredMap[gy]) this.exploredMap[gy] = [];
                    this.exploredMap[gy][gx] = true;
                }
            }
        }
    }

    checkCollisions() {
        // Player-enemy collisions
        for (let enemy of this.enemies) {
            if (!enemy.active) continue;
            
            const dx = this.player.x - enemy.x;
            const dy = this.player.y - enemy.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            if (distance < this.player.size + enemy.size) {
                if (this.player.takeDamage(enemy.damage)) {
                    this.gameState.setState(GAME_STATES.GAME_OVER);
                }
                this.audioManager.playSound('HIT');
            }
        }
        
        // Bullet-enemy collisions
        for (let bullet of this.bullets) {
            if (!bullet.active) continue;
            
            for (let enemy of this.enemies) {
                if (!enemy.active) continue;
                
                const dx = bullet.x - enemy.x;
                const dy = bullet.y - enemy.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                
                if (distance < enemy.size) {
                    bullet.active = false;
                    if (enemy.takeDamage(bullet.damage)) {
                        this.gameState.score += enemy.points;
                        this.createExplosion(enemy.x, enemy.y);
                        enemy.destroy();
                    }
                    this.audioManager.playSound('HIT');
                }
            }
        }
    }

    cleanupObjects() {
        // Clean up inactive enemies
        this.enemies = this.enemies.filter(enemy => enemy.active);
        
        // Limit bullet count for performance
        if (this.bullets.length > GAME_CONFIG.PERFORMANCE.MAX_BULLETS) {
            const excess = this.bullets.splice(0, this.bullets.length - GAME_CONFIG.PERFORMANCE.MAX_BULLETS);
            excess.forEach(bullet => Bullet.destroy(bullet));
        }
        
        // Limit explosion count
        if (this.explosions.length > GAME_CONFIG.PERFORMANCE.MAX_EXPLOSIONS) {
            this.explosions.splice(0, this.explosions.length - GAME_CONFIG.PERFORMANCE.MAX_EXPLOSIONS);
        }
    }

    checkWallCollision(x, y, size) {
        const gridX = Math.floor(x / GAME_CONFIG.GRID.SIZE);
        const gridY = Math.floor(y / GAME_CONFIG.GRID.SIZE);
        
        if (gridY < 0 || gridY >= this.levelData.length || 
            gridX < 0 || gridX >= this.levelData[0]?.length) {
            return true;
        }
        
        const cell = this.levelData[gridY][gridX];
        return this.isSolidWallType(cell);
    }

    checkBulletCollision(bullet) {
        return this.checkWallCollision(bullet.x, bullet.y, 2);
    }

    isSolidWallType(cellType) {
        return cellType === 1 || cellType === 2; // Basic wall types
    }

    shoot() {
        const now = Date.now();
        const weapon = GAME_CONFIG.WEAPONS[this.player.weapons[this.player.currentWeapon]?.toUpperCase()];
        
        if (!weapon || now - this.player.lastShot < weapon.delay) return;
        if (!this.player.hasAmmo(this.player.weapons[this.player.currentWeapon])) return;
        
        const bullet = Bullet.create(
            this.player.x, 
            this.player.y, 
            this.player.angle, 
            10, 
            weapon.damage, 
            weapon.range
        );
        
        this.bullets.push(bullet);
        this.player.useAmmo(this.player.weapons[this.player.currentWeapon]);
        this.player.lastShot = now;
        
        this.audioManager.playSound(weapon.name.split(' ')[0]);
    }

    createExplosion(x, y) {
        this.explosions.push({
            x: x,
            y: y,
            time: 0,
            duration: 500,
            radius: 30
        });
    }

    // Rendering methods
    render() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        this.ctx.save();
        this.ctx.translate(-this.camera.x, -this.camera.y);
        
        this.renderLevel();
        this.renderItems();
        this.renderEnemies();
        this.renderPlayer();
        this.renderBullets();
        this.renderExplosions();
        
        this.ctx.restore();
        
        // Render UI elements that shouldn't be affected by camera
        this.renderDebugInfo();
    }

    renderLevel() {
        // Simplified level rendering - implement full tilemap rendering
        for (let y = 0; y < this.levelData.length; y++) {
            for (let x = 0; x < this.levelData[y].length; x++) {
                const cell = this.levelData[y][x];
                const screenX = x * GAME_CONFIG.GRID.SIZE;
                const screenY = y * GAME_CONFIG.GRID.SIZE;
                
                // Only render visible tiles
                if (!this.camera.isVisible(screenX, screenY, GAME_CONFIG.GRID.SIZE, this.canvas.width, this.canvas.height)) {
                    continue;
                }
                
                // Only render explored areas
                if (!this.exploredMap[y]?.[x]) {
                    continue;
                }
                
                this.ctx.fillStyle = this.getCellColor(cell);
                this.ctx.fillRect(screenX, screenY, GAME_CONFIG.GRID.SIZE, GAME_CONFIG.GRID.SIZE);
            }
        }
    }

    getCellColor(cell) {
        switch (cell) {
            case 0: return GAME_CONFIG.COLORS.FLOOR;
            case 1: return GAME_CONFIG.COLORS.WALL;
            case 2: return GAME_CONFIG.COLORS.DOOR;
            default: return GAME_CONFIG.COLORS.FLOOR;
        }
    }

    renderPlayer() {
        if (!this.camera.isVisible(this.player.x, this.player.y, this.player.size, this.canvas.width, this.canvas.height)) {
            return;
        }
        
        this.ctx.fillStyle = this.player.invulnerable ? '#FF6666' : GAME_CONFIG.COLORS.PLAYER;
        this.ctx.fillRect(
            this.player.x - this.player.size / 2, 
            this.player.y - this.player.size / 2, 
            this.player.size, 
            this.player.size
        );
        
        // Draw direction indicator
        this.ctx.strokeStyle = GAME_CONFIG.COLORS.PLAYER;
        this.ctx.beginPath();
        this.ctx.moveTo(this.player.x, this.player.y);
        this.ctx.lineTo(
            this.player.x + Math.cos(this.player.angle) * this.player.size,
            this.player.y + Math.sin(this.player.angle) * this.player.size
        );
        this.ctx.stroke();
    }

    renderEnemies() {
        for (let enemy of this.enemies) {
            if (!enemy.active) continue;
            if (!this.camera.isVisible(enemy.x, enemy.y, enemy.size, this.canvas.width, this.canvas.height)) {
                continue;
            }
            
            this.ctx.fillStyle = enemy.isBoss ? '#FF6666' : GAME_CONFIG.COLORS.ENEMY;
            this.ctx.fillRect(
                enemy.x - enemy.size / 2, 
                enemy.y - enemy.size / 2, 
                enemy.size, 
                enemy.size
            );
        }
    }

    renderBullets() {
        for (let bullet of this.bullets) {
            if (!bullet.active) continue;
            if (!this.camera.isVisible(bullet.x, bullet.y, 4, this.canvas.width, this.canvas.height)) {
                continue;
            }
            
            this.ctx.fillStyle = bullet.color;
            this.ctx.fillRect(bullet.x - 2, bullet.y - 2, 4, 4);
        }
    }

    renderExplosions() {
        for (let explosion of this.explosions) {
            if (!this.camera.isVisible(explosion.x, explosion.y, explosion.radius, this.canvas.width, this.canvas.height)) {
                continue;
            }
            
            const progress = explosion.time / explosion.duration;
            const radius = explosion.radius * (1 - progress);
            const alpha = 1 - progress;
            
            this.ctx.fillStyle = `rgba(255, 165, 0, ${alpha})`;
            this.ctx.beginPath();
            this.ctx.arc(explosion.x, explosion.y, radius, 0, Math.PI * 2);
            this.ctx.fill();
        }
    }

    renderItems() {
        // Implement item rendering
    }

    renderDebugInfo() {
        if (this.gameState.settings.graphics === 'debug') {
            this.ctx.fillStyle = '#00FF00';
            this.ctx.font = '12px monospace';
            this.ctx.fillText(`FPS: ${this.fps}`, 10, 30);
            this.ctx.fillText(`Bullets: ${this.bullets.length}`, 10, 45);
            this.ctx.fillText(`Enemies: ${this.enemies.filter(e => e.active).length}`, 10, 60);
            this.ctx.fillText(`Player: ${Math.floor(this.player.x)}, ${Math.floor(this.player.y)}`, 10, 75);
        }
    }

    // UI screens
    renderMenuScreen() {
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        this.ctx.fillStyle = '#FF0';
        this.ctx.font = '48px monospace';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('DOOM GAME', this.canvas.width / 2, this.canvas.height / 2 - 50);
        
        this.ctx.font = '24px monospace';
        this.ctx.fillText('Press any key to start', this.canvas.width / 2, this.canvas.height / 2 + 50);
    }

    renderPauseScreen() {
        // Render game in background with overlay
        this.render();
        
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        this.ctx.fillStyle = '#FF0';
        this.ctx.font = '48px monospace';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('PAUSED', this.canvas.width / 2, this.canvas.height / 2);
    }

    renderGameOverScreen() {
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        this.ctx.fillStyle = '#F00';
        this.ctx.font = '48px monospace';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('GAME OVER', this.canvas.width / 2, this.canvas.height / 2 - 50);
        
        this.ctx.fillStyle = '#FFF';
        this.ctx.font = '24px monospace';
        this.ctx.fillText(`Score: ${this.gameState.score}`, this.canvas.width / 2, this.canvas.height / 2 + 50);
    }

    renderLevelCompleteScreen() {
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        this.ctx.fillStyle = '#0F0';
        this.ctx.font = '48px monospace';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('LEVEL COMPLETE', this.canvas.width / 2, this.canvas.height / 2 - 50);
        
        this.ctx.fillStyle = '#FFF';
        this.ctx.font = '24px monospace';
        this.ctx.fillText(`Score: ${this.gameState.score}`, this.canvas.width / 2, this.canvas.height / 2 + 50);
    }

    renderSettingsScreen() {
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        this.ctx.fillStyle = '#FF0';
        this.ctx.font = '48px monospace';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('SETTINGS', this.canvas.width / 2, this.canvas.height / 2 - 100);
        
        // Settings options would be rendered here
    }

    // Game logic methods
    generateLevel() {
        // Simplified level generation
        const width = 32;
        const height = 24;
        this.levelData = Array(height).fill().map(() => Array(width).fill(0));
        this.exploredMap = Array(height).fill().map(() => Array(width).fill(false));
        
        // Add walls around the border
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
                    this.levelData[y][x] = 1;
                }
            }
        }
        
        // Add some interior walls
        for (let i = 0; i < 20; i++) {
            const x = Math.floor(Math.random() * (width - 2)) + 1;
            const y = Math.floor(Math.random() * (height - 2)) + 1;
            this.levelData[y][x] = 1;
        }
        
        // Generate enemies
        this.generateEnemies();
    }

    generateEnemies() {
        this.enemies = [];
        for (let i = 0; i < 5; i++) {
            const x = Math.random() * 800 + 100;
            const y = Math.random() * 600 + 100;
            this.enemies.push(new Enemy(x, y, 'zombie'));
        }
    }

    switchWeapon(weaponIndex) {
        if (weaponIndex < this.player.weapons.length) {
            this.player.currentWeapon = weaponIndex;
        }
    }

    togglePause() {
        if (this.gameState.current === GAME_STATES.PLAYING) {
            this.gameState.setState(GAME_STATES.PAUSED);
        } else if (this.gameState.current === GAME_STATES.PAUSED) {
            this.gameState.setState(GAME_STATES.PLAYING);
        }
    }

    openSettings() {
        this.gameState.setState(GAME_STATES.SETTINGS);
    }

    checkItemCollection() {
        // Implement item collection logic
    }

    checkDoorInteraction() {
        // Implement door interaction logic
    }

    checkExit() {
        // Implement level exit check
        return false;
    }

    nextLevel() {
        this.gameState.level++;
        this.generateLevel();
        this.gameState.setState(GAME_STATES.LEVEL_COMPLETE);
    }

    updateHUD() {
        // Update HUD elements
        const healthElement = document.getElementById('health');
        const weaponElement = document.getElementById('weaponName');
        const ammoElement = document.getElementById('ammo');
        
        if (healthElement) healthElement.textContent = this.player.health;
        if (weaponElement) weaponElement.textContent = this.player.weapons[this.player.currentWeapon]?.toUpperCase() || 'FIST';
        if (ammoElement) {
            const currentWeapon = this.player.weapons[this.player.currentWeapon];
            const ammo = this.player.ammo[currentWeapon];
            ammoElement.textContent = ammo === -1 ? '∞' : ammo;
        }
        
        // Update level and score display
        document.querySelector('.level-info').textContent = `Level ${this.gameState.level}`;
        document.querySelector('.score-info').textContent = `Score: ${this.gameState.score}`;
    }
}