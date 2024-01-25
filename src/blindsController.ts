/* eslint-disable indent */
import { BlindsTilt, BlindsTimingVariant, BlindsType } from "./loxone/types";
import { getBlindsTiming } from "./loxone/utils/getBlindsTiming";
import { sendCommand } from "./loxone/utils/sendCommand";
import { sleep } from "./loxone/utils/sleep";
import { toPositive } from "./loxone/utils/toPositive";
import { LoxoneControlPlatform } from "./platform";
import { PlatformWindowCoveringAccessory } from "./platformWindowCoveringAccessory";

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
  private activeTimers: {
    [identifier: string]: NodeJS.Timeout | undefined;
  } = {};

  private runCommands: MoveBlindsToPositionParams[] = [];
  private runDebounceTimer: NodeJS.Timeout | null = null;
  public commandsExecuting = false;

  constructor(public readonly platform: LoxoneControlPlatform) {
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
        this.platform.log.debug(
          `🤖 Nothing received for ${debounceDelay}ms, collected commands: [${this.runCommands.map(
            (rc) => rc.value
          )}]`
        );
        this.runDebounceTimer = null;
        this.commandsExecuting = true;
        const promises = this.runCommands.map(async (command, index) => {
          const additionalDelay = 600;
          const delay = index * additionalDelay;
          const delays = await this.moveBlindsToPositionNow(command, delay);
          command.platformAccessory.resetTiltPositions();
          return delays;
        });
        Promise.all(promises).then((delays) => {
          this.platform.log.debug(
            `✅ All commands executed!, collected delays: ${JSON.stringify(
              delays.flat()
            )}`
          );
          this.runCommands = [];
          this.commandsExecuting = false;
          resolve(delays.flat() as unknown as number[]);
        });
        this.runCommands = [];
      }, debounceDelay);
    });
  };

  moveBlindsToPositionNow = async (
    { value, platformAccessory }: MoveBlindsToPositionParams,
    waitBeforeExecute = 0
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

      const isAlreadyRunning = states.PositionState !== 2;
      if (isAlreadyRunning) {
        this.platform.log.debug(
          `   🔥 Blinds "${accessory.context.device.name}" are already running, stop them!`
        );
        await sendCommand(this.platform, identifier, ["FullDown"]);
        await sleep(500);
      }

      let delay = 0;
      const { blindsTiming, blindsMaxPosition } = accessory.context.device;
      const maxPosition = parseInt(blindsMaxPosition || "100", 10);
      const timing = isNaN(parseInt(blindsTiming, 10))
        ? getBlindsTiming(
            blindsTiming as BlindsTimingVariant,
            this.platform.config
          )
        : parseInt(blindsTiming, 10);
      const timingUp = getBlindsTiming(
        blindsTiming as BlindsTimingVariant,
        this.platform.config,
        "up"
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
      const stepsToTarget = toPositive(steps);
      const targetIsFullyDownOrUp =
        value === 0 || (value === 100 && tilt === "closed");

      if (stepsToTarget > 0) {
        if (this.activeTimers[identifier]) {
          this.platform.log.debug(
            `   🚨 Clear active timer for "${identifier}"`
          );
          clearTimeout(this.activeTimers[identifier]);
          this.activeTimers[identifier] = undefined;
        }

        if (!targetIsFullyDownOrUp) {
          // calculate exact delay to reach "stepsToTarget"
          delay = Math.floor(
            stepsToTarget * ((isMovingDown ? timing : timingUp) / 100) * 1000
          );
        }
        const { name } = accessory.context.device;
        this.platform.log.info(
          `🕹️ Move jalousie "${name}" from ${states.Position}% to ${value}% (${tilt}), wait ${delay}ms to reach position`
        );

        states.TargetPosition = value;
        const jsError = await this.sendMoveJalousieCommand(
          platformAccessory,
          true,
          isMovingDown ? "FullDown" : "FullUp"
        );

        if (jsError) {
          this.platform.log.error(`Error in sendCommand: ${jsError as string}`);
        }

        if (delay > 0) {
          this.activeTimers[identifier] = setTimeout(
            (() => {
              this.activeTimers[identifier] = undefined;
              this.moveBlindsToFinalPosition({
                platformAccessory,
                isMovingDown,
                tilt,
                blindsType,
              });
            }).bind(this),
            delay
          );
        }
      } else {
        // check if blinds are in correct slat tilt angle position
        if (tilt !== states.TiltPosition) {
          this.platform.log.debug(
            `   🕹️ Move slat tilt angle only, from "${states.TargetPosition}" to "${tilt}"`
          );
          this.moveBlindsToFinalPosition({
            platformAccessory,
            isMovingDown: true,
            tilt,
            blindsType,
          });
        } else {
          this.platform.log.debug(
            `   👍 Nothing to do, the blinds are already at position ${value}`
          );
        }
      }

      return delay;
    } catch (e) {
      this.platform.log.error(`Error in moveBlindsToPositionNow: ${e}`);
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
    this.platform.log.debug(
      `   🎯 Control blinds slat tilt angle of "${name}" to final position "${JSON.stringify(
        {
          tilt,
          isMovingDown,
          currPos: platformAccessory.getPositionState(),
        }
      )}"`
    );

    if (platformAccessory.getPositionState() !== 2) {
      // Stop the blinds now at reached position (more or less :D)
      await this.sendMoveJalousieCommand(
        platformAccessory,
        false,
        isMovingDown ? "FullDown" : "FullUp"
      );
      await sleep(500);
    }
    if (blindsType === "awning") {
      return;
    }

    if (isMovingDown) {
      if (tilt === "closed") {
        this.platform.log.debug(
          `   👍 Nothing to do, the blinds are already closed`
        );
        return;
      } else if (tilt === "tilted") {
        this.platform.log.debug(
          `   🕹️ Double click "up" button with delay of 300ms (tilt=${tilt})})`
        );
        await this.sendMoveJalousieCommand(platformAccessory, true, "FullUp");
        await sleep(300);
        await this.sendMoveJalousieCommand(platformAccessory, false, "FullUp");
      } else if (tilt === "open") {
        this.platform.log.debug(
          `   🕹️ Double click "up" button with delay of 1000ms (tilt=${tilt})})`
        );
        await this.sendMoveJalousieCommand(platformAccessory, true, "FullUp");
        await sleep(1000);
        await this.sendMoveJalousieCommand(platformAccessory, false, "FullUp");
      }
    } else {
      if (tilt === "closed") {
        this.platform.log.debug(
          `   🕹️ Double click "down" button with delay of 1000ms (tilt=${tilt})})`
        );
        await this.sendMoveJalousieCommand(platformAccessory, true, "FullDown");
        await sleep(1000);
        await this.sendMoveJalousieCommand(
          platformAccessory,
          false,
          "FullDown"
        );
      } else if (tilt === "tilted") {
        this.platform.log.debug(
          `   🕹️ Double click "down" button with delay of 600ms (tilt=${tilt})})`
        );
        await this.sendMoveJalousieCommand(platformAccessory, true, "FullDown");
        await sleep(600);
        await this.sendMoveJalousieCommand(
          platformAccessory,
          false,
          "FullDown"
        );
      } else if (tilt === "open") {
        this.platform.log.debug(
          `   👍 Nothing to do, the blinds are already open`
        );
        return;
      }
    }
  };

  sendMoveJalousieCommand = async (
    platformAccessory: PlatformWindowCoveringAccessory,
    shouldMove: boolean,
    command = "FullDown",
    failOver = 0
  ) => {
    if (failOver > 1) {
      return;
    }
    const jsError = await sendCommand(
      this.platform,
      platformAccessory.identifier,
      [command]
    );

    return jsError;
  };
}
