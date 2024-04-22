/* eslint-disable @typescript-eslint/no-explicit-any */
import puppeteer, { Browser, Page } from "puppeteer";
import { LoxoneControlPlatform } from "../platform";
import username from "username";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { sleep } from "./utils/sleep";

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
    this.platform.log.debug("LoxoneWebinterface constructor");
    this.init = this.init.bind(this);
    this.getLoxoneCredentials = this.getLoxoneCredentials.bind(this);
  }

  async init() {
    const { serverUrl, user, password } = this.getLoxoneCredentials();
    if (!serverUrl || !user || !password) {
      return;
    }
    this.platform.log.info(`🚀 Initializing loxone web interface..`);
    this.platform.log.debug(`🔗 Open URL "${serverUrl}" and login...`);

    if (!this.browser) {
      try {
        const isRoot = username.sync() === "root";
        if (this.platform.config.chromiumPath) {
          // check if chromium path exists
          if (!existsSync(this.platform.config.chromiumPath)) {
            this.platform.log.error(
              `Chromium path does not exist: ${this.platform.config.chromiumPath}`
            );
            return;
          }

          this.platform.log.debug(
            "Starting new instance of Chromium: " +
              this.platform.config.chromiumPath
          );
          this.browser = await puppeteer.launch({
            executablePath: this.platform.config.chromiumPath,
            ignoreHTTPSErrors: false,
            args: isRoot ? ["--no-sandbox"] : [],
          });
          this.platform.log.debug("Chromium started");
        } else {
          this.browser = await puppeteer.launch({
            ignoreHTTPSErrors: false,
            args: isRoot ? ["--no-sandbox"] : [],
          });
          this.platform.log.debug(
            "Chrome of local package installation started"
          );
        }
      } catch (e) {
        this.platform.log.error(
          "Could not start headless browser! See https://github.com/rocket-monkey/homebridge-loxone-control?tab=readme-ov-file#setup"
        );
      }
    }
    this.page = await this.browser?.newPage();

    // mobile viewport for easy navigation
    await this.page?.setViewport({ width: 500, height: 800 });

    await this.page?.exposeFunction(
      "LoxoneControlPlatformStatus",
      (stateContainer: any) => {
        this.platform.onStatusUpdate(stateContainer);
      }
    );
    await this.page?.exposeFunction(
      "LoxoneControlPlatformStatusBefore",
      (newValues: any) => {
        this.platform.onStatusUpdateBefore(newValues);
      }
    );

    // store in localstorage the loxone config with "ambientOnboardingShown":true
    await this.page?.evaluateOnNewDocument((settingStr) => {
      localStorage.setItem("LoxSettings.json", settingStr);
      // eslint-disable-next-line max-len
    }, `{"animations":true,"darkMode":true,"tileRepresentation":true,"simpleDesign":false,"miniservers":{"${this.platform.config.loxoneMiniServerId}":{"homeScreen":{"activated":true,"widget":{"building":0,"skyline":0}},"manualFavorites":{"activated":false},"deviceFavorites":{"activated":false},"entryPointLocation":"favorites","presenceRoom":"","instructionFlags":{},"userManagement":{},"sortingDeviceFavorites":{"Mieter":{"activated":false}},"kvStore":{},"ambientOnboardingShown":true}},"instructionFlags":{},"LOCAL_STORAGE":{},"entryPoint":{"activated":true,"entryPointLocation":"favorites"},"SYNC":{"ENABLED":false},"screenSaver":{"activationTime":300,"brightness":10}}`);

    // Listen for each network request
    await this.page?.setRequestInterception(true);
    this.page?.on("request", async (request) => {
      if (request.url().includes("comps.js?v=14.0.2")) {
        // Read the modified script content
        const patched = await readFile(
          resolve(__dirname, "scripts/comps.js-v14.0.2.js"),
          "utf-8"
        );
        // search for "this._initStatesSrc()," and change to
        // "this._initStatesSrc(),window.collection=window.collection?window.collection:[],window.collection.push(this),"
        // then, search for "newStatesReceived" and add at the beginning of the function "window.LoxoneControlPlatformStatusBefore(v);" and just before the "}else", "window.LoxoneControlPlatformStatus(this);"

        // Respond with the modified script
        request.respond({
          status: 200,
          contentType: "text/javascript",
          body: patched,
        });
      } else {
        request.continue();
      }
    });

    try {
      if (!this.page) {
        return;
      }
      // login to loxone miniserver
      await this.page.goto(serverUrl);
      await this.page.type("input[type=text]", user);
      await this.page.type("input[type=password]", password);

      await this.page.click("button[type=submit]");
      await this.page.waitForNavigation();

      await this.page.waitForFunction(
        `!document.querySelector("body").innerText.includes("Loading Script ")`
      );
      await sleep(1000 * 2);

      // random number between 0 and 60 seconds
      const randomDelay = Math.floor(Math.random() * 1000 * 60);

      this.interval = setInterval(
        this.refreshLogin.bind(this),
        1000 * 60 * 60 * 24 + randomDelay
      );

      this.preventStandbyInterval = setInterval(async () => {
        if (this.page) {
          await this.page.mouse.move(0, 0);
        }
      }, 1000 * 30);

      this.platform.log.info(
        `✅ Login successful, loxone web interface ready!`
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
      this.collectedComponents = allCollectedComponents.map((c) => ({
        ...c,
        identifier: `${c.searchDescription || "unknown • unknown"}:type=${
          c.type
        }:${c.uuidAction}`,
      })) as LoxoneComponent[];
      this.platform.log.info(
        "🔌 All collected components: ",
        this.collectedComponents.map((c) => c.identifier)
      );
      this.platform.onReady();
    } catch (e) {
      this.platform.log.error("Error during login!");
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

    this.platform.log.debug(`Refreshing login for loxone web interface...`);
    const timestamp = new Date().getTime();

    try {
      // login to loxone miniserver
      await this.page?.goto(serverUrl);
      await this.page?.type("input[type=text]", user);
      await this.page?.type("input[type=password]", password);

      await this.page?.click("button[type=submit]");
      await this.page?.waitForNavigation();

      await this.page?.waitForFunction(
        `!document.querySelector("body").innerText.includes("Loading Script ")`
      );

      const timeElapsed = new Date().getTime() - timestamp;
      // log success with time elapsed in seconds
      this.platform.log.info(
        `Successfully refreshed login in ${Math.floor(
          timeElapsed / 1000
        )} seconds!`
      );
    } catch (e) {
      this.platform.log.error("Error during login: ", e);
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
