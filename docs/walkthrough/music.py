#!/usr/bin/env python3
"""A quiet bed for the walkthrough: soft chords and a slow plucked figure, made from code (no samples, no licence).

usage: python -I music.py OUT.wav SECONDS
"""
import sys, wave
import numpy as np

SR = 24000
BPM = 84
BEAT = 60 / BPM
# I - vi - IV - V in D major, two bars each; MIDI notes
CHORDS = [[50, 57, 62, 66], [47, 54, 59, 62], [43, 50, 55, 59], [45, 52, 57, 61]]


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def pad(freqs, dur):
    t = np.arange(int(dur * SR)) / SR
    out = np.zeros_like(t)
    for f in freqs:
        for detune in (-0.12, 0.0, 0.12):  # three slightly detuned sines: a soft chorus
            out += np.sin(2 * np.pi * f * (1 + detune / 100) * t)
    env = np.minimum(1, t / 1.2) * np.minimum(1, (dur - t) / 1.2)
    return out * env / (len(freqs) * 3)


def pluck(f, dur=1.6):
    t = np.arange(int(dur * SR)) / SR
    tone = np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t) + 0.1 * np.sin(6 * np.pi * f * t)
    return tone * np.exp(-t * 3.2) * np.minimum(1, t / 0.005)


def main(path, seconds):
    n = int(seconds * SR)
    out = np.zeros(n + SR * 4)
    bar = 4 * BEAT
    pos, i = 0.0, 0
    while pos < seconds:
        chord = CHORDS[i % len(CHORDS)]
        seg = pad([hz(m) for m in chord], 2 * bar + 1.0)
        s = int(pos * SR)
        out[s:s + len(seg)] += 0.5 * seg[: len(out) - s]
        for b in range(8):  # one plucked note per beat, walking the chord an octave up
            note = chord[[0, 2, 1, 3, 2, 1, 3, 2][b]] + 12
            p = pluck(hz(note))
            ps = int((pos + b * BEAT) * SR)
            if ps < len(out):
                out[ps:ps + len(p)] += 0.18 * p[: len(out) - ps]
        pos += 2 * bar
        i += 1
    out = out[:n]
    fade = int(3 * SR)
    out[-fade:] *= np.linspace(1, 0, fade)
    out[: SR] *= np.linspace(0, 1, SR)
    out /= np.max(np.abs(out)) + 1e-9
    pcm = (out * 0.8 * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


if __name__ == "__main__":
    main(sys.argv[1], float(sys.argv[2]))
