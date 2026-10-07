"""Causal LM cross entropy with only the final target EOS down/up-weighted."""
from __future__ import annotations


def terminal_eos_mask(labels, eos_token_id):
    """Locate the last supervised label in each row, including padded batches."""
    import torch

    if labels.ndim != 2:
        raise ValueError('labels must have batch and sequence dimensions')
    valid = labels != -100
    positions = torch.arange(labels.shape[1], device=labels.device).expand_as(labels)
    last = torch.where(valid, positions, -1).max(dim=1).values
    if bool((last < 1).any()):
        raise ValueError('every row must have a supervised target after the first input token')
    terminal = torch.zeros_like(valid)
    terminal.scatter_(1, last[:, None], True)
    if bool((labels[terminal] != eos_token_id).any()):
        raise ValueError('last supervised label must be EOS in every row')
    return terminal


def terminal_eos_weighted_loss(logits, labels, eos_token_id, terminal_eos_loss_weight=1.0):
    """Match standard shifted CE at weight 1; retain its token-count denominator.

    The fixed denominator keeps every non-terminal token's coefficient exactly
    unchanged when the EOS weight changes. Internal EOS labels, if any, keep
    ordinary weight; only the last supervised EOS in each row is weighted.
    """
    import torch
    import torch.nn.functional as F

    weight = float(terminal_eos_loss_weight)
    if not 0 <= weight <= 1:
        raise ValueError('terminal_eos_loss_weight must be between 0 and 1')
    if logits.ndim != 3 or labels.shape != logits.shape[:2]:
        raise ValueError('logits/labels shape mismatch')
    terminal = terminal_eos_mask(labels, eos_token_id)[:, 1:]
    shifted_labels = labels[:, 1:].contiguous()
    per_token = F.cross_entropy(logits[:, :-1, :].float().contiguous().view(-1, logits.shape[-1]),
                                shifted_labels.reshape(-1), ignore_index=-100,
                                reduction='none').view_as(shifted_labels)
    weights = torch.where(terminal, weight, 1.0)
    return (per_token * weights).sum() / (shifted_labels != -100).sum()
