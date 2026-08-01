/* eslint-disable @typescript-eslint/no-explicit-any */
import { LoxoneControlPlatform } from "../../platform.js";

export const sendCommand = async (
  platform: LoxoneControlPlatform,
  ...args: any[]
) => {
  platform.logger.debug(
    `   🔌 sendCommand over websocket: ${JSON.stringify(args)}`
  );
  const webinterface = platform.getLoxoneWebinterfaceInstance();
  if (!webinterface) {
    return null;
  }
  const jsError = await webinterface
    .safeEvaluate((passedIdentifier: string, ...passedArgs) => {
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

export const sendCommandSafe = async (
  platform: LoxoneControlPlatform,
  ...args: any[]
) => {
  const jsError = await sendCommand(platform, ...args);
  if (jsError) {
    platform.logger.error(`Error in sendCommand: ${jsError}`);
  }
  // NOTE: deliberately does NOT arm the command-echo watchdog. Plenty of
  // commands here produce no status update at all, and arming on those would
  // fire a bogus recovery ~3s later:
  //   - no-ops, where the target value already equals the current one
  //     ("fan from Off to Off" — light/fan setOn send these; outlet guards)
  //   - momentary / stateless commands: stop, FullUp, FullDown, shade, auto,
  //     NoAuto, the central pushbuttons, and the /api/debug probes. FullUp on
  //     an already-retracted blind moves nothing (platform.ts even sends
  //     FullUp twice in a row, so the second is silent by construction).
  // Arming is therefore OPT-IN via AccessoryBase.expectEcho(), called only
  // where the caller has just proven a real state delta. Fail-safe by design:
  // a missed arm costs nothing (the socket-close and silence watchdogs still
  // cover it), while a wrong arm would cost a needless recovery.
};
