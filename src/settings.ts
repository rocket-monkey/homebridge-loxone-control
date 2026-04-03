/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = "LoxoneControl";

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = "homebridge-loxone-control";

// Timing constants (milliseconds)
export const BLINDS_DEBOUNCE_DELAY = 500;
export const BLINDS_COMMAND_STAGGER_DELAY = 600;
export const BLINDS_TILT_RESET_BUFFER = 1000;
export const BLINDS_STOP_SETTLE_DELAY = 500;
export const BLINDS_FINAL_POSITION_SETTLE = 800;

export const LOGIN_JS_INIT_DELAY = 5000;
export const LOGIN_POST_SUBMIT_DELAY = 30000;
export const LOGIN_POST_LOAD_DELAY = 2000;
export const COLLECTION_POLL_INTERVAL = 5000;
export const COLLECTION_MAX_ATTEMPTS = 30;

export const NAVIGATION_TIMEOUT = 180000;
export const NAVIGATION_RETRY_TIMEOUT = 300000;
export const BROWSER_LAUNCH_TIMEOUT = 30000;
export const BROWSER_PROTOCOL_TIMEOUT = 300000;

export const STANDBY_PREVENT_INTERVAL = 30000;
export const AUTO_SUN_COOLDOWN = 1000;

export const BLINDS_POSITION_TOLERANCE = 3;
export const BLINDS_POSITION_TIMEOUT = 120_000;

// Tilt pulse: send command, wait pulse duration, send stop
export const BLINDS_TILT_PULSE_SHORT = 300;  // 1 tilt step (closed↔tilted or tilted↔open)
export const BLINDS_TILT_PULSE_LONG = 1000;  // 2 tilt steps (closed↔open)
export const BLINDS_TILT_SETTLE_DELAY = 1500; // wait for Loxone to report new tilt after pulse
export const BLINDS_TILT_MAX_RETRIES = 3;
