import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { serialize } from '../common/serialize.js';
import { CreditCardsService } from './credit-cards.service.js';

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
  async importStatement(
    @Session() session: UserSession,
    @Param('cardId') cardId: string,
    @Body()
    body: {
      periodStart: string;
      periodEnd: string;
      statementDate: string;
      sourceFilename: string;
      transactions: {
        postedOn: string;
        merchant: string;
        cardholder: string;
        description?: string;
        amountMinorUnits: string | number;
        externalReference?: string;
      }[];
    },
  ) {
    return serialize(await this.service.importStatement(session, cardId, body));
  }

  @Get('periods')
  async listPeriods() {
    return serialize(await this.service.listPeriods());
  }

  @Get('periods/:id')
  async getPeriod(@Param('id') id: string) {
    return serialize(await this.service.getPeriod(id));
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
