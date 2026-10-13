import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller.js';
import { DocumentsRecordsService } from './documents-records.service.js';
import { DocumentsService } from './documents.service.js';

@Module({
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentsRecordsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
