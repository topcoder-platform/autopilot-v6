import { Module } from '@nestjs/common';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

/** Exports shared-core authentication for manual controls; no local password login or token issuance. */
@Module({ providers: [JwtAuthGuard], exports: [JwtAuthGuard] })
export class AuthModule {}
