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
import { resolvePage, type PageQuery } from '../common/pagination.js';
import { serialize } from '../common/serialize.js';
import { IntakeService } from './intake.service.js';

@Controller('intake')
@UseGuards(AuthGuard)
export class IntakeController {
  constructor(private readonly service: IntakeService) {}

  @Get('messages')
  async listMessages(@Query() query: PageQuery) {
    const page = resolvePage(query);
    const result = await this.service.listMessages(query);
    return serialize({
      items: result.items,
      total: result.total,
      limit: 'limit' in page && page.limit != null ? page.limit : page.take,
      offset: 'offset' in page && page.offset != null ? page.offset : page.skip,
    });
  }

  @Get('operations')
  async operations(@Query('probe_mailbox') probeMailbox?: string) {
    return serialize(await this.service.operationsSummary(probeMailbox === 'true'));
  }

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  async upload(
    @Session() session: UserSession,
    @Body()
    body: {
      filename: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
      key: string;
      bucket: string;
      subject?: string;
      note?: string;
      kind?: string;
    },
  ) {
    return serialize(await this.service.manualUpload(session, body));
  }

  @Get('attachments/:documentId/download-url')
  async downloadUrl(@Param('documentId') documentId: string) {
    return serialize(await this.service.attachmentDownloadUrl(documentId));
  }

  @Get('messages/:id')
  async getMessageByPath(@Param('id') id: string) {
    return serialize(await this.service.getMessage(id));
  }

  @Get(':id')
  async getMessage(@Param('id') id: string) {
    return serialize(await this.service.getMessage(id));
  }
}
