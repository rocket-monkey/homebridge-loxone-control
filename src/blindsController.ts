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
  BLINDS_TILT_PULSE_SHORT,
  BLINDS_TILT_PULSE_LONG,
  BLINDS_TILT_SETTLE_DELAY,
  BLINDS_TILT_MAX_RETRIES,
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

      platformAccessory.onPositionUpdate = (position: number, isStopped: boolean) => {
        // Check if we've reached the target (within tolerance)
        if (Math.abs(position - targetPosition) <= BLINDS_POSITION_TOLERANCE) {
          onReached();
        } else if (isStopped) {
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

      // If blind is already moving, any command will stop it first (hardware behavior).
      // So we send a stop command, wait for it to settle, then send the new movement.
      if (isAlreadyRunning) {
        this.platform.logger.debug(
          `   🔥 Blinds "${name}" are already moving, stopping first before new command`,
        );
        await sendCommandSafe(this.platform, identifier, [isMovingDown ? "FullDown" : "FullUp"]);
        await sleep(BLINDS_STOP_SETTLE_DELAY);
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
          isMovingDown ? "FullDown" : "FullUp",
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
          this.platform.logger.debug(
            `   🕹️ Move slat tilt angle only, from "${states.TiltPosition}" to "${tilt}"`,
          );
          await this.moveBlindsToFinalPosition({
            platformAccessory,
            isMovingDown: true,
            tilt,
            blindsType,
            targetPosition: value,
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
      const stopCmd = isMovingDown ? "FullDown" : "FullUp";
      this.platform.logger.info(
        `   ⏹️ "${name}" still moving, sending stop command (${stopCmd})`,
      );
      await this.sendMoveJalousieCommand(platformAccessory, false, stopCmd);

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
      await sleep(BLINDS_FINAL_POSITION_SETTLE);
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

    // Determine if tilt needs adjustment and which direction to move
    const currentTilt = platformAccessory.states.TiltPosition || "closed";
    if (tilt === currentTilt) {
      this.platform.logger.info(
        `   👍 "${name}" tilt already at "${tilt}", no adjustment needed`,
      );
      return;
    }

    // Tilt order: closed < tilted < open
    // To go towards "open", move up (FullUp). To go towards "closed", move down (FullDown).
    const tiltOrder: BlindsTilt[] = ["closed", "tilted", "open"];
    const currentIndex = tiltOrder.indexOf(currentTilt);
    const targetIndex = tiltOrder.indexOf(tilt);
    const tiltCommand = targetIndex > currentIndex ? "FullUp" : "FullDown";
    const tiltSteps = Math.abs(targetIndex - currentIndex);
    const pulseDuration = tiltSteps > 1 ? BLINDS_TILT_PULSE_LONG : BLINDS_TILT_PULSE_SHORT;

    // Pulse + verify loop: send a timed pulse, then wait for state confirmation
    for (let attempt = 1; attempt <= BLINDS_TILT_MAX_RETRIES; attempt++) {
      const reportedTilt = platformAccessory.states.TiltPosition || "closed";
      if (reportedTilt === tilt) {
        this.platform.logger.info(
          `   ✅ "${name}" tilt verified at "${tilt}" after ${attempt - 1} pulse(s)`,
        );
        return;
      }

      this.platform.logger.info(
        `   🕹️ "${name}" tilt pulse ${attempt}/${BLINDS_TILT_MAX_RETRIES}: "${reportedTilt}" → "${tilt}" via ${tiltCommand} (${pulseDuration}ms)`,
      );

      // Start movement, wait pulse duration, stop, let slats settle
      await this.sendMoveJalousieCommand(platformAccessory, true, tiltCommand);
      await sleep(pulseDuration);
      await this.sendMoveJalousieCommand(platformAccessory, false, tiltCommand);
      await sleep(BLINDS_STOP_SETTLE_DELAY);

      // Wait for Loxone to confirm tilt state (with timeout fallback)
      const confirmed = await this.waitForTiltState(platformAccessory, tilt);
      if (confirmed) {
        this.platform.logger.info(
          `   ✅ "${name}" tilt confirmed at "${tilt}" after ${attempt} pulse(s)`,
        );
        return;
      }
    }

    const finalTilt = platformAccessory.states.TiltPosition || "closed";
    if (finalTilt === tilt) {
      this.platform.logger.info(
        `   ✅ "${name}" tilt verified at "${tilt}"`,
      );
    } else {
      this.platform.logger.warn(
        `   ⚠️ "${name}" tilt is "${finalTilt}" after ${BLINDS_TILT_MAX_RETRIES} retries, wanted "${tilt}"`,
      );
    }
  };

  private waitForTiltState(
    platformAccessory: PlatformWindowCoveringAccessory,
    targetTilt: BlindsTilt,
  ): Promise<boolean> {
    // If already at target, return immediately
    if ((platformAccessory.states.TiltPosition || "closed") === targetTilt) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        platformAccessory.onTiltUpdate = null;
        resolve((platformAccessory.states.TiltPosition || "closed") === targetTilt);
      }, BLINDS_TILT_SETTLE_DELAY);

      platformAccessory.onTiltUpdate = (currentTilt: BlindsTilt) => {
        if (currentTilt === targetTilt) {
          clearTimeout(timeout);
          platformAccessory.onTiltUpdate = null;
          resolve(true);
        }
      };
    });
  }

  sendMoveJalousieCommand = async (
    platformAccessory: PlatformWindowCoveringAccessory,
    shouldMove: boolean,
    command = "FullDown",
    failOver = 0,
  ) => {
    if (failOver > 1) {
      return;
    }
    await sendCommandSafe(
      this.platform,
      platformAccessory.identifier,
      [command],
    );
  };
}
