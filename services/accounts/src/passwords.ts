import { scrypt, randomBytes, timingSafeEqual } from "crypto";

const KEY_LENGTH = 64;

// Node's built-in scrypt — deliberately avoids pulling in bcrypt/argon2 (both
// need native bindings that complicate Lambda bundling) for this "extremely
// lightweight" account system.
export function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (err, derivedKey) => {
      if (err) reject(err);
      else resolve({ hash: derivedKey.toString("hex"), salt });
    });
  });
}

export function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(timingSafeEqual(Buffer.from(expectedHash, "hex"), derivedKey));
    });
  });
}
