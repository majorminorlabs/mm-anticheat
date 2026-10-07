#!/bin/sh
exec "${ANTICHEAT_PYTHON:-python3}" -I -m mm_anticheat.hooks --agent claude
