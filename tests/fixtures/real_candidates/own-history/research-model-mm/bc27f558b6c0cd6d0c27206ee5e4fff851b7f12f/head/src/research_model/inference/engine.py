from __future__ import annotations

import json
import re
from typing import Any

from ..research_protocol.protocol import SYSTEM_INSTRUCTION, build_prompt


class ProtocolOutputError(ValueError):
    def __init__(self, message: str, raw_output: str):
        super().__init__(message)
        self.raw_output = raw_output


def _parse_protocol_output(text: str, backend_name: str) -> dict[str, Any]:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ProtocolOutputError(f"{backend_name} model did not return a JSON object", text)
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError as exc:
        raise ProtocolOutputError(f"{backend_name} model returned invalid JSON: {exc}", text) from exc
    if not isinstance(parsed, dict):
        raise ProtocolOutputError(f"{backend_name} model returned a non-object JSON value", text)
    return parsed


class HeuristicBackend:
    name = "heuristic-protocol-baseline"

    def generate(self, question: str, context: str = "", task_type: str = "research_plan", **_: Any) -> dict[str, Any]:
        del task_type
        source_ids = re.findall(r"scifact:\d+", context); has_evidence = bool(re.search(r"\[\d+\]", context)); query = " ".join(question.replace("?", "").split()[:12])
        return {"state": "evidence_review" if context else "planning", "action": "EXTRACT" if has_evidence and context else "SEARCH", "query": None if has_evidence else query, "source_ids": source_ids[:1] if has_evidence else [], "claims": [], "evidence": [], "gaps": [] if has_evidence else ["Primary evidence has not been retrieved."], "confidence": "unknown", "next_action": "SYNTHESIZE" if has_evidence else "READ"}

    def generate_text(self, prompt: str, **_: Any) -> str:
        del prompt
        return ""

    def generate_freeform_text(self, prompt: str, **kwargs: Any) -> str:
        return self.generate_text(prompt, **kwargs)


class TransformersBackend:
    name = "transformers"

    def __init__(
        self,
        model_name: str,
        device: str | None = None,
        load_in_4bit: bool = False,
        adapter_path: str | None = None,
        model_revision: str | None = None,
        tokenizer_revision: str | None = None,
    ) -> None:
        try:
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
        except ImportError as exc:
            raise RuntimeError("Install the ml extra to use the Transformers backend") from exc
        self.torch = torch
        self.model_name = model_name
        self.model_revision = model_revision
        self.tokenizer_revision = tokenizer_revision or model_revision
        self.adapter_path = adapter_path
        tokenizer_kwargs: dict[str, Any] = {}
        if tokenizer_revision or model_revision:
            tokenizer_kwargs["revision"] = tokenizer_revision or model_revision
        self.tokenizer = AutoTokenizer.from_pretrained(model_name, **tokenizer_kwargs)

        kwargs: dict[str, Any] = {"torch_dtype": "auto"}
        if model_revision:
            kwargs["revision"] = model_revision
        if load_in_4bit:
            if not torch.cuda.is_available():
                raise RuntimeError("4-bit Transformers evaluation requires CUDA; refusing a CPU fallback")
            if not torch.cuda.is_bf16_supported():
                raise RuntimeError("the frozen QLoRA evaluation recipe requires CUDA BF16 support")
            kwargs["device_map"] = {"": torch.cuda.current_device()}
            kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.bfloat16,
                bnb_4bit_use_double_quant=True,
            )
        elif device:
            kwargs["device_map"] = device
        elif torch.cuda.is_available():
            kwargs["device_map"] = "auto"

        self.model = AutoModelForCausalLM.from_pretrained(model_name, **kwargs)
        if adapter_path:
            try:
                from peft import PeftModel
            except ImportError as exc:
                raise RuntimeError("Install the ml extra to load a PEFT adapter") from exc
            self.model = PeftModel.from_pretrained(self.model, adapter_path)
        self.model.eval()

    def generate_text(self, prompt: str, max_new_tokens: int = 512, temperature: float = 0.0, **_: Any) -> str:
        inputs = self.tokenizer(prompt, return_tensors="pt"); device = next(self.model.parameters()).device; inputs = {key: value.to(device) for key, value in inputs.items()}
        with self.torch.no_grad():
            output = self.model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=temperature > 0, temperature=max(temperature, 0.01))
        return self.tokenizer.decode(output[0][inputs["input_ids"].shape[-1]:], skip_special_tokens=True)

    def generate_freeform_text(self, prompt: str, **kwargs: Any) -> str:
        return self.generate_text(prompt, **kwargs)

    def generate_with_raw(self, question: str, context: str = "", task_type: str = "research_plan", max_new_tokens: int = 512, temperature: float = 0.0, **_: Any) -> tuple[dict[str, Any], str]:
        text = self.generate_text(build_prompt(question, context, task_type), max_new_tokens=max_new_tokens, temperature=temperature)
        return _parse_protocol_output(text, "Transformers"), text

    def generate(self, question: str, context: str = "", task_type: str = "research_plan", max_new_tokens: int = 512, temperature: float = 0.0, **kwargs: Any) -> dict[str, Any]:
        predicted, _ = self.generate_with_raw(question, context, task_type, max_new_tokens, temperature, **kwargs)
        return predicted


class MLXBackend:
    name = "mlx"

    def __init__(self, model_name: str, adapter_path: str | None = None) -> None:
        try:
            from mlx_lm import generate, load
            from mlx_lm.generate import make_sampler
        except ImportError as exc:
            raise RuntimeError("Install the mlx extra to use the MLX backend") from exc
        self._generate = generate; self._make_sampler = make_sampler
        self.model, self.tokenizer = load(model_name, adapter_path=adapter_path)
        self.model_name = model_name
        self.adapter_path = adapter_path

    def generate_text(self, prompt: str, max_new_tokens: int = 512, temperature: float = 0.0, **_: Any) -> str:
        text = self._generate(self.model, self.tokenizer, prompt=prompt, max_tokens=max_new_tokens, sampler=self._make_sampler(temp=temperature))
        return text

    def _freeform_prompt(self, prompt: str) -> str:
        messages = [{"role": "user", "content": prompt}]
        try:
            return self.tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
        except (AttributeError, TypeError):
            return prompt

    def generate_freeform_text(self, prompt: str, max_new_tokens: int = 512, temperature: float = 0.0, **_: Any) -> str:
        return self.generate_text(self._freeform_prompt(prompt), max_new_tokens=max_new_tokens, temperature=temperature)

    def _protocol_prompt(self, question: str, context: str, task_type: str) -> str:
        messages = [{"role": "system", "content": SYSTEM_INSTRUCTION}, {"role": "user", "content": question + "\n" + context}]
        try:
            return self.tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
        except (AttributeError, TypeError):
            return build_prompt(question, context, task_type)

    def generate_with_raw(self, question: str, context: str = "", task_type: str = "research_plan", max_new_tokens: int = 512, temperature: float = 0.0, **_: Any) -> tuple[dict[str, Any], str]:
        text = self.generate_text(self._protocol_prompt(question, context, task_type), max_new_tokens=max_new_tokens, temperature=temperature)
        return _parse_protocol_output(text, "MLX"), text

    def generate(self, question: str, context: str = "", task_type: str = "research_plan", max_new_tokens: int = 512, temperature: float = 0.0, **kwargs: Any) -> dict[str, Any]:
        predicted, _ = self.generate_with_raw(question, context, task_type, max_new_tokens, temperature, **kwargs)
        return predicted


def load_backend(name: str, model: str | None = None, **kwargs: Any) -> Any:
    if name == "heuristic": return HeuristicBackend()
    if name == "transformers":
        if not model: raise ValueError("--model is required for the transformers backend")
        return TransformersBackend(model, **kwargs)
    if name == "mlx":
        if not model: raise ValueError("--model is required for the MLX backend")
        return MLXBackend(model, adapter_path=kwargs.get("adapter_path"))
    raise ValueError(f"unknown backend: {name}")
