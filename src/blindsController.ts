/* eslint-disable indent */
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
  BLINDS_TILT_DELAY_SHORT,
  BLINDS_TILT_DELAY_MEDIUM,
  BLINDS_TILT_DELAY_LONG,
  BLINDS_POSITION_TOLERANCE,
  BLINDS_POSITION_TIMEOUT,
} from "./settings.js";

interface MoveBlindsToPositionParams {
  value: number;
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
    { value, platformAccessory }: MoveBlindsToPositionParams,
    waitBeforeExecute = 0,
  ) => {
    try {
      await sleep(waitBeforeExecute);
      const actualTilt = platformAccessory.getOpenedOn()
        ? "open"
        : platformAccessory.getTiltedOn()
        ? "tilted"
        : "closed";
      const tilt = (value > 0 ? actualTilt : "closed") as BlindsTilt;
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
    this.platform.logger.debug(
      `   🎯 Control blinds slat tilt angle of "${name}" to final position "${JSON.stringify(
        {
          tilt,
          isMovingDown,
          currPos: platformAccessory.getPositionState(),
        },
      )}"`,
    );

    // Stop the blind if it's still moving (it may still be in motion when position-watching triggers)
    const isStopped = platformAccessory.getPositionState() === this.platform.Characteristic.PositionState.STOPPED;
    if (!isStopped) {
      await this.sendMoveJalousieCommand(
        platformAccessory,
        false,
        isMovingDown ? "FullDown" : "FullUp",
      );
      await sleep(BLINDS_STOP_SETTLE_DELAY);
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

    if (isMovingDown) {
      if (tilt === "closed") {
        this.platform.logger.debug(
          "   👍 Tilt is closed, no additional tilt adjustment needed",
        );
        return;
      } else if (tilt === "tilted") {
        this.platform.logger.debug(
          `   🕹️ Double click "up" button with delay of ${BLINDS_TILT_DELAY_SHORT}ms (tilt=${tilt})`,
        );
        await this.sendMoveJalousieCommand(platformAccessory, true, "FullUp");
        await sleep(BLINDS_TILT_DELAY_SHORT);
        await this.sendMoveJalousieCommand(platformAccessory, false, "FullUp");
      } else if (tilt === "open") {
        this.platform.logger.debug(
          `   🕹️ Double click "up" button with delay of ${BLINDS_TILT_DELAY_LONG}ms (tilt=${tilt})`,
        );
        await this.sendMoveJalousieCommand(platformAccessory, true, "FullUp");
        await sleep(BLINDS_TILT_DELAY_LONG);
        await this.sendMoveJalousieCommand(platformAccessory, false, "FullUp");
      }
    } else {
      if (tilt === "closed") {
        this.platform.logger.debug(
          `   🕹️ Double click "down" button with delay of ${BLINDS_TILT_DELAY_LONG}ms (tilt=${tilt})`,
        );
        await this.sendMoveJalousieCommand(platformAccessory, true, "FullDown");
        await sleep(BLINDS_TILT_DELAY_LONG);
        await this.sendMoveJalousieCommand(
          platformAccessory,
          false,
          "FullDown",
        );
      } else if (tilt === "tilted") {
        this.platform.logger.debug(
          `   🕹️ Double click "down" button with delay of ${BLINDS_TILT_DELAY_MEDIUM}ms (tilt=${tilt})`,
        );
        await this.sendMoveJalousieCommand(platformAccessory, true, "FullDown");
        await sleep(BLINDS_TILT_DELAY_MEDIUM);
        await this.sendMoveJalousieCommand(
          platformAccessory,
          false,
          "FullDown",
        );
      } else if (tilt === "open") {
        this.platform.logger.debug(
          "   👍 Tilt is open, no additional tilt adjustment needed",
        );
        return;
      }
    }
  };

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
