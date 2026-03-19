/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  UnknownContext,
} from "homebridge";
import { EveHomeKitTypes } from "homebridge-lib/EveHomeKitTypes";
import http, { IncomingMessage, Server, ServerResponse } from "http";
import { AccessoryBase } from "./accessoryBase.js";
import { BlindsController } from "./blindsController.js";
import { LoxoneWebinterface } from "./loxone/loxoneWebinterface.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import { sleep } from "./loxone/utils/sleep.js";
import { sendCommand } from "./loxone/utils/sendCommand.js";
import { splitTail } from "./loxone/utils/split.js";
import { PlatformFanAccessory } from "./platformFanAccessory.js";
import { PlatformLightAccessory } from "./platformLightAccessory.js";
import { PlatformOutletAccessory } from "./platformOutletAccessory.js";
import { PlatformTemperatureAccessory } from "./platformTemperatureAccessory.js";
import { PlatformToggleAccessory } from "./platformToggleAccessory.js";
import { PlatformWindowCoveringAccessory } from "./platformWindowCoveringAccessory.js";
import { Logger } from "./logger.js";

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class LoxoneControlPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  // This is only required when using Custom Services and Characteristics not support by HomeKit

  public readonly CustomServices: any;

  public readonly CustomCharacteristics: any;

  // custom properties
  public readonly logger: Logger;
  public readonly instances: AccessoryBase[] = [];
  public blindsController: BlindsController;

  private requestServer?: Server;

  private loxoneWebinterface: LoxoneWebinterface;
  private loxoneWebinterfaceReady = false;
  private allStates: {
    [identifier: string]: any[];
  } = {};

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.logger = new Logger(this);

    // This is only required when using Custom Services and Characteristics not support by HomeKit
    this.CustomServices = new EveHomeKitTypes(this.api).Services;
    this.CustomCharacteristics = new EveHomeKitTypes(this.api).Characteristics;

    this.logger.debug("Finished initializing platform:", this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on("didFinishLaunching", () => {
      this.logger.debug("Executed didFinishLaunching callback");
      // run the method to discover / register your devices as accessories
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

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.logger.info("Loading accessory from cache:", accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices() {
    this.logger.info("🔍 discoverDevices called");
    if (!this.config.devices) {
      this.logger.info("⚠️ No devices configured in config.devices");
      return;
    }
    const devices = this.config.devices;
    this.logger.info(`🔍 Found ${devices.length} devices in config:`, devices.map((d: any) => d.name));

    // loop over the discovered devices and register each one if it has not already been registered
    for (const device of devices) {
      this.logger.info(`🔍 Processing device: ${device.name} with identifier: ${device.identifier}`);
      // generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address
      const uuid = this.api.hap.uuid.generate(device.identifier);
      this.logger.info(`🔍 Generated UUID: ${uuid}`);

      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        // the accessory already exists
        this.logger.info(
          "Restoring existing accessory from cache:",
          existingAccessory.displayName,
        );

        // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
        existingAccessory.context.device = device;
        this.api.updatePlatformAccessories([existingAccessory]);

        // create the accessory handler for the restored accessory
        // this is imported from `platformAccessory.ts`
        const instance = this.createDeviceInstance(
          device.identifier,
          existingAccessory,
        );
        if (!instance) {
          continue;
        }
        this.instances.push(instance);

        // it is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`, eg.:
        // remove platform accessories when no longer present
        // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
        this.logger.info(
          "Removing existing accessory from cache:",
          existingAccessory.displayName,
        );
      } else {
        // the accessory does not yet exist, so we need to create it
        this.logger.info("Adding new accessory:", device.name);

        // create a new accessory
        const accessory = new this.api.platformAccessory(device.name, uuid);

        // store a copy of the device object in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        accessory.context.device = device;

        // create the accessory handler for the newly create accessory
        // this is imported from `platformAccessory.ts`
        const instance = this.createDeviceInstance(
          device.identifier,
          accessory,
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

  /**
   * Custom code of the loxone platform plugin
   */
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
          "GET, POST, OPTIONS, PUT, PATCH, DELETE",
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "X-Requested-With,content-type",
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
      this.requestServer.listen(18081, "0.0.0.0", () =>
        this.logger.info("Http server listening on 0.0.0.0:18081..."),
      );
    } catch (e) {
      this.logger.error("Could not start http server!");
    }
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const [_url, query] =
      request.url && request.url.includes("?") ? request.url.split("?") : [];
    const identifierRaw = query ? query.replace("name=", "") : "";
    const identifier = identifierRaw ? decodeURIComponent(identifierRaw) : null;

    if (request.url === "/discoverDevices") {
      this.logger.debug("🔎 Discover devices request received...");
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
          this.loxoneWebinterface.collectedComponents.map((c) => c.identifier),
        ),
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
      case "Automatikbeschattung":
        await sendCommand(this, identifier, ["on"]);
        await sleep(2000);
        await sendCommand(this, identifier, ["off"]);
        break;
      default:
        // For other categories that might be toggle switches, try a simple on/off
        if (category.includes("Automatikbeschattung")) {
          await sendCommand(this, identifier, ["on"]);
          await sleep(2000);
          await sendCommand(this, identifier, ["off"]);
        }
        break;
    }
  }

  createDeviceInstance(
    identifier: string,
    accessory: PlatformAccessory<UnknownContext>,
  ) {
    const [searchDescription, typeQuery, actionUuid] = identifier.split(":");
    const [room, category] = searchDescription.split(" • ");
    const type = typeQuery.split("=")[1];
    this.logger.info(
      `🔨 Create device instance for room: "${room}", category: "${category}", type: "${type}" (${actionUuid})...`,
    );
    
    // Check if user explicitly selected an accessory type
    if (accessory.context.device.accessoryType) {
      const userType = accessory.context.device.accessoryType;
      this.logger.info(`🔨 User explicitly selected type: "${userType}"`);
      
      switch (userType) {
        case "fan":
          return new PlatformFanAccessory(this, accessory, identifier);
        case "light":
          if (accessory.context.device.lightOutlet) {
            return new PlatformOutletAccessory(this, accessory, identifier);
          }
          return new PlatformLightAccessory(this, accessory, identifier);
        case "temperature":
          return new PlatformTemperatureAccessory(this, accessory, identifier);
        case "blinds":
          return new PlatformWindowCoveringAccessory(this, accessory, identifier);
        case "toggle":
          return new PlatformToggleAccessory(this, accessory, identifier);
        default:
          this.logger.error(`🔨 Unknown user-selected type: "${userType}", falling back to category-based detection`);
          break;
      }
    }
    
    // Fall back to category-based detection
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
        // Check for blinds/shades (Jalousie, Markise)
        if (category === "Jalousie" || category === "Jalousie Loggia" || category.includes("Markise")) {
          this.logger.info(`🔨 Detected window covering accessory based on category: "${category}"`);
          return new PlatformWindowCoveringAccessory(this, accessory, identifier);
        }
        
        // Check for lighting (Deckenleuchte, Deckenspots, Deckenspot, Spot, Leuchte, Spiegelschrank, Schalter)
        if (category.includes("Deckenleuchte") || category.includes("Deckenspots") || category === "Deckenspot" || 
            category.includes("Spot") || category.includes("Leuchte") || category === "Spiegelschrank" || 
            category === "Schalter" || category.includes("Steckdosen")) {
          this.logger.info(`🔨 Detected lighting accessory based on category: "${category}"`);
          if (accessory.context.device.lightOutlet) {
            return new PlatformOutletAccessory(this, accessory, identifier);
          }
          return new PlatformLightAccessory(this, accessory, identifier);
        }
        
        // Check for fans (Lüfter, Ventilator)
        if (category === "Lüfter" || category === "Ventilator") {
          this.logger.info(`🔨 Detected fan accessory based on category: "${category}"`);
          return new PlatformFanAccessory(this, accessory, identifier);
        }
        
        // Check for temperature sensors (Temperatur)
        if (category === "Temperatur") {
          this.logger.info(`🔨 Detected temperature accessory based on category: "${category}"`);
          return new PlatformTemperatureAccessory(this, accessory, identifier);
        }
        
        // Check for switches that should be lights (Abwesenheit Heizung, etc.)
        if (category.includes("Heizung") || category.includes("Abwesenheit")) {
          this.logger.info(`🔨 Detected switch accessory based on category: "${category}"`);
          return new PlatformLightAccessory(this, accessory, identifier);
        }
        
        this.logger.error(`🔨 Unknown category: "${category}", returning null`);
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
    this.logger.info(
      `✅ LoxoneControlPlatform: web interface ready and all components collected (${this.loxoneWebinterface.collectedComponents.length})!`,
    );

    this.loxoneWebinterfaceReady = true;
    // make it possible to discover loxone devices on the fly and identify them trough a custom http service
    this.createHttpService();

    this.instances.forEach((instance) => {
      let foundState = this.allStates[instance.identifier];
      
      if (!foundState) {
        // Fallback: try to find state by matching type and UUID suffix
        const [, typeQuery, actionUuid] = instance.identifier.split(":");
        const type = typeQuery.split("=")[1];
        
        for (const stateKey in this.allStates) {
          const [, stateTypeQuery, stateActionUuid] = stateKey.split(":");
          const stateType = stateTypeQuery.split("=")[1];
          if (stateType === type && stateActionUuid === actionUuid) {
            foundState = this.allStates[stateKey];
            break;
          }
        }
      }
      
      if (foundState) {
        instance.setState(foundState);
      } else {
        this.logger.error(`No initial state found for ${instance.identifier}`);
      }
    });
  }

  onStatusUpdateBefore(newValue: any) {
    const thirdKey = Object.keys(newValue).pop();
    const lastPart = splitTail(thirdKey, "-");
    const existingControls = this.loxoneWebinterface.collectedComponents.filter(
      (c) => {
        const result = c.uuidAction.includes(lastPart);
        return result;
      },
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
        (inst) => inst.accessory.UUID === uuid,
      );
      if (existingInstance) {
        if (identifier.includes("Beschattung")) {
          existingInstance.setState(newValue);
        }
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
    
    let existingInstance = this.instances.find(
      (inst) => inst.accessory.UUID === uuid,
    );
    
    if (!existingInstance) {
      // Fallback: try to match by type and UUID suffix when full identifier doesn't match
      // This handles the case where status updates use German room names but config uses UUID room names
      const [, typeQuery, actionUuid] = identifier.split(":");
      const type = typeQuery.split("=")[1];
      
      existingInstance = this.instances.find((inst) => {
        const [, instTypeQuery, instActionUuid] = inst.identifier.split(":");
        const instType = instTypeQuery.split("=")[1];
        return instType === type && instActionUuid === actionUuid;
      });
    }
    
    if (existingInstance && !!newState) {
      existingInstance.setState(newState);
      return;
    }
    if (identifier.includes("Beschattung")) {
      newState.forEach(
        ((val: any) => {
          const subIdentifier = `Beschattung:type=Jalousie:${val.controlUUID}`;
          const existingInstance = this.instances.find((inst) =>
            inst.identifier.includes(subIdentifier),
          );

          if (existingInstance) {
            existingInstance.setState([val]);
          }
        }).bind(this),
      );
      return;
    }
  }

  // Reset cooldown for all blind accessories to allow immediate state updates
  resetAllBlindAutoCooldowns() {
    this.instances.forEach((instance) => {
      if (instance instanceof PlatformWindowCoveringAccessory) {
        instance.resetAutoSunCooldown();
      }
    });
    this.logger.debug("🔄 Reset auto sun cooldowns for all blind accessories");
  }

  // Send command to all individual blind accessories
  async sendCommandToAllBlinds(commands: string[]) {
    const blindInstances = this.instances.filter(
      (instance) => instance instanceof PlatformWindowCoveringAccessory,
    ) as PlatformWindowCoveringAccessory[];

    this.logger.info(`🔄 Sending ${commands[0]} command to ${blindInstances.length} blind accessories`);

    // Update local state immediately for all blinds to reflect the expected change
    const expectedState = commands[0] === "auto";
    blindInstances.forEach((blindInstance) => {
      blindInstance.autoSunPosition = expectedState;
      blindInstance.autoSunSwitchService?.updateCharacteristic(
        this.Characteristic.On,
        expectedState,
      );
      // Set cooldown for all blinds to prevent them from being overridden by stale WebSocket responses
      blindInstance.lastAutoSunCommand = Date.now();
    });

    // Send commands to all blinds in parallel (without setting individual cooldowns)
    const commandPromises = blindInstances.map(async (blindInstance) => {
      try {
        await sendCommand(this, blindInstance.identifier, commands);
        this.logger.debug(`🔄 Sent ${commands[0]} to ${blindInstance.accessory.context.device.name}`);
      } catch (error) {
        this.logger.error(`🔄 Failed to send ${commands[0]} to ${blindInstance.accessory.context.device.name}:`, error);
      }
    });

    await Promise.all(commandPromises);
    this.logger.info(`🔄 Completed sending ${commands[0]} command to all blinds`);
  }
}
