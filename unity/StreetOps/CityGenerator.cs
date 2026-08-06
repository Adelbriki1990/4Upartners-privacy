using UnityEngine;

namespace StreetOps
{
    /// Builds the downtown combat zone procedurally: street, sidewalks,
    /// towers with lit windows, sponsor billboards, cars, barriers, lamps.
    /// Everything is parented under one root so a restart can wipe it.
    public static class CityGenerator
    {
        public const float StreetHalf = 12f;
        public static readonly float[] AlleyZ = { -55f, -20f, 15f, 50f };

        static GameObject _root;

        public static GameObject Build()
        {
            _root = new GameObject("World");

            BuildGround();
            BuildBuildings();
            BuildProps();
            BuildLamps();
            return _root;
        }

        static GameObject Box(string name, Vector3 pos, Vector3 size, Material mat, bool collider = true)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            go.name = name;
            go.transform.SetParent(_root.transform);
            go.transform.position = pos;
            go.transform.localScale = size;
            go.GetComponent<Renderer>().material = mat;
            if (!collider) Object.Destroy(go.GetComponent<Collider>());
            return go;
        }

        static void BuildGround()
        {
            var asphalt = Materials.Solid(new Color(0.13f, 0.14f, 0.16f), 0.05f);
            Box("Road", new Vector3(0, -0.05f, 0), new Vector3(17f, 0.1f, 170f), asphalt);

            var walkMat = Materials.Solid(new Color(0.23f, 0.24f, 0.26f), 0.05f);
            Box("SidewalkL", new Vector3(-10.5f, 0.11f, 0), new Vector3(4.5f, 0.22f, 170f), walkMat);
            Box("SidewalkR", new Vector3(10.5f, 0.11f, 0), new Vector3(4.5f, 0.22f, 170f), walkMat);

            var lineMat = Materials.Emissive(new Color(0.85f, 0.83f, 0.7f), 0.35f, new Color(0.7f, 0.68f, 0.6f));
            for (float z = -82f; z < 84f; z += 6f)
                Box("Dash", new Vector3(0, 0.012f, z), new Vector3(0.28f, 0.02f, 2.6f), lineMat, false);

            // dirt beyond the buildings so the horizon isn't a void
            var dirt = Materials.Solid(new Color(0.08f, 0.08f, 0.09f), 0f);
            Box("GroundPlane", new Vector3(0, -0.2f, 0), new Vector3(300f, 0.1f, 300f), dirt);
        }

        static void BuildBuildings()
        {
            float z = -85f;
            while (z < 85f)
            {
                bool gap = false;
                foreach (float a in AlleyZ) if (Mathf.Abs(a - z) < 5f) gap = true;
                if (gap) { z += 7f; continue; }

                float d = 12f + Random.value * 10f;
                if (z + d > 85f) break;
                foreach (int sx in new[] { -1, 1 })
                {
                    float w = 10f + Random.value * 8f;
                    float h = 14f + Random.value * 26f;
                    float x = sx * (StreetHalf + 1.4f + w / 2f);
                    var b = Box("Tower", new Vector3(x, h / 2f, z + d / 2f), new Vector3(w, h, d),
                        Materials.Facade(Random.value < 0.7f ? 0.12f : 0.55f));
                    b.GetComponent<Renderer>().material.mainTextureScale =
                        new Vector2(Mathf.Max(1f, Mathf.Round(w / 8f)), Mathf.Max(1f, Mathf.Round(h / 8f)));

                    // sponsor billboard on the street-facing wall of taller towers
                    if (h > 20f && Random.value < 0.75f)
                        AddBillboard(new Vector3(x - sx * (w / 2f + 0.15f), h * 0.6f, z + d / 2f),
                                     Quaternion.Euler(0, sx > 0 ? -90f : 90f, 0), Mathf.Min(d * 0.7f, 9f));
                }
                z += d + 2.5f;
            }

            // end caps so the street feels enclosed
            Box("EndCapN", new Vector3(0, 13f, -97f), new Vector3(40f, 26f, 14f), Materials.Facade(0.12f));
            Box("EndCapS", new Vector3(0, 13f, 97f), new Vector3(40f, 26f, 14f), Materials.Facade(0.12f));
        }

        public static void AddBillboard(Vector3 pos, Quaternion rot, float width)
        {
            var sponsor = SponsorConfig.Random();
            float height = width * 0.5f;

            var panel = GameObject.CreatePrimitive(PrimitiveType.Quad);
            panel.name = "Billboard_" + sponsor.Name;
            panel.transform.SetParent(_root.transform);
            panel.transform.SetPositionAndRotation(pos, rot);
            panel.transform.localScale = new Vector3(width, height, 1f);
            Object.Destroy(panel.GetComponent<Collider>());
            panel.GetComponent<Renderer>().material = Materials.Billboard(sponsor);

            // optional real logo from a Resources folder
            if (!string.IsNullOrEmpty(sponsor.LogoResource))
            {
                var logoTex = Resources.Load<Texture2D>(sponsor.LogoResource);
                if (logoTex != null)
                {
                    var logo = GameObject.CreatePrimitive(PrimitiveType.Quad);
                    logo.name = "Logo";
                    logo.transform.SetParent(panel.transform, false);
                    logo.transform.localPosition = new Vector3(0, 0.1f, -0.01f);
                    logo.transform.localScale = new Vector3(0.55f, 0.55f, 1f);
                    Object.Destroy(logo.GetComponent<Collider>());
                    logo.GetComponent<Renderer>().material = Materials.Emissive(Color.white, 1f);
                    logo.GetComponent<Renderer>().material.mainTexture = logoTex;
                }
            }

            // sponsor name + tagline as legacy 3D text (no TMP dependency)
            var nameGo = new GameObject("Text_" + sponsor.Name);
            nameGo.transform.SetParent(panel.transform, false);
            nameGo.transform.localPosition = new Vector3(0, string.IsNullOrEmpty(sponsor.LogoResource) ? 0.08f : -0.28f, -0.02f);
            nameGo.transform.localScale = new Vector3(1f / width, 1f / height, 1f) * 2.2f;
            var tm = nameGo.AddComponent<TextMesh>();
            tm.text = sponsor.Name + "\n<size=18>" + sponsor.Tagline + "</size>";
            tm.fontSize = 42;
            tm.richText = true;
            tm.characterSize = 0.5f;
            tm.anchor = TextAnchor.MiddleCenter;
            tm.alignment = TextAlignment.Center;
            tm.color = Color.white;

            // soft glow light so ads read at night
            var glow = new GameObject("AdGlow").AddComponent<Light>();
            glow.transform.SetParent(panel.transform, false);
            glow.transform.localPosition = new Vector3(0, 0, -0.6f);
            glow.type = LightType.Point;
            glow.range = width * 1.4f;
            glow.intensity = 1.6f;
            glow.color = Color.Lerp(sponsor.ColorA, Color.white, 0.5f);
        }

        static void BuildProps()
        {
            // parked cars — cover
            Color[] carColors = { new Color(0.48f,0.18f,0.18f), new Color(0.18f,0.29f,0.48f),
                                  new Color(0.34f,0.36f,0.38f), new Color(0.43f,0.39f,0.22f) };
            float[][] cars = {
                new[]{-8.3f,-40f,0f}, new[]{8.3f,-12f,0f}, new[]{-8.4f,12f,0f}, new[]{8.2f,38f,0f},
                new[]{-8.2f,62f,0f}, new[]{8.4f,-62f,0f}, new[]{2.5f,-28f,90f}, new[]{-3f,30f,90f} };
            foreach (var c in cars) AddCar(new Vector3(c[0], 0, c[1]), c[2], carColors[Random.Range(0, carColors.Length)]);

            // concrete barriers + crates mid-street
            var conc = Materials.Solid(new Color(0.42f, 0.43f, 0.45f), 0.05f);
            float[][] bars = { new[]{0f,-5f}, new[]{-2.2f,-5f}, new[]{2.2f,-5f}, new[]{1f,45f},
                               new[]{-1.2f,45f}, new[]{0f,-48f}, new[]{-4f,20f}, new[]{4f,-33f} };
            foreach (var b in bars)
                Box("Barrier", new Vector3(b[0], 0.52f, b[1]), new Vector3(2.1f, 1.05f, 0.65f), conc);

            var crate = Materials.Solid(new Color(0.36f, 0.29f, 0.18f), 0.1f);
            float[][] crates = { new[]{-6f,4f,1.1f}, new[]{6.2f,22f,1.3f}, new[]{-5.5f,-22f,1f},
                                 new[]{5.8f,-50f,1.2f}, new[]{-6.5f,55f,1.1f} };
            foreach (var c in crates)
            {
                var go = Box("Crate", new Vector3(c[0], c[2] / 2f, c[1]), Vector3.one * c[2], crate);
                go.transform.rotation = Quaternion.Euler(0, Random.value * 40f, 0);
            }

            // street-level sponsor panels on bus-stop style stands
            foreach (float zPos in new[] { -35f, 8f, 42f })
            {
                float side = zPos > 0 ? 1f : -1f;
                AddBillboard(new Vector3(side * 9.7f, 1.7f, zPos),
                             Quaternion.Euler(0, side > 0 ? -90f : 90f, 0), 3.2f);
                Box("AdStand", new Vector3(side * 9.7f, 0.5f, zPos), new Vector3(0.2f, 1f, 0.4f),
                    Materials.Solid(new Color(0.15f, 0.16f, 0.18f), 0.4f, 0.6f));
            }
        }

        static void AddCar(Vector3 pos, float rotY, Color color)
        {
            var car = new GameObject("Car");
            car.transform.SetParent(_root.transform);
            car.transform.position = pos;
            car.transform.rotation = Quaternion.Euler(0, rotY, 0);

            var mBody = Materials.Solid(color, 0.7f, 0.5f);
            var mDark = Materials.Solid(new Color(0.07f, 0.08f, 0.1f), 0.4f);

            var body = GameObject.CreatePrimitive(PrimitiveType.Cube);
            body.transform.SetParent(car.transform, false);
            body.transform.localPosition = new Vector3(0, 0.55f, 0);
            body.transform.localScale = new Vector3(1.9f, 0.62f, 4.4f);
            body.GetComponent<Renderer>().material = mBody;

            var cab = GameObject.CreatePrimitive(PrimitiveType.Cube);
            cab.transform.SetParent(car.transform, false);
            cab.transform.localPosition = new Vector3(0, 1.1f, -0.2f);
            cab.transform.localScale = new Vector3(1.7f, 0.55f, 2.2f);
            cab.GetComponent<Renderer>().material = mDark;

            foreach (var w in new[] { new Vector3(-0.95f, 0.34f, 1.45f), new Vector3(0.95f, 0.34f, 1.45f),
                                      new Vector3(-0.95f, 0.34f, -1.45f), new Vector3(0.95f, 0.34f, -1.45f) })
            {
                var wheel = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
                wheel.transform.SetParent(car.transform, false);
                wheel.transform.localPosition = w;
                wheel.transform.localRotation = Quaternion.Euler(0, 0, 90f);
                wheel.transform.localScale = new Vector3(0.68f, 0.125f, 0.68f);
                wheel.GetComponent<Renderer>().material = mDark;
                Object.Destroy(wheel.GetComponent<Collider>());
            }
        }

        static void BuildLamps()
        {
            var mPole = Materials.Solid(new Color(0.16f, 0.18f, 0.2f), 0.4f, 0.6f);
            for (float z = -70f; z <= 70f; z += 35f)
                foreach (int sx in new[] { -1, 1 })
                {
                    var pole = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
                    pole.transform.SetParent(_root.transform);
                    pole.transform.position = new Vector3(sx * 9.6f, 2.8f, z);
                    pole.transform.localScale = new Vector3(0.2f, 2.8f, 0.2f);
                    pole.GetComponent<Renderer>().material = mPole;

                    var bulb = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                    bulb.transform.SetParent(_root.transform);
                    bulb.transform.position = new Vector3(sx * 8.35f, 5.45f, z);
                    bulb.transform.localScale = Vector3.one * 0.28f;
                    bulb.GetComponent<Renderer>().material = Materials.Emissive(new Color(1f, 0.85f, 0.63f), 2f);
                    Object.Destroy(bulb.GetComponent<Collider>());

                    var light = new GameObject("LampLight").AddComponent<Light>();
                    light.transform.SetParent(_root.transform);
                    light.transform.position = new Vector3(sx * 8.35f, 5.3f, z);
                    light.type = LightType.Point;
                    light.range = 16f;
                    light.intensity = 2.2f;
                    light.color = new Color(1f, 0.76f, 0.48f);
                }
        }
    }
}
