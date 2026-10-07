# Resource record contract

Each candidate run records a pre-inference baseline and sustained-run
snapshots. Required fields are available system memory, total swap used,
model-attributable/inference swap when measurable, model/process RSS when
measurable, and Vulkan/shared-memory observations when measurable.

`runner.resource.eligibility()` applies the frozen floor: available memory
must remain at least 5.0 GiB, model-attributable swap must be zero, and no
memory-related instability may occur. Baseline swap is retained separately.
