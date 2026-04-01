import { CharacteristicValue, PlatformAccessory } from "homebridge";
import { AccessoryBase } from "./accessoryBase.js";
import { sendCommandSafe } from "./loxone/utils/sendCommand.js";
import { LoxoneControlPlatform } from "./platform.js";
import { States } from "./loxone/types.js";

export class PlatformToggleAccessory extends AccessoryBase {
  protected override get modelName() {
    return "Loxone Toggle";
  }

  constructor(
    public readonly platform: LoxoneControlPlatform,
    public readonly accessory: PlatformAccessory,
    public readonly identifier: string,
  ) {
    super(platform, accessory, identifier);

    this.service =
      this.accessory.getService(this.platform.Service.Switch) ||
      this.accessory.addService(this.platform.Service.Switch);

    this.setServiceName(this.service, accessory.context.device.name);

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

    // Reset cooldown on all individual blind accessories so they can update immediately
    this.platform.resetAllBlindAutoCooldowns();

    if (value) {
      // Turning ON: send auto command to central automation AND all individual blinds
      this.platform.logger.info(`🔄 CentralJalousie ${name}: Sending auto command to enable automation`);
      await sendCommandSafe(this.platform, this.identifier, ["auto"]);
      
      // Also send auto command to all individual blind accessories
      await this.platform.sendCommandToAllBlinds(["auto"]);
    } else {
      // Turning OFF: send stop command to central automation AND NoAuto to all individual blinds
      this.platform.logger.info(`🔄 CentralJalousie ${name}: Sending stop command to disable automation`);
      await sendCommandSafe(this.platform, this.identifier, ["stop"]);
      
      // Also send NoAuto command to all individual blind accessories
      await this.platform.sendCommandToAllBlinds(["NoAuto"]);
    }
  }

  async setOn(value: CharacteristicValue) {
    const { name } = this.accessory.context.device;
    this.platform.logger.info(
      `🔄 Toggle accessory ${name} set to ${value ? "ON" : "OFF"} - SETTER CALLED!`,
    );

    // For regular toggles, send on/off as requested
    if (value) {
      await sendCommandSafe(this.platform, this.identifier, ["on"]);
    } else {
      await sendCommandSafe(this.platform, this.identifier, ["off"]);
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
      // For CentralJalousie, check current state and send appropriate command
      const currentState = await this.getOn();
      if (currentState) {
        // Currently ON (automation active): send stop to turn off
        await sendCommandSafe(this.platform, this.identifier, ["stop"]);
      } else {
        // Currently OFF (automation inactive): send auto to turn on
        await sendCommandSafe(this.platform, this.identifier, ["auto"]);
      }
    } else {
      // For regular toggles, toggle the state
      const currentState = await this.getOn();
      await this.setOn(!currentState);
    }
  };

  setStateOn = async () => {
    if (this.identifier.includes("type=CentralJalousie")) {
      // For CentralJalousie, send "auto" to activate automation
      await sendCommandSafe(this.platform, this.identifier, ["auto"]);
    } else {
      await this.setOn(true);
    }
  };
}