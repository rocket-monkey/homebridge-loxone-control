/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { resolve } from "path";
import puppeteer, { Browser, Page } from "puppeteer";
import { usernameSync } from "username";
import { LoxoneControlPlatform } from "../platform.js";
import { sleep } from "./utils/sleep.js";

const __dirname = import.meta.dirname;
const BROWSER_LOG = false; // set to true to log browser console messages
const DEBUG_MODE = false; // set to true for verbose debugging
const NAVIGATION_TIMEOUT = 60000; // 60 seconds timeout for navigation

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

  private interval: NodeJS.Timer | undefined;
  private preventStandbyInterval: NodeJS.Timer | undefined;

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
          const launchArgs = isRoot ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] : ["--disable-dev-shm-usage"];
          if (DEBUG_MODE) {
            this.platform.logger.debug(`🔍 Browser launch args: ${JSON.stringify(launchArgs)}`);
          }
          
          this.browser = await puppeteer.launch({
            executablePath: this.platform.config.chromiumPath,
            ignoreHTTPSErrors: true,
            args: launchArgs,
            timeout: 30000,
          });
          if (DEBUG_MODE) {
            this.platform.logger.info("✅ Chromium started successfully");
          }
        } else {
          if (DEBUG_MODE) {
            this.platform.logger.info("🔍 Starting Chrome from local package installation");
          }
          const launchArgs = isRoot ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] : ["--disable-dev-shm-usage"];
          if (DEBUG_MODE) {
            this.platform.logger.debug(`🔍 Browser launch args: ${JSON.stringify(launchArgs)}`);
          }
          
          this.browser = await puppeteer.launch({
            ignoreHTTPSErrors: true,
            args: launchArgs,
            timeout: 30000,
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
      
      // Always log debug messages and WebSocket commands
      if (msgText.includes("🔍 AUTOMATION OFF COMMAND") || msgText.includes("🔍 BLIND AUTO COMMAND") || 
          msgText.includes("🔍") || msgText.includes("CommTracker") || msgText.includes("WebSocket SEND")) {
        if (msgType === "error") {
          this.platform.logger.error(`Browser Console Error: ${msgText}`);
        } else if (msgType === "warn") {
          this.platform.logger.error(`Browser Console Warning: ${msgText}`);
        } else {
          this.platform.logger.info(`Browser Console: ${msgText}`);
        }
        return;
      }
      
      if (msgType === "error") {
        this.platform.logger.error(`🔍 Browser Console Error: ${msgText}`);
      } else if (msgType === "warn") {
        this.platform.logger.error(`🔍 Browser Console Warning: ${msgText}`);
      } else {
        this.platform.logger.debug(`🔍 Browser Console ${msgType}: ${msgText}`);
      }
    });

    // Listen to page errors
    this.page?.on("pageerror", (error) => {
      if (!BROWSER_LOG) {
        return;
      }
      this.platform.logger.error(`🔍 Browser Page Error: ${error.message}`);
      this.platform.logger.error(`🔍 Error stack: ${error.stack}`);
    });

    // Listen to request failures
    this.page?.on("requestfailed", (request) => {
      this.platform.logger.error(`🔍 Request failed: ${request.url()} - ${request.failure()?.errorText}`);
    });

    // Listen to response errors
    this.page?.on("response", (response) => {
      if (response.status() >= 400) {
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
      if (request.url().includes("comps.js")) {
        if (DEBUG_MODE) {
          this.platform.logger.info(`🔍 Intercepting comps.js request: ${request.url()}`);
        }
        // search for "this._initStatesSrc()," and change to
        // "this._initStatesSrc(),window.collection=window.collection?window.collection:[],window.collection.push(this),"
        // then, search for "newStatesReceived" and add at the beginning of the function 
        // "window.LoxoneControlPlatformStatusBefore(v);" and just before the "}else", "window.LoxoneControlPlatformStatus(this);"
        
        let patched = "";
        let version = "unknown";
        
        if (request.url().includes("comps.js?v=15.3.2")) {
          version = "15.3.2";
          patched = await readFile(
            resolve(__dirname, "scripts/comps.js-v15.3.2.js"),
            "utf-8",
          );
        } else if (request.url().includes("comps.js?v=15.1.2")) {
          version = "15.1.2";
          patched = await readFile(
            resolve(__dirname, "scripts/comps.js-v15.1.2.js"),
            "utf-8",
          );
        } else if (request.url().includes("comps.js?v=15.0.1")) {
          version = "15.0.1";
          patched = await readFile(
            resolve(__dirname, "scripts/comps.js-v15.0.1.js"),
            "utf-8",
          );
        } else if (request.url().includes("comps.js?v=14.0.2")) {
          version = "14.0.2";
          patched = await readFile(
            resolve(__dirname, "scripts/comps.js-v14.0.2.js"),
            "utf-8",
          );
        } else if (request.url().includes("comps.js?v=16.0.0")) {
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
          this.platform.logger.info(`✅ Using patched script for Loxone version ${version}, script size: ${patched.length} bytes`);
        }
        
        // Respond with the modified script
        try {
          await request.respond({
            status: 200,
            contentType: "text/javascript",
            body: patched,
          });
          if (DEBUG_MODE) {
            this.platform.logger.info(`✅ Successfully responded with patched script for version ${version}`);
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
      await this.page.goto(serverUrl, { 
        waitUntil: "networkidle2", 
        timeout: NAVIGATION_TIMEOUT,
      });
      if (DEBUG_MODE) {
        this.platform.logger.info(`✅ Page loaded in ${Date.now() - startTime}ms`);
        
        // Take a screenshot for debugging
        const pageContent = await this.page.content();
        this.platform.logger.debug(`🔍 Page title: ${await this.page.title()}`);
        this.platform.logger.debug(`🔍 Page URL: ${this.page.url()}`);
        this.platform.logger.debug(`🔍 Page content length: ${pageContent.length} characters`);
      }
      
      // Check if login form is present
      const hasLoginForm = await this.page.$("input[type=text]") !== null;
      const hasPasswordForm = await this.page.$("input[type=password]") !== null;
      const hasSubmitButton = await this.page.$("button[type=submit]") !== null;
      
      if (DEBUG_MODE) {
        this.platform.logger.info(`🔍 Login form elements found - Username: ${hasLoginForm}, Password: ${hasPasswordForm}, Submit: ${hasSubmitButton}`);
      }
      
      if (!hasLoginForm || !hasPasswordForm || !hasSubmitButton) {
        this.platform.logger.error("❌ Login form elements not found on page");
        return;
      }
      
      if (DEBUG_MODE) {
        this.platform.logger.info("🔍 Typing credentials and submitting...");
      }
      await this.page.type("input[type=text]", user);
      await this.page.type("input[type=password]", password);
      await this.page.click("button[type=submit]");
      
      if (DEBUG_MODE) {
        this.platform.logger.info("🔍 Waiting for navigation...");
      }
      const navigationStart = Date.now();
      await this.page.waitForNavigation({ 
        waitUntil: "networkidle2", 
        timeout: NAVIGATION_TIMEOUT,
      });
      if (DEBUG_MODE) {
        this.platform.logger.info(`✅ Navigation completed in ${Date.now() - navigationStart}ms`);
      }

      if (DEBUG_MODE) {
        this.platform.logger.info("🔍 Waiting for scripts to load...");
      }
      const scriptLoadStart = Date.now();
      await this.page.waitForFunction(
        "!document.querySelector(\"body\").innerText.includes(\"Loading Script \")",
        { timeout: NAVIGATION_TIMEOUT },
      );
      if (DEBUG_MODE) {
        this.platform.logger.info(`✅ Scripts loaded in ${Date.now() - scriptLoadStart}ms`);
        this.platform.logger.info("🔍 Waiting additional 2 seconds for stability...");
      }
      await sleep(1000 * 2);

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
      }, 1000 * 30);

      this.platform.logger.info(
        "✅ Login successful, loxone web interface ready!",
      );

      await sleep(1000 * 2);
      const allCollectedComponents = await this.page?.evaluate(() => {
        try {
          // @ts-expect-error patched
          return window.collection;
        } catch (e) {
          return e;
        }
      });
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
      await this.page?.goto(serverUrl, { 
        waitUntil: "networkidle2", 
        timeout: NAVIGATION_TIMEOUT,
      });
      
      if (DEBUG_MODE) {
        this.platform.logger.debug("🔍 Refresh login - typing credentials");
      }
      await this.page?.type("input[type=text]", user);
      await this.page?.type("input[type=password]", password);

      await this.page?.click("button[type=submit]");
      
      if (DEBUG_MODE) {
        this.platform.logger.debug("🔍 Refresh login - waiting for navigation");
      }
      await this.page?.waitForNavigation({ 
        waitUntil: "networkidle2", 
        timeout: NAVIGATION_TIMEOUT,
      });

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

  getLoxoneCredentials() {
    return {
      serverUrl: `https://dns.loxonecloud.com/${this.platform.config.loxoneMiniServerId}`,
      user: this.platform.config.loxoneUser,
      password: this.platform.config.loxonePassword,
    };
  }
}
