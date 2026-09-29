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


def master(buf, name, title, mood, bpm):
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
    return {'id': name, 'title': title, 'mood': mood, 'bpm': bpm, 'file': f'/music/{name}.mp3', 'duration': LEN}


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


for fn in (breaking_pulse, headline_rise, morning_brief, lofi_desk, tech_wave, desi_beat):
    info = fn()
    catalog.append(info)
    print('composed', info['title'])

with open(os.path.join(OUT, 'catalog.json'), 'w') as f:
    json.dump(catalog, f, indent=2)
