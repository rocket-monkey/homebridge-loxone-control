import { CharacteristicValue, PlatformAccessory } from "homebridge";
import { AccessoryBase } from "./accessoryBase.js";
import { sendCommand } from "./loxone/utils/sendCommand.js";
import { LoxoneControlPlatform } from "./platform.js";
import { States } from "./loxone/types.js";

export class PlatformLightAccessory extends AccessoryBase {
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
      .setCharacteristic(this.platform.Characteristic.Model, "Loxone Light")
      .setCharacteristic(this.platform.Characteristic.SerialNumber, "🤖");

    this.service =
      this.accessory.getService(this.platform.Service.Lightbulb) ||
      this.accessory.addService(this.platform.Service.Lightbulb);

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.name
    );

    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    if (this.identifier.includes("type=Dimmer")) {
      this.service
        .getCharacteristic(this.platform.Characteristic.Brightness)
        .onSet(this.setBrightness.bind(this))
        .onGet(this.getBrightness.bind(this));
    }
  }

  async setOn(value: CharacteristicValue) {
    if (this.states?.On === value) {
      return;
    }

    const { name } = this.accessory.context.device;
    this.platform.log.info(
      `💡 Control light switch "${name}" from ${
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

  async setBrightness(givenValue: CharacteristicValue) {
    // we can only handle steps of 10
    const value = Math.round((givenValue as number) / 10) * 10;
    if (this.states?.Brightness === value) {
      return;
    }

    const { name } = this.accessory.context.device;
    this.platform.log.info(
      `💡 Control brightness "${name}" from ${this.states.Brightness}% to ${value}%`
    );
    const jsError = await sendCommand(this.platform, this.identifier, [
      `${value}`,
      "override",
    ]);
    if (jsError) {
      this.platform.log.error(`Error in sendCommand: ${jsError as string}`);
    }
  }

  async getBrightness(): Promise<CharacteristicValue> {
    return this.states?.Brightness || 0;
  }

  setState = (newValues: States) => {
    const firstValue = newValues[Object.keys(newValues)[0]];
    const newStates: States = {};
    if (firstValue === 0) {
      newStates.On = false;
    } else {
      newStates.On = true;
    }
    this.service?.updateCharacteristic(
      this.platform.Characteristic.On,
      newStates.On
    );
    if (this.identifier.includes("type=Dimmer")) {
      newStates.Brightness = firstValue;
      this.service?.updateCharacteristic(
        this.platform.Characteristic.Brightness,
        newStates.Brightness
      );
    }
    this.states = newStates;
  };
}
