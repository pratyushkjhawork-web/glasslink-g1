# Bonus Design Doc: Voice Intent Classifier

## Goal

The smart glasses need to map short voice transcripts into five intents: `capture`, `exit`, `wake`, `chat`, and `none`. I chose a small dependency-free Python classifier so the prototype can run locally without a model download, internet access, or API key.

## Approach

The classifier normalizes input using Unicode NFKC normalization, case folding, punctuation removal, and whitespace cleanup. It then scores phrase and keyword matches across English, Hindi, Telugu, and common transliterated phrases such as "photo lo", "jago", and "emi idi cheppu". Phrases receive a higher score than single-word hints because they are usually more intentional, for example "take a photo" should be stronger than "photo".

Supported examples:

- English: "take a photo", "wake up", "stop", "tell me"
- Hindi: "फोटो लो", "जागो", "बंद", "बताओ"
- Telugu: "ఫోటో", "లేవు", "ఆపు", "చెప్పు"

The output is a `Classification` dataclass containing the original text, predicted intent, score, and matched terms. Unknown text returns `none` instead of guessing.

## Architecture

- `classifier.py`
  - `normalize(text)`: makes matching robust across casing and punctuation.
  - `classify(text)`: scores all intents and returns the best one.
  - `classify_many(lines)`: convenience helper for batch tests or demos.
  - CLI demo: `python classifier.py "take a photo"`
- `test_classifier.py`
  - Covers English, Hindi, Telugu, exit, and none.
- `evaluate_classifier.py`
  - Runs a small labeled smoke-test dataset and prints accuracy plus per-example predictions.

## Trade-offs

This is not a machine-learning model. A trained multilingual model would handle synonyms and noisy ASR transcripts better, but it would add setup time and dependency risk. For a 3.5 day assignment, a deterministic rule-based classifier is easier to explain in an interview and safer to run in a fresh environment.

With more time I would collect real ASR transcripts, measure accuracy on a larger labeled set, and then compare this baseline with a lightweight multilingual embedding model.
