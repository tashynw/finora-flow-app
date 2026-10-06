import { Module } from '@nestjs/common';
import { YessirController } from './yessir.controller.js';
import { YessirService } from './yessir.service.js';

@Module({
  controllers: [YessirController],
  providers: [YessirService],
})
export class YessirModule {}
