"""
Composes Newsgram's built-in background tracks from scratch (pure synthesis),
so every track is original and free to use anywhere, including monetised posts.

    python3 scripts/compose-music.py      # writes public/music/*.wav (then encode to mp3)
"""
import json
import os
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

SR = 44100
LEN = 30.0  # seconds
N = int(SR * LEN)
rng = np.random.default_rng(7)
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'music')
os.makedirs(OUT, exist_ok=True)


def note(n):
    """MIDI note -> Hz."""
    return 440.0 * 2 ** ((n - 69) / 12)


def lp(x, hz, order=2):
    return sosfilt(butter(order, hz, 'low', fs=SR, output='sos'), x)


def hp(x, hz, order=2):
    return sosfilt(butter(order, hz, 'high', fs=SR, output='sos'), x)


def bp(x, lo, hi):
    return sosfilt(butter(2, [lo, hi], 'band', fs=SR, output='sos'), x)


def env(n, a=0.005, d=0.2, s=0.0, r=0.05, hold=None):
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4))
    dec = s + (1 - s) * np.exp(-(t - a).clip(0) / max(d, 1e-4))
    e = np.where(t < a, e, dec)
    if hold is not None:
        rel = np.clip((t - hold) / r, 0, 1)
        e = e * (1 - rel)
    return e


def place(buf, sig, start_s, gain=1.0, pan=0.0):
    i = int(start_s * SR)
    if i >= buf.shape[1]:
        return
    j = min(buf.shape[1], i + len(sig))
    seg = sig[: j - i] * gain
    buf[0, i:j] += seg * np.sqrt(0.5 * (1 - pan))
    buf[1, i:j] += seg * np.sqrt(0.5 * (1 + pan))


def saw(f, n, detune=0.0):
    t = np.arange(n) / SR
    ph = (t * f * (1 + detune)) % 1.0
    return 2 * ph - 1


def sine(f, n, phase=0.0):
    t = np.arange(n) / SR
    return np.sin(2 * np.pi * f * t + phase)


def square(f, n, pw=0.5):
    t = np.arange(n) / SR
    return np.where((t * f) % 1.0 < pw, 1.0, -1.0)


# ---------------- drums ----------------
def kick(len_s=0.45, top=140, bottom=45, punch=1.0):
    n = int(SR * len_s)
    t = np.arange(n) / SR
    f = bottom + (top - bottom) * np.exp(-t * 30)
    ph = 2 * np.pi * np.cumsum(f) / SR
    click = rng.standard_normal(n) * np.exp(-t * 300) * 0.3 * punch
    return (np.sin(ph) * np.exp(-t * 7) + click) * 0.9


def snare(len_s=0.25, tone=190, bright=1.0):
    n = int(SR * len_s)
    t = np.arange(n) / SR
    noise = hp(rng.standard_normal(n), 1500) * np.exp(-t * 18) * 0.6 * bright
    body = np.sin(2 * np.pi * tone * t) * np.exp(-t * 25) * 0.5
    return noise + body


def clap():
    n = int(SR * 0.3)
    t = np.arange(n) / SR
    e = np.zeros(n)
    for k, off in enumerate([0, 0.011, 0.022, 0.034]):
        e += np.exp(-np.clip(t - off, 0, None) * (160 if k < 3 else 22)) * (t >= off)
    return bp(rng.standard_normal(n), 900, 5000) * e * 0.5


def hat(len_s=0.06, open_=False):
    n = int(SR * (0.3 if open_ else len_s))
    t = np.arange(n) / SR
    return hp(rng.standard_normal(n), 7000) * np.exp(-t * (12 if open_ else 70)) * 0.35


def tick():
    n = int(SR * 0.03)
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * 2400 * t) + 0.5 * np.sin(2 * np.pi * 5200 * t)) * np.exp(-t * 260) * 0.35


def tabla(pitch=220, len_s=0.5, bend=1.4, bright=0.4):
    """Dhol/tabla-like stroke: pitched membrane with a downward bend."""
    n = int(SR * len_s)
    t = np.arange(n) / SR
    f = pitch * (1 + (bend - 1) * np.exp(-t * 25))
    ph = 2 * np.pi * np.cumsum(f) / SR
    tone = np.sin(ph) + 0.3 * np.sin(2.01 * ph) + 0.15 * np.sin(3.2 * ph)
    slap = bp(rng.standard_normal(n), 1200, 6000) * np.exp(-t * 90) * bright
    return (tone * np.exp(-t * 9) + slap) * 0.6


# ---------------- tonal ----------------
def pad(freqs, n, cutoff=1800, attack=0.6, release=0.8, bright=1.0):
    x = np.zeros(n)
    for f in freqs:
        for d in (-0.004, 0.0, 0.005):
            x += saw(f, n, d)
    x /= len(freqs) * 3
    x = lp(x, cutoff * bright, 2)
    return x * env(n, a=attack, d=99, s=1, r=release, hold=n / SR - release)


def pluck(f, len_s=0.5, cutoff=3500, decay=6):
    n = int(SR * len_s)
    t = np.arange(n) / SR
    x = saw(f, n) * 0.6 + square(f * 2, n, 0.3) * 0.2
    return lp(x, cutoff) * np.exp(-t * decay)


def bass(f, len_s, cutoff=500, kind='saw'):
    n = int(SR * len_s)
    x = saw(f, n) if kind == 'saw' else square(f, n) * 0.7 + sine(f, n) * 0.5
    x = lp(x, cutoff, 2) + sine(f, n) * 0.5
    return x * env(n, a=0.004, d=len_s * 0.8, s=0.55, r=0.03, hold=len_s - 0.03)


def rhodes(freqs, len_s):
    n = int(SR * len_s)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for f in freqs:
        x += np.sin(2 * np.pi * f * t + 0.8 * np.sin(2 * np.pi * f * t) * np.exp(-t * 3))
    x /= len(freqs)
    trem = 1 + 0.25 * np.sin(2 * np.pi * 4.5 * t)
    return x * trem * env(n, a=0.01, d=1.4, s=0.35, r=0.3, hold=len_s - 0.3)


def flute(f, len_s, vib=5.2):
    n = int(SR * len_s)
    t = np.arange(n) / SR
    fm = f * (1 + 0.006 * np.sin(2 * np.pi * vib * t) * np.clip(t * 3, 0, 1))
    ph = 2 * np.pi * np.cumsum(fm) / SR
    breath = bp(rng.standard_normal(n), f * 0.8, f * 3) * 0.08
    x = np.sin(ph) + 0.18 * np.sin(2 * ph) + 0.06 * np.sin(3 * ph) + breath
    return x * env(n, a=0.06, d=99, s=1, r=0.12, hold=len_s - 0.12)


def reverb(buf, secs=1.8, mix=0.25, damp=5000):
    n = int(SR * secs)
    t = np.arange(n) / SR
    out = np.zeros_like(buf)
    for ch in range(2):
        ir = lp(rng.standard_normal(n), damp) * np.exp(-t * 6.9 / secs)
        ir[: int(0.012 * SR)] = 0
        ir /= np.sqrt(np.sum(ir ** 2))
        out[ch] = fftconvolve(buf[ch], ir)[: buf.shape[1]]
    return buf + out * mix


def master(buf, name, title, mood, bpm, group='Background beds'):
    buf = hp(buf, 30)
    buf = np.tanh(buf * 1.2) / np.tanh(1.2)
    peak = np.max(np.abs(buf))
    buf = buf / peak * 0.89
    fade = int(SR * 2.0)
    buf[:, -fade:] *= np.linspace(1, 0, fade) ** 1.5
    buf[:, : int(SR * 0.02)] *= np.linspace(0, 1, int(SR * 0.02))
    import wave
    pcm = (buf.T * 32767).astype('<i2')
    with wave.open(os.path.join(OUT, f'{name}.wav'), 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return {'id': name, 'title': title, 'mood': mood, 'bpm': bpm, 'group': group, 'file': f'/music/{name}.mp3', 'duration': LEN}


def grid(bpm):
    return 60.0 / bpm


catalog = []

# 1. Breaking Pulse — urgent news bed, A minor, ticking clock
def breaking_pulse():
    bpm = 122
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    prog = [(57, [57, 60, 64]), (53, [53, 57, 60]), (48, [55, 60, 64]), (55, [55, 59, 62])]  # Am F C G
    bars = int(LEN / (4 * b)) + 1
    for bar in range(bars):
        root, chord = prog[bar % 4]
        t0 = bar * 4 * b
        place(buf, pad([note(n + 12) for n in chord], int(4 * b * SR), cutoff=1400), t0, 0.35)
        for e in range(8):
            place(buf, bass(note(root - 24), b / 2 * 0.9, cutoff=420), t0 + e * b / 2, 0.55)
        for q in range(4):
            if bar >= 1:
                place(drums, kick(), t0 + q * b, 0.9)
            if bar >= 2 and q in (1, 3):
                place(drums, snare(bright=0.8), t0 + q * b, 0.45)
        for s in range(16):
            place(drums, tick(), t0 + s * b / 4, 0.5 if s % 4 == 0 else 0.25, pan=0.3)
        if bar % 2 == 1:
            for k, n in enumerate([76, 74, 72, 71]):
                place(buf, pluck(note(n), 0.35), t0 + 2 * b + k * b / 2, 0.12, pan=-0.3)
    return master(reverb(buf, 1.6, 0.3) + drums, 'breaking-pulse', 'Breaking Pulse', 'Urgent · news', bpm)


# 2. Headline Rise — cinematic build
def headline_rise():
    bpm = 90
    b = grid(bpm)
    buf = np.zeros((2, N))
    prog = [[50, 57, 62, 65], [46, 53, 58, 62], [48, 55, 60, 64], [45, 52, 57, 61]]  # Dm Bb C A
    bars = int(LEN / (4 * b)) + 1
    for bar in range(bars):
        t0 = bar * 4 * b
        ch = prog[bar % 4]
        place(buf, pad([note(n) for n in ch], int(4 * b * SR), cutoff=900 + bar * 180, attack=1.0), t0, 0.5)
        place(buf, sine(note(ch[0] - 12), int(4 * b * SR)) * env(int(4 * b * SR), a=0.3, d=3), t0, 0.35)
        place(buf, kick(0.9, 90, 38, 0.5), t0, 1.0)
        place(buf, kick(0.9, 90, 38, 0.5), t0 + 2.5 * b, 0.7)
        if bar >= 2:
            place(buf, snare(0.6, 150, 0.6), t0 + 2 * b, 0.4)
            for s in range(8):
                arp = ch[s % 4] + 12 + (12 if s >= 4 else 0)
                place(buf, pluck(note(arp), 0.45, 4000, 5), t0 + s * b / 2, 0.14, pan=0.4 * np.sin(s))
        if bar >= 5:
            for s in range(4):
                place(buf, hat(0.08), t0 + s * b + b / 2, 0.4)
    return master(reverb(buf, 2.8, 0.4), 'headline-rise', 'Headline Rise', 'Cinematic · big story', bpm)


# 3. Morning Brief — bright pop
def morning_brief():
    bpm = 112
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    prog = [(48, [60, 64, 67]), (43, [59, 62, 67]), (45, [57, 60, 64]), (41, [57, 60, 65])]  # C G Am F
    arp_pat = [0, 1, 2, 1, 0, 2, 1, 2]
    bars = int(LEN / (4 * b)) + 1
    for bar in range(bars):
        root, ch = prog[bar % 4]
        t0 = bar * 4 * b
        place(buf, pad([note(n) for n in ch], int(4 * b * SR), cutoff=2400, attack=0.2), t0, 0.22)
        for s, idx in enumerate(arp_pat):
            place(buf, pluck(note(ch[idx] + 12), 0.3, 5000, 9), t0 + s * b / 2, 0.22, pan=0.25 if s % 2 else -0.25)
        for q in range(4):
            place(buf, bass(note(root - 12), b * 0.45, 700, 'square'), t0 + q * b, 0.4)
            place(buf, bass(note(root - 12), b * 0.3, 700, 'square'), t0 + q * b + 0.75 * b, 0.25)
            place(drums, kick(0.35), t0 + q * b, 0.8 if q in (0, 2) else 0.0)
            if q in (1, 3):
                place(drums, clap(), t0 + q * b, 0.8)
            place(drums, hat(), t0 + q * b + b / 2, 0.5)
        place(drums, kick(0.35), t0 + 2.5 * b, 0.5)
    return master(reverb(buf, 1.2, 0.2) + drums, 'morning-brief', 'Morning Brief', 'Upbeat · positive', bpm)


# 4. Lo-fi Desk — mellow, swung
def lofi_desk():
    bpm = 80
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    prog = [[50, 53, 57, 60], [43, 53, 55, 59], [48, 52, 55, 59], [45, 52, 55, 60]]  # Dm7 G7 Cmaj7 Am7
    bars = int(LEN / (4 * b)) + 1
    swing = b * 0.58
    for bar in range(bars):
        t0 = bar * 4 * b
        ch = prog[bar % 4]
        place(buf, rhodes([note(n + 12) for n in ch[1:]], 4 * b), t0, 0.45)
        place(buf, rhodes([note(n + 12) for n in ch[1:]], 1.5 * b), t0 + 2.5 * b, 0.25)
        place(buf, bass(note(ch[0] - 12), 1.8 * b, 300), t0, 0.5)
        place(buf, bass(note(ch[0] - 12 + 7), 1.2 * b, 300), t0 + 2.5 * b, 0.35)
        place(drums, kick(0.4, 110, 45, 0.3), t0, 0.8)
        place(drums, kick(0.4, 110, 45, 0.3), t0 + 2.75 * b, 0.6)
        place(drums, snare(0.3, 180, 0.5), t0 + b, 0.35)
        place(drums, snare(0.3, 180, 0.5), t0 + 3 * b, 0.35)
        for q in range(4):
            place(drums, hat(0.05), t0 + q * b, 0.25)
            place(drums, hat(0.05), t0 + q * b + swing, 0.18)
    crackle = np.zeros(N)
    idx = rng.integers(0, N, 900)
    crackle[idx] = rng.standard_normal(900) * 0.25
    crackle = hp(crackle, 2000) + lp(rng.standard_normal(N), 400) * 0.01
    buf += crackle
    buf = lp(buf, 6500)
    return master(reverb(buf, 1.5, 0.25) + lp(drums, 7000), 'lofi-desk', 'Lo-fi Desk', 'Chill · explainer', bpm)


# 5. Tech Wave — synthwave arps
def tech_wave():
    bpm = 104
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    prog = [(45, [57, 60, 64]), (41, [53, 57, 60]), (43, [55, 59, 62]), (40, [52, 56, 59])]  # Am F G E
    bars = int(LEN / (4 * b)) + 1
    for bar in range(bars):
        root, ch = prog[bar % 4]
        t0 = bar * 4 * b
        for s in range(16):
            place(buf, bass(note(root - 12 + (12 if s % 4 == 2 else 0)), b / 4 * 0.9, 900), t0 + s * b / 4, 0.3)
        gate = np.zeros(int(4 * b * SR))
        for s in range(16):
            a = int(s * b / 4 * SR)
            gate[a : a + int(b / 4 * 0.6 * SR)] = 1
        gate = lp(gate, 60)
        place(buf, pad([note(n + 12) for n in ch], int(4 * b * SR), 2600, 0.05) * gate, t0, 0.3)
        seq = [ch[0] + 24, ch[1] + 24, ch[2] + 24, ch[1] + 24] * 2
        for s, n in enumerate(seq):
            place(buf, pluck(note(n), 0.25, 6000, 12), t0 + s * b / 2 + b / 4, 0.12, pan=0.5 if s % 2 else -0.5)
        for q in range(4):
            place(drums, kick(0.4), t0 + q * b, 0.85)
            if q in (1, 3):
                place(drums, snare(0.35, 200, 1.0), t0 + q * b, 0.5)
            place(drums, hat(0.12, True), t0 + q * b + b / 2, 0.25)
    return master(reverb(buf, 2.0, 0.35) + reverb(drums, 1.0, 0.12), 'tech-wave', 'Tech Wave', 'Tech · gadgets', bpm)


# 6. Desi Beat — dhol/tabla groove, tanpura drone, bansuri line
def desi_beat():
    bpm = 98
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    sa = 50  # D
    t = np.arange(N) / SR
    # tanpura-like drone: Pa, Sa, Sa, low Sa cycling
    drone_notes = [sa - 5, sa, sa, sa - 12]
    cyc = 4 * b
    for k in range(int(LEN / (cyc / 4)) + 1):
        f = note(drone_notes[k % 4])
        n = int(SR * 2.4)
        tt = np.arange(n) / SR
        x = sum(np.sin(2 * np.pi * f * h * tt) / h ** 1.2 for h in range(1, 9))
        x *= np.exp(-tt * 1.4) * (1 + 0.3 * np.sin(2 * np.pi * 3 * tt))
        place(buf, x, k * cyc / 4, 0.09, pan=-0.2 + 0.4 * (k % 2))
    # keherwa-style groove (8 beats per 2 bars): dha ge na ti na ka dhi na
    pattern = [
        (0.0, 'dha'), (0.5, 'ge'), (1.0, 'na'), (1.5, 'ti'), (2.0, 'na'), (2.5, 'ka'), (3.0, 'dhi'), (3.5, 'na'),
        (3.75, 'ge'),
    ]
    bars = int(LEN / (4 * b)) + 1
    for bar in range(bars):
        t0 = bar * 4 * b
        for pos, bol in pattern:
            if bol in ('dha', 'dhi', 'ge'):
                place(drums, tabla(75, 0.6, 1.6, 0.2), t0 + pos * b, 0.9 if bol != 'ge' else 0.5, pan=-0.15)
            if bol in ('dha', 'dhi', 'na', 'ti'):
                place(drums, tabla(410, 0.35, 1.05, 0.7), t0 + pos * b, 0.35 if bol == 'ti' else 0.5, pan=0.2)
            if bol == 'ka':
                place(drums, snare(0.15, 300, 0.7), t0 + pos * b, 0.25)
        if bar >= 1:
            place(drums, clap(), t0 + 2 * b, 0.35)
        for q in range(4):
            place(drums, hat(0.04), t0 + q * b + b / 2, 0.18)
        place(buf, bass(note(sa - 12), b * 1.4, 350), t0, 0.45)
        place(buf, bass(note(sa - 12 + 7), b * 0.9, 350), t0 + 2.5 * b, 0.3)
    # bansuri phrase in D major pentatonic (Sa Re Ga Pa Dha)
    S = [0, 2, 4, 7, 9, 12, 14, 16]
    phrase = [(4, 1), (5, 0.5), (4, 0.5), (3, 1), (2, 1), (3, 2), (0, 0), (2, 0.5), (3, 0.5), (4, 1), (6, 1), (5, 1), (4, 1), (3, 2), (0, 0)]
    start = 4 * 4 * b
    pos = start
    for rep in range(3):
        for deg, dur in phrase:
            if dur == 0:
                pos += b
                continue
            place(buf, flute(note(sa + 12 + S[deg]), dur * b * 0.98), pos, 0.2, pan=0.1)
            pos += dur * b
            if pos > LEN - 3:
                break
    return master(reverb(buf, 2.2, 0.35) + reverb(drums, 0.8, 0.1), 'desi-beat', 'Desi Beat', 'Indian · festive', bpm)



# ================= NEWS TONES =================
def impact(len_s=2.5):
    """Trailer-style hit: sub boom + noise crash."""
    n = int(SR * len_s)
    t = np.arange(n) / SR
    boom = kick(len_s, 110, 32, 1.5)[:n]
    sub = np.sin(2 * np.pi * 42 * t) * np.exp(-t * 2.2) * 0.8
    crash = lp(rng.standard_normal(n), 6000) * np.exp(-t * 3.5) * 0.35
    return boom + sub + crash


def whoosh_up(len_s=1.0):
    """Reverse-cymbal style riser that lands on the downbeat."""
    n = int(SR * len_s)
    t = np.arange(n) / SR
    x = hp(rng.standard_normal(n), 2500) * (t / len_s) ** 3
    return x * 0.5


def brass_stab(freqs, len_s=0.35):
    n = int(SR * len_s)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for f in freqs:
        for d in (-0.006, 0.0, 0.007):
            x += saw(f, n, d)
    x /= len(freqs) * 3
    bright = lp(x, 4200)
    dark = lp(x, 700)
    e = np.exp(-t * 14)
    return (bright * e + dark * (1 - e)) * env(n, a=0.004, d=len_s, s=0.6, r=0.06, hold=len_s - 0.06)


def bell(f, len_s=2.0, index=2.2):
    n = int(SR * len_s)
    t = np.arange(n) / SR
    mod = index * np.exp(-t * 2.5) * np.sin(2 * np.pi * f * 3.5 * t)
    return np.sin(2 * np.pi * f * t + mod) * np.exp(-t * 2.2)


def tom(pitch=110, len_s=0.6):
    return tabla(pitch, len_s, 1.8, 0.15) * 1.2


def beep(f, len_s=0.09):
    n = int(SR * len_s)
    x = square(f, n, 0.5) * 0.35 + sine(f, n) * 0.4
    return lp(x, 5000) * env(n, a=0.002, d=99, s=1, r=0.01, hold=len_s - 0.01)


def news_bed(buf, drums, bpm, prog, start_bar=0, bars=None, drive=True):
    """Shared urgent 16th-note bed used under the news tones."""
    b = grid(bpm)
    bars = bars or int(LEN / (4 * b)) + 1
    for bar in range(start_bar, bars):
        root, ch = prog[bar % len(prog)]
        t0 = bar * 4 * b
        place(buf, pad([note(n + 12) for n in ch], int(4 * b * SR), 1500, 0.3), t0, 0.25)
        for s16 in range(16):
            acc = 1.0 if s16 % 4 == 0 else 0.6
            place(buf, pluck(note(root - 12 + (12 if s16 % 8 == 6 else 0)), b / 4 * 0.85, 1100, 14), t0 + s16 * b / 4, 0.28 * acc)
        if drive:
            for q in range(4):
                place(drums, kick(0.4), t0 + q * b, 0.8)
                if q in (1, 3):
                    place(drums, snare(0.3, 200, 0.9), t0 + q * b, 0.45)
                place(drums, hat(0.05), t0 + q * b + b / 2, 0.3)


# 7. Breaking News — hit, brass fanfare, driving bed
def breaking_news():
    bpm = 128
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    place(buf, whoosh_up(1.0), 0.0, 0.8)
    hit_t = 1.0
    place(drums, impact(), hit_t, 1.0)
    # "DA - DA - DAAAA" stabs in D minor
    stabs = [(0.0, [62, 65, 69], 0.22), (0.35, [62, 65, 69], 0.22), (0.7, [58, 62, 65, 70], 0.9)]
    for off, ch, ln in stabs:
        place(buf, brass_stab([note(n) for n in ch], ln), hit_t + off, 0.7)
    for k in range(10):
        place(drums, tom(95 + k * 3, 0.4), hit_t + 1.7 + k * 0.06, 0.25 + k * 0.05)
    start = hit_t + 2.4
    prog = [(50, [62, 65, 69]), (46, [58, 62, 65]), (48, [60, 64, 67]), (45, [57, 61, 64])]
    sub = np.zeros((2, N))
    news_bed(sub, drums, bpm, prog)
    shift = int(start * SR)
    buf[:, shift:] += sub[:, : N - shift]
    for bar in range(0, 20, 4):
        t = start + bar * 4 * b
        if t < LEN - 3:
            place(buf, brass_stab([note(n) for n in (62, 65, 69)], 0.3), t, 0.45)
            place(drums, impact(1.5), t, 0.35)
    return master(reverb(buf, 1.8, 0.3) + drums, 'breaking-news', 'Breaking News', 'Hit + fanfare', bpm, 'News tones')


# 8. Flash News — alert bleeps then pulsing bed
def flash_news():
    bpm = 120
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    pattern = [1320, 1320, 990, 1320, 0, 1320, 990, 1760]
    for rep in range(2):
        for k, f in enumerate(pattern):
            if f:
                place(buf, beep(f), rep * 1.2 + k * 0.12, 0.35, pan=0.4 if k % 2 else -0.4)
    place(drums, impact(1.8), 2.4, 0.8)
    prog = [(52, [64, 67, 71]), (48, [60, 64, 67]), (50, [62, 66, 69]), (47, [59, 62, 66])]
    sub = np.zeros((2, N))
    news_bed(sub, drums, bpm, prog)
    shift = int(2.4 * SR)
    buf[:, shift:] += sub[:, : N - shift]
    # alert blips every 2 bars
    for bar in range(0, 16, 2):
        t = 2.4 + bar * 4 * b + 3.5 * b
        if t < LEN - 2:
            place(buf, beep(1760, 0.07), t, 0.2)
            place(buf, beep(1320, 0.07), t + 0.1, 0.2)
    for s in range(int((LEN - 2.4) / (b / 4))):
        place(drums, tick(), 2.4 + s * b / 4, 0.18 if s % 4 else 0.35, pan=0.3)
    return master(reverb(buf, 1.2, 0.25) + drums, 'flash-news', 'Flash News', 'Alert bleeps', bpm, 'News tones')


# 9. Top Headlines — news-room tom groove
def top_headlines():
    bpm = 100
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    place(drums, impact(), 0.0, 0.9)
    place(buf, brass_stab([note(n) for n in (55, 62, 67, 70)], 1.2), 0.0, 0.5)
    groove = [(0, 70), (0.75, 95), (1.5, 70), (2, 130), (2.5, 95), (3, 70), (3.25, 70), (3.5, 130)]
    bars = int(LEN / (4 * b)) + 1
    for bar in range(1, bars):
        t0 = bar * 4 * b - 2 * b  # groove enters half a bar after the opening hit
        for pos, p in groove:
            place(drums, tom(p, 0.5), t0 + pos * b, 0.55, pan=(p - 95) / 120)
        place(drums, snare(0.3, 190, 1.0), t0 + b, 0.35)
        place(drums, snare(0.3, 190, 1.0), t0 + 3 * b, 0.35)
        for q in range(8):
            place(drums, hat(0.04), t0 + q * b / 2, 0.2)
        place(buf, bass(note(43), 4 * b * 0.95, 260), t0, 0.5)
        if bar % 2 == 0:
            place(buf, brass_stab([note(n) for n in (55, 62, 67)], 0.25), t0, 0.35)
            place(buf, brass_stab([note(n) for n in (53, 60, 65)], 0.25), t0 + 2.5 * b, 0.3)
        place(buf, pad([note(n) for n in (67, 70, 74)], int(4 * b * SR), 1200, 0.4), t0, 0.15)
    return master(reverb(buf, 1.5, 0.25) + reverb(drums, 0.9, 0.12), 'top-headlines', 'Top Headlines', 'News drums', bpm, 'News tones')


# 10. Countdown Clock — tick-tock tension with hits
def countdown_clock():
    bpm = 120
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    beats = int(LEN / b)
    for k in range(beats):
        t0 = k * b
        f = 3000 if k % 2 == 0 else 2200
        n = int(SR * 0.05)
        tt = np.arange(n) / SR
        clk = (np.sin(2 * np.pi * f * tt) + hp(rng.standard_normal(n), 4000) * 0.4) * np.exp(-tt * 180) * 0.5
        place(drums, clk, t0, 0.6, pan=0.25 if k % 2 else -0.25)
        if k % 8 == 0:
            place(drums, impact(1.2), t0, 0.45)
        if k % 2 == 0:
            place(drums, kick(0.3, 120, 50, 0.6), t0, 0.5)
    # rising semitone pulses (tension)
    for bar in range(int(LEN / (4 * b)) + 1):
        root = 45 + (bar % 8)
        t0 = bar * 4 * b
        for e in range(8):
            place(buf, pluck(note(root - 12), b / 2 * 0.9, 700, 10), t0 + e * b / 2, 0.35)
        place(buf, pad([note(root + 12), note(root + 15), note(root + 19)], int(4 * b * SR), 900 + bar * 120, 0.8), t0, 0.22)
    return master(reverb(buf, 1.6, 0.3) + drums, 'countdown-clock', 'Countdown Clock', 'Ticking tension', bpm, 'News tones')


# 11. Bulletin Intro — timpani roll, hit, bell motif, warm bed
def bulletin_intro():
    bpm = 92
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    roll_len = 1.6
    k = 0
    while k * 0.045 < roll_len:
        place(drums, tom(70, 0.5), k * 0.045, 0.08 + 0.35 * (k * 0.045 / roll_len) ** 2)
        k += 1
    place(drums, impact(), roll_len, 1.0)
    motif = [74, 77, 81, 79]  # news-style 4-note bell motif
    for rep in range(2):
        for i, n in enumerate(motif):
            place(buf, bell(note(n), 2.2), roll_len + 0.1 + rep * 2.4 + i * 0.3, 0.35, pan=-0.3 + i * 0.2)
    prog = [[50, 57, 62, 65], [46, 53, 58, 62], [43, 50, 55, 58], [45, 52, 57, 61]]
    bars = int(LEN / (4 * b)) + 1
    for bar in range(1, bars):
        t0 = roll_len + bar * 4 * b - 4 * b + 0.2
        ch = prog[bar % 4]
        place(buf, pad([note(n) for n in ch], int(4 * b * SR), 1500, 0.8), t0, 0.35)
        place(buf, bass(note(ch[0] - 12), 4 * b * 0.9, 300), t0, 0.4)
        for q in range(4):
            place(drums, kick(0.4, 100, 45, 0.4), t0 + q * b, 0.5 if q in (0, 2) else 0)
            place(drums, hat(0.05), t0 + q * b + b / 2, 0.18)
        if bar % 4 == 0:
            for i, n in enumerate(motif):
                place(buf, bell(note(n), 1.8, 1.5), t0 + i * b / 2, 0.18)
    return master(reverb(buf, 2.6, 0.35) + drums, 'bulletin-intro', 'Bulletin Intro', 'Timpani + bells', bpm, 'News tones')


# 12. Urgent Alert — siren sweep with heavy hits
def urgent_alert():
    bpm = 140
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    t = np.arange(N) / SR
    lfo = 0.5 * (1 - np.cos(2 * np.pi * 0.5 * t))
    f = 520 + 380 * lfo
    siren = np.sin(2 * np.pi * np.cumsum(f) / SR)
    siren = bp(siren + 0.3 * np.sign(siren), 400, 2500) * 0.12
    siren *= np.clip(t / 0.5, 0, 1) * (1 - 0.6 * np.clip((t - 4) / 2, 0, 1))
    buf[0] += siren
    buf[1] += siren
    place(drums, impact(), 0.0, 0.9)
    prog = [(45, [57, 60, 64]), (45, [57, 60, 64]), (41, [53, 57, 60]), (43, [55, 59, 62])]
    news_bed(buf, drums, bpm, prog, start_bar=1)
    for bar in range(1, int(LEN / (4 * b)) + 1, 2):
        place(drums, impact(1.2), bar * 4 * b, 0.4)
    return master(reverb(buf, 1.3, 0.25) + drums, 'urgent-alert', 'Urgent Alert', 'Siren + hits', bpm, 'News tones')


# 13. Tamil Mass Beat — parai/thavil groove, nadhaswaram-style lead
def nadhaswaram(f0, f1, len_s, glide=0.08):
    n = int(SR * len_s)
    t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t / glide) if f0 else np.full(n, f1)
    f = f * (1 + 0.012 * np.sin(2 * np.pi * 6 * t) * np.clip((t - 0.1) * 4, 0, 1))
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = np.sin(ph) + 0.6 * np.sin(2 * ph) + 0.45 * np.sin(3 * ph) + 0.3 * np.sin(4 * ph) + 0.2 * np.sin(5 * ph)
    x = bp(x, 500, 4000) * 1.4
    return x * env(n, a=0.03, d=99, s=1, r=0.06, hold=len_s - 0.06)


def tamil_mass():
    bpm = 104
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    sa = 55  # G
    bars = int(LEN / (4 * b)) + 1
    # parai / thavil pattern (dappankuthu feel): ta . ka ta | ta ka . ta
    hits = [(0, 'low'), (0.75, 'high'), (1.0, 'low'), (1.5, 'high'), (2.0, 'low'), (2.5, 'high'), (2.75, 'high'), (3.0, 'low'), (3.5, 'high')]
    for bar in range(bars):
        t0 = bar * 4 * b
        for pos, kind in hits:
            if kind == 'low':
                place(drums, tabla(85, 0.5, 1.7, 0.4), t0 + pos * b, 0.9, pan=-0.15)
            else:
                place(drums, tabla(330, 0.25, 1.1, 1.3), t0 + pos * b, 0.55, pan=0.2)
        place(drums, clap(), t0 + b, 0.45)
        place(drums, clap(), t0 + 3 * b, 0.45)
        for q in range(8):
            place(drums, hat(0.04), t0 + q * b / 2, 0.22)
        place(buf, bass(note(sa - 24), b * 1.5, 300), t0, 0.5)
        place(buf, bass(note(sa - 24 + 7), b * 1.2, 300), t0 + 2 * b, 0.4)
        # drone
        place(buf, pad([note(sa - 12), note(sa - 5)], int(4 * b * SR), 800, 0.2), t0, 0.18)
    # Mayamalavagowla-flavoured phrase: S R1 G3 M1 P D1 N3 S'
    scale = [0, 1, 4, 5, 7, 8, 11, 12, 13, 16]
    phrase = [(4, 0.5), (5, 0.5), (4, 0.5), (2, 0.5), (4, 1), (7, 1), (6, 0.5), (5, 0.5), (4, 1), (2, 0.5), (1, 0.5), (0, 2)]
    t = 2 * 4 * b
    prev = None
    while t < LEN - 4:
        for deg, dur in phrase:
            f1 = note(sa + 12 + scale[deg])
            place(buf, nadhaswaram(prev, f1, dur * b * 0.97), t, 0.16, pan=0.1)
            prev = f1
            t += dur * b
        t += 4 * b
    return master(reverb(buf, 1.6, 0.3) + reverb(drums, 0.7, 0.1), 'tamil-mass', 'Tamil Mass Beat', 'Parai + nadhaswaram', bpm, 'Background beds')



# ================= extra instruments =================
def sub808(f, len_s, glide_from=None, glide=0.07, drive=2.0, decay=1.0):
    """808 bass with optional pitch slide from the previous note."""
    n = int(SR * len_s)
    t = np.arange(n) / SR
    fr = np.full(n, f) if glide_from is None else f + (glide_from - f) * np.exp(-t / glide)
    fr = fr * (1 + 0.6 * np.exp(-t * 60))  # punchy pitch drop at the start
    x = np.sin(2 * np.pi * np.cumsum(fr) / SR)
    x = np.tanh(x * drive) / np.tanh(drive)
    return x * env(n, a=0.003, d=decay, s=0.35, r=0.05, hold=len_s - 0.05)


def cowbell(f=587, len_s=0.32):
    """Phonk-style pitched cowbell."""
    n = int(SR * len_s)
    t = np.arange(n) / SR
    x = square(f, n, 0.5) + square(f * 1.505, n, 0.5)
    x = bp(x, f * 0.9, f * 4)
    return x * (np.exp(-t * 22) * 0.6 + np.exp(-t * 6) * 0.4) * 0.5


def piano(f, len_s=1.5, bright=1.0):
    n = int(SR * len_s)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for h in range(1, 8):
        x += np.sin(2 * np.pi * f * h * (1 + 0.0004 * h * h) * t) / h ** 1.4 * np.exp(-t * (1.2 + h * 0.9 / bright))
    hammer = hp(rng.standard_normal(n), 2000) * np.exp(-t * 200) * 0.05
    return (x + hammer) * env(n, a=0.002, d=99, s=1, r=0.08, hold=len_s - 0.08) * 0.6


def supersaw(freqs, n, cutoff=3000, attack=0.02, release=0.2):
    x = np.zeros(n)
    for f in freqs:
        for d in (-0.012, -0.007, -0.003, 0.0, 0.003, 0.007, 0.012):
            x += saw(f, n, d)
    x /= len(freqs) * 7
    x = lp(x, cutoff, 2)
    return x * env(n, a=attack, d=99, s=1, r=release, hold=n / SR - release)


def stacc(f, len_s=0.18, cutoff=2800):
    """Staccato string section note."""
    n = int(SR * len_s)
    x = sum(saw(f, n, d) for d in (-0.005, 0.0, 0.006)) / 3
    return lp(x, cutoff) * env(n, a=0.006, d=len_s * 0.6, s=0.4, r=0.04, hold=len_s - 0.04)


def riser(len_s=2.0, lo=300, hi=8000):
    """Filtered-noise sweep plus rising tone."""
    n = int(SR * len_s)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    seg = 32
    L = n // seg + 1
    for k in range(seg):
        a, z = k * L, min(n, (k + 1) * L)
        cut = lo * (hi / lo) ** (k / seg)
        out[a:z] = lp(noise[max(0, a - 2000):z], cut)[-(z - a):]
    f = 120 * (16 ** (t / len_s))
    tone = np.sin(2 * np.pi * np.cumsum(f) / SR) * 0.3
    return (out * 0.5 + tone) * (t / len_s) ** 2


def typewriter():
    n = int(SR * 0.05)
    t = np.arange(n) / SR
    return (hp(rng.standard_normal(n), 2500) * np.exp(-t * 350) + np.sin(2 * np.pi * 1700 * t) * np.exp(-t * 300) * 0.4) * 0.6


def shaker(len_s=0.08):
    n = int(SR * len_s)
    t = np.arange(n) / SR
    return bp(rng.standard_normal(n), 5000, 11000) * np.minimum(1, t / 0.01) * np.exp(-t * 45) * 0.4


def log_drum(f, len_s=0.45):
    """Amapiano log drum: woody pitched bass hit with a bend."""
    n = int(SR * len_s)
    t = np.arange(n) / SR
    fr = f * (1 + 0.45 * np.exp(-t * 35))
    ph = 2 * np.pi * np.cumsum(fr) / SR
    x = np.sin(ph) + 0.25 * np.sin(2 * ph + 0.5) + 0.1 * np.sin(3 * ph)
    x = np.tanh(x * 1.8) * np.exp(-t * 5.5)
    return x * 0.8


def rim():
    n = int(SR * 0.06)
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * 1700 * t) * 0.5 + bp(rng.standard_normal(n), 2000, 7000) * 0.6) * np.exp(-t * 120) * 0.5


def chirp(f0=500, f1=1400, len_s=0.12):
    """Jersey-club style 'squeak'."""
    n = int(SR * len_s)
    t = np.arange(n) / SR
    fr = f0 * (f1 / f0) ** (t / len_s)
    return np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-t * 18) * env(n, a=0.004, d=99, s=1, r=0.01, hold=len_s - 0.01) * 0.4


def tumbi(f, len_s=0.25):
    """Bright Punjabi tumbi-like pluck."""
    n = int(SR * len_s)
    t = np.arange(n) / SR
    x = saw(f, n) * 0.5 + square(f, n, 0.12) * 0.5
    return bp(x, f * 0.8, 6000) * np.exp(-t * 14) * 0.9


def sidechain(buf, times, depth=0.7, rel=0.16):
    g = np.ones(buf.shape[1])
    L = int(SR * rel * 4)
    curve = 1 - depth * np.exp(-np.arange(L) / (SR * rel))
    for k in times:
        i = int(k * SR)
        if i >= len(g):
            continue
        j = min(len(g), i + L)
        g[i:j] = np.minimum(g[i:j], curve[: j - i])
    return buf * g


def stutter(buf, at, slice_s, reps):
    """Repeat a short slice (glitch transition)."""
    i = int(at * SR)
    L = int(slice_s * SR)
    sl = buf[:, i : i + L].copy()
    for r in range(1, reps):
        a = i + r * L
        if a + L > buf.shape[1]:
            break
        buf[:, a : a + L] = sl * (1 - 0.05 * r)
    return buf


def crash(len_s=2.0):
    n = int(SR * len_s)
    t = np.arange(n) / SR
    return hp(rng.standard_normal(n), 3500) * np.exp(-t * 2.2) * 0.35


def bars_for(b):
    return int(LEN / (4 * b)) + 1


# ================= MORE NEWS TONES =================
# Prime Time — orchestral news theme: string ostinato, timpani, brass call
def prime_time():
    bpm = 120
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    place(buf, riser(1.5), 0, 0.6)
    place(drums, impact(), 1.5, 1.0)
    t0s = 1.5
    prog = [(50, [62, 65, 69]), (46, [58, 62, 65]), (48, [60, 64, 67]), (45, [57, 61, 64])]  # Dm Bb C A
    ost = [0, 2, 1, 2, 0, 2, 1, 2, 0, 2, 1, 2, 0, 1, 2, 1]
    for bar in range(bars_for(b)):
        root, ch = prog[bar % 4]
        t0 = t0s + bar * 4 * b
        if t0 > LEN:
            break
        for s, k in enumerate(ost):
            place(buf, stacc(note(ch[k]), b / 4 * 0.9), t0 + s * b / 4, 0.16, pan=-0.35)
            place(buf, stacc(note(ch[k] - 12), b / 4 * 0.9, 1600), t0 + s * b / 4, 0.12, pan=0.35)
        place(buf, bass(note(root - 12), 4 * b * 0.95, 300), t0, 0.4)
        place(drums, tom(62, 0.9), t0, 0.8)
        place(drums, tom(62, 0.9), t0 + 2 * b, 0.6)
        place(drums, tom(80, 0.5), t0 + 3.5 * b, 0.4)
        if bar % 2 == 0:
            for k, (off, dur) in enumerate([(0, 0.5), (0.5, 0.5), (1, 2.5)]):
                place(buf, brass_stab([note(n + 12 * (k == 2)) for n in ch[:2]] + [note(ch[2])], dur * b), t0 + off * b, 0.35)
        else:
            place(buf, pad([note(n) for n in ch], int(4 * b * SR), 2000, 0.5), t0, 0.25)
        if bar % 4 == 3:
            for s in range(8):
                place(drums, snare(0.2, 200, 0.9), t0 + 2 * b + s * b / 4, 0.12 + s * 0.04)
        if bar % 4 == 0 and bar > 0:
            place(drums, crash(), t0, 0.6)
    return master(reverb(buf, 2.4, 0.35) + reverb(drums, 1.4, 0.2), 'prime-time', 'Prime Time', 'Orchestral news theme', bpm, 'News tones')


# Newsroom Ticker — teleprinter clicks, carriage-return bell, pulse bed
def newsroom_ticker():
    bpm = 108
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    prog = [(48, [60, 63, 67]), (44, [56, 60, 63]), (46, [58, 62, 65]), (43, [55, 59, 62])]  # Cm Ab Bb G
    for bar in range(bars_for(b)):
        root, ch = prog[bar % 4]
        t0 = bar * 4 * b
        for s in range(14):
            if rng.random() < 0.85:
                place(drums, typewriter(), t0 + s * b / 4 + rng.uniform(-0.008, 0.008), 0.35 + 0.2 * rng.random(), pan=rng.uniform(-0.4, 0.4))
        place(buf, bell(note(96), 1.0, 0.8), t0 + 3.5 * b, 0.15, pan=0.5)
        for e in range(8):
            place(buf, bass(note(root - 12), b / 2 * 0.8, 700, 'square'), t0 + e * b / 2, 0.3)
        if bar >= 1:
            place(buf, pad([note(n + 12) for n in ch], int(4 * b * SR), 1400, 0.4), t0, 0.22)
            for q in range(4):
                place(drums, kick(0.35, 120, 48, 0.6), t0 + q * b, 0.6)
                if q in (1, 3):
                    place(drums, clap(), t0 + q * b, 0.35)
        if bar >= 2 and bar % 2 == 0:
            for k, n in enumerate([ch[2] + 12, ch[1] + 12, ch[2] + 12, ch[0] + 24]):
                place(buf, pluck(note(n), 0.3, 4500, 8), t0 + k * b * 0.75, 0.13)
    return master(reverb(buf, 1.4, 0.25) + drums, 'newsroom-ticker', 'Newsroom Ticker', 'Teleprinter + pulse', bpm, 'News tones')


# Election Night — snare march, heroic brass, bells
def election_night():
    bpm = 112
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    prog = [(46, [58, 62, 65]), (51, [63, 67, 70]), (53, [65, 69, 72]), (46, [58, 62, 65])]  # Bb Eb F Bb
    march = [0, 0.75, 1, 1.5, 2, 2.25, 2.5, 3, 3.25, 3.5, 3.75]
    for bar in range(bars_for(b)):
        root, ch = prog[bar % 4]
        t0 = bar * 4 * b
        for p in march:
            place(drums, snare(0.18, 220, 1.0), t0 + p * b, 0.35 if p == int(p) else 0.18, pan=0.1)
        place(drums, tom(58, 0.9), t0, 0.7)
        place(drums, tom(58, 0.9), t0 + 2 * b, 0.5)
        place(buf, bass(note(root - 12), 4 * b * 0.95, 300), t0, 0.4)
        place(buf, pad([note(n) for n in ch], int(4 * b * SR), 1700, 0.3), t0, 0.22)
        if bar >= 1:
            place(buf, brass_stab([note(n) for n in ch], 1.4 * b), t0, 0.4)
            place(buf, brass_stab([note(n + 2 if i == 2 else n) for i, n in enumerate(ch)], 0.5 * b), t0 + 1.5 * b, 0.3)
            place(buf, brass_stab([note(n + 12) for n in ch[1:]], 1.8 * b), t0 + 2 * b, 0.35)
        if bar % 4 == 0:
            for i, n in enumerate([ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[0] + 24]):
                place(buf, bell(note(n), 1.8), t0 + i * b / 2, 0.2, pan=-0.3 + 0.2 * i)
            place(drums, crash(), t0, 0.5)
    return master(reverb(buf, 2.2, 0.35) + reverb(drums, 1.0, 0.15), 'election-night', 'Election Night', 'Snare march + brass', bpm, 'News tones')


# Live Update — modern electronic news, sidechained chords, glitch stingers
def live_update():
    bpm = 124
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    prog = [(52, [64, 67, 71]), (48, [60, 64, 67]), (55, [62, 67, 71]), (50, [62, 66, 69])]  # Em C G D
    kicks = []
    for bar in range(bars_for(b)):
        root, ch = prog[bar % 4]
        t0 = bar * 4 * b
        place(buf, supersaw([note(n) for n in ch], int(4 * b * SR), 2600, 0.01), t0, 0.35)
        for e in range(8):
            place(buf, bass(note(root - 24), b / 2 * 0.7, 600), t0 + e * b / 2 + b / 4, 0.4)
        for q in range(4):
            place(drums, kick(0.4), t0 + q * b, 0.9)
            kicks.append(t0 + q * b)
            if q in (1, 3):
                place(drums, clap(), t0 + q * b, 0.5)
            place(drums, hat(0.12, True), t0 + q * b + b / 2, 0.22)
        if bar % 2 == 1:
            for k, f in enumerate([1760, 1320, 1760]):
                place(buf, beep(f, 0.07), t0 + 3 * b + k * b / 4, 0.18)
    buf = sidechain(buf, kicks, 0.75, 0.12)
    mix = reverb(buf, 1.4, 0.25) + drums
    for bar in range(3, bars_for(b), 4):
        mix = stutter(mix, bar * 4 * b + 3 * b, b / 8, 8)
    return master(mix, 'live-update', 'Live Update', 'Electronic · glitch', bpm, 'News tones')


# Market Watch — business news: piano arps, steady pulse
def market_watch():
    bpm = 110
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    prog = [(48, [60, 64, 67, 71]), (45, [57, 60, 64, 67]), (41, [57, 60, 65, 69]), (43, [55, 59, 62, 67])]
    for bar in range(bars_for(b)):
        root, ch = prog[bar % 4]
        t0 = bar * 4 * b
        for s in range(8):
            place(buf, piano(note(ch[[0, 2, 1, 3, 2, 1, 3, 2][s]] + 12), 0.9), t0 + s * b / 2, 0.35, pan=0.2 if s % 2 else -0.2)
        place(buf, pad([note(n) for n in ch], int(4 * b * SR), 1300, 0.6), t0, 0.15)
        for q in range(4):
            place(buf, bass(note(root - 12), b * 0.5, 450), t0 + q * b, 0.35)
            place(drums, kick(0.35, 110, 48, 0.4), t0 + q * b, 0.55)
            place(drums, hat(0.05), t0 + q * b + b / 2, 0.25)
            place(drums, shaker(), t0 + q * b + b / 4, 0.2)
            place(drums, shaker(), t0 + q * b + 3 * b / 4, 0.2)
            if q in (1, 3) and bar >= 1:
                place(drums, rim(), t0 + q * b, 0.5)
    return master(reverb(buf, 1.6, 0.25) + drums, 'market-watch', 'Market Watch', 'Business · piano pulse', bpm, 'News tones')


# Sports Desk — stadium stomps, claps, brass riff
def sports_desk():
    bpm = 132
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    prog = [(45, [57, 60, 64]), (48, [60, 64, 67]), (43, [55, 59, 62]), (50, [62, 65, 69])]
    riff = [(0, 0), (0.5, 0), (1, 2), (1.75, 1), (2.5, 0)]
    for bar in range(bars_for(b)):
        root, ch = prog[bar % 4]
        t0 = bar * 4 * b
        for q in range(4):
            place(drums, kick(0.5, 100, 40, 1.2), t0 + q * b, 0.9)
            place(drums, tom(90, 0.4), t0 + q * b, 0.35)
            if q in (1, 3):
                place(drums, clap(), t0 + q * b, 0.7)
                place(drums, clap(), t0 + q * b + 0.012, 0.5, pan=0.4)
            place(drums, hat(0.05), t0 + q * b + b / 2, 0.3)
        for e in range(8):
            place(buf, bass(note(root - 12), b / 2 * 0.8, 800), t0 + e * b / 2, 0.35)
        if bar >= 1:
            for off, k in riff:
                place(buf, brass_stab([note(ch[k] + 12), note(ch[k])], 0.4 * b), t0 + off * b, 0.4)
        if bar % 4 == 0:
            place(drums, crash(), t0, 0.5)
    return master(reverb(buf, 1.6, 0.3) + reverb(drums, 1.2, 0.18), 'sports-desk', 'Sports Desk', 'Stadium stomp + brass', bpm, 'News tones')


# Investigation — dark crime/explainer: drone, heartbeat, clock
def investigation():
    bpm = 84
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    t = np.arange(N) / SR
    drone = (saw(note(33), N) + saw(note(33), N, 0.004) + saw(note(34), N, 0.0)) / 3
    drone = lp(drone, 260) * (0.7 + 0.3 * np.sin(2 * np.pi * 0.11 * t))
    buf[0] += drone * 0.35
    buf[1] += drone * 0.35
    notes = [69, 72, 68, 67, 69, 75, 74, 72]
    for bar in range(bars_for(b)):
        t0 = bar * 4 * b
        place(drums, kick(0.5, 80, 38, 0.3), t0, 0.8)
        place(drums, kick(0.5, 80, 38, 0.3), t0 + 0.28, 0.55)
        place(drums, kick(0.5, 80, 38, 0.3), t0 + 2 * b, 0.8)
        place(drums, kick(0.5, 80, 38, 0.3), t0 + 2 * b + 0.28, 0.55)
        for s in range(16):
            place(drums, tick(), t0 + s * b / 4, 0.12 if s % 4 else 0.22, pan=0.4)
        if bar >= 1:
            place(buf, piano(note(notes[bar % 8] - 12), 2.5, 0.6), t0, 0.35)
            place(buf, piano(note(notes[(bar + 3) % 8] - 12), 2.0, 0.6), t0 + 2.5 * b, 0.22)
        if bar >= 3:
            place(buf, pad([note(57), note(58), note(64)], int(4 * b * SR), 900, 1.2), t0, 0.14)
    return master(reverb(buf, 3.2, 0.45) + reverb(drums, 1.0, 0.15), 'investigation', 'Investigation', 'Dark · crime explainer', bpm, 'News tones')


# Evening Bulletin — warm classic Indian bulletin feel: santoor-like plucks, strings
def evening_bulletin():
    bpm = 96
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    sa = 50  # D
    S = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21]
    place(drums, tom(66, 1.2), 0, 0.7)
    place(drums, impact(2.0), 0, 0.4)
    prog = [[50, 57, 62, 66], [47, 54, 59, 62], [43, 50, 55, 59], [45, 52, 57, 61]]  # D Bm G A
    for bar in range(bars_for(b)):
        t0 = bar * 4 * b
        ch = prog[bar % 4]
        place(buf, pad([note(n + 12) for n in ch[1:]], int(4 * b * SR), 2000, 0.8), t0, 0.22)
        place(buf, bass(note(ch[0] - 12), 4 * b * 0.9, 300), t0, 0.35)
        for s in range(8):
            deg = [5, 4, 3, 4, 5, 6, 5, 3][(s + bar * 2) % 8]
            for d in (0, 0.012):
                place(buf, pluck(note(sa + 12 + S[deg]), 0.6, 6000, 7), t0 + s * b / 2 + d, 0.11, pan=-0.3 + 0.08 * s)
        for q in range(4):
            place(drums, tabla(75, 0.5, 1.5, 0.2), t0 + q * b, 0.5 if q in (0, 2) else 0.0)
            place(drums, tabla(400, 0.3, 1.05, 0.6), t0 + q * b + b / 2, 0.3)
        if bar % 4 == 0 and bar > 0:
            for i, n in enumerate([74, 78, 81, 86]):
                place(buf, bell(note(n), 1.6, 1.4), t0 + i * 0.22, 0.18)
    return master(reverb(buf, 2.4, 0.35) + reverb(drums, 0.8, 0.12), 'evening-bulletin', 'Evening Bulletin', 'Warm · classic Indian', bpm, 'News tones')


# ================= TRENDING REEL STYLES =================
# Phonk Drift — cowbell melody, sliding 808, distorted
def phonk_drift():
    bpm = 130
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    mel = [69, 72, 76, 74, 72, 69, 67, 69, 69, 72, 76, 79, 77, 76, 74, 72]  # 16ths-ish riff
    bassline = [45, 45, 48, 43]
    prev = None
    for bar in range(bars_for(b)):
        t0 = bar * 4 * b
        for s, n in enumerate(mel):
            if s % 3 != 2 or s in (14, 15):
                place(buf, cowbell(note(n)), t0 + s * b / 4, 0.4, pan=0.15 if s % 2 else -0.15)
        r = bassline[bar % 4]
        for off, ln in ((0, 1.5), (1.5, 1), (2.5, 1.5)):
            f = note(r - 12 + (12 if off == 2.5 and bar % 2 else 0))
            place(buf, sub808(f, ln * b, prev), t0 + off * b, 0.7)
            prev = f
        if bar >= 1:
            for p in (0, 0.75, 2.5):
                place(drums, kick(0.4, 150, 50, 1.2), t0 + p * b, 0.9)
            place(drums, snare(0.3, 200, 1.3), t0 + 2 * b, 0.6)
            place(drums, clap(), t0 + 2 * b, 0.5)
            for e in range(8):
                place(drums, hat(0.04), t0 + e * b / 2, 0.3)
            if bar % 2:
                for k in range(6):
                    place(drums, hat(0.03), t0 + 3.5 * b + k * b / 12, 0.22)
    x = reverb(buf, 1.2, 0.2) + drums
    x = np.tanh(x * 1.4) / np.tanh(1.4)
    return master(x, 'phonk-drift', 'Phonk Drift', 'Cowbell · 808 · car edits', bpm, 'Trending reels')


# Drill Slide — UK/Punjabi drill: sliding 808s, triplet hats, dark bells
def drill_slide():
    bpm = 142
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    slides = [(0, 41, 1.5), (1.5, 44, 1.0), (2.5, 39, 1.5)]
    mel = [77, 76, 72, 73, 72, 68, 70, 72]
    prev = None
    for bar in range(bars_for(b)):
        t0 = bar * 4 * b
        tr = (bar % 2) * 2
        for off, n, ln in slides:
            f = note(n - 12 + tr)
            place(buf, sub808(f, ln * b, prev, 0.09, 2.5), t0 + off * b, 0.7)
            prev = f
        for i, n in enumerate(mel):
            place(buf, bell(note(n - 12), 0.9, 1.2), t0 + i * b / 2, 0.1, pan=0.3)
        place(buf, pad([note(65), note(68), note(72)], int(4 * b * SR), 1100, 0.5), t0, 0.14)
        if bar >= 1:
            place(drums, kick(0.35, 140, 50, 1.0), t0, 0.8)
            place(drums, kick(0.35, 140, 50, 1.0), t0 + 2.75 * b, 0.6)
            place(drums, snare(0.25, 230, 1.2), t0 + 2 * b, 0.55)
            place(drums, snare(0.2, 230, 0.8), t0 + 3.5 * b, 0.25)
            pat = [0, 2 / 3, 4 / 3, 2, 2.5, 3, 3 + 1 / 3, 3 + 2 / 3]
            for p in pat:
                place(drums, hat(0.035), t0 + p * b, 0.3, pan=0.2)
            place(drums, rim(), t0 + 1.5 * b, 0.35)
    return master(reverb(buf, 1.8, 0.3) + drums, 'drill-slide', 'Drill Slide', 'Dark · sliding 808', bpm, 'Trending reels')


# Trap Hype — rolling hats, long 808, square lead
def trap_hype():
    bpm = 140
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    lead = [(0, 72), (0.5, 75), (1, 79), (1.5, 77), (2, 75), (2.75, 72), (3.25, 74)]
    roots = [36, 36, 39, 34]
    place(buf, riser(3.4), 0, 0.4)
    for bar in range(bars_for(b)):
        t0 = bar * 4 * b
        place(buf, sub808(note(roots[bar % 4]), 3.5 * b, None, drive=1.6, decay=2.0), t0, 0.7)
        if bar >= 2:
            for off, n in lead:
                place(buf, lp(square(note(n), int(0.4 * b * SR), 0.3), 3500) * env(int(0.4 * b * SR), a=0.003, d=0.2, s=0.5, r=0.03, hold=0.4 * b - 0.03), t0 + off * b, 0.12, pan=-0.2)
        place(buf, pad([note(60), note(63), note(67)], int(4 * b * SR), 1300, 0.4), t0, 0.14)
        if bar >= 1:
            place(drums, kick(0.4, 150, 45, 1.2), t0, 0.9)
            place(drums, kick(0.4, 150, 45, 1.2), t0 + 1.75 * b, 0.6)
            place(drums, clap(), t0 + 2 * b, 0.7)
            place(drums, snare(0.25, 200, 1.0), t0 + 2 * b, 0.4)
            p = 0.0
            while p < 4:
                roll = (bar % 2 == 1 and 3 <= p < 3.5) or (1.5 <= p < 1.75)
                place(drums, hat(0.03), t0 + p * b, 0.28 if not roll else 0.2, pan=0.25)
                p += 1 / 8 if roll else 1 / 2
    return master(reverb(buf, 1.4, 0.22) + drums, 'trap-hype', 'Trap Hype', 'Hats rolls · big 808', bpm, 'Trending reels')


# EDM Drop — build-up, big drop at ~7.5s
def edm_drop():
    bpm = 128
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    prog = [(45, [57, 60, 64]), (41, [53, 57, 60]), (48, [55, 60, 64]), (43, [55, 59, 62])]
    bar_len = 4 * b
    kicks = []
    nb = bars_for(b)
    for bar in range(nb):
        root, ch = prog[bar % 4]
        t0 = bar * bar_len
        section = 'intro' if bar < 2 else 'build' if bar < 4 else 'drop' if bar < 12 else 'break' if bar < 14 else 'drop'
        if section in ('intro', 'break'):
            for q in range(4):
                place(buf, piano(note(ch[q % 3] + 12), 1.0), t0 + q * b, 0.3)
            place(buf, pad([note(n) for n in ch], int(bar_len * SR), 1200, 0.3), t0, 0.2)
        elif section == 'build':
            step = 1 / 2 if bar == 2 else 1 / 4
            if bar == 3:
                step = 1 / 4
            p = 0.0
            while p < 4:
                if bar == 3 and p >= 2:
                    step = 1 / 8
                place(drums, snare(0.15, 210, 1.0), t0 + p * b, 0.2 + 0.1 * (bar - 2) + p * 0.04)
                p += step
            place(buf, supersaw([note(n) for n in ch], int(bar_len * SR), 600 + 1500 * (bar - 2)), t0, 0.2)
            if bar == 2:
                place(buf, riser(2 * bar_len), t0, 0.6)
        else:
            place(buf, supersaw([note(n + 12) for n in ch] + [note(ch[0])], int(bar_len * SR), 5000, 0.005), t0, 0.45)
            for q in range(4):
                place(drums, kick(0.45, 150, 45, 1.2), t0 + q * b, 1.0)
                kicks.append(t0 + q * b)
                place(buf, bass(note(root - 12), b / 2 * 0.8, 1200), t0 + q * b + b / 2, 0.45)
                place(drums, hat(0.15, True), t0 + q * b + b / 2, 0.3)
                if q in (1, 3):
                    place(drums, clap(), t0 + q * b, 0.6)
            if bar in (4, 14):
                place(drums, impact(), t0, 0.7)
                place(drums, crash(), t0, 0.6)
    buf = sidechain(buf, kicks, 0.8, 0.13)
    return master(reverb(buf, 1.8, 0.3) + drums, 'edm-drop', 'EDM Drop', 'Build-up · drop at 7s', bpm, 'Trending reels')


# Bhangra Bounce — dhol chaal, tumbi riff, synth bass
def bhangra_bounce():
    bpm = 100
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    sa = 52  # E
    riff = [12, 12, 15, 12, 10, 7, 10, 12, 12, 12, 15, 17, 15, 12, 10, 7]
    for bar in range(bars_for(b)):
        t0 = bar * 4 * b
        for q in range(4):  # chaal: DAGGA . tilli DAGGA . tilli
            place(drums, tabla(68, 0.55, 1.7, 0.3), t0 + q * b, 1.0, pan=-0.1)
            place(drums, tabla(520, 0.2, 1.1, 1.2), t0 + q * b + 0.66 * b, 0.45, pan=0.25)
            place(drums, tabla(520, 0.2, 1.1, 1.2), t0 + q * b + 0.83 * b, 0.3, pan=0.25)
            if q in (1, 3):
                place(drums, clap(), t0 + q * b, 0.5)
        if bar >= 1:
            for s, n in enumerate(riff):
                if s % 4 != 3:
                    place(buf, tumbi(note(sa + n)), t0 + s * b / 4, 0.3, pan=0.3)
        place(buf, bass(note(sa - 24), b * 1.4, 500, 'square'), t0, 0.45)
        place(buf, bass(note(sa - 24 + 7), b * 0.8, 500, 'square'), t0 + 1.5 * b, 0.35)
        place(buf, bass(note(sa - 24 + 10), b * 1.2, 500, 'square'), t0 + 2.5 * b, 0.35)
        if bar % 4 == 0:
            place(buf, chirp(900, 1800, 0.25), t0, 0.2)  # 'hoi!' accent
    return master(reverb(buf, 1.2, 0.2) + reverb(drums, 0.7, 0.1), 'bhangra-bounce', 'Bhangra Bounce', 'Dhol + tumbi', bpm, 'Trending reels')


# Kuthu Remix — Tamil kuthu thappu meets EDM
def kuthu_remix():
    bpm = 128
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    sa = 55
    prog = [[55, 59, 62], [53, 57, 60], [51, 55, 58], [53, 57, 60]]
    thappu = [(0, 'L'), (0.5, 'H'), (0.75, 'H'), (1, 'L'), (1.5, 'H'), (2, 'L'), (2.25, 'H'), (2.5, 'L'), (3, 'H'), (3.25, 'H'), (3.5, 'L'), (3.75, 'H')]
    kicks = []
    for bar in range(bars_for(b)):
        t0 = bar * 4 * b
        ch = prog[bar % 4]
        for p, k in thappu:
            if k == 'L':
                place(drums, tabla(90, 0.45, 1.8, 0.5), t0 + p * b, 0.85)
            else:
                place(drums, tabla(360, 0.2, 1.1, 1.5), t0 + p * b, 0.5, pan=0.2)
        if bar >= 2:
            for q in range(4):
                place(drums, kick(0.4, 150, 45, 1.0), t0 + q * b, 0.7)
                kicks.append(t0 + q * b)
            place(buf, supersaw([note(n + 12) for n in ch], int(4 * b * SR), 3500, 0.01), t0, 0.3)
        for s in range(8):
            place(buf, nadhaswaram(None, note(sa + 12 + [0, 4, 7, 5, 4, 1, 0, -1][s]), b / 2 * 0.9), t0 + s * b / 2, 0.1 if bar % 2 else 0.0)
        place(buf, bass(note(sa - 24), b * 1.8, 400), t0, 0.45)
        place(buf, bass(note(sa - 24 + 5), b * 1.8, 400), t0 + 2 * b, 0.4)
        if bar % 4 == 1:
            place(buf, riser(4 * b), t0, 0.3)
    buf = sidechain(buf, kicks, 0.7, 0.12)
    return master(reverb(buf, 1.4, 0.25) + reverb(drums, 0.7, 0.1), 'kuthu-remix', 'Kuthu Remix', 'Thappu + EDM', bpm, 'Trending reels')


# Amapiano Log — log drums, shakers, rhodes
def amapiano_log():
    bpm = 113
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    prog = [[57, 60, 64, 67], [53, 57, 60, 64], [50, 53, 57, 60], [52, 56, 59, 62]]  # Am7 Fmaj7 Dm7 E7
    logs = [(0.75, 45), (1.5, 45), (2.25, 48), (3.0, 43), (3.5, 45)]
    for bar in range(bars_for(b)):
        t0 = bar * 4 * b
        ch = prog[bar % 4]
        place(buf, rhodes([note(n) for n in ch], 2 * b), t0, 0.35)
        place(buf, rhodes([note(n) for n in ch], 1.5 * b), t0 + 2.5 * b, 0.25)
        for p, n in logs:
            place(buf, log_drum(note(n - 12 + (ch[0] - 57))), t0 + p * b, 0.6)
        for q in range(4):
            place(drums, kick(0.35, 100, 45, 0.3), t0 + q * b, 0.6)
            if q in (1, 3):
                place(drums, clap(), t0 + q * b, 0.3)
            for s in range(4):
                place(drums, shaker(), t0 + q * b + s * b / 4, 0.3 if s == 2 else 0.18, pan=0.3)
        place(drums, rim(), t0 + 1.75 * b, 0.4)
        place(drums, rim(), t0 + 3.25 * b, 0.4)
    return master(reverb(buf, 1.6, 0.25) + drums, 'amapiano-log', 'Amapiano Log', 'Log drums · groove', bpm, 'Trending reels')


# Funk Brazil — tamborzão kick pattern, distorted lead
def funk_brazil():
    bpm = 130
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    pat = [0, 0.75, 1.5, 2, 2.75, 3.5]
    lead = [(0, 76), (0.25, 76), (0.75, 74), (1, 72), (1.5, 74), (2, 76), (2.5, 79), (3, 76)]
    for bar in range(bars_for(b)):
        t0 = bar * 4 * b
        for p in pat:
            place(drums, kick(0.35, 170, 50, 1.4), t0 + p * b, 1.0)
        place(drums, snare(0.2, 240, 1.4), t0 + b, 0.5)
        place(drums, snare(0.2, 240, 1.4), t0 + 3 * b, 0.5)
        place(drums, clap(), t0 + 2.25 * b, 0.4)
        for e in range(8):
            place(drums, hat(0.03), t0 + e * b / 2 + b / 4, 0.22)
        place(buf, sub808(note(33 + (3 if bar % 4 == 2 else 0)), 3.8 * b, None, drive=3.0, decay=1.5), t0, 0.5)
        if bar >= 1:
            for off, n in lead:
                ln = 0.24 * b
                nn = int(ln * SR)
                tt = np.arange(nn) / SR
                fr = note(n) * (1 - 0.06 * np.exp(-tt * 30))
                x = np.sign(np.sin(2 * np.pi * np.cumsum(fr) / SR)) * 0.5
                place(buf, lp(x, 3000) * np.exp(-tt * 8), t0 + off * b, 0.15)
    x = buf + drums
    x = np.tanh(x * 1.5) / np.tanh(1.5)
    return master(reverb(x, 0.9, 0.12), 'funk-brazil', 'Funk Brazil', 'Montagem · hard bass', bpm, 'Trending reels')


# Jersey Club — bouncy kicks, squeaks, chopped chords
def jersey_club():
    bpm = 140
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    prog = [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 67]]
    kp = [0, 1, 2, 2.75, 3.5]
    for bar in range(bars_for(b)):
        t0 = bar * 4 * b
        ch = prog[bar % 4]
        for p in kp:
            place(drums, kick(0.3, 150, 50, 1.0), t0 + p * b, 0.85)
        place(drums, clap(), t0 + b, 0.5)
        place(drums, clap(), t0 + 3 * b, 0.5)
        for p in (0.5, 1.5, 2.5, 3.25):
            place(buf, chirp(), t0 + p * b, 0.25, pan=0.3)
        for s in (0, 0.75, 1.5, 2.5, 3):
            place(buf, supersaw([note(n) for n in ch], int(0.4 * b * SR), 3200, 0.004, 0.05), t0 + s * b, 0.3)
        place(buf, bass(note(ch[0] - 24), 4 * b * 0.9, 400), t0, 0.35)
        for e in range(8):
            place(drums, hat(0.03), t0 + e * b / 2 + b / 4, 0.2)
    return master(reverb(buf, 1.2, 0.2) + drums, 'jersey-club', 'Jersey Club', 'Bouncy kicks · squeaks', bpm, 'Trending reels')


# Afro Bounce — afrobeats groove, rims, guitar-like plucks
def afro_bounce():
    bpm = 104
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    prog = [[62, 66, 69], [59, 62, 66], [55, 59, 62], [57, 61, 64]]  # D Bm G A
    gtr = [0.5, 1.25, 1.75, 2.5, 3.25, 3.75]
    for bar in range(bars_for(b)):
        t0 = bar * 4 * b
        ch = prog[bar % 4]
        place(drums, kick(0.4, 110, 45, 0.6), t0, 0.85)
        place(drums, kick(0.4, 110, 45, 0.6), t0 + 1.5 * b, 0.6)
        place(drums, kick(0.4, 110, 45, 0.6), t0 + 2 * b, 0.75)
        place(drums, kick(0.4, 110, 45, 0.6), t0 + 3.5 * b, 0.5)
        for p in (0.75, 1.5, 2.5, 3.25):
            place(drums, rim(), t0 + p * b, 0.5)
        place(drums, clap(), t0 + 2 * b, 0.45)
        for s in range(16):
            place(drums, shaker(0.06), t0 + s * b / 4, 0.25 if s % 2 else 0.12, pan=-0.3)
        for i, p in enumerate(gtr):
            for k, n in enumerate(ch):
                place(buf, pluck(note(n + 12), 0.25, 3800, 14), t0 + p * b + k * 0.008, 0.08, pan=0.35)
        place(buf, bass(note(ch[0] - 24), b * 0.9, 380), t0, 0.45)
        place(buf, bass(note(ch[0] - 24 + 7), b * 0.5, 380), t0 + 1.5 * b, 0.35)
        place(buf, bass(note(ch[0] - 24 + 12), b * 0.9, 380), t0 + 2.5 * b, 0.3)
        place(buf, pad([note(n) for n in ch], int(4 * b * SR), 1500, 0.4), t0, 0.12)
    return master(reverb(buf, 1.4, 0.22) + drums, 'afro-bounce', 'Afro Bounce', 'Afrobeats · feel-good', bpm, 'Trending reels')


# Slowed + Reverb — sad piano, washed-out, vinyl
def slowed_reverb():
    bpm = 72
    b = grid(bpm)
    buf = np.zeros((2, N))
    drums = np.zeros((2, N))
    prog = [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 59], [55, 59, 62, 65]]  # Am7 Fmaj7 Cmaj7 G7
    mel = [76, 74, 72, 71, 72, 69, 67, 69]
    for bar in range(bars_for(b)):
        t0 = bar * 4 * b
        ch = prog[bar % 4]
        for i, n in enumerate(ch):
            place(buf, piano(note(n), 3.0, 0.7), t0 + i * 0.03, 0.22)
        place(buf, piano(note(mel[(bar * 2) % 8]), 1.8, 0.8), t0 + 1.5 * b, 0.25)
        place(buf, piano(note(mel[(bar * 2 + 1) % 8]), 1.8, 0.8), t0 + 2.5 * b, 0.22)
        place(buf, bass(note(ch[0] - 24), 4 * b * 0.9, 220), t0, 0.35)
        if bar >= 1:
            place(drums, kick(0.5, 90, 40, 0.3), t0, 0.7)
            place(drums, kick(0.5, 90, 40, 0.3), t0 + 2.5 * b, 0.5)
            place(drums, snare(0.4, 170, 0.6), t0 + 2 * b, 0.35)
            for q in range(4):
                place(drums, hat(0.05), t0 + q * b + b / 2, 0.15)
    # tape warble
    t = np.arange(N) / SR
    d = (0.0025 * (1 + np.sin(2 * np.pi * 0.4 * t)) * SR).astype(int)
    idx = np.clip(np.arange(N) - d, 0, N - 1)
    buf = buf[:, idx]
    crackle = np.zeros(N)
    k = rng.integers(0, N, 1200)
    crackle[k] = rng.standard_normal(1200) * 0.2
    buf += hp(crackle, 2000)
    x = reverb(buf + lp(drums, 5000), 4.0, 0.6, 3500)
    return master(lp(x, 7000), 'slowed-reverb', 'Slowed + Reverb', 'Sad · emotional edits', bpm, 'Trending reels')


TRACKS = [
    # News tones
    breaking_news, flash_news, top_headlines, countdown_clock, bulletin_intro, urgent_alert,
    prime_time, newsroom_ticker, election_night, live_update, market_watch, sports_desk, investigation, evening_bulletin,
    # Trending reels
    phonk_drift, drill_slide, trap_hype, edm_drop, bhangra_bounce, kuthu_remix, amapiano_log, funk_brazil, jersey_club, afro_bounce, slowed_reverb,
    # Background beds
    tamil_mass, breaking_pulse, headline_rise, morning_brief, lofi_desk, tech_wave, desi_beat,
]

if __name__ == '__main__':
    import sys
    import subprocess
    only = set(sys.argv[1:])  # e.g. `python3 scripts/compose-music.py phonk-drift edm-drop`
    path = os.path.join(OUT, 'catalog.json')
    try:
        old = {t['id']: t for t in json.load(open(path))}
    except Exception:
        old = {}
    for fn in TRACKS:
        tid = fn.__name__.replace('_', '-')
        if only and tid not in only:
            if tid in old:
                catalog.append(old[tid])
            continue
        info = fn()
        wav = os.path.join(OUT, f"{info['id']}.wav")
        try:  # encode to mp3 if ffmpeg is around
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-af', 'loudnorm=I=-15:TP=-1.5:LRA=11', '-ar', '44100', '-codec:a', 'libmp3lame', '-b:a', '128k', wav[:-4] + '.mp3'], check=True)
            os.remove(wav)
        except Exception:
            pass
        catalog.append(info)
        print('composed', info['title'])
    with open(path, 'w') as f:
        json.dump(catalog, f, indent=2)
