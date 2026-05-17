"""
Small built-in evaluation set for the bonus classifier.

This is not a scientific benchmark; it is a transparent smoke test showing how
I would measure the classifier before replacing rules with a model.
"""

from __future__ import annotations

from classifier import classify


EVAL_SET = (
    ("take a photo of this sign", "capture"),
    ("click photo", "capture"),
    ("photo lo", "capture"),
    ("photo teeyi", "capture"),
    ("stop listening", "exit"),
    ("ruko", "exit"),
    ("aapu", "exit"),
    ("wake up glass", "wake"),
    ("jago glass", "wake"),
    ("levu glass", "wake"),
    ("tell me what is ahead", "chat"),
    ("kya hai", "chat"),
    ("emi idi cheppu", "chat"),
    ("today is monday", "none"),
    ("blue shirt", "none"),
)


def evaluate() -> tuple[int, int, float]:
    correct = 0
    for text, expected in EVAL_SET:
        predicted = classify(text).intent
        if predicted == expected:
            correct += 1
    total = len(EVAL_SET)
    return correct, total, correct / total


def main() -> None:
    correct, total, accuracy = evaluate()
    print("GlassLink voice intent evaluation")
    print(f"examples={total}")
    print(f"correct={correct}")
    print(f"accuracy={accuracy:.2%}")

    for text, expected in EVAL_SET:
        result = classify(text)
        marker = "PASS" if result.intent == expected else "FAIL"
        print(f"{marker} expected={expected:7} predicted={result.intent:7} score={result.score:<2} text={text}")


if __name__ == "__main__":
    main()
