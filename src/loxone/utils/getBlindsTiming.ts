import { PlatformConfig } from "homebridge";
import { BlindsTimingVariant } from "../types.js";

export const LoggiaRolloTiming = 58;
export const WindowRolloTiming = 40;
export const MarkiseTiming = 23;

export const getBlindsTiming = (
  rolloType: BlindsTimingVariant,
  config: PlatformConfig,
  variant: "up" | "down" = "down"
) => {
  switch (rolloType) {
    case "window-big": {
      if (config.blindsTimingWindowBig && variant === "down") {
        return parseInt(config.blindsTimingWindowBig, 10);
      }
      if (config.blindsTimingUpWindowBig && variant === "up") {
        return parseInt(config.blindsTimingUpWindowBig, 10);
      }
      return LoggiaRolloTiming;
    }
    case "awning": {
      if (config.blindsTimingAwning && variant === "down") {
        return parseInt(config.blindsTimingAwning, 10);
      }
      if (config.blindsTimingUpAwning && variant === "up") {
        return parseInt(config.blindsTimingUpAwning, 10);
      }
      return MarkiseTiming;
    }
    default: {
      if (config.blindsTimingWindow && variant === "down") {
        return parseInt(config.blindsTimingWindow, 10);
      }
      if (config.blindsTimingUpWindow && variant === "up") {
        return parseInt(config.blindsTimingUpWindow, 10);
      }
      return WindowRolloTiming;
    }
  }
};
