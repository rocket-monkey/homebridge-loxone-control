/* eslint-disable indent */
import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { AccessoryBase } from "./accessoryBase.js";
import { sendCommand } from "./loxone/utils/sendCommand.js";
import { LoxoneControlPlatform } from "./platform.js";
import { splitTail } from "./loxone/utils/split.js";
import { States } from "./loxone/types.js";

export class PlatformFanAccessory extends AccessoryBase {
  private fanLevels: Array<{ index: number; loxoneLevelName: string }> = [];
  private additionalServices: Service[] = [];

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
      .setCharacteristic(this.platform.Characteristic.Model, "Loxone Fan")
      .setCharacteristic(this.platform.Characteristic.SerialNumber, "🤖");

    this.parseConfigFanLevels();

    this.service =
      this.accessory.getService(this.platform.Service.Fanv2) ||
      this.accessory.addService(this.platform.Service.Fanv2);

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.name
    );

    this.service
      .getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    const { name, fanBathroom, fanAddButtons } = this.accessory.context.device;
    if (!fanBathroom && fanAddButtons) {
      const buttons = fanAddButtons.split(",");
      buttons.forEach((indexStr: string) => {
        const levelIndex = parseInt(indexStr, 10);
        const levelToSet = this.fanLevels[levelIndex];

        const buttonSwitchService =
          this.accessory.getService(`${name} ${levelToSet.loxoneLevelName}`) ||
          this.accessory.addService(
            this.platform.Service.Switch,
            `${name} ${levelToSet.loxoneLevelName}`,
            `${name}-${levelToSet.index}`
          );

        buttonSwitchService
          .getCharacteristic(this.platform.Characteristic.On)
          .onSet(this.setLevel(levelToSet).bind(this))
          .onGet(this.getLevel(levelToSet).bind(this));

        this.additionalServices.push(buttonSwitchService);
      });
    }
    this.parseConfigFanLevels = this.parseConfigFanLevels.bind(this);
  }

  setLevel =
    (level: { index: number; loxoneLevelName: string }) =>
    async (value: CharacteristicValue) => {
      // when we turn this button off, just set it back to "fanOnSet" value
      const levelToSet = value ? level.index : 1;
      const { name } = this.accessory.context.device;
      this.platform.log.info(
        `💨 Control fan level "${name}" to "${levelToSet}"`
      );
      const jsError = await sendCommand(this.platform, this.identifier, [
        levelToSet,
      ]);
      if (jsError) {
        this.platform.log.error(`Error in sendCommand: ${jsError as string}`);
      }
    };

  getLevel =
    (level: { index: number; loxoneLevelName: string }) =>
    async (): Promise<CharacteristicValue> => {
      return this.states?.FanLevelIndex === level.index;
    };

  async setOn(value: CharacteristicValue) {
    if (this.states?.On === value) {
      return;
    }

    const { fanBathroom } = this.accessory.context.device;
    const { name } = this.accessory.context.device;
    this.platform.log.info(
      `💨 Control fan "${name}" from ${this.states.On ? "On" : "Off"} to ${
        value ? "On" : "Off"
      }`
    );

    const command = fanBathroom
      ? value
        ? "on"
        : "off"
      : value
      ? "1"
      : "reset";
    const jsError = await sendCommand(this.platform, this.identifier, [
      command,
    ]);
    if (jsError) {
      this.platform.log.error(`Error in sendCommand: ${jsError as string}`);
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    return this.states?.On || false;
  }

  setState = (givenValues: States) => {
    const newValues = Array.isArray(givenValues) ? givenValues : [givenValues];
    const newValue = newValues[0];
    const newIndex = newValue[Object.keys(newValue)[0]];
    const newFanLevel = this.fanLevels[newIndex];
    const newStates: States = {
      On: newFanLevel.index > 0,
      FanLevelIndex: newFanLevel.index,
    };

    this.additionalServices.forEach((service) => {
      const levelIndexStr = splitTail(service.subtype, "-");
      const levelIndex = this.fanLevels.findIndex(
        (l) => l.index === parseInt(levelIndexStr, 10)
      );
      service.updateCharacteristic(
        this.platform.Characteristic.On,
        levelIndex === newFanLevel.index
      );
    });

    this.states = newStates;
    this.service?.updateCharacteristic(
      this.platform.Characteristic.Active,
      this.states?.On
    );
  };

  parseConfigFanLevels() {
    const { fanLevels } = this.platform.config;
    const levels = (
      fanLevels ||
      "0:Aus;1:Stufe 1;2:Stufe 2;3:Stufe 3;4:Stufe 4;5:Hyper Speed;6:Nacht;7:Freecolling"
    ).split(";");
    const newFanLevels = levels.map((level: string) => {
      const [index, loxoneLevelName] = level.split(":");
      return {
        index: parseInt(index, 10),
        loxoneLevelName,
      };
    });
    this.fanLevels = newFanLevels;
  }
}
