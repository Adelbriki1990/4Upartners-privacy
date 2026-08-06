using UnityEngine;

namespace StreetOps
{
    /// First-person controller: mouse look, WASD, sprint, jump,
    /// COD-style regenerating health. Built entirely in code.
    public class PlayerController : MonoBehaviour
    {
        public const float Eye = 1.66f;

        public Camera Cam { get; private set; }
        public Weapon Gun { get; private set; }
        public float Health { get; private set; } = 100f;
        public float LastHurtTime { get; private set; } = -99f;
        public bool Dead { get; private set; }
        public bool Sprinting { get; private set; }

        CharacterController _cc;
        float _yaw, _pitch, _velY;

        public static PlayerController Spawn(Vector3 pos)
        {
            var go = new GameObject("Player");
            go.layer = 2; // Ignore Raycast: enemy line-of-sight checks skip actors
            go.transform.position = pos;
            var cc = go.AddComponent<CharacterController>();
            cc.height = 1.8f;
            cc.radius = 0.38f;
            cc.center = new Vector3(0, 0.9f, 0);
            return go.AddComponent<PlayerController>();
        }

        void Start()
        {
            var camGo = new GameObject("PlayerCamera") { tag = "MainCamera" };
            camGo.transform.SetParent(transform, false);
            camGo.transform.localPosition = new Vector3(0, Eye, 0);
            Cam = camGo.AddComponent<Camera>();
            Cam.fieldOfView = Weapon.BaseFov;
            Cam.nearClipPlane = 0.05f;
            Cam.backgroundColor = new Color(0.05f, 0.08f, 0.13f);
            Cam.clearFlags = CameraClearFlags.SolidColor;
            camGo.AddComponent<AudioListener>();

            Gun = camGo.AddComponent<Weapon>();

            _cc = GetComponent<CharacterController>();
            Cursor.lockState = CursorLockMode.Locked;
            Cursor.visible = false;
        }

        void Update()
        {
            if (Dead) return;

            // re-lock cursor after alt-tab / Esc
            if (Cursor.lockState != CursorLockMode.Locked)
            {
                if (Input.GetMouseButtonDown(0))
                {
                    Cursor.lockState = CursorLockMode.Locked;
                    Cursor.visible = false;
                }
                return;
            }

            // ---- look ----
            float sens = Gun != null && Gun.Aiming ? 1.1f : 2.2f;
            _yaw += Input.GetAxis("Mouse X") * sens;
            _pitch -= Input.GetAxis("Mouse Y") * sens;
            _pitch = Mathf.Clamp(_pitch, -83f, 83f);
            transform.rotation = Quaternion.Euler(0, _yaw, 0);
            float recoil = Gun != null ? Gun.RecoilKick : 0f;
            Cam.transform.localRotation = Quaternion.Euler(_pitch - recoil, 0, 0);

            // ---- move ----
            Vector3 wish = transform.right * Input.GetAxisRaw("Horizontal")
                         + transform.forward * Input.GetAxisRaw("Vertical");
            wish = Vector3.ClampMagnitude(wish, 1f);
            Sprinting = Input.GetKey(KeyCode.LeftShift) && Input.GetAxisRaw("Vertical") > 0 && !(Gun != null && Gun.Aiming);
            float speed = Gun != null && Gun.Aiming ? 2.6f : Sprinting ? 8.2f : 5.2f;

            if (_cc.isGrounded)
            {
                _velY = -1f;
                if (Input.GetKeyDown(KeyCode.Space)) _velY = 7.2f;
            }
            else _velY -= 22f * Time.deltaTime;

            _cc.Move((wish * speed + Vector3.up * _velY) * Time.deltaTime);

            // ---- health regen after 4s without damage ----
            if (Health < 100f && Time.time - LastHurtTime > 4f)
                Health = Mathf.Min(100f, Health + Time.deltaTime * 22f);
        }

        public void TakeDamage(float dmg)
        {
            if (Dead) return;
            Health -= dmg;
            LastHurtTime = Time.time;
            AudioSynth.PlayHurt(transform.position);
            if (Health <= 0f)
            {
                Health = 0f;
                Dead = true;
                Cursor.lockState = CursorLockMode.None;
                Cursor.visible = true;
            }
        }
    }
}
