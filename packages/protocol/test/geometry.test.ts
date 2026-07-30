import { describe, it, expect } from "vitest";
import { intersects } from "../src/geometry";

describe("intersects", () => {
  const viewport = { x: 0, y: 0, width: 1920, height: 1080 };

  it("is true when a rect is fully inside the other", () => {
    expect(intersects({ x: 100, y: 100, width: 50, height: 50 }, viewport)).toBe(true);
  });

  it("is true for a partial overlap across an edge", () => {
    expect(intersects({ x: -10, y: -10, width: 50, height: 50 }, viewport)).toBe(true);
  });

  it("is false when fully outside on every axis", () => {
    expect(intersects({ x: 5000, y: 5000, width: 50, height: 50 }, viewport)).toBe(false);
  });

  it("is false when merely touching (edges flush, no actual overlap)", () => {
    // a's left edge sits exactly on viewport's right edge -- strict
    // inequalities in intersects() mean edge-touching does not count.
    expect(intersects({ x: 1920, y: 0, width: 100, height: 100 }, viewport)).toBe(false);
  });

  it("is false when one rect is entirely to the left/above the other", () => {
    expect(intersects({ x: -200, y: -200, width: 100, height: 100 }, viewport)).toBe(false);
  });

  it("is symmetric", () => {
    const a = { x: 10, y: 10, width: 100, height: 100 };
    const b = { x: 50, y: 50, width: 100, height: 100 };
    expect(intersects(a, b)).toBe(intersects(b, a));
  });
});
