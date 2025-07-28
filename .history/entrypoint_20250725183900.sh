#!/usr/bin/env sh
set -e

# 1) Start your server in the background
node server.js &

# 2) Wait a moment for your app to bind to port 3000
sleep 2

# 3) Launch LocalTunnel on port 3000 with your desired subdomain
#    Replace "myflyfonebot" with the name you want.
lt --port 6565 --subdomain myflyfonebot

# If lt exits, we'll bring the whole container down
wait

