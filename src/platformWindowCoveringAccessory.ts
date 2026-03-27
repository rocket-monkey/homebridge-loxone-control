/* eslint-disable indent */
import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { AccessoryBase } from "./accessoryBase.js";
import { BlindsTilt, States } from "./loxone/types.js";
import { LoxoneControlPlatform } from "./platform.js";
import { getTiltPositionFromTransforms } from "./loxone/utils/getTiltPositionFromTransforms.js";
import { sendCommand } from "./loxone/utils/sendCommand.js";

export class PlatformWindowCoveringAccessory extends AccessoryBase {
  private slatService: Service | undefined;
  private tiltedSwitchService: Service | undefined;
  private openedSwitchService: Service | undefined;
  private shadeSwitchService: Service | undefined;
  private fullyInSwitchService: Service | undefined;
  private fullyOutSwitchService: Service | undefined;
  public autoSunSwitchService: Service | undefined;

  public tilted = false;
  public opened = false;
  public autoSunPosition = false;
  public lastAutoSunCommand = 0; // Timestamp of last command to prevent flickering

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

    const { device } = accessory.context;
    const isAwning = device.blindsTiming?.includes("awning");
    if (!isAwning) {
      // Add an additional service for "Slats" characteristics
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

    // Shade and Auto Sun Position are available for ALL window coverings (including awnings)
    // Add an additional service button for "Shade" - stateless command
    this.shadeSwitchService =
      this.accessory.getService(`${device.name} Shade`) ||
      this.accessory.addService(
        this.platform.Service.Switch,
        `${device.name} Shade`,
        `${device.room}-${device.name}-${device.type}-shade`,
      );

    this.shadeSwitchService
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setShadeOn.bind(this))
      .onGet(this.getShadeOn.bind(this));

    // Add an additional service button for "Auto Sun Position" - toggles automation
    this.autoSunSwitchService =
      this.accessory.getService(`${device.name} Auto Sun Position`) ||
      this.accessory.addService(
        this.platform.Service.Switch,
        `${device.name} Auto Sun Position`,
        `${device.room}-${device.name}-${device.type}-autosun`,
      );

    this.autoSunSwitchService
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setAutoSunOn.bind(this))
      .onGet(this.getAutoSunOn.bind(this));

    // Awnings get "Fully In" and "Fully Out" buttons (retract/extend)
    if (isAwning) {
      this.fullyInSwitchService =
        this.accessory.getService(`${device.name} Fully In`) ||
        this.accessory.addService(
          this.platform.Service.Switch,
          `${device.name} Fully In`,
          `${device.room}-${device.name}-${device.type}-fullyin`,
        );

      this.fullyInSwitchService
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setFullyInOn.bind(this))
        .onGet(() => false);

      this.fullyOutSwitchService =
        this.accessory.getService(`${device.name} Fully Out`) ||
        this.accessory.addService(
          this.platform.Service.Switch,
          `${device.name} Fully Out`,
          `${device.room}-${device.name}-${device.type}-fullyout`,
        );

      this.fullyOutSwitchService
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setFullyOutOn.bind(this))
        .onGet(() => false);
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

  async setShadeOn(value: CharacteristicValue) {
    if (value) {
      // Send shade command immediately when turned on
      const { name } = this.accessory.context.device;
      this.platform.logger.info(`🌤️ ${name}: Sending shade command`);
      await sendCommand(this.platform, this.identifier, ["shade"]);
      
      // Immediately turn the switch back off since this is a momentary action
      setTimeout(() => {
        this.shadeSwitchService?.updateCharacteristic(
          this.platform.Characteristic.On,
          false,
        );
      }, 100);
    }
  }

  getShadeOn(): CharacteristicValue {
    // Always return false since this is a momentary button
    return false;
  }

  async setFullyInOn(value: CharacteristicValue) {
    if (value) {
      const { name } = this.accessory.context.device;
      this.platform.logger.info(`⬆️ ${name}: Sending Fully In (retract) command`);
      await sendCommand(this.platform, this.identifier, ["FullUp"]);
      setTimeout(() => {
        this.fullyInSwitchService?.updateCharacteristic(
          this.platform.Characteristic.On,
          false,
        );
      }, 100);
    }
  }

  async setFullyOutOn(value: CharacteristicValue) {
    if (value) {
      const { name } = this.accessory.context.device;
      this.platform.logger.info(`⬇️ ${name}: Sending Fully Out (extend) command`);
      await sendCommand(this.platform, this.identifier, ["FullDown"]);
      setTimeout(() => {
        this.fullyOutSwitchService?.updateCharacteristic(
          this.platform.Characteristic.On,
          false,
        );
      }, 100);
    }
  }

  async setAutoSunOn(value: CharacteristicValue) {
    const { name } = this.accessory.context.device;
    this.platform.logger.info(
      `☀️ ${name}: Auto Sun Position ${value ? "ON" : "OFF"} - SETTER CALLED!`,
    );

    // Immediately update local state to prevent flickering
    this.autoSunPosition = value as boolean;
    // Only set cooldown for individual user commands, not central automation commands
    this.lastAutoSunCommand = Date.now();

    if (value) {
      // Turning ON: send auto command to enable sun position automation
      this.platform.logger.info(`☀️ ${name}: Sending auto command to enable sun position automation`);
      await sendCommand(this.platform, this.identifier, ["auto"]);
    } else {
      // Turning OFF: send NoAuto command to disable sun position automation
      this.platform.logger.info(`☀️ ${name}: Sending NoAuto command to disable sun position automation`);
      await sendCommand(this.platform, this.identifier, ["NoAuto"]);
    }
  }

  getAutoSunOn(): CharacteristicValue {
    return this.autoSunPosition;
  }

  // Reset cooldown to allow immediate state updates (used when central automation changes all blinds)
  resetAutoSunCooldown() {
    this.lastAutoSunCommand = 0;
  }

  getCurrentSlatState() {
    return this.states.TiltPosition === "closed"
      ? this.platform.Characteristic.CurrentSlatState.FIXED
      : this.platform.Characteristic.CurrentSlatState.SWINGING;
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
      this.platform.logger.debug(
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

    // Update slat tilt angle and state when tilt position changes
    if (this.slatService && this.states.TiltPosition !== newStates.TiltPosition) {
      anyStateChanged = true;
      const tiltAngle = newStates.TiltPosition === "tilted" ? 45
        : newStates.TiltPosition === "open" ? 90 : 0;
      const slatState = newStates.TiltPosition === "closed"
        ? this.platform.Characteristic.CurrentSlatState.FIXED
        : this.platform.Characteristic.CurrentSlatState.SWINGING;

      this.slatService.updateCharacteristic(
        this.platform.Characteristic.CurrentTiltAngle,
        tiltAngle,
      );
      this.slatService.updateCharacteristic(
        this.platform.Characteristic.CurrentSlatState,
        slatState,
      );
    }

    if (anyStateChanged) {
      const { name } = this.accessory.context.device;
      this.platform.logger.debug(
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
    
    // Update Auto Sun Position state based on automation text messages
    const checkAutomationState = (stateObj: Record<string, unknown>): { hasAutomationText: boolean; isActive: boolean } => {
      // Look for text properties that contain automation status
      for (const value of Object.values(stateObj)) {
        if (typeof value === "object" && value !== null && "text" in value) {
          const text = (value as { text: string }).text;
          if (text && text.includes("Automatik Beschattung")) {
            // Check if automation is active (contains "aktiv") or deactivated ("deaktiviert")
            const isActive = text.includes("aktiv") && !text.includes("deaktiviert");
            this.platform.logger.debug(
              `☀️ ${this.accessory.context.device.name}: Automation text: "${text}", interpreted as: ${isActive ? "ACTIVE" : "INACTIVE"}`,
            );
            return { hasAutomationText: true, isActive };
          }
        }
      }
      return { hasAutomationText: false, isActive: false };
    };

    // Don't update from WebSocket for 1 second after user command to prevent flickering
    // Only apply this cooldown if this specific blind had a recent user command
    const timeSinceLastCommand = Date.now() - this.lastAutoSunCommand;
    if (this.lastAutoSunCommand > 0 && timeSinceLastCommand < 1000) {
      this.platform.logger.debug(
        `☀️ ${this.accessory.context.device.name}: Ignoring automation state update for ${1000 - timeSinceLastCommand}ms after user command`,
      );
      return;
    }

    if (Array.isArray(givenValues)) {
      // For arrays (multiple blind states), check the first one
      const firstState = givenValues[0];
      const automationResult = checkAutomationState(firstState);
      
      // Only update if we found automation text, otherwise preserve current state
      if (automationResult.hasAutomationText && this.autoSunPosition !== automationResult.isActive) {
        this.autoSunPosition = automationResult.isActive;
        this.autoSunSwitchService?.updateCharacteristic(
          this.platform.Characteristic.On,
          this.autoSunPosition,
        );
        this.platform.logger.info(
          `☀️ ${this.accessory.context.device.name}: Auto Sun Position updated to ${this.autoSunPosition ? "ON" : "OFF"}`,
        );
      } else if (!automationResult.hasAutomationText) {
        this.platform.logger.debug(
          `☀️ ${this.accessory.context.device.name}: No automation text found, preserving current state: ${this.autoSunPosition ? "ON" : "OFF"}`,
        );
      }
    } else if (typeof givenValues === "object" && givenValues !== null) {
      // For single object states
      const automationResult = checkAutomationState(givenValues);
      
      // Only update if we found automation text, otherwise preserve current state
      if (automationResult.hasAutomationText && this.autoSunPosition !== automationResult.isActive) {
        this.autoSunPosition = automationResult.isActive;
        this.autoSunSwitchService?.updateCharacteristic(
          this.platform.Characteristic.On,
          this.autoSunPosition,
        );
        this.platform.logger.info(
          `☀️ ${this.accessory.context.device.name}: Auto Sun Position updated to ${this.autoSunPosition ? "ON" : "OFF"}`,
        );
      } else if (!automationResult.hasAutomationText) {
        this.platform.logger.debug(
          `☀️ ${this.accessory.context.device.name}: No automation text found, preserving current state: ${this.autoSunPosition ? "ON" : "OFF"}`,
        );
      }
    }
  };
}
