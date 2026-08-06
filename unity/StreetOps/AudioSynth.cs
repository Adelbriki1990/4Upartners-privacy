using System.Collections.Generic;
using UnityEngine;

namespace StreetOps
{
    /// Procedural sound effects — clips are synthesized in code at first use,
    /// so the game needs no audio assets.
    public static class AudioSynth
    {
        const int SampleRate = 44100;
        static readonly Dictionary<string, AudioClip> _cache = new Dictionary<string, AudioClip>();

        static AudioClip Make(string key, float dur, System.Func<float, float> wave)
        {
            if (_cache.TryGetValue(key, out var cached)) return cached;
            int n = (int)(SampleRate * dur);
            var data = new float[n];
            for (int i = 0; i < n; i++)
                data[i] = Mathf.Clamp(wave(i / (float)SampleRate), -1f, 1f);
            var clip = AudioClip.Create(key, n, 1, SampleRate, false);
            clip.SetData(data, 0);
            _cache[key] = clip;
            return clip;
        }

        public static void PlayShot(Vector3 pos, float volume, float freq)
        {
            var rng = new System.Random(42);
            var clip = Make("shot" + freq, 0.16f, t =>
            {
                float env = Mathf.Exp(-t * 30f);
                float noise = (float)(rng.NextDouble() * 2.0 - 1.0) * env;
                float sweep = freq * Mathf.Exp(-t * 12f) + 60f;
                float thump = Mathf.Sin(2f * Mathf.PI * sweep * t) * env * 0.8f;
                return noise * 0.7f + thump;
            });
            AudioSource.PlayClipAtPoint(clip, pos, volume);
        }

        public static void PlayClick(Vector3 pos, float pitch)
        {
            var clip = Make("click" + pitch, 0.06f, t =>
                Mathf.Sign(Mathf.Sin(2f * Mathf.PI * pitch * t)) * Mathf.Exp(-t * 60f) * 0.4f);
            AudioSource.PlayClipAtPoint(clip, pos, 0.5f);
        }

        public static void PlayHurt(Vector3 pos)
        {
            var clip = Make("hurt", 0.2f, t =>
            {
                float f = Mathf.Lerp(220f, 70f, t / 0.2f);
                return Mathf.Sin(2f * Mathf.PI * f * t) * Mathf.Exp(-t * 12f) * 0.6f;
            });
            AudioSource.PlayClipAtPoint(clip, pos, 0.6f);
        }
    }
}
