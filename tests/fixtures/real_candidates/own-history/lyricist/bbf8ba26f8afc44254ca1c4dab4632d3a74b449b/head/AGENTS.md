# Lyricist experiment

Treat `lyrics/*.md` as immutable source data. Never put corpus text in a public issue, report, or remote repository. Regenerate derived files with `python -m scripts.pipeline`. Split by complete work only; evaluation prompts must never be used as training examples. Keep RunPod credentials outside the repository. Do not push or publish this private experiment. Test with `python -m pytest` before a training run.
