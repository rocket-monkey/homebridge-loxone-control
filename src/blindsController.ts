/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable indent */
import { BlindsTilt, BlindsTimingVariant, BlindsType } from "./loxone/types.js";
import { getBlindsTiming } from "./loxone/utils/getBlindsTiming.js";
import { sendCommand } from "./loxone/utils/sendCommand.js";
import { sleep } from "./loxone/utils/sleep.js";
import { toPositive } from "./loxone/utils/toPositive.js";
import { LoxoneControlPlatform } from "./platform.js";
import { PlatformWindowCoveringAccessory } from "./platformWindowCoveringAccessory.js";

interface MoveBlindsToPositionParams {
  value: number;
  platformAccessory: PlatformWindowCoveringAccessory;
}

interface MoveBlindsToFinalPositionParams {
  platformAccessory: PlatformWindowCoveringAccessory;
  isMovingDown: boolean;
  tilt: BlindsTilt;
  blindsType: BlindsType;
}

export class BlindsController {
  private activeTimers: Map<string, NodeJS.Timeout>;

  private runCommands: MoveBlindsToPositionParams[] = [];
  private runDebounceTimer: NodeJS.Timeout | null = null;
  public commandsExecuting = false;

  constructor(public readonly platform: LoxoneControlPlatform) {
    this.activeTimers = new Map<string, NodeJS.Timeout>();
    this.moveBlindsToPosition = this.moveBlindsToPosition.bind(this);
    this.moveBlindsToPositionNow = this.moveBlindsToPositionNow.bind(this);
    this.moveBlindsToFinalPosition = this.moveBlindsToFinalPosition.bind(this);
  }

  moveBlindsToPosition = async (params: MoveBlindsToPositionParams) => {
    return new Promise((resolve: (delays: number[]) => void) => {
      const debounceDelay = 500;
      this.runCommands.push(params);

      if (this.runDebounceTimer) {
        clearTimeout(this.runDebounceTimer);
      }
      this.runDebounceTimer = setTimeout(() => {
        this.platform.logger.debug(
          `🤖 Nothing received for ${debounceDelay}ms, collected commands: [${this.runCommands.map(
            (rc) => rc.value,
          )}]`,
        );
        this.runDebounceTimer = null;
        this.commandsExecuting = true;
        const promises = this.runCommands.map(async (command, index) => {
          const additionalDelay = 600;
          const delay = index * additionalDelay;
          const movingDelay = await this.moveBlindsToPositionNow(
            command,
            delay,
          );
          this.resetTiltButtonsAfterDelay(
            command.platformAccessory,
            movingDelay,
          );
          return movingDelay;
        });
        Promise.all(promises).then((delays) => {
          this.platform.logger.debug(
            `✅ All commands executed!, collected delays: ${JSON.stringify(
              delays.flat(),
            )}`,
          );
          this.runCommands = [];
          this.commandsExecuting = false;
          resolve(delays.flat() as unknown as number[]);
        });
        this.runCommands = [];
      }, debounceDelay);
    });
  };

  resetTiltButtonsAfterDelay = async (
    accessory: PlatformWindowCoveringAccessory,
    delay: number,
  ) => {
    await sleep(delay + 1000);
    accessory.resetTiltPositions();
  };

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
      const [_searchDescription, _typeQuery, actionUuid] =
        identifier.split(":");

      if (this.activeTimers.has(actionUuid)) {
        this.platform.logger.debug(
          ` > 🕰️ Clear active timer for "${actionUuid}"`,
        );
        clearTimeout(this.activeTimers.get(actionUuid));
        this.activeTimers.delete(actionUuid);
      } else {
        this.platform.logger.debug(
          ` > 🕰️ No active timer for "${actionUuid}", ${JSON.stringify(
            this.activeTimers.get(actionUuid),
          )}`,
        );
      }

      let delay = 0;
      const { blindsTiming, blindsMaxPosition } = accessory.context.device;
      const maxPosition = parseInt(blindsMaxPosition || "100", 10);
      const timing = isNaN(parseInt(blindsTiming, 10))
        ? getBlindsTiming(
            blindsTiming as BlindsTimingVariant,
            this.platform.config,
          )
        : parseInt(blindsTiming, 10);
      const timingUp = getBlindsTiming(
        blindsTiming as BlindsTimingVariant,
        this.platform.config,
        "up",
      );

      const blindsType: BlindsType = blindsTiming?.includes("awning")
        ? "awning"
        : "blinds";

      if (maxPosition < 100) {
        value = Math.round((value * maxPosition) / 100);
      }
      if (value > maxPosition) {
        value = maxPosition;
      }

      const steps = value - states.Position;
      const isMovingDown = steps > 0;

      const isPositionStateChanged = isMovingDown
        ? states.PositionState !==
          this.platform.Characteristic.PositionState.INCREASING
        : states.PositionState !==
          this.platform.Characteristic.PositionState.DECREASING;

      const isAlreadyRunning =
        states.PositionState !==
        this.platform.Characteristic.PositionState.STOPPED;
      if (isAlreadyRunning && isPositionStateChanged) {
        this.platform.logger.debug(
          `   🔥 Blinds "${
            accessory.context.device.name
          }" are already running and will have a new direction, stop them! ${JSON.stringify(
            { isMovingDown, PositionState: states.PositionState },
          )}`,
        );
        await sendCommand(this.platform, identifier, ["FullDown"]);
        await sleep(500);
      } else if (isAlreadyRunning && !isPositionStateChanged) {
        this.platform.logger.debug(
          `   👌 Blinds "${accessory.context.device.name}" are already running in the correct direction, do not stop them!`,
        );
      }

      const stepsToTarget = toPositive(steps);
      const targetIsFullyDownOrUp =
        value === 0 || (value === 100 && tilt === "closed");

      if (stepsToTarget > 0) {
        if (!targetIsFullyDownOrUp) {
          // calculate exact delay to reach "stepsToTarget"
          delay = Math.floor(
            stepsToTarget * ((isMovingDown ? timing : timingUp) / 100) * 1000,
          );
        }
        const { name } = accessory.context.device;
        this.platform.logger.info(
          `🕹️ Move jalousie "${name}" from ${states.Position}% to ${value}% (${tilt}), wait ${delay}ms to reach position`,
        );

        states.TargetPosition = value;
        if (!isAlreadyRunning) {
          const jsError = await this.sendMoveJalousieCommand(
            platformAccessory,
            true,
            isMovingDown ? "FullDown" : "FullUp",
          );

          if (jsError) {
            this.platform.logger.error(
              `Error in sendCommand: ${jsError as string}`,
            );
          }
        }

        if (delay > 0) {
          const newTimer = setTimeout(
            (() => {
              this.moveBlindsToFinalPosition({
                platformAccessory,
                isMovingDown,
                tilt,
                blindsType,
              });
              this.activeTimers.delete(actionUuid);
            }).bind(this),
            delay,
          );
          this.activeTimers.set(actionUuid, newTimer);
          this.platform.logger.debug(
            ` > 🕰️ Set timer for "${actionUuid}" to ${delay}ms, ${JSON.stringify(
              this.activeTimers.has(actionUuid),
            )}`,
          );
        }
      } else {
        // check if blinds are in correct slat tilt angle position
        if (tilt !== states.TiltPosition) {
          this.platform.logger.debug(
            `   🕹️ Move slat tilt angle only, from "${states.TargetPosition}" to "${tilt}"`,
          );
          this.moveBlindsToFinalPosition({
            platformAccessory,
            isMovingDown: true,
            tilt,
            blindsType,
          });
        } else {
          this.platform.logger.debug(
            `   👍 Nothing to do, the blinds are already at position ${value}`,
          );
        }
      }

      return delay;
    } catch (e) {
      this.platform.logger.error(`Error in moveBlindsToPositionNow: ${e}`);
      return 0;
    }
  };

  moveBlindsToFinalPosition = async ({
    platformAccessory,
    isMovingDown,
    tilt,
    blindsType,
  }: MoveBlindsToFinalPositionParams) => {
    const { accessory } = platformAccessory;
    const { name } = accessory.context.device;
    await sleep(800);
    this.platform.logger.debug(
      `   🎯 Control blinds slat tilt angle of "${name}" to final position "${JSON.stringify(
        {
          tilt,
          isMovingDown,
          currPos: platformAccessory.getPositionState(),
        },
      )}"`,
    );

    if (platformAccessory.getPositionState() !== 2) {
      // Stop the blinds now at reached position (more or less :D)
      await this.sendMoveJalousieCommand(
        platformAccessory,
        false,
        isMovingDown ? "FullDown" : "FullUp",
      );
      await sleep(500);
    }
    if (blindsType === "awning") {
      return;
    }

    if (isMovingDown) {
      if (tilt === "closed") {
        this.platform.logger.debug(
          "   👍 Nothing to do, the blinds are already closed",
        );
        return;
      } else if (tilt === "tilted") {
        this.platform.logger.debug(
          `   🕹️ Double click "up" button with delay of 300ms (tilt=${tilt})})`,
        );
        await this.sendMoveJalousieCommand(platformAccessory, true, "FullUp");
        await sleep(300);
        await this.sendMoveJalousieCommand(platformAccessory, false, "FullUp");
      } else if (tilt === "open") {
        this.platform.logger.debug(
          `   🕹️ Double click "up" button with delay of 1000ms (tilt=${tilt})})`,
        );
        await this.sendMoveJalousieCommand(platformAccessory, true, "FullUp");
        await sleep(1000);
        await this.sendMoveJalousieCommand(platformAccessory, false, "FullUp");
      }
    } else {
      if (tilt === "closed") {
        this.platform.logger.debug(
          `   🕹️ Double click "down" button with delay of 1000ms (tilt=${tilt})})`,
        );
        await this.sendMoveJalousieCommand(platformAccessory, true, "FullDown");
        await sleep(1000);
        await this.sendMoveJalousieCommand(
          platformAccessory,
          false,
          "FullDown",
        );
      } else if (tilt === "tilted") {
        this.platform.logger.debug(
          `   🕹️ Double click "down" button with delay of 600ms (tilt=${tilt})})`,
        );
        await this.sendMoveJalousieCommand(platformAccessory, true, "FullDown");
        await sleep(600);
        await this.sendMoveJalousieCommand(
          platformAccessory,
          false,
          "FullDown",
        );
      } else if (tilt === "open") {
        this.platform.logger.debug(
          "   👍 Nothing to do, the blinds are already open",
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
    const jsError = await sendCommand(
      this.platform,
      platformAccessory.identifier,
      [command],
    );

    return jsError;
  };
}
