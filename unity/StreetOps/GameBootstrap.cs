using UnityEngine;

namespace StreetOps
{
    /// Zero-setup entry point: drop the StreetOps folder into Assets,
    /// open any (preferably empty) scene and press Play — the whole game
    /// builds itself procedurally. No prefabs, scenes or assets required.
    public static class GameBootstrap
    {
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Init()
        {
            if (Object.FindObjectOfType<GameManager>() == null)
                new GameObject("StreetOps").AddComponent<GameManager>();
        }
    }

    public class GameManager : MonoBehaviour
    {
        public static GameManager I { get; private set; }

        public int Wave;
        public int Kills;
        public PlayerController Player;
        public WaveManager Waves;

        GameObject _worldRoot;

        void Awake()
        {
            I = this;
            gameObject.AddComponent<HUDController>();
            gameObject.AddComponent<FXRunner>();
            BuildAll();
        }

        void BuildAll()
        {
            Wave = 0;
            Kills = 0;

            // politely mute whatever camera/listener the scene already has
            foreach (var cam in Object.FindObjectsOfType<Camera>()) cam.enabled = false;
            foreach (var lis in Object.FindObjectsOfType<AudioListener>()) lis.enabled = false;

            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.ExponentialSquared;
            RenderSettings.fogDensity = 0.0085f;
            RenderSettings.fogColor = new Color(0.05f, 0.08f, 0.13f);
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
            RenderSettings.ambientLight = new Color(0.22f, 0.27f, 0.36f);

            _worldRoot = CityGenerator.Build();

            var moon = new GameObject("Moonlight").AddComponent<Light>();
            moon.type = LightType.Directional;
            moon.color = new Color(0.62f, 0.72f, 1f);
            moon.intensity = 0.9f;
            moon.shadows = LightShadows.Soft;
            moon.transform.rotation = Quaternion.Euler(52f, 140f, 0f);
            moon.transform.SetParent(_worldRoot.transform);

            Player = PlayerController.Spawn(new Vector3(0f, 0.5f, 72f));
            Waves = gameObject.AddComponent<WaveManager>();
        }

        public void Restart()
        {
            foreach (var e in Object.FindObjectsOfType<EnemyAI>()) Destroy(e.gameObject);
            if (Player != null) Destroy(Player.gameObject);
            if (Waves != null) Destroy(Waves);
            if (_worldRoot != null) Destroy(_worldRoot);
            BuildAll();
        }
    }

    /// Persistent coroutine host for short-lived effects (tracers, impacts),
    /// so effects keep animating even if their spawner dies.
    public class FXRunner : MonoBehaviour
    {
        public static FXRunner I { get; private set; }
        void Awake() { I = this; }
    }
}
