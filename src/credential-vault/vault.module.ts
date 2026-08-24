// src/credential-vault/vault.module.ts
import { Global, Module } from '@nestjs/common';
import { VaultService } from './vault.service';

@Global() // Available everywhere without re-importing
@Module({
  providers: [VaultService],
  exports: [VaultService],
})
export class VaultModule {}
