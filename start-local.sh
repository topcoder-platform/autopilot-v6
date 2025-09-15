#!/bin/bash

# A robust way to load variables from .env file for the script's environment.
# It handles comments and empty lines, and works across different shells.
if [ -f .env ]; then
  set -o allexport
  source .env
  set +o allexport
fi

# Set/override development-specific variables.
# This uses the value from .env if present, otherwise defaults to the value after ':-'.
export NODE_ENV=${NODE_ENV:-development}
export LOG_LEVEL=${LOG_LEVEL:-debug}

# Start the application using ts-node-dev
echo "Starting application in development mode..."
mkdir -p logs
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
npm run start:dev 2>&1 | tee logs/app_${TIMESTAMP}.log
