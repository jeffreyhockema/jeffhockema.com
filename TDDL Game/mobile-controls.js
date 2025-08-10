export class MobileControls {
    constructor(gameEngine) {
        this.gameEngine = gameEngine;
        this.isTouch = 'ontouchstart' in window;
        this.virtualKeys = {};
        
        if (this.isTouch) {
            this.createMobileUI();
            this.bindMobileEvents();
        }
    }

    createMobileUI() {
        // Create mobile controls container
        const controlsDiv = document.createElement('div');
        controlsDiv.className = 'mobile-controls';
        controlsDiv.innerHTML = `
            <div class="mobile-dpad">
                <div class="mobile-btn" data-key="up" style="top: 0; left: 40px;">↑</div>
                <div class="mobile-btn" data-key="left" style="top: 40px; left: 0;">←</div>
                <div class="mobile-btn" data-key="right" style="top: 40px; left: 80px;">→</div>
                <div class="mobile-btn" data-key="down" style="top: 80px; left: 40px;">↓</div>
            </div>
            <div class="mobile-actions">
                <div class="mobile-btn" data-key="shoot" style="top: 20px; right: 60px;">🔥</div>
                <div class="mobile-btn" data-key="interact" style="top: 60px; right: 20px;">E</div>
            </div>
        `;
        
        document.body.appendChild(controlsDiv);
    }

    bindMobileEvents() {
        const buttons = document.querySelectorAll('.mobile-btn');
        
        buttons.forEach(button => {
            const key = button.dataset.key;
            
            button.addEventListener('touchstart', (e) => {
                e.preventDefault();
                this.virtualKeys[key] = true;
                button.style.background = 'rgba(255,255,255,0.6)';
                this.handleVirtualKey(key, true);
            });
            
            button.addEventListener('touchend', (e) => {
                e.preventDefault();
                this.virtualKeys[key] = false;
                button.style.background = 'rgba(255,255,255,0.3)';
                this.handleVirtualKey(key, false);
            });
        });
        
        // Add touch shooting
        this.gameEngine.canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            if (e.touches.length === 1) {
                this.virtualKeys.shoot = true;
            }
        });
        
        this.gameEngine.canvas.addEventListener('touchend', (e) => {
            e.preventDefault();
            this.virtualKeys.shoot = false;
        });
    }

    handleVirtualKey(key, pressed) {
        // Map virtual keys to game actions
        switch (key) {
            case 'up':
                this.gameEngine.inputManager.keys['KeyW'] = pressed;
                break;
            case 'down':
                this.gameEngine.inputManager.keys['KeyS'] = pressed;
                break;
            case 'left':
                this.gameEngine.inputManager.keys['KeyA'] = pressed;
                break;
            case 'right':
                this.gameEngine.inputManager.keys['KeyD'] = pressed;
                break;
            case 'shoot':
                this.gameEngine.inputManager.keys['Space'] = pressed;
                break;
            case 'interact':
                this.gameEngine.inputManager.keys['KeyE'] = pressed;
                break;
        }
    }

    isVirtualKeyPressed(key) {
        return this.virtualKeys[key] || false;
    }
}

export class SettingsManager {
    constructor(gameEngine) {
        this.gameEngine = gameEngine;
        this.settings = {
            volume: 0.5,
            graphics: 'high',
            difficulty: 'normal',
            controls: {
                moveUp: 'KeyW',
                moveDown: 'KeyS',
                moveLeft: 'KeyA',
                moveRight: 'KeyD',
                shoot: 'Space',
                interact: 'KeyE',
                pause: 'Escape'
            }
        };
        
        this.loadSettings();
        this.createSettingsUI();
    }

    createSettingsUI() {
        const overlay = document.createElement('div');
        overlay.className = 'settings-overlay';
        overlay.id = 'settingsOverlay';
        
        overlay.innerHTML = `
            <div class="settings-panel">
                <h2>Settings</h2>
                
                <div class="setting-item">
                    <label for="volumeSlider">Volume:</label>
                    <input type="range" id="volumeSlider" min="0" max="1" step="0.1" value="${this.settings.volume}">
                    <span id="volumeValue">${Math.round(this.settings.volume * 100)}%</span>
                </div>
                
                <div class="setting-item">
                    <label for="graphicsSelect">Graphics:</label>
                    <select id="graphicsSelect">
                        <option value="low" ${this.settings.graphics === 'low' ? 'selected' : ''}>Low</option>
                        <option value="medium" ${this.settings.graphics === 'medium' ? 'selected' : ''}>Medium</option>
                        <option value="high" ${this.settings.graphics === 'high' ? 'selected' : ''}>High</option>
                        <option value="debug" ${this.settings.graphics === 'debug' ? 'selected' : ''}>Debug</option>
                    </select>
                </div>
                
                <div class="setting-item">
                    <label for="difficultySelect">Difficulty:</label>
                    <select id="difficultySelect">
                        <option value="easy" ${this.settings.difficulty === 'easy' ? 'selected' : ''}>Easy</option>
                        <option value="normal" ${this.settings.difficulty === 'normal' ? 'selected' : ''}>Normal</option>
                        <option value="hard" ${this.settings.difficulty === 'hard' ? 'selected' : ''}>Hard</option>
                        <option value="nightmare" ${this.settings.difficulty === 'nightmare' ? 'selected' : ''}>Nightmare</option>
                    </select>
                </div>
                
                <div class="setting-item">
                    <button id="saveSettings">Save</button>
                    <button id="resetSettings">Reset to Defaults</button>
                    <button id="closeSettings">Close</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(overlay);
        this.bindSettingsEvents();
    }

    bindSettingsEvents() {
        const overlay = document.getElementById('settingsOverlay');
        const volumeSlider = document.getElementById('volumeSlider');
        const volumeValue = document.getElementById('volumeValue');
        const graphicsSelect = document.getElementById('graphicsSelect');
        const difficultySelect = document.getElementById('difficultySelect');
        const saveButton = document.getElementById('saveSettings');
        const resetButton = document.getElementById('resetSettings');
        const closeButton = document.getElementById('closeSettings');

        volumeSlider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            volumeValue.textContent = Math.round(value * 100) + '%';
            this.gameEngine.audioManager.setVolume(value);
        });

        saveButton.addEventListener('click', () => {
            this.settings.volume = parseFloat(volumeSlider.value);
            this.settings.graphics = graphicsSelect.value;
            this.settings.difficulty = difficultySelect.value;
            
            this.saveSettings();
            this.applySettings();
            this.closeSettings();
        });

        resetButton.addEventListener('click', () => {
            this.resetToDefaults();
            this.updateSettingsUI();
        });

        closeButton.addEventListener('click', () => {
            this.closeSettings();
        });

        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                this.closeSettings();
            }
        });

        // Close on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.style.display === 'flex') {
                this.closeSettings();
            }
        });
    }

    showSettings() {
        const overlay = document.getElementById('settingsOverlay');
        overlay.style.display = 'flex';
    }

    closeSettings() {
        const overlay = document.getElementById('settingsOverlay');
        overlay.style.display = 'none';
        this.gameEngine.gameState.setState(this.gameEngine.gameState.previous || 'playing');
    }

    loadSettings() {
        try {
            const saved = localStorage.getItem('doomGameSettings');
            if (saved) {
                this.settings = { ...this.settings, ...JSON.parse(saved) };
            }
        } catch (error) {
            console.warn('Could not load settings:', error);
        }
        
        this.applySettings();
    }

    saveSettings() {
        try {
            localStorage.setItem('doomGameSettings', JSON.stringify(this.settings));
        } catch (error) {
            console.warn('Could not save settings:', error);
        }
    }

    applySettings() {
        // Apply volume setting
        this.gameEngine.audioManager.setVolume(this.settings.volume);
        
        // Apply graphics setting
        this.gameEngine.gameState.settings.graphics = this.settings.graphics;
        
        // Apply difficulty setting
        this.applyDifficultySettings();
    }

    applyDifficultySettings() {
        import('./constants.js').then(({ GAME_CONFIG }) => {
            switch (this.settings.difficulty) {
                case 'easy':
                    this.gameEngine.player.speed = GAME_CONFIG.PLAYER.SPEED * 1.2;
                    break;
                case 'normal':
                    this.gameEngine.player.speed = GAME_CONFIG.PLAYER.SPEED;
                    break;
                case 'hard':
                    this.gameEngine.player.speed = GAME_CONFIG.PLAYER.SPEED * 0.8;
                    break;
                case 'nightmare':
                    this.gameEngine.player.speed = GAME_CONFIG.PLAYER.SPEED * 0.6;
                    break;
            }
        });
    }

    updateSettingsUI() {
        document.getElementById('volumeSlider').value = this.settings.volume;
        document.getElementById('volumeValue').textContent = Math.round(this.settings.volume * 100) + '%';
        document.getElementById('graphicsSelect').value = this.settings.graphics;
        document.getElementById('difficultySelect').value = this.settings.difficulty;
    }

    resetToDefaults() {
        this.settings = {
            volume: 0.5,
            graphics: 'high',
            difficulty: 'normal',
            controls: {
                moveUp: 'KeyW',
                moveDown: 'KeyS',
                moveLeft: 'KeyA',
                moveRight: 'KeyD',
                shoot: 'Space',
                interact: 'KeyE',
                pause: 'Escape'
            }
        };
        
        this.applySettings();
    }

    getSetting(key) {
        return this.settings[key];
    }

    setSetting(key, value) {
        this.settings[key] = value;
        this.saveSettings();
        this.applySettings();
    }
}