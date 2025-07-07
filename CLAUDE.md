# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a Homebridge plugin that controls Loxone smart home systems through the web interface using Puppeteer. It's designed for situations where direct Miniserver network access is unavailable, intercepting the Loxone web interface's WebSocket connection to control devices.

## Commands

### Build and Development
- **Build**: `npm run build` - Compiles TypeScript to JavaScript in the `dist` directory
- **Watch Mode**: `npm run watch` - Builds, links locally, and watches for changes with nodemon
- **Lint**: `npm run lint` - Runs ESLint on all TypeScript files with zero warnings allowed
- **Lint Fix**: `npm run lint:fix` - Auto-fixes linting issues

### Publishing
- **Prepare for publish**: `npm run prepublishOnly` - Runs linting and build before publishing

## Architecture

### Core Components

1. **Platform (`src/platform.ts`)**: Main platform class that manages device discovery and accessory registration
   - Handles WebSocket connection via Puppeteer
   - Manages accessory lifecycle and caching
   - Coordinates with the Loxone web interface

2. **Loxone WebInterface (`src/loxone/loxoneWebinterface.ts`)**: Controls the headless Chrome browser
   - Intercepts WebSocket communication
   - Manages authentication and connection state
   - Handles multiple Loxone web interface versions (v14.0.2, v15.0.1, v15.1.2, v15.3.2)

3. **Accessory Classes**: Each device type has its own accessory class
   - `PlatformWindowCoveringAccessory`: Blinds and awnings with position/tilt control
   - `PlatformLightAccessory`: Lights with dimming support
   - `PlatformOutletAccessory`: Switchable outlets
   - `PlatformFanAccessory`: Ventilation with multiple speed levels
   - `PlatformTemperatureAccessory`: Temperature sensors

4. **Blinds Controller (`src/blindsController.ts`)**: Manages blind position calculations
   - Handles different timing profiles (window, window-big, awning)
   - Manages position updates during movement

### Key Patterns

- **WebSocket Interception**: The plugin doesn't connect directly to Loxone but intercepts an existing web interface connection
- **Device Identification**: Uses Loxone's internal identifiers (e.g., `Wohnzimmer • Beschattung:type=Jalousie:1b2f65ea-0188-97df-ffff3270fa7dbe12`)
- **State Management**: Accessories track their state locally and sync with Loxone via WebSocket events
- **Timing-based Control**: Blinds use timing calculations since Loxone doesn't provide percentage feedback

## Code Style

- TypeScript with ES2022 target
- ESLint configured with strict rules
- 2-space indentation
- Double quotes for strings
- Always use semicolons
- Trailing commas in multiline structures
- Max line length: 160 characters

## Dependencies

- **homebridge**: Platform integration
- **puppeteer**: Headless browser control
- **homebridge-lib**: Eve HomeKit characteristics support
- **@homebridge/plugin-ui-utils**: Configuration UI support

## Notes

- No test framework is configured
- Uses ES modules (`"type": "module"` in package.json)
- Scripts are copied to dist after build via `scripts/copyScripts.mjs`
- Requires Node.js v18.20.4+, v20.12.2+, v20.18.0+, or v22.10.0+