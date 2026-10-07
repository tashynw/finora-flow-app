import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { serialize } from '../common/serialize.js';
import { OverviewService } from './overview.service.js';

@Controller('overview')
@UseGuards(AuthGuard)
export class OverviewController {
  constructor(private readonly service: OverviewService) {}

  @Get('metrics')
  async metrics(@Query('months') months?: string) {
    const n = months ? Number(months) : 6;
    return serialize(await this.service.metrics(Number.isFinite(n) ? n : 6));
  }
}
