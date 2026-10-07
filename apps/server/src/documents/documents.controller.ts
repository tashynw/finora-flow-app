import { Body, Controller, Delete, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { DocumentsService } from './documents.service.js';

type UploadUrlBody = {
  key: string;
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

@Controller('documents')
@UseGuards(AuthGuard)
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('upload-url')
  createUploadUrl(@Body() body: UploadUrlBody) {
    return this.documentsService.createUploadLink(body);
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
