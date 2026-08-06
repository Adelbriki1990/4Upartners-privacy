using System.Collections.Generic;
using UnityEngine;

namespace StreetOps
{
    /// Spawns escalating waves of hostiles from the alleys and street ends.
    public class WaveManager : MonoBehaviour
    {
        readonly List<Vector3> _spawns = new List<Vector3>();
        float _intermission;

        void Start()
        {
            foreach (float az in CityGenerator.AlleyZ)
            {
                _spawns.Add(new Vector3(-CityGenerator.StreetHalf - 2f, 0.5f, az));
                _spawns.Add(new Vector3(CityGenerator.StreetHalf + 2f, 0.5f, az));
            }
            _spawns.Add(new Vector3(0f, 0.5f, -84f));
            _spawns.Add(new Vector3(4f, 0.5f, -84f));
            _spawns.Add(new Vector3(-4f, 0.5f, -84f));
            StartWave();
        }

        void Update()
        {
            var gm = GameManager.I;
            if (gm == null || gm.Player == null || gm.Player.Dead) return;
            if (EnemyAI.All.Count == 0)
            {
                _intermission += Time.deltaTime;
                if (_intermission > 4f) { _intermission = 0f; StartWave(); }
                else if (_intermission > 3.5f && HUDController.I != null) HUDController.I.ShowBanner("Get ready…");
            }
        }

        void StartWave()
        {
            var gm = GameManager.I;
            gm.Wave++;
            var weapon = gm.Player != null ? gm.Player.Gun : null;
            if (weapon != null) weapon.Reserve = Mathf.Max(weapon.Reserve, 120);

            int count = Mathf.Min(3 + gm.Wave * 2, 14);
            for (int i = 0; i < count; i++)
            {
                Vector3 s = _spawns[Random.Range(0, _spawns.Count)];
                EnemyAI.Spawn(s + new Vector3(Random.Range(-1f, 1f), 0, Random.Range(-1f, 1f)));
            }
            if (HUDController.I != null) HUDController.I.ShowBanner("WAVE " + gm.Wave);
        }
    }
}
