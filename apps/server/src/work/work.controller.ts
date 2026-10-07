import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { serialize } from '../common/serialize.js';
import { WorkService } from './work.service.js';

@Controller('work')
@UseGuards(AuthGuard)
export class WorkController {
  constructor(private readonly service: WorkService) {}

  @Get('queue')
  async queue(@Query('limit') limit?: string) {
    const take = limit ? Math.min(Number(limit), 100) : 25;
    return serialize(await this.service.queue(take));
  }

  @Get('badges')
  async badges() {
    return serialize(await this.service.badges());
  }

  @Get('dashboard')
  async dashboard(@Query('top') top?: string) {
    const topN = top ? Math.min(Number(top), 50) : 10;
    return serialize(await this.service.dashboard(topN));
  }
}
