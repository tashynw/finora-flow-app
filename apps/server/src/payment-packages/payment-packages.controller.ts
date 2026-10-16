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
import { DomainException } from '../common/errors.js';
import { type PageQuery } from '../common/pagination.js';
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
  async list(
    @Query()
    query: PageQuery & {
      standing?: string | string[];
      search?: string;
      page_size?: string;
    },
  ) {
    const result = await this.service.list(query);
    return serialize({
      rows: result.rows,
      total: result.total,
      page: result.page,
      page_size: result.pageSize,
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
      payment_method?: string | null;
      intendedPaymentDate?: string;
      intended_payment_date?: string | null;
    },
  ) {
    const created = await this.service.create(session, {
      description: body.description,
      paymentMethod: body.paymentMethod ?? body.payment_method ?? undefined,
      intendedPaymentDate:
        body.intendedPaymentDate ?? body.intended_payment_date ?? undefined,
    });
    return serialize(this.service.toDetail(created));
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    return serialize(this.service.toDetail(await this.service.getById(id)));
  }

  @Put(':id')
  async updateHeader(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body()
    body: {
      description?: string;
      paymentMethod?: string | null;
      payment_method?: string | null;
      intendedPaymentDate?: string | null;
      intended_payment_date?: string | null;
    },
  ) {
    const updated = await this.service.updateHeader(session, id, {
      description: body.description,
      paymentMethod:
        body.paymentMethod !== undefined
          ? body.paymentMethod
          : body.payment_method,
      intendedPaymentDate:
        body.intendedPaymentDate !== undefined
          ? body.intendedPaymentDate
          : body.intended_payment_date,
    });
    return serialize(this.service.toDetail(updated));
  }

  @Post(':id/lines')
  async addLines(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { invoiceIds?: string[]; invoice_ids?: string[] },
  ) {
    const result = await this.service.addLines(
      session,
      id,
      body.invoiceIds ?? body.invoice_ids ?? [],
    );
    return serialize({
      added: result.added.map((line) =>
        typeof line === 'object' && line && 'invoiceId' in line
          ? String(line.invoiceId)
          : String(line),
      ),
      refused: result.refused.map((item) => ({
        invoice_id: item.invoiceId,
        invoice_reference: item.reference,
        refusal: 'not_approved',
        explanation: item.reason,
      })),
      package: this.service.toDetail(await this.service.getById(id)),
    });
  }

  @Delete(':id/lines/:invoiceId')
  async removeLine(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Param('invoiceId') invoiceId: string,
  ) {
    return serialize(
      this.service.toDetail(await this.service.removeLine(session, id, invoiceId)),
    );
  }

  @Get(':id/manifest')
  async manifest(@Param('id') id: string) {
    const result = await this.service.manifest(id);
    if (!result) {
      throw new DomainException(
        'This package has no payment method or date yet, so there is no manifest to produce.',
        HttpStatus.CONFLICT,
      );
    }
    return serialize({
      content: result.content,
      digest: result.digest,
      line_count: result.lineCount,
      filename: result.filename,
      submitted_digest: result.submittedDigest,
      matches_submitted: result.matchesSubmitted,
    });
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
    @Body()
    body: { submissionReference?: string; submission_reference?: string },
  ) {
    const result = await this.service.submit(
      session,
      id,
      body.submissionReference ?? body.submission_reference ?? '',
    );
    return serialize({
      manifest: {
        content: result.manifest.content,
        digest: result.manifest.digest,
        line_count: result.manifest.lineCount,
        filename: `${result.package.reference}-manifest.csv`,
        submitted_digest: result.package.manifestSha256,
        matches_submitted: true,
      },
      package: this.service.toDetail(result.package),
    });
  }

  @Post(':id/cancel')
  async cancel(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return serialize(
      this.service.toDetail(
        await this.service.cancel(session, id, body.reason ?? ''),
      ),
    );
  }
}
