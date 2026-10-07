# Frozen benchmark controller

Benchmark v1.0 through v1.0.3 validate the controller tree hash recorded in
their immutable manifests. Production controller development must not change
that historical source tree in place.

The v1.0.3 frozen controller snapshot is kept outside both repositories at:

```text
/Volumes/External/GitHub/IGNORED/anyways-controller-frozen-v1.0.3
```

Validate the historical benchmark environment with:

```sh
cd /Volumes/External/GitHub/IGNORED/anyways
node bin/validate-frozen-benchmark.mjs
```

To use another independently preserved snapshot, set
`ANYWAYS_FROZEN_CONTROLLER_ROOT`. The command validates v1.0, v1.0.1, v1.0.2,
and v1.0.3 against the supplied controller tree without changing benchmark
manifests or historical artifacts.
