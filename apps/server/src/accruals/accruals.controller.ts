import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, Session, type UserSession } from '@thallesp/nestjs-better-auth';
import type { Response } from 'express';
import { serialize } from '../common/serialize.js';
import { AccrualsService } from './accruals.service.js';

@Controller('accruals')
@UseGuards(AuthGuard)
export class AccrualsController {
  constructor(private readonly service: AccrualsService) {}

  @Get('periods')
  async listPeriods(@Query('standing') standing?: string) {
    return serialize(await this.service.listPeriods(standing));
  }

  @Post('periods')
  @HttpCode(HttpStatus.CREATED)
  async createPeriod(
    @Session() session: UserSession,
    @Body()
    body: {
      periodStart?: string;
      periodEnd?: string;
      period_start?: string;
      period_end?: string;
      label: string;
    },
  ) {
    return serialize(await this.service.createPeriod(session, body));
  }

  @Get('periods/:id')
  async getPeriod(
    @Session() session: UserSession,
    @Param('id') id: string,
  ) {
    return serialize(await this.service.getPeriod(id, session));
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
      amountMinorUnits?: string | number | null;
      amount_minor?: string | number | null;
      exclude?: boolean;
      note?: string | null;
      editReason?: string;
      reason?: string;
      description?: string | null;
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
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportPeriod(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { format?: string; official?: boolean },
    @Res() res: Response,
  ) {
    const result = await this.service.exportPeriod(session, id, {
      format: body.format ?? 'csv',
      official: body.official,
    });
    res.setHeader('X-Finora-Export-Filename', result.filename);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`,
    );
    res.setHeader('X-Finora-Export-Sha256', result.sha256);
    res.send(result.csv);
  }
}
