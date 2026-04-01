import { CharacteristicValue, PlatformAccessory } from "homebridge";
import { AccessoryBase } from "./accessoryBase.js";
import { sendCommandSafe } from "./loxone/utils/sendCommand.js";
import { LoxoneControlPlatform } from "./platform.js";
import { States } from "./loxone/types.js";

export class PlatformLightAccessory extends AccessoryBase {
  private powerOnCooldownActive = false;
  private powerOnCooldownTimer: ReturnType<typeof setTimeout> | null = null;

  protected override get modelName() {
    return "Loxone Light";
  }

  constructor(
    public readonly platform: LoxoneControlPlatform,
    public readonly accessory: PlatformAccessory,
    public readonly identifier: string,
  ) {
    super(platform, accessory, identifier);

    this.service =
      this.accessory.getService(this.platform.Service.Lightbulb) ||
      this.accessory.addService(this.platform.Service.Lightbulb);

    this.setServiceName(this.service, accessory.context.device.name);

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

    if (value && this.powerOnCooldownActive) {
      this.platform.logger.info(
        `💡 Ignoring turn-on for "${name}" — power-on cooldown active`,
      );
      setTimeout(() => {
        this.service?.updateCharacteristic(
          this.platform.Characteristic.On,
          false,
        );
      }, 100);
      return;
    }

    this.platform.logger.info(
      `💡 Control light switch "${name}" from ${
        this.states.On ? "On" : "Off"
      } to ${value ? "On" : "Off"}`,
    );
    await sendCommandSafe(this.platform, this.identifier, [
      value ? "on" : "off",
    ]);

    if (!value) {
      this.startPowerOnCooldown();
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

    if (this.powerOnCooldownActive) {
      this.platform.logger.info(
        `💡 Ignoring brightness change for "${name}" — power-on cooldown active`,
      );
      setTimeout(() => {
        this.service?.updateCharacteristic(
          this.platform.Characteristic.Brightness,
          this.states?.Brightness || 0,
        );
        this.service?.updateCharacteristic(
          this.platform.Characteristic.On,
          false,
        );
      }, 100);
      return;
    }
    this.platform.logger.info(
      `💡 Control brightness "${name}" from ${this.states.Brightness}% to ${value}%`,
    );
    await sendCommandSafe(this.platform, this.identifier, [
      `${value}`,
      "override",
    ]);
  }

  async getBrightness(): Promise<CharacteristicValue> {
    return this.states?.Brightness || 0;
  }

  private startPowerOnCooldown() {
    const cooldownSeconds = this.accessory.context.device.powerOnCooldown;
    if (!cooldownSeconds || cooldownSeconds <= 0) {
      return;
    }

    const { name } = this.accessory.context.device;

    if (this.powerOnCooldownTimer) {
      clearTimeout(this.powerOnCooldownTimer);
    }

    this.powerOnCooldownActive = true;
    this.platform.logger.info(
      `💡 "${name}" power-on cooldown started (${cooldownSeconds}s)`,
    );

    this.powerOnCooldownTimer = setTimeout(() => {
      this.powerOnCooldownActive = false;
      this.powerOnCooldownTimer = null;
      this.platform.logger.info(
        `💡 "${name}" power-on cooldown ended`,
      );
    }, cooldownSeconds * 1000);
  }

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

    if (newStates.On && this.powerOnCooldownActive) {
      const { name } = this.accessory.context.device;
      this.platform.logger.info(
        `💡 Ignoring external turn-on for "${name}" — power-on cooldown active`,
      );
      this.service?.updateCharacteristic(
        this.platform.Characteristic.On,
        false,
      );
      return;
    }

    this.service?.updateCharacteristic(
      this.platform.Characteristic.On,
      newStates.On,
    );
    if (this.identifier.includes("type=Dimmer")) {
      newStates.Brightness = firstValue;
      this.service?.updateCharacteristic(
        this.platform.Characteristic.Brightness,
        newStates.Brightness,
      );
    }
    this.states = newStates;
  };
}
