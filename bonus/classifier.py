"""
GlassLink G1 bonus: multilingual voice intent classifier.

The prototype is intentionally dependency-free so it can run offline during
review. It uses normalized keyword and phrase matching for English, Hindi, and
Telugu, then returns one of: capture, exit, wake, chat, none.
"""

from __future__ import annotations

import argparse
import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable

INTENTS = ("capture", "exit", "wake", "chat", "none")


@dataclass(frozen=True)
class Classification:
    text: str
    intent: str
    score: int
    matched_terms: tuple[str, ...]


PHRASES: dict[str, tuple[str, ...]] = {
    "capture": (
        "take photo",
        "take a photo",
        "click photo",
        "capture",
        "camera",
        "photo",
        "picture",
        "photo lo",
        "tasveer lo",
        "tasveer",
        "chitram",
        "photo teeyi",
        "फोटो",
        "तस्वीर",
        "कैप्चर",
        "फोटो लो",
        "తీయి",
        "ఫోటో",
        "చిత్రం",
        "క్యాప్చర్",
    ),
    "exit": (
        "exit",
        "quit",
        "stop",
        "close",
        "cancel",
        "band",
        "ruko",
        "aapu",
        "museyi",
        "बंद",
        "रुको",
        "बाहर",
        "रद्द",
        "ఆపు",
        "మూసివేయి",
        "బయటకు",
        "రద్దు",
    ),
    "wake": (
        "wake",
        "wake up",
        "hello glass",
        "hey glass",
        "start listening",
        "jago",
        "suno",
        "levu",
        "vinu",
        "जागो",
        "सुनो",
        "हैलो ग्लास",
        "లేవు",
        "విను",
        "హలో గ్లాస్",
    ),
    "chat": (
        "what is",
        "tell me",
        "describe",
        "explain",
        "question",
        "help me",
        "kya",
        "batao",
        "emi",
        "cheppu",
        "vivarinchu",
        "क्या",
        "बताओ",
        "समझाओ",
        "वर्णन",
        "ఏమిటి",
        "చెప్పు",
        "వివరించు",
        "సహాయం",
    ),
}

SINGLE_WORD_HINTS: dict[str, tuple[str, ...]] = {
    "capture": ("shoot", "snap", "फोटो", "తీయి"),
    "exit": ("bye", "done", "रुको", "ఆపు"),
    "wake": ("hello", "hey", "जागो", "లేవు"),
    "chat": ("why", "how", "where", "when", "क्यों", "कैसे", "ఎలా", "ఎక్కడ"),
}


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).casefold()
    text = re.sub(r"[^\w\s\u0900-\u097F\u0C00-\u0C7F]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def classify(text: str) -> Classification:
    normalized = normalize(text)
    if not normalized:
        return Classification(text=text, intent="none", score=0, matched_terms=())

    scores: dict[str, int] = {intent: 0 for intent in INTENTS if intent != "none"}
    matches: dict[str, list[str]] = {intent: [] for intent in scores}

    for intent, phrases in PHRASES.items():
        for phrase in phrases:
            norm_phrase = normalize(phrase)
            if norm_phrase and norm_phrase in normalized:
                scores[intent] += 3 if " " in norm_phrase else 2
                matches[intent].append(phrase)

    words = set(normalized.split())
    for intent, hints in SINGLE_WORD_HINTS.items():
        for hint in hints:
            if normalize(hint) in words:
                scores[intent] += 1
                matches[intent].append(hint)

    best_intent, best_score = max(scores.items(), key=lambda item: item[1])
    if best_score == 0:
        return Classification(text=text, intent="none", score=0, matched_terms=())

    return Classification(
        text=text,
        intent=best_intent,
        score=best_score,
        matched_terms=tuple(dict.fromkeys(matches[best_intent])),
    )


def classify_many(lines: Iterable[str]) -> list[Classification]:
    return [classify(line) for line in lines]


def main() -> None:
    parser = argparse.ArgumentParser(description="Classify GlassLink voice intent text.")
    parser.add_argument("text", nargs="*", help="Text to classify. If omitted, demo examples are used.")
    args = parser.parse_args()

    examples = args.text or [
        "Take a photo of the board",
        "जागो ग्लास",
        "ఈ దృశ్యం ఏమిటి చెప్పు",
        "Stop listening",
        "I like mangoes",
    ]

    for result in classify_many([" ".join(args.text)] if args.text else examples):
        terms = ", ".join(result.matched_terms) if result.matched_terms else "-"
        print(f"{result.intent:7} score={result.score:<2} terms={terms} | {result.text}")


if __name__ == "__main__":
    main()
