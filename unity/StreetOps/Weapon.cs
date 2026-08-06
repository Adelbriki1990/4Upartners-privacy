using System.Collections;
using System.Linq;
using UnityEngine;

namespace StreetOps
{
    /// Hitscan assault rifle: full-auto fire, reload, aim-down-sights,
    /// recoil, tracers, muzzle flash. View model is built from primitives.
    public class Weapon : MonoBehaviour
    {
        public const float BaseFov = 75f, AdsFov = 52f;

        public int Mag = 30, MagSize = 30, Reserve = 120;
        public bool Aiming { get; private set; }
        public bool Reloading => _reloadT > 0f;
        public float RecoilKick { get; private set; }

        const float FireInterval = 0.1f; // 600 rpm
        const float Damage = 30f;

        static readonly Vector3 HipPos = new Vector3(0.24f, -0.2f, 0.48f);
        static readonly Vector3 AdsPos = new Vector3(0f, -0.115f, 0.34f);

        PlayerController _player;
        Camera _cam;
        Transform _gun;
        Light _muzzleLight;
        float _cooldown, _reloadT, _bobPhase;

        void Start()
        {
            _cam = GetComponent<Camera>();
            _player = GetComponentInParent<PlayerController>();
            BuildViewModel();
        }

        void BuildViewModel()
        {
            _gun = new GameObject("GunViewModel").transform;
            _gun.SetParent(transform, false);
            _gun.localPosition = HipPos;

            var mGun = Materials.Solid(new Color(0.14f, 0.15f, 0.17f), 0.55f, 0.7f);
            var mGrip = Materials.Solid(new Color(0.2f, 0.16f, 0.11f), 0.2f);

            void Part(PrimitiveType type, Vector3 pos, Vector3 scale, Material m, Vector3? euler = null)
            {
                var p = GameObject.CreatePrimitive(type);
                p.transform.SetParent(_gun, false);
                p.transform.localPosition = pos;
                p.transform.localScale = scale;
                if (euler.HasValue) p.transform.localRotation = Quaternion.Euler(euler.Value);
                p.GetComponent<Renderer>().material = m;
                Object.Destroy(p.GetComponent<Collider>());
            }

            Part(PrimitiveType.Cube, Vector3.zero, new Vector3(0.062f, 0.085f, 0.42f), mGun);
            Part(PrimitiveType.Cylinder, new Vector3(0, 0.012f, 0.33f), new Vector3(0.032f, 0.15f, 0.032f), mGun, new Vector3(90, 0, 0));
            Part(PrimitiveType.Cube, new Vector3(0, -0.1f, -0.02f), new Vector3(0.05f, 0.14f, 0.075f), mGrip, new Vector3(-10, 0, 0));
            Part(PrimitiveType.Cube, new Vector3(0, -0.012f, -0.27f), new Vector3(0.05f, 0.075f, 0.17f), mGrip);
            Part(PrimitiveType.Cube, new Vector3(0, 0.06f, 0.05f), new Vector3(0.02f, 0.035f, 0.06f), mGun);

            _muzzleLight = new GameObject("MuzzleFlash").AddComponent<Light>();
            _muzzleLight.transform.SetParent(_gun, false);
            _muzzleLight.transform.localPosition = new Vector3(0, 0.01f, 0.55f);
            _muzzleLight.type = LightType.Point;
            _muzzleLight.range = 7f;
            _muzzleLight.color = new Color(1f, 0.72f, 0.4f);
            _muzzleLight.intensity = 0f;
        }

        void Update()
        {
            if (_player.Dead || Cursor.lockState != CursorLockMode.Locked) { Aiming = false; return; }

            Aiming = Input.GetMouseButton(1);
            _cooldown -= Time.deltaTime;
            RecoilKick = Mathf.Max(0f, RecoilKick - Time.deltaTime * 26f);
            _muzzleLight.intensity = Mathf.Max(0f, _muzzleLight.intensity - Time.deltaTime * 160f);

            if (Input.GetKeyDown(KeyCode.R)) StartReload();

            if (_reloadT > 0f)
            {
                _reloadT -= Time.deltaTime;
                if (_reloadT <= 0f)
                {
                    int take = Mathf.Min(MagSize - Mag, Reserve);
                    Mag += take;
                    Reserve -= take;
                    AudioSynth.PlayClick(transform.position, 1600f);
                }
            }
            else if (Input.GetMouseButton(0) && _cooldown <= 0f)
            {
                if (Mag > 0) Fire();
                else { AudioSynth.PlayClick(transform.position, 2100f); _cooldown = 0.25f; StartReload(); }
            }

            // ADS interpolation + bob
            var cc = _player.GetComponent<CharacterController>();
            float planar = new Vector2(cc.velocity.x, cc.velocity.z).magnitude;
            if (planar > 0.5f && cc.isGrounded) _bobPhase += Time.deltaTime * planar * 1.6f;
            float bob = Mathf.Sin(_bobPhase) * 0.012f * Mathf.Min(planar / 5f, 1f) * (Aiming ? 0.3f : 1f);

            Vector3 target = (Aiming ? AdsPos : HipPos) + new Vector3(0, bob, -RecoilKick * 0.004f);
            _gun.localPosition = Vector3.Lerp(_gun.localPosition, target, Time.deltaTime * 12f);
            _gun.localRotation = Quaternion.Euler(-RecoilKick * 0.8f, 0, 0);
            _cam.fieldOfView = Mathf.Lerp(_cam.fieldOfView, Aiming ? AdsFov : BaseFov, Time.deltaTime * 14f);
        }

        void StartReload()
        {
            if (_reloadT > 0f || Mag == MagSize || Reserve <= 0) return;
            _reloadT = 1.9f;
            AudioSynth.PlayClick(transform.position, 900f);
        }

        void Fire()
        {
            Mag--;
            _cooldown = FireInterval;
            RecoilKick = Mathf.Min(RecoilKick + 1.4f, 6f);
            _muzzleLight.intensity = 8f;
            AudioSynth.PlayShot(transform.position, 0.5f, 950f);

            float spread = Aiming ? 0.15f : 0.9f;
            Vector3 dir = Quaternion.Euler(Random.Range(-spread, spread), Random.Range(-spread, spread), 0)
                          * _cam.transform.forward;

            Vector3 origin = _cam.transform.position;
            Vector3 end = origin + dir * 200f;
            EnemyAI hitEnemy = null;
            bool headshot = false;

            var hits = Physics.RaycastAll(origin, dir, 200f, ~0, QueryTriggerInteraction.Collide)
                              .OrderBy(h => h.distance);
            foreach (var h in hits)
            {
                if (h.collider.GetComponentInParent<PlayerController>() != null) continue;
                end = h.point;
                var enemy = h.collider.GetComponentInParent<EnemyAI>();
                if (enemy != null && !enemy.Dead)
                {
                    hitEnemy = enemy;
                    headshot = h.collider.name == "Head";
                }
                break;
            }

            FX.Tracer(_muzzleLight.transform.position, end, new Color(1f, 0.9f, 0.66f));
            FX.Impact(end);

            if (hitEnemy != null)
            {
                hitEnemy.TakeDamage(headshot ? Damage * 2f : Damage);
                HUDController.I.ShowHitmarker(hitEnemy.Dead);
            }
        }
    }

    /// Short-lived visual effects, hosted on the persistent FXRunner.
    public static class FX
    {
        static Material _lineMat;
        static Material LineMat => _lineMat != null ? _lineMat : _lineMat = new Material(Shader.Find("Sprites/Default"));

        public static void Tracer(Vector3 from, Vector3 to, Color color)
        {
            var go = new GameObject("Tracer");
            var lr = go.AddComponent<LineRenderer>();
            lr.material = LineMat;
            lr.positionCount = 2;
            lr.SetPosition(0, from);
            lr.SetPosition(1, to);
            lr.startWidth = lr.endWidth = 0.02f;
            lr.startColor = lr.endColor = color;
            Object.Destroy(go, 0.06f);
        }

        public static void Impact(Vector3 at)
        {
            var s = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            Object.Destroy(s.GetComponent<Collider>());
            s.transform.position = at;
            s.transform.localScale = Vector3.one * 0.1f;
            s.GetComponent<Renderer>().material = Materials.Emissive(new Color(1f, 0.8f, 0.5f), 2.5f);
            if (FXRunner.I != null) FXRunner.I.StartCoroutine(Grow(s));
            else Object.Destroy(s, 0.12f);
        }

        static IEnumerator Grow(GameObject s)
        {
            float t = 0f;
            while (t < 0.12f && s != null)
            {
                t += Time.deltaTime;
                s.transform.localScale = Vector3.one * (0.1f + t * 1.5f);
                yield return null;
            }
            if (s != null) Object.Destroy(s);
        }
    }
}
