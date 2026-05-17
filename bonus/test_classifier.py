from classifier import classify
from evaluate_classifier import evaluate


def test_english_capture():
    assert classify("take a photo of this").intent == "capture"


def test_hindi_wake():
    assert classify("जागो ग्लास").intent == "wake"


def test_telugu_chat():
    assert classify("ఇది ఏమిటి చెప్పు").intent == "chat"


def test_exit():
    assert classify("stop listening now").intent == "exit"


def test_none():
    assert classify("the weather is nice").intent == "none"


def test_transliterated_hindi_and_telugu():
    assert classify("photo lo").intent == "capture"
    assert classify("emi idi cheppu").intent == "chat"


def test_evaluation_set_accuracy():
    correct, total, accuracy = evaluate()

    assert correct == total
    assert accuracy == 1.0
