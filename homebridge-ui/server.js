/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-var-requires */
const {
  HomebridgePluginUiServer,
  RequestError,
} = require("@homebridge/plugin-ui-utils");
const { existsSync } = require("fs");
const { readFile } = require("fs/promises");
const { resolve } = require("path");

class PluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    // super() MUST be called first
    super();

    // this MUST be called when you are ready to accept requests
    this.ready();
  }
}

(() => {
  return new PluginUiServer();
})();
