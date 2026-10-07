from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace

import pytest

from research_model.inference.engine import ProtocolOutputError, _parse_protocol_output, load_backend


class _FakeModel:
    def __init__(self):
        self.was_evaluated = False

    def eval(self):
        self.was_evaluated = True
        return self


def _install_fake_ml_modules(monkeypatch, *, cuda_available=False):
    calls = {}

    class AutoTokenizer:
        @staticmethod
        def from_pretrained(name, **kwargs):
            calls["tokenizer"] = (name, kwargs)
            return object()

    class AutoModelForCausalLM:
        @staticmethod
        def from_pretrained(name, **kwargs):
            calls["model"] = (name, kwargs)
            calls["loaded_model"] = _FakeModel()
            return calls["loaded_model"]

    class BitsAndBytesConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    torch = ModuleType("torch")
    torch.bfloat16 = "bfloat16"
    torch.cuda = SimpleNamespace(
        is_available=lambda: cuda_available,
        is_bf16_supported=lambda: cuda_available,
        current_device=lambda: 0,
        device_count=lambda: int(cuda_available),
    )
    transformers = ModuleType("transformers")
    transformers.AutoTokenizer = AutoTokenizer
    transformers.AutoModelForCausalLM = AutoModelForCausalLM
    transformers.BitsAndBytesConfig = BitsAndBytesConfig

    class PeftModel:
        @staticmethod
        def from_pretrained(model, adapter_path):
            calls["adapter"] = (model, adapter_path)
            return model

    peft = ModuleType("peft")
    peft.PeftModel = PeftModel
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "transformers", transformers)
    monkeypatch.setitem(sys.modules, "peft", peft)
    return calls


def test_transformers_backend_pins_revision_and_loads_adapter(monkeypatch):
    calls = _install_fake_ml_modules(monkeypatch)
    revision = "49e3418fbbbca6ecbdf9608b4d22e5a407081db4"

    backend = load_backend(
        "transformers",
        "Qwen/Qwen3-8B-Base",
        model_revision=revision,
        adapter_path="outputs/E014/adapter",
    )

    assert calls["tokenizer"] == ("Qwen/Qwen3-8B-Base", {"revision": revision})
    assert calls["model"][0] == "Qwen/Qwen3-8B-Base"
    assert calls["model"][1]["revision"] == revision
    assert calls["adapter"][1] == "outputs/E014/adapter"
    assert backend.model.was_evaluated


def test_transformers_backend_refuses_cpu_four_bit_evaluation(monkeypatch):
    _install_fake_ml_modules(monkeypatch)
    with pytest.raises(RuntimeError, match="requires CUDA"):
        load_backend("transformers", "Qwen/Qwen3-8B-Base", load_in_4bit=True)


def test_invalid_json_error_retains_literal_generation():
    raw_output = "not-json {broken"
    with pytest.raises(ProtocolOutputError) as exc_info:
        _parse_protocol_output(raw_output, "Transformers")

    assert exc_info.value.raw_output == raw_output
