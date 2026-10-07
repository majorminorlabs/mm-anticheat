"""NVIDIA-ready QLoRA SFT entry point; requires the optional ml dependencies."""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from research_model.research_protocol.protocol import build_prompt


def main() -> int:
    parser = argparse.ArgumentParser(); parser.add_argument("--config", required=True); args = parser.parse_args()
    try:
        import torch
        from datasets import Dataset
        from peft import LoraConfig
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, TrainingArguments
        from trl import SFTTrainer
    except ImportError as exc:
        raise SystemExit("Install the ml extra before training: uv sync --extra ml") from exc
    import tomllib
    with open(args.config, "rb") as handle: config = tomllib.load(handle)
    random.seed(config["seed"]); data = [json.loads(line) for line in Path(config["dataset_path"]).read_text(encoding="utf-8").splitlines() if line.strip()]
    train = [row for row in data if row.get("split") == "train"]; validation = [row for row in data if row.get("split") == "validation"]
    def text(row: dict) -> str:
        return build_prompt(row["question"], row.get("context", ""), row["task_type"]) + "\n" + json.dumps(row["expected_output"], ensure_ascii=False)
    train_ds = Dataset.from_list([{"text": text(row)} for row in train]); val_ds = Dataset.from_list([{"text": text(row)} for row in validation])
    tokenizer = AutoTokenizer.from_pretrained(config["base_model"]); bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True) if config.get("load_in_4bit") else None
    model = AutoModelForCausalLM.from_pretrained(config["base_model"], device_map="auto", torch_dtype=torch.bfloat16, quantization_config=bnb)
    lora = LoraConfig(r=config["lora_r"], lora_alpha=config["lora_alpha"], lora_dropout=config["lora_dropout"], target_modules=config["lora_target_modules"], task_type="CAUSAL_LM")
    train_args = TrainingArguments(output_dir=config["output_dir"], seed=config["seed"], num_train_epochs=config["num_train_epochs"], per_device_train_batch_size=config["per_device_train_batch_size"], gradient_accumulation_steps=config["gradient_accumulation_steps"], learning_rate=config["learning_rate"], warmup_ratio=config["warmup_ratio"], weight_decay=config["weight_decay"], lr_scheduler_type=config["lr_scheduler_type"], logging_steps=config["logging_steps"], save_strategy=config["save_strategy"], bf16=config["bf16"], gradient_checkpointing=config["gradient_checkpointing"], report_to="none")
    trainer = SFTTrainer(model=model, args=train_args, train_dataset=train_ds, eval_dataset=val_ds, peft_config=lora, processing_class=tokenizer, max_seq_length=config["max_seq_length"]); trainer.train(); trainer.save_model(config["output_dir"])
    Path(config["output_dir"], "training_config.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8"); return 0


if __name__ == "__main__": raise SystemExit(main())
