import { Module } from '@nestjs/common';
import { WorkController } from './work.controller.js';
import { WorkService } from './work.service.js';

@Module({
  controllers: [WorkController],
  providers: [WorkService],
  exports: [WorkService],
})
export class WorkModule {}
