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
export const BLINDS_COMMAND_STAGGER_DELAY = 800;
export const BLINDS_TILT_RESET_BUFFER = 1000;
export const BLINDS_STOP_SETTLE_DELAY = 500;
export const BLINDS_FINAL_POSITION_SETTLE = 800;

export const LOGIN_JS_INIT_DELAY = 5000;
// Minimum wait after submit — before this, V8 is still blocked parsing comps.js.
// Previously 30s fixed; dropped because the collection poll carries the rest.
export const LOGIN_POST_SUBMIT_DELAY = 10000;
export const LOGIN_POST_LOAD_DELAY = 2000;
// Poll more aggressively so we pick up readiness as soon as V8 finishes.
export const COLLECTION_POLL_INTERVAL = 2000;
export const COLLECTION_MAX_ATTEMPTS = 60;
// How long to wait for the login form after goto() before assuming the restored
// session is valid and the page skipped straight to the app.
export const SESSION_RESTORE_PROBE_TIMEOUT = 3000;

export const NAVIGATION_TIMEOUT = 180000;
export const NAVIGATION_RETRY_TIMEOUT = 300000;
export const BROWSER_LAUNCH_TIMEOUT = 30000;
export const BROWSER_PROTOCOL_TIMEOUT = 300000;

// Any page.evaluate that doesn't return within this window is treated as a hang.
// The Loxone web interface normally answers in <100ms, so 5s is a generous ceiling.
export const EVALUATE_TIMEOUT = 5000;
// How often the background watchdog pings the page to detect hangs.
export const HEALTH_CHECK_INTERVAL = 30000;
// Max time to wait for a graceful page/browser close during recovery before force-killing.
export const RECOVERY_CLOSE_TIMEOUT = 3000;
// If no Loxone status push lands within this window, the WS data path is dead
// even if the page itself is responsive. The trivial `() => 1` health probe
// can't tell — Chrome's JS context is still alive, but the patched comps.js
// stopped delivering events. Triggers a full recovery the same way an
// evaluate-hang does. 2026-05-06: previously zero coverage here, observed
// 5h37m of complete log silence after the WS data path quietly died.
export const STATUS_STALE_THRESHOLD = 600000; // 10 minutes

// Grace period after the LAST Loxone WebSocket closes before we treat the data
// path as dead and recover. The Loxone web app reconnects on its own after a
// normal blip, so we must not fire on every close — but when the relay endpoint
// has MOVED (the Miniserver re-registered its cloud tunnel and got a new
// host:port) it can never reconnect, and waiting out STATUS_STALE_THRESHOLD
// costs 10 minutes of dead automation. Watching the socket directly turns that
// into ~20s, because a vanished socket is an event we can observe rather than
// an absence we have to time out. STATUS_STALE_THRESHOLD stays as the backstop
// for the other failure shape: socket still open, but no data flowing.
export const WS_RECONNECT_GRACE = 20000;

// The fastest and most decisive liveness signal we have: a command we just sent
// MUST come back as a status push. Loxone echoes state for anything we control,
// so if we drive a control and hear nothing within this window, the data path is
// dead — no inference, no waiting for silence to accumulate. This is the
// detector that matters during actual use, because it fires on the exact
// interaction the user is standing in front of.
export const COMMAND_ECHO_TIMEOUT = 3000;

// Loxone's cloud redirector (dns.loxonecloud.com) intermittently answers the
// navigation with an HTTP error instead of the usual 307 — observed 405 on
// 2026-07-31 and 408 on 2026-07-29. When that happens the document never
// loads, so the login form can NEVER appear, and blocking on waitForSelector
// just burns NAVIGATION_TIMEOUT + NAVIGATION_RETRY_TIMEOUT (8 minutes) before
// admitting defeat. We cannot stop the redirector doing it, but a failed
// navigation is visible within ~1s, so re-issue the goto instead of waiting
// out a timeout against a page that already errored. Retries are cheap: the
// same URL answered 307 on ten consecutive probes moments later.
export const NAV_MAX_ATTEMPTS = 3;
export const NAV_RETRY_DELAY = 3000;

export const STANDBY_PREVENT_INTERVAL = 30000;
export const AUTO_SUN_COOLDOWN = 1000;

export const BLINDS_POSITION_TOLERANCE = 3;
export const BLINDS_POSITION_TIMEOUT = 120_000;

