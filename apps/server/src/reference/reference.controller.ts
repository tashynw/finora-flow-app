import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { serialize } from '../common/serialize.js';
import { ReferenceService } from './reference.service.js';

@Controller('reference')
@UseGuards(AuthGuard)
export class ReferenceController {
  constructor(private readonly referenceService: ReferenceService) {}

  @Get()
  async list() {
    return serialize(await this.referenceService.getReferenceData());
  }
}
