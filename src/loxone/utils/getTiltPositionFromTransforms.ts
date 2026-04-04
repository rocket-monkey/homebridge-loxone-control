import { BlindsTilt } from "../types.js";
import { toPositive } from "./toPositive.js";

export const getTiltPositionFromTransforms = (transformations: {
  [key: string]: string;
}, log?: (msg: string) => void) => {
  if (!transformations) {
    return "closed" as BlindsTilt;
  }
  const rawV = transformations["jal_slats_vertical"];
  const rawH = transformations["jal_slats_horizontal"];
  const rawS = transformations["jal_slats_shading"];

  const tranforms = {
    jalStatsVertical: toPositive(rawV ? parseFloat(rawV.split(",")[1]) : -20),
    jalStatsHorizontal: toPositive(rawH ? parseFloat(rawH.split(",")[1]) : -20),
    jalStatsShading: toPositive(rawS ? parseFloat(rawS.split(",")[1]) : -20),
  };

  let result: BlindsTilt;
  if (tranforms.jalStatsVertical === 0) {
    result = "closed";
  } else if (tranforms.jalStatsShading !== 20) {
    result = "tilted";
  } else if (tranforms.jalStatsHorizontal !== 20) {
    result = "open";
  } else {
    result = "closed";
  }

  if (log) {
    log(`🔍 transforms: V=${rawV || "null"} H=${rawH || "null"} S=${rawS || "null"} → parsed: V=${tranforms.jalStatsVertical} H=${tranforms.jalStatsHorizontal} S=${tranforms.jalStatsShading} → ${result}`);
  }

  return result;
};
