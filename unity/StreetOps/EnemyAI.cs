using System.Collections.Generic;
using UnityEngine;

namespace StreetOps
{
    /// Hostile soldier: chases the player, strafes in close range and fires
    /// with distance-based accuracy when it has line of sight.
    /// Rig is built from primitives; movement uses a CharacterController.
    public class EnemyAI : MonoBehaviour
    {
        public static readonly List<EnemyAI> All = new List<EnemyAI>();
        public static int AliveCount
        {
            get { int n = 0; foreach (var e in All) if (!e.Dead) n++; return n; }
        }

        public float Health = 100f;
        public bool Dead { get; private set; }

        CharacterController _cc;
        Transform _legL, _legR, _armL, _armR;
        float _fireCooldown, _strafeT, _walkPhase, _speed;
        int _strafeDir;

        public static EnemyAI Spawn(Vector3 pos)
        {
            var go = new GameObject("Enemy");
            go.layer = 2; // Ignore Raycast: LOS checks skip actors
            go.transform.position = pos;
            var cc = go.AddComponent<CharacterController>();
            cc.height = 1.8f;
            cc.radius = 0.35f;
            cc.center = new Vector3(0, 0.9f, 0);
            return go.AddComponent<EnemyAI>();
        }

        void Awake() { All.Add(this); }
        void OnDestroy() { All.Remove(this); }

        void Start()
        {
            _cc = GetComponent<CharacterController>();
            _fireCooldown = 1f + Random.value * 1.5f;
            _strafeDir = Random.value < 0.5f ? 1 : -1;
            _strafeT = 1f + Random.value * 2f;
            _speed = 3f + Random.value * 1.2f;
            BuildRig();
        }

        void BuildRig()
        {
            var mUniform = Materials.Solid(new Color(0.26f, 0.29f, 0.23f), 0.1f);
            var mVest = Materials.Solid(new Color(0.17f, 0.18f, 0.16f), 0.1f);
            var mSkin = Materials.Solid(new Color(0.69f, 0.54f, 0.4f), 0.15f);
            var mRifle = Materials.Solid(new Color(0.1f, 0.11f, 0.13f), 0.5f, 0.6f);

            Transform Part(string name, Vector3 pos, Vector3 scale, Material m, bool hitbox = false)
            {
                var p = GameObject.CreatePrimitive(PrimitiveType.Cube);
                p.name = name;
                p.layer = 2;
                p.transform.SetParent(transform, false);
                p.transform.localPosition = pos;
                p.transform.localScale = scale;
                p.GetComponent<Renderer>().material = m;
                var col = p.GetComponent<BoxCollider>();
                if (hitbox) col.isTrigger = true; // raycastable, doesn't block movement
                else Object.Destroy(col);
                return p.transform;
            }

            Part("Torso", new Vector3(0, 1.12f, 0), new Vector3(0.52f, 0.62f, 0.3f), mVest);
            Part("Hips", new Vector3(0, 0.72f, 0), new Vector3(0.44f, 0.24f, 0.27f), mUniform);
            Part("Head", new Vector3(0, 1.62f, 0), new Vector3(0.26f, 0.28f, 0.26f), mSkin, hitbox: true);
            Part("Helmet", new Vector3(0, 1.76f, 0), new Vector3(0.3f, 0.14f, 0.3f), mUniform);
            _legL = Part("LegL", new Vector3(-0.13f, 0.3f, 0), new Vector3(0.17f, 0.6f, 0.2f), mUniform);
            _legR = Part("LegR", new Vector3(0.13f, 0.3f, 0), new Vector3(0.17f, 0.6f, 0.2f), mUniform);
            _armL = Part("ArmL", new Vector3(-0.34f, 1.15f, 0), new Vector3(0.13f, 0.5f, 0.16f), mUniform);
            _armR = Part("ArmR", new Vector3(0.34f, 1.15f, 0), new Vector3(0.13f, 0.5f, 0.16f), mUniform);
            Part("Rifle", new Vector3(0.2f, 1.2f, 0.3f), new Vector3(0.07f, 0.09f, 0.62f), mRifle);
        }

        void Update()
        {
            var player = GameManager.I != null ? GameManager.I.Player : null;
            if (player == null) return;

            if (Dead)
            {
                // topple, sink, despawn
                transform.rotation = Quaternion.RotateTowards(transform.rotation,
                    Quaternion.Euler(-90f, transform.eulerAngles.y, 0), Time.deltaTime * 220f);
                return;
            }

            Vector3 toPlayer = player.transform.position - transform.position;
            toPlayer.y = 0;
            float dist = toPlayer.magnitude;
            Vector3 dir = toPlayer.normalized;

            transform.rotation = Quaternion.Euler(0, Quaternion.LookRotation(dir).eulerAngles.y, 0);

            Vector3 eye = transform.position + Vector3.up * 1.55f;
            Vector3 playerEye = player.transform.position + Vector3.up * PlayerController.Eye;
            // actors are on Ignore Raycast, so this only tests world geometry
            bool los = dist < 70f && !Physics.Linecast(eye, playerEye, Physics.DefaultRaycastLayers, QueryTriggerInteraction.Ignore);

            // ---- movement ----
            Vector3 step = Vector3.zero;
            if (!player.Dead)
            {
                _strafeT -= Time.deltaTime;
                if (_strafeT <= 0f) { _strafeDir = -_strafeDir; _strafeT = 1.2f + Random.value * 2.2f; }

                if (dist > 16f || !los) step += dir;
                else if (dist < 8f) step -= dir * 0.6f;
                if (los && dist < 26f) step += new Vector3(-dir.z, 0, dir.x) * (_strafeDir * 0.7f);
            }
            if (step.sqrMagnitude > 0.001f)
            {
                _cc.Move((step.normalized * _speed + Vector3.down * 5f) * Time.deltaTime);
                _walkPhase += Time.deltaTime * 9f;
                float sw = Mathf.Sin(_walkPhase) * 28f;
                _legL.localRotation = Quaternion.Euler(sw, 0, 0);
                _legR.localRotation = Quaternion.Euler(-sw, 0, 0);
                _armL.localRotation = Quaternion.Euler(-sw * 0.5f, 0, 0);
                _armR.localRotation = Quaternion.Euler(sw * 0.5f, 0, 0);
            }

            // ---- shooting ----
            _fireCooldown -= Time.deltaTime;
            if (!player.Dead && los && dist < 55f && _fireCooldown <= 0f)
            {
                _fireCooldown = 0.55f + Random.value * 0.9f;
                AudioSynth.PlayShot(eye, Mathf.Max(0.08f, 0.4f - dist * 0.005f), 700f);

                float hitChance = Mathf.Max(0.12f, 0.55f - dist * 0.007f);
                if (player.Sprinting) hitChance *= 0.72f;

                if (Random.value < hitChance)
                {
                    FX.Tracer(eye, playerEye + Random.insideUnitSphere * 0.1f, new Color(1f, 0.75f, 0.5f));
                    player.TakeDamage(7f + Random.value * 8f);
                }
                else
                {
                    Vector3 missDir = (playerEye + Random.insideUnitSphere * 2.5f - eye).normalized;
                    Vector3 end = eye + missDir * 90f;
                    if (Physics.Raycast(eye, missDir, out var hit, 90f, Physics.DefaultRaycastLayers, QueryTriggerInteraction.Ignore))
                        end = hit.point;
                    FX.Tracer(eye, end, new Color(1f, 0.75f, 0.5f));
                    FX.Impact(end);
                }
            }
        }

        public void TakeDamage(float dmg)
        {
            if (Dead) return;
            Health -= dmg;
            if (Health <= 0f)
            {
                Dead = true;
                _cc.enabled = false;
                var head = transform.Find("Head");
                if (head != null) head.GetComponent<Collider>().enabled = false;
                if (GameManager.I != null) GameManager.I.Kills++;
                Destroy(gameObject, 3f);
            }
        }
    }
}
