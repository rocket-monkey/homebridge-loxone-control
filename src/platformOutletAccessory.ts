import { CharacteristicValue, PlatformAccessory } from "homebridge";
import { AccessoryBase } from "./accessoryBase.js";
import { LoxoneControlPlatform } from "./platform.js";
import { sendCommandSafe } from "./loxone/utils/sendCommand.js";
import { States } from "./loxone/types.js";

export class PlatformOutletAccessory extends AccessoryBase {
  protected override get modelName() {
    return "Loxone Outlet";
  }

  constructor(
    public readonly platform: LoxoneControlPlatform,
    public readonly accessory: PlatformAccessory,
    public readonly identifier: string,
  ) {
    super(platform, accessory, identifier);

    this.service =
      this.accessory.getService(this.platform.Service.Outlet) ||
      this.accessory.addService(this.platform.Service.Outlet);

    this.setServiceName(this.service, accessory.context.device.name);

    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));
  }

  async setOn(value: CharacteristicValue) {
    if (this.states?.On === value) {
      return;
    }

    const { name } = this.accessory.context.device;
    this.platform.logger.info(
      `🔌 Control outlet switch "${name}" from ${
        this.states.On ? "On" : "Off"
      } to ${value ? "On" : "Off"}`,
    );
    await sendCommandSafe(this.platform, this.identifier, [
      value ? "on" : "off",
    ]);
  }

  async getOn(): Promise<CharacteristicValue> {
    return this.states?.On || false;
  }

  toggleState = async () => {
    if (!this.states) {
      return;
    }
    await this.setOn(!this.states.On);
  };

  setStateOn = async () => {
    if (!this.states) {
      return;
    }
    await this.setOn(true);
  };

  setState = (newValues: States) => {
    const keys = Object.keys(newValues);
    if (keys.length === 0) {
      return;
    }
    const firstValue = newValues[keys[0]];
    const newStates: States = {};
    if (firstValue === 0) {
      newStates.On = false;
    } else {
      newStates.On = true;
    }
    this.states = newStates;
    this.service?.updateCharacteristic(
      this.platform.Characteristic.On,
      this.states?.On,
    );
  };
}
