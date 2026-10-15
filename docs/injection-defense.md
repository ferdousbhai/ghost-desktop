# Prompt-injection defense

ghost-desktop treats window titles, on-screen text, and control names as untrusted. Every successful tool result's text is defended in two layers:

1. `fenceUntrusted` wraps each untrusted payload in tags containing a fresh, per-call nonce. It also neutralizes a matching close tag inside the payload, preventing on-screen text from trivially escaping its boundary.
2. `detectInjection` applies deterministic, local checks for imperative instructions directed at an AI, spoofed system/assistant/developer turns, tool-call-shaped text, invisible or bidirectional Unicode controls, and unusually large base64 or hexadecimal blobs. Flagged text still reaches the model, behind a warning line.

Detection is a defense-in-depth signal rather than proof that content is safe. The nonce fence limits how untrusted content is presented, while the detector identifies known suspicious shapes. A local classifier was tried and removed: on the evaluation corpus the heuristic caught every injection, so the classifier added only false positives.

## Detection evaluation

Run the deterministic heuristic evaluation from the repository root:

```sh
bun run test injection-eval
```

The evaluation prints recall, false-positive rate (FPR), per-category catch counts, misses, and false positives for the detector.

The heuristic corpus measured on 2026-08-24 contains 34 injection samples and 28 benign samples. Its category distribution and observed catches are:

| Primary category | Caught / corpus |
| --- | ---: |
| `imperative-ai-instruction` | 13 / 13 |
| `role-marker-spoofing` | 5 / 5 |
| `tool-call-shaped-text` | 6 / 6 |
| `invisible-or-bidi-unicode` | 4 / 4 |
| `large-encoded-blob` | 6 / 6 |

Observed heuristic recall is **34/34 = 1.000** and observed FPR is **0/28 = 0.000**. The regression test requires recall of at least **0.97** and FPR of at most **0.04**, allowing a small measurement margin while still detecting meaningful regressions.
