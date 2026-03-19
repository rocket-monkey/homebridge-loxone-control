#!/bin/bash
# Link the pre-installed plugin into the Homebridge plugin directory
# This runs as a cont-init script before Homebridge starts
PLUGIN_SRC="/opt/homebridge-plugins/node_modules/homebridge-loxone-control"
PLUGIN_DST="/var/lib/homebridge/node_modules/homebridge-loxone-control"

# Create the target node_modules if it doesn't exist yet
mkdir -p /var/lib/homebridge/node_modules

if [ ! -e "$PLUGIN_DST" ]; then
  echo "Linking homebridge-loxone-control plugin..."
  ln -s "$PLUGIN_SRC" "$PLUGIN_DST"
fi
