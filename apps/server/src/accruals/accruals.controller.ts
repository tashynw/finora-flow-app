import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { serialize } from '../common/serialize.js';
import { AccrualsService } from './accruals.service.js';

@Controller('accruals')
@UseGuards(AuthGuard)
export class AccrualsController {
  constructor(private readonly service: AccrualsService) {}

  @Get('periods')
  async listPeriods() {
    return serialize(await this.service.listPeriods());
  }

  @Post('periods')
  @HttpCode(HttpStatus.CREATED)
  async createPeriod(
    @Session() session: UserSession,
    @Body()
    body: { periodStart: string; periodEnd: string; label: string },
  ) {
    return serialize(await this.service.createPeriod(session, body));
  }

  @Get('periods/:id')
  async getPeriod(@Param('id') id: string) {
    return serialize(await this.service.getPeriod(id));
  }

  @Post('periods/:id/candidates/generate')
  async generateCandidates(
    @Session() session: UserSession,
    @Param('id') id: string,
  ) {
    return serialize(await this.service.generateCandidates(session, id));
  }

  @Patch('candidates/:id')
  async patchCandidate(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body()
    body: {
      amountMinorUnits?: string | number;
      exclude?: boolean;
      note?: string | null;
      editReason?: string;
    },
  ) {
    return serialize(await this.service.patchCandidate(session, id, body));
  }

  @Post('candidates/:id/finalize')
  async finalizeCandidate(
    @Session() session: UserSession,
    @Param('id') id: string,
  ) {
    return serialize(await this.service.finalizeCandidate(session, id));
  }

  @Post('periods/:id/lock')
  async lockPeriod(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return serialize(await this.service.lockPeriod(session, id, body));
  }

  @Post('periods/:id/export')
  async exportPeriod(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { format: string; official?: boolean },
  ) {
    return serialize(await this.service.exportPeriod(session, id, body));
  }
}
