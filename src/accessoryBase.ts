import { PlatformAccessory, Service } from "homebridge";
import { LoxoneControlPlatform } from "./platform.js";
import { States } from "./loxone/types.js";

export class AccessoryBase {
  public service: Service | undefined;
  public states: States = {};

  constructor(
    public readonly platform: LoxoneControlPlatform,
    public readonly accessory: PlatformAccessory,
    public readonly identifier: string,
  ) {
    this.setupAccessoryInformation();
  }

  protected get modelName(): string {
    return "Loxone Device";
  }

  private setupAccessoryInformation() {
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        "Homebridge Loxone Puppeteer by @rvetere",
      )
      .setCharacteristic(this.platform.Characteristic.Model, this.modelName)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, "\uD83E\uDD16");
  }

  /**
   * Get initials from the device name (e.g. "Kitchen Blinds" → "KB").
   */
  protected get namePrefix(): string {
    const name = this.accessory.context.device?.name || "";
    return name.split(/\s+/).map((w: string) => w[0]?.toUpperCase() || "").join("");
  }

  /**
   * Set both Name and ConfiguredName on a service.
   * HomeKit uses ConfiguredName for display after pairing.
   */
  protected setServiceName(service: Service, name: string) {
    service.setCharacteristic(this.platform.Characteristic.Name, name);
    service.setCharacteristic(this.platform.Characteristic.ConfiguredName, name);
  }

  toggleState = async () => {
    this.platform.logger.error(
      `toggleState not implemented! (${this.identifier})`,
    );
  };

  setStateOn = async () => {
    this.platform.logger.error(
      `setStateOn not implemented! (${this.identifier})`,
    );
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setState = (newStates: States, stateText?: string) => {
    this.states = newStates;
  };
}
