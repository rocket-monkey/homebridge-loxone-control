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

  setState = (newStates: States) => {
    this.states = newStates;
  };
}
