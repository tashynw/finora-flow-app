import { Module } from '@nestjs/common';
import { AdminApprovalsModule } from './admin-approvals/admin-approvals.module.js';
import { AdminSettingsModule } from './admin-settings/admin-settings.module.js';
import { AdminThresholdsModule } from './admin-thresholds/admin-thresholds.module.js';
import { AdminUsersModule } from './admin-users/admin-users.module.js';

@Module({
  imports: [
    AdminUsersModule,
    AdminApprovalsModule,
    AdminThresholdsModule,
    AdminSettingsModule,
  ],
})
export class AdminModule {}
