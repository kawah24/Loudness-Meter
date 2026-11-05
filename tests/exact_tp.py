"""Exact band-limited true peak via 4x FFT zero-padding — ground truth for TP checks."""
import numpy as np, wave, sys, json, os

def read_wav(path):
    with wave.open(path, 'rb') as w:
        ch, sw, fs, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    assert sw == 2
    d = np.frombuffer(raw, dtype='<i2').astype(np.float64) / 32768.0
    return d.reshape(-1, ch), fs

def true_peak(path, factor=8):
    data, fs = read_wav(path)
    out = []
    for c in range(data.shape[1]):
        x = data[:, c]
        # pad to avoid circular wrap artefacts, then FFT interpolate by `factor`
        xp = np.concatenate([np.zeros(4096), x, np.zeros(4096)])
        N = len(xp)
        X = np.fft.rfft(xp)
        Y = np.zeros(N * factor // 2 + 1, dtype=complex)
        Y[:len(X)] = X
        y = np.fft.irfft(Y, n=N * factor) * factor
        m = int(0.2 * fs * factor)          # ignore edge ringing
        out.append(np.max(np.abs(y[m:len(y) - m])))
    peak = max(out)
    return 20 * np.log10(peak) if peak > 0 else -np.inf

if __name__ == '__main__':
    d = os.path.join(os.path.dirname(__file__), 'signals')
    res = {}
    for f in sorted(os.listdir(d)):
        if not f.endswith('.wav'):
            continue
        tp = true_peak(os.path.join(d, f))
        res[f] = round(tp, 3)
        print(f'{f:24s} exact TP {tp:7.3f} dBTP')
    with open(os.path.join(os.path.dirname(__file__), 'exact_tp.json'), 'w') as fh:
        json.dump(res, fh, indent=1)
