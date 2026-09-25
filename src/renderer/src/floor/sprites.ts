// Procedural pixel-art avatars, pre-rendered once per (look, pose, frame) into
// small offscreen canvases. Drawing an avatar per frame is then a single
// drawImage — cheap even with dozens of agents.

import type { AvatarLook } from '../../../core/types';

export const SPRITE_W = 16;
export const SPRITE_H = 24;
export type Pose = 'front' | 'back' | 'walk1' | 'walk2' | 'type1' | 'type2';

const cache = new Map<string, HTMLCanvasElement>();

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c + amt * 255)));
  const r = f(n >> 16), g = f((n >> 8) & 255), b = f(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

export function sprite(look: AvatarLook, pose: Pose): HTMLCanvasElement {
  const key = `${look.shirt}${look.hair}${look.skin}${pose}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = SPRITE_W;
  c.height = SPRITE_H;
  const g = c.getContext('2d')!;
  const px = (x: number, y: number, w: number, h: number, col: string) => {
    g.fillStyle = col;
    g.fillRect(x, y, w, h);
  };
  const back = pose === 'back' || pose === 'type1' || pose === 'type2';
  const pants = '#2d3142';
  const shoe = '#1b1b22';
  const shirtD = shade(look.shirt, -0.12);
  const hairD = shade(look.hair, -0.1);
  const skinD = shade(look.skin, -0.1);

  // legs
  const l1 = pose === 'walk1' ? -1 : 0;
  const l2 = pose === 'walk2' ? -1 : 0;
  px(5, 17 + l1, 2, 5, pants);
  px(9, 17 + l2, 2, 5, pants);
  px(5, 21 + l1, 2, 1, shoe);
  px(9, 21 + l2, 2, 1, shoe);
  // torso
  px(4, 11, 8, 7, look.shirt);
  px(4, 16, 8, 2, shirtD);
  if (!back) px(7, 11, 2, 2, shade(look.shirt, 0.18)); // collar
  // arms
  const armY = pose === 'type1' ? 11 : pose === 'type2' ? 12 : 12;
  px(2, armY, 2, 5, shirtD);
  px(12, armY, 2, 5, shirtD);
  px(2, armY + 5, 2, 1, look.skin);
  px(12, armY + 5, 2, 1, look.skin);
  // head
  px(4, 3, 8, 8, look.skin);
  px(4, 10, 8, 1, skinD);
  if (back) {
    px(4, 2, 8, 7, look.hair);
    px(3, 3, 1, 5, hairD);
    px(12, 3, 1, 5, hairD);
    px(5, 9, 6, 1, hairD);
  } else {
    px(4, 2, 8, 3, look.hair);
    px(3, 3, 1, 4, hairD);
    px(12, 3, 1, 4, hairD);
    px(4, 5, 1, 2, look.hair);
    px(11, 5, 1, 2, look.hair);
    px(6, 6, 1, 2, '#1d1d24'); // eyes
    px(9, 6, 1, 2, '#1d1d24');
    px(7, 9, 2, 1, skinD); // mouth
  }
  cache.set(key, c);
  return c;
}
