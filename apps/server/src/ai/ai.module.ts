import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AiGatewayService } from './ai-gateway.service.js';

@Module({
  imports: [PrismaModule],
  providers: [AiGatewayService],
  exports: [AiGatewayService],
})
export class AiModule {}
