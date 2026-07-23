export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// World-space bounding-box intersection — the sole trigger for an asset
// becoming visible in the browser source (see plan: static viewport
// rectangle, assets sit above it, visibility = geometric overlap).
export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
