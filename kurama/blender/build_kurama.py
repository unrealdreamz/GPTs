"""
Kurama (九喇嘛) — procedural Blender build script.

Builds a stylised, fully rigged and animated Nine-Tailed Fox plus the
"seal cage" mindscape set, then exports:

    <out>/kurama.glb      skinned character + all animation clips
    <out>/mindscape.glb   cage / water / pipes environment
    <blend>               a .blend with everything, ready to open in Blender

Run with Blender (4.2+):
    blender --background --python build_kurama.py -- --out ../web/assets --blend kurama.blend
or with the bpy module (pip install bpy==4.2.0, Python 3.11):
    python build_kurama.py --out ../web/assets --blend kurama.blend

Everything is generated from code — no external assets — so it is easy to tweak
proportions (see LANDMARKS / the head section) and rebuild.

Conventions: Blender Z-up, the fox faces -Y, character's left is +X.
Bones use _L/_R suffixes. The web app relies on these names:
    head, neck, jaw, eye_L/R, lid_L/R, ear_L/R, chest, spine, hips, tail_<i>_<k>
"""

import argparse
import math
import os
import random
import sys

import bpy
import bmesh
from mathutils import Matrix, Quaternion, Vector

# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
ap = argparse.ArgumentParser()
ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "assets"))
ap.add_argument("--blend", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "kurama.blend"))
ap.add_argument("--no-export", action="store_true")
ap.add_argument("--fast", action="store_true", help="coarser metaballs for quick iteration")
ARGS = ap.parse_args(argv)

random.seed(9)
V = Vector
FPS = 30

# --------------------------------------------------------------------------
# Palette (sRGB hex -> linear floats)
# --------------------------------------------------------------------------


def srgb(hexstr, a=1.0):
    h = hexstr.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return (lin[0], lin[1], lin[2], a)


FUR = srgb("#F2701E")        # Kurama orange
FUR_DARK = srgb("#C9471A")   # back / tail roots
FUR_LIGHT = srgb("#FF8A2A")  # chest / muzzle highlight
MARK = srgb("#15100E")       # black markings
MOUTH = srgb("#4A0B10")      # mouth interior
TONGUE = srgb("#A82B34")
TEETH = srgb("#F6EEDC")
CLAW = srgb("#1E1B1A")


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(a[i] * (1 - t) + b[i] * t for i in range(4))


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


# --------------------------------------------------------------------------
# Scene helpers
# --------------------------------------------------------------------------

bpy.ops.wm.read_factory_settings(use_empty=True)
SCENE = bpy.context.scene
SCENE.render.fps = FPS


def collection(name, parent=None):
    c = bpy.data.collections.new(name)
    (parent or SCENE.collection).children.link(c)
    return c


COL_KURAMA = collection("Kurama")
COL_SET = collection("Mindscape")


def new_object(name, data, coll):
    o = bpy.data.objects.new(name, data)
    coll.objects.link(o)
    return o


def look_rotation(forward, up=V((0, 0, 1))):
    """Quaternion that maps local +X to `forward` (used for metaball capsules)."""
    f = forward.normalized()
    if abs(f.dot(up)) > 0.98:
        up = V((0, 1, 0))
    side = up.cross(f).normalized()
    up2 = f.cross(side).normalized()
    m = Matrix((f, side, up2)).transposed()
    return m.to_quaternion()


# --------------------------------------------------------------------------
# Metaball modelling with bone tags (used afterwards for skin weights)
# --------------------------------------------------------------------------

THRESH, STIFF = 0.6, 2.0
VIS = 0.575  # visible radius / influence radius at THRESH, STIFF


class Blob:
    """Records metaball elements so the same field can drive skin weights."""

    def __init__(self, name, resolution):
        self.name = name
        self.res = resolution * (1.8 if ARGS.fast else 1.0)
        self.els = []

    def ellipsoid(self, c, semi, tags, rot=None, neg=False, stiff=STIFF):
        a, b, cc = semi
        R = max(a, b, cc) / VIS
        self.els.append(dict(kind="ELLIPSOID", co=V(c), rot=rot or Quaternion(),
                             size=V((a / (VIS * R), b / (VIS * R), cc / (VIS * R))), r=R,
                             tags=tags, neg=neg, stiff=stiff))

    def ball(self, c, rad, tags, neg=False, stiff=STIFF):
        self.ellipsoid(c, (rad, rad, rad), tags, neg=neg, stiff=stiff)

    def capsule(self, a, b, rad, tags, stiff=STIFF):
        a, b = V(a), V(b)
        half = (b - a).length / 2
        self.els.append(dict(kind="CAPSULE", co=(a + b) / 2, rot=look_rotation(b - a),
                             size=V((half, 1, 1)), r=rad / VIS, tags=tags, neg=False, stiff=stiff))

    def field(self, p):
        """Per-element field contributions at point p (list of floats)."""
        out = []
        for e in self.els:
            q = e["rot"].inverted() @ (p - e["co"])
            if e["kind"] == "CAPSULE":
                x = max(-e["size"].x, min(e["size"].x, q.x))
                d2 = (q.x - x) ** 2 + q.y ** 2 + q.z ** 2
            else:
                s = e["size"]
                d2 = (q.x / s.x) ** 2 + (q.y / s.y) ** 2 + (q.z / s.z) ** 2
            t = d2 / (e["r"] ** 2)
            out.append(0.0 if t >= 1 else e["stiff"] * (1 - t) ** 3 * (-1 if e["neg"] else 1))
        return out

    def build(self, coll, decimate=None, keep=None, cull=None):
        mb = bpy.data.metaballs.new(self.name + "_mb")
        mb.resolution = self.res
        mb.render_resolution = self.res
        mb.threshold = THRESH
        for e in self.els:
            el = mb.elements.new(type=e["kind"])
            el.co = e["co"]
            el.rotation = e["rot"]
            el.radius = e["r"]
            el.stiffness = e["stiff"]
            el.use_negative = e["neg"]
            if e["kind"] == "CAPSULE":
                el.size_x = e["size"].x
            else:
                el.size_x, el.size_y, el.size_z = e["size"]
        tmp = new_object(self.name + "_tmp", mb, coll)
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg))
        me.name = self.name
        bpy.data.objects.remove(tmp)
        bpy.data.metaballs.remove(mb)
        obj = new_object(self.name, me, coll)
        # metaball output is already smooth; recalc normals + smooth shading
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=self.res * 0.05)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        if cull is not None:
            # drop geometry buried deep inside another blob (e.g. the neck inside the chest)
            dead = [f for f in bm.faces if all(cull.inside(v.co, 3.0) for v in f.verts)]
            bmesh.ops.delete(bm, geom=dead, context='FACES')
        bm.to_mesh(me)
        bm.free()
        if decimate:
            # curvature-aware reduction; `keep` (0..1) protects detail (eyes, mouth)
            if keep is not None:
                vg = obj.vertex_groups.new(name="_keep")
                for v in me.vertices:
                    vg.add([v.index], max(0.0, min(1.0, keep(v.co))), 'REPLACE')
            mod = obj.modifiers.new("Decimate", 'DECIMATE')
            mod.decimate_type = 'COLLAPSE'
            mod.ratio = decimate
            if keep is not None:
                mod.vertex_group = "_keep"
                mod.invert_vertex_group = True
                mod.vertex_group_factor = 2.0
            dg = bpy.context.evaluated_depsgraph_get()
            me2 = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
            obj.modifiers.clear()
            obj.data = me2
            bpy.data.meshes.remove(me)
            me = me2
            me.name = self.name
            for g in list(obj.vertex_groups):
                obj.vertex_groups.remove(g)
        for poly in me.polygons:
            poly.use_smooth = True
        return obj

    def inside(self, p, k=1.0):
        return sum(self.field(p)) > THRESH * k

    def weights(self, obj, extra=None):
        """Skin weights from the tagged field: weight(bone) = sum field of its elements."""
        wmap = []
        for v in obj.data.vertices:
            f = self.field(v.co)
            acc = {}
            for e, val in zip(self.els, f):
                if val <= 0:
                    continue
                for bone, share in e["tags"].items():
                    acc[bone] = acc.get(bone, 0.0) + val * share
            if extra:
                extra(v.co, acc)
            if not acc:  # far from everything -> nearest element
                best = min(range(len(self.els)), key=lambda i: (self.els[i]["co"] - v.co).length)
                acc = dict(self.els[best]["tags"])
            wmap.append(acc)
        assign_weights(obj, wmap)


def assign_weights(obj, wmap, max_inf=4):
    groups = {}
    for i, acc in enumerate(wmap):
        items = sorted(acc.items(), key=lambda kv: -kv[1])[:max_inf]
        tot = sum(w for _, w in items) or 1.0
        for bone, w in items:
            w /= tot
            if w < 0.01:
                continue
            g = groups.get(bone)
            if g is None:
                g = groups[bone] = obj.vertex_groups.get(bone) or obj.vertex_groups.new(name=bone)
            g.add([i], w, 'REPLACE')


def single_bone_weights(obj, bone):
    g = obj.vertex_groups.get(bone) or obj.vertex_groups.new(name=bone)
    g.add(list(range(len(obj.data.vertices))), 1.0, 'REPLACE')


def paint(obj, fn):
    """Vertex colours (point domain, linear float) from fn(co, normal) -> rgba."""
    me = obj.data
    attr = me.color_attributes.get("Col") or me.color_attributes.new("Col", 'FLOAT_COLOR', 'POINT')
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find("Col")
    for v in me.vertices:
        attr.data[v.index].color = fn(v.co, v.normal)


def mesh_from_bmesh(name, bm, coll, smooth=True):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    return new_object(name, me, coll)


# --------------------------------------------------------------------------
# LANDMARKS (sphinx pose, propped on the forearms, head raised)
# --------------------------------------------------------------------------

H = V((0, -0.35, 4.3))           # head bone origin (top of neck)
HS = 1.3                          # head scale (Kurama has a big head)


def hp(x, y, z):
    """Head-local (unscaled) point -> world."""
    return H + V((x, y, z)) * HS


def to_head(co):
    """World -> head-local (unscaled)."""
    return (co - H) / HS


L = dict(
    hips=V((0, 3.35, 1.75)),
    spine=V((0, 2.15, 2.15)),
    chest=V((0, 0.95, 2.55)),
    neck=V((0, 0.35, 3.25)),
    shoulder=V((1.35, 0.55, 2.85)),
    elbow=V((1.75, 0.35, 0.62)),
    wrist=V((1.62, -1.75, 0.42)),
    paw=V((1.62, -2.55, 0.28)),
    hip_joint=V((1.30, 3.35, 1.55)),
    knee=V((1.95, 2.05, 0.75)),
    hock=V((1.85, 3.95, 0.45)),
    toe=V((1.85, 2.85, 0.22)),
    tail_root=V((0, 4.45, 1.85)),
)


def mirror(p):
    return V((-p.x, p.y, p.z))


def side(p, s):
    return p if s > 0 else mirror(p)


# eye / ear anchors in head-local space (left side, +X)
EYE_C = V((0.56, -1.30, 0.64))
EYE_R = 0.27
EYE_FWD_X = 0.30         # eyes look forward, slightly outward
EAR_BASE = V((0.74, -0.12, 1.12))
EAR_TIP = V((1.3, 0.42, 2.85))
JAW_PIVOT = V((0, -0.40, -0.12))
LIP_Z = -0.28            # mouth line height (head-local)
MOUTH_BACK_Y = -0.50     # mouth corner (head-local y)
HEAD_C = V((0, -0.40, 0.45))  # centre used for the angular marking map


# --------------------------------------------------------------------------
# BODY
# --------------------------------------------------------------------------

BLOBS = {}


def fur_color(co, n):
    """Base fur: darker along the back, slightly lighter on the chest/throat."""
    c = mix(FUR, FUR_DARK, smoothstep(0.2, 0.9, n.z) * smoothstep(1.0, 3.0, co.y) * 0.55)
    return mix(c, FUR_LIGHT, smoothstep(0.2, 0.9, -n.y) * smoothstep(1.5, 0.0, co.y) * smoothstep(4.6, 3.6, co.z) * 0.3)


def build_body():
    b = Blob("Kurama_Body", 0.06)
    T = lambda **kw: kw  # noqa: E731
    # torso
    b.ellipsoid(L["hips"] + V((0, 0.1, 0.05)), (1.45, 1.35, 1.12), T(hips=1.0))
    b.ellipsoid(L["spine"] + V((0, 0, 0.1)), (1.38, 1.3, 1.18), T(spine=1.0, hips=0.3))
    b.ellipsoid(L["chest"] + V((0, 0.05, 0.1)), (1.55, 1.2, 1.35), T(chest=1.0, spine=0.25))
    for s in (1, -1):                                                                 # pecs (centre crease)
        b.ellipsoid(L["chest"] + V((0.5 * s, -0.55, -0.3)), (0.74, 0.78, 0.92), T(chest=1.0))
    # neck root (the head mesh brings the rest of the neck)
    b.capsule(L["chest"] + V((0, -0.2, 0.4)), L["neck"] + V((0, -0.1, 0.25)), 0.95, T(chest=0.6, neck=0.4))
    # tail base mound
    b.ball(L["tail_root"] + V((0, -0.1, 0.05)), 0.55, T(hips=1.0))
    for s in (1, -1):
        sfx = "_L" if s > 0 else "_R"
        sh, el, wr, pw = (side(L[k], s) for k in ("shoulder", "elbow", "wrist", "paw"))
        # shoulder + upper arm
        b.ball(sh, 0.95, {"chest": 0.5, "upperarm" + sfx: 0.5})
        b.capsule(sh, el + V((0, 0, 0.15)), 0.7, {"upperarm" + sfx: 1.0})
        b.ball(el, 0.58, {"upperarm" + sfx: 0.5, "forearm" + sfx: 0.5})
        # forearm lying on the ground
        b.capsule(el, wr, 0.54, {"forearm" + sfx: 1.0})
        b.ellipsoid(el.lerp(wr, 0.3) + V((0, 0, 0.12)), (0.62, 0.9, 0.55), {"forearm" + sfx: 1.0})
        # paw (palm + four fingers + thumb)
        b.ellipsoid(pw + V((0, 0.2, 0.0)), (0.55, 0.62, 0.3), {"paw" + sfx: 1.0})
        for i, dx in enumerate((-0.33, -0.11, 0.11, 0.33)):
            f0 = pw + V((dx * s, -0.35, 0.02))
            f1 = f0 + V((dx * 0.35 * s, -0.45, -0.1))
            b.capsule(f0, f1, 0.13, {"paw" + sfx: 1.0}, stiff=1.6)
        b.capsule(pw + V((-0.42 * s, 0.05, 0.05)), pw + V((-0.6 * s, -0.3, -0.05)), 0.12, {"paw" + sfx: 1.0}, stiff=1.6)
        # hind leg folded under
        hj, kn, hk, to = (side(L[k], s) for k in ("hip_joint", "knee", "hock", "toe"))
        b.ellipsoid(hj + V((0.18 * s, -0.3, -0.25)), (0.85, 1.3, 1.0), {"thigh" + sfx: 1.0, "hips": 0.35})
        b.capsule(hj, kn, 0.6, {"thigh" + sfx: 1.0})
        b.ball(kn, 0.42, {"thigh" + sfx: 0.5, "shin" + sfx: 0.5})
        b.capsule(kn, hk, 0.34, {"shin" + sfx: 1.0})
        b.capsule(hk, to, 0.26, {"foot" + sfx: 1.0})
        b.ellipsoid(to + V((0, -0.1, 0.0)), (0.36, 0.42, 0.2), {"foot" + sfx: 1.0})
    def keep(co):  # protect fingers / toes from decimation
        d = min((co - side(L[k], s)).length for k in ("paw", "toe") for s in (1, -1))
        return 1.0 - smoothstep(0.5, 1.1, d)

    obj = b.build(COL_KURAMA, decimate=0.3, keep=keep)
    b.weights(obj)
    BLOBS["body"] = b

    paint(obj, fur_color)
    return obj


# --------------------------------------------------------------------------
# HEAD (skull + upper muzzle + neck), JAW, EYES, EARS, TEETH
# --------------------------------------------------------------------------

def head_angles(p):
    """Azimuth/elevation of a head-local point around HEAD_C (0 az = straight ahead)."""
    d = p - HEAD_C
    return math.atan2(d.x, -d.y), math.atan2(d.z, math.hypot(d.x, d.y))


def seg_dist2d(p, a, b):
    ab = (b[0] - a[0], b[1] - a[1])
    ap_ = (p[0] - a[0], p[1] - a[1])
    L2 = ab[0] ** 2 + ab[1] ** 2
    t = max(0.0, min(1.0, (ap_[0] * ab[0] + ap_[1] * ab[1]) / L2))
    q = (a[0] + ab[0] * t, a[1] + ab[1] * t)
    return math.hypot(p[0] - q[0], p[1] - q[1]), t


def eye_marking(p, n):
    """Coverage (0..1) of the black 'eyeliner' marks sweeping from each eye toward the ear.
    Soft edges so vertex-colour interpolation gives clean anti-aliased shapes."""
    d = (p - HEAD_C)
    if n.dot(d.normalized()) < 0.05:
        return 0.0
    az, el = head_angles(p)
    cov = 0.0
    for s in (1, -1):
        e_az, e_el = head_angles(V((EYE_C.x * s, EYE_C.y, EYE_C.z)))
        a_az, a_el = head_angles(V((EAR_BASE.x * s, EAR_BASE.y, EAR_BASE.z)))
        # ring around the eye (slightly wider toward the outer corner)
        dx = (az - e_az - 0.02 * s) / 0.22
        dy = (el - e_el) / 0.13
        r = math.sqrt(dx * dx + dy * dy)
        cov = max(cov, 1 - smoothstep(0.85, 1.1, r))
        # pointed wing sweeping from the outer-upper eye corner up toward the ear base
        dist, t = seg_dist2d((az, el), (e_az + 0.12 * s, e_el + 0.06), (a_az - 0.02 * s, a_el + 0.02))
        w = 0.075 * (1 - t) ** 1.2 + 0.012
        cov = max(cov, 1 - smoothstep(w * 0.75, w * 1.15, dist))
    return cov


class JawProfile:
    """Measured from the jaw mesh: outer half-width of the jaw at (y, z) in head-local units."""

    def __init__(self, jaw_obj):
        self.pts = [to_head(v.co) for v in jaw_obj.data.vertices]
        self.top = {}
        for v, p in zip(jaw_obj.data.vertices, self.pts):
            if v.normal.z > 0.3:
                k = round(p.y / 0.05)
                self.top[k] = max(self.top.get(k, 0.0), abs(p.x))

    def top_half_width(self, y):
        k = round(y / 0.05)
        vals = [self.top[j] for j in (k - 1, k, k + 1) if j in self.top]
        return max(vals) if vals else 0.0

    def half_width_at(self, y, z, tol=0.06):
        xs = [abs(p.x) for p in self.pts if abs(p.y - y) < tol and abs(p.z - z) < tol]
        return max(xs) if xs else 0.0


def build_head(jaw_profile):
    b = Blob("Kurama_Head", 0.033)
    hd = {"head": 1.0}

    def E(c, semi, tags=hd, **kw):
        b.ellipsoid(hp(*c), tuple(x * HS for x in semi), tags, **kw)

    E((0, -0.35, 0.52), (1.12, 1.05, 0.88))                 # cranium
    E((0, -0.98, 0.84), (0.96, 0.48, 0.32))                 # brow shelf
    for s in (1, -1):
        E((0.90 * s, -0.66, 0.10), (0.70, 0.74, 0.50))      # cheeks
        E((1.24 * s, -0.28, -0.02), (0.42, 0.5, 0.46))      # cheek ruff base
        E((0.30 * s, -1.75, -0.10), (0.25, 0.78, 0.26))     # upper lip sides (set the mouth width)
    # tapered muzzle: a chain of shrinking ellipsoids ending at the nose
    E((0, -1.22, 0.10), (0.62, 0.52, 0.46))
    E((0, -1.72, 0.10), (0.50, 0.52, 0.40))
    E((0, -2.18, 0.10), (0.38, 0.46, 0.33))
    E((0, -2.58, 0.12), (0.26, 0.36, 0.26))
    E((0, -1.90, 0.34), (0.24, 0.92, 0.20))                 # nose bridge ridge
    # neck: sinks into the chest; blends head/neck/chest
    b.capsule(hp(0, 0.25, 0.05), hp(0, 0.55, -0.75), 0.92, {"neck": 0.7, "head": 0.3})
    b.capsule(hp(0, 0.55, -0.75), L["neck"] + V((0, 0.3, -0.45)), 0.98, {"neck": 0.6, "chest": 0.4})
    for s in (1, -1):                                        # shallow eye sockets
        b.ball(hp(EYE_C.x * s, EYE_C.y + 0.02, EYE_C.z + 0.02), 0.12 * HS, hd, neg=True, stiff=1.0)
    def keep(co):  # keep the face dense (eyes, markings, mouth), thin out the skull/neck
        p = to_head(co)
        face = smoothstep(-0.2, -0.9, p.y) * smoothstep(-0.9, -0.5, p.z)
        near_eye = max(1 - smoothstep(0.25, 0.7, (p - V((EYE_C.x * s, EYE_C.y, EYE_C.z))).length) for s in (1, -1))
        return max(face, near_eye, smoothstep(0.35, 0.1, abs(p.z - LIP_Z)) * smoothstep(-0.2, -0.6, p.y))

    obj = b.build(COL_KURAMA, decimate=0.45, keep=keep, cull=BLOBS.get("body"))
    b.weights(obj)
    BLOBS["head"] = b

    def col(co, n):
        p = to_head(co)
        # mouth interior (palate): downward facing surfaces directly above the jaw
        if p.y < MOUTH_BACK_Y + 0.2 and LIP_Z - 0.3 < p.z < LIP_Z + 0.12 and n.z < -0.3:
            if abs(p.x) < jaw_profile.top_half_width(p.y) + 0.03:
                return MOUTH
        # thin black lip line where the upper lip meets the jaw
        if p.y < MOUTH_BACK_Y + 0.1 and abs(p.z - (LIP_Z + 0.02)) < 0.025 and -0.6 < n.z < 0.3:
            return MARK
        return mix(fur_color(co, n), MARK, eye_marking(p, n))

    paint(obj, col)
    return obj


def build_jaw():
    b = Blob("Kurama_Jaw", 0.032)
    jw = {"jaw": 1.0}

    def E(c, semi):
        b.ellipsoid(hp(*c), tuple(x * HS for x in semi), jw)

    E((0, -1.02, -0.46), (0.54, 0.62, 0.26))
    E((0, -1.70, -0.44), (0.40, 0.56, 0.23))
    E((0, -2.30, -0.40), (0.26, 0.46, 0.19))
    for s in (1, -1):
        E((0.42 * s, -0.78, -0.38), (0.27, 0.42, 0.28))    # jaw hinge mass (kept in front of the pivot)
    obj = b.build(COL_KURAMA, decimate=0.6, keep=lambda co: smoothstep(-0.5, -0.3, to_head(co).z))
    single_bone_weights(obj, "jaw")

    def col(co, n):
        p = to_head(co)
        if n.z > 0.3 and p.z > -0.36:
            return MOUTH
        if abs(p.z - (LIP_Z + 0.0)) < 0.03 and n.z > -0.3:
            return MARK
        return mix(FUR, FUR_LIGHT, smoothstep(0.0, -0.9, n.z) * 0.3)

    paint(obj, col)
    return obj


def cone(bm, base, tip, r, segs=10, bend=None):
    """Add a (slightly bent) cone to bm; returns created verts."""
    axis = (tip - base)
    L_ = axis.length
    fwd = axis.normalized()
    ref = V((0, 0, 1)) if abs(fwd.z) < 0.9 else V((1, 0, 0))
    u = fwd.cross(ref).normalized()
    w = fwd.cross(u).normalized()
    rings = 5
    ring_verts = []
    for k in range(rings):
        t = k / rings
        c = base + axis * t
        if bend is not None:
            c = c + bend * (t * t) * L_
        rr = r * (1 - t) ** 0.9
        ring = []
        for i in range(segs):
            a = 2 * math.pi * i / segs
            ring.append(bm.verts.new(c + (u * math.cos(a) + w * math.sin(a)) * rr))
        ring_verts.append(ring)
    tipv = bm.verts.new(tip + (bend * L_ if bend is not None else V()))
    capv = bm.verts.new(base - fwd * r * 0.2)
    for k in range(rings - 1):
        a, b_ = ring_verts[k], ring_verts[k + 1]
        for i in range(segs):
            j = (i + 1) % segs
            bm.faces.new((a[i], a[j], b_[j], b_[i]))
    last = ring_verts[-1]
    for i in range(segs):
        bm.faces.new((last[i], last[(i + 1) % segs], tipv))
        bm.faces.new((ring_verts[0][(i + 1) % segs], ring_verts[0][i], capv))
    return [v for ring in ring_verts for v in ring] + [tipv, capv]


def mouth_half_width(y):
    """Half width of the tooth row at head-local y (front of the mouth is y≈-2.75)."""
    return 0.07 + 0.46 * smoothstep(-2.85, -0.9, y)


def build_teeth(jaw_profile):
    """Upper teeth -> head, lower teeth -> jaw. Visible even with the mouth shut (the grin)."""
    objs = []
    n = 13
    for part, bone in (("Upper", "head"), ("Lower", "jaw")):
        bm = bmesh.new()
        for s in (1, -1):
            for i in range(n):
                t = (i + (0.5 if part == "Lower" else 0.0)) / (n - 1)
                if t > 1.0:
                    continue
                y = -2.62 + t * 1.95                       # front -> back along the mouth
                fang = (i == 1) if part == "Upper" else (i == 3)
                length = (0.30 if fang else 0.19 - 0.06 * t) * HS
                rad = (0.07 if fang else 0.05) * HS
                if part == "Upper":
                    zb = LIP_Z + 0.06
                    x = max(jaw_profile.half_width_at(y, LIP_Z - 0.1), 0.06) + 0.012
                    base = hp(x * s, y, zb)
                    tip = hp((x - 0.02) * s, y - 0.02, zb) + V((0, 0, -length))
                else:
                    zb = LIP_Z - 0.13
                    x = max(jaw_profile.half_width_at(y, zb), 0.05) + 0.004
                    base = hp(x * s, y, zb)
                    tip = hp((x - 0.03) * s, y - 0.02, zb) + V((0, 0, length * 0.9))
                cone(bm, base, tip, rad, segs=7)
        obj = mesh_from_bmesh("Kurama_Teeth" + part, bm, COL_KURAMA)
        single_bone_weights(obj, bone)
        objs.append(obj)
    return objs


def build_tongue():
    b = Blob("Kurama_Tongue", 0.05)
    b.ellipsoid(hp(0, -1.4, -0.34), (0.32 * HS, 0.9 * HS, 0.1 * HS), {"jaw": 1.0})
    obj = b.build(COL_KURAMA)
    single_bone_weights(obj, "jaw")
    paint(obj, lambda co, n: TONGUE)
    return obj


def eye_frame(s):
    """(centre, forward, 4x4 rotation) of the left (s=1) / right (s=-1) eye."""
    c = hp(EYE_C.x * s, EYE_C.y, EYE_C.z)
    fwd = V((EYE_FWD_X * s, -1, 0.05)).normalized()
    rot = look_rotation(fwd).to_matrix().to_4x4()          # local X -> fwd, Z -> up
    slant = Quaternion(V((1, 0, 0)), math.radians(14 * s)).to_matrix().to_4x4()  # outer corner up
    return c, fwd, rot @ slant


def build_eyes():
    """Eyeballs (red, slit pupils) on eye bones + black lids on lid bones."""
    eye_objs = []
    lid_bm = bmesh.new()
    lid_groups = []
    R = EYE_R * HS
    for s in (1, -1):
        sfx = "_L" if s > 0 else "_R"
        c, fwd, rot = eye_frame(s)
        # eyeball: almond — scaled UV sphere (local X depth, Y width, Z height)
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=28, v_segments=18, radius=R)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(c) @ rot @ Matrix.Diagonal((0.55, 1.32, 0.82, 1)), verts=bm.verts)
        eye = mesh_from_bmesh("Kurama_Eye" + sfx, bm, COL_KURAMA)
        eye.data.materials.append(MATS["eye"])
        # vertical slit pupil
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=10, radius=1.0)
        pc = c + fwd * (R * 0.47)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(pc) @ rot @ Matrix.Diagonal((0.13 * R, 0.16 * R, 0.62 * R, 1)), verts=bm.verts)
        pupil = mesh_from_bmesh("Kurama_Pupil" + sfx, bm, COL_KURAMA)
        pupil.data.materials.append(MATS["pupil"])
        for o in (eye, pupil):
            single_bone_weights(o, "eye" + sfx)
        eye_objs += [eye, pupil]

        # lids: partial shells a bit larger than the eye; the upper lid is rolled so the
        # inner corner sits low -> the permanent glare
        for which in ("upper", "lower"):
            segs_u, segs_v = 20, 7
            # the upper lid is a big shell (0..120°) rotated back 60° so it rests open and can
            # swing down over the whole eye; the lower lid is a fixed cap
            th0, th1 = (0.0, math.radians(120)) if which == "upper" else (math.radians(132), math.radians(180))
            pre = Quaternion(V((0, 1, 0)), math.radians(-60 if which == "upper" else 0))
            rows = []
            for i in range(segs_v + 1):
                th = th0 + (th1 - th0) * i / segs_v
                row = []
                for j in range(segs_u + 1):
                    ph = math.pi * (0.02 + 0.96 * j / segs_u)
                    lx = math.sin(th) * math.sin(ph)
                    ly = math.sin(th) * math.cos(ph)
                    lz = math.cos(th)
                    q = pre @ V((lx, ly, lz))
                    row.append(V((q.x * 0.64, q.y * 1.42, q.z * 0.95)) * R * 1.02)
                rows.append(row)
            roll = -24 * s if which == "upper" else 6 * s
            M = Matrix.Translation(c) @ rot @ Quaternion(V((1, 0, 0)), math.radians(roll)).to_matrix().to_4x4()
            vv = [[lid_bm.verts.new(M @ p) for p in row] for row in rows]
            for i in range(segs_v):
                for j in range(segs_u):
                    lid_bm.faces.new((vv[i][j], vv[i][j + 1], vv[i + 1][j + 1], vv[i + 1][j]))
            bone = ("lid" + sfx) if which == "upper" else "head"
            lid_groups += [bone] * ((segs_v + 1) * (segs_u + 1))
    bmesh.ops.recalc_face_normals(lid_bm, faces=lid_bm.faces)
    lids = mesh_from_bmesh("Kurama_Lids", lid_bm, COL_KURAMA)
    solid = lids.modifiers.new("Solidify", 'SOLIDIFY')
    solid.thickness = 0.035
    solid.offset = 1.0
    dg = bpy.context.evaluated_depsgraph_get()
    me2 = bpy.data.meshes.new_from_object(lids.evaluated_get(dg))
    old = lids.data
    n0 = len(old.vertices)          # solidify output: originals, then offset copies
    lids.modifiers.clear()
    lids.data = me2
    bpy.data.meshes.remove(old)
    assign_weights(lids, [{lid_groups[i % n0]: 1.0} for i in range(len(me2.vertices))])
    for p in me2.polygons:
        p.use_smooth = True
    paint(lids, lambda co, n: MARK)
    return eye_objs + [lids]


def build_nose():
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=1.0)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(hp(0, -2.92, 0.26)) @ Matrix.Diagonal((0.16 * HS, 0.13 * HS, 0.105 * HS, 1)), verts=bm.verts)
    obj = mesh_from_bmesh("Kurama_Nose", bm, COL_KURAMA)
    single_bone_weights(obj, "head")
    paint(obj, lambda co, n: MARK)
    return obj


def paint_list(obj, colors):
    me = obj.data
    attr = me.color_attributes.get("Col") or me.color_attributes.new("Col", 'FLOAT_COLOR', 'POINT')
    me.color_attributes.active_color = attr
    for i, c in enumerate(colors):
        attr.data[i].color = c


def build_ears():
    bm = bmesh.new()
    wmap, colors = [], []
    for s in (1, -1):
        sfx = "_L" if s > 0 else "_R"
        base = hp(EAR_BASE.x * s, EAR_BASE.y, EAR_BASE.z)
        tip = hp(EAR_TIP.x * s, EAR_TIP.y, EAR_TIP.z)
        axis = tip - base
        up = axis.normalized()
        face = V((0.4 * s, -1, 0.0)).normalized()
        across = up.cross(face).normalized()
        face = across.cross(up).normalized()
        nu, nv = 18, 10
        rows_front, rows_back = [], []
        for i in range(nu + 1):
            u = i / nu
            width = 0.56 * HS * math.sin(math.pi * min(1.0, 0.2 + 0.8 * u)) ** 0.85 * (1 - 0.2 * u)
            rf, rb = [], []
            for j in range(nv + 1):
                v = -1 + 2 * j / nv
                cup = -0.3 * HS * (1 - v * v) * math.sin(math.pi * min(1, u * 1.1)) * (1 - u * 0.5)
                pos = base + axis * u + across * (v * width) + face * cup
                thick = (0.1 * (1 - u) + 0.025) * HS
                rf.append(bm.verts.new(pos))
                rb.append(bm.verts.new(pos - face * thick))
                w_ear = smoothstep(0.0, 0.3, u)
                for _ in range(2):
                    wmap.append({"ear" + sfx: 0.3 + 0.7 * w_ear, "head": 1 - w_ear})
                inner = abs(v) < 0.72 and 0.07 < u < 0.93
                colors.append(MARK if inner else mix(FUR, FUR_DARK, 0.2))   # front
                colors.append(mix(FUR, FUR_DARK, 0.25 + 0.3 * u))            # back
            rows_front.append(rf)
            rows_back.append(rb)
        for i in range(nu):
            for j in range(nv):
                bm.faces.new((rows_front[i][j], rows_front[i + 1][j], rows_front[i + 1][j + 1], rows_front[i][j + 1]))
                bm.faces.new((rows_back[i][j], rows_back[i][j + 1], rows_back[i + 1][j + 1], rows_back[i + 1][j]))
            bm.faces.new((rows_front[i][0], rows_back[i][0], rows_back[i + 1][0], rows_front[i + 1][0]))
            bm.faces.new((rows_front[i][nv], rows_front[i + 1][nv], rows_back[i + 1][nv], rows_back[i][nv]))
        for j in range(nv):
            bm.faces.new((rows_front[0][j], rows_front[0][j + 1], rows_back[0][j + 1], rows_back[0][j]))
            bm.faces.new((rows_front[nu][j], rows_back[nu][j], rows_back[nu][j + 1], rows_front[nu][j + 1]))
    # bmesh creates verts in the same order we appended weights/colours (front, back per sample)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = mesh_from_bmesh("Kurama_Ears", bm, COL_KURAMA)
    assign_weights(obj, wmap)
    paint_list(obj, colors)
    return obj


# --------------------------------------------------------------------------
# NINE TAILS
# --------------------------------------------------------------------------

N_TAILS = 9
TAIL_BONES = 6


def catmull(pts, t):
    n = len(pts) - 1
    x = t * n
    i = min(int(x), n - 1)
    u = x - i
    p0 = pts[max(i - 1, 0)]
    p1, p2 = pts[i], pts[i + 1]
    p3 = pts[min(i + 2, n)]
    return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u)


def tail_curve(i):
    """Control points for tail i (fan behind the body)."""
    k = i - (N_TAILS - 1) / 2                       # -4..4
    ang = math.radians(k * 21.5)                     # fan angle from vertical
    length = 1.42 - 0.05 * abs(k)
    r = L["tail_root"]
    sx, cz = math.sin(ang), math.cos(ang)
    flick = math.copysign(1, k) if k else 1
    offs = [
        V((0, 0, 0)),
        V((sx * 0.2, 0.9, 0.45)),
        V((sx * 1.3, 1.75, 1.3 + cz * 1.1)),
        V((sx * 3.2, 2.1, 1.7 + cz * 3.2)),
        V((sx * 4.9, 1.6, 1.8 + cz * 5.1)),
        V((sx * 5.6 - 0.6 * cz * flick, 0.8, 1.6 + cz * 6.2 + 0.6 * abs(sx))),
    ]
    return [r + o * (length if j > 1 else 1.0) for j, o in enumerate(offs)]


def build_tails():
    bm = bmesh.new()
    wmap = []
    segs, rings = 16, 44
    bone_heads_all = []
    for i in range(N_TAILS):
        pts = tail_curve(i)
        samples = [catmull(pts, t / rings) for t in range(rings + 1)]
        # arc length parameter
        acc = [0.0]
        for a, b_ in zip(samples, samples[1:]):
            acc.append(acc[-1] + (b_ - a).length)
        total = acc[-1]
        u_of = [a / total for a in acc]
        # parallel transport frames
        tangents = [(samples[min(k + 1, rings)] - samples[max(k - 1, 0)]).normalized() for k in range(rings + 1)]
        normal = V((1, 0, 0)).cross(tangents[0]).normalized()
        if normal.length < 0.1:
            normal = V((0, 0, 1))
        frames = []
        for k, t in enumerate(tangents):
            normal = (normal - t * normal.dot(t)).normalized()
            frames.append((normal, t.cross(normal).normalized()))
        # bone boundaries along the tail (u)
        cuts = [0.0, 0.14, 0.3, 0.46, 0.62, 0.78, 1.0]
        bone_heads_all.append([catmull(pts, 0) if c == 0 else samples[min(range(rings + 1), key=lambda k: abs(u_of[k] - c))] for c in cuts])
        rows = []
        for k in range(rings + 1):
            u = u_of[k]
            if u < 0.4:
                shape = 0.52 + 0.48 * math.sin(math.pi / 2 * u / 0.4)
            else:
                shape = ((1 - u) / 0.6) ** 0.75
            rad = 1.0 * shape * (1.0 - 0.03 * abs(i - 4))
            c = samples[k]
            nrm, bi = frames[k]
            row = []
            if k == rings:
                row = [bm.verts.new(c)]
            else:
                for j in range(segs):
                    a = 2 * math.pi * j / segs
                    # subtle fur ridges that twist along the tail
                    ridge = 1 + 0.045 * math.sin(5 * a + u * 9) * smoothstep(0.1, 0.5, u)
                    row.append(bm.verts.new(c + (nrm * math.cos(a) + bi * math.sin(a)) * rad * ridge))
            rows.append(row)
            # weights along the chain
            for _ in row:
                seg = 0
                while seg < TAIL_BONES - 1 and u > (cuts[seg] + cuts[seg + 1]) / 2 + (cuts[seg + 1] - cuts[seg]) / 2:
                    seg += 1
                # blend with next bone near the boundary
                lo, hi = cuts[seg], cuts[seg + 1]
                f = (u - lo) / (hi - lo)
                acc_w = {f"tail_{i}_{seg}": 1.0}
                if f > 0.6 and seg < TAIL_BONES - 1:
                    b2 = smoothstep(0.6, 1.0, f) * 0.5
                    acc_w = {f"tail_{i}_{seg}": 1 - b2, f"tail_{i}_{seg + 1}": b2}
                elif f < 0.4 and seg > 0:
                    b2 = smoothstep(0.4, 0.0, f) * 0.5
                    acc_w = {f"tail_{i}_{seg}": 1 - b2, f"tail_{i}_{seg - 1}": b2}
                if seg == 0 and f < 0.5:
                    acc_w["hips"] = 0.6 * (1 - f * 2)
                wmap.append(acc_w)
        for k in range(rings - 1):
            a, b_ = rows[k], rows[k + 1]
            for j in range(segs):
                bm.faces.new((a[j], a[(j + 1) % segs], b_[(j + 1) % segs], b_[j]))
        last, tipv = rows[rings - 1], rows[rings][0]
        for j in range(segs):
            bm.faces.new((last[j], last[(j + 1) % segs], tipv))
    obj = mesh_from_bmesh("Kurama_Tails", bm, COL_KURAMA)
    assign_weights(obj, wmap)

    root = L["tail_root"]

    def col(co, n):
        d = (co - root).length
        return mix(FUR_DARK, FUR, smoothstep(0.5, 2.5, d))

    paint(obj, col)
    return obj, bone_heads_all


# --------------------------------------------------------------------------
# FUR SPIKES + CLAWS
# --------------------------------------------------------------------------

def build_spikes():
    bm = bmesh.new()
    groups = []

    def spike(base, direction, length, rad, bone, bend=None):
        vs = cone(bm, base, base + direction.normalized() * length, rad, segs=8, bend=bend)
        groups.extend([bone] * len(vs))

    for s in (1, -1):
        sfx = "_L" if s > 0 else "_R"
        # cheek ruff: jagged fur sweeping back/out below the ears
        for (x, y, z, dx, dy, dz, ln) in ((1.45, -0.55, 0.10, 0.85, 0.45, -0.05, 0.62),
                                          (1.40, -0.30, -0.22, 0.75, 0.55, -0.45, 0.66),
                                          (1.15, -0.60, -0.42, 0.45, 0.3, -0.85, 0.52),
                                          (1.38, -0.05, 0.36, 0.7, 0.7, 0.3, 0.5)):
            spike(hp(x * s, y, z), V((dx * s, dy, dz)), ln * HS, 0.22 * HS, "head", bend=V((0, 0.15, 0.05)))
        # elbow tufts
        el = side(L["elbow"], s)
        for k, (dz, ln) in enumerate(((0.45, 0.85), (0.1, 0.7))):
            spike(el + V((0.4 * s, 0.3, dz)), V((0.45 * s, 1.0, 0.1)), ln, 0.26, "upperarm" + sfx, bend=V((0, 0, 0.12)))
    # chest ruff: two staggered rows of tufts under the throat, rooted on the actual surface
    def surface(x, z):
        for i in range(300):
            y = -3.5 + i * 0.02
            p = V((x, y, z))
            if any(BLOBS[k].inside(p) for k in ("body", "head") if k in BLOBS):
                return p
        return None

    for row, (z, xs, ln) in enumerate(((3.45, (-0.62, -0.21, 0.21, 0.62), 0.78), (2.85, (-0.82, -0.41, 0.0, 0.41, 0.82), 0.72))):
        for x in xs:
            p = surface(x, z)
            if p is None:
                continue
            base = p + V((0, 0.18, 0.05))
            spike(base, V((x * 0.35, -0.55, -1.0)), ln - abs(x) * 0.12, 0.27, "neck" if row == 0 else "chest",
                  bend=V((0, -0.12, 0.0)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = mesh_from_bmesh("Kurama_Fur", bm, COL_KURAMA)
    assign_weights(obj, [{g: 1.0} for g in groups])
    paint(obj, lambda co, n: FUR)
    return obj


def build_claws():
    bm = bmesh.new()
    groups = []
    for s in (1, -1):
        sfx = "_L" if s > 0 else "_R"
        pw = side(L["paw"], s)
        for dx in (-0.33, -0.11, 0.11, 0.33):
            f1 = pw + V((dx * s, -0.35, 0.02)) + V((dx * 0.35 * s, -0.45, -0.1))
            vs = cone(bm, f1 + V((0, 0.06, 0.02)), f1 + V((0, -0.3, -0.12)), 0.075, segs=7, bend=V((0, 0, -0.2)))
            groups += ["paw" + sfx] * len(vs)
        f1 = pw + V((-0.6 * s, -0.3, -0.05))
        vs = cone(bm, f1 + V((0, 0.05, 0.0)), f1 + V((-0.05 * s, -0.25, -0.1)), 0.07, segs=7)
        groups += ["paw" + sfx] * len(vs)
        to = side(L["toe"], s)
        for dx in (-0.22, -0.07, 0.07, 0.22):
            b0 = to + V((dx * s, -0.35, 0.02))
            vs = cone(bm, b0, b0 + V((0, -0.22, -0.1)), 0.06, segs=7)
            groups += ["foot" + sfx] * len(vs)
    obj = mesh_from_bmesh("Kurama_Claws", bm, COL_KURAMA)
    assign_weights(obj, [{g: 1.0} for g in groups])
    paint(obj, lambda co, n: CLAW)
    return obj


# --------------------------------------------------------------------------
# MATERIALS
# --------------------------------------------------------------------------

def make_material(name, color=None, use_vcol=False, emission=None, strength=0.0, rough=0.7):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = rough
    if use_vcol:
        vc = nt.nodes.new("ShaderNodeVertexColor")
        vc.layer_name = "Col"
        nt.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
    elif color:
        bsdf.inputs["Base Color"].default_value = color
    if emission:
        bsdf.inputs["Emission Color"].default_value = emission
        bsdf.inputs["Emission Strength"].default_value = strength
    return m


MATS = dict(
    fur=make_material("KuramaFur", use_vcol=True, rough=0.85),
    eye=make_material("KuramaEye", srgb("#FF3A12"), emission=srgb("#FF2A0A"), strength=2.0, rough=0.25),
    pupil=make_material("KuramaPupil", srgb("#0A0506"), rough=0.3),
    teeth=make_material("KuramaTeeth", TEETH, rough=0.35),
)


# --------------------------------------------------------------------------
# ARMATURE
# --------------------------------------------------------------------------

def build_armature(tail_heads):
    ad = bpy.data.armatures.new("KuramaRig")
    ad.display_type = 'STICK'
    arm = new_object("Kurama", ad, COL_KURAMA)
    arm.show_in_front = True
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = ad.edit_bones

    def bone(name, head, tail, parent=None, deform=True, roll_to=None):
        b = eb.new(name)
        b.head, b.tail = V(head), V(tail)
        if roll_to is not None:
            b.align_roll(V(roll_to))
        if parent:
            b.parent = eb[parent]
        b.use_deform = deform
        return b

    bone("root", (0, 0, 0), (0, 0, 1.2), deform=False)
    bone("hips", L["hips"], L["spine"], "root", roll_to=(0, 0, 1))
    bone("spine", L["spine"], L["chest"], "hips", roll_to=(0, 0, 1))
    bone("chest", L["chest"], L["neck"], "spine", roll_to=(0, -1, 0))
    bone("neck", L["neck"], H, "chest", roll_to=(0, -1, 0))
    bone("head", H, H + V((0, 0, 1.3)), "neck", roll_to=(0, -1, 0))
    bone("jaw", hp(*JAW_PIVOT), hp(0, -2.35, -0.35), "head", roll_to=(0, 0, 1))
    for s in (1, -1):
        sfx = "_L" if s > 0 else "_R"
        ec, fwd, _ = eye_frame(s)
        bone("eye" + sfx, ec, ec + fwd * 0.4, "head", roll_to=(0, 0, 1))
        bone("lid" + sfx, ec, ec + fwd * 0.35, "head", roll_to=(0, 0, 1))
        bone("ear" + sfx, hp(EAR_BASE.x * s, EAR_BASE.y, EAR_BASE.z), hp(EAR_TIP.x * s, EAR_TIP.y, EAR_TIP.z), "head", roll_to=(0, -1, 0))
        bone("upperarm" + sfx, side(L["shoulder"], s), side(L["elbow"], s), "chest", roll_to=(0, -1, 0))
        bone("forearm" + sfx, side(L["elbow"], s), side(L["wrist"], s), "upperarm" + sfx, roll_to=(0, 0, 1))
        bone("paw" + sfx, side(L["wrist"], s), side(L["paw"], s) + V((0, -0.5, 0)), "forearm" + sfx, roll_to=(0, 0, 1))
        bone("thigh" + sfx, side(L["hip_joint"], s), side(L["knee"], s), "hips", roll_to=(0, -1, 0))
        bone("shin" + sfx, side(L["knee"], s), side(L["hock"], s), "thigh" + sfx, roll_to=(0, 0, 1))
        bone("foot" + sfx, side(L["hock"], s), side(L["toe"], s), "shin" + sfx, roll_to=(0, 0, 1))
    for i, heads in enumerate(tail_heads):
        parent = "hips"
        for k in range(TAIL_BONES):
            h0, h1 = heads[k], heads[k + 1]
            bone(f"tail_{i}_{k}", h0, h1, parent, roll_to=(0, 1, 0))
            parent = f"tail_{i}_{k}"
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    return arm


# --------------------------------------------------------------------------
# ANIMATION
# --------------------------------------------------------------------------

class Pose:
    """Accumulates rotations expressed about ARMATURE-space axes, per bone."""

    def __init__(self, arm):
        self.arm = arm
        self.rot = {}
        self.loc = {}

    def r(self, bone, axis, deg):
        if abs(deg) < 1e-6:
            return
        q = Quaternion(V(axis).normalized(), math.radians(deg))
        rest = self.arm.data.bones[bone].matrix_local.to_quaternion()
        local = rest.inverted() @ q @ rest
        self.rot[bone] = self.rot.get(bone, Quaternion()) @ local

    def local(self, bone, axis, deg):
        """Rotation about the bone's own local axis ('X','Y','Z')."""
        if abs(deg) < 1e-6:
            return
        ax = dict(X=(1, 0, 0), Y=(0, 1, 0), Z=(0, 0, 1))[axis]
        self.rot[bone] = self.rot.get(bone, Quaternion()) @ Quaternion(V(ax), math.radians(deg))

    def t(self, bone, offset):
        rest = self.arm.data.bones[bone].matrix_local.to_3x3()
        self.loc[bone] = self.loc.get(bone, V()) + rest.inverted() @ V(offset)


X, Y, Z = (1, 0, 0), (0, 1, 0), (0, 0, 1)
PITCH_DOWN = X        # +deg about +X tips a -Y-facing bone downwards
YAW_LEFT = Z          # +deg about +Z turns the face toward +X (character's left)


def tails_pose(P, t, amp=1.0, speed=1.0, lift=0.0, spread=0.0, lash=0.0, curl=0.0, period=None):
    """Flowing tails: travelling waves with per-tail phase. `period` forces loopable frequencies."""
    for i in range(N_TAILS):
        k = i - 4
        ph = i * 0.83
        for j in range(TAIL_BONES):
            b = f"tail_{i}_{j}"
            w = 2 * math.pi * speed * (1 / period if period else 0.35)
            a = min(amp, 1.6)
            fall = 0.5 + 0.1 * j
            sway = a * (6 + 2.2 * j) * math.sin(w * t - j * 0.7 + ph) * fall
            bob = a * (3.5 + 1.5 * j) * math.sin(w * t * (2 if period else 1.3) - j * 0.6 + ph * 1.7) * 0.6
            lash_a = min(lash, 1.2) * (7 + 3 * j) * math.sin(w * 3 * t - j * 0.9 + ph)
            P.local(b, 'Z', sway + lash_a)
            P.local(b, 'X', bob - lift * (6 if j < 2 else 2) + curl * (6 + 4 * j))
            if j == 0 and spread:
                P.r(b, Y, -spread * k * 2.2)


def breathe(P, t, amt=1.0, period=4.0):
    b = math.sin(2 * math.pi * t / period)
    P.r("spine", X, -0.8 * amt * b)
    P.r("chest", X, -1.2 * amt * b)
    P.r("neck", X, 0.9 * amt * b)
    P.r("head", X, 0.5 * amt * b)
    for s in ("_L", "_R"):
        P.r("upperarm" + s, X, 0.6 * amt * b)
        P.r("forearm" + s, X, -0.6 * amt * b)


def ears(P, back=0.0, flat=0.0, twitch=0.0):
    # back: rotate ears backwards (anger); flat: droop sideways (sad/sleepy)
    P.r("ear_L", X, -back * 30)
    P.r("ear_R", X, -back * 30)
    P.r("ear_L", Y, flat * 30 + twitch)
    P.r("ear_R", Y, -flat * 30)


def lids(P, close=0.0, glare=0.0):
    # close 0..1 blinks the upper lids; glare narrows them into a squint
    for s in ("_L", "_R"):
        P.r("lid" + s, X, 70 * close + 16 * glare)


def keyframe(arm, P, frame):
    for pb in arm.pose.bones:
        q = P.rot.get(pb.name, Quaternion())
        pb.rotation_quaternion = q
        pb.keyframe_insert("rotation_quaternion", frame=frame, group=pb.name)
        if pb.name in P.loc or pb.name in ("root", "hips"):
            pb.location = P.loc.get(pb.name, V())
            pb.keyframe_insert("location", frame=frame, group=pb.name)


def make_action(arm, name, seconds, fn, step=2, loop=True):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data_create()
    arm.animation_data.action = act
    n = int(round(seconds * FPS))
    frames = list(range(0, n + 1, step))
    if frames[-1] != n:
        frames.append(n)
    for f in frames:
        P = Pose(arm)
        tt = (f % n if loop else f) / FPS if loop else f / FPS
        fn(P, tt if not loop or f < n else 0.0, seconds)
        keyframe(arm, P, f + 1)
    act.frame_range = (1, n + 1)
    if loop:
        for fc in act.fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = 'BEZIER'
    # keep in NLA so it survives + exports as its own clip
    track = arm.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, act)
    strip.extrapolation = 'NOTHING'
    track.mute = True
    arm.animation_data.action = None
    return act


def env(t, t0, t1, fade=0.25):
    """Envelope 0->1->0 over [t0, t1] with soft edges."""
    return smoothstep(t0, t0 + fade, t) * (1 - smoothstep(t1 - fade, t1, t))


def build_animations(arm):
    def idle(P, t, d):
        breathe(P, t, 1.0, period=d / 2)
        w = 2 * math.pi / d
        P.r("neck", Z, 3.0 * math.sin(w * t))
        P.r("head", Z, 2.0 * math.sin(w * t + 0.8))
        P.r("head", Y, 1.8 * math.sin(w * t * 2 + 0.3))
        P.r("head", X, 1.5 * math.sin(w * t * 2))
        tw = 10 * env(t, d * 0.55, d * 0.62, 0.08)
        ears(P, back=0.05, twitch=tw)
        tails_pose(P, t, amp=1.0, period=d / 2)

    def talk(P, t, d):
        breathe(P, t, 1.3, period=d / 2)
        w = 2 * math.pi / d
        P.r("neck", X, 2.5 * math.sin(w * t * 2))
        P.r("head", X, 3.5 * math.sin(w * t * 4 + 0.5))
        P.r("head", Z, 4.0 * math.sin(w * t + 1.0))
        P.r("head", Y, 3.0 * math.sin(w * t * 2 + 0.2))
        P.r("chest", Z, 1.5 * math.sin(w * t))
        ears(P, back=0.1 + 0.1 * math.sin(w * t * 2))
        tails_pose(P, t, amp=1.2, period=d / 2)

    def angry(P, t, d):
        breathe(P, t, 1.8, period=d / 2)
        w = 2 * math.pi / d
        P.r("chest", X, 4)
        P.r("neck", X, 8 + 1.5 * math.sin(w * t * 2))
        P.r("head", X, -6)
        P.r("head", Z, 2 * math.sin(w * t))
        ears(P, back=0.9)
        lids(P, glare=1.0)
        P.r("jaw", X, 4 + 2 * math.sin(w * t * 4))
        tails_pose(P, t, amp=1.1, lash=0.8, lift=1.0, period=d)

    def sleep(P, t, d):
        breathe(P, t, 2.2, period=d / 2)
        P.r("chest", X, 6)
        P.r("neck", X, 26)
        P.r("head", X, 14)
        P.r("head", Y, 6)
        P.r("head", Z, -8)
        ears(P, back=0.5, flat=0.35)
        lids(P, close=1.05)
        for s, sg in (("_L", 1), ("_R", -1)):
            P.r("upperarm" + s, X, 6)
        tails_pose(P, t, amp=0.35, lift=4.0, curl=1.2, period=d / 2)

    def laugh(P, t, d):
        e = env(t, 0.1, d - 0.2, 0.3)
        breathe(P, t, 1.0, period=2.0)
        shake = math.sin(2 * math.pi * 4.5 * t)
        P.r("chest", X, (-6 - 2 * shake) * e)
        P.r("neck", X, (-10 - 2 * shake) * e)
        P.r("head", X, (-14 - 3 * shake) * e)
        P.r("head", Y, 6 * e)
        P.r("jaw", X, (16 + 9 * shake) * e)
        lids(P, glare=1.4 * e)
        ears(P, back=0.3 * e)
        tails_pose(P, t, amp=1.4, lash=0.4 * e)

    def roar(P, t, d):
        wind = env(t, 0.0, 0.8, 0.35)
        blast = env(t, 0.6, d - 0.5, 0.25)
        shake = math.sin(2 * math.pi * 11 * t) * blast
        P.r("spine", X, -5 * blast + 3 * wind)
        P.r("chest", X, -10 * blast + 6 * wind)
        P.r("neck", X, 10 * wind - 8 * blast + 1.2 * shake)
        P.r("head", X, 10 * wind - 12 * blast)
        P.r("head", Z, 1.5 * shake)
        P.r("jaw", X, 34 * blast + 4 * wind)
        ears(P, back=1.0 * max(wind, blast))
        lids(P, glare=0.6 * wind - 0.4 * blast)
        tails_pose(P, t, amp=1.0 + 0.5 * blast, lash=0.8 * blast, spread=1.5 * blast, lift=-0.8 * blast)

    def nod(P, t, d):
        breathe(P, t, 1.0, period=2.0)
        e = env(t, 0.05, d - 0.05, 0.2)
        P.r("head", X, 10 * math.sin(2 * math.pi * t / (d / 2)) ** 2 * e)
        P.r("neck", X, 4 * math.sin(2 * math.pi * t / (d / 2)) ** 2 * e)
        tails_pose(P, t, amp=1.0)

    def headshake(P, t, d):
        breathe(P, t, 1.0, period=2.0)
        e = env(t, 0.05, d - 0.05, 0.25)
        P.r("head", Z, 13 * math.sin(2 * math.pi * t * 2.2) * e)
        P.r("neck", Z, 4 * math.sin(2 * math.pi * t * 2.2 - 0.4) * e)
        lids(P, glare=0.5 * e)
        tails_pose(P, t, amp=1.0)

    def lean_in(P, t, d):
        e = env(t, 0.0, d, 0.8)
        breathe(P, t, 1.0, period=2.5)
        P.r("spine", X, 3 * e)
        P.r("chest", X, 8 * e)
        P.r("neck", X, -14 * e)
        P.r("head", X, 8 * e)
        P.t("hips", (0, -0.35 * e, 0))
        lids(P, glare=0.8 * e)
        ears(P, back=-0.2 * e)
        tails_pose(P, t, amp=0.8)

    def look_away(P, t, d):
        e = env(t, 0.0, d, 0.5)
        breathe(P, t, 1.0, period=2.5)
        P.r("neck", Z, -14 * e)
        P.r("head", Z, -20 * e)
        P.r("head", X, -6 * e)
        P.r("head", Y, -6 * e)
        lids(P, close=0.55 * e)
        ears(P, back=0.4 * e)
        tails_pose(P, t, amp=0.8, lash=0.3 * e)

    def tail_lash(P, t, d):
        e = env(t, 0.0, d, 0.3)
        breathe(P, t, 1.2, period=2.0)
        P.r("head", X, 3 * e)
        ears(P, back=0.6 * e)
        lids(P, glare=0.6 * e)
        tails_pose(P, t, amp=1.0 + e, lash=1.4 * e, lift=-1.0 * e)

    def grin(P, t, d):
        e = env(t, 0.0, d, 0.4)
        breathe(P, t, 1.0, period=2.5)
        P.r("head", Y, 10 * e)
        P.r("head", X, 5 * e)
        P.r("neck", X, 4 * e)
        P.r("jaw", X, 7 * e)
        lids(P, glare=1.3 * e)
        ears(P, back=0.2 * e)
        tails_pose(P, t, amp=1.1)

    def sigh(P, t, d):
        up = env(t, 0.0, 1.2, 0.5)
        down = env(t, 1.0, d, 0.6)
        P.r("chest", X, -4 * up + 3 * down)
        P.r("spine", X, -2 * up + 2 * down)
        P.r("neck", X, 8 * down)
        P.r("head", X, 6 * down)
        P.r("jaw", X, 5 * down * (1 - smoothstep(1.4, 2.2, t)))
        lids(P, close=0.45 * down)
        ears(P, back=0.2, flat=0.5 * down)
        tails_pose(P, t, amp=0.6, lift=2.0 * down)

    def wake(P, t, d):
        # from the sleep pose back to idle (one eye first)
        k = smoothstep(0.2, d - 0.3, t)
        s = 1 - k
        breathe(P, t, 1.5, period=2.5)
        P.r("chest", X, 6 * s)
        P.r("neck", X, 26 * s)
        P.r("head", X, 14 * s)
        P.r("head", Y, 6 * s)
        P.r("head", Z, -8 * s)
        ears(P, back=0.5 * s, flat=0.35 * s)
        P.r("lid_L", X, 70 * (1 - smoothstep(0.2, 0.9, t)))
        P.r("lid_R", X, 70 * (1 - smoothstep(0.9, 1.6, t)))
        tails_pose(P, t, amp=0.35 + 0.65 * k, lift=4.0 * s, curl=1.2 * s)

    clips = [
        ("Idle", 8.0, idle, True),
        ("Talk", 4.0, talk, True),
        ("Angry", 4.0, angry, True),
        ("Sleep", 8.0, sleep, True),
        ("Laugh", 2.6, laugh, False),
        ("Roar", 3.2, roar, False),
        ("Nod", 1.4, nod, False),
        ("HeadShake", 1.6, headshake, False),
        ("LeanIn", 3.0, lean_in, False),
        ("LookAway", 3.0, look_away, False),
        ("TailLash", 2.2, tail_lash, False),
        ("Grin", 2.4, grin, False),
        ("Sigh", 2.8, sigh, False),
        ("Wake", 2.2, wake, False),
    ]
    acts = {}
    for name, dur, fn, loop in clips:
        acts[name] = make_action(arm, name, dur, fn, step=2, loop=loop)
    # showcase timeline in the .blend: Idle is active
    arm.animation_data.action = acts["Idle"]
    SCENE.frame_start = 1
    SCENE.frame_end = int(8.0 * FPS) + 1
    return acts


# --------------------------------------------------------------------------
# MINDSCAPE SET (seal cage, water, pipes)
# --------------------------------------------------------------------------

def build_set():
    objs = []
    mats = dict(
        water=make_material("Water", srgb("#0E1A1C"), rough=0.05),
        bars=make_material("CageBars", srgb("#2A2624"), rough=0.6),
        stone=make_material("Stone", srgb("#20262A"), rough=0.9),
        pipe=make_material("Pipe", srgb("#3A4A48"), rough=0.5),
        tag=make_material("SealTag", srgb("#EFE6CF"), rough=0.9),
    )
    GATE_Y = -4.4
    # water floor
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=60)
    o = mesh_from_bmesh("Water", bm, COL_SET, smooth=False)
    o.data.materials.append(mats["water"])
    objs.append(o)

    # cage bars
    bm = bmesh.new()

    def box(center, size):
        r = bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(V(center)) @ Matrix.Diagonal((*size, 1)), verts=r["verts"])

    # the two gate leaves meet in a wide central gap so Kurama's face stays visible;
    # the seal tag hangs on a low cross-bar across that gap
    xs = [s * (2.05 + 1.75 * k) for s in (-1, 1) for k in range(9)]
    for x in xs:
        box((x, GATE_Y, 9.0), (0.46, 0.6, 18.0))
    box((0, GATE_Y - 0.05, 17.5), (34.0, 0.9, 1.2))          # lintel
    box((0, GATE_Y - 0.05, 0.25), (34.0, 0.9, 0.5))          # sill
    for z in (2.9, 13.2):                                     # cross-bars
        box((0, GATE_Y - 0.02, z), (34.0, 0.42, 0.34))
    box((0, GATE_Y - 0.1, 2.9), (1.0, 0.62, 0.9))             # lock plate the tag is pasted on
    o = mesh_from_bmesh("CageBars", bm, COL_SET, smooth=False)
    o.data.materials.append(mats["bars"])
    objs.append(o)

    # paper seal tag (封) — UV mapped plane, the web app draws the kanji
    bm = bmesh.new()
    r = bmesh.ops.create_grid(bm, x_segments=1, y_segments=6, size=1.0)
    uv = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        for lp in f.loops:
            lp[uv].uv = ((lp.vert.co.x + 1) / 2, (lp.vert.co.y + 1) / 2)
    for v in bm.verts:
        x, y = v.co.x, v.co.y
        v.co = V((x * 0.36, GATE_Y - 0.46 - 0.05 * math.sin((1 - y) * 1.6), 2.35 + y * 1.05))
    o = mesh_from_bmesh("SealTag", bm, COL_SET, smooth=False)
    o.data.materials.append(mats["tag"])
    objs.append(o)

    # corridor walls + ceiling in front of the cage
    bm = bmesh.new()
    box((-16.5, -14, 9), (1.0, 20, 18))
    box((16.5, -14, 9), (1.0, 20, 18))
    box((0, -14, 18.5), (34, 20, 1.0))
    box((0, 8, 9), (34, 1.0, 18))            # dark back wall inside the cage
    o = mesh_from_bmesh("Walls", bm, COL_SET, smooth=False)
    o.data.materials.append(mats["stone"])
    objs.append(o)

    # pipes along the walls and ceiling
    bm = bmesh.new()

    def pipe(a, b_, r):
        a, b_ = V(a), V(b_)
        d = b_ - a
        res = bmesh.ops.create_cone(bm, cap_ends=True, segments=14, radius1=r, radius2=r, depth=d.length)
        q = V((0, 0, 1)).rotation_difference(d.normalized())
        bmesh.ops.transform(bm, matrix=Matrix.Translation((a + b_) / 2) @ q.to_matrix().to_4x4(), verts=res["verts"])

    for sx in (-1, 1):
        for z, r in ((3.0, 0.45), (4.4, 0.3), (12.5, 0.6)):
            pipe((15.6 * sx, -24, z), (15.6 * sx, GATE_Y - 0.6, z), r)
        for y in (-20, -13, -7):
            pipe((15.6 * sx, y, 0), (15.6 * sx, y, 17.8), 0.25)
    for x in (-9, -3.5, 4, 10):
        pipe((x, -24, 17.4), (x, GATE_Y - 0.6, 17.4), 0.4)
    o = mesh_from_bmesh("Pipes", bm, COL_SET)
    o.data.materials.append(mats["pipe"])
    objs.append(o)
    return objs


# --------------------------------------------------------------------------
# BUILD
# --------------------------------------------------------------------------

def main():
    print("[kurama] building meshes…")
    body = build_body()
    jaw = build_jaw()
    jaw_profile = JawProfile(jaw)
    head = build_head(jaw_profile)
    tongue = build_tongue()
    teeth = build_teeth(jaw_profile)
    eyes = build_eyes()
    nose = build_nose()
    ear = build_ears()
    tails, tail_heads = build_tails()
    fur = build_spikes()
    claws = build_claws()

    fur_meshes = [body, head, jaw, tongue, nose, ear, tails, fur, claws] + [o for o in eyes if o.name == "Kurama_Lids"]
    for o in fur_meshes:
        o.data.materials.append(MATS["fur"])
    for o in teeth:
        o.data.materials.append(MATS["teeth"])

    print("[kurama] rigging…")
    arm = build_armature(tail_heads)
    for o in fur_meshes + teeth + [e for e in eyes if e.name != "Kurama_Lids"]:
        o.parent = arm
        mod = o.modifiers.new("Armature", 'ARMATURE')
        mod.object = arm

    print("[kurama] animating…")
    build_animations(arm)

    print("[kurama] set dressing…")
    set_objs = build_set()

    # camera + lights for the .blend
    cam = bpy.data.cameras.new("Cam")
    cam.lens = 38
    camo = new_object("Camera", cam, SCENE.collection)
    camo.location = V((2.8, -15.5, 3.2))
    camo.rotation_euler = (math.radians(84), 0, math.radians(8))
    SCENE.camera = camo
    for name, loc, energy, color in (("Key", (6, -9, 12), 3500, (1.0, 0.85, 0.7)),
                                     ("Rim", (-6, 8, 10), 2500, (1.0, 0.35, 0.1)),
                                     ("Fill", (-8, -12, 4), 900, (0.5, 0.75, 0.8))):
        ld = bpy.data.lights.new(name, 'AREA')
        ld.energy = energy
        ld.size = 6
        ld.color = color
        lo = new_object(name, ld, SCENE.collection)
        lo.location = V(loc)
        lo.rotation_euler = (V(loc) * -1).to_track_quat('-Z', 'Y').to_euler()
    world = bpy.data.worlds.new("Mindscape")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = srgb("#0A1012")
    SCENE.world = world

    stats = sum(len(o.data.polygons) for o in fur_meshes + teeth + eyes)
    print(f"[kurama] character faces: {stats}")

    if not ARGS.no_export:
        os.makedirs(ARGS.out, exist_ok=True)
        export(arm, os.path.join(ARGS.out, "kurama.glb"), animations=True)
        export_objs(set_objs, os.path.join(ARGS.out, "mindscape.glb"))
    if ARGS.blend:
        bpy.context.preferences.filepaths.save_version = 0      # no .blend1 backups
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(ARGS.blend), compress=True)
        print("[kurama] saved", ARGS.blend)


def select_only(objs):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]


def export(arm, path, animations=True):
    objs = [arm] + [o for o in arm.children]
    select_only(objs)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True,
        export_animations=animations, export_animation_mode='ACTIONS',
        export_frame_step=1, export_force_sampling=True,
        export_optimize_animation_size=True, export_def_bones=False,
        export_vertex_color='ACTIVE', export_all_vertex_colors=False,
        export_yup=True, export_apply=False, export_skins=True,
        export_morph=False, export_reset_pose_bones=True,
        export_extras=False, export_leaf_bone=False,
    )
    print("[kurama] exported", path, os.path.getsize(path) // 1024, "KB")


def export_objs(objs, path):
    select_only(objs)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True,
        export_animations=False, export_yup=True, export_apply=True,
        export_vertex_color='NONE', export_texcoords=True,
    )
    print("[kurama] exported", path, os.path.getsize(path) // 1024, "KB")


main()
