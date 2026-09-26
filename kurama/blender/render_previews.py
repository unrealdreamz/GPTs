"""
Render turntable-style preview stills of the built Kurama .blend (Cycles, CPU).

    python render_previews.py --blend kurama.blend --out previews/ [--action Idle --frame 40] [--views front,three_quarter,side,face]
    blender --background --python render_previews.py -- --blend kurama.blend --out previews/
"""

import argparse
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
ap = argparse.ArgumentParser()
ap.add_argument("--blend", default="kurama.blend")
ap.add_argument("--out", default="previews")
ap.add_argument("--action", default="Idle")
ap.add_argument("--frame", type=int, default=1)
ap.add_argument("--views", default="front,three_quarter,side,face,back")
ap.add_argument("--samples", type=int, default=24)
ap.add_argument("--res", default="640x480")
ap.add_argument("--hide-set", action="store_true", help="hide the cage/walls")
args = ap.parse_args(argv)

bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.blend))
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = args.samples
scene.cycles.use_denoising = True
w, h = (int(x) for x in args.res.split("x"))
scene.render.resolution_x, scene.render.resolution_y = w, h
scene.render.film_transparent = False
scene.view_settings.view_transform = 'AgX'

arm = bpy.data.objects["Kurama"]
arm.animation_data.action = bpy.data.actions[args.action]
for t in arm.animation_data.nla_tracks:
    t.mute = True
scene.frame_set(args.frame)

if args.hide_set:
    for o in bpy.data.collections["Mindscape"].objects:
        o.hide_render = True
else:
    for name in ("Walls",):
        if name in bpy.data.objects:
            bpy.data.objects[name].hide_render = True

cam = scene.camera
VIEWS = {
    "front": ((0.0, -16.0, 4.6), (0, -1.0, 3.6), 40),
    "three_quarter": ((9.5, -12.5, 5.5), (0, 0.2, 3.4), 36),
    "side": ((16.0, -0.5, 4.0), (0, 0.8, 3.4), 34),
    "face": ((1.6, -11.5, 5.6), (0, -2.0, 4.5), 55),
    "face_low": ((0.0, -13.0, 2.4), (0, -1.8, 4.6), 50),
    "mouth": ((2.2, -8.5, 4.4), (0, -2.6, 4.1), 70),
    "back": ((-9.0, 14.0, 7.5), (0, 2.0, 4.5), 30),
    "top": ((0.0, -2.0, 22.0), (0, 1.0, 2.0), 30),
}
os.makedirs(args.out, exist_ok=True)
for name in args.views.split(","):
    loc, target, lens = VIEWS[name]
    cam.location = Vector(loc)
    cam.data.lens = lens
    d = Vector(target) - Vector(loc)
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = os.path.join(os.path.abspath(args.out), f"{args.action}_{args.frame:03d}_{name}.png")
    bpy.ops.render.render(write_still=True)
    print("wrote", scene.render.filepath)
