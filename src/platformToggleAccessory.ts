import { CharacteristicValue, PlatformAccessory } from "homebridge";
import { AccessoryBase } from "./accessoryBase.js";
import { sendCommand } from "./loxone/utils/sendCommand.js";
import { LoxoneControlPlatform } from "./platform.js";
import { States } from "./loxone/types.js";

export class PlatformToggleAccessory extends AccessoryBase {
  constructor(
    public readonly platform: LoxoneControlPlatform,
    public readonly accessory: PlatformAccessory,
    public readonly identifier: string,
  ) {
    super(platform, accessory, identifier);
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        "Homebrdige Loxone Puppeteer by @rvetere",
      )
      .setCharacteristic(this.platform.Characteristic.Model, "Loxone Toggle")
      .setCharacteristic(this.platform.Characteristic.SerialNumber, "🤖");

    this.service =
      this.accessory.getService(this.platform.Service.Switch) ||
      this.accessory.addService(this.platform.Service.Switch);

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.name,
    );

    // For CentralJalousie, we need special handling since it's a toggle command
    if (this.identifier.includes("type=CentralJalousie")) {
      this.service
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setOnCentralJalousie.bind(this))
        .onGet(this.getOn.bind(this));
    } else {
      this.service
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setOn.bind(this))
        .onGet(this.getOn.bind(this));
    }
  }

  async setOnCentralJalousie(value: CharacteristicValue) {
    const { name } = this.accessory.context.device;
    this.platform.logger.info(
      `🔄 CentralJalousie ${name} triggered (value: ${value}) - SETTER CALLED!`,
    );

    // Always send "auto" command to toggle automation, regardless of the requested value
    this.platform.logger.info(`🔄 CentralJalousie ${name}: Sending auto toggle command`);
    await sendCommand(this.platform, this.identifier, ["auto"]);
  }

  async setOn(value: CharacteristicValue) {
    const { name } = this.accessory.context.device;
    this.platform.logger.info(
      `🔄 Toggle accessory ${name} set to ${value ? "ON" : "OFF"} - SETTER CALLED!`,
    );

    // For regular toggles, send on/off as requested
    if (value) {
      await sendCommand(this.platform, this.identifier, ["on"]);
    } else {
      await sendCommand(this.platform, this.identifier, ["off"]);
    }
  }

  async getOn() {
    if (this.identifier.includes("type=CentralJalousie")) {
      // For CentralJalousie, check if ALL blinds have autoActive: true
      if (Array.isArray(this.states)) {
        const allAutoActive = this.states.every((blind: { autoActive: boolean }) => blind.autoActive === true);
        this.platform.logger.debug(
          `🔄 CentralJalousie ${this.accessory.context.device.name}: ${this.states.length} blinds, all auto active: ${allAutoActive}`,
        );
        return allAutoActive;
      }
      return false;
    } else {
      // For regular toggles, use the On state
      const isOn = this.states?.On === 1;
      this.platform.logger.debug(
        `🔄 Toggle accessory ${this.accessory.context.device.name} is ${
          isOn ? "ON" : "OFF"
        }`,
      );
      return isOn;
    }
  }

  setState = (newStates: States) => {
    this.states = newStates;
    this.platform.logger.debug(
      `🔄 Toggle accessory ${this.accessory.context.device.name} state updated`,
    );
    
    if (this.identifier.includes("type=CentralJalousie")) {
      // For CentralJalousie, calculate the state based on all blinds' autoActive status
      if (Array.isArray(newStates)) {
        const allAutoActive = newStates.every((blind: { autoActive: boolean }) => blind.autoActive === true);
        const autoActiveCount = newStates.filter((blind: { autoActive: boolean }) => blind.autoActive === true).length;
        
        this.platform.logger.debug(
          `🔄 CentralJalousie ${this.accessory.context.device.name}: ${autoActiveCount}/${newStates.length} blinds in auto mode, ` +
          `setting switch to ${allAutoActive ? "ON" : "OFF"}`,
        );
        
        this.service?.updateCharacteristic(
          this.platform.Characteristic.On,
          allAutoActive,
        );
      }
    } else {
      // For regular toggles, use the On state
      this.service?.updateCharacteristic(
        this.platform.Characteristic.On,
        newStates.On === 1,
      );
    }
  };

  toggleState = async () => {
    if (this.identifier.includes("type=CentralJalousie")) {
      // For CentralJalousie, always send "auto" to toggle automation
      await sendCommand(this.platform, this.identifier, ["auto"]);
    } else {
      // For regular toggles, toggle the state
      const currentState = await this.getOn();
      await this.setOn(!currentState);
    }
  };

  setStateOn = async () => {
    if (this.identifier.includes("type=CentralJalousie")) {
      // For CentralJalousie, send "auto" to activate automation if not already active
      await sendCommand(this.platform, this.identifier, ["auto"]);
    } else {
      await this.setOn(true);
    }
  };
}