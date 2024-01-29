import { PlatformAccessory, Service } from "homebridge";
import { LoxoneControlPlatform } from "./platform";
import { States } from "./loxone/types";

export class AccessoryBase {
  public service: Service | undefined;
  public states: States = {};

  constructor(
    public readonly platform: LoxoneControlPlatform,
    public readonly accessory: PlatformAccessory,
    public readonly identifier: string
  ) {}

  toggleState = async () => {
    this.platform.log.error(
      `toggleState not implemented! (${this.identifier})`
    );
  };

  setStateOn = async () => {
    this.platform.log.error(`setStateOn not implemented! (${this.identifier})`);
  };

  setState = (newStates: States) => {
    this.states = newStates;
  };
}
