/* eslint-disable indent */
import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { AccessoryBase } from "./accessoryBase.js";
import { BlindsTilt, States } from "./loxone/types.js";
import { LoxoneControlPlatform } from "./platform.js";
import { AUTO_SUN_COOLDOWN } from "./settings.js";
import { getTiltPositionFromStateText } from "./loxone/utils/getTiltPositionFromTransforms.js";
import { sendCommandSafe } from "./loxone/utils/sendCommand.js";

// Map tilt positions to angles (-90 to 90 range for HomeKit)
const TILT_ANGLES: Record<BlindsTilt, number> = {
  "closed": -90,
  "tilted": 0,
  "open": 90,
};

export class PlatformWindowCoveringAccessory extends AccessoryBase {
  protected override get modelName() {
    return "Loxone Blinds";
  }

  private slatService: Service | undefined;
  private tiltedSwitchService: Service | undefined;
  private openedSwitchService: Service | undefined;
  private shadeSwitchService: Service | undefined;
  private fullyInSwitchService: Service | undefined;
  private fullyOutSwitchService: Service | undefined;
  public autoSunSwitchService: Service | undefined;

  public tilted = false;
  public opened = false;
  public desiredTilt: BlindsTilt | null = null; // Desired tilt angle, applied after movement completes
  public autoSunPosition = false;
  public lastAutoSunCommand = 0; // Timestamp of last command to prevent flickering
  public onPositionUpdate: ((position: number, isStopped: boolean) => void) | null = null;
  private targetPositionTimer: ReturnType<typeof setTimeout> | null = null;
  private tiltTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTargetValue: number | null = null;
  public movementStartTime = 0; // Timestamp when movement command was dispatched
  public tiltCooldownUntil = 0; // Ignore stateText tilt updates until this timestamp

  constructor(
    public readonly platform: LoxoneControlPlatform,
    public readonly accessory: PlatformAccessory,
    public readonly identifier: string,
  ) {
    super(platform, accessory, identifier);

    this.service =
      this.accessory.getService(this.platform.Service.WindowCovering) ||
      this.accessory.addService(this.platform.Service.WindowCovering);

    this.setServiceName(this.service, accessory.context.device.name);

    // Position characteristics
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
    const isAwning = device.blindsType === "awning" || device.blindsTiming?.includes("awning");
    if (!isAwning) {
      // Add tilt angle directly on the WindowCovering service (gives a slider in HomeKit)
      this.service
        .getCharacteristic(this.platform.Characteristic.CurrentHorizontalTiltAngle)
        .onGet(this.getCurrentTiltAngle.bind(this));

      this.service
        .getCharacteristic(this.platform.Characteristic.TargetHorizontalTiltAngle)
        .onGet(this.getCurrentTiltAngle.bind(this))
        .onSet(this.setTargetTiltAngle.bind(this));

      // Keep the Slats service for additional detail
      this.slatService =
        this.accessory.getService(`${device.name} Slats`) ||
        this.accessory.addService(
          this.platform.Service.Slats,
          `${device.name} Slats`,
          `${device.room}-${device.name}-${device.type}-slats`,
        );
      this.setServiceName(this.slatService, `${this.namePrefix} Slats`);
      this.slatService
        .getCharacteristic(this.platform.Characteristic.CurrentSlatState)
        .onGet(this.getCurrentSlatState.bind(this));

      this.slatService
        .getCharacteristic(this.platform.Characteristic.SlatType)
        .onGet(this.getSlatType.bind(this));

      this.slatService
        .getCharacteristic(this.platform.Characteristic.CurrentTiltAngle)
        .onGet(this.getCurrentSlatTiltAngle.bind(this));

      // Tilted/Opened switch buttons for tilt presets
      this.tiltedSwitchService =
        this.accessory.getService(`${device.name} Tilted`) ||
        this.accessory.addService(
          this.platform.Service.Switch,
          `${device.name} Tilted`,
          `${device.room}-${device.name}-${device.type}-tilted`,
        );
      this.setServiceName(this.tiltedSwitchService, `${this.namePrefix} Tilted`);

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
      this.setServiceName(this.openedSwitchService, `${this.namePrefix} Opened`);

      this.openedSwitchService
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setOpenedOn.bind(this))
        .onGet(this.getOpenedOn.bind(this));
    }

    // Shade and Auto Sun Position are available for ALL window coverings (including awnings)
    this.shadeSwitchService =
      this.accessory.getService(`${device.name} Shade`) ||
      this.accessory.addService(
        this.platform.Service.Switch,
        `${device.name} Shade`,
        `${device.room}-${device.name}-${device.type}-shade`,
      );
    this.setServiceName(this.shadeSwitchService, `${this.namePrefix} Shade`);

    this.shadeSwitchService
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setShadeOn.bind(this))
      .onGet(this.getShadeOn.bind(this));

    // Auto Sun Position - toggles automation
    this.autoSunSwitchService =
      this.accessory.getService(`${device.name} Auto Sun Position`) ||
      this.accessory.addService(
        this.platform.Service.Switch,
        `${device.name} Auto Sun Position`,
        `${device.room}-${device.name}-${device.type}-autosun`,
      );
    this.setServiceName(this.autoSunSwitchService, `${this.namePrefix} Auto Sun`);

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
      this.setServiceName(this.fullyInSwitchService, `${this.namePrefix} Fully In`);

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
      this.setServiceName(this.fullyOutSwitchService, `${this.namePrefix} Fully Out`);

      this.fullyOutSwitchService
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setFullyOutOn.bind(this))
        .onGet(() => false);
    }

    this.resetTiltPositions = this.resetTiltPositions.bind(this);
    this.handleSetTargetPosition = this.handleSetTargetPosition.bind(this);
  }

  // --- Tilt control ---

  private tiltPositionToAngle(tiltPosition: BlindsTilt): number {
    return TILT_ANGLES[tiltPosition] ?? TILT_ANGLES.closed;
  }

  getCurrentTiltAngle() {
    return this.tiltPositionToAngle(this.states.TiltPosition || "closed");
  }

  // Slats service uses 0-90 range
  getCurrentSlatTiltAngle() {
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

  async setTargetTiltAngle(value: CharacteristicValue) {
    const angle = value as number;
    const { name } = this.accessory.context.device;

    // Map angle ranges to tilt positions:
    // -90 to -30: closed, -30 to 30: tilted, 30 to 90: open
    let targetTilt: BlindsTilt;
    if (angle <= -30) {
      targetTilt = "closed";
    } else if (angle >= 30) {
      targetTilt = "open";
    } else {
      targetTilt = "tilted";
    }

    this.platform.logger.info(
      `🔄 ${name}: Desired tilt set to "${targetTilt}" (angle: ${angle})`,
    );

    // Store desired tilt and update switch states
    this.desiredTilt = targetTilt;
    this.tilted = targetTilt === "tilted";
    this.opened = targetTilt === "open";
    this.tiltedSwitchService?.updateCharacteristic(
      this.platform.Characteristic.On,
      this.tilted,
    );
    this.openedSwitchService?.updateCharacteristic(
      this.platform.Characteristic.On,
      this.opened,
    );

    // If a position command is already pending (scene), let it handle the tilt
    if (this.targetPositionTimer) {
      return;
    }

    // If currently moving, do nothing — tilt will be applied after movement completes
    if (this.onPositionUpdate) {
      return;
    }

    // Not moving, no position pending — apply tilt at current position after a debounce
    // (slightly longer than position debounce so position commands win if sent together)
    if (this.tiltTimer) {
      clearTimeout(this.tiltTimer);
    }
    this.tiltTimer = setTimeout(() => {
      this.tiltTimer = null;
      this.applyDesiredTilt();
    }, 500);
  }

  applyDesiredTilt() {
    if (!this.desiredTilt || this.desiredTilt === this.states.TiltPosition) {
      this.desiredTilt = null;
      return;
    }

    const currentPosition = this.states.Position || 0;
    if (currentPosition > 0) {
      const { name } = this.accessory.context.device;
      this.platform.logger.info(
        `🔄 ${name}: Applying tilt "${this.desiredTilt}" at position ${currentPosition}%`,
      );
      const tilt = this.desiredTilt;
      this.desiredTilt = null;

      // Set tilt flags and trigger movement at current position
      // The blinds controller will see steps=0 and apply tilt-only
      this.tilted = tilt === "tilted";
      this.opened = tilt === "open";
      this.platform.blindsController.moveBlindsToPosition({
        platformAccessory: this,
        value: currentPosition,
        tilt,
      });
    }
  }

  setTiltedOn(value: CharacteristicValue) {
    this.tilted = value as boolean;
    this.desiredTilt = this.opened ? "open" : this.tilted ? "tilted" : "closed";
    this.restartPendingPosition();
  }

  getTiltedOn(): CharacteristicValue {
    return this.tilted;
  }

  setOpenedOn(value: CharacteristicValue) {
    this.opened = value as boolean;
    this.desiredTilt = this.opened ? "open" : this.tilted ? "tilted" : "closed";
    this.restartPendingPosition();
  }

  getOpenedOn(): CharacteristicValue {
    return this.opened;
  }

  applyTiltStateOptimistically(tilt: BlindsTilt) {
    this.states.TiltPosition = tilt;
    // Ignore stateText tilt updates for 5s — Loxone may report stale tilt after pulse
    this.tiltCooldownUntil = Date.now() + 5000;
    const tiltAngle = this.tiltPositionToAngle(tilt);
    this.service?.updateCharacteristic(
      this.platform.Characteristic.CurrentHorizontalTiltAngle,
      tiltAngle,
    );
    this.service?.updateCharacteristic(
      this.platform.Characteristic.TargetHorizontalTiltAngle,
      tiltAngle,
    );
    if (this.slatService) {
      const slatAngle = tilt === "tilted" ? 45 : tilt === "open" ? 90 : 0;
      const slatState = tilt === "closed"
        ? this.platform.Characteristic.CurrentSlatState.FIXED
        : this.platform.Characteristic.CurrentSlatState.SWINGING;
      this.slatService.updateCharacteristic(
        this.platform.Characteristic.CurrentTiltAngle,
        slatAngle,
      );
      this.slatService.updateCharacteristic(
        this.platform.Characteristic.CurrentSlatState,
        slatState,
      );
    }
  }

  getCurrentSlatState() {
    return this.states.TiltPosition === "closed"
      ? this.platform.Characteristic.CurrentSlatState.FIXED
      : this.platform.Characteristic.CurrentSlatState.SWINGING;
  }

  getSlatType() {
    return this.platform.Characteristic.SlatType.HORIZONTAL;
  }

  // --- Shade & Awning buttons ---

  async setShadeOn(value: CharacteristicValue) {
    if (value) {
      const { name } = this.accessory.context.device;
      this.platform.logger.info(`🌤️ ${name}: Sending shade command`);
      await sendCommandSafe(this.platform, this.identifier, ["shade"]);

      setTimeout(() => {
        this.shadeSwitchService?.updateCharacteristic(
          this.platform.Characteristic.On,
          false,
        );
      }, 100);
    }
  }

  getShadeOn(): CharacteristicValue {
    return false;
  }

  async setFullyInOn(value: CharacteristicValue) {
    if (value) {
      const { name } = this.accessory.context.device;
      this.platform.logger.info(`⬆️ ${name}: Sending Fully In (retract) command`);
      await sendCommandSafe(this.platform, this.identifier, ["FullUp"]);
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
      await sendCommandSafe(this.platform, this.identifier, ["FullDown"]);
      setTimeout(() => {
        this.fullyOutSwitchService?.updateCharacteristic(
          this.platform.Characteristic.On,
          false,
        );
      }, 100);
    }
  }

  // --- Auto Sun Position ---

  async setAutoSunOn(value: CharacteristicValue) {
    const { name } = this.accessory.context.device;
    this.platform.logger.info(
      `☀️ ${name}: Auto Sun Position ${value ? "ON" : "OFF"}`,
    );

    this.autoSunPosition = value as boolean;
    this.lastAutoSunCommand = Date.now();

    if (value) {
      await sendCommandSafe(this.platform, this.identifier, ["auto"]);
    } else {
      await sendCommandSafe(this.platform, this.identifier, ["NoAuto"]);
    }
  }

  getAutoSunOn(): CharacteristicValue {
    return this.autoSunPosition;
  }

  resetAutoSunCooldown() {
    this.lastAutoSunCommand = 0;
  }

  // --- Position getters ---

  getPosition() {
    return this.states?.Position || 0;
  }

  getPositionState() {
    return this.states?.PositionState ||
      this.platform.Characteristic.PositionState.STOPPED;
  }

  getTargetPosition() {
    return this.states?.TargetPosition || 0;
  }

  async setTargetPosition(value: CharacteristicValue) {
    this.pendingTargetValue = value as number;
    if (this.targetPositionTimer) {
      clearTimeout(this.targetPositionTimer);
    }
    this.targetPositionTimer = setTimeout(() => {
      this.targetPositionTimer = null;
      this.pendingTargetValue = null;
      this.movementStartTime = Date.now();
      this.handleSetTargetPosition(value as number);
    }, 300);
  }

  private restartPendingPosition() {
    if (this.targetPositionTimer && this.pendingTargetValue !== null) {
      clearTimeout(this.targetPositionTimer);
      const value = this.pendingTargetValue;
      this.targetPositionTimer = setTimeout(() => {
        this.targetPositionTimer = null;
        this.pendingTargetValue = null;
        this.movementStartTime = Date.now();
        this.handleSetTargetPosition(value);
      }, 300);
    }
  }

  async handleSetTargetPosition(value: number) {
    // Use desiredTilt if explicitly set (from tilt slider or scene), otherwise from switch buttons
    const actualTilt = this.desiredTilt || (this.opened ? "open" : this.tilted ? "tilted" : "closed");
    const tilt = (value > 0 ? actualTilt : "closed") as BlindsTilt;
    // Clear desiredTilt since it's being consumed by this position command
    this.desiredTilt = null;

    const positionDelta = Math.abs(value - this.states.Position);
    const tiltChanged = tilt !== this.states.TiltPosition;
    const isFullTarget = value === 0 || value === 100;

    // Skip only when position is very close, tilt unchanged, and not targeting a limit
    if (positionDelta < 6 && !tiltChanged && !isFullTarget) {
      this.platform.logger.debug(
        `   🚨 Too close and same tilt, skip! ${JSON.stringify({
          value,
          pos: this.states.Position,
          tilt,
          curr: this.states.TiltPosition,
        })}`,
      );
      return;
    }

    // Position too close to move reliably, but tilt needs adjustment
    if (positionDelta < 6 && tiltChanged && !isFullTarget) {
      this.platform.logger.info(
        `   🕹️ Position within tolerance (${this.states.Position}% → ${value}%), adjusting tilt only: "${this.states.TiltPosition}" → "${tilt}"`,
      );
      this.platform.blindsController.moveBlindsToPosition({
        platformAccessory: this,
        value: this.states.Position,
        tilt,
      });
      return;
    }

    this.platform.blindsController.moveBlindsToPosition({
      platformAccessory: this,
      value,
      tilt,
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

  // --- State updates from Loxone ---

  setState = (givenValues: States, stateText?: string) => {
    const newValues = Array.isArray(givenValues) ? givenValues : [givenValues];
    const newStates: States = {
      ...this.states,
      PositionState: this.platform.Characteristic.PositionState.STOPPED,
    };

    const newValue = Array.isArray(newValues) ? newValues[0] : newValues;
    if (!newValue) {
      return;
    }

    const keys = Object.keys(newValue);
    const thirstValue = keys.length > 0 ? newValue[keys[0]] : undefined;
    const secondValue = keys.length > 1 ? newValue[keys[1]] : undefined;
    const isMoving =
      newValue.isMoving || thirstValue === 1 || secondValue === 1;
    const movingDirection = !isMoving
      ? null
      : thirstValue === 1
      ? "up"
      : secondValue === 1
      ? "down"
      : null;

    // Parse tilt from stateText when available, otherwise preserve current
    if (stateText && Date.now() >= this.tiltCooldownUntil) {
      newStates.TiltPosition = getTiltPositionFromStateText(
        stateText,
        (msg) => this.platform.logger.info(msg),
      );
    } else {
      newStates.TiltPosition = this.states.TiltPosition || "closed";
    }

    // Position comes from raw WS values (3rd key = position float)
    const thirdValue = keys.length > 2 ? newValue[keys[2]] : undefined;
    const Position = typeof thirdValue === "number" ? Math.round(thirdValue * 100) : NaN;
    if (!isNaN(Position)) {
      newStates.Position = Position;
      newStates.TargetPosition = Position;
    }

    newStates.PositionState = isMoving
      ? movingDirection === "up"
        ? this.platform.Characteristic.PositionState.DECREASING
        : this.platform.Characteristic.PositionState.INCREASING
      : this.platform.Characteristic.PositionState.STOPPED;

    if (newStates.PositionState === 2 && !isNaN(Position)) {
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

    // Don't update TargetPosition from Loxone while user is actively scrubbing the slider
    if (this.targetPositionTimer) {
      newStates.TargetPosition = this.states.TargetPosition;
    }

    if (this.states.TargetPosition !== newStates.TargetPosition) {
      anyStateChanged = true;
      this.service?.updateCharacteristic(
        this.platform.Characteristic.TargetPosition,
        newStates.TargetPosition,
      );
    }

    // Update tilt on both the WindowCovering service and the Slats service
    if (this.states.TiltPosition !== newStates.TiltPosition) {
      anyStateChanged = true;
      const tiltAngle = this.tiltPositionToAngle(newStates.TiltPosition);

      // Update WindowCovering tilt (slider in blind control)
      this.service?.updateCharacteristic(
        this.platform.Characteristic.CurrentHorizontalTiltAngle,
        tiltAngle,
      );
      this.service?.updateCharacteristic(
        this.platform.Characteristic.TargetHorizontalTiltAngle,
        tiltAngle,
      );

      // Update Slats service
      if (this.slatService) {
        const slatAngle = newStates.TiltPosition === "tilted" ? 45
          : newStates.TiltPosition === "open" ? 90 : 0;
        const slatState = newStates.TiltPosition === "closed"
          ? this.platform.Characteristic.CurrentSlatState.FIXED
          : this.platform.Characteristic.CurrentSlatState.SWINGING;

        this.slatService.updateCharacteristic(
          this.platform.Characteristic.CurrentTiltAngle,
          slatAngle,
        );
        this.slatService.updateCharacteristic(
          this.platform.Characteristic.CurrentSlatState,
          slatState,
        );
      }
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

    // Notify blinds controller of position update (for state-based positioning)
    if (this.onPositionUpdate) {
      const isStopped = newStates.PositionState === this.platform.Characteristic.PositionState.STOPPED;
      this.onPositionUpdate(newStates.Position ?? 0, isStopped);
    }

    // Update Auto Sun Position state based on automation text messages
    this.updateAutoSunState(givenValues);
  };

  private updateAutoSunState(givenValues: States) {
    const checkAutomationState = (stateObj: Record<string, unknown>): { hasAutomationText: boolean; isActive: boolean } => {
      for (const value of Object.values(stateObj)) {
        if (typeof value === "object" && value !== null && "text" in value) {
          const text = (value as { text: string }).text;
          if (text && text.includes("Automatik Beschattung")) {
            const isActive = text.includes("aktiv") && !text.includes("deaktiviert") && !text.includes("inaktiv");
            this.platform.logger.debug(
              `☀️ ${this.accessory.context.device.name}: Automation text: "${text}", interpreted as: ${isActive ? "ACTIVE" : "INACTIVE"}`,
            );
            return { hasAutomationText: true, isActive };
          }
        }
      }
      return { hasAutomationText: false, isActive: false };
    };

    const timeSinceLastCommand = Date.now() - this.lastAutoSunCommand;
    if (this.lastAutoSunCommand > 0 && timeSinceLastCommand < AUTO_SUN_COOLDOWN) {
      this.platform.logger.debug(
        `☀️ ${this.accessory.context.device.name}: Ignoring automation state update for ${AUTO_SUN_COOLDOWN - timeSinceLastCommand}ms after user command`,
      );
      return;
    }

    const stateToCheck = Array.isArray(givenValues) ? givenValues[0] : givenValues;
    if (!stateToCheck || typeof stateToCheck !== "object") {
      return;
    }

    const automationResult = checkAutomationState(stateToCheck);
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
}
