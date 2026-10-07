# Data

`raw/` is a local cache of public source downloads and is ignored by git. `generated/` contains derived structured examples and validation/evaluation reports. Every derived release must point to a provenance entry in `manifests/public_sources.json` and carry a version and content hash.

The initial source is SciFact. Its dataset card describes 1.4K expert-written scientific claims paired with evidence-containing abstracts and gives the dataset license as CC BY-NC 2.0. This repository uses it only as labeled public evidence material; it does not claim that SciFact or its underlying articles are Apache-2.0.

The pipeline intentionally preserves source IDs and sentence-level evidence. Future additions should be rejected when license, redistribution, or transformation rights are unclear.

