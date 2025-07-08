/* eslint-disable @typescript-eslint/no-explicit-any */
import { LoxoneControlPlatform } from "../../platform.js";

export const sendCommand = async (
  platform: LoxoneControlPlatform,
  ...args: any[]
) => {
  platform.logger.debug(
    `   🔌 sendCommand over websocket: ${JSON.stringify(args)}`
  );
  const jsError = await platform
    .getLoxoneWebinterface()
    ?.evaluate((passedIdentifier: string, ...passedArgs) => {
      try {
        // @ts-expect-error patched
        let control = window.collection.find((c) => {
          const currentIdentifier = `${
            c.searchDescription || "unknown • unknown"
          }:type=${c.type}:${c.uuidAction}`;
          return currentIdentifier === passedIdentifier;
        });
        
        if (!control) {
          // Fallback: try to match by type and UUID suffix when full identifier doesn't match
          // This handles the case where config uses German room names but Loxone uses UUID room names
          const identifierParts = passedIdentifier.split(":");
          if (identifierParts.length === 3) {
            const [, typeQuery, actionUuid] = identifierParts;
            const type = typeQuery.split("=")[1];
            
            // @ts-expect-error patched
            control = window.collection.find((c: any) => {
              return c.type === type && c.uuidAction === actionUuid;
            });
          }
        }
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
