/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { resolve } from "path";
import puppeteer, { Browser, Page } from "puppeteer";
import { usernameSync } from "username";
import { LoxoneControlPlatform } from "../platform.js";
import { sleep } from "./utils/sleep.js";
import {
  NAVIGATION_TIMEOUT,
  NAVIGATION_RETRY_TIMEOUT,
  BROWSER_LAUNCH_TIMEOUT,
  BROWSER_PROTOCOL_TIMEOUT,
  LOGIN_JS_INIT_DELAY,
  LOGIN_POST_SUBMIT_DELAY,
  LOGIN_POST_LOAD_DELAY,
  COLLECTION_POLL_INTERVAL,
  COLLECTION_MAX_ATTEMPTS,
  STANDBY_PREVENT_INTERVAL,
  EVALUATE_TIMEOUT,
  HEALTH_CHECK_INTERVAL,
  RECOVERY_CLOSE_TIMEOUT,
  SESSION_RESTORE_PROBE_TIMEOUT,
  STATUS_STALE_THRESHOLD,
  COMMAND_ECHO_TIMEOUT,
  WS_RECONNECT_GRACE,
} from "../settings.js";

// In-memory snapshot of a successful Loxone session. Used to skip the full
// form-based login on re-init (e.g. after a Puppeteer-hang recovery) — saves
// ~7s of form wait + credential typing + JS-init sleep.
interface SavedSession {
  cookies: Parameters<Page["setCookie"]>[0][];
  localStorage: Record<string, string>;
}

const __dirname = import.meta.dirname;
const BROWSER_LOG = false; // set to true to log browser console messages
const DEBUG_MODE = false; // set to true for verbose debugging

export type LoxoneComponent = {
  identifier: string;
  uuidAction: string;
  name: string;
  searchDescription: string;
  type: string;
  defaultIcon: string;
  controlType: string;
  groupDetail: string;
  room: string;
  isSecured: boolean;
  states: {
    [key: string]: string;
  };
};

export class LoxoneWebinterface {
  private browser: Browser | undefined;
  public page: Page | undefined;
  public collectedComponents: LoxoneComponent[] = [];
  // uuidAction → state-name → UUID. Read once from window.collection after
  // login. The `control.states` map isn't carried in the per-update dispatch
  // (Puppeteer serialization strips it), so this snapshot is the canonical
  // way to know which UUID in newVals corresponds to e.g. "autoActive".
  public controlStateMaps: { [uuidAction: string]: { [stateName: string]: string } } = {};

  private preventStandbyInterval: ReturnType<typeof setInterval> | undefined;
  private healthCheckInterval: ReturnType<typeof setInterval> | undefined;
  private isRecovering = false;
  private savedSession: SavedSession | null = null;
  public recoveryCount = 0;
  // Wall-clock of the most recent Loxone status push delivered through the
  // patched comps.js (onStatusUpdate / onStatusUpdateBefore). The page can
  // be JS-responsive while the WS data path silently dies — `() => 1` would
  // still return 1. Tracking actual data flow is the only reliable signal.
  private lastStatusPushAt = 0;
  // Armed when the last WebSocket closes, cancelled if one reconnects.
  private wsRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  // Armed when a command goes out, cancelled by the status push it must produce.
  private commandEchoTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(public readonly platform: LoxoneControlPlatform) {
    this.platform.logger.debug("LoxoneWebinterface constructor");
    this.init = this.init.bind(this);
    this.getLoxoneCredentials = this.getLoxoneCredentials.bind(this);
  }

  /**
   * Returns true only when the interface came up far enough to serve HomeKit
   * (collection captured, onReady fired, health check armed). Callers — notably
   * triggerRecovery — need to distinguish that from the failure paths below,
   * which are all logged but deliberately not thrown.
   */
  async init(): Promise<boolean> {
    const { serverUrl, user, password } = this.getLoxoneCredentials();
    if (!serverUrl || !user || !password) {
      this.platform.logger.error("❌ Missing credentials - serverUrl, user or password not configured");
      return false;
    }
    // Clear stale intervals from a previous init (e.g. after recovery), otherwise
    // preventStandby would run against both the old and new pages.
    if (this.preventStandbyInterval) {
      clearInterval(this.preventStandbyInterval);
      this.preventStandbyInterval = undefined;
    }
    this.platform.logger.info("🚀 Initializing loxone web interface..");
    if (DEBUG_MODE) {
      this.platform.logger.info(`🔗 Open URL "${serverUrl}" and login...`);
      this.platform.logger.debug(`🔍 Debug mode enabled, navigation timeout: ${NAVIGATION_TIMEOUT}ms`);
    }

    if (!this.browser) {
      try {
        const isRoot = usernameSync() === "root";
        if (DEBUG_MODE) {
          this.platform.logger.info(`🔍 Starting browser as user: ${usernameSync()}, isRoot: ${isRoot}`);
        }
        
        if (this.platform.config.chromiumPath) {
          // check if chromium path exists
          if (!existsSync(this.platform.config.chromiumPath)) {
            this.platform.logger.error(
              `❌ Chromium path does not exist: ${this.platform.config.chromiumPath}`,
            );
            return false;
          }

          if (DEBUG_MODE) {
            this.platform.logger.info(
              `🔍 Starting new instance of Chromium: ${this.platform.config.chromiumPath}`,
            );
          }
          const launchArgs = isRoot
            ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
            : ["--disable-dev-shm-usage"];
          if (DEBUG_MODE) {
            this.platform.logger.debug(`🔍 Browser launch args: ${JSON.stringify(launchArgs)}`);
          }

          this.browser = await puppeteer.launch({
            executablePath: this.platform.config.chromiumPath,
            acceptInsecureCerts: true,
            args: launchArgs,
            timeout: BROWSER_LAUNCH_TIMEOUT,
            protocolTimeout: BROWSER_PROTOCOL_TIMEOUT,
          });
          if (DEBUG_MODE) {
            this.platform.logger.info("✅ Chromium started successfully");
          }
        } else {
          if (DEBUG_MODE) {
            this.platform.logger.info("🔍 Starting Chrome from local package installation");
          }
          const launchArgs = isRoot
            ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
            : ["--disable-dev-shm-usage"];
          if (DEBUG_MODE) {
            this.platform.logger.debug(`🔍 Browser launch args: ${JSON.stringify(launchArgs)}`);
          }

          this.browser = await puppeteer.launch({
            acceptInsecureCerts: true,
            args: launchArgs,
            timeout: BROWSER_LAUNCH_TIMEOUT,
            protocolTimeout: BROWSER_PROTOCOL_TIMEOUT,
          });
          if (DEBUG_MODE) {
            this.platform.logger.info("✅ Chrome started successfully");
          }
        }
      } catch (e: any) {
        this.platform.logger.error(
          `❌ Could not start headless browser! Error: ${e.message}`,
        );
        this.platform.logger.error("See https://github.com/rocket-monkey/homebridge-loxone-control?tab=readme-ov-file#setup");
        return false;
      }
    }
    if (DEBUG_MODE) {
      this.platform.logger.info("🔍 Creating new page...");
    }
    this.page = await this.browser?.newPage();
    if (DEBUG_MODE) {
      this.platform.logger.info("✅ New page created");
    }

    await this.watchWebSocket();

    // mobile viewport for easy navigation
    if (DEBUG_MODE) {
      this.platform.logger.debug("🔍 Setting viewport to 500x800");
    }
    await this.page?.setViewport({ width: 500, height: 800 });
    if (DEBUG_MODE) {
      this.platform.logger.debug("✅ Viewport set");
    }

    // Listen to browser console messages
    if (DEBUG_MODE) {
      this.platform.logger.debug("🔍 Setting up browser console and error listeners");
    }
    this.page?.on("console", (msg) => {
      if (!BROWSER_LOG) {
        return;
      }
      const msgType = msg.type();
      const msgText = msg.text();
      if (msgType === "error") {
        this.platform.logger.error(`🔍 Browser Console Error: ${msgText}`);
      } else if (msgType === "warn") {
        this.platform.logger.error(`🔍 Browser Console Warning: ${msgText}`);
      } else {
        this.platform.logger.debug(`🔍 Browser Console ${msgType}: ${msgText}`);
      }
    });

    // Listen to page errors
    this.page?.on("pageerror", (error: unknown) => {
      if (!BROWSER_LOG) {
        return;
      }
      const err = error as Error;
      this.platform.logger.error(`🔍 Browser Page Error: ${err.message}`);
      this.platform.logger.error(`🔍 Error stack: ${err.stack}`);
    });

    // Listen to request failures — filter out ERR_ABORTED which is the Loxone SPA
    // cancelling its own in-flight polls (normal behavior, not a real failure).
    // Remaining failures are logged at debug level since they rarely need action.
    this.page?.on("requestfailed", (request) => {
      const errorText = request.failure()?.errorText ?? "";
      if (errorText.includes("ERR_ABORTED")) {
        return;
      }
      this.platform.logger.debug(`🔍 Request failed: ${request.url()} - ${errorText}`);
    });

    // Listen to all responses for debugging
    // Listen to response errors
    this.page?.on("response", (response) => {
      if (response.status() >= 400 && !response.url().includes("statistic.js")) {
        this.platform.logger.error(`🔍 HTTP Error ${response.status()}: ${response.url()}`);
      }
    });

    if (DEBUG_MODE) {
      this.platform.logger.debug("🔍 Exposing platform functions to browser context");
    }
    await this.page?.exposeFunction(
      "LoxoneControlPlatformStatus",
      (stateContainer: any) => {
        this.platform.onStatusUpdate(stateContainer);
      },
    );
    await this.page?.exposeFunction(
      "LoxoneControlPlatformStatusBefore",
      (newValues: any) => {
        this.platform.onStatusUpdateBefore(newValues);
      },
    );
    if (DEBUG_MODE) {
      this.platform.logger.debug("✅ Platform functions exposed");
    }

    // store in localstorage the loxone config with "ambientOnboardingShown":true
    if (DEBUG_MODE) {
      this.platform.logger.debug("🔍 Setting up localStorage configuration");
    }
    await this.page?.evaluateOnNewDocument((settingStr) => {
      localStorage.setItem("LoxSettings.json", settingStr);
      // eslint-disable-next-line max-len
    }, `{"animations":true,"darkMode":true,"tileRepresentation":true,"simpleDesign":false,"miniservers":{"${this.platform.config.loxoneMiniServerId}":{"homeScreen":{"activated":true,"widget":{"building":0,"skyline":0}},"manualFavorites":{"activated":false},"deviceFavorites":{"activated":false},"entryPointLocation":"favorites","presenceRoom":"","instructionFlags":{},"userManagement":{},"sortingDeviceFavorites":{"Mieter":{"activated":false}},"kvStore":{},"ambientOnboardingShown":true}},"instructionFlags":{},"LOCAL_STORAGE":{},"entryPoint":{"activated":true,"entryPointLocation":"favorites"},"SYNC":{"ENABLED":false},"screenSaver":{"activationTime":300,"brightness":10}}`);
    if (DEBUG_MODE) {
      this.platform.logger.debug("✅ localStorage configuration set");
    }

    // Listen for each network request
    if (DEBUG_MODE) {
      this.platform.logger.debug("🔍 Setting up request interception");
    }
    await this.page?.setRequestInterception(true);
    this.page?.on("request", async (request) => {
      const url = request.url();
      if (url.includes("comps.js")) {
        if (DEBUG_MODE) {
          this.platform.logger.info(`🔍 Intercepting comps.js request: ${request.url()}`);
        }

        // search for "this._initStatesSrc()," and change to
        // "this._initStatesSrc(),window.collection=window.collection?window.collection:[],window.collection.push(this),"
        // then, search for "newStatesReceived" and add at the beginning of the function 
        // "window.LoxoneControlPlatformStatusBefore(v);" and just before the "}else", "window.LoxoneControlPlatformStatus(this);"
        
        let patched = "";
        let version = "unknown";
        
        if (request.url().includes("comps.js?v=15.3")) {
          version = "15.3.2";
          patched = await readFile(
            resolve(__dirname, "scripts/comps.js-v15.3.2.js"),
            "utf-8",
          );
        } else if (request.url().includes("comps.js?v=15.1")) {
          version = "15.1.2";
          patched = await readFile(
            resolve(__dirname, "scripts/comps.js-v15.1.2.js"),
            "utf-8",
          );
        } else if (request.url().includes("comps.js?v=15.0")) {
          version = "15.0.1";
          patched = await readFile(
            resolve(__dirname, "scripts/comps.js-v15.0.1.js"),
            "utf-8",
          );
        } else if (request.url().includes("comps.js?v=14.0")) {
          version = "14.0.2";
          patched = await readFile(
            resolve(__dirname, "scripts/comps.js-v14.0.2.js"),
            "utf-8",
          );
        } else if (request.url().includes("comps.js?v=16.0")) {
          version = "16.0.0";
          patched = await readFile(
            resolve(__dirname, "scripts/comps.js-v16.0.0.js"),
            "utf-8",
          );
        } else if (request.url().includes("comps.js?v=17.1")) {
          // v17 rewrote newStatesReceived (dedup via _shallowEqual, Promise
          // instead of Q) — the patch is PORTED, not copied: the after-callback
          // now sits inside the dedup branch, so it only fires on real state
          // changes; the before-callback still receives the RAW arg because
          // v17's own merge (`{...o}`) would flatten CentralJalousie's Array
          // broadcast into an index-keyed object.
          version = "17.1.4";
          patched = await readFile(
            resolve(__dirname, "scripts/comps.js-v17.1.4.js"),
            "utf-8",
          );
        } else {
          this.platform.logger.error(`❌ Unsupported Loxone version in URL: ${request.url()}`);
          // Let the original request continue
          request.continue();
          return;
        }

        if (DEBUG_MODE) {
          this.platform.logger.info(`✅ Using patched comps.js for Loxone v${version} (${patched.length} bytes)`);
        }
        
        // Respond with the modified script
        try {
          await request.respond({
            status: 200,
            contentType: "text/javascript",
            body: patched,
          });
          if (DEBUG_MODE) {
            this.platform.logger.info(`✅ Patched comps.js served to browser`);
          }
        } catch (error: any) {
          this.platform.logger.error(`❌ Error responding with patched script: ${error.message}`);
          request.continue();
        }
      } else {
        request.continue();
      }
    });

    try {
      if (!this.page) {
        this.platform.logger.error("❌ Page not available for login");
        return false;
      }

      const startTime = Date.now();
      if (DEBUG_MODE) {
        this.platform.logger.info(`🔍 Navigating to: ${serverUrl}`);
      }

      // Try session restore first — if we have a previous saved session, inject
      // cookies + localStorage before navigating. If the session is still valid,
      // Loxone skips the login form and goes straight to the app.
      let sessionRestored = false;
      if (this.savedSession && this.savedSession.cookies.length > 0) {
        this.platform.logger.info("♻️  Attempting session restore from saved cookies...");
        try {
          if (this.savedSession.cookies.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await this.page.setCookie(...(this.savedSession.cookies as any));
          }
          const lsSnapshot = this.savedSession.localStorage;
          await this.page.evaluateOnNewDocument((entries: Record<string, string>) => {
            for (const [key, val] of Object.entries(entries)) {
              localStorage.setItem(key, val);
            }
          }, lsSnapshot);

          this.page.goto(serverUrl).catch((e: any) => {
            this.platform.logger.info(`🔍 goto catch: ${e.message}`);
          });

          // Race the login form against a short probe timeout.
          // Form visible → session expired, fall through to full login.
          // No form within the probe window → assume session is valid.
          try {
            await this.page.waitForSelector("input[type=text]", { timeout: SESSION_RESTORE_PROBE_TIMEOUT });
            this.platform.logger.info("♻️  Saved session expired — login form reappeared, falling back to full login");
            this.savedSession = null;
          } catch {
            sessionRestored = true;
            this.platform.logger.info(`♻️  Session restored in ${Date.now() - startTime}ms — skipping form login`);
          }
        } catch (e: any) {
          this.platform.logger.warn(`♻️  Session restore failed: ${e.message} — falling back to full login`);
          this.savedSession = null;
        }
      }

      const navigationStart = Date.now();
      if (!sessionRestored) {
        // login to loxone miniserver
        this.platform.logger.info("🔍 Navigating to Loxone web interface...");
        // Don't await goto — just fire and wait for the login form
        this.page.goto(serverUrl).catch((e: any) => {
          this.platform.logger.info(`🔍 goto catch: ${e.message}`);
        });

        // Wait for the login form — use waitForSelector which listens via CDP
        // without needing JS execution on the main thread
        this.platform.logger.info("🔍 Waiting for login form...");
        try {
          await this.page.waitForSelector("input[type=text]", { timeout: NAVIGATION_TIMEOUT });
        } catch {
          this.platform.logger.error("❌ Login form never appeared - retrying with extended timeout...");
          // Try once more with a longer timeout — the huge comps.js can take very long
          await this.page.waitForSelector("input[type=text]", { timeout: NAVIGATION_RETRY_TIMEOUT });
        }
        this.platform.logger.info(`✅ Login form appeared in ${Date.now() - startTime}ms`);

        // Wait for JS framework to fully initialize event handlers
        this.platform.logger.info("🔍 Waiting for page JS to initialize...");
        await sleep(LOGIN_JS_INIT_DELAY);

        // Use the same approach as v1.5.5: page.type + page.click
        this.platform.logger.info("🔍 Typing credentials...");
        await this.page.type("input[type=text]", user);
        await this.page.type("input[type=password]", password);

        const usernameVal = await this.page.$eval("input[type=text]", (el: any) => el.value);
        const passwordVal = await this.page.$eval("input[type=password]", (el: any) => el.value);
        this.platform.logger.info(`🔍 Field values - username: "${usernameVal}" (${usernameVal.length}), password: ${passwordVal.length} chars`);

        this.platform.logger.info("🔍 Submitting login...");
        await this.page.click("button[type=submit]");

        // After login, the Loxone web app loads the massive comps.js (14-16MB)
        // which blocks Chrome's main thread. We can't use waitForFunction/evaluate
        // during this time. Instead, wait for the intercepted comps.js to be served
        // and give Chrome time to parse it.
        // Wait for the post-login page to load (comps.js parsing takes time)
        this.platform.logger.info("🔍 Waiting for Loxone web interface to load...");
        await sleep(LOGIN_POST_SUBMIT_DELAY);
      } else {
        // Session restored: comps.js still needs to parse but we skipped form/typing/js-init.
        // Wait the post-submit delay anyway since comps.js parsing is unavoidable on a fresh page.
        // (V8's code cache inside a still-alive browser process makes this much faster.)
        await sleep(LOGIN_POST_SUBMIT_DELAY);
      }
      this.platform.logger.info(`✅ Login flow completed in ${Date.now() - navigationStart}ms${sessionRestored ? " (session restore)" : ""}`);
      await sleep(LOGIN_POST_LOAD_DELAY);

      // NO proactive daily re-login here. There used to be a 24h setInterval
      // calling refreshLogin(), and it was the single biggest source of
      // instability: refreshLogin() ran `page.goto(serverUrl)` on THIS page —
      // the one carrying the live Loxone WebSocket — so it destroyed a working
      // data path before it had a replacement, then re-did a full form login
      // on top of the wreckage with ONE waitForSelector attempt and no
      // rollback. Succeed and you never notice; fail and the WS is already
      // gone with nothing to fall back to.
      //
      // Traced to the second on 2026-07-31: refresh fired at 19:53:19, status
      // pushes stopped at that exact moment, the re-login timed out at
      // 19:56:21, and the watchdog reported "no status push for 614s" at
      // 20:03:33. A guaranteed daily coin-flip against whatever Loxone's cloud
      // relay was doing in those few seconds.
      //
      // Session expiry is now handled REACTIVELY instead: an expired session
      // stops the status pushes, the watchdog notices within
      // STATUS_STALE_THRESHOLD and runs triggerRecovery() -> init(), which is
      // strictly more robust than refreshLogin ever was (retries with an
      // extended timeout, restores the saved session, re-applies the comps.js
      // patches, and re-arms the watchdog on failure so it keeps retrying).
      // Worst case is a few minutes of stale state on the rare occasion the
      // session actually expires — instead of a daily chance of hours of
      // downtime.
      this.preventStandbyInterval = setInterval(async () => {
        if (this.page) {
          await this.page.mouse.move(0, 0);
        }
      }, STANDBY_PREVENT_INTERVAL);

      this.platform.logger.info(
        "✅ Login successful, loxone web interface ready!",
      );

      // Wait for the patched comps.js to initialize window.collection
      this.platform.logger.info("🔍 Waiting for device collection to be available...");
      let allCollectedComponents: any;
      const pollStart = Date.now();
      for (let i = 0; i < COLLECTION_MAX_ATTEMPTS; i++) {
        await sleep(COLLECTION_POLL_INTERVAL);
        try {
          allCollectedComponents = await this.page?.evaluate(() => {
            // @ts-expect-error patched
            return window.collection;
          });
          if (allCollectedComponents && allCollectedComponents.length > 0) {
            this.platform.logger.info(`✅ Collection ready with ${allCollectedComponents.length} components after ${Math.round((Date.now() - pollStart) / 1000)}s`);
            break;
          }
        } catch {
          // JS context may still be busy — keep trying
        }
      }
      if (!allCollectedComponents || allCollectedComponents.length === 0) {
        this.platform.logger.error(`❌ No components collected after ${(COLLECTION_MAX_ATTEMPTS * COLLECTION_POLL_INTERVAL) / 1000}s`);
        return false;
      }
      this.collectedComponents = allCollectedComponents.map((c: any) => ({
        ...c,
        identifier: `${c.searchDescription || "unknown • unknown"}:type=${
          c.type
        }:${c.uuidAction}`,
      })) as LoxoneComponent[];

      // Snapshot each control's state-name → UUID map directly off the live
      // controls in the page. Each entry in window.collection IS the control
      // (per the comps.js patch), and `control.states` is the Loxone-native
      // name map (string UUID, array of UUIDs, or object of UUIDs). We
      // flatten it so platform.ts can resolve any named state from newVals.
      try {
        this.controlStateMaps = await this.page!.evaluate(() => {
          const collection = (window as unknown as { collection: any[] }).collection || [];
          const out: Record<string, Record<string, string>> = {};
          for (const ctrl of collection) {
            if (!ctrl) continue;
            // Collection entries are CommandSrc objects with a `.control`
            // referencing the actual Control. The Loxone-native state-name
            // → UUID map lives on `.control.states`.
            const uuidAction = ctrl.uuidAction || ctrl.control?.uuidAction;
            const stateMap = ctrl.control?.states || ctrl.states;
            if (!uuidAction || !stateMap) continue;
            const flat: Record<string, string> = {};
            for (const name of Object.keys(stateMap)) {
              const v = stateMap[name];
              if (typeof v === "string") {
                flat[name] = v;
              } else if (Array.isArray(v)) {
                if (typeof v[0] === "string") flat[name] = v[0];
              } else if (v && typeof v === "object") {
                const first = Object.values(v).find((x: unknown) => typeof x === "string");
                if (typeof first === "string") flat[name] = first;
              }
            }
            out[uuidAction] = flat;
          }
          return out;
        });
      } catch (e) {
        this.platform.logger.error(`Failed to capture control state maps: ${e}`);
      }
      this.platform.logger.info(
        "🔌 All collected components: ",
        this.collectedComponents.map((c) => c.identifier),
      );
      this.platform.onReady();
      this.startHealthCheck();
      // Snapshot cookies + localStorage so the next init() (e.g. after a recovery)
      // can skip the form-based login entirely. In-memory only — not persisted to disk.
      await this.captureSession();
      return true;
    } catch (e: any) {
      this.platform.logger.error("❌ Error during login!");
      this.platform.logger.error(`🔍 Error type: ${e.constructor.name}`);
      this.platform.logger.error(`🔍 Error message: ${e.message}`);
      
      if (e.message?.includes("Navigation timeout")) {
        this.platform.logger.error("🔍 Navigation timeout detected - this usually indicates:");
        this.platform.logger.error("  • Network connectivity issues");
        this.platform.logger.error("  • Slow server response");
        this.platform.logger.error("  • Incorrect server URL");
        this.platform.logger.error("  • Firewall/proxy blocking the connection");
      }
      
      if (e.message?.includes("net::ERR_")) {
        this.platform.logger.error("🔍 Network error detected - check connectivity to Loxone server");
      }
      
      if (e.stack) {
        this.platform.logger.error(`🔍 Error stack: ${e.stack}`);
      }
      
      // Try to get page information if available
      if (this.page) {
        try {
          const currentUrl = this.page.url();
          const pageTitle = await this.page.title();
          this.platform.logger.error(`🔍 Current page URL: ${currentUrl}`);
          this.platform.logger.error(`🔍 Current page title: ${pageTitle}`);
        } catch (pageError) {
          this.platform.logger.error(`🔍 Could not get page info: ${pageError}`);
        }
      }
      return false;
    }
  }

  /**
   * Run a page.evaluate with a hard timeout. If the underlying Chrome CDP call hangs
   * (the classic "Runtime.callFunctionOn timed out" symptom), kick off a recovery and
   * return null to the caller so it can fail fast instead of blocking on the 5-minute
   * protocol timeout. Returns null during recovery and if the page is not yet ready.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async safeEvaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T | null> {
    if (this.isRecovering || !this.page) {
      return null;
    }
    const page = this.page;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        page.evaluate(fn as any, ...args),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`evaluate exceeded ${EVALUATE_TIMEOUT}ms`)),
            EVALUATE_TIMEOUT,
          );
        }),
      ]);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      return result as T;
    } catch (e: unknown) {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      const msg = (e as Error)?.message ?? String(e);
      const isHang =
        msg.includes("exceeded") ||
        msg.includes("Runtime.callFunctionOn") ||
        msg.includes("Target closed") ||
        msg.includes("Protocol error") ||
        msg.includes("Session closed");
      if (isHang) {
        this.platform.logger.error(`🚨 Puppeteer hang detected: ${msg}`);
        // Fire-and-forget — don't block the caller on recovery
        this.triggerRecovery().catch(() => { /* already logged */ });
      } else {
        this.platform.logger.error(`❌ safeEvaluate error (non-hang): ${msg}`);
      }
      return null;
    }
  }

  /**
   * Snapshot cookies + localStorage from the live page into memory so a subsequent
   * init() (e.g. recovery) can skip the form-based login.
   */
  private async captureSession() {
    if (!this.page) {
      return;
    }
    try {
      const cookies = await this.page.cookies();
      const localStorage = await this.page.evaluate(() => {
        const out: Record<string, string> = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          if (key !== null) {
            out[key] = window.localStorage.getItem(key) ?? "";
          }
        }
        return out;
      });
      this.savedSession = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cookies: cookies as any,
        localStorage,
      };
      this.platform.logger.info(`♻️  Captured session: ${cookies.length} cookies, ${Object.keys(localStorage).length} localStorage entries`);
    } catch (e: unknown) {
      this.platform.logger.warn(`♻️  Failed to capture session: ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * Public entry point for external recovery triggers (e.g. debug endpoint).
   */
  async getHealthStatus() {
    const browserConnected = !!this.browser?.connected;
    const pageReady = !!this.page;
    let pageResponsive = false;
    if (pageReady && !this.isRecovering) {
      const probe = await this.safeEvaluate(() => true);
      pageResponsive = probe === true;
    }
    return {
      status: pageResponsive ? "healthy" : this.isRecovering ? "recovering" : "unhealthy",
      browser: browserConnected ? "connected" : "disconnected",
      page: pageReady ? (pageResponsive ? "responsive" : "unresponsive") : "none",
      recovering: this.isRecovering,
      recoveryCount: this.recoveryCount,
      uptime: Math.round(process.uptime()),
    };
  }

  async forceRecovery() {
    await this.triggerRecovery();
  }

  /**
   * Tear down the current page (and optionally the browser) and re-run init().
   * Tries a page-only recovery first — keeping the browser alive preserves V8's
   * compiled code cache for comps.js, making re-init dramatically faster. Only
   * kills the whole browser if page-only recovery fails.
   * Idempotent — concurrent callers see isRecovering=true and exit.
   */
  private async triggerRecovery() {
    if (this.isRecovering) {
      return;
    }
    this.isRecovering = true;
    this.platform.logger.warn("🚑 Recovering from Puppeteer hang...");

    // Closing the page below fires webSocketClosed; without this the old page's
    // watcher would arm a timer and schedule a second, redundant recovery.
    if (this.wsRecoveryTimer) {
      clearTimeout(this.wsRecoveryTimer);
      this.wsRecoveryTimer = undefined;
    }
    if (this.commandEchoTimer) {
      clearTimeout(this.commandEchoTimer);
      this.commandEchoTimer = undefined;
    }

    // Stop the health check while we're recovering so it doesn't fire again mid-flight
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }

    // Mark the platform as not ready so commands short-circuit until we're back
    this.platform.markWebinterfaceNotReady();

    // Phase 1: close the page only. If the browser is still responsive, we can reuse it.
    if (this.page) {
      const pageToClose = this.page;
      this.page = undefined;
      await Promise.race([
        pageToClose.close().catch(() => { /* already dead */ }),
        sleep(RECOVERY_CLOSE_TIMEOUT),
      ]);
    }

    // Phase 2: probe whether the browser is still usable. If not, tear it down too.
    const browserAlive = await this.isBrowserAlive();
    if (!browserAlive && this.browser) {
      this.platform.logger.warn("🚑 Browser itself is unresponsive — tearing down and relaunching");
      const browserToClose = this.browser;
      this.browser = undefined;
      await Promise.race([
        browserToClose.close().catch(() => { /* already dead */ }),
        sleep(RECOVERY_CLOSE_TIMEOUT),
      ]);
      try {
        browserToClose.process()?.kill("SIGKILL");
      } catch {
        // process may already be gone
      }
      await sleep(1000);
    } else if (browserAlive) {
      this.platform.logger.info("🚑 Browser still responsive — reusing it (V8 code cache intact)");
    }

    this.recoveryCount++;
    this.platform.logger.info(`🚑 Re-initializing Loxone web interface after recovery (count: ${this.recoveryCount})...`);
    this.isRecovering = false; // init() needs this cleared so it can proceed
    let recovered = false;
    try {
      recovered = await this.init();
    } catch (e: unknown) {
      this.platform.logger.error(`❌ Recovery init failed: ${(e as Error)?.message ?? e}`);
    }
    if (recovered) {
      this.platform.logger.info("✅ Recovery complete — Loxone web interface back online");
    } else {
      this.platform.logger.error("❌ Recovery failed — Loxone web interface still down, will retry");
    }
    // Re-arm the watchdog unconditionally. We cleared it above, and only a
    // SUCCESSFUL init() re-arms it (via startHealthCheck at the end of its try
    // block). Without this, a failed recovery left the watchdog dead forever:
    // the WS path stayed down, nothing ever re-triggered, and the plugin sat
    // accepting HomeKit commands that went nowhere. Observed 2026-07-31 — one
    // transient login failure turned into a 5h silent outage. startHealthCheck
    // is a no-op when already armed, so this is safe on the success path too.
    this.startHealthCheck();
  }

  /**
   * Watch the page's WebSockets via CDP so a dead data path is detected as an
   * EVENT (~20s) instead of being inferred from STATUS_STALE_THRESHOLD silence
   * (10 minutes). This is the fast path for the failure that actually happens
   * here: the Miniserver re-registers its cloud tunnel, gets a new relay
   * host:port, and the socket we hold is closed against an endpoint that no
   * longer exists — the app can retry forever and never get back.
   *
   * We do NOT recover on every close: the Loxone app reconnects itself after an
   * ordinary blip, so a close only arms a timer that any new socket cancels.
   * Recovery fires only if nothing reconnects within the grace window.
   */
  private async watchWebSocket() {
    if (!this.page) {
      return;
    }
    let openSockets = 0;
    const cancelPending = () => {
      if (this.wsRecoveryTimer) {
        clearTimeout(this.wsRecoveryTimer);
        this.wsRecoveryTimer = undefined;
      }
    };
    try {
      const client = await this.page.createCDPSession();
      await client.send("Network.enable");

      client.on("Network.webSocketCreated", () => {
        openSockets++;
        cancelPending(); // reconnected — whatever was pending is moot
      });

      client.on("Network.webSocketClosed", () => {
        openSockets = Math.max(0, openSockets - 1);
        if (openSockets > 0 || this.isRecovering) {
          return; // another socket still carrying data, or we're already on it
        }
        cancelPending();
        this.wsRecoveryTimer = setTimeout(() => {
          this.wsRecoveryTimer = undefined;
          if (this.isRecovering) {
            return;
          }
          this.platform.logger.error(
            `🚨 Loxone WebSocket closed and did not reconnect within ${WS_RECONNECT_GRACE / 1000}s — ` +
            "data path is dead (relay endpoint likely moved), triggering recovery",
          );
          this.triggerRecovery().catch(() => { /* already logged */ });
        }, WS_RECONNECT_GRACE);
      });
    } catch (e) {
      // Non-fatal: without this we simply fall back to the slower
      // STATUS_STALE_THRESHOLD watchdog, which still catches the same failure.
      this.platform.logger.warn(`⚠️  Could not attach WebSocket watcher: ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * Quick liveness probe: create a throwaway page and close it within a deadline.
   * If the browser's CDP connection is wedged, both will time out.
   */
  private async isBrowserAlive(): Promise<boolean> {
    if (!this.browser) {
      return false;
    }
    try {
      const probe = await Promise.race([
        this.browser.newPage(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), RECOVERY_CLOSE_TIMEOUT)),
      ]);
      if (!probe) {
        return false;
      }
      await Promise.race([
        probe.close().catch(() => { /* ignore */ }),
        sleep(RECOVERY_CLOSE_TIMEOUT),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Called from platform.onStatusUpdate / onStatusUpdateBefore on every Loxone
   * status push. The watchdog uses this timestamp to detect a silently dead
   * WS data path (page JS still answers but no events flow through).
   */
  bumpStatusHeartbeat() {
    this.lastStatusPushAt = Date.now();
    // The echo we were waiting for arrived — the path is proven alive.
    if (this.commandEchoTimer) {
      clearTimeout(this.commandEchoTimer);
      this.commandEchoTimer = undefined;
    }
  }

  /**
   * Called right after a command goes out over the WebSocket. Loxone echoes a
   * status push for anything we control, so silence here is proof of death
   * rather than an inference from it — which makes this the fastest detector we
   * have, and the only one that fires on the interaction the user is actually
   * standing in front of.
   *
   * Deliberately armed only once: a burst of commands (e.g. "all blinds up")
   * waits on a single echo, not one timer per control.
   */
  expectStatusAfterCommand() {
    if (this.isRecovering || this.commandEchoTimer || !this.page) {
      return;
    }
    this.commandEchoTimer = setTimeout(() => {
      this.commandEchoTimer = undefined;
      if (this.isRecovering) {
        return;
      }
      this.platform.logger.error(
        `🚨 Command sent but no Loxone status push within ${COMMAND_ECHO_TIMEOUT / 1000}s — ` +
        "data path is dead, triggering recovery",
      );
      this.triggerRecovery().catch(() => { /* already logged */ });
    }, COMMAND_ECHO_TIMEOUT);
  }

  /**
   * Background watchdog. Two checks per tick:
   *   1. JS-responsiveness — `safeEvaluate(() => 1)` exercises Chrome's CDP path;
   *      a hang there triggers recovery via safeEvaluate's own catch.
   *   2. WS-data freshness — if no Loxone status push has landed within
   *      STATUS_STALE_THRESHOLD ms, the WS path is dead even if Chrome is
   *      responsive. The trivial probe in (1) cannot detect this. Trigger
   *      the same recovery path explicitly.
   */
  startHealthCheck() {
    if (this.healthCheckInterval) {
      return;
    }
    // Reset on (re)init — give the threshold window a fresh start so we
    // don't immediately re-trigger after a successful recovery before the
    // first push lands.
    this.lastStatusPushAt = Date.now();
    this.healthCheckInterval = setInterval(async () => {
      if (this.isRecovering || !this.page) {
        return;
      }
      await this.safeEvaluate(() => 1);
      const stale = Date.now() - this.lastStatusPushAt;
      if (stale > STATUS_STALE_THRESHOLD) {
        this.platform.logger.error(
          `🚨 No Loxone status push for ${Math.round(stale / 1000)}s ` +
          `(threshold ${STATUS_STALE_THRESHOLD / 1000}s) — WS data path is dead, triggering recovery`,
        );
        this.triggerRecovery().catch(() => { /* already logged */ });
      }
    }, HEALTH_CHECK_INTERVAL);
  }

  async shutdown() {
    if (this.wsRecoveryTimer) {
      clearTimeout(this.wsRecoveryTimer);
      this.wsRecoveryTimer = undefined;
    }
    if (this.commandEchoTimer) {
      clearTimeout(this.commandEchoTimer);
      this.commandEchoTimer = undefined;
    }
    if (this.preventStandbyInterval) {
      clearInterval(this.preventStandbyInterval);
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
    if (this.page) {
      try {
        await this.page.close();
      } catch {
        // page may already be closed
      }
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // browser may already be closed
      }
      this.browser = undefined;
    }
    this.platform.logger.info("Browser and intervals cleaned up");
  }

  getLoxoneCredentials() {
    return {
      serverUrl: `https://dns.loxonecloud.com/${this.platform.config.loxoneMiniServerId}`,
      user: this.platform.config.loxoneUser,
      password: this.platform.config.loxonePassword,
    };
  }
}
