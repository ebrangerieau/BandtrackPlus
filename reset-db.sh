#!/bin/bash
set -euo pipefail

rm -f bandtrack.db
npm run migrate
