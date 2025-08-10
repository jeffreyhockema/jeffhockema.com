# Doom Game - Improved Version

A modern, performance-optimized top-down Doom-style game with comprehensive improvements over the original version.

## Features

### Performance Optimizations
- **requestAnimationFrame** game loop for smooth 60fps rendering
- **Object pooling** for bullets and effects to reduce garbage collection
- **Viewport culling** - only renders objects visible on screen
- **Memory management** with automatic cleanup of inactive objects
- **Performance monitoring** with automatic graphics quality adjustment

### Modern Architecture
- **Modular ES6 modules** with clean separation of concerns
- **Class-based object system** replacing object literals
- **Proper state management** with finite state machine
- **Error handling** with comprehensive logging and user feedback
- **Input validation** for all user inputs and game parameters

### Enhanced User Experience
- **Mobile/touch controls** with virtual D-pad and action buttons
- **Settings system** with volume, graphics, and difficulty options
- **Accessibility features** with ARIA labels and keyboard navigation
- **Responsive design** that adapts to different screen sizes
- **Offline support** with service worker caching

### Game Improvements
- **Advanced audio system** with Web Audio API and volume control
- **Fog of war** with explored area mapping
- **Improved collision detection** with proper bounds checking
- **Weapon system** with realistic ammunition management
- **Debug mode** for development with FPS counter and object counts

## File Structure

- `doom-game-improved.html` - Main game file with improved structure
- `styles.css` - All game styles including mobile controls
- `constants.js` - Game configuration and constants
- `classes.js` - Core game classes (Player, Enemy, Bullet, etc.)
- `game-engine.js` - Main game engine with rendering and game loop
- `mobile-controls.js` - Mobile touch controls and settings manager
- `error-handler.js` - Comprehensive error handling and logging
- `sw.js` - Service worker for offline support

## Controls

### Desktop
- **WASD** or **Arrow Keys** - Move
- **Mouse** - Aim
- **Left Click** or **Space** - Shoot
- **1-6** - Switch weapons
- **E** - Interact with doors
- **Escape** - Pause
- **M** or **F10** - Settings

### Mobile
- **Virtual D-pad** - Move
- **Touch screen** - Aim and shoot
- **Action buttons** - Interact and settings

### Debug (Development only)
- **F1** - Show error report in console
- **F2** - Export error log
- **F3** - Toggle debug mode

## Browser Requirements

- Modern browser with ES6 module support
- Canvas 2D context
- Web Audio API (optional, degrades gracefully)
- Local Storage for settings

## Performance Notes

The improved version includes several performance optimizations:

1. **Object Pooling**: Bullets are reused instead of created/destroyed
2. **Viewport Culling**: Only visible objects are rendered
3. **Memory Management**: Automatic cleanup prevents memory leaks
4. **Adaptive Quality**: Graphics quality adjusts based on performance
5. **Request Animation Frame**: Smooth 60fps rendering

## Error Handling

Comprehensive error handling includes:

- Global JavaScript error catching
- Promise rejection handling
- Canvas context loss recovery
- Memory usage monitoring
- Performance tracking
- User-friendly error messages

## Settings

Configurable options include:

- **Volume**: Audio volume control
- **Graphics**: Low/Medium/High/Debug quality levels
- **Difficulty**: Easy/Normal/Hard/Nightmare modes
- **Controls**: Customizable key bindings (future feature)

## Mobile Support

Full mobile support with:

- Touch controls with virtual buttons
- Responsive layout
- Touch event handling
- Mobile-specific optimizations
- Prevent scrolling and zooming

## Accessibility

Accessibility features include:

- ARIA labels for screen readers
- Keyboard navigation support
- High contrast support
- Semantic HTML structure
- Focus management

## Development

To modify or extend the game:

1. All constants are in `constants.js`
2. Core game logic is in `game-engine.js`
3. Object classes are in `classes.js`
4. Error handling can be monitored via console
5. Debug mode provides performance metrics

## Future Enhancements

Potential improvements:

- Level editor
- Multiplayer support
- Sound effects and music
- More weapon types
- Boss battles
- Save/load system
- Achievement system
- Particle effects

## License

Open source - feel free to modify and distribute.