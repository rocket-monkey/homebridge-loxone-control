import { LoxoneControlPlatform } from "../../platform.js";

export const sendCommand = async (
  platform: LoxoneControlPlatform,
  ...args: any[]
) => {
  platform.log.debug(
    `   🔌 sendCommand over websocket: ${JSON.stringify(args)}`
  );
  const jsError = await platform
    .getLoxoneWebinterface()
    ?.evaluate((passedIdentifier: string, ...passedArgs) => {
      try {
        // @ts-expect-error patched
        const control = window.collection.find((c) => {
          const currentIdentifier = `${
            c.searchDescription || "unknown • unknown"
          }:type=${c.type}:${c.uuidAction}`;
          return currentIdentifier === passedIdentifier;
        });
        if (control) {
          // eslint-disable-next-line prefer-spread
          control._sendCommand.apply(control, passedArgs);
        } else {
          return "Control not found!";
        }
        return null;
      } catch (e) {
        return e;
      }
    }, ...args);
  return jsError;
};
