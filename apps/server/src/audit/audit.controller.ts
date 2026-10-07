import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { AuditService } from '../common/audit.service.js';
import { notFound } from '../common/errors.js';
import { serialize } from '../common/serialize.js';

@Controller('audit')
@UseGuards(AuthGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('entries')
  async listEntries(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('action') action?: string,
    @Query('subjectType') subjectType?: string,
  ) {
    const result = await this.audit.list({
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      action,
      subjectType,
    });
    return serialize(result);
  }

  @Get('entries/:sequence')
  async getEntry(@Param('sequence') sequence: string) {
    const row = await this.audit.getBySequence(BigInt(sequence));
    if (!row) {
      throw notFound('Audit entry', sequence);
    }
    return serialize(row);
  }

  @Post('verify')
  async verify(
    @Body()
    body: { startSequence?: number | string; limit?: number },
  ) {
    const start =
      body.startSequence != null ? BigInt(body.startSequence) : 1n;
    const limit = body.limit ?? 500;
    const result = await this.audit.verify(start, limit);
    return serialize(result);
  }
}
