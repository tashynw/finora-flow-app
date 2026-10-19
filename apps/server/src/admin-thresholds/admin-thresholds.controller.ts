import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  AuthGuard,
  Roles,
  Session,
  type UserSession,
} from '@thallesp/nestjs-better-auth';
import { parseBoolQuery } from '../common/query.js';
import { AdminThresholdsService } from './admin-thresholds.service.js';

@Controller('admin/thresholds')
@UseGuards(AuthGuard)
@Roles(['administrator'])
export class AdminThresholdsController {
  constructor(private readonly adminThresholdsService: AdminThresholdsService) {}

  @Get()
  list(@Query('include_inactive') includeInactive?: string) {
    return this.adminThresholdsService.list(parseBoolQuery(includeInactive, true));
  }

  @Put()
  upsert(
    @Body()
    body: { currency: string; applies_above_minor_units: number; reason: string },
    @Session() session: UserSession,
  ) {
    return this.adminThresholdsService.upsert(body, session);
  }

  @Post(':id/active')
  setActive(
    @Param('id') id: string,
    @Body() body: { is_active: boolean; reason: string },
    @Session() session: UserSession,
  ) {
    return this.adminThresholdsService.setActive(id, body, session);
  }
}
