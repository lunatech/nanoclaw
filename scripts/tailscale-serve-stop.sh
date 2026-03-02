#!/bin/bash
# Stop tailscale serve for inject endpoint

echo "tailscale-serve-stop: resetting tailscale serve config"
exec tailscale serve reset
