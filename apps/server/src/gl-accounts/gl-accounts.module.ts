import { Module } from '@nestjs/common';
import { GlAccountsController } from './gl-accounts.controller.js';
import { GlAccountsService } from './gl-accounts.service.js';

@Module({
  controllers: [GlAccountsController],
  providers: [GlAccountsService],
  exports: [GlAccountsService],
})
export class GlAccountsModule {}
