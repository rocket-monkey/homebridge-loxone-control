import { BlindsTilt } from "../types.js";

/**
 * Parse tilt position from Loxone stateText (supports English and German).
 *
 * English:
 *   "slats are horizontal" → closed
 *   "slats are in shading position" / "shading" → tilted
 *   "slats are vertical" → open
 *
 * German:
 *   "horizontale Lamellen" → closed
 *   "Lamellen auf Beschattung" → tilted
 *   "vertikale Lamellen" → open
 */
export const getTiltPositionFromStateText = (
  stateText: string | undefined,
  log?: (msg: string) => void,
): BlindsTilt => {
  if (!stateText) {
    return "closed";
  }

  const text = stateText.toLowerCase();

  let result: BlindsTilt;
  if (text.includes("vertical") || text.includes("vertikale")) {
    result = "open";
  } else if (text.includes("shading") || text.includes("beschattung")) {
    result = "tilted";
  } else if (text.includes("horizontal") || text.includes("horizontale")) {
    result = "closed";
  } else {
    result = "closed";
  }

  if (log) {
    log(`🔍 stateText: "${stateText}" → ${result}`);
  }

  return result;
};
