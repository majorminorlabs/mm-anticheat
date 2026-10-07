import unittest

try:
    import torch
    import torch.nn.functional as F
except ImportError:
    torch = None

from scripts.terminal_eos_loss import terminal_eos_mask, terminal_eos_weighted_loss


@unittest.skipIf(torch is None, 'torch is required for tensor loss tests')
class TerminalEOSLossTests(unittest.TestCase):
    EOS = 3

    def labels(self):
        # Two different target lengths, with padding after the first row.
        # The first row also has an internal EOS-like label that stays ordinary.
        return torch.tensor([[-100, -100, 2, self.EOS, 4, self.EOS, -100, -100],
                             [-100, -100, 5, 6, 7, 4, 2, self.EOS]])

    def test_weight_one_matches_standard_shifted_cross_entropy(self):
        torch.manual_seed(23)
        logits = torch.randn(2, 8, 11, dtype=torch.float64, requires_grad=True)
        labels = self.labels()
        expected = F.cross_entropy(logits[:, :-1, :].float().reshape(-1, 11),
                                   labels[:, 1:].reshape(-1), ignore_index=-100)
        actual = terminal_eos_weighted_loss(logits, labels, self.EOS, 1.0)
        self.assertTrue(torch.allclose(actual, expected, atol=1e-6, rtol=1e-6))

    def test_only_terminal_eos_gradient_changes(self):
        torch.manual_seed(23)
        labels = self.labels()
        base_logits = torch.randn(2, 8, 11, requires_grad=True)
        reduced_logits = base_logits.detach().clone().requires_grad_()
        terminal_eos_weighted_loss(base_logits, labels, self.EOS, 1.0).backward()
        terminal_eos_weighted_loss(reduced_logits, labels, self.EOS, 0.25).backward()
        base, reduced = base_logits.grad, reduced_logits.grad
        terminal = terminal_eos_mask(labels, self.EOS)
        self.assertEqual(terminal.nonzero().tolist(), [[0, 5], [1, 7]])
        for batch in range(labels.shape[0]):
            for label_position in range(1, labels.shape[1]):
                grad_position = label_position - 1
                if terminal[batch, label_position]:
                    self.assertTrue(torch.allclose(reduced[batch, grad_position],
                                                    base[batch, grad_position] * .25,
                                                    atol=1e-7, rtol=1e-5))
                else:
                    self.assertTrue(torch.allclose(reduced[batch, grad_position],
                                                    base[batch, grad_position],
                                                    atol=1e-7, rtol=1e-5))
        self.assertTrue(torch.equal(reduced[:, -1], torch.zeros_like(reduced[:, -1])))
        self.assertNotEqual(float(base[0, 2].abs().sum()), 0.0)  # internal EOS is supervised

    def test_finite_batched_loss_and_missing_terminal_rejection(self):
        labels = self.labels()
        logits = torch.randn(2, 8, 11, requires_grad=True)
        loss = terminal_eos_weighted_loss(logits, labels, self.EOS, .25)
        loss.backward()
        self.assertTrue(torch.isfinite(loss))
        self.assertTrue(torch.isfinite(logits.grad).all())
        malformed = labels.clone()
        malformed[1, 7] = 2
        with self.assertRaises(ValueError):
            terminal_eos_weighted_loss(logits, malformed, self.EOS, .25)


if __name__ == '__main__':
    unittest.main()
