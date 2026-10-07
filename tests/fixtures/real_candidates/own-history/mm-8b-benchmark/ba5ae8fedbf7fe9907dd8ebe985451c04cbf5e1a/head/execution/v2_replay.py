"""Future-only V2 collector entry point. Do not use on historical evidence."""

import pathlib
import json
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "frozen_reference"))
sys.path.insert(0, str(ROOT))

from execution import frozen_replay  # noqa: E402
from scoring.v2.future_simulator import SimulatorV2  # noqa: E402
from scoring.v2.tool_schema import tool_defs_v2  # noqa: E402

frozen_replay.Simulator = SimulatorV2
frozen_replay.tool_defs = tool_defs_v2

if __name__ == "__main__":
    frozen_replay.main()
    # The collector's append-only raw files retain their original format;
    # a separate marker makes the forward simulator/tool contract explicit.
    output = pathlib.Path(sys.argv[sys.argv.index("--output") + 1])
    marker = {"benchmark_task_version": "v2.0.0", "scorer_version": "v2.0.0",
              "simulator_version": "v2.0.0", "runner": "execution/v2_replay.py"}
    (output / "v2-version.json").write_text(json.dumps(marker, indent=2, sort_keys=True) + "\n")
