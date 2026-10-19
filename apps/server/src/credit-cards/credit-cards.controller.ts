import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard, Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { DomainException } from '../common/errors.js';
import { serialize } from '../common/serialize.js';
import { CreditCardsService } from './credit-cards.service.js';
import { decodeStatement } from './statement-csv.js';

@Controller('credit-cards')
@UseGuards(AuthGuard)
export class CreditCardsController {
  constructor(private readonly service: CreditCardsService) {}

  @Get('cards')
  async listCards(@Query('activeOnly') activeOnly?: string) {
    const active =
      activeOnly === undefined || activeOnly === '' || activeOnly === 'true';
    return serialize(await this.service.listCards(active));
  }

  @Post('cards')
  @HttpCode(HttpStatus.CREATED)
  async createCard(
    @Session() session: UserSession,
    @Body()
    body: {
      label: string;
      lastFour: string;
      cardholderName: string;
      currency?: string;
    },
  ) {
    return serialize(await this.service.createCard(session, body));
  }

  @Post('cards/:cardId/statements')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  async importStatement(
    @Session() session: UserSession,
    @Param('cardId') cardId: string,
    @UploadedFile() file: { buffer: Buffer; originalname?: string } | undefined,
    @Body()
    body: {
      period_start?: string;
      period_end?: string;
      statement_date?: string;
      periodStart?: string;
      periodEnd?: string;
      statementDate?: string;
    },
  ) {
    if (!file?.buffer?.length) {
      throw new DomainException('Choose a statement CSV.');
    }
    const periodStart = body.period_start ?? body.periodStart;
    const periodEnd = body.period_end ?? body.periodEnd;
    const statementDate = body.statement_date ?? body.statementDate;
    if (!periodStart || !periodEnd || !statementDate) {
      throw new DomainException('Enter the period start, period end, and statement date.');
    }
    return serialize(
      await this.service.importStatement(session, cardId, {
        csvText: decodeStatement(file.buffer),
        filename: file.originalname || 'statement.csv',
        periodStart,
        periodEnd,
        statementDate,
      }),
    );
  }

  @Get('periods')
  async listPeriods(@Query('standing') standing?: string) {
    return serialize(await this.service.listPeriods(standing));
  }

  @Get('periods/:id')
  async getPeriod(@Session() session: UserSession, @Param('id') id: string) {
    return serialize(await this.service.getPeriod(id, session.user.id));
  }

  @Post('transactions/:id/code')
  async codeTransaction(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body()
    body: {
      glAccountId?: string | null;
      costCentreId?: string | null;
      category?: string | null;
      exceptionReason?: string | null;
      expectedVersion?: number;
    },
  ) {
    return serialize(await this.service.codeTransaction(session, id, body));
  }

  @Post('transactions/:id/receipt')
  async attachReceipt(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body()
    body: {
      documentId?: string | null;
      waived?: boolean;
      waiverReason?: string | null;
    },
  ) {
    return serialize(await this.service.attachReceipt(session, id, body));
  }

  @Post('periods/:id/close')
  async closePeriod(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return serialize(await this.service.closePeriod(session, id, body));
  }
}
