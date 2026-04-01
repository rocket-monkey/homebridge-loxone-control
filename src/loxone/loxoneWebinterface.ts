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
} from "../settings.js";

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

  private interval: ReturnType<typeof setInterval> | undefined;
  private preventStandbyInterval: ReturnType<typeof setInterval> | undefined;

  constructor(public readonly platform: LoxoneControlPlatform) {
    this.platform.logger.debug("LoxoneWebinterface constructor");
    this.init = this.init.bind(this);
    this.getLoxoneCredentials = this.getLoxoneCredentials.bind(this);
  }

  async init() {
    const { serverUrl, user, password } = this.getLoxoneCredentials();
    if (!serverUrl || !user || !password) {
      this.platform.logger.error("❌ Missing credentials - serverUrl, user or password not configured");
      return;
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
            return;
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
        return;
      }
    }
    if (DEBUG_MODE) {
      this.platform.logger.info("🔍 Creating new page...");
    }
    this.page = await this.browser?.newPage();
    if (DEBUG_MODE) {
      this.platform.logger.info("✅ New page created");
    }

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

    // Listen to request failures
    this.page?.on("requestfailed", (request) => {
      this.platform.logger.error(`🔍 Request failed: ${request.url()} - ${request.failure()?.errorText}`);
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
        return;
      }
      
      const startTime = Date.now();
      if (DEBUG_MODE) {
        this.platform.logger.info(`🔍 Navigating to: ${serverUrl}`);
      }
      
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
      const navigationStart = Date.now();
      await this.page.click("button[type=submit]");

      // After login, the Loxone web app loads the massive comps.js (14-16MB)
      // which blocks Chrome's main thread. We can't use waitForFunction/evaluate
      // during this time. Instead, wait for the intercepted comps.js to be served
      // and give Chrome time to parse it.
      // Wait for the post-login page to load (comps.js parsing takes time)
      this.platform.logger.info("🔍 Waiting for Loxone web interface to load...");
      await sleep(LOGIN_POST_SUBMIT_DELAY);
      this.platform.logger.info(`✅ Login flow completed in ${Date.now() - navigationStart}ms`);
      await sleep(LOGIN_POST_LOAD_DELAY);

      // random number between 0 and 60 seconds
      const randomDelay = Math.floor(Math.random() * 1000 * 60);

      this.interval = setInterval(
        this.refreshLogin.bind(this),
        1000 * 60 * 60 * 24 + randomDelay,
      );

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
      for (let i = 0; i < COLLECTION_MAX_ATTEMPTS; i++) {
        await sleep(COLLECTION_POLL_INTERVAL);
        try {
          allCollectedComponents = await this.page?.evaluate(() => {
            // @ts-expect-error patched
            return window.collection;
          });
          if (allCollectedComponents && allCollectedComponents.length > 0) {
            this.platform.logger.info(`✅ Collection ready with ${allCollectedComponents.length} components after ${(i + 1) * 5}s`);
            break;
          }
        } catch {
          // JS context may still be busy — keep trying
        }
      }
      if (!allCollectedComponents || allCollectedComponents.length === 0) {
        this.platform.logger.error(`❌ No components collected after ${(COLLECTION_MAX_ATTEMPTS * COLLECTION_POLL_INTERVAL) / 1000}s`);
        return;
      }
      this.collectedComponents = allCollectedComponents.map((c: any) => ({
        ...c,
        identifier: `${c.searchDescription || "unknown • unknown"}:type=${
          c.type
        }:${c.uuidAction}`,
      })) as LoxoneComponent[];
      this.platform.logger.info(
        "🔌 All collected components: ",
        this.collectedComponents.map((c) => c.identifier),
      );
      this.platform.onReady();
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
    }
  }

  async refreshLogin() {
    const { serverUrl, user, password } = this.getLoxoneCredentials();
    if (!serverUrl || !user || !password) {
      return;
    }

    if (!this.browser) {
      return;
    }

    this.platform.logger.debug("Refreshing login for loxone web interface...");
    const timestamp = new Date().getTime();

    try {
      // login to loxone miniserver
      if (DEBUG_MODE) {
        this.platform.logger.debug(`🔍 Refresh login - navigating to: ${serverUrl}`);
      }
      this.page?.goto(serverUrl).catch(() => { /* navigation may be interrupted */ });
      await this.page?.waitForSelector("input[type=text]", { timeout: NAVIGATION_TIMEOUT });

      if (DEBUG_MODE) {
        this.platform.logger.debug("🔍 Refresh login - typing credentials");
      }
      await this.page?.type("input[type=text]", user);
      await this.page?.type("input[type=password]", password);

      await Promise.all([
        this.page?.click("button[type=submit]"),
        this.page?.waitForSelector("input[type=text]", { hidden: true, timeout: NAVIGATION_TIMEOUT }),
      ]);

      if (DEBUG_MODE) {
        this.platform.logger.debug("🔍 Refresh login - waiting for scripts to load");
      }
      await this.page?.waitForFunction(
        "!document.querySelector(\"body\").innerText.includes(\"Loading Script \")",
        { timeout: NAVIGATION_TIMEOUT },
      );

      const timeElapsed = new Date().getTime() - timestamp;
      // log success with time elapsed in seconds
      this.platform.logger.info(
        `✅ Successfully refreshed login in ${Math.floor(
          timeElapsed / 1000,
        )} seconds!`,
      );
    } catch (e: any) {
      this.platform.logger.error("❌ Error during refresh login!");
      this.platform.logger.error(`🔍 Error message: ${e.message}`);
      
      if (e.message?.includes("Navigation timeout")) {
        this.platform.logger.error("🔍 Navigation timeout during refresh - server may be slow or unresponsive");
      }
    }
  }

  async shutdown() {
    if (this.interval) {
      clearInterval(this.interval);
    }
    if (this.preventStandbyInterval) {
      clearInterval(this.preventStandbyInterval);
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
