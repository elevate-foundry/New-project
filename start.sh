#!/bin/bash

# Kill any process using port 3000
lsof -ti:3000 | xargs kill -9 2>/dev/null || true

# Start the server
npm start
