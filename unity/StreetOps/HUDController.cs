using UnityEngine;

namespace StreetOps
{
    /// Immediate-mode HUD: crosshair, health, ammo, wave info, hitmarker,
    /// damage vignette, wave banner and the game-over screen.
    public class HUDController : MonoBehaviour
    {
        public static HUDController I { get; private set; }

        float _hitmarkerT;
        bool _hitmarkerKill;
        float _bannerT;
        string _bannerText = "";

        GUIStyle _big, _label, _banner, _small;
        Texture2D _white;

        void Awake()
        {
            I = this;
            _white = Texture2D.whiteTexture;
        }

        public void ShowHitmarker(bool kill)
        {
            _hitmarkerT = 0.18f;
            _hitmarkerKill = kill;
            AudioSynth.PlayClick(Camera.main != null ? Camera.main.transform.position : Vector3.zero, kill ? 500f : 1800f);
        }

        public void ShowBanner(string text)
        {
            if (_bannerText == text && _bannerT > 0f) return;
            _bannerText = text;
            _bannerT = 2.2f;
        }

        void Update()
        {
            if (_hitmarkerT > 0f) _hitmarkerT -= Time.deltaTime;
            if (_bannerT > 0f) _bannerT -= Time.deltaTime;
        }

        void EnsureStyles()
        {
            if (_big != null) return;
            _big = new GUIStyle(GUI.skin.label) { fontSize = 42, fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleRight };
            _big.normal.textColor = Color.white;
            _label = new GUIStyle(GUI.skin.label) { fontSize = 16, alignment = TextAnchor.MiddleCenter };
            _label.normal.textColor = new Color(0.87f, 0.91f, 0.95f);
            _banner = new GUIStyle(GUI.skin.label) { fontSize = 44, fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleCenter };
            _banner.normal.textColor = Color.white;
            _small = new GUIStyle(GUI.skin.label) { fontSize = 13, alignment = TextAnchor.MiddleLeft };
            _small.normal.textColor = new Color(0.62f, 0.7f, 0.77f);
        }

        void Rect(float x, float y, float w, float h, Color c)
        {
            GUI.color = c;
            GUI.DrawTexture(new Rect(x, y, w, h), _white);
        }

        void OnGUI()
        {
            var gm = GameManager.I;
            if (gm == null || gm.Player == null) return;
            EnsureStyles();
            var player = gm.Player;
            float W = Screen.width, H = Screen.height;

            if (player.Dead)
            {
                Rect(0, 0, W, H, new Color(0.03f, 0.02f, 0.02f, 0.88f));
                GUI.color = new Color(1f, 0.37f, 0.37f);
                GUI.Label(new Rect(0, H * 0.3f, W, 60), "MISSION FAILED", _banner);
                GUI.color = Color.white;
                GUI.Label(new Rect(0, H * 0.3f + 70, W, 30), "Waves survived: " + gm.Wave + "    Eliminations: " + gm.Kills, _label);
                if (GUI.Button(new Rect(W / 2 - 90, H * 0.3f + 120, 180, 44), "REDEPLOY"))
                    gm.Restart();
                return;
            }

            // damage vignette (flat red tint scaled by missing health + fresh hits)
            float hurt = Mathf.Clamp01((100f - player.Health) / 140f
                       + (Time.time - player.LastHurtTime < 0.4f ? 0.25f : 0f));
            if (hurt > 0.01f) Rect(0, 0, W, H, new Color(0.7f, 0f, 0f, hurt * 0.35f));

            // crosshair
            float cx = W / 2f, cy = H / 2f;
            Color ch = new Color(1f, 1f, 1f, 0.92f);
            Rect(cx - 1, cy - 12, 2, 7, ch);
            Rect(cx - 1, cy + 5, 2, 7, ch);
            Rect(cx - 12, cy - 1, 7, 2, ch);
            Rect(cx + 5, cy - 1, 7, 2, ch);

            // hitmarker (X shape)
            if (_hitmarkerT > 0f)
            {
                Color hm = _hitmarkerKill ? new Color(1f, 0.3f, 0.3f) : Color.white;
                var prev = GUI.matrix;
                GUIUtility.RotateAroundPivot(45f, new Vector2(cx, cy));
                Rect(cx - 1, cy - 16, 2, 10, hm);
                Rect(cx - 1, cy + 6, 2, 10, hm);
                Rect(cx - 16, cy - 1, 10, 2, hm);
                Rect(cx + 6, cy - 1, 10, 2, hm);
                GUI.matrix = prev;
            }

            // top bar
            GUI.color = Color.white;
            GUI.Label(new Rect(0, 18, W, 24),
                "WAVE " + gm.Wave + "      HOSTILES " + EnemyAI.AliveCount + "      ELIMINATIONS " + gm.Kills, _label);

            // wave banner
            if (_bannerT > 0f)
            {
                GUI.color = new Color(1f, 1f, 1f, Mathf.Min(1f, _bannerT));
                GUI.Label(new Rect(0, H * 0.32f, W, 60), _bannerText, _banner);
                GUI.color = Color.white;
            }

            // health bar
            GUI.Label(new Rect(34, H - 76, 240, 18), "ARMOR / HEALTH", _small);
            Rect(34, H - 52, 242, 14, new Color(0f, 0f, 0f, 0.55f));
            Color hc = player.Health > 50f ? new Color(0.24f, 0.86f, 0.48f) : new Color(0.88f, 0.4f, 0.28f);
            Rect(35, H - 51, 240f * player.Health / 100f, 12, hc);

            // ammo
            var gun = player.Gun;
            if (gun != null)
            {
                GUI.color = new Color(0.5f, 0.82f, 1f);
                GUI.Label(new Rect(W - 320, H - 104, 280, 20), "MK-4 ASSAULT RIFLE",
                    new GUIStyle(_small) { alignment = TextAnchor.MiddleRight });
                GUI.color = Color.white;
                GUI.Label(new Rect(W - 320, H - 84, 280, 50), gun.Mag + " / " + gun.Reserve, _big);
                if (gun.Reloading)
                    GUI.Label(new Rect(0, cy + 60, W, 24), "RELOADING…", _label);
            }
            GUI.color = Color.white;
        }
    }
}
