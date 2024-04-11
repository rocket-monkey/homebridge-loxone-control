/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable indent */
import http, { IncomingMessage, Server, ServerResponse } from "http";
import {
  API,
  APIEvent,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  UnknownContext,
} from "homebridge";
import { AccessoryBase } from "./accessoryBase";
import { BlindsController } from "./blindsController";
import { LoxoneWebinterface } from "./loxone/loxoneWebinterface";
import { splitTail } from "./loxone/utils/split";
import { PlatformFanAccessory } from "./platformFanAccessory";
import { PlatformLightAccessory } from "./platformLightAccessory";
import { PlatformOutletAccessory } from "./platformOutletAccessory";
import { PlatformTemperatureAccessory } from "./platformTemperatureAccessory";
import { PlatformWindowCoveringAccessory } from "./platformWindowCoveringAccessory";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { sleep } from "./loxone/utils/sleep";
import { sendCommand } from "./loxone/utils/sendCommand";

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class LoxoneControlPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic =
    this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  public readonly instances: AccessoryBase[] = [];
  public blindsController: BlindsController;

  private requestServer?: Server;

  private loxoneWebinterface: LoxoneWebinterface;
  private loxoneWebinterfaceReady = false;
  private allStates: {
    [identifier: string]: any[];
  } = {};

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API
  ) {
    this.log.debug("Finished initializing platform:", this.config.platform);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      // run the method to discover / register your devices as accessories (from config)
      this.discoverDevices();
    });

    this.loxoneWebinterface = new LoxoneWebinterface(this);
    this.loxoneWebinterface.init();
    this.blindsController = new BlindsController(this);

    this.createDeviceInstance = this.createDeviceInstance.bind(this);
    this.getLoxoneWebinterface = this.getLoxoneWebinterface.bind(this);
    this.onReady = this.onReady.bind(this);
    this.onStatusUpdate = this.onStatusUpdate.bind(this);
    this.onStatusUpdateBefore = this.onStatusUpdateBefore.bind(this);
    this.handleRequest = this.handleRequest.bind(this);
    this.identifyAccessory = this.identifyAccessory.bind(this);
    this.toggleAccessoryState = this.toggleAccessoryState.bind(this);
    this.setAccessoryStateOn = this.setAccessoryStateOn.bind(this);
  }

  createHttpService() {
    if (
      !this.config.loxoneMiniServerId ||
      !this.config.loxoneUser ||
      !this.config.loxonePassword
    ) {
      return;
    }

    try {
      this.requestServer = http.createServer((req, res) => {
        // Set CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*"); // This allows all origins
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, OPTIONS, PUT, PATCH, DELETE"
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "X-Requested-With,content-type"
        );
        res.setHeader("Access-Control-Allow-Credentials", "true");

        // Handle preflight OPTIONS request
        if (req.method === "OPTIONS") {
          res.writeHead(200);
          res.end();
          return;
        }

        this.handleRequest(req, res);
      });
      this.requestServer.listen(18081, () =>
        this.log.info("Http server listening on 18081...")
      );
    } catch (e) {
      this.log.error("Could not start http server!");
    }
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ) {
    const [_url, query] =
      request.url && request.url.includes("?") ? request.url.split("?") : [];
    const identifierRaw = query ? query.replace("name=", "") : "";
    const identifier = identifierRaw ? decodeURIComponent(identifierRaw) : null;

    if (request.url === "/discoverDevices") {
      this.log.debug("🔎 Discover devices request received...");
      if (!this.loxoneWebinterfaceReady) {
        let tries = 0;
        while (!this.loxoneWebinterfaceReady && tries < 4) {
          await sleep(500);
          tries++;
        }
      }

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          this.loxoneWebinterface.collectedComponents.map((c) => c.identifier)
        )
      );
      return;
    } else if (request.url?.includes("/identifyAccessory") && identifier) {
      this.identifyAccessory(identifier);
    } else if (request.url?.includes("/toggle") && identifier) {
      this.toggleAccessoryState(identifier);
    } else if (request.url?.includes("/setOn") && identifier) {
      this.setAccessoryStateOn(identifier);
    }

    response.writeHead(204); // 204 No content
    response.end();
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info("Loading accessory from cache:", accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  async toggleAccessoryState(identifier: string) {
    return this.instances
      .find((instance) => instance.identifier === identifier)
      ?.toggleState();
  }

  async setAccessoryStateOn(identifier: string) {
    return this.instances
      .find((instance) => instance.identifier === identifier)
      ?.setStateOn();
  }

  async identifyAccessory(identifier: string) {
    const [searchDescription] = identifier.split(":");
    const [_room, category] = searchDescription.split(" • ");
    switch (category) {
      case "Klima":
        break;
      case "Beschattung":
        await sendCommand(this, identifier, ["FullDown"]);
        await sleep(3000);
        await sendCommand(this, identifier, ["FullUp"]);
        await sleep(500);
        await sendCommand(this, identifier, ["FullUp"]);
        break;
      case "Beleuchtung":
        await sendCommand(this, identifier, ["on"]);
        await sleep(3000);
        await sendCommand(this, identifier, ["off"]);
        break;
      case "Lüftung":
        await sendCommand(this, identifier, ["4"]);
        await sleep(4000);
        await sendCommand(this, identifier, ["reset"]);
        break;
    }
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices() {
    if (!this.config.devices) {
      return;
    }
    const devices = this.config.devices;

    // loop over the discovered devices and register each one if it has not already been registered
    for (const device of devices) {
      // generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address
      const uuid = this.api.hap.uuid.generate(device.identifier);

      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.find(
        (accessory) => accessory.UUID === uuid
      );

      if (existingAccessory) {
        // the accessory already exists
        this.log.info(
          "Restoring existing accessory from cache:",
          existingAccessory.displayName
        );

        // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
        existingAccessory.context.device = device;
        this.api.updatePlatformAccessories([existingAccessory]);

        // create the accessory handler for the restored accessory
        // this is imported from `platformAccessory.ts`
        const instance = this.createDeviceInstance(
          device.identifier,
          existingAccessory
        );
        if (!instance) {
          continue;
        }
        this.instances.push(instance);

        // it is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`, eg.:
        // remove platform accessories when no longer present
        // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
        this.log.info(
          "Removing existing accessory from cache:",
          existingAccessory.displayName
        );
      } else {
        // the accessory does not yet exist, so we need to create it
        this.log.info("Adding new accessory:", device.name);

        // create a new accessory
        const accessory = new this.api.platformAccessory(device.name, uuid);

        // store a copy of the device object in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        accessory.context.device = device;

        // create the accessory handler for the newly create accessory
        // this is imported from `platformAccessory.ts`
        const instance = this.createDeviceInstance(
          device.identifier,
          accessory
        );
        if (!instance) {
          continue;
        }
        this.instances.push(instance);

        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
      }
    }
  }

  createDeviceInstance(
    identifier: string,
    accessory: PlatformAccessory<UnknownContext>
  ) {
    const [searchDescription, typeQuery, actionUuid] = identifier.split(":");
    const [room, category] = searchDescription.split(" • ");
    const type = typeQuery.split("=")[1];
    this.log.info(
      `🔨 Create device instance for room: "${room}", category: "${category}", type: "${type}" (${actionUuid})...`
    );
    switch (category) {
      case "Klima":
        return new PlatformTemperatureAccessory(this, accessory, identifier);
      case "Beschattung":
        return new PlatformWindowCoveringAccessory(this, accessory, identifier);
      case "Beleuchtung": {
        if (accessory.context.device.lightOutlet) {
          return new PlatformOutletAccessory(this, accessory, identifier);
        }
        return new PlatformLightAccessory(this, accessory, identifier);
      }
      case "Lüftung":
        return new PlatformFanAccessory(this, accessory, identifier);
      default:
        return null;
    }
  }

  getLoxoneWebinterface() {
    if (!this.loxoneWebinterfaceReady) {
      return null;
    }
    return this.loxoneWebinterface.page;
  }

  async onReady() {
    this.log.info(
      `✅ LoxoneControlPlatform: web interface ready and all components collected (${this.loxoneWebinterface.collectedComponents.length})!`
    );

    this.loxoneWebinterfaceReady = true;
    // make it possible to discover loxone devices on the fly and identify them trough a custom http service
    this.createHttpService();

    this.instances.forEach((instance) => {
      if (this.allStates[instance.identifier]) {
        instance.setState(this.allStates[instance.identifier]);
      }
    });
  }

  onStatusUpdateBefore(newValue: any) {
    const thirdKey = Object.keys(newValue)[2];
    const lastPart = splitTail(thirdKey, "-");
    const existingControls = this.loxoneWebinterface.collectedComponents.filter(
      (c) => c.uuidAction.includes(lastPart)
    );
    if (existingControls.length === 0) {
      return;
    }
    if (existingControls.length > 1) {
      return;
    }
    const existingControl = existingControls[0];
    if (existingControl) {
      const identifier = `${
        existingControl.searchDescription || "unknown • unknown"
      }:type=${existingControl.type}:${existingControl.uuidAction}`;
      const uuid = this.api.hap.uuid.generate(identifier);
      const existingInstance = this.instances.find(
        (inst) => inst.accessory.UUID === uuid
      );
      if (existingInstance && identifier.includes("Beschattung")) {
        existingInstance.setState(newValue);
        return;
      }
    }
  }

  onStatusUpdate(stateContainer: any) {
    const { searchDescription, type, uuidAction } = stateContainer.control;
    const identifier = `${
      searchDescription || "unknown • unknown"
    }:type=${type}:${uuidAction}`;

    const newState = stateContainer.newVals || stateContainer.states;
    this.allStates[identifier] = newState;
    if (!this.loxoneWebinterfaceReady) {
      return;
    }

    // When the web interface is ready, we can update a specific accessory
    const uuid = this.api.hap.uuid.generate(identifier);
    const existingInstance = this.instances.find(
      (inst) => inst.accessory.UUID === uuid
    );
    if (existingInstance && !!newState) {
      existingInstance.setState(newState);
      return;
    }
    if (identifier.includes("Beschattung")) {
      newState.forEach(
        ((val) => {
          const subIdentifier = `Beschattung:type=Jalousie:${val.controlUUID}`;
          const existingInstance = this.instances.find((inst) =>
            inst.identifier.includes(subIdentifier)
          );

          if (existingInstance) {
            existingInstance.setState([val]);
          }
        }).bind(this)
      );
      return;
    }
  }
}
