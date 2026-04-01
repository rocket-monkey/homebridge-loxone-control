import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { AccessoryBase } from "./accessoryBase.js";
import { LoxoneControlPlatform } from "./platform.js";
import { sendCommandSafe } from "./loxone/utils/sendCommand.js";
import { sleep } from "./loxone/utils/sleep.js";
import { States } from "./loxone/types.js";

export class PlatformCentralBlindsAccessory extends AccessoryBase {
  protected override get modelName() {
    return "Loxone Central Blinds";
  }

  private switchServices: Service[] = [];

  constructor(
    public readonly platform: LoxoneControlPlatform,
    public readonly accessory: PlatformAccessory,
    public readonly identifier: string,
  ) {
    super(platform, accessory, identifier);

    const { device } = accessory.context;

    // Remove all non-AccessoryInformation services from previous versions
    const servicesToRemove = this.accessory.services.filter(
      (s) => s.UUID !== this.platform.Service.AccessoryInformation.UUID,
    );
    for (const s of servicesToRemove) {
      this.accessory.removeService(s);
    }

    const buttons: Array<{ name: string; subtype: string; emoji: string; command: string }> = [
      { name: `${device.name} Up`, subtype: `${device.name}-all-up`, emoji: "⬆️", command: "FullUp" },
      { name: `${device.name} Down`, subtype: `${device.name}-all-down`, emoji: "⬇️", command: "FullDown" },
      { name: `${device.name} Stop`, subtype: `${device.name}-stop`, emoji: "✋", command: "stop" },
      { name: `${device.name} Auto`, subtype: `${device.name}-auto`, emoji: "☀️", command: "auto" },
      { name: `${device.name} Shade`, subtype: `${device.name}-shade`, emoji: "🌤️", command: "shade" },
    ];

    buttons.forEach(({ name, subtype, emoji, command }, index) => {
      const svc = this.accessory.addService(
        this.platform.Service.Switch,
        name,
        subtype,
      );
      this.setServiceName(svc, name);

      svc.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => false)
        .onSet(async (value: CharacteristicValue) => {
          if (value) {
            this.platform.logger.info(`${emoji} ${device.name}: Sending ${command}`);
            await sendCommandSafe(this.platform, this.identifier, [command]);
            // Wait briefly then reset — same pattern as resetTiltPositions
            // which works in HomeKit even though Homebridge UI doesn't reflect it
            await sleep(1000);
            this.resetAllButtons();
          }
        });

      this.switchServices.push(svc);

      if (index === 0) {
        this.service = svc;
      }
    });
  }

  private resetAllButtons() {
    for (const svc of this.switchServices) {
      svc.updateCharacteristic(this.platform.Characteristic.On, false);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setState = (_newStates: States) => {
    this.resetAllButtons();
  };
}
