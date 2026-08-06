using UnityEngine;

namespace StreetOps
{
    /// Render-pipeline-agnostic material helpers (Built-in RP, URP, HDRP).
    public static class Materials
    {
        static Shader _lit;
        static Shader Lit
        {
            get
            {
                if (_lit == null)
                    _lit = Shader.Find("Universal Render Pipeline/Lit")
                        ?? Shader.Find("HDRP/Lit")
                        ?? Shader.Find("Standard");
                return _lit;
            }
        }

        public static Material Solid(Color c, float smoothness = 0.25f, float metallic = 0f)
        {
            var m = new Material(Lit) { color = c };
            if (m.HasProperty("_Smoothness")) m.SetFloat("_Smoothness", smoothness);
            if (m.HasProperty("_Glossiness")) m.SetFloat("_Glossiness", smoothness);
            if (m.HasProperty("_Metallic")) m.SetFloat("_Metallic", metallic);
            return m;
        }

        public static Material Emissive(Color glow, float intensity = 1f, Color? baseColor = null)
        {
            var m = Solid(baseColor ?? Color.black);
            m.EnableKeyword("_EMISSION");
            if (m.HasProperty("_EmissionColor")) m.SetColor("_EmissionColor", glow * intensity);
            if (m.HasProperty("_EmissiveColor")) m.SetColor("_EmissiveColor", glow * intensity);
            return m;
        }

        /// Building facade with a procedurally generated lit-window emission map.
        public static Material Facade(float hue)
        {
            var tex = WindowTexture(hue);
            var m = Solid(new Color(0.33f, 0.38f, 0.44f), 0.2f);
            m.EnableKeyword("_EMISSION");
            if (m.HasProperty("_EmissionMap")) m.SetTexture("_EmissionMap", tex);
            if (m.HasProperty("_EmissionColor")) m.SetColor("_EmissionColor", Color.white * 0.9f);
            m.mainTexture = tex;
            return m;
        }

        static Texture2D WindowTexture(float hue)
        {
            const int S = 128;
            var tex = new Texture2D(S, S, TextureFormat.RGB24, true);
            var dark = new Color(0.03f, 0.04f, 0.06f);
            var px = new Color[S * S];
            for (int i = 0; i < px.Length; i++) px[i] = Color.black;
            for (int wy = 6; wy < S - 12; wy += 22)
                for (int wx = 6; wx < S - 12; wx += 20)
                {
                    bool lit = Random.value < 0.45f;
                    Color c = lit
                        ? Color.HSVToRGB(hue, 0.45f, 0.75f + Random.value * 0.25f)
                        : dark;
                    for (int y = 0; y < 14; y++)
                        for (int x = 0; x < 11; x++)
                            px[(wy + y) * S + wx + x] = c;
                }
            tex.SetPixels(px);
            tex.Apply();
            return tex;
        }

        /// Canvas-style billboard texture with sponsor name + tagline.
        public static Material Billboard(SponsorConfig.Entry sponsor)
        {
            var m = Emissive(Color.white, 1.1f, Color.black);
            var tex = BillboardTexture(sponsor);
            m.mainTexture = tex;
            if (m.HasProperty("_EmissionMap")) m.SetTexture("_EmissionMap", tex);
            return m;
        }

        static Texture2D BillboardTexture(SponsorConfig.Entry s)
        {
            // Text rendering without fonts: block-pattern background + TextMesh
            // handles actual lettering (see CityGenerator.AddBillboard); the
            // texture just provides the branded backdrop.
            const int W = 256, H = 128;
            var tex = new Texture2D(W, H, TextureFormat.RGB24, false);
            var px = new Color[W * H];
            for (int y = 0; y < H; y++)
                for (int x = 0; x < W; x++)
                {
                    float t = y / (float)H;
                    px[y * W + x] = Color.Lerp(s.ColorA, s.ColorB, t);
                }
            // border
            for (int x = 0; x < W; x++) { px[x] = px[(H - 1) * W + x] = Color.white; px[W + x] = px[(H - 2) * W + x] = Color.white; }
            for (int y = 0; y < H; y++) { px[y * W] = px[y * W + W - 1] = Color.white; px[y * W + 1] = px[y * W + W - 2] = Color.white; }
            tex.SetPixels(px);
            tex.Apply();
            return tex;
        }
    }
}
