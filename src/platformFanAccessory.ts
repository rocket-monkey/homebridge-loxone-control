/* eslint-disable indent */
import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { AccessoryBase } from "./accessoryBase.js";
import { sendCommandSafe } from "./loxone/utils/sendCommand.js";
import { LoxoneControlPlatform } from "./platform.js";
import { splitTail } from "./loxone/utils/split.js";
import { States } from "./loxone/types.js";

export class PlatformFanAccessory extends AccessoryBase {
  protected override get modelName() {
    return "Loxone Fan";
  }

  private fanLevels: Array<{ index: number; loxoneLevelName: string }> = [];
  private additionalServices: Service[] = [];

  constructor(
    public readonly platform: LoxoneControlPlatform,
    public readonly accessory: PlatformAccessory,
    public readonly identifier: string,
  ) {
    super(platform, accessory, identifier);

    this.parseConfigFanLevels();

    this.service =
      this.accessory.getService(this.platform.Service.Fanv2) ||
      this.accessory.addService(this.platform.Service.Fanv2);

    this.setServiceName(this.service, accessory.context.device.name);

    this.service
      .getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    const { name, fanBathroom, fanAddButtons } = this.accessory.context.device;

    // Add RotationSpeed for non-bathroom fans (maps fan levels to percentage)
    if (!fanBathroom) {
      this.service
        .getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onSet(this.setRotationSpeed.bind(this))
        .onGet(this.getRotationSpeed.bind(this));
    }

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
            `${name}-${levelToSet.index}`,
          );
        this.setServiceName(buttonSwitchService, levelToSet.loxoneLevelName);

        buttonSwitchService
          .getCharacteristic(this.platform.Characteristic.On)
          .onSet(this.setLevel(levelToSet).bind(this))
          .onGet(this.getLevel(levelToSet).bind(this));

        this.additionalServices.push(buttonSwitchService);
      });
    }
    this.parseConfigFanLevels = this.parseConfigFanLevels.bind(this);
  }

  // --- RotationSpeed: map fan levels to percentage ---

  private levelToPercent(levelIndex: number): number {
    const maxLevel = this.fanLevels.length - 1;
    if (maxLevel <= 0) {
      return 0;
    }
    return Math.round((levelIndex / maxLevel) * 100);
  }

  private percentToLevel(percent: number): number {
    const maxLevel = this.fanLevels.length - 1;
    if (maxLevel <= 0) {
      return 0;
    }
    return Math.round((percent / 100) * maxLevel);
  }

  async setRotationSpeed(value: CharacteristicValue) {
    const percent = value as number;
    const levelIndex = this.percentToLevel(percent);
    const fanLevel = this.fanLevels[levelIndex];
    if (!fanLevel) {
      return;
    }

    const { name } = this.accessory.context.device;
    this.platform.logger.info(
      `💨 Control fan speed "${name}" to level ${fanLevel.index} (${fanLevel.loxoneLevelName}, ${percent}%)`,
    );
    await sendCommandSafe(this.platform, this.identifier, [
      fanLevel.index === 0 ? "reset" : fanLevel.index,
    ]);
  }

  getRotationSpeed(): CharacteristicValue {
    const levelIndex = this.states?.FanLevelIndex ?? 0;
    return this.levelToPercent(levelIndex);
  }

  // --- Level buttons ---

  setLevel =
    (level: { index: number; loxoneLevelName: string }) =>
    async (value: CharacteristicValue) => {
      const levelToSet = value ? level.index : 1;
      const { name } = this.accessory.context.device;
      this.platform.logger.info(
        `💨 Control fan level "${name}" to "${levelToSet}"`,
      );
      await sendCommandSafe(this.platform, this.identifier, [
        levelToSet,
      ]);
    };

  getLevel =
    (level: { index: number; loxoneLevelName: string }) =>
    async (): Promise<CharacteristicValue> => {
      return this.states?.FanLevelIndex === level.index;
    };

  // --- On/Off ---

  async setOn(value: CharacteristicValue) {
    if (this.states?.On === value) {
      return;
    }

    const { fanBathroom, name } = this.accessory.context.device;
    this.platform.logger.info(
      `💨 Control fan "${name}" from ${this.states.On ? "On" : "Off"} to ${
        value ? "On" : "Off"
      }`,
    );

    const command = fanBathroom
      ? value
        ? "on"
        : "off"
      : value
      ? "1"
      : "reset";
    await sendCommandSafe(this.platform, this.identifier, [
      command,
    ]);
  }

  async getOn(): Promise<CharacteristicValue> {
    return this.states?.On || false;
  }

  // --- State updates from Loxone ---

  setState = (givenValues: States) => {
    const newValues = Array.isArray(givenValues) ? givenValues : [givenValues];
    const newValue = newValues[0];
    if (!newValue) {
      return;
    }
    const keys = Object.keys(newValue);
    if (keys.length === 0) {
      return;
    }
    const newIndex = newValue[keys[0]];
    const newFanLevel = this.fanLevels[newIndex];
    if (!newFanLevel) {
      return;
    }
    const newStates: States = {
      On: newFanLevel.index > 0,
      FanLevelIndex: newFanLevel.index,
    };

    this.additionalServices.forEach((service) => {
      const levelIndexStr = splitTail(service.subtype, "-");
      const levelIndex = this.fanLevels.findIndex(
        (l) => l.index === parseInt(levelIndexStr, 10),
      );
      service.updateCharacteristic(
        this.platform.Characteristic.On,
        levelIndex === newFanLevel.index,
      );
    });

    this.states = newStates;
    this.service?.updateCharacteristic(
      this.platform.Characteristic.Active,
      this.states?.On,
    );

    // Update RotationSpeed to reflect the current level
    this.service?.updateCharacteristic(
      this.platform.Characteristic.RotationSpeed,
      this.levelToPercent(newFanLevel.index),
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
