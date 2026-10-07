import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { resolvePage, type PageQuery } from '../common/pagination.js';
import { serialize } from '../common/serialize.js';
import { PaymentPackagesService } from './payment-packages.service.js';

@Controller('payment-packages')
@UseGuards(AuthGuard)
export class PaymentPackagesController {
  constructor(private readonly service: PaymentPackagesService) {}

  @Get('eligible-invoices')
  async eligibleInvoices(@Query('limit') limit?: string) {
    const take = limit ? Number(limit) : 200;
    return serialize(await this.service.eligibleInvoices(take));
  }

  @Get()
  async list(@Query() query: PageQuery) {
    const page = resolvePage(query);
    const result = await this.service.list(query);
    return serialize({
      rows: result.rows,
      total: result.total,
      page: page.page ?? 1,
      pageSize: page.pageSize ?? page.take,
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Session() session: UserSession,
    @Body()
    body: {
      description?: string;
      paymentMethod?: string;
      intendedPaymentDate?: string;
    },
  ) {
    return serialize(await this.service.create(session, body));
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    return serialize(await this.service.getById(id));
  }

  @Put(':id')
  async updateHeader(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body()
    body: {
      description?: string;
      paymentMethod?: string | null;
      intendedPaymentDate?: string | null;
    },
  ) {
    return serialize(await this.service.updateHeader(session, id, body));
  }

  @Post(':id/lines')
  async addLines(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { invoiceIds: string[] },
  ) {
    return serialize(
      await this.service.addLines(session, id, body.invoiceIds ?? []),
    );
  }

  @Delete(':id/lines/:invoiceId')
  async removeLine(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Param('invoiceId') invoiceId: string,
  ) {
    return serialize(await this.service.removeLine(session, id, invoiceId));
  }

  @Get(':id/manifest')
  async manifest(@Param('id') id: string) {
    const result = await this.service.manifest(id);
    return serialize(result);
  }

  @Get(':id/manifest.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async manifestCsv(@Param('id') id: string) {
    const result = await this.service.manifest(id);
    if (!result) {
      return '';
    }
    return result.content;
  }

  @Post(':id/submit')
  async submit(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { submissionReference: string },
  ) {
    return serialize(
      await this.service.submit(session, id, body.submissionReference ?? ''),
    );
  }

  @Post(':id/cancel')
  async cancel(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return serialize(await this.service.cancel(session, id, body.reason ?? ''));
  }
}
