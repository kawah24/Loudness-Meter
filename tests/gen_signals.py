"""Generate reference test signals (16-bit PCM WAV) for the loudness meter checks."""
import numpy as np
import wave, os, sys

FS = 48000
OUT = os.path.join(os.path.dirname(__file__), "signals")
os.makedirs(OUT, exist_ok=True)


def write_wav(name, data, fs=FS):
    """data: float array (frames, channels) in [-1, 1]"""
    data = np.asarray(data, dtype=np.float64)
    if data.ndim == 1:
        data = data[:, None]
    peak = np.max(np.abs(data)) if data.size else 0.0
    if peak > 1.0:
        raise SystemExit(f"{name}: would clip ({peak:.3f})")
    pcm = np.clip(np.round(data * 32767.0), -32768, 32767).astype("<i2")
    path = os.path.join(OUT, name)
    with wave.open(path, "wb") as w:
        w.setnchannels(data.shape[1])
        w.setsampwidth(2)
        w.setframerate(fs)
        w.writeframes(pcm.tobytes())
    print(f"{path}  {data.shape[1]}ch {len(data)/fs:.1f}s peak={20*np.log10(max(peak,1e-12)):.2f}dBFS")


def sine(freq, amp, seconds, fs=FS, phase=0.0):
    t = np.arange(int(round(seconds * fs))) / fs
    return amp * np.sin(2 * np.pi * freq * t + phase)


def db(x):
    return 10 ** (x / 20.0)


def pink(n, seed=1):
    rng = np.random.default_rng(seed)
    white = rng.standard_normal(n)
    # simple -3 dB/oct filter
    b = [0.049922035, -0.095993537, 0.050612699, -0.004408786]
    a = [1, -2.494956002, 2.017265875, -0.522189400]
    from scipy.signal import lfilter  # noqa
    return lfilter(b, a, white)


# 1. Steady 1 kHz tone, -20 dBFS per channel
write_wav("sine_1k_m20.wav", np.stack([sine(1000, db(-20), 30)] * 2, axis=1))

# 2. Steady 1 kHz tone, -30 dBFS per channel (below/above gates)
write_wav("sine_1k_m30.wav", np.stack([sine(1000, db(-30), 30)] * 2, axis=1))

# 3. EBU Tech 3342 style LRA case: 20 s @ -20 dBFS, 20 s @ -30 dBFS  -> LRA ~ 10 LU
seg1 = np.stack([sine(1000, db(-20), 20)] * 2, axis=1)
seg2 = np.stack([sine(1000, db(-30), 20)] * 2, axis=1)
write_wav("lra_step_10lu.wav", np.concatenate([seg1, seg2], axis=0))

# 4. Program-like: quiet / medium / loud sections
rng = np.random.default_rng(7)
def coloured(seconds, amp, seed):
    rng = np.random.default_rng(seed)
    n = int(seconds * FS)
    t = np.arange(n) / FS
    noise = rng.standard_normal(n) * 0.25
    tone = (np.sin(2 * np.pi * 110 * t) * 0.5 + np.sin(2 * np.pi * 220 * t) * 0.3
            + np.sin(2 * np.pi * 330 * t) * 0.2)
    env = 0.6 + 0.4 * np.sin(2 * np.pi * 0.5 * t)
    sig = (tone + noise) * env
    sig = sig / np.max(np.abs(sig)) * amp
    return sig

quiet = coloured(8, db(-28), 3)
mid = coloured(8, db(-18), 4)
loud = coloured(8, db(-11), 5)
prog = np.concatenate([quiet, mid, loud, mid, quiet], axis=0)
write_wav("program.wav", np.stack([prog, prog * 0.95], axis=1))

# 5. True-peak stress: 11.9 kHz tone near Nyquist-ish, amplitude 0.9
tp = sine(11900, 0.9, 10, phase=0.37)
write_wav("tp_11k9.wav", np.stack([tp, np.zeros_like(tp)], axis=1))

# 6. Short transient program for PLR
n = int(12 * FS)
t = np.arange(n) / FS
pcm = np.zeros(n)
for k, start in enumerate([0.5, 2.0, 4.2, 6.1, 8.4, 10.0]):
    i0 = int(start * FS)
    ln = int(0.004 * FS)
    env = np.exp(-np.linspace(0, 8, ln))
    pcm[i0:i0 + ln] += env * 0.95
pcm += 0.05 * rng.standard_normal(n)
pcm = np.clip(pcm, -1, 1)
write_wav("transients.wav", np.stack([pcm, pcm * 0.8], axis=1))
print("done")
