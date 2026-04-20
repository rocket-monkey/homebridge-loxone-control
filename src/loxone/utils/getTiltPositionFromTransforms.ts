import { BlindsTilt } from "../types.js";

/**
 * Parse tilt position from Loxone stateText (supports English and German).
 *
 * Physical convention (verified empirically on Jalousie hardware):
 *   vertical   = slats rotated to block light   → closed
 *   horizontal = slats rotated to let light through → open
 *   tilted / shading = ~45° intermediate         → tilted
 *
 * Loxone firmware now emits "tilted" (older versions: "shading" / "Beschattung"),
 * both are accepted.
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
    result = "closed";
  } else if (text.includes("tilted") || text.includes("shading") || text.includes("beschattung")) {
    result = "tilted";
  } else if (text.includes("horizontal") || text.includes("horizontale")) {
    result = "open";
  } else {
    result = "closed";
  }

  if (log) {
    log(`🔍 stateText: "${stateText}" → ${result}`);
  }

  return result;
};
