import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  AuthGuard,
  Roles,
  Session,
  type UserSession,
} from '@thallesp/nestjs-better-auth';
import { parseBoolQuery } from '../common/query.js';
import { AdminSettingsService } from './admin-settings.service.js';

@Controller('admin/settings')
@UseGuards(AuthGuard)
@Roles(['administrator'])
export class AdminSettingsController {
  constructor(private readonly adminSettingsService: AdminSettingsService) {}

  @Get('operational')
  getOperational() {
    return this.adminSettingsService.getOperationalSnapshot();
  }

  @Post('operational/ai-kill-switch')
  setAiKillSwitch(
    @Body() body: { engaged: boolean; reason: string },
    @Session() session: UserSession,
  ) {
    return this.adminSettingsService.setAiKillSwitch(body, session);
  }

  @Get('retention')
  listRetention(@Query('include_inactive') includeInactive?: string) {
    return this.adminSettingsService.listRetention(parseBoolQuery(includeInactive, true));
  }

  @Post('retention/:key/active')
  setRetentionActive(
    @Param('key') key: string,
    @Body() body: { is_active: boolean; reason: string },
    @Session() session: UserSession,
  ) {
    return this.adminSettingsService.setRetentionActive(key, body, session);
  }

  @Patch('retention/:key')
  patchRetention(
    @Param('key') key: string,
    @Body() body: { retention_days: number; reason: string },
    @Session() session: UserSession,
  ) {
    return this.adminSettingsService.patchRetention(key, body, session);
  }
}
