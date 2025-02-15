import { BlindsTilt } from "../types.js";
import { toPositive } from "./toPositive.js";

export const getTiltPositionFromTransforms = (transformations: {
  [key: string]: string;
}) => {
  if (!transformations) {
    return "closed" as BlindsTilt;
  }
  const tranforms = {
    jalStatsVertical: toPositive(
      transformations["jal_slats_vertical"]
        ? parseFloat(transformations["jal_slats_vertical"].split(",")[1])
        : -20
    ),
    jalStatsHorizontal: toPositive(
      transformations["jal_slats_horizontal"]
        ? parseFloat(transformations["jal_slats_horizontal"].split(",")[1])
        : -20
    ),
    jalStatsShading: toPositive(
      transformations["jal_slats_shading"]
        ? parseFloat(transformations["jal_slats_shading"].split(",")[1])
        : -20
    ),
  };

  if (tranforms.jalStatsVertical === 0) {
    return "closed" as BlindsTilt;
  } else if (tranforms.jalStatsShading !== 20) {
    return "tilted" as BlindsTilt;
  } else if (tranforms.jalStatsHorizontal !== 20) {
    return "open" as BlindsTilt;
  }
  return "closed" as BlindsTilt;
};
