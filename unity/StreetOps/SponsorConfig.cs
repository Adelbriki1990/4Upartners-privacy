using UnityEngine;

namespace StreetOps
{
    /// Sponsor / advertising configuration.
    /// Edit this list to change the billboards shown around the city —
    /// each entry becomes glowing ad panels on towers and street level.
    /// To use a real logo, drop a PNG into a Resources folder and set
    /// LogoResource to its name (without extension).
    public static class SponsorConfig
    {
        [System.Serializable]
        public class Entry
        {
            public string Name;
            public string Tagline;
            public Color ColorA;
            public Color ColorB;
            public string LogoResource; // optional: texture in a Resources folder

            public Entry(string name, string tagline, Color a, Color b, string logo = null)
            { Name = name; Tagline = tagline; ColorA = a; ColorB = b; LogoResource = logo; }
        }

        public static readonly Entry[] Sponsors =
        {
            new Entry("4U PARTNERS", "Your city. Your game.",
                new Color(0.05f, 0.25f, 0.55f), new Color(0.02f, 0.08f, 0.2f)),
            new Entry("VOLT ENERGY", "Charge the night",
                new Color(0.7f, 0.45f, 0.02f), new Color(0.3f, 0.1f, 0.02f)),
            new Entry("NOVA TELECOM", "Always connected",
                new Color(0.4f, 0.05f, 0.45f), new Color(0.1f, 0.02f, 0.2f)),
            new Entry("APEX MOTORS", "Drive the future",
                new Color(0.05f, 0.4f, 0.3f), new Color(0.02f, 0.12f, 0.1f)),
        };

        public static Entry Random() => Sponsors[UnityEngine.Random.Range(0, Sponsors.Length)];
    }
}
