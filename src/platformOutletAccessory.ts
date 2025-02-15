import { CharacteristicValue, PlatformAccessory } from "homebridge";
import { AccessoryBase } from "./accessoryBase.js";
import { LoxoneControlPlatform } from "./platform.js";
import { sendCommand } from "./loxone/utils/sendCommand.js";
import { States } from "./loxone/types.js";

export class PlatformOutletAccessory extends AccessoryBase {
  constructor(
    public readonly platform: LoxoneControlPlatform,
    public readonly accessory: PlatformAccessory,
    public readonly identifier: string
  ) {
    super(platform, accessory, identifier);
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        "Homebrdige Loxone Puppeteer by @rvetere"
      )
      .setCharacteristic(this.platform.Characteristic.Model, "Loxone Outlet")
      .setCharacteristic(this.platform.Characteristic.SerialNumber, "🤖");

    this.service =
      this.accessory.getService(this.platform.Service.Outlet) ||
      this.accessory.addService(this.platform.Service.Outlet);

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.name
    );

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
    this.platform.log.info(
      `🔌 Control outlet switch "${name}" from ${
        this.states.On ? "On" : "Off"
      } to ${value ? "On" : "Off"}`
    );
    const jsError = await sendCommand(this.platform, this.identifier, [
      value ? "on" : "off",
    ]);
    if (jsError) {
      this.platform.log.error(`Error in sendCommand: ${jsError as string}`);
    }
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
    const firstValue = newValues[Object.keys(newValues)[0]];
    const newStates: States = {};
    if (firstValue === 0) {
      newStates.On = false;
    } else {
      newStates.On = true;
    }
    this.states = newStates;
    this.service?.updateCharacteristic(
      this.platform.Characteristic.On,
      this.states?.On
    );
  };
}
