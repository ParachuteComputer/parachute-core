#!/usr/bin/env python3
"""The parachute-core walkthrough: what the repo is and how we'll build, in under 90 seconds.

usage (a Python with kokoro_onnx, numpy, PIL; on uni: ~/studio/.venv/bin/python):
  python -I make_video.py          narrate (cached), draw slides, add the music bed, render
  python -I make_video.py stills   only the slides, for a look

Kokoro voice af_heart, one clip per line, slides that build line by line, a quiet bed from music.py. Scratch and the
film go to $WALK_OUT (default $TMPDIR/parachute-core-walkthrough). Each terminal line on screen is copied word for
word from a real run (`bun run today` in CI run 40453698606, `bun run mutants` on uni); some lines are left out, marked
"...". Fonts: Fraunces and DM Sans from ~/.local/share/fonts if present, else PIL's default font.
"""
import hashlib, json, os, subprocess, sys, wave
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
OUT = Path(os.environ.get("WALK_OUT", Path(os.environ.get("TMPDIR", "/tmp")) / "parachute-core-walkthrough"))
FILM = OUT / "parachute-core-walkthrough.mp4"
KDIR = Path.home() / ".local/share/kokoro"
VOICE, SR, FPS = "af_heart", 24000, 30
W, H = 1280, 720
GAP, SCENE_GAP, LEAD, TAIL = 0.35, 0.6, 0.5, 1.6
MUSIC_GAIN = 0.11

PAPER = (247, 243, 234); INK = (33, 37, 41); DIM = (112, 117, 122); FAINT = (196, 192, 184)
SKY = (52, 120, 196); LEAF = (62, 150, 96); CLAY = (204, 102, 64); TERM = (30, 33, 36); TERM_TXT = (222, 226, 220)

FONT = {
    "serif": str(Path.home() / ".local/share/fonts/fraunces-600.ttf"),
    "sans": str(Path.home() / ".local/share/fonts/dm-sans-400.ttf"),
    "sans-b": str(Path.home() / ".local/share/fonts/dm-sans-600.ttf"),
    "mono": "/usr/share/fonts/liberation/LiberationMono-Regular.ttf",
}
_fonts = {}


def font(kind, size):
    if (kind, size) not in _fonts:
        try:
            _fonts[kind, size] = ImageFont.truetype(FONT[kind], size)
        except OSError:
            _fonts[kind, size] = ImageFont.load_default(size)
    return _fonts[kind, size]


# ---------------------------------------------------------------------------------------------------- the script

def s_title(c, step):
    c.text(90, 230, "parachute-core", "serif", 72, INK)
    c.text(92, 330, "a new home for Parachute, and how we'll build it", "sans", 32, DIM)
    c.text(92, 620, "ParachuteComputer/parachute-core · private · October 2026", "sans", 20, FAINT)


def s_thesis(c, step):
    c.head("Steady core, living surface")
    c.box(90, 150, 1100, 200, PAPER, SKY)
    c.text(120, 170, "the core: a plain vault", "serif", 30, SKY)
    c.chips(120, 240, ["notes", "tags with fields", "links", "files", "history", "who sees what"], SKY)
    if step >= 1:
        c.box(90, 400, 1100, 150, PAPER, CLAY)
        c.text(120, 420, "the surface: apps", "serif", 30, CLAY)
        c.text(120, 475, "Uni, Prism, a consumer AI app: each brings its own shape", "sans", 26, INK)


def s_consumer(c, step):
    c.head("First-class from day one")
    c.box(90, 200, 330, 160, PAPER, CLAY, label="the Claude app\nor ChatGPT")
    c.box(860, 200, 330, 160, PAPER, SKY, label="your vault")
    c.arrow(430, 280, 850, 280, INK)
    c.text(640, 240, "MCP", "sans-b", 24, INK, anchor="mm")
    if step >= 1:
        c.chips(90, 440, ["connect", "sign in, say yes", "read", "write", "search"], LEAF)


def s_contracts(c, step):
    c.head("We start with tests, not code")
    c.para(90, 140, "They call today's hub and vault from the outside, the way apps do.", "sans", 28, INK, 1100)
    rows = ["notes", "tags and types", "links", "search", "history", "who sees what", "the consumer app"]
    c.chips(90, 230, rows, SKY)
    if step >= 1:
        c.terminal(90, 380, ["$ bun run today",
                             "...",
                             " 35 pass",
                             " 0 fail",
                             "Ran 35 tests across 5 files. [34.57s]",
                             "[contracts] services stopped and temp home removed"])


def s_red(c, step):
    c.head("A test that can't fail proves nothing")
    c.para(90, 140, "So we break today's vault in five small ways, and a test has to catch each one.", "sans", 28,
           INK, 1100)
    if step >= 1:
        c.terminal(90, 260, ["$ bun run mutants", "..."] + MUTANT_LINES)


def s_v1(c, step):
    c.head("Decided, not built yet")
    c.box(90, 160, 1100, 110, PAPER, LEAF, label="sharing only adds up")
    c.box(90, 300, 1100, 110, PAPER, LEAF, label="private notes for the exceptions")
    c.box(90, 440, 1100, 110, PAPER, LEAF, label="the app that wrote a note is named on it")
    if step >= 1:
        c.text(90, 600, "the tests are written, and wait, marked failing until the code arrives", "sans", 24, DIM)


def s_build(c, step):
    c.head("How we'll build")
    steps = ["move today's code in, a piece at a time", "every test still passes, or it doesn't land",
             "a branch, a pull request, someone else reviews", "CI runs every test on every change"]
    for i, t in enumerate(steps):
        on = step >= (0 if i < 2 else 1)
        c.text(90, 160 + i * 80, f"{i + 1}", "serif", 36, SKY if on else FAINT)
        c.text(150, 168 + i * 80, t, "sans", 28, INK if on else FAINT)
    if step >= 2:
        c.text(90, 520, "Uni's workers and Benjamin's agent: same rules, same checks", "sans-b", 26, CLAY)


def s_end(c, step):
    c.head("Where it stands")
    c.chips(90, 200, ["private repo", "AGPL, other terms on request", "the shape isn't final"], SKY)
    c.para(90, 320, "Benjamin's feedback can still change it. The tests are what we agree on first.", "serif", 36,
           INK, 1100)


# Copied from `bun run mutants` (harness/mutate.ts summary lines).
MUTANT_LINES = [
    '[mutants] scope-leak      caught, 2 red',
    '[mutants] untagged-leak   caught, 1 red',
    '[mutants] no-history      caught, 3 red',
    '[mutants] stale-write     caught, 1 red',
    '[mutants] wrong-resource  caught, 1 red',
    '[mutants] 5/5 caught',
]

SCENES = [
    (s_title, ["This is parachute-core: a new home for Parachute, and a plan for how we'll build it."]),
    (s_thesis, ["The idea is steady core, living surface. The core is a plain vault: notes, tags with fields, links, "
                "files, history, and who can see what. It has no opinions about how you organise things.",
                "Apps like Uni and Prism bring their own shape on top."]),
    (s_consumer, ["One path matters from day one: someone whose only AI is the Claude app, or ChatGPT.",
                  "They own one vault. They connect the app, say yes once, and it reads, writes and searches their "
                  "notes."]),
    (s_contracts, ["So we start with tests, not code. They call today's hub and vault from the outside, the way apps "
                   "do.",
                   "Right now all thirty-five pass, against throwaway copies started on this machine."]),
    (s_red, ["A test that can't fail proves nothing.",
             "So we break today's vault five small ways, and check that a test catches each one. All five are "
             "caught."]),
    (s_v1, ["Some things are decided but not built: sharing that only adds up, private notes for the exceptions, "
            "and naming the app that wrote a note.",
            "Their tests are written already, and waiting."]),
    (s_build, ["Then we move today's code in, a piece at a time. Nothing lands unless every test still passes.",
               "Each change gets a branch, a pull request, someone else's review, and every test in CI.",
               "Uni's workers and Benjamin's agent follow the same rules."]),
    (s_end, ["The repo is private and AGPL. The shape isn't final, and Benjamin's feedback can still change it."]),
]


# ---------------------------------------------------------------------------------------------------- drawing

class Canvas:
    def __init__(self):
        self.im = Image.new("RGB", (W, H), PAPER)
        self.d = ImageDraw.Draw(self.im)
        self.d.rectangle([0, H - 8, W, H], fill=SKY)

    def text(self, x, y, s, kind, size, col, anchor="la"):
        self.d.text((x, y), s, font=font(kind, size), fill=col, anchor=anchor)

    def head(self, s):
        self.text(90, 60, s, "serif", 42, INK)

    def para(self, x, y, s, kind, size, col, maxw):
        lines, cur = [], ""
        for word in s.split():
            t = (cur + " " + word).strip()
            if self.d.textlength(t, font=font(kind, size)) > maxw and cur:
                lines.append(cur); cur = word
            else:
                cur = t
        lines.append(cur)
        for i, ln in enumerate(lines):
            self.text(x, y + i * size * 1.35, ln, kind, size, col)

    def box(self, x, y, w, h, fill, col, label=None):
        self.d.rounded_rectangle([x, y, x + w, y + h], 16, fill=fill, outline=col, width=3)
        if label:
            self.d.multiline_text((x + w / 2, y + h / 2), label, font=font("sans-b", 28), fill=col, anchor="mm",
                                  align="center", spacing=8)

    def chip(self, x, y, s, col):
        w = self.d.textlength(s, font=font("sans-b", 22)) + 36
        self.d.rounded_rectangle([x, y, x + w, y + 44], 22, fill=PAPER, outline=col, width=2)
        self.text(x + 18, y + 10, s, "sans-b", 22, col)
        return w

    def chips(self, x, y, items, col, maxw=1100, gap=16):
        cx, cy = x, y
        for s in items:
            w = self.d.textlength(s, font=font("sans-b", 22)) + 36
            if cx + w > x + maxw:
                cx, cy = x, cy + 58
            self.chip(cx, cy, s, col)
            cx += w + gap

    def arrow(self, x1, y1, x2, y2, col):
        self.d.line([x1, y1, x2, y2], fill=col, width=4)
        self.d.polygon([(x2, y2), (x2 - 18, y2 - 10), (x2 - 18, y2 + 10)], fill=col)

    def terminal(self, x, y, lines):
        h = 36 * len(lines) + 40
        self.d.rounded_rectangle([x, y, x + 1100, y + h], 12, fill=TERM)
        for i, ln in enumerate(lines):
            col = LEAF if ("caught" in ln or ln.strip().endswith("pass")) else TERM_TXT
            self.text(x + 24, y + 20 + i * 36, ln, "mono", 22, col)


def draw(scene_ix, step):
    c = Canvas()
    SCENES[scene_ix][0](c, step)
    return c.im


# ---------------------------------------------------------------------------------------------------- audio

SPEED, LANG = 1.05, "en-us"


def clip_path(text):
    model = (KDIR / "kokoro.onnx").stat().st_mtime_ns
    key = f"{VOICE}|{SPEED}|{LANG}|{model}|{text}"
    return OUT / "tts" / (hashlib.sha1(key.encode()).hexdigest()[:16] + ".npy")


def narrate():
    (OUT / "tts").mkdir(parents=True, exist_ok=True)
    k = None
    for _, lines in SCENES:
        for ln in lines:
            p = clip_path(ln)
            if p.exists():
                continue
            if k is None:
                from kokoro_onnx import Kokoro
                k = Kokoro(str(KDIR / "kokoro.onnx"), str(KDIR / "voices.bin"))
            samples, sr = k.create(ln, voice=VOICE, speed=SPEED, lang=LANG)
            assert sr == SR, sr
            np.save(p, samples.astype(np.float32))
            print(f"  tts {len(samples) / SR:5.1f}s  {ln[:70]}", flush=True)


def timeline():
    parts, shots = [np.zeros(int(LEAD * SR), np.float32)], []
    for si, (_, lines) in enumerate(SCENES):
        for li, ln in enumerate(lines):
            clip = np.load(clip_path(ln))
            last = li == len(lines) - 1
            pause = (SCENE_GAP if si < len(SCENES) - 1 else TAIL) if last else GAP
            lead = LEAD if (si == 0 and li == 0) else 0.0
            parts += [clip, np.zeros(int(pause * SR), np.float32)]
            shots.append((si, li, lead + len(clip) / SR + pause))
    return shots, np.concatenate(parts)


def render():
    narrate()
    shots, voice = timeline()
    total = sum(s for *_, s in shots)
    frames = OUT / "frames"; frames.mkdir(parents=True, exist_ok=True)
    music = OUT / "music.wav"
    subprocess.run([sys.executable, "-I", str(HERE / "music.py"), str(music), f"{total:.3f}"], check=True)
    with wave.open(str(music)) as w:
        assert (w.getframerate(), w.getnchannels()) == (SR, 1), "music.py must write mono at the narration's rate"
        bed = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32767
    bed = np.pad(bed, (0, max(0, len(voice) - len(bed))))[: len(voice)]
    voice = voice * (0.85 / max(float(np.max(np.abs(voice))), 1e-6))  # headroom for the bed
    mix = np.clip(voice + MUSIC_GAIN * bed, -1, 1)
    wav = OUT / "mix.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((mix * 32767).astype(np.int16).tobytes())
    lst = OUT / "shots.txt"
    with open(lst, "w") as f:
        for n, (si, step, secs) in enumerate(shots):
            png = frames / f"{n:02d}-s{si}-{step}.png"
            draw(si, step).save(png)
            f.write(f"file '{png}'\nduration {secs:.3f}\n")
        f.write(f"file '{png}'\n")
    begin = np.concatenate([[0.0], np.cumsum([secs for *_, secs in shots])[:-1]])
    begin[0] = LEAD
    (OUT / "timing.json").write_text(json.dumps(
        [{"start": round(float(b), 3), "text": SCENES[si][1][step]} for b, (si, step, _) in zip(begin, shots)],
        indent=1))
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-i", str(wav),
                    "-map", "0:v:0", "-map", "1:a:0", "-vf", f"fps={FPS},format=yuv420p",
                    "-map_metadata", "-1", "-map_chapters", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact",
                    "-flags:a", "+bitexact", "-c:v", "libx264", "-x264-params", "no-info=1", "-preset", "medium",
                    "-crf", "20", "-tune", "stillimage", "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
                    "-t", f"{total:.3f}", "-movflags", "+faststart", str(FILM)], check=True)
    print(f"film: {FILM}  ({total:.1f} s, {len(shots)} shots)")


def stills():
    out = OUT / "stills"; out.mkdir(parents=True, exist_ok=True)
    for si, (_, lines) in enumerate(SCENES):
        for step in range(len(lines)):
            draw(si, step).save(out / f"s{si}-{step}.png")
    print(out)


if __name__ == "__main__":
    modes = {"": render, "stills": stills}
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode not in modes:
        sys.exit(__doc__)
    modes[mode]()
