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
        
        // Set up cheat code handling
        this.setupCheats();
        
        // Start game loop
        this.start();
    }

    resizeCanvas() {
        this.canvas.width = window.innerWidth;
        
        // Full height for menu states, reduced for gameplay
        const isGameplay = this.gameState?.current === GAME_STATES.PLAYING || 
                          this.gameState?.current === GAME_STATES.PAUSED;
        
        this.canvas.height = window.innerHeight - (isGameplay ? GAME_CONFIG.CANVAS.HUD_HEIGHT : 0);
    }

    start() {
        this.gameState.setState(GAME_STATES.MENU);
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
        
        // Handle input for all states
        this.handleGlobalInput();
        
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
            case GAME_STATES.INSTRUCTIONS:
                this.renderInstructionsScreen();
                break;
            case GAME_STATES.MENU:
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

    handleGlobalInput() {
        const input = this.inputManager;
        
        // Menu navigation
        if (this.gameState.current === GAME_STATES.MENU) {
            if (input.isKeyPressed('SHOOT') || input.keys['Enter']) {
                this.gameState.setState(GAME_STATES.PLAYING);
                this.inputManager.keys['Space'] = false;
                this.inputManager.keys['Enter'] = false;
            } else if (input.keys['KeyI']) {
                this.gameState.setState(GAME_STATES.INSTRUCTIONS);
                this.inputManager.keys['KeyI'] = false;
            }
        } else if (this.gameState.current === GAME_STATES.INSTRUCTIONS) {
            if (input.keys['Escape'] || input.keys['Enter']) {
                this.gameState.setState(GAME_STATES.MENU);
                this.inputManager.keys['Escape'] = false;
                this.inputManager.keys['Enter'] = false;
            }
        } else if (this.gameState.current === GAME_STATES.GAME_OVER) {
            if (input.keys['Enter'] || input.isKeyPressed('SHOOT')) {
                this.resetGame();
                this.gameState.setState(GAME_STATES.MENU);
                this.inputManager.keys['Enter'] = false;
                this.inputManager.keys['Space'] = false;
            }
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
        if (!this.levelData || this.levelData.length === 0) return;
        
        const CELL_SIZE = GAME_CONFIG.GRID.SIZE;
        const playerGridX = Math.floor(this.player.x / CELL_SIZE);
        const playerGridY = Math.floor(this.player.y / CELL_SIZE);
        const viewDistance = 12; // Reasonable view distance
        
        // Reset current visibility
        for (let y = 0; y < this.levelData.length; y++) {
            if (!this.visibilityMap[y]) this.visibilityMap[y] = [];
            for (let x = 0; x < this.levelData[y].length; x++) {
                this.visibilityMap[y][x] = false;
            }
        }
        
        // Always make player position visible
        if (playerGridY >= 0 && playerGridY < this.levelData.length &&
            playerGridX >= 0 && playerGridX < this.levelData[0].length) {
            this.visibilityMap[playerGridY][playerGridX] = true;
            if (!this.exploredMap[playerGridY]) this.exploredMap[playerGridY] = [];
            this.exploredMap[playerGridY][playerGridX] = true;
        }
        
        // Use a more precise raycasting algorithm
        const rays = 720; // Higher resolution for smoother visibility
        for (let i = 0; i < rays; i++) {
            const angle = (i / rays) * 2 * Math.PI;
            const dx = Math.cos(angle);
            const dy = Math.sin(angle);
            
            this.castVisibilityRay(playerGridX, playerGridY, dx, dy, viewDistance);
        }
        
        // Also do a flood fill for immediate area to ensure proper visibility
        this.floodFillVisibility(playerGridX, playerGridY, 2);
    }
    
    castVisibilityRay(startX, startY, dx, dy, maxDistance) {
        let currentX = startX + 0.5; // Start from center of cell
        let currentY = startY + 0.5;
        
        const stepSize = 0.1; // Smaller steps for better precision
        
        for (let step = 0; step < maxDistance / stepSize; step++) {
            currentX += dx * stepSize;
            currentY += dy * stepSize;
            
            const gridX = Math.floor(currentX);
            const gridY = Math.floor(currentY);
            
            // Check bounds
            if (gridX < 0 || gridX >= this.levelData[0].length || 
                gridY < 0 || gridY >= this.levelData.length) {
                break;
            }
            
            // Mark as visible and explored
            this.visibilityMap[gridY][gridX] = true;
            if (!this.exploredMap[gridY]) this.exploredMap[gridY] = [];
            this.exploredMap[gridY][gridX] = true;
            
            // Stop ray AFTER marking wall as visible
            if (this.isSolidWallType(this.levelData[gridY][gridX])) {
                break;
            }
        }
    }
    
    floodFillVisibility(centerX, centerY, radius) {
        // Simple flood fill for immediate area around player
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const x = centerX + dx;
                const y = centerY + dy;
                
                if (x >= 0 && x < this.levelData[0].length && 
                    y >= 0 && y < this.levelData.length) {
                    
                    // Only fill if within circular radius
                    if (dx * dx + dy * dy <= radius * radius) {
                        this.visibilityMap[y][x] = true;
                        if (!this.exploredMap[y]) this.exploredMap[y] = [];
                        this.exploredMap[y][x] = true;
                    }
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
        // No collision if no-clip cheat is active
        if (this.cheatEffects?.noClip) {
            return false;
        }
        
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
        for (let y = 0; y < this.levelData.length; y++) {
            for (let x = 0; x < this.levelData[y].length; x++) {
                const cell = this.levelData[y][x];
                const screenX = x * GAME_CONFIG.GRID.SIZE;
                const screenY = y * GAME_CONFIG.GRID.SIZE;
                
                // Only render visible tiles
                if (!this.camera.isVisible(screenX, screenY, GAME_CONFIG.GRID.SIZE, this.canvas.width, this.canvas.height)) {
                    continue;
                }
                
                // Skip unexplored areas
                if (!this.exploredMap[y]?.[x]) {
                    continue;
                }
                
                // Get base color using texture information
                const baseColor = this.getCellColor(cell, this.textureMap[y][x]);
                
                // Apply fog of war effect
                const isVisible = this.visibilityMap[y]?.[x];
                if (isVisible) {
                    // Fully visible - normal color
                    this.ctx.fillStyle = baseColor;
                } else {
                    // Explored but not currently visible - dimmed
                    this.ctx.fillStyle = this.dimColor(baseColor, 0.4);
                }
                
                this.ctx.fillRect(screenX, screenY, GAME_CONFIG.GRID.SIZE, GAME_CONFIG.GRID.SIZE);
                
                // Add texture details and borders
                this.renderTextureDetails(cell, this.textureMap[y][x], screenX, screenY, isVisible);
            }
        }
    }

    dimColor(color, factor) {
        // Convert hex color to RGB and dim it
        if (color.startsWith('#')) {
            const r = parseInt(color.slice(1, 3), 16);
            const g = parseInt(color.slice(3, 5), 16);
            const b = parseInt(color.slice(5, 7), 16);
            
            return `rgb(${Math.floor(r * factor)}, ${Math.floor(g * factor)}, ${Math.floor(b * factor)})`;
        }
        return color; // Fallback for non-hex colors
    }

    getCellColor(cell, theme) {
        switch (cell) {
            case 0: // Floor
                switch (theme) {
                    case 'BROWN': return GAME_CONFIG.COLORS.FLOOR_GREY;
                    case 'GREY': return GAME_CONFIG.COLORS.FLOOR_METAL;
                    case 'RED': return GAME_CONFIG.COLORS.FLOOR_STONE;
                    case 'METAL': return GAME_CONFIG.COLORS.FLOOR_METAL;
                    case 'TECH': return GAME_CONFIG.COLORS.FLOOR_TECH;
                    default: return GAME_CONFIG.COLORS.FLOOR_GREY;
                }
            case 1: // Wall
                switch (theme) {
                    case 'BROWN': return GAME_CONFIG.COLORS.WALL_BROWN;
                    case 'GREY': return GAME_CONFIG.COLORS.WALL_GREY;
                    case 'RED': return GAME_CONFIG.COLORS.WALL_RED;
                    case 'METAL': return GAME_CONFIG.COLORS.WALL_METAL;
                    case 'TECH': return GAME_CONFIG.COLORS.WALL_TECH;
                    default: return GAME_CONFIG.COLORS.WALL_BROWN;
                }
            case 2: // Door
                switch (theme) {
                    case 'BROWN': return GAME_CONFIG.COLORS.DOOR_BROWN;
                    case 'GREY': case 'METAL': return GAME_CONFIG.COLORS.DOOR_METAL;
                    case 'RED': return GAME_CONFIG.COLORS.DOOR_BROWN;
                    case 'TECH': return GAME_CONFIG.COLORS.DOOR_TECH;
                    default: return GAME_CONFIG.COLORS.DOOR_BROWN;
                }
            default: 
                return GAME_CONFIG.COLORS.FLOOR_GREY;
        }
    }

    renderTextureDetails(cell, theme, x, y, isVisible) {
        const size = GAME_CONFIG.GRID.SIZE;
        const alpha = isVisible ? 1.0 : 0.4;
        
        this.ctx.save();
        this.ctx.globalAlpha = alpha;
        
        if (cell === 1) { // Walls
            // Add texture-specific wall details
            switch (theme) {
                case 'BROWN':
                    // Stone brick lines
                    this.ctx.strokeStyle = '#6B5D4B';
                    this.ctx.lineWidth = 1;
                    this.ctx.strokeRect(x, y, size, size);
                    // Horizontal mortar line
                    this.ctx.beginPath();
                    this.ctx.moveTo(x, y + size/2);
                    this.ctx.lineTo(x + size, y + size/2);
                    this.ctx.stroke();
                    break;
                    
                case 'GREY':
                    // Stone block pattern
                    this.ctx.strokeStyle = '#4A4A4A';
                    this.ctx.lineWidth = 1;
                    this.ctx.strokeRect(x, y, size, size);
                    break;
                    
                case 'RED':
                    // Brick pattern
                    this.ctx.strokeStyle = '#6B2B13';
                    this.ctx.lineWidth = 1;
                    this.ctx.strokeRect(x, y, size, size);
                    // Brick divisions
                    this.ctx.beginPath();
                    this.ctx.moveTo(x + size/2, y);
                    this.ctx.lineTo(x + size/2, y + size);
                    this.ctx.stroke();
                    break;
                    
                case 'METAL':
                    // Metal panel lines
                    this.ctx.strokeStyle = '#3A3A3A';
                    this.ctx.lineWidth = 2;
                    this.ctx.strokeRect(x, y, size, size);
                    // Rivets
                    this.ctx.fillStyle = '#2A2A2A';
                    this.ctx.beginPath();
                    this.ctx.arc(x + 4, y + 4, 1, 0, Math.PI * 2);
                    this.ctx.arc(x + size - 4, y + 4, 1, 0, Math.PI * 2);
                    this.ctx.arc(x + 4, y + size - 4, 1, 0, Math.PI * 2);
                    this.ctx.arc(x + size - 4, y + size - 4, 1, 0, Math.PI * 2);
                    this.ctx.fill();
                    break;
                    
                case 'TECH':
                    // Tech panel with lines
                    this.ctx.strokeStyle = '#2A4A6A';
                    this.ctx.lineWidth = 1;
                    this.ctx.strokeRect(x, y, size, size);
                    // Circuit pattern
                    this.ctx.strokeStyle = '#1A3A5A';
                    this.ctx.beginPath();
                    this.ctx.moveTo(x + size/4, y);
                    this.ctx.lineTo(x + size/4, y + size);
                    this.ctx.moveTo(x + 3*size/4, y);
                    this.ctx.lineTo(x + 3*size/4, y + size);
                    this.ctx.stroke();
                    break;
            }
        } else if (cell === 2) { // Doors
            // Door frame
            this.ctx.strokeStyle = isVisible ? '#8A7A6A' : this.dimColor('#8A7A6A', 0.4);
            this.ctx.lineWidth = 2;
            this.ctx.strokeRect(x, y, size, size);
            
            // Door handle
            this.ctx.fillStyle = isVisible ? '#FFD700' : this.dimColor('#FFD700', 0.4);
            this.ctx.beginPath();
            this.ctx.arc(x + size - 6, y + size/2, 2, 0, Math.PI * 2);
            this.ctx.fill();
        }
        
        this.ctx.restore();
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
        const CELL_SIZE = GAME_CONFIG.GRID.SIZE;
        let visibleEnemies = 0;
        
        for (let enemy of this.enemies) {
            if (!enemy.active) continue;
            if (!this.camera.isVisible(enemy.x, enemy.y, enemy.size, this.canvas.width, this.canvas.height)) {
                continue;
            }
            
            // Check if enemy is in visible area
            const enemyGridX = Math.floor(enemy.x / CELL_SIZE);
            const enemyGridY = Math.floor(enemy.y / CELL_SIZE);
            
            // In debug mode, show all enemies; otherwise respect fog of war
            if (this.gameState.settings.graphics !== 'debug' && !this.visibilityMap[enemyGridY]?.[enemyGridX]) {
                continue; // Don't render enemies not in line of sight
            }
            
            visibleEnemies++;
            
            // Draw enemy body
            this.ctx.fillStyle = enemy.isBoss ? '#FF6666' : this.getEnemyColor(enemy.type);
            this.ctx.fillRect(
                enemy.x - enemy.size / 2, 
                enemy.y - enemy.size / 2, 
                enemy.size, 
                enemy.size
            );
            
            // Draw enemy direction indicator
            this.ctx.strokeStyle = '#FFFFFF';
            this.ctx.lineWidth = 2;
            this.ctx.beginPath();
            this.ctx.moveTo(enemy.x, enemy.y);
            this.ctx.lineTo(
                enemy.x + Math.cos(enemy.angle) * enemy.size,
                enemy.y + Math.sin(enemy.angle) * enemy.size
            );
            this.ctx.stroke();
            
            // Draw health bar for debugging
            if (this.gameState.settings.graphics === 'debug') {
                const healthPercent = enemy.health / enemy.maxHealth;
                this.ctx.fillStyle = '#FF0000';
                this.ctx.fillRect(enemy.x - enemy.size / 2, enemy.y - enemy.size / 2 - 8, enemy.size, 3);
                this.ctx.fillStyle = '#00FF00';
                this.ctx.fillRect(enemy.x - enemy.size / 2, enemy.y - enemy.size / 2 - 8, enemy.size * healthPercent, 3);
            }
        }
        
        // Update debug counter
        if (this.gameState.settings.graphics === 'debug') {
            this.visibleEnemyCount = visibleEnemies;
        }
    }
    
    getEnemyColor(type) {
        switch (type.toLowerCase()) {
            case 'zombie': return '#8B4513';
            case 'demon': return '#800080';
            case 'cacodemon': return '#FF6347';
            case 'baron': return '#2F4F4F';
            default: return GAME_CONFIG.COLORS.ENEMY;
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
        const CELL_SIZE = GAME_CONFIG.GRID.SIZE;
        
        for (let item of this.items) {
            if (item.collected) continue;
            if (!this.camera.isVisible(item.x, item.y, 16, this.canvas.width, this.canvas.height)) {
                continue;
            }
            
            // Check if item is in visible or explored area
            const itemGridX = Math.floor(item.x / CELL_SIZE);
            const itemGridY = Math.floor(item.y / CELL_SIZE);
            
            if (!this.exploredMap[itemGridY]?.[itemGridX]) {
                continue;
            }
            
            // Dim items not currently visible
            const isVisible = this.visibilityMap[itemGridY]?.[itemGridX];
            const alpha = isVisible ? 1.0 : 0.4;
            
            this.ctx.save();
            this.ctx.globalAlpha = alpha;
            
            if (item.type === 'health') {
                this.ctx.fillStyle = GAME_CONFIG.COLORS.HEALTH;
                this.ctx.fillRect(item.x - 8, item.y - 8, 16, 16);
                
                // Draw cross
                this.ctx.fillStyle = '#FFFFFF';
                this.ctx.fillRect(item.x - 2, item.y - 6, 4, 12);
                this.ctx.fillRect(item.x - 6, item.y - 2, 12, 4);
            } else if (item.type === 'ammo') {
                this.ctx.fillStyle = GAME_CONFIG.COLORS.AMMO;
                this.ctx.fillRect(item.x - 6, item.y - 4, 12, 8);
            }
            
            this.ctx.restore();
        }
    }

    renderDebugInfo() {
        if (this.gameState.settings.graphics === 'debug') {
            this.ctx.fillStyle = '#00FF00';
            this.ctx.font = '12px monospace';
            this.ctx.fillText(`FPS: ${this.fps}`, 10, 30);
            this.ctx.fillText(`Bullets: ${this.bullets.length}`, 10, 45);
            this.ctx.fillText(`Enemies: ${this.enemies.filter(e => e.active).length} (${this.visibleEnemyCount || 0} visible)`, 10, 60);
            this.ctx.fillText(`Rooms: ${this.rooms?.length || 0}`, 10, 75);
            this.ctx.fillText(`Player: ${Math.floor(this.player.x)}, ${Math.floor(this.player.y)}`, 10, 90);
            this.ctx.fillText(`Total Enemies Generated: ${this.enemies.length}`, 10, 105);
        }
    }

    // UI screens
    renderMenuScreen() {
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Title
        this.ctx.fillStyle = '#FF0';
        this.ctx.font = 'bold 48px monospace';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('DOOM GAME', this.canvas.width / 2, this.canvas.height / 2 - 120);
        
        // Subtitle
        this.ctx.fillStyle = '#FFF';
        this.ctx.font = '16px monospace';
        this.ctx.fillText('Top-Down Action Game', this.canvas.width / 2, this.canvas.height / 2 - 80);
        
        // Menu options
        this.ctx.font = 'bold 24px monospace';
        this.ctx.fillStyle = '#0F0';
        this.ctx.fillText('PRESS SPACE OR ENTER TO START', this.canvas.width / 2, this.canvas.height / 2);
        
        this.ctx.fillStyle = '#FF0';
        this.ctx.font = '18px monospace';
        this.ctx.fillText('Press I for Instructions', this.canvas.width / 2, this.canvas.height / 2 + 40);
        
        // Credits
        this.ctx.fillStyle = '#666';
        this.ctx.font = '12px monospace';
        this.ctx.fillText('Improved version with enhanced performance and features', this.canvas.width / 2, this.canvas.height - 40);
    }

    renderInstructionsScreen() {
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        this.ctx.fillStyle = '#FF0';
        this.ctx.font = 'bold 36px monospace';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('INSTRUCTIONS', this.canvas.width / 2, 80);
        
        // Instructions
        const instructions = [
            '',
            'CONTROLS:',
            'WASD / Arrow Keys - Move',
            'Mouse - Aim',
            'Space / Left Click - Shoot',
            'E - Interact with doors',
            '1-6 - Switch weapons',
            'Escape - Pause',
            'M - Settings',
            '',
            'OBJECTIVES:',
            '• Explore the dungeon',
            '• Defeat all enemies',
            '• Collect health and ammo',
            '• Find the exit to next level',
            '',
            'CHEAT CODES:',
            'IDDQD - God mode',
            'IDKFA - All weapons & ammo',
            'IDCLIP - No clipping',
            'IDDT - Reveal map',
            'IDBEHOLDH - Full health',
            '',
            'Press ESCAPE or ENTER to return to menu'
        ];
        
        this.ctx.font = '16px monospace';
        this.ctx.textAlign = 'left';
        
        const startY = 120;
        const lineHeight = 20;
        const leftMargin = 50;
        
        for (let i = 0; i < instructions.length; i++) {
            const line = instructions[i];
            if (line.includes('CONTROLS:') || line.includes('OBJECTIVES:') || line.includes('CHEAT CODES:')) {
                this.ctx.fillStyle = '#0F0';
                this.ctx.font = 'bold 18px monospace';
            } else if (line.startsWith('•') || line.includes(' - ')) {
                this.ctx.fillStyle = '#FFF';
                this.ctx.font = '16px monospace';
            } else {
                this.ctx.fillStyle = '#AAA';
                this.ctx.font = '16px monospace';
            }
            
            this.ctx.fillText(line, leftMargin, startY + i * lineHeight);
        }
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
        const LEVEL_WIDTH = 60;
        const LEVEL_HEIGHT = 45;
        const CELL_SIZE = GAME_CONFIG.GRID.SIZE;
        
        // Initialize level with walls
        this.levelData = Array(LEVEL_HEIGHT).fill().map(() => Array(LEVEL_WIDTH).fill(1));
        this.textureMap = Array(LEVEL_HEIGHT).fill().map(() => Array(LEVEL_WIDTH).fill('BROWN')); // Texture themes
        this.exploredMap = Array(LEVEL_HEIGHT).fill().map(() => Array(LEVEL_WIDTH).fill(false));
        this.visibilityMap = Array(LEVEL_HEIGHT).fill().map(() => Array(LEVEL_WIDTH).fill(false));
        
        // Generate rooms
        const rooms = [];
        const numRooms = 6 + Math.floor(Math.random() * 4); // 6-10 rooms
        
        // Create rooms with proper spacing
        for (let i = 0; i < numRooms; i++) {
            let room = null;
            let attempts = 0;
            
            while (!room && attempts < 100) {
                const w = 4 + Math.floor(Math.random() * 8); // 4-12 width
                const h = 4 + Math.floor(Math.random() * 8); // 4-12 height
                const x = 1 + Math.floor(Math.random() * (LEVEL_WIDTH - w - 2));
                const y = 1 + Math.floor(Math.random() * (LEVEL_HEIGHT - h - 2));
                
                // Check if room overlaps with existing rooms
                let overlaps = false;
                for (let existingRoom of rooms) {
                    if (!(x + w + 1 < existingRoom.x || x - 1 > existingRoom.x + existingRoom.w ||
                          y + h + 1 < existingRoom.y || y - 1 > existingRoom.y + existingRoom.h)) {
                        overlaps = true;
                        break;
                    }
                }
                
                if (!overlaps) {
                    // Assign texture theme to room
                    const themes = ['BROWN', 'GREY', 'RED', 'METAL', 'TECH'];
                    const theme = i === 0 ? 'BROWN' : themes[Math.floor(Math.random() * themes.length)];
                    room = { x, y, w, h, type: i === 0 ? 'start' : 'normal', theme };
                    rooms.push(room);
                }
                attempts++;
            }
        }
        
        // Carve out rooms and apply textures
        for (let room of rooms) {
            for (let y = room.y; y < room.y + room.h; y++) {
                for (let x = room.x; x < room.x + room.w; x++) {
                    if (x >= 0 && x < LEVEL_WIDTH && y >= 0 && y < LEVEL_HEIGHT) {
                        this.levelData[y][x] = 0; // Floor
                        this.textureMap[y][x] = room.theme; // Apply room's texture theme
                    }
                }
            }
        }
        
        // Create hallways to connect rooms
        for (let i = 0; i < rooms.length - 1; i++) {
            const roomA = rooms[i];
            const roomB = rooms[i + 1];
            
            // Create L-shaped hallway
            const startX = Math.floor(roomA.x + roomA.w / 2);
            const startY = Math.floor(roomA.y + roomA.h / 2);
            const endX = Math.floor(roomB.x + roomB.w / 2);
            const endY = Math.floor(roomB.y + roomB.h / 2);
            
            // Horizontal segment
            const minX = Math.min(startX, endX);
            const maxX = Math.max(startX, endX);
            for (let x = minX; x <= maxX; x++) {
                if (x >= 0 && x < LEVEL_WIDTH && startY >= 0 && startY < LEVEL_HEIGHT) {
                    this.levelData[startY][x] = 0;
                    this.textureMap[startY][x] = 'GREY'; // Hallways are grey
                    // Make hallway 2 tiles wide
                    if (startY + 1 < LEVEL_HEIGHT) {
                        this.levelData[startY + 1][x] = 0;
                        this.textureMap[startY + 1][x] = 'GREY';
                    }
                }
            }
            
            // Vertical segment
            const minY = Math.min(startY, endY);
            const maxY = Math.max(startY, endY);
            for (let y = minY; y <= maxY; y++) {
                if (endX >= 0 && endX < LEVEL_WIDTH && y >= 0 && y < LEVEL_HEIGHT) {
                    this.levelData[y][endX] = 0;
                    this.textureMap[y][endX] = 'GREY';
                    // Make hallway 2 tiles wide
                    if (endX + 1 < LEVEL_WIDTH) {
                        this.levelData[y][endX + 1] = 0;
                        this.textureMap[y][endX + 1] = 'GREY';
                    }
                }
            }
        }
        
        // Add doors to rooms (except the starting room)
        this.placeDoors(rooms);
        
        // Add some interior obstacles and variety
        for (let room of rooms) {
            // Add pillars in larger rooms
            if (room.w > 6 && room.h > 6) {
                const pillarX = room.x + 2 + Math.floor(Math.random() * (room.w - 4));
                const pillarY = room.y + 2 + Math.floor(Math.random() * (room.h - 4));
                this.levelData[pillarY][pillarX] = 1;
            }
        }
        
        // Place player in first room
        if (rooms.length > 0) {
            const startRoom = rooms[0];
            this.player.x = (startRoom.x + Math.floor(startRoom.w / 2)) * CELL_SIZE + CELL_SIZE / 2;
            this.player.y = (startRoom.y + Math.floor(startRoom.h / 2)) * CELL_SIZE + CELL_SIZE / 2;
        }
        
        // Store rooms for other systems
        this.rooms = rooms;
        
        console.log(`Generated level with ${rooms.length} rooms:`);
        rooms.forEach((room, i) => {
            console.log(`  Room ${i}: (${room.x}, ${room.y}) ${room.w}x${room.h}`);
        });
        
        // Generate enemies and items
        this.generateEnemies();
        this.generateItems();
    }

    generateEnemies() {
        this.enemies = [];
        if (!this.rooms || this.rooms.length <= 1) {
            console.warn('No rooms available for enemy generation');
            return;
        }
        
        const CELL_SIZE = GAME_CONFIG.GRID.SIZE;
        const baseEnemyCount = 4 + Math.floor(Math.random() * 6); // 4-10 enemies
        const maxEnemiesPerRoom = 3;
        
        console.log(`Generating ${baseEnemyCount} enemies in ${this.rooms.length} rooms`);
        
        let enemiesGenerated = 0;
        const enemyTypes = ['zombie', 'demon', 'cacodemon', 'baron'];
        
        // Try to place enemies in each room (except first room which is player start)
        for (let roomIndex = 1; roomIndex < this.rooms.length && enemiesGenerated < baseEnemyCount; roomIndex++) {
            const room = this.rooms[roomIndex];
            const enemiesInThisRoom = 1 + Math.floor(Math.random() * maxEnemiesPerRoom);
            
            for (let e = 0; e < enemiesInThisRoom && enemiesGenerated < baseEnemyCount; e++) {
                let attempts = 0;
                let validPosition = false;
                
                while (!validPosition && attempts < 20) {
                    // Place enemy in room with some margin from walls
                    const margin = 1;
                    const x = (room.x + margin + Math.random() * (room.w - 2 * margin)) * CELL_SIZE + CELL_SIZE / 2;
                    const y = (room.y + margin + Math.random() * (room.h - 2 * margin)) * CELL_SIZE + CELL_SIZE / 2;
                    
                    // Check if position is valid (on floor)
                    const gridX = Math.floor(x / CELL_SIZE);
                    const gridY = Math.floor(y / CELL_SIZE);
                    
                    if (gridX >= 0 && gridX < this.levelData[0].length && 
                        gridY >= 0 && gridY < this.levelData.length &&
                        !this.isSolidWallType(this.levelData[gridY][gridX])) {
                        
                        // Check distance from player
                        const playerDist = Math.sqrt(
                            (x - this.player.x) * (x - this.player.x) + 
                            (y - this.player.y) * (y - this.player.y)
                        );
                        
                        if (playerDist > 100) { // Minimum distance from player
                            const type = enemyTypes[Math.floor(Math.random() * enemyTypes.length)];
                            const enemy = new Enemy(x, y, type);
                            
                            this.enemies.push(enemy);
                            enemiesGenerated++;
                            validPosition = true;
                            
                            console.log(`Enemy ${enemiesGenerated} (${type}) placed at (${Math.floor(x)}, ${Math.floor(y)}) in room ${roomIndex}`);
                        }
                    }
                    attempts++;
                }
            }
        }
        
        // If we didn't generate enough enemies, try placing some in hallways
        if (enemiesGenerated < baseEnemyCount / 2) {
            console.log('Adding enemies to hallways...');
            for (let i = 0; i < 20 && enemiesGenerated < baseEnemyCount; i++) {
                const x = (5 + Math.random() * 50) * CELL_SIZE + CELL_SIZE / 2;
                const y = (5 + Math.random() * 35) * CELL_SIZE + CELL_SIZE / 2;
                
                const gridX = Math.floor(x / CELL_SIZE);
                const gridY = Math.floor(y / CELL_SIZE);
                
                if (gridX >= 0 && gridX < this.levelData[0].length && 
                    gridY >= 0 && gridY < this.levelData.length &&
                    !this.isSolidWallType(this.levelData[gridY][gridX])) {
                    
                    const playerDist = Math.sqrt(
                        (x - this.player.x) * (x - this.player.x) + 
                        (y - this.player.y) * (y - this.player.y)
                    );
                    
                    if (playerDist > 100) {
                        const type = enemyTypes[Math.floor(Math.random() * enemyTypes.length)];
                        this.enemies.push(new Enemy(x, y, type));
                        enemiesGenerated++;
                    }
                }
            }
        }
        
        console.log(`Total enemies generated: ${this.enemies.length}`);
    }

    placeDoors(rooms) {
        // Place doors in room entrances (skip first room which is player start)
        for (let i = 1; i < rooms.length; i++) {
            const room = rooms[i];
            const doorPositions = [];
            
            // Find potential door positions on room perimeter
            // Top wall
            for (let x = room.x + 1; x < room.x + room.w - 1; x++) {
                if (room.y - 1 >= 0 && this.levelData[room.y - 1][x] === 0) { // hallway above
                    doorPositions.push({ x, y: room.y, dir: 'horizontal' });
                }
            }
            
            // Bottom wall  
            for (let x = room.x + 1; x < room.x + room.w - 1; x++) {
                if (room.y + room.h < this.levelData.length && 
                    this.levelData[room.y + room.h][x] === 0) { // hallway below
                    doorPositions.push({ x, y: room.y + room.h - 1, dir: 'horizontal' });
                }
            }
            
            // Left wall
            for (let y = room.y + 1; y < room.y + room.h - 1; y++) {
                if (room.x - 1 >= 0 && this.levelData[y][room.x - 1] === 0) { // hallway to left
                    doorPositions.push({ x: room.x, y, dir: 'vertical' });
                }
            }
            
            // Right wall
            for (let y = room.y + 1; y < room.y + room.h - 1; y++) {
                if (room.x + room.w < this.levelData[0].length && 
                    this.levelData[y][room.x + room.w] === 0) { // hallway to right
                    doorPositions.push({ x: room.x + room.w - 1, y, dir: 'vertical' });
                }
            }
            
            // Place 1-2 doors per room randomly
            const numDoors = Math.min(doorPositions.length, 1 + Math.floor(Math.random() * 2));
            for (let d = 0; d < numDoors && doorPositions.length > 0; d++) {
                const doorIndex = Math.floor(Math.random() * doorPositions.length);
                const door = doorPositions.splice(doorIndex, 1)[0];
                
                // Set door tile type (2 = door)
                this.levelData[door.y][door.x] = 2;
                
                // Set door texture to match room theme
                const roomTheme = room.theme || 'BROWN';
                this.textureMap[door.y][door.x] = roomTheme;
                
                // Store door info for interaction
                if (!this.doors) this.doors = [];
                this.doors.push({
                    x: door.x,
                    y: door.y,
                    direction: door.dir,
                    theme: roomTheme,
                    locked: false, // Start with unlocked doors for now
                    keyType: ['red', 'yellow', 'blue'][Math.floor(Math.random() * 3)],
                    opened: false
                });
            }
        }
        
        console.log(`Placed ${this.doors?.length || 0} doors`);
    }

    generateItems() {
        this.items = [];
        if (!this.rooms || this.rooms.length === 0) return;
        
        const CELL_SIZE = GAME_CONFIG.GRID.SIZE;
        
        // Place health packs
        for (let i = 0; i < 3; i++) {
            const room = this.rooms[Math.floor(Math.random() * this.rooms.length)];
            const x = (room.x + 1 + Math.random() * (room.w - 2)) * CELL_SIZE + CELL_SIZE / 2;
            const y = (room.y + 1 + Math.random() * (room.h - 2)) * CELL_SIZE + CELL_SIZE / 2;
            
            this.items.push({
                x, y, type: 'health', value: 25, collected: false
            });
        }
        
        // Place ammo
        for (let i = 0; i < 2; i++) {
            const room = this.rooms[Math.floor(Math.random() * this.rooms.length)];
            const x = (room.x + 1 + Math.random() * (room.w - 2)) * CELL_SIZE + CELL_SIZE / 2;
            const y = (room.y + 1 + Math.random() * (room.h - 2)) * CELL_SIZE + CELL_SIZE / 2;
            
            this.items.push({
                x, y, type: 'ammo', weapon: 'shotgun', value: 10, collected: false
            });
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
        const CELL_SIZE = GAME_CONFIG.GRID.SIZE;
        const collectionDistance = 20;
        
        for (let item of this.items) {
            if (item.collected) continue;
            
            const dx = this.player.x - item.x;
            const dy = this.player.y - item.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            if (distance < collectionDistance) {
                item.collected = true;
                
                if (item.type === 'health') {
                    this.player.heal(item.value);
                    this.showCheatMessage(`+${item.value} Health`);
                } else if (item.type === 'ammo') {
                    this.player.addAmmo(item.weapon, item.value);
                    this.showCheatMessage(`+${item.value} ${item.weapon.toUpperCase()} ammo`);
                }
                
                this.audioManager.playSound('PICKUP');
            }
        }
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
        
        // Update weapon grid
        this.updateWeaponGrid();
        
        // Update key indicators
        this.updateKeyIndicators();
        
        // Update level and score display
        document.querySelector('.level-info').textContent = `Level ${this.gameState.level}`;
        document.querySelector('.score-info').textContent = `Score: ${this.gameState.score}`;
        
        // Update HUD visibility
        this.updateHUDVisibility();
    }

    updateWeaponGrid() {
        const weaponSlots = document.querySelectorAll('.weapon-slot');
        
        weaponSlots.forEach((slot, index) => {
            const weaponName = this.player.weapons[index];
            const isOwned = weaponName !== undefined;
            const isActive = index === this.player.currentWeapon;
            const ammoElement = slot.querySelector('.weapon-ammo');
            
            // Update ownership status
            slot.classList.remove('owned', 'not-owned', 'active');
            if (isActive && isOwned) {
                slot.classList.add('active');
            } else if (isOwned) {
                slot.classList.add('owned');
            } else {
                slot.classList.add('not-owned');
            }
            
            // Update ammo display
            if (ammoElement && weaponName) {
                const currentAmmo = this.player.ammo[weaponName];
                const maxAmmo = this.getMaxAmmo(weaponName);
                
                if (currentAmmo === -1) {
                    ammoElement.textContent = '∞';
                } else {
                    ammoElement.textContent = `${currentAmmo}/${maxAmmo}`;
                }
            } else if (ammoElement) {
                ammoElement.textContent = '-';
            }
        });
    }

    updateKeyIndicators() {
        const redKey = document.getElementById('redKey');
        const yellowKey = document.getElementById('yellowKey');
        const blueKey = document.getElementById('blueKey');
        
        if (redKey) {
            redKey.style.opacity = this.player.keys.red > 0 ? '1' : '0.3';
        }
        if (yellowKey) {
            yellowKey.style.opacity = this.player.keys.yellow > 0 ? '1' : '0.3';
        }
        if (blueKey) {
            blueKey.style.opacity = this.player.keys.blue > 0 ? '1' : '0.3';
        }
    }

    getMaxAmmo(weaponType) {
        const maxAmmoMap = {
            'fist': -1,
            'pistol': -1,
            'shotgun': 50,
            'chaingun': 300,
            'rocket': 20,
            'plasma': 100
        };
        return maxAmmoMap[weaponType] || 0;
    }

    updateHUDVisibility() {
        const hud = document.querySelector('.doom-hud');
        const levelInfo = document.querySelector('.level-info');
        const scoreInfo = document.querySelector('.score-info');
        
        const shouldShowHUD = this.gameState.current === GAME_STATES.PLAYING || 
                             this.gameState.current === GAME_STATES.PAUSED;
        
        if (hud) hud.style.display = shouldShowHUD ? 'flex' : 'none';
        if (levelInfo) levelInfo.style.display = shouldShowHUD ? 'block' : 'none';
        if (scoreInfo) scoreInfo.style.display = shouldShowHUD ? 'block' : 'none';
    }

    setupCheats() {
        this.cheatEffects = {
            godMode: false,
            noClip: false,
            mapRevealed: false,
            invulnerable: false,
            invisible: false
        };

        this.inputManager.onCheatActivated((event) => {
            this.handleCheat(event.detail.type);
        });
    }

    handleCheat(cheatType) {
        switch (cheatType) {
            case 'all_keys':
                this.player.keys.red = 1;
                this.player.keys.yellow = 1;
                this.player.keys.blue = 1;
                this.showCheatMessage('All Keys Acquired');
                break;
                
            case 'invincibility':
                this.cheatEffects.invulnerable = !this.cheatEffects.invulnerable;
                this.player.invulnerable = this.cheatEffects.invulnerable;
                this.showCheatMessage(`Invincibility: ${this.cheatEffects.invulnerable ? 'ON' : 'OFF'}`);
                break;
                
            case 'all_guns':
                this.player.weapons = ['fist', 'pistol', 'shotgun', 'chaingun', 'rocket', 'plasma'];
                for (let weapon in this.player.ammo) {
                    if (weapon !== 'fist' && weapon !== 'pistol') {
                        this.player.ammo[weapon] = 999;
                    }
                }
                this.showCheatMessage('All Weapons & Ammo Acquired');
                break;
                
            case 'no_clip':
                this.cheatEffects.noClip = !this.cheatEffects.noClip;
                this.showCheatMessage(`No Clip: ${this.cheatEffects.noClip ? 'ON' : 'OFF'}`);
                break;
        }
    }

    showCheatMessage(message) {
        // Create temporary message display
        const messageDiv = document.createElement('div');
        messageDiv.textContent = message;
        messageDiv.style.cssText = `
            position: fixed;
            top: 50px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(255, 255, 0, 0.9);
            color: black;
            padding: 10px 20px;
            border-radius: 5px;
            font-family: 'Courier New', monospace;
            font-weight: bold;
            z-index: 2000;
            pointer-events: none;
        `;
        
        document.body.appendChild(messageDiv);
        
        // Remove after 3 seconds
        setTimeout(() => {
            if (messageDiv.parentNode) {
                messageDiv.parentNode.removeChild(messageDiv);
            }
        }, 3000);
    }

    resetGame() {
        // Reset player
        this.player.health = GAME_CONFIG.PLAYER.MAX_HEALTH;
        this.player.weapons = ['fist', 'pistol'];
        this.player.currentWeapon = 1;
        this.player.ammo = { 
            fist: -1, 
            pistol: -1, 
            shotgun: 0, 
            chaingun: 0, 
            rocket: 0, 
            plasma: 0 
        };
        this.player.keys = { red: 0, yellow: 0, blue: 0 };
        this.player.invulnerable = false;
        
        // Reset game state
        this.gameState.level = 1;
        this.gameState.score = 0;
        
        // Reset cheat effects
        if (this.cheatEffects) {
            this.cheatEffects.godMode = false;
            this.cheatEffects.noClip = false;
            this.cheatEffects.mapRevealed = false;
            this.cheatEffects.invulnerable = false;
            this.cheatEffects.invisible = false;
        }
        
        // Clear arrays
        this.bullets = [];
        this.enemies = [];
        this.items = [];
        this.explosions = [];
        
        // Generate new level
        this.generateLevel();
    }
}