 
/* eslint-disable indent */
import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { AccessoryBase } from "./accessoryBase.js";
import { BlindsTilt, States } from "./loxone/types.js";
import { LoxoneControlPlatform } from "./platform.js";
import { getTiltPositionFromTransforms } from "./loxone/utils/getTiltPositionFromTransforms.js";

export class PlatformWindowCoveringAccessory extends AccessoryBase {
  private slatService: Service | undefined;
  private tiltedSwitchService: Service | undefined;
  private openedSwitchService: Service | undefined;

  public tilted = false;
  public opened = false;

  constructor(
    public readonly platform: LoxoneControlPlatform,
    public readonly accessory: PlatformAccessory,
    public readonly identifier: string,
  ) {
    super(platform, accessory, identifier);
    // set accessory information
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        "Homebrdige Loxone Puppeteer by @rvetere",
      )
      .setCharacteristic(this.platform.Characteristic.Model, "Loxone Blinds")
      .setCharacteristic(this.platform.Characteristic.SerialNumber, "🤖");

    this.service =
      this.accessory.getService(this.platform.Service.WindowCovering) ||
      this.accessory.addService(this.platform.Service.WindowCovering);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.name,
    );

    // create handlers for required characteristics
    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(this.getPosition.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(this.getPositionState.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onGet(this.getTargetPosition.bind(this))
      .onSet(this.setTargetPosition.bind(this));

    const isAwning =
      this.accessory.context.device.blindsTiming?.includes("awning");
    if (!isAwning) {
      // Add an additional service for "Slats" characteristics
      const { device } = accessory.context;
      this.slatService =
        this.accessory.getService(`${device.name} Slats`) ||
        this.accessory.addService(
          this.platform.Service.Slats,
          `${device.name} Slats`,
          `${device.room}-${device.name}-${device.type}-slats`,
        );
      this.slatService
        .getCharacteristic(this.platform.Characteristic.CurrentSlatState)
        .onGet(this.getCurrentSlatState.bind(this));

      this.slatService
        .getCharacteristic(this.platform.Characteristic.SlatType)
        .onGet(this.getSlatType.bind(this));

      this.slatService
        .getCharacteristic(this.platform.Characteristic.CurrentTiltAngle)
        .onGet(this.getCurrentTiltAngle.bind(this));

      // Add an additional service buttons for "finalTiltPosition"
      this.tiltedSwitchService =
        this.accessory.getService(`${device.name} Tilted`) ||
        this.accessory.addService(
          this.platform.Service.Switch,
          `${device.name} Tilted`,
          `${device.room}-${device.name}-${device.type}-tilted`,
        );

      this.tiltedSwitchService
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setTiltedOn.bind(this))
        .onGet(this.getTiltedOn.bind(this));

      this.openedSwitchService =
        this.accessory.getService(`${device.name} Opened`) ||
        this.accessory.addService(
          this.platform.Service.Switch,
          `${device.name} Opened`,
          `${device.room}-${device.name}-${device.type}-opened`,
        );

      this.openedSwitchService
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setOpenedOn.bind(this))
        .onGet(this.getOpenedOn.bind(this));
    }

    this.resetTiltPositions = this.resetTiltPositions.bind(this);
    this.handleSetTargetPosition = this.handleSetTargetPosition.bind(this);
  }

  setTiltedOn(value: CharacteristicValue) {
    this.tilted = value as boolean;
  }

  getTiltedOn(): CharacteristicValue {
    return this.tilted;
  }

  setOpenedOn(value: CharacteristicValue) {
    this.opened = value as boolean;
  }

  getOpenedOn(): CharacteristicValue {
    return this.opened;
  }

  getCurrentSlatState() {
    return this.platform.Characteristic.CurrentSlatState.FIXED;
  }

  getSlatType() {
    return this.platform.Characteristic.SlatType.HORIZONTAL;
  }

  getCurrentTiltAngle() {
    switch (this.states.TiltPosition) {
      default:
      case "closed":
        return 0;
      case "tilted":
        return 45;
      case "open":
        return 90;
    }
  }

  getPosition() {
    const position = this.states?.Position || 0;
    return position;
  }

  getPositionState() {
    const state =
      this.states?.PositionState ||
      this.platform.Characteristic.PositionState.STOPPED;

    return state;
  }

  getTargetPosition() {
    const targetPosition = this.states?.TargetPosition || 0;
    return targetPosition;
  }

  async setTargetPosition(value: CharacteristicValue) {
    setTimeout(
      (() => {
        this.handleSetTargetPosition(value as number);
      }).bind(this),
      300,
    );
  }

  async handleSetTargetPosition(value: number) {
    const actualTilt = this.opened ? "open" : this.tilted ? "tilted" : "closed";
    const tilt = (value > 0 ? actualTilt : "closed") as BlindsTilt;

    // if the difference to the current position is not bigger than 6, just ignore the command
    // -> but only if the tilt is not changed
    if (
      Math.abs(value - this.states.Position) < 6 &&
      tilt === this.states.TiltPosition
    ) {
      this.platform.log.debug(
        `   🚨 Too close, skip! ${JSON.stringify({
          value,
          pos: this.states.Position,
          tilt,
          curr: this.states.TiltPosition,
        })}`,
      );
      return;
    }

    this.platform.blindsController.moveBlindsToPosition({
      platformAccessory: this,
      value,
    });
  }

  resetTiltPositions = () => {
    if (this.tilted) {
      this.tilted = false;
      this.tiltedSwitchService?.updateCharacteristic(
        this.platform.Characteristic.On,
        this.tilted,
      );
    }
    if (this.opened) {
      this.opened = false;
      this.openedSwitchService?.updateCharacteristic(
        this.platform.Characteristic.On,
        this.opened,
      );
    }
  };

  setState = (givenValues: States) => {
    const newValues = Array.isArray(givenValues) ? givenValues : [givenValues];
    const newStates: States = {
      ...this.states,
      PositionState: this.platform.Characteristic.PositionState.STOPPED,
      TiltPosition: "closed",
    };

    const newValue = Array.isArray(newValues) ? newValues[0] : newValues;

    const thirstValue = newValue[Object.keys(newValue)[0]];
    const secondValue = newValue[Object.keys(newValue)[1]];
    const isMoving =
      newValue.isMoving || thirstValue === 1 || secondValue === 1;
    const movingDirection = !isMoving
      ? null
      : thirstValue === 1
      ? "up"
      : secondValue === 1
      ? "down"
      : null;

    let Position = 0;
    if (newValue && newValue.stateText) {
      Position = newValue.positionState
        ? Math.round(newValue.positionState * 100)
        : 0;

      newStates.TiltPosition = getTiltPositionFromTransforms(
        newValue.transformations,
      );

      if (!isNaN(Position)) {
        newStates.Position = Position;
      }
    } else {
      const thirdValue = newValue[Object.keys(newValue)[2]];
      Position = Math.round(thirdValue * 100);
      if (!isNaN(Position)) {
        newStates.Position = Position;
        newStates.TargetPosition = Position;
      }
    }

    newStates.PositionState = isMoving
      ? movingDirection === "up"
        ? this.platform.Characteristic.PositionState.DECREASING
        : this.platform.Characteristic.PositionState.INCREASING
      : this.platform.Characteristic.PositionState.STOPPED;

    if (newStates.PositionState === 2) {
      newStates.TargetPosition = Position;
    }

    let anyStateChanged = false;
    if (this.states.PositionState !== newStates.PositionState) {
      anyStateChanged = true;
      this.service?.updateCharacteristic(
        this.platform.Characteristic.PositionState,
        newStates.PositionState,
      );
    }

    if (this.states.Position !== newStates.Position) {
      anyStateChanged = true;
      this.service?.updateCharacteristic(
        this.platform.Characteristic.CurrentPosition,
        newStates.Position,
      );
    }

    if (this.states.TargetPosition !== newStates.TargetPosition) {
      anyStateChanged = true;
      this.service?.updateCharacteristic(
        this.platform.Characteristic.TargetPosition,
        newStates.TargetPosition,
      );
    }
    if (anyStateChanged) {
      const { name } = this.accessory.context.device;
      this.platform.log.debug(
        `ℹ️ State change for "${name}": ${JSON.stringify({
          PositionState:
            newStates.PositionState === 2
              ? "stopped"
              : newStates.PositionState === 0
              ? "decreasing"
              : "increasing",
          Position: newStates.Position,
          TiltPosition: newStates.TiltPosition,
          TargetPosition: newStates.TargetPosition,
        })}`,
      );
    }
    this.states = newStates;
  };
}
