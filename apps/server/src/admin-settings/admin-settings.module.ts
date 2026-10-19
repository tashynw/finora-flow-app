import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module.js';
import { AdminSettingsController } from './admin-settings.controller.js';
import { AdminSettingsService } from './admin-settings.service.js';

@Module({
  imports: [CommonModule],
  controllers: [AdminSettingsController],
  providers: [AdminSettingsService],
})
export class AdminSettingsModule {}
