#!/usr/bin/env python3
"""
Word-level forced alignment for burned-in captions.

We already know what is said (the script), so this does not transcribe: PocketSphinx's aligner finds
when each known word is spoken. Usage:

    python3 align.py AUDIO_S16LE_16K_MONO.raw < transcript.txt

Prints JSON to stdout: {"engine": "pocketsphinx", "words": [{"text", "start", "end"}]} where `text` is
the word as written in the transcript and times are in seconds. Exits non-zero on failure.
"""
import json
import re
import sys

from pocketsphinx import Decoder

ONES = (
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
    "fifteen sixteen seventeen eighteen nineteen"
).split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def number_words(n):
    if n < 20:
        return [ONES[n]]
    if n < 100:
        return [TENS[n // 10]] + ([ONES[n % 10]] if n % 10 else [])
    if n < 1000:
        return [ONES[n // 100], "hundred"] + (number_words(n % 100) if n % 100 else [])
    if n < 1000000:
        return number_words(n // 1000) + ["thousand"] + (number_words(n % 1000) if n % 1000 else [])
    return [ONES[int(c)] for c in str(n)]


# Rough English letter-to-sound rules. Only used for words missing from the dictionary (brand names,
# jargon); the acoustic match is tolerant, so an approximate pronunciation aligns well enough.
RULES = [
    ("tion", "SH AH N"), ("igh", "AY"), ("ph", "F"), ("sh", "SH"), ("ch", "CH"), ("th", "TH"),
    ("ng", "NG"), ("ck", "K"), ("qu", "K W"), ("ee", "IY"), ("ea", "IY"), ("oo", "UW"), ("ou", "AW"),
    ("ow", "OW"), ("ai", "EY"), ("ay", "EY"), ("oi", "OY"), ("au", "AO"), ("ar", "AA R"), ("er", "ER"),
    ("ir", "ER"), ("ur", "ER"), ("or", "AO R"), ("a", "AE"), ("b", "B"), ("c", "K"), ("d", "D"),
    ("e", "EH"), ("f", "F"), ("g", "G"), ("h", "HH"), ("i", "IH"), ("j", "JH"), ("k", "K"), ("l", "L"),
    ("m", "M"), ("n", "N"), ("o", "AA"), ("p", "P"), ("r", "R"), ("s", "S"), ("t", "T"), ("u", "AH"),
    ("v", "V"), ("w", "W"), ("x", "K S"), ("y", "IY"), ("z", "Z"),
]


def letter_to_sound(word):
    w, out, i = word.lower(), [], 0
    while i < len(w):
        for graph, phones in RULES:
            if w.startswith(graph, i):
                out.append(phones)
                i += len(graph)
                break
        else:
            i += 1
    return " ".join(out) or "AH"


def display_tokens(text):
    """Words as written, each with the spoken form(s) used for alignment ("2D" -> "two", "d")."""
    tokens = []
    for raw in re.findall(r"[^\s]+", text):
        display = raw.strip()
        core = re.sub(r"^[^\w]+|[^\w]+$", "", display.replace("’", "'"), flags=re.UNICODE)
        if not core:
            continue
        spoken = []
        for part in re.split(r"[-/]", core.lower()):
            part = part.strip("'")
            if not part:
                continue
            m = re.fullmatch(r"(\d+)([a-z]*)", part)
            if m:
                spoken += number_words(int(m.group(1))) + list(m.group(2))
            elif re.fullmatch(r"[a-z']+", part):
                spoken.append(part)
            else:
                spoken.append(re.sub(r"[^a-z']", "", part) or "uh")
        if spoken:
            tokens.append((display, spoken))
    return tokens


def pronunciation(decoder, word):
    if decoder.lookup_word(word):
        return None
    if word.endswith("'s") and decoder.lookup_word(word[:-2]):
        return decoder.lookup_word(word[:-2]) + " Z"
    return letter_to_sound(word)


def match_segments(spoken, segs):
    """Pairs aligned segments with the expected words in order; unmatched words stay None."""
    timings = [None] * len(spoken)
    j = 0
    for word, start, end in segs:
        # Look ahead a few words: the aligner can skip short words it could not place.
        for k in range(j, min(j + 4, len(spoken))):
            if spoken[k] == word:
                timings[k] = (start, end)
                j = k + 1
                break
    return timings


def speech_bounds(audio):
    """(first, last) second with speech energy, from 10 ms frames of 16 kHz s16le audio."""
    import array
    import math

    samples = array.array("h")
    samples.frombytes(audio[: len(audio) // 2 * 2])
    frame = 160
    energies = []
    for i in range(0, len(samples) - frame + 1, frame):
        chunk = samples[i : i + frame]
        energies.append(math.sqrt(sum(x * x for x in chunk) / frame))
    if not energies:
        return 0.0, 0.0
    threshold = max(sorted(energies)[len(energies) // 2] * 3, max(energies) * 0.05)
    voiced = [i for i, e in enumerate(energies) if e > threshold]
    if not voiced:
        return 0.0, len(energies) / 100.0
    return voiced[0] / 100.0, (voiced[-1] + 1) / 100.0


def fill_missing(timings, spoken, bounds):
    """Gives unmatched words a share of the time between their aligned neighbours (by length)."""
    n = len(timings)
    i = 0
    while i < n:
        if timings[i] is not None:
            i += 1
            continue
        j = i
        while j < n and timings[j] is None:
            j += 1
        left = timings[i - 1][1] if i > 0 else bounds[0]
        right = timings[j][0] if j < n else max(bounds[1], left + 0.3 * (j - i))
        weights = [max(len(w), 2) for w in spoken[i:j]]
        total = float(sum(weights))
        t = left
        for k, weight in zip(range(i, j), weights):
            span = (right - left) * weight / total
            timings[k] = (t, t + span)
            t += span
        i = j


def main():
    audio_path = sys.argv[1]
    text = sys.stdin.read()
    tokens = display_tokens(text)
    if not tokens:
        print(json.dumps({"engine": "pocketsphinx", "words": []}))
        return

    decoder = Decoder(samprate=16000, loglevel="FATAL")
    for _, spoken in tokens:
        for w in spoken:
            phones = pronunciation(decoder, w)
            if phones:
                decoder.add_word(w, phones, True)
    decoder.set_align_text(" ".join(w for _, spoken in tokens for w in spoken))

    with open(audio_path, "rb") as f:
        audio = f.read()
    decoder.start_utt()
    decoder.process_raw(audio, full_utt=True)
    decoder.end_utt()

    segs = [
        (re.sub(r"\(\d+\)$", "", s.word), s.start_frame / 100.0, (s.end_frame + 1) / 100.0)
        for s in decoder.seg()
        if s.word not in ("<s>", "</s>", "<sil>", "[NOISE]")
    ]
    spoken = [w for _, sp in tokens for w in sp]
    timings = match_segments(spoken, segs)
    found = sum(1 for t in timings if t)
    if found < max(1, len(spoken) // 2):
        print(f"alignment matched only {found} of {len(spoken)} words", file=sys.stderr)
        sys.exit(2)
    fill_missing(timings, spoken, speech_bounds(audio))

    words, i = [], 0
    for display, sp in tokens:
        group = timings[i : i + len(sp)]
        i += len(sp)
        words.append({"text": display, "start": round(group[0][0], 3), "end": round(group[-1][1], 3)})
    print(json.dumps({"engine": "pocketsphinx", "words": words}))


if __name__ == "__main__":
    main()
