export class ErrorHandler {
    constructor(gameEngine) {
        this.gameEngine = gameEngine;
        this.errorLog = [];
        this.maxErrors = 50;
        
        this.bindGlobalErrorHandlers();
    }

    bindGlobalErrorHandlers() {
        // Handle uncaught JavaScript errors
        window.addEventListener('error', (event) => {
            this.logError('JavaScript Error', event.error || event.message, {
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno
            });
        });

        // Handle unhandled promise rejections
        window.addEventListener('unhandledrejection', (event) => {
            this.logError('Promise Rejection', event.reason);
            event.preventDefault(); // Prevent console logging
        });

        // Handle canvas context lost
        this.gameEngine.canvas.addEventListener('webglcontextlost', (event) => {
            event.preventDefault();
            this.logError('WebGL Context Lost', 'Graphics context was lost');
            this.handleContextLoss();
        });

        this.gameEngine.canvas.addEventListener('webglcontextrestored', () => {
            this.logError('WebGL Context Restored', 'Graphics context was restored');
            this.handleContextRestore();
        });
    }

    logError(type, message, details = null) {
        const errorEntry = {
            timestamp: new Date().toISOString(),
            type: type,
            message: String(message),
            details: details,
            gameState: this.gameEngine?.gameState?.current,
            playerPosition: {
                x: this.gameEngine?.player?.x,
                y: this.gameEngine?.player?.y
            }
        };

        this.errorLog.push(errorEntry);

        // Keep only the most recent errors
        if (this.errorLog.length > this.maxErrors) {
            this.errorLog.shift();
        }

        // Log to console in development
        if (this.isDevelopment()) {
            console.error(`[${type}]`, message, details);
        }

        // Show user-friendly error message for critical errors
        if (this.isCriticalError(type)) {
            this.showErrorToUser(message);
        }
    }

    isDevelopment() {
        return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    }

    isCriticalError(type) {
        const criticalTypes = ['WebGL Context Lost', 'Audio Context Error', 'Canvas Error'];
        return criticalTypes.includes(type);
    }

    showErrorToUser(message) {
        // Create a user-friendly error display
        const errorDiv = document.createElement('div');
        errorDiv.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(255, 0, 0, 0.9);
            color: white;
            padding: 15px;
            border-radius: 5px;
            z-index: 9999;
            max-width: 300px;
            font-family: monospace;
            font-size: 12px;
        `;
        errorDiv.textContent = `Error: ${message}`;
        
        document.body.appendChild(errorDiv);
        
        // Auto-remove after 5 seconds
        setTimeout(() => {
            if (errorDiv.parentNode) {
                errorDiv.parentNode.removeChild(errorDiv);
            }
        }, 5000);
    }

    handleContextLoss() {
        // Pause the game when context is lost
        this.gameEngine.gameState.setState('paused');
        this.showErrorToUser('Graphics context lost. Game paused.');
    }

    handleContextRestore() {
        // Resume the game when context is restored
        this.gameEngine.gameState.setState('playing');
        this.showErrorToUser('Graphics context restored. Game resumed.');
    }

    // Safe wrapper for potentially dangerous operations
    safeExecute(operation, fallback = null, context = 'Unknown') {
        try {
            return operation();
        } catch (error) {
            this.logError('Safe Execute Error', error.message, { context });
            return fallback;
        }
    }

    // Validate game object bounds
    validateBounds(obj, maxX = 2000, maxY = 2000) {
        if (!obj || typeof obj.x !== 'number' || typeof obj.y !== 'number') {
            return false;
        }

        if (isNaN(obj.x) || isNaN(obj.y) || !isFinite(obj.x) || !isFinite(obj.y)) {
            this.logError('Invalid Position', 'Object has invalid coordinates', {
                x: obj.x,
                y: obj.y,
                type: obj.constructor.name
            });
            return false;
        }

        if (obj.x < -maxX || obj.x > maxX || obj.y < -maxY || obj.y > maxY) {
            this.logError('Out of Bounds', 'Object is out of game bounds', {
                x: obj.x,
                y: obj.y,
                maxX,
                maxY,
                type: obj.constructor.name
            });
            return false;
        }

        return true;
    }

    // Validate input parameters
    validateInput(value, type, range = null) {
        switch (type) {
            case 'number':
                if (typeof value !== 'number' || isNaN(value) || !isFinite(value)) {
                    return false;
                }
                if (range && (value < range.min || value > range.max)) {
                    return false;
                }
                break;
            
            case 'string':
                if (typeof value !== 'string') {
                    return false;
                }
                if (range && (value.length < range.min || value.length > range.max)) {
                    return false;
                }
                break;
            
            case 'array':
                if (!Array.isArray(value)) {
                    return false;
                }
                if (range && (value.length < range.min || value.length > range.max)) {
                    return false;
                }
                break;
            
            default:
                return value !== null && value !== undefined;
        }
        
        return true;
    }

    // Memory usage monitoring
    checkMemoryUsage() {
        if (performance.memory) {
            const memory = performance.memory;
            const usedPercent = (memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100;
            
            if (usedPercent > 80) {
                this.logError('High Memory Usage', `Memory usage at ${usedPercent.toFixed(1)}%`, {
                    used: memory.usedJSHeapSize,
                    total: memory.totalJSHeapSize,
                    limit: memory.jsHeapSizeLimit
                });
                
                // Suggest garbage collection
                this.gameEngine.cleanupObjects();
            }
        }
    }

    // Performance monitoring
    checkPerformance() {
        const fps = this.gameEngine.fps;
        
        if (fps < 30 && fps > 0) {
            this.logError('Low FPS', `FPS dropped to ${fps}`, {
                bulletCount: this.gameEngine.bullets.length,
                enemyCount: this.gameEngine.enemies.filter(e => e.active).length,
                explosionCount: this.gameEngine.explosions.length
            });
            
            // Auto-adjust graphics quality
            if (this.gameEngine.gameState.settings.graphics === 'high') {
                this.gameEngine.gameState.settings.graphics = 'medium';
                this.logError('Auto Adjustment', 'Graphics quality reduced due to low FPS');
            }
        }
    }

    // Get error report for debugging
    getErrorReport() {
        return {
            errors: this.errorLog.slice(-10), // Last 10 errors
            gameInfo: {
                state: this.gameEngine.gameState.current,
                level: this.gameEngine.gameState.level,
                score: this.gameEngine.gameState.score,
                fps: this.gameEngine.fps,
                playerHealth: this.gameEngine.player?.health,
                activeObjects: {
                    bullets: this.gameEngine.bullets.length,
                    enemies: this.gameEngine.enemies.filter(e => e.active).length,
                    explosions: this.gameEngine.explosions.length
                }
            },
            performance: performance.memory ? {
                used: performance.memory.usedJSHeapSize,
                total: performance.memory.totalJSHeapSize,
                limit: performance.memory.jsHeapSizeLimit
            } : null,
            userAgent: navigator.userAgent,
            timestamp: new Date().toISOString()
        };
    }

    // Clear error log
    clearErrors() {
        this.errorLog = [];
    }

    // Export error log for support
    exportErrorLog() {
        const report = this.getErrorReport();
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `doom-game-errors-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}