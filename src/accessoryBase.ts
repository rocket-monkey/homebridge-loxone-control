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
  ) {}

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

  setState = (newStates: States) => {
    this.states = newStates;
  };
}
