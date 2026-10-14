import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { serialize } from '../common/serialize.js';
import { documentObjectKey } from './document-keys.js';
import { DocumentsRecordsService } from './documents-records.service.js';
import { DocumentsService } from './documents.service.js';

type UploadUrlBody = {
  folder: string;
  uuid: string;
  filename: string;
  contentType: string;
  contentMd5?: string;
  bucket?: string;
  expiresIn?: number;
};

type ViewUrlBody = {
  key: string;
  bucket?: string;
  expiresIn?: number;
};

type DeleteBody = {
  key: string;
  bucket?: string;
};

function actor(session: UserSession) {
  return {
    id: session.user.id,
    name: session.user.name || session.user.email,
  };
}

@Controller('documents')
@UseGuards(AuthGuard)
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly records: DocumentsRecordsService,
  ) {}

  @Get()
  async list(
    @Query('status') status?: string,
    @Query('kind') kind?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return serialize(
      await this.records.list({
        status,
        kind,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      }),
    );
  }

  @Post('read-pending')
  async readPending() {
    return serialize(await this.records.readPending());
  }

  @Get(':id/viewer-url')
  async viewerUrl(@Param('id') id: string) {
    return serialize(await this.records.viewerUrl(id));
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    return serialize(await this.records.getById(id));
  }

  @Post(':id/kind')
  async setKind(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { kind: string },
  ) {
    return serialize(await this.records.setKind(id, body.kind, actor(session)));
  }

  @Post(':id/read')
  async reread(@Session() session: UserSession, @Param('id') id: string) {
    return serialize(await this.records.reread(id, actor(session)));
  }

  @Patch(':id/fields/:name')
  async correctField(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Param('name') name: string,
    @Body() body: { text: string; reason?: string | null },
  ) {
    return serialize(
      await this.records.correctField(id, name, body, actor(session)),
    );
  }

  @Post(':id/fields/:name/review')
  async reviewField(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Param('name') name: string,
    @Body() body: { review: string },
  ) {
    return serialize(
      await this.records.reviewField(id, name, body.review, actor(session)),
    );
  }

  @Post(':id/acknowledge')
  async acknowledge(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { signal: string },
  ) {
    return serialize(await this.records.acknowledge(id, body.signal, actor(session)));
  }

  @Post(':id/accept')
  async accept(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: { note?: string | null },
  ) {
    return serialize(
      await this.records.accept(id, body.note ?? null, actor(session)),
    );
  }

  @Post('upload-url')
  createUploadUrl(@Body() body: UploadUrlBody) {
    const key = documentObjectKey(body.folder, body.uuid, body.filename);
    return this.documentsService.createUploadLink({
      key,
      contentType: body.contentType,
      contentMd5: body.contentMd5,
      bucket: body.bucket,
      expiresIn: body.expiresIn,
    });
  }

  @Post('view-url')
  createViewUrl(@Body() body: ViewUrlBody) {
    return this.documentsService.createViewUrl(body);
  }

  @Delete()
  deleteObject(@Body() body: DeleteBody) {
    return this.documentsService.deleteObject(body);
  }
}
