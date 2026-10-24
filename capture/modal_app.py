"""Optional Modal GPU worker: walk-through video → Gaussian splat (.ply).

Not imported by the server. Deploy once (needs `pip install modal` + `modal token new`):

    modal deploy capture/modal_app.py

capture/splat_job.py then calls it via modal.Function.from_name("sitetwin-splat", "train_splat") whenever
MODAL_TOKEN_ID / MODAL_TOKEN_SECRET are set and `modal` is importable. Pipeline: ffmpeg (2 fps, ≤ 200 frames)
→ COLMAP (sequential matcher, OPENCV camera) → gsplat simple_trainer (7k steps) → export .ply.
Typical runtime on an A10G/L4: 6–12 min for a 60 s clip.
"""

from __future__ import annotations

import modal

app = modal.App("sitetwin-splat")

image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.11")
    .apt_install("ffmpeg", "colmap", "git", "libgl1", "libglib2.0-0")
    .pip_install("torch==2.4.1", "torchvision==0.19.1", "numpy<2", "plyfile", "tqdm", "imageio", "opencv-python-headless",
                 "tyro", "tensorboard", "scikit-learn", "pycolmap")
    .run_commands(
        "pip install git+https://github.com/nerfstudio-project/gsplat.git@v1.4.0",
        "git clone --depth 1 --branch v1.4.0 https://github.com/nerfstudio-project/gsplat.git /gsplat",
        "pip install -r /gsplat/examples/requirements.txt || true",
    )
)


@app.function(image=image, gpu="L4", timeout=60 * 30)
def train_splat(video: bytes, steps: int = 7000) -> bytes:
    import glob
    import os
    import subprocess
    import tempfile

    work = tempfile.mkdtemp()
    video_path = os.path.join(work, "input.mp4")
    images = os.path.join(work, "images")
    os.makedirs(images)
    with open(video_path, "wb") as handle:
        handle.write(video)

    def run(*command: str) -> None:
        subprocess.run(command, check=True, cwd=work)

    run("ffmpeg", "-i", video_path, "-vf", "fps=2,scale=1280:-2", "-frames:v", "200", os.path.join(images, "%04d.jpg"))
    database = os.path.join(work, "database.db")
    run("colmap", "feature_extractor", "--database_path", database, "--image_path", images,
        "--ImageReader.camera_model", "OPENCV", "--ImageReader.single_camera", "1", "--SiftExtraction.use_gpu", "0")
    run("colmap", "sequential_matcher", "--database_path", database, "--SiftMatching.use_gpu", "0")
    sparse = os.path.join(work, "sparse")
    os.makedirs(sparse)
    run("colmap", "mapper", "--database_path", database, "--image_path", images, "--output_path", sparse)
    result = os.path.join(work, "result")
    run("python", "/gsplat/examples/simple_trainer.py", "default", "--data_dir", work, "--data_factor", "1",
        "--result_dir", result, "--max_steps", str(steps), "--save_ply", "--ply_steps", str(steps), "--disable_viewer")
    plys = sorted(glob.glob(os.path.join(result, "**", "*.ply"), recursive=True))
    if not plys:
        raise RuntimeError("gsplat produced no .ply")
    with open(plys[-1], "rb") as handle:
        return handle.read()
