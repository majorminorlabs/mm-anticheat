#!/bin/sh
exec "${GOODHART_PYTHON:-python3}" -I -m goodhart.hooks --agent codex
