import { BlindsTilt, BlindsType } from "./loxone/types.js";
import { sendCommandSafe } from "./loxone/utils/sendCommand.js";
import { sleep } from "./loxone/utils/sleep.js";
import { parseIdentifier } from "./loxone/utils/parseIdentifier.js";
import { LoxoneControlPlatform } from "./platform.js";
import { PlatformWindowCoveringAccessory } from "./platformWindowCoveringAccessory.js";
import {
  BLINDS_DEBOUNCE_DELAY,
  BLINDS_COMMAND_STAGGER_DELAY,
  BLINDS_STOP_SETTLE_DELAY,
  BLINDS_FINAL_POSITION_SETTLE,
  BLINDS_POSITION_TOLERANCE,
  BLINDS_POSITION_TIMEOUT,
} from "./settings.js";

interface MoveBlindsToPositionParams {
  value: number;
  tilt: BlindsTilt;
  platformAccessory: PlatformWindowCoveringAccessory;
}

interface MoveBlindsToFinalPositionParams {
  platformAccessory: PlatformWindowCoveringAccessory;
  isMovingDown: boolean;
  tilt: BlindsTilt;
  blindsType: BlindsType;
  targetPosition: number;
}

interface ActiveMovement {
  safetyTimer: ReturnType<typeof setTimeout>;
  resolve: () => void;
}

export class BlindsController {
  private activeMovements: Map<string, ActiveMovement> = new Map();

  private runCommands: MoveBlindsToPositionParams[] = [];
  private runDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  public commandsExecuting = false;

  constructor(public readonly platform: LoxoneControlPlatform) {
    this.moveBlindsToPosition = this.moveBlindsToPosition.bind(this);
    this.moveBlindsToPositionNow = this.moveBlindsToPositionNow.bind(this);
    this.moveBlindsToFinalPosition = this.moveBlindsToFinalPosition.bind(this);
  }

  moveBlindsToPosition = async (params: MoveBlindsToPositionParams) => {
    return new Promise<void>((resolve) => {
      this.runCommands.push(params);

      if (this.runDebounceTimer) {
        clearTimeout(this.runDebounceTimer);
      }
      this.runDebounceTimer = setTimeout(() => {
        this.platform.logger.debug(
          `🤖 Nothing received for ${BLINDS_DEBOUNCE_DELAY}ms, collected commands: [${this.runCommands.map(
            (rc) => rc.value,
          )}]`,
        );
        this.runDebounceTimer = null;
        this.commandsExecuting = true;
        const commands = [...this.runCommands];
        this.runCommands = [];

        // Cancel all active movements up front so blinds from a previous
        // batch stop immediately instead of continuing during stagger delays
        for (const command of commands) {
          const { actionUuid } = parseIdentifier(command.platformAccessory.identifier);
          this.cancelActiveMovement(actionUuid, command.platformAccessory);
        }

        const promises = commands.map(async (command, index) => {
          const delay = index * BLINDS_COMMAND_STAGGER_DELAY;
          await this.moveBlindsToPositionNow(command, delay);
          command.platformAccessory.resetTiltPositions();
          // After movement completes, apply any desired tilt that was set during movement
          command.platformAccessory.applyDesiredTilt();
        });
        Promise.all(promises).then(() => {
          this.platform.logger.debug("✅ All blind commands completed");
          this.commandsExecuting = false;
          resolve();
        }).catch((error) => {
          this.platform.logger.error(`Error executing blind commands: ${error}`);
          this.commandsExecuting = false;
          resolve();
        });
      }, BLINDS_DEBOUNCE_DELAY);
    });
  };

  private cancelActiveMovement(actionUuid: string, platformAccessory: PlatformWindowCoveringAccessory) {
    const existing = this.activeMovements.get(actionUuid);
    if (existing) {
      clearTimeout(existing.safetyTimer);
      platformAccessory.onPositionUpdate = null;
      platformAccessory.movementStartTime = 0;
      this.activeMovements.delete(actionUuid);
      // Resolve the dangling watchPosition promise so it doesn't block
      existing.resolve();
      this.platform.logger.debug(` > Cancelled active movement for "${actionUuid}"`);
    }
  }

  private watchPosition(
    platformAccessory: PlatformWindowCoveringAccessory,
    targetPosition: number,
    isMovingDown: boolean,
    tilt: BlindsTilt,
    blindsType: BlindsType,
  ): Promise<void> {
    return new Promise((resolve) => {
      const { actionUuid } = parseIdentifier(platformAccessory.identifier);
      const { name } = platformAccessory.accessory.context.device;

      // Cancel any existing movement for this blind
      this.cancelActiveMovement(actionUuid, platformAccessory);

      const cleanup = () => {
        platformAccessory.onPositionUpdate = null;
        platformAccessory.movementStartTime = 0;
        const movement = this.activeMovements.get(actionUuid);
        if (movement) {
          clearTimeout(movement.safetyTimer);
        }
        this.activeMovements.delete(actionUuid);
      };

      const onReached = async () => {
        cleanup();
        this.platform.logger.info(
          `🎯 "${name}" reached target position ${targetPosition}%`,
        );
        await this.moveBlindsToFinalPosition({
          platformAccessory, isMovingDown, tilt, blindsType, targetPosition,
        });
        resolve();
      };

      const safetyTimer = setTimeout(async () => {
        this.platform.logger.warn(
          `⏰ Safety timeout: "${name}" did not reach target ${targetPosition}% within ${BLINDS_POSITION_TIMEOUT / 1000}s`,
        );
        cleanup();
        await this.moveBlindsToFinalPosition({
          platformAccessory, isMovingDown, tilt, blindsType, targetPosition,
        });
        resolve();
      }, BLINDS_POSITION_TIMEOUT);

      // Ignore early "stopped" reports — the blind needs time to start moving after the command
      const moveStartTime = Date.now();
      const MOVE_GRACE_PERIOD = 2000;

      platformAccessory.onPositionUpdate = (position: number, isStopped: boolean) => {
        // Check if we've reached the target (within tolerance)
        if (Math.abs(position - targetPosition) <= BLINDS_POSITION_TOLERANCE) {
          onReached();
        } else if (isStopped && Date.now() - moveStartTime > MOVE_GRACE_PERIOD) {
          // Blind stopped before reaching target (obstacle, manual stop, etc.)
          this.platform.logger.warn(
            `⚠️ "${name}" stopped at ${position}%, target was ${targetPosition}%`,
          );
          cleanup();
          resolve();
        } else if (isMovingDown && position > targetPosition + BLINDS_POSITION_TOLERANCE) {
          // Overshot while moving down
          this.platform.logger.debug(
            `🎯 "${name}" overshot target (at ${position}%, target ${targetPosition}%), stopping`,
          );
          onReached();
        } else if (!isMovingDown && position < targetPosition - BLINDS_POSITION_TOLERANCE) {
          // Overshot while moving up
          this.platform.logger.debug(
            `🎯 "${name}" overshot target (at ${position}%, target ${targetPosition}%), stopping`,
          );
          onReached();
        }
      };

      this.activeMovements.set(actionUuid, { safetyTimer, resolve });
    });
  }

  moveBlindsToPositionNow = async (
    { value, tilt, platformAccessory }: MoveBlindsToPositionParams,
    waitBeforeExecute = 0,
  ) => {
    try {
      await sleep(waitBeforeExecute);
      const { accessory, identifier, states } = platformAccessory;
      const { actionUuid } = parseIdentifier(identifier);
      const { name } = accessory.context.device;

      // Cancel any existing movement
      this.cancelActiveMovement(actionUuid, platformAccessory);

      const blindsType: BlindsType =
        accessory.context.device.blindsType === "awning" ||
        accessory.context.device.blindsTiming?.includes("awning")
          ? "awning"
          : "blinds";

      const steps = value - (states.Position ?? 0);
      const isMovingDown = steps > 0;

      const isAlreadyRunning =
        states.PositionState !==
        this.platform.Characteristic.PositionState.STOPPED;

      // If blind is already moving, stop it and wait for confirmed stop before sending new command.
      if (isAlreadyRunning) {
        this.platform.logger.debug(
          `   🔥 Blinds "${name}" are already moving, stopping first before new command`,
        );
        await sendCommandSafe(this.platform, identifier, ["stop"]);
        // Wait until the blind actually reports stopped (up to 10s)
        const stoppedState = this.platform.Characteristic.PositionState.STOPPED;
        for (let i = 0; i < 20; i++) {
          await sleep(BLINDS_STOP_SETTLE_DELAY);
          if (states.PositionState === stoppedState) {
            break;
          }
        }
      }

      const stepsToTarget = Math.abs(steps);
      const targetIsFullyDownOrUp =
        value === 0 || (value === 100 && tilt === "closed");

      if (stepsToTarget > 0) {
        this.platform.logger.info(
          `🕹️ Move jalousie "${name}" from ${states.Position}% to ${value}% (${tilt})`,
        );

        states.TargetPosition = value;
        await this.sendMoveJalousieCommand(
          platformAccessory,
          true,
          isMovingDown ? "down" : "up",
        );

        if (targetIsFullyDownOrUp) {
          // For fully up/down: Loxone stops at mechanical limits automatically
          // Just wait for the state to report stopped
          this.platform.logger.debug(
            `   📍 Target is fully ${value === 0 ? "up" : "down"}, Loxone will stop at limit`,
          );
          await this.watchPosition(
            platformAccessory, value, isMovingDown, tilt, blindsType,
          );
        } else {
          // Watch position updates until target is reached
          await this.watchPosition(
            platformAccessory, value, isMovingDown, tilt, blindsType,
          );
        }
      } else {
        // No position change needed, check if tilt needs adjustment
        if (tilt !== states.TiltPosition) {
          this.platform.logger.info(
            `   🕹️ Tilt-only adjustment: "${states.TiltPosition}" → "${tilt}"`,
          );
          await this.adjustTiltFromCurrentState({
            platformAccessory,
            fromTilt: states.TiltPosition || "closed",
            toTilt: tilt,
          });
        } else {
          this.platform.logger.debug(
            `   👍 Nothing to do, the blinds are already at position ${value}`,
          );
        }
      }
    } catch (e) {
      this.platform.logger.error(`Error in moveBlindsToPositionNow: ${e}`);
    }
  };

  moveBlindsToFinalPosition = async ({
    platformAccessory,
    isMovingDown,
    tilt,
    blindsType,
    targetPosition,
  }: MoveBlindsToFinalPositionParams) => {
    const { accessory } = platformAccessory;
    const { name } = accessory.context.device;
    await sleep(BLINDS_FINAL_POSITION_SETTLE);
    const posState = platformAccessory.getPositionState();
    const posStateLabel = posState === this.platform.Characteristic.PositionState.STOPPED ? "stopped"
      : posState === this.platform.Characteristic.PositionState.DECREASING ? "decreasing" : "increasing";
    this.platform.logger.info(
      `   🎯 "${name}" tilt adjustment: tilt=${tilt}, isMovingDown=${isMovingDown}, positionState=${posStateLabel}, target=${targetPosition}%`,
    );

    // Stop the blind if it's still moving (it may still be in motion when position-watching triggers)
    const isStopped = posState === this.platform.Characteristic.PositionState.STOPPED;
    if (!isStopped) {
      this.platform.logger.info(
        `   ⏹️ "${name}" still moving, sending stop command`,
      );
      await this.sendMoveJalousieCommand(platformAccessory, false);

      // Wait for Loxone to confirm the blind has actually stopped
      const stoppedState = this.platform.Characteristic.PositionState.STOPPED;
      for (let i = 0; i < 20; i++) {
        await sleep(BLINDS_STOP_SETTLE_DELAY);
        if (platformAccessory.getPositionState() === stoppedState) {
          break;
        }
        if (i === 19) {
          this.platform.logger.warn(`   ⚠️ "${name}" did not report stopped after ${20 * BLINDS_STOP_SETTLE_DELAY}ms, proceeding anyway`);
        }
      }

      // Extra settle: let the physical slats fully stabilize after stopping
      await sleep(BLINDS_FINAL_POSITION_SETTLE * 2);
    }

    if (blindsType === "awning") {
      return;
    }

    // Near 0% (fully retracted), tilt adjustments are meaningless and would move the blind back down
    if (targetPosition <= BLINDS_POSITION_TOLERANCE) {
      this.platform.logger.debug(
        `   👍 "${name}" target is ${targetPosition}%, skipping tilt adjustment`,
      );
      return;
    }

    // After position movement, infer tilt from direction (stateText is unreliable during movement):
    // moving down → slats are physically closed, moving up → slats are physically open.
    const currentTilt: BlindsTilt = isMovingDown ? "closed" : "open";

    if (currentTilt === tilt) {
      this.platform.logger.debug(`   👍 "${name}" tilt is already "${tilt}", no adjustment needed`);
      return;
    }

    await this.applyTiltPulses(platformAccessory, currentTilt, tilt);
  };

  /**
   * Adjust tilt from the actual current tilt state (for tilt-only changes without position movement).
   * Unlike moveBlindsToFinalPosition which assumes a natural starting tilt based on movement direction,
   * this method handles all tilt transitions including from the "tilted" (shading) state.
   */
  adjustTiltFromCurrentState = async ({
    platformAccessory,
    fromTilt,
    toTilt,
  }: {
    platformAccessory: PlatformWindowCoveringAccessory;
    fromTilt: BlindsTilt;
    toTilt: BlindsTilt;
  }) => {
    const { name } = platformAccessory.accessory.context.device;

    if (fromTilt === toTilt) {
      this.platform.logger.debug(`   👍 "${name}" tilt: no transition needed (${fromTilt} → ${toTilt})`);
      return;
    }

    this.platform.logger.info(`   🕹️ "${name}" tilt-only: ${fromTilt} → ${toTilt}`);
    await this.applyTiltPulses(platformAccessory, fromTilt, toTilt);
  };

  /**
   * Apply tilt pulses to transition between tilt states.
   * Uses "up"/"down" toggle commands (not FullUp/FullDown which move to limits).
   * For full transitions (closed↔open), chains two short pulses via "tilted" intermediate
   * to avoid overshooting into position movement.
   */
  private applyTiltPulses = async (
    platformAccessory: PlatformWindowCoveringAccessory,
    fromTilt: BlindsTilt,
    toTilt: BlindsTilt,
  ) => {
    const { name } = platformAccessory.accessory.context.device;

    // Single-step tilt transitions: [command, duration]
    const tiltSteps: Record<string, Record<string, [string, number]>> = {
      closed: { tilted: ["up", 470] },
      tilted: { closed: ["down", 470], open: ["up", 470] },
      open: { tilted: ["down", 470] },
    };

    // Build the path: direct step if available, otherwise go via "tilted" intermediate
    const directStep = tiltSteps[fromTilt]?.[toTilt];
    const fromToTilted = tiltSteps[fromTilt]?.tilted;
    const tiltedToTarget = tiltSteps.tilted?.[toTilt];
    const steps: [string, number, string, string][] = directStep
      ? [[directStep[0], directStep[1], fromTilt, toTilt]]
      : fromToTilted && tiltedToTarget
        ? [
          [fromToTilted[0], fromToTilted[1], fromTilt, "tilted"],
          [tiltedToTarget[0], tiltedToTarget[1], "tilted", toTilt],
        ]
        : [];

    for (const [command, duration, from, to] of steps) {
      this.platform.logger.info(`   🕹️ "${name}" tilt: ${command} ${duration}ms (${from} → ${to})`);
      await this.sendMoveJalousieCommand(platformAccessory, true, command);
      await sleep(duration);
      await this.sendMoveJalousieCommand(platformAccessory, false);
    }

    platformAccessory.applyTiltStateOptimistically(toTilt);
  };

  sendMoveJalousieCommand = async (
    platformAccessory: PlatformWindowCoveringAccessory,
    shouldMove: boolean,
    command = "down",
    failOver = 0,
  ) => {
    if (failOver > 1) {
      return;
    }
    await sendCommandSafe(
      this.platform,
      platformAccessory.identifier,
      [shouldMove ? command : "stop"],
    );
  };
}
