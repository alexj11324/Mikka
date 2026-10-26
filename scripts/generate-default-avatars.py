#!/usr/bin/env python3
"""Draws the default person avatars in public/avatars: a soft colored ball on a pale ground.

Run with `python3 scripts/generate-default-avatars.py` (needs numpy and Pillow). The palettes
follow the five hues people expect from a default avatar; the art is generated here.
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

SIZE = 256
# ground (corner), glow (top), ball start (top-left), ball end (bottom-right)
PALETTES = {
    'blue':   ('#9dd2e4', '#c6e1f4', '#6bc8e9', '#6968f2'),
    'green':  ('#9ce5b7', '#c8f5d4', '#66e0a7', '#2f8dcd'),
    'purple': ('#d59de6', '#e0c6f5', '#9c66de', '#c72f78'),
    'orange': ('#e4c09c', '#f5e1c6', '#e9bb66', '#f36f2f'),
    'red':    ('#e49c9d', '#f4c8c5', '#e98b67', '#f44532'),
}


def rgb(value: str) -> np.ndarray:
    return np.array([int(value[i:i + 2], 16) for i in (1, 3, 5)], dtype=float)


def draw(ground: str, glow: str, start: str, end: str) -> Image.Image:
    y, x = np.mgrid[0:SIZE, 0:SIZE] / (SIZE - 1)
    # Pale ground, lightest just above the middle.
    light = np.clip(1 - np.hypot(x - 0.5, (y - 0.3) * 1.2) / 0.75, 0, 1)[..., None]
    image = rgb(ground) * (1 - light) + rgb(glow) * light
    # The ball: a diagonal blend from start to end, centered a little low and right.
    blend = np.clip((x + y - 0.85) / 0.6, 0, 1)[..., None]
    ball = rgb(start) * (1 - blend) + rgb(end) * blend
    mask = Image.fromarray((np.hypot(x - 0.55, y - 0.62) < 0.33).astype(np.uint8) * 255)
    mask = mask.filter(ImageFilter.GaussianBlur(SIZE * 0.07))
    alpha = np.asarray(mask, dtype=float)[..., None] / 255
    image = image * (1 - alpha) + ball * alpha
    return Image.fromarray(np.clip(image, 0, 255).astype(np.uint8))


if __name__ == '__main__':
    out = Path(__file__).resolve().parent.parent / 'public' / 'avatars'
    out.mkdir(parents=True, exist_ok=True)
    for name, palette in PALETTES.items():
        draw(*palette).save(out / f'{name}.webp', quality=88, method=6)
