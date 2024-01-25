import { CharacteristicValue, PlatformAccessory } from "homebridge";
import { AccessoryBase } from "./accessoryBase";
import { LoxoneControlPlatform } from "./platform";
import { States } from "./loxone/types";

export class PlatformTemperatureAccessory extends AccessoryBase {
  constructor(
    public readonly platform: LoxoneControlPlatform,
    public readonly accessory: PlatformAccessory,
    public readonly identifier: string
  ) {
    super(platform, accessory, identifier);
    // set accessory information
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        "Homebrdige Loxone Puppeteer by @rvetere"
      )
      .setCharacteristic(this.platform.Characteristic.Model, "Loxone Light")
      .setCharacteristic(this.platform.Characteristic.SerialNumber, "🤖");

    this.service =
      this.accessory.getService(this.platform.Service.TemperatureSensor) ||
      this.accessory.addService(this.platform.Service.TemperatureSensor);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.name
    );

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Lightbulb

    // register handlers for the On/Off Characteristic
    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getTemperature.bind(this)); // GET - bind to the `getOn` method below
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   *
   * GET requests should return as fast as possbile. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   *
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.

   * @example
   * this.service.updateCharacteristic(this.platform.Characteristic.On, true)
   */
  async getTemperature(): Promise<CharacteristicValue> {
    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    return this.states?.Temperature || 0;
  }

  setState = (newValues: States) => {
    const firstValue = newValues[Object.keys(newValues)[0]];
    // this.platform.log.debug(`🥶 setState: ${JSON.stringify({ firstValue })}`);
    const newStates: States = {
      Temperature: firstValue,
    };
    this.states = newStates;
    this.service?.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      this.states?.Temperature
    );
  };
}
