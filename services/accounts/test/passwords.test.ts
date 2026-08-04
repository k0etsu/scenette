import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../src/passwords";

describe("passwords", () => {
  it("verifies a correct password against its own hash/salt", async () => {
    const { hash, salt } = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("correct horse battery staple", salt, hash)).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const { hash, salt } = await hashPassword("the-real-one");
    await expect(verifyPassword("not-it", salt, hash)).resolves.toBe(false);
  });

  it("returns false (not throw) for a malformed/short stored hash", async () => {
    // A corrupt row must fail cleanly -- timingSafeEqual throws on
    // unequal-length buffers, which would otherwise surface as a 500.
    await expect(verifyPassword("anything", "somesalt", "deadbeef")).resolves.toBe(false);
  });
});
