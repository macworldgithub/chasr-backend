// src/credential-vault/vault.service.ts
import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm' as const;

/**
 * CredentialVaultService — AES-256-GCM symmetric encryption.
 *
 * ALL tokens and secrets stored in MongoDB MUST pass through this service.
 * Never store plaintext credentials. Never log decrypted values.
 *
 * Ciphertext format (colon-delimited hex strings):
 *   <iv_hex>:<authTag_hex>:<ciphertext_hex>
 *
 * Key material: VAULT_ENCRYPTION_KEY env var (64-char hex = 32 bytes).
 * Generate: openssl rand -hex 32
 */
@Injectable()
export class VaultService {
  private readonly encryptionKey: Buffer;

  constructor() {
    const keyHex = process.env.VAULT_ENCRYPTION_KEY;
    if (!keyHex || keyHex.length !== 64) {
      throw new Error(
        'VAULT_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
          'Generate with: openssl rand -hex 32',
      );
    }
    this.encryptionKey = Buffer.from(keyHex, 'hex');
  }

  /**
   * Encrypt a plaintext string.
   * Each call uses a fresh random IV — same plaintext never produces same ciphertext.
   */
  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]); 
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /**
   * Decrypt a ciphertext string produced by `encrypt()`.
   * Throws if the authTag verification fails (tampered data).
   */
  decrypt(ciphertext: string | undefined | null): string {
    if (!ciphertext || typeof ciphertext !== 'string') {
      throw new Error('Missing encrypted credential value');
    }

    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
      throw new Error(
        'Invalid ciphertext format — expected iv:authTag:ciphertext',
      );
    }
    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8');
  }
}
