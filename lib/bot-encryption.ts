import crypto from "crypto"

const ENCRYPTION_KEY = process.env.BOT_ENCRYPTION_KEY
const ALGORITHM = "aes-256-gcm"
const IV_LENGTH = 16
const SALT_LENGTH = 64
const TAG_LENGTH = 16
const TAG_POSITION = SALT_LENGTH + IV_LENGTH
const ENCRYPTED_POSITION = TAG_POSITION + TAG_LENGTH

/**
 * Encrypts a private key using AES-256-GCM
 * @param text - Private key to encrypt
 * @returns Encrypted string (hex encoded)
 */
export function encryptPrivateKey(text: string): string {
  if (!ENCRYPTION_KEY) {
    throw new Error("BOT_ENCRYPTION_KEY environment variable is not set")
  }

  const iv = crypto.randomBytes(IV_LENGTH)
  const salt = crypto.randomBytes(SALT_LENGTH)

  // Derive key from encryption key and salt
  const key = crypto.pbkdf2Sync(ENCRYPTION_KEY, salt, 100000, 32, "sha512")

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)

  let encrypted = cipher.update(text, "utf8", "hex")
  encrypted += cipher.final("hex")

  const tag = cipher.getAuthTag()

  // Combine: salt + iv + tag + encrypted
  return salt.toString("hex") + iv.toString("hex") + tag.toString("hex") + encrypted
}

/**
 * Decrypts an encrypted private key
 * @param encryptedData - Encrypted string (hex encoded)
 * @returns Decrypted private key
 */
export function decryptPrivateKey(encryptedData: string): string {
  if (!ENCRYPTION_KEY) {
    throw new Error("BOT_ENCRYPTION_KEY environment variable is not set")
  }

  const salt = Buffer.from(encryptedData.substring(0, SALT_LENGTH * 2), "hex")
  const iv = Buffer.from(
    encryptedData.substring(SALT_LENGTH * 2, TAG_POSITION * 2),
    "hex"
  )
  const tag = Buffer.from(
    encryptedData.substring(TAG_POSITION * 2, ENCRYPTED_POSITION * 2),
    "hex"
  )
  const encrypted = encryptedData.substring(ENCRYPTED_POSITION * 2)

  // Derive key from encryption key and salt
  const key = crypto.pbkdf2Sync(ENCRYPTION_KEY, salt, 100000, 32, "sha512")

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)

  let decrypted = decipher.update(encrypted, "hex", "utf8")
  decrypted += decipher.final("utf8")

  return decrypted
}

