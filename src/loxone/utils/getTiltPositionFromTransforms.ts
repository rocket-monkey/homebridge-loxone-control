import { BlindsTilt } from "../types.js";

/**
 * Parse tilt position from Loxone stateText.
 * Loxone reports slat state in German text:
 *   "horizontale Lamellen" → closed
 *   "Lamellen auf Beschattung" → tilted (shading)
 *   "vertikale Lamellen" → open
 */
export const getTiltPositionFromStateText = (
  stateText: string | undefined,
  log?: (msg: string) => void,
): BlindsTilt => {
  if (!stateText) {
    return "closed";
  }

  let result: BlindsTilt;
  if (stateText.includes("vertikale Lamellen")) {
    result = "open";
  } else if (stateText.includes("Lamellen auf Beschattung")) {
    result = "tilted";
  } else {
    result = "closed";
  }

  if (log) {
    log(`🔍 stateText: "${stateText}" → ${result}`);
  }

  return result;
};
