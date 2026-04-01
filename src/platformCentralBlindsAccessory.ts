import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { AccessoryBase } from "./accessoryBase.js";
import { LoxoneControlPlatform } from "./platform.js";
import { sendCommandSafe } from "./loxone/utils/sendCommand.js";
import { States } from "./loxone/types.js";

export class PlatformCentralBlindsAccessory extends AccessoryBase {
  protected override get modelName() {
    return "Loxone Central Blinds";
  }

  private allUpService: Service;
  private allDownService: Service;

  constructor(
    public readonly platform: LoxoneControlPlatform,
    public readonly accessory: PlatformAccessory,
    public readonly identifier: string,
  ) {
    super(platform, accessory, identifier);

    const { device } = accessory.context;

    // "All Up" momentary button
    this.allUpService =
      this.accessory.getService(`${device.name} All Up`) ||
      this.accessory.addService(
        this.platform.Service.Switch,
        `${device.name} All Up`,
        `${device.name}-all-up`,
      );
    this.setServiceName(this.allUpService, "All Up");

    this.allUpService
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setAllUp.bind(this))
      .onGet(() => false);

    // "All Down" momentary button
    this.allDownService =
      this.accessory.getService(`${device.name} All Down`) ||
      this.accessory.addService(
        this.platform.Service.Switch,
        `${device.name} All Down`,
        `${device.name}-all-down`,
      );
    this.setServiceName(this.allDownService, "All Down");

    this.allDownService
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setAllDown.bind(this))
      .onGet(() => false);
  }

  async setAllUp(value: CharacteristicValue) {
    if (value) {
      const { name } = this.accessory.context.device;
      this.platform.logger.info(`⬆️ ${name}: Sending All Up command`);
      await sendCommandSafe(this.platform, this.identifier, ["FullUp"]);
      setTimeout(() => {
        this.allUpService.updateCharacteristic(
          this.platform.Characteristic.On,
          false,
        );
      }, 100);
    }
  }

  async setAllDown(value: CharacteristicValue) {
    if (value) {
      const { name } = this.accessory.context.device;
      this.platform.logger.info(`⬇️ ${name}: Sending All Down command`);
      await sendCommandSafe(this.platform, this.identifier, ["FullDown"]);
      setTimeout(() => {
        this.allDownService.updateCharacteristic(
          this.platform.Characteristic.On,
          false,
        );
      }, 100);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setState = (_newStates: States) => {
    // Central blinds don't have meaningful state to track
  };
}
